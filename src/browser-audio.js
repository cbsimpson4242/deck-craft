import { DECK_IDS } from './catalog.js';
import { analyzeChannels } from './browser-analysis.js';
import { findEmbeddedPicture, thumbnailFromPicture } from './browser-artwork.js';
import { BROWSER_STORAGE_LIMITS, BrowserFileStore, browserUUID, quotaError } from './browser-store.js';

// Browser audio backend. It implements the same semantic command contract as the
// native bridge so the shared session, layouts and library are unchanged, but it
// is a different engine: one HTMLAudioElement per deck (the browser media clock
// owns position, playbackRate and preservesPitch) routed through Web Audio gains.
// It needs no secure-context-only API, so it works from a plain-HTTP LAN origin.
// Files are read from the user's File/Blob objects and never leave the browser.

const HEADROOM = 0.25;
const RATE_MIN = 0.92, RATE_MAX = 1.08;
// 24 kHz makes the analysis envelope exactly 200 Hz (120-frame bins), matching the native estimator at 48 kHz.
const DECODE_RATE = 24000;
const TRACK_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLLECTION_ID = /^collection-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FOLDER_EXTENSIONS = new Set(['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'webm']);
const PICKER_ACCEPT = 'audio/*,.wav,.mp3,.flac,.ogg,.oga,.opus,.m4a,.aac';
const GRID_RANGE = [60, 200];
const COMMAND_FIELDS = {
  status: ['type'], analyze: ['type', 'trackId'], tempo: ['type', 'deck', 'rate', 'pitchLock'], master: ['type', 'deck'], sync: ['type', 'deck'],
  library: ['type'], pick: ['type', 'deck'], import: ['type', 'kind'], 'collection-create': ['type', 'kind', 'name'], 'collection-rename': ['type', 'id', 'name'],
  'collection-delete': ['type', 'id'], 'collection-add': ['type', 'id', 'trackIds'], 'collection-remove': ['type', 'id', 'trackIds'],
  'collection-move': ['type', 'id', 'trackId', 'direction'], forget: ['type', 'trackIds'], load: ['type', 'deck', 'trackId'], 'retain-track': ['type', 'deck', 'trackId'],
  play: ['type', 'deck'], pause: ['type', 'deck'], seek: ['type', 'deck', 'position'], level: ['type', 'deck', 'value'], crossfader: ['type', 'value'], reconnect: ['type'],
};

/** Same semantic shapes and ranges as the native bridge; anything else is rejected. */
export function validateBrowserCommand(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('invalid_command');
  if (typeof request.type !== 'string' || !Object.hasOwn(COMMAND_FIELDS, request.type)) throw Error('invalid_command');
  const fields = COMMAND_FIELDS[request.type], keys = Object.keys(request);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) throw Error('invalid_command');
  if (fields.includes('rate') && (!Number.isFinite(request.rate) || request.rate < RATE_MIN || request.rate > RATE_MAX)) throw Error('invalid_tempo');
  if (fields.includes('pitchLock') && typeof request.pitchLock !== 'boolean') throw Error('invalid_pitch_lock');
  if (fields.includes('deck') && !DECK_IDS.includes(request.deck)) throw Error('invalid_deck');
  if (fields.includes('id') && (typeof request.id !== 'string' || !COLLECTION_ID.test(request.id))) throw Error('invalid_collection');
  if (fields.includes('name') && (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 80 || /[\x00-\x1f]/.test(request.name))) throw Error('invalid_collection_name');
  if (fields.includes('kind') && !(request.type === 'import' ? ['files', 'folder'] : ['crate', 'playlist']).includes(request.kind)) throw Error('invalid_kind');
  if (fields.includes('trackIds') && (!Array.isArray(request.trackIds) || !request.trackIds.length || request.trackIds.length > 1000 || request.trackIds.some(id => typeof id !== 'string' || !TRACK_ID.test(id)))) throw Error('invalid_track');
  if (fields.includes('direction') && ![-1, 1].includes(request.direction)) throw Error('invalid_direction');
  if (fields.includes('trackId') && (typeof request.trackId !== 'string' || !TRACK_ID.test(request.trackId))) throw Error('invalid_track');
  if (fields.includes('value') && (!Number.isFinite(request.value) || request.value < 0 || request.value > 100)) throw Error('invalid_value');
  if (fields.includes('position') && (!Number.isFinite(request.position) || request.position < 0 || request.position > 7200)) throw Error('invalid_position');
  return request;
}

/** What this browser can do. Never asks for a secure context. */
export function detectBrowserAudio(env = globalThis) {
  const reasons = [];
  const Media = env.HTMLMediaElement;
  if (typeof env.Audio !== 'function' || !Media) reasons.push('HTMLAudioElement playback');
  if (typeof (env.AudioContext || env.webkitAudioContext) !== 'function') reasons.push('Web Audio');
  if (typeof (env.OfflineAudioContext || env.webkitOfflineAudioContext) !== 'function') reasons.push('audio decoding for analysis');
  if (typeof env.URL?.createObjectURL !== 'function' || typeof env.File !== 'function' || typeof env.Blob !== 'function') reasons.push('local file objects');
  if (typeof env.crypto?.getRandomValues !== 'function' && typeof env.crypto?.randomUUID !== 'function') reasons.push('secure random identifiers');
  const proto = Media?.prototype;
  const pitchLock = !!proto && ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch'].some(name => name in proto);
  return { supported: reasons.length === 0, reasons, pitchLock, indexedDB: !!env.indexedDB, secureContext: env.isSecureContext === true };
}

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));
const fraction = value => value - Math.floor(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function waitForMedia(target, ok, fail, ms) {
  return new Promise((resolve, reject) => {
    let timer;
    const handlers = [...ok.map(name => [name, () => done(resolve)]), ...fail.map(name => [name, () => done(reject, Error('unsupported_or_corrupt_audio'))])];
    const done = (settle, value) => { clearTimeout(timer); for (const [name, handler] of handlers) target.removeEventListener(name, handler); settle(value); };
    for (const [name, handler] of handlers) target.addEventListener(name, handler);
    timer = setTimeout(() => done(reject, Error('media_timeout')), ms);
  });
}
function seekMedia(audio, position, ms = 5000) {
  return new Promise(resolve => {
    const finish = () => { audio.removeEventListener('seeked', finish); clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, ms);
    audio.addEventListener('seeked', finish);
    audio.currentTime = position;
  });
}
function sanitizeTitle(name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 512) || 'Untitled audio';
}
const validGrid = g => g === null || (g && Number.isFinite(g.bpm) && g.bpm >= GRID_RANGE[0] && g.bpm <= GRID_RANGE[1] && Number.isFinite(g.offset) && g.offset >= 0 && g.offset < 1.01 && Number.isFinite(g.confidence) && g.confidence >= 0 && g.confidence <= 1);
const validArtwork = a => a === null || (typeof a === 'string' && a.length <= 22000 && /^data:image\/png;base64,iVBOR[A-Za-z0-9+/]*={0,2}$/.test(a));

function cleanStoredTrack(raw) {
  if (!raw || typeof raw !== 'object' || !TRACK_ID.test(raw.id) || typeof raw.title !== 'string') return null;
  const grid = raw.beatGrid ?? null;
  const peaks = Array.isArray(raw.peaks) && raw.peaks.length === 512 && raw.peaks.every(n => Number.isFinite(n) && n >= 0 && n <= 1) ? raw.peaks : [];
  if (!Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 7200 || !validGrid(grid) || !validArtwork(raw.artwork ?? null)) return null;
  if (!Number.isSafeInteger(raw.size) || raw.size <= 0 || raw.size > BROWSER_STORAGE_LIMITS.fileBytes) return null;
  return {
    id: raw.id, title: sanitizeTitle(raw.title), duration: raw.duration, channels: Number.isInteger(raw.channels) ? raw.channels : 2,
    beatGrid: grid ? { bpm: grid.bpm, offset: grid.offset, confidence: grid.confidence } : null, artwork: raw.artwork ?? null,
    analysisVersion: raw.analysisVersion === 1 ? 1 : 0, peaks, size: raw.size, key: typeof raw.key === 'string' ? raw.key.slice(0, 400) : '', persisted: true, file: null,
  };
}
function publicTrack(r) {
  return {
    id: r.id, title: r.title, artist: 'Local audio', genre: 'Local files', bpm: r.beatGrid?.bpm || 0, beatGrid: r.beatGrid, artwork: r.artwork,
    analysisVersion: r.analysisVersion, key: '—', duration: r.duration, color: '#96c7a8', local: true, peaks: r.peaks, channels: r.channels, persisted: r.persisted,
  };
}
const storedTrack = r => ({ id: r.id, title: r.title, duration: r.duration, channels: r.channels, beatGrid: r.beatGrid, artwork: r.artwork, analysisVersion: r.analysisVersion, peaks: r.peaks, size: r.size, key: r.key });
function cleanCollections(raw, records) {
  if (!Array.isArray(raw)) return [];
  const out = [], seen = new Set();
  let memberships = 0;
  for (const c of raw.slice(0, 200)) {
    if (!c || !COLLECTION_ID.test(c.id) || seen.has(c.id) || !['crate', 'playlist'].includes(c.kind) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80 || !Array.isArray(c.trackIds)) continue;
    const ids = [...new Set(c.trackIds.filter(id => records.has(id)))];
    if (memberships + ids.length > 20000) break;
    memberships += ids.length;
    seen.add(c.id);
    out.push({ id: c.id, kind: c.kind, name: c.name.trim(), trackIds: ids });
  }
  return out;
}

export class BrowserAudioBridge {
  constructor(env, store, support) {
    this.env = env; this.store = store; this.support = support;
    this.backend = Object.freeze({ id: 'browser', name: 'Browser audio', engine: 'HTMLAudioElement + Web Audio' });
    this.version = 1;
    this.records = new Map();
    this.collections = [];
    this.listeners = new Set();
    this.seq = 0;
    this.engine = null;
    this.timer = null;
    this.picking = false;
    this.busy = Promise.resolve();
    this.storageWarning = '';
    this.sessionBytes = 0;
  }
  // ----- lifecycle ---------------------------------------------------------
  async initialize() {
    await this.store.open();
    if (!this.store.available) this.storageWarning = 'This browser blocked local file storage. Imported files stay available only until this tab closes; select them again after a reload.';
    else {
      const document = await this.store.readLibrary().catch(() => null);
      if (document && document.version === 1 && Array.isArray(document.tracks)) {
        for (const raw of document.tracks.slice(0, BROWSER_STORAGE_LIMITS.tracks)) {
          const record = cleanStoredTrack(raw);
          if (record && !this.records.has(record.id)) this.records.set(record.id, record);
        }
        this.collections = cleanCollections(document.collections, this.records);
      }
      await this.store.collectOrphans(new Set(this.records.keys())).catch(() => 0);
    }
    this.createEngine();
    return this;
  }
  createEngine() {
    const env = this.env, Context = env.AudioContext || env.webkitAudioContext;
    const engine = { id: browserUUID(env.crypto), sourceId: browserUUID(env.crypto), ctx: null, master: null, decks: [], masterDeck: null, crossfader: 50, error: null, wasRunning: false };
    this.engine = engine;
    try {
      const ctx = new Context({ latencyHint: 'interactive' });
      engine.ctx = ctx;
      engine.master = ctx.createGain();
      engine.master.connect(ctx.destination);
      engine.wasRunning = ctx.state === 'running';
      ctx.onstatechange = () => {
        if (this.engine !== engine) return;
        if (ctx.state === 'running') engine.wasRunning = true;
        else if (engine.wasRunning) this.failClosed(engine, 'audio_output_suspended');
        this.emit();
      };
      engine.decks = DECK_IDS.map(id => this.createDeck(engine, id));
    } catch {
      engine.error = 'audio_output_unavailable';
    }
    return engine;
  }
  createDeck(engine, id) {
    const gain = engine.ctx.createGain();
    gain.connect(engine.master);
    gain.gain.value = 0;
    const deck = { id, gain, media: null, audio: null, trackId: null, target: null, loadToken: 0, transport: 0, seekToken: 0, generation: 0, loading: false, rate: 1, pitchLock: true, synced: false, level: 78, failed: null };
    this.adopt(engine, deck, this.makeMedia(engine, deck));
    return deck;
  }
  /** A fresh element per load: a MediaElementSource can never be re-bound, and a failed load leaves the previous source intact. */
  makeMedia(engine, deck) {
    const audio = new this.env.Audio();
    audio.preload = 'auto'; audio.loop = false;
    this.applyMedia(deck, audio);
    return { audio, source: engine.ctx.createMediaElementSource(audio), url: null, listeners: [] };
  }
  adopt(engine, deck, media) {
    const index = DECK_IDS.indexOf(deck.id);
    media.source.connect(deck.gain);
    for (const name of ['ended', 'pause', 'playing', 'error', 'seeked']) {
      const handler = () => {
        if (this.engine !== engine || deck.media !== media) return;
        if (name === 'error' && deck.trackId && !deck.loading) { deck.failed = 'decoder_failed'; this.unsync(engine, index); }
        if (name === 'ended') this.unsync(engine, index);
        this.emit();
      };
      media.audio.addEventListener(name, handler);
      media.listeners.push([name, handler]);
    }
    deck.media = media; deck.audio = media.audio;
  }
  discard(media) {
    if (!media) return;
    try { media.audio.pause(); } catch {}
    for (const [name, handler] of media.listeners) media.audio.removeEventListener(name, handler);
    media.listeners = [];
    try { media.source.disconnect(); } catch {}
    try { media.audio.removeAttribute('src'); media.audio.load(); } catch {}
    if (media.url) { this.env.URL.revokeObjectURL(media.url); media.url = null; }
  }
  disposeEngine(engine) {
    if (!engine) return;
    for (const deck of engine.decks) {
      deck.loadToken++; deck.transport++; deck.seekToken++;
      this.discard(deck.media);
      try { deck.gain.disconnect(); } catch {}
    }
    if (engine.ctx) { engine.ctx.onstatechange = null; engine.ctx.close?.().catch?.(() => {}); }
    engine.decks = [];
  }
  /** Gesture hook: resumes the context synchronously inside the user's click/key event. */
  unlock() {
    const ctx = this.engine?.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  }
  /** Page hide / freeze: stop everything and never restart by itself. */
  haltAll() {
    const engine = this.engine;
    if (!engine) return;
    for (const deck of engine.decks) { deck.transport++; deck.seekToken++; try { deck.audio.pause(); } catch {} }
    for (const deck of engine.decks) deck.synced = false;
    this.emit();
  }
  failClosed(engine, code) {
    engine.error = code;
    for (const deck of engine.decks) { deck.transport++; deck.seekToken++; try { deck.audio.pause(); } catch {} deck.synced = false; }
  }
  /** Stops timers and releases every deck source and the audio context. */
  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.disposeEngine(this.engine);
    this.listeners.clear();
  }
  onEvent(callback) {
    if (typeof callback !== 'function') throw Error('invalid_callback');
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  // ----- snapshots ---------------------------------------------------------
  isPlaying(deck) {
    return !!(deck.trackId && !deck.loading && !deck.failed && !deck.audio.paused && !deck.audio.ended && this.engine?.ctx?.state === 'running');
  }
  storageInfo() {
    let used = 0, persisted = 0, session = 0;
    for (const r of this.records.values()) { if (r.persisted) { used += r.size; persisted++; } else session++; }
    return { persistent: this.store.available, usedBytes: used, limitBytes: BROWSER_STORAGE_LIMITS.persistedBytes, tracks: this.records.size, persistedTracks: persisted, sessionOnlyTracks: session };
  }
  snapshot(extra = {}) {
    const engine = this.engine, ctx = engine?.ctx;
    const ready = !!ctx && ctx.state !== 'closed' && !engine.error?.startsWith('audio_output_unavailable');
    const decks = DECK_IDS.map((id, i) => {
      const deck = engine.decks[i], record = deck?.trackId ? this.records.get(deck.trackId) : null;
      if (!deck) return { id, trackId: null, duration: 0, position: 0, playing: false, level: 78, loading: false, rate: 1, pitchLock: false, synced: false, beatGrid: null, loadGeneration: 0, error: null };
      const duration = record?.duration || 0, position = record ? clampNumber(Number(deck.audio.currentTime) || 0, 0, duration) : 0;
      return {
        id, trackId: deck.trackId, duration, channels: record?.channels || 0, position, playing: this.isPlaying(deck), level: deck.level, loadGeneration: deck.generation,
        loading: deck.loading, rate: deck.rate, pitchLock: deck.pitchLock && this.support.pitchLock, synced: deck.synced, beatGrid: record?.beatGrid || null, error: deck.failed,
      };
    });
    return {
      ready, backend: 'browser', engineId: engine.id, sourceId: engine.sourceId, seq: ++this.seq,
      output: ctx ? { sampleRate: ctx.sampleRate, channels: 2, backend: 'Browser audio (HTMLAudioElement + Web Audio)', state: ctx.state, baseLatency: Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : null, outputLatency: Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : null } : null,
      error: ready ? engine.error : (engine.error || 'audio_output_unavailable'),
      decks, crossfader: engine.crossfader, master: engine.masterDeck === null ? null : DECK_IDS[engine.masterDeck],
      capabilities: { pitchLock: this.support.pitchLock, persistence: this.store.available, secureContext: this.support.secureContext },
      storage: this.storageInfo(), ...extra,
    };
  }
  emit(extra) {
    if (this.listeners.size) {
      const snapshot = this.snapshot(extra);
      for (const callback of [...this.listeners]) { try { callback({ type: 'state', snapshot }); } catch {} }
    }
    const playing = !!this.engine?.decks.some(deck => this.isPlaying(deck));
    if (playing && !this.timer) this.timer = setInterval(() => this.emit(), 100);
    else if (!playing && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  // ----- command dispatch --------------------------------------------------
  async command(raw) {
    let request;
    try { request = validateBrowserCommand(raw); } catch (error) { return { ok: false, error: error.message }; }
    if (['play', 'load', 'pick', 'import', 'reconnect'].includes(request.type)) this.unlock();
    try {
      // No await may precede the file chooser: it needs the caller's user activation.
      return { ok: true, ...(await this.execute(request)) };
    } catch (error) {
      return { ok: false, error: /^[a-z][a-z_]{0,60}$/.test(error?.message || '') ? error.message : 'audio_command_failed' };
    }
  }
  deckFor(request) { return this.engine.decks[DECK_IDS.indexOf(request.deck)]; }
  requireEngine() {
    if (!this.engine?.ctx || this.engine.ctx.state === 'closed' || this.engine.error === 'audio_output_unavailable') throw Error('audio_output_unavailable');
    return this.engine;
  }
  libraryResult() { return { tracks: [...this.records.values()].map(publicTrack), collections: structuredClone(this.collections), warning: this.warning() }; }
  warning() {
    const info = this.storageInfo(), parts = [];
    if (this.storageWarning) parts.push(this.storageWarning);
    if (info.sessionOnlyTracks) parts.push(`${info.sessionOnlyTracks} imported ${info.sessionOnlyTracks === 1 ? 'file is' : 'files are'} kept for this session only and will need to be selected again after a reload.`);
    if (info.persistent && info.usedBytes > info.limitBytes * 0.85) parts.push(`Browser library storage is ${Math.round(info.usedBytes / info.limitBytes * 100)}% full (limit ${Math.round(info.limitBytes / 1048576)} MB). Remove tracks from the library to free space.`);
    return parts.join(' ');
  }
  async execute(request) {
    switch (request.type) {
      case 'status': return { snapshot: this.snapshot() };
      case 'library': return this.libraryResult();
      case 'retain-track': this.record(request.trackId); return {};
      case 'pick': return this.pickAndLoad(request);
      case 'import': return this.importSelection(request);
      case 'analyze': return this.analyzeTrack(request.trackId);
      case 'forget': return this.forget(request.trackIds);
      case 'load': return this.load(request);
      case 'reconnect': return this.reconnect();
      case 'play': return this.play(request);
      case 'pause': return this.pause(request);
      case 'seek': return this.seek(request);
      case 'level': return this.setLevel(request);
      case 'crossfader': { const engine = this.requireEngine(); engine.crossfader = request.value; this.applyLevels(engine); return { snapshot: this.snapshot() }; }
      case 'tempo': return this.tempo(request);
      case 'master': { const engine = this.requireEngine(); engine.masterDeck = DECK_IDS.indexOf(request.deck); for (const d of engine.decks) { d.synced = false; d.seekToken++; } return { snapshot: this.snapshot() }; }
      case 'sync': return this.sync(request);
      default: return this.collection(request);
    }
  }
  record(id) {
    const record = this.records.get(id);
    if (!record) throw Error('unknown_local_track');
    return record;
  }
  // ----- mixing -------------------------------------------------------------
  applyLevels(engine) {
    const angle = engine.crossfader / 100 * Math.PI / 2;
    engine.decks.forEach((deck, i) => {
      const fade = i === 0 ? Math.cos(angle) : i === 1 ? Math.sin(angle) : 1;
      deck.gain.gain.setTargetAtTime(HEADROOM * deck.level / 100 * fade, engine.ctx.currentTime, 0.01);
    });
  }
  setLevel(request) {
    const engine = this.requireEngine(), deck = this.deckFor(request);
    deck.level = request.value; this.applyLevels(engine);
    return { snapshot: this.snapshot() };
  }
  /** Writes rate and pitch-lock to the media element so the signal really changes. */
  applyMedia(deck, audio = deck.audio) {
    const lock = deck.pitchLock && this.support.pitchLock;
    for (const name of ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch']) if (name in audio) audio[name] = lock;
    audio.defaultPlaybackRate = deck.rate; audio.playbackRate = deck.rate;
  }
  unsync(engine, index) {
    if (engine.masterDeck === index) for (const d of engine.decks) { d.synced = false; d.seekToken++; }
    else if (engine.decks[index]) { engine.decks[index].synced = false; engine.decks[index].seekToken++; }
  }
  tempo(request) {
    const engine = this.requireEngine(), index = DECK_IDS.indexOf(request.deck), deck = engine.decks[index];
    if (deck.loading) throw Error('deck_loading');
    if (request.pitchLock && !this.support.pitchLock && Math.abs(request.rate - 1) > 1e-9) throw Error('pitch_lock_unsupported');
    const updates = [[deck, request.rate]], record = deck.trackId ? this.records.get(deck.trackId) : null;
    if (engine.masterDeck === index && record?.beatGrid) {
      engine.decks.forEach((other, j) => {
        const grid = other.trackId ? this.records.get(other.trackId)?.beatGrid : null;
        if (j !== index && other.synced && grid) {
          const rate = record.beatGrid.bpm * request.rate / grid.bpm;
          if (!(rate >= RATE_MIN && rate <= RATE_MAX)) throw Error('sync_tempo_out_of_range');
          updates.push([other, rate]);
        }
      });
    }
    for (const [target, rate] of updates) {
      target.seekToken++;
      target.rate = rate;
      if (target === deck) { target.pitchLock = request.pitchLock; target.synced = false; }
      this.applyMedia(target);
    }
    return { snapshot: this.snapshot() };
  }
  // ----- transport ----------------------------------------------------------
  async load(request) {
    const engine = this.requireEngine(), index = DECK_IDS.indexOf(request.deck), deck = engine.decks[index];
    const record = this.record(request.trackId);
    this.unsync(engine, index);
    const token = ++deck.loadToken;
    deck.transport++; deck.loading = true; deck.target = record.id;
    try { deck.audio.pause(); } catch {}
    this.emit();
    let staged = null;
    try {
      const blob = record.file || await this.store.getBlob(record.id);
      if (!blob) throw Error('file_unavailable');
      staged = this.makeMedia(engine, deck);
      staged.url = this.env.URL.createObjectURL(blob);
      staged.audio.src = staged.url;
      await waitForMedia(staged.audio, ['loadedmetadata'], ['error'], 20000);
      if (token !== deck.loadToken) throw Error('load_cancelled');
      if (!(staged.audio.duration > 0) || !Number.isFinite(staged.audio.duration)) throw Error('duration_unavailable');
      const previous = deck.media;
      this.adopt(engine, deck, staged);
      staged = null;
      this.discard(previous);
      deck.trackId = record.id; deck.generation++; deck.failed = null;
      this.applyMedia(deck);
      deck.audio.currentTime = 0;
    } catch (error) {
      this.discard(staged);
      if (token === deck.loadToken) { deck.loading = false; deck.target = null; this.emit(); }
      throw Error(error.message === 'media_timeout' ? 'audio_command_timed_out' : error.message);
    }
    deck.loading = false; deck.target = null;
    this.applyLevels(engine);
    return { track: publicTrack(record), snapshot: this.snapshot() };
  }
  async play(request) {
    const engine = this.requireEngine(), index = DECK_IDS.indexOf(request.deck), deck = engine.decks[index];
    if (!deck.trackId) throw Error('deck_unloaded');
    if (deck.loading) throw Error('deck_loading');
    const token = ++deck.transport, audio = deck.audio, record = this.records.get(deck.trackId);
    const stillOwned = () => this.engine === engine && deck.audio === audio && deck.transport === token;
    if (engine.ctx.state !== 'running') {
      await Promise.race([engine.ctx.resume().catch(() => {}), sleep(1500)]);
      if (!stillOwned()) return { snapshot: this.snapshot() };
      if (engine.ctx.state !== 'running') throw Error('audio_context_blocked');
      engine.wasRunning = true;
    }
    if (!stillOwned()) return { snapshot: this.snapshot() };
    deck.failed = null; engine.error = null;
    if (deck.audio.ended || deck.audio.currentTime >= record.duration - 0.02) { this.unsync(engine, index); await seekMedia(deck.audio, 0); }
    if (!stillOwned()) return { snapshot: this.snapshot() };
    if (deck.audio.paused) this.unsync(engine, index);
    this.applyLevels(engine);
    try {
      await audio.play();
    } catch (error) {
      if (token !== deck.transport || error?.name === 'AbortError') return { snapshot: this.snapshot() };
      throw Error(error?.name === 'NotAllowedError' ? 'autoplay_blocked' : error?.name === 'NotSupportedError' ? 'unsupported_or_corrupt_audio' : 'playback_failed');
    }
    // A newer pause/seek/load must win over a play that was still starting.
    if (!stillOwned() && deck.audio !== audio) { try { audio.pause(); } catch {} }
    this.emit();
    return { snapshot: this.snapshot() };
  }
  pause(request) {
    const engine = this.requireEngine(), index = DECK_IDS.indexOf(request.deck), deck = engine.decks[index];
    deck.loadToken++; deck.transport++; deck.seekToken++; deck.loading = false; deck.target = null;
    this.unsync(engine, index);
    try { deck.audio.pause(); } catch {}
    this.emit();
    return { snapshot: this.snapshot() };
  }
  async seek(request) {
    const engine = this.requireEngine(), index = DECK_IDS.indexOf(request.deck), deck = engine.decks[index];
    if (!deck.trackId) throw Error('deck_unloaded');
    if (deck.loading) throw Error('deck_loading');
    const record = this.records.get(deck.trackId);
    if (request.position > record.duration) throw Error('invalid_position');
    this.unsync(engine, index);
    deck.transport++;
    const token = ++deck.seekToken;
    await seekMedia(deck.audio, Math.min(request.position, Number.isFinite(deck.audio.duration) ? deck.audio.duration : record.duration));
    if (token === deck.seekToken) this.emit();
    return { snapshot: this.snapshot() };
  }
  /** Aligns the follower's beat phase to the master using measured media positions. */
  async sync(request) {
    const engine = this.requireEngine(), index = DECK_IDS.indexOf(request.deck), follower = engine.decks[index];
    const masterIndex = engine.masterDeck;
    if (masterIndex === null) throw Error('sync_master_required');
    if (masterIndex === index) throw Error('sync_same_deck');
    const master = engine.decks[masterIndex], fr = follower.trackId && this.records.get(follower.trackId), mr = master.trackId && this.records.get(master.trackId);
    const fg = fr?.beatGrid, mg = mr?.beatGrid;
    if (!fg || !mg) throw Error('beat_grid_unavailable');
    if (follower.loading || master.loading) throw Error('deck_loading');
    const rate = mg.bpm * master.rate / fg.bpm;
    if (!(rate >= RATE_MIN && rate <= RATE_MAX)) throw Error('sync_tempo_out_of_range');
    const period = 60 / fg.bpm, token = ++follower.seekToken;
    const masterMedia = master.audio, masterTransport = master.transport, masterSeek = master.seekToken, masterRate = master.rate;
    const followerMedia = follower.audio, followerTransport = follower.transport;
    const stillOwned = () => this.engine === engine && engine.masterDeck === masterIndex && master.audio === masterMedia && master.transport === masterTransport && master.seekToken === masterSeek && master.rate === masterRate && follower.audio === followerMedia && follower.transport === followerTransport && follower.seekToken === token;
    follower.synced = false;
    follower.rate = rate; this.applyMedia(follower);
    const active = this.isPlaying(master) || this.isPlaying(follower);
    let latency = 0.05, error = Infinity;
    for (let attempt = 0; attempt < (active ? 5 : 1); attempt++) {
      const masterAt = master.audio.currentTime + (this.isPlaying(master) ? master.rate * latency : 0), here = follower.audio.currentTime;
      const phase = fraction((masterAt - mg.offset) * mg.bpm / 60);
      let target = fg.offset + (Math.round((here - fg.offset) / period - phase) + phase) * period;
      if (target < 0) target += period;
      if (target >= fr.duration) target -= period;
      if (target < 0 || target >= fr.duration) throw Error('invalid_position');
      const started = performance.now();
      await seekMedia(follower.audio, target);
      if (!stillOwned()) throw Error('action_superseded');
      latency = (performance.now() - started) / 1000;
      const mp = master.audio.currentTime, fp = follower.audio.currentTime;
      let diff = fraction((mp - mg.offset) * mg.bpm / 60) - fraction((fp - fg.offset) * fg.bpm / 60);
      diff -= Math.round(diff);
      error = Math.abs(diff) * 60 / (fg.bpm * follower.rate);
      if (error < 0.012) break;
    }
    if (active && error > 0.08) throw Error('sync_alignment_failed');
    if (!stillOwned()) throw Error("action_superseded");
    follower.synced = true;
    this.emit();
    return { snapshot: this.snapshot({ syncErrorSeconds: Number.isFinite(error) ? error : null }) };
  }
  reconnect() {
    const old = this.engine;
    if (old) {
      this.emit({ terminal: true, ready: false });
      this.disposeEngine(old);
    }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.createEngine();
    this.emit();
    return { snapshot: this.snapshot() };
  }
  // ----- file selection and import -----------------------------------------
  pickFiles({ multiple, directory }) {
    if (this.picking) throw Error('library_busy');
    const document = this.env.document;
    if (!document?.body) throw Error('file_picker_unavailable');
    if (this.env.navigator?.userActivation && !this.env.navigator.userActivation.isActive) throw Error('gesture_required');
    const input = document.createElement('input');
    input.type = 'file'; input.hidden = true; input.multiple = !!multiple;
    if (directory) input.webkitdirectory = true; else input.accept = PICKER_ACCEPT;
    input.dataset.deckcraftPicker = directory ? 'folder' : multiple ? 'files' : 'file';
    document.body.append(input);
    this.picking = true;
    return new Promise(resolve => {
      let settled = false, timer = null;
      const finish = files => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        this.env.removeEventListener?.('focus', onFocus);
        input.remove(); this.picking = false;
        resolve(files);
      };
      const onFocus = () => { timer = setTimeout(() => finish(input.files?.length ? [...input.files] : null), 1500); };
      input.addEventListener('change', () => finish(input.files?.length ? [...input.files] : null));
      input.addEventListener('cancel', () => finish(null));
      if (!('oncancel' in input)) this.env.addEventListener?.('focus', onFocus, { once: true });
      try { input.click(); } catch { finish(null); }
    });
  }
  exclusive(task) {
    const run = this.busy.then(task, task);
    this.busy = run.catch(() => {});
    return run;
  }
  async pickAndLoad(request) {
    const files = await this.pickFiles({ multiple: false, directory: false });
    if (!files) return { cancelled: true };
    const outcome = await this.importFiles(files.slice(0, 1), { progress: false });
    const added = outcome.all[0];
    if (!added) throw Error(outcome.summary.errors[0]?.error || 'unsupported_or_corrupt_audio');
    const loaded = await this.load({ deck: request.deck, trackId: added.id });
    return { ...loaded, warning: this.warning() };
  }
  async importSelection(request) {
    const files = await this.pickFiles({ multiple: true, directory: request.kind === 'folder' });
    if (!files) return { cancelled: true };
    const outcome = await this.importFiles(files, { folder: request.kind === 'folder', progress: true });
    return { summary: outcome.summary, ...this.libraryResult() };
  }
  async importFiles(files, { folder = false, progress = true } = {}) {
    const limits = BROWSER_STORAGE_LIMITS;
    const summary = { added: 0, existing: 0, failed: 0, skipped: 0, truncated: false, errors: [] };
    const candidates = [];
    for (const file of files) {
      const extension = String(file.name).split('.').pop().toLowerCase();
      if (folder && !FOLDER_EXTENSIONS.has(extension)) summary.skipped++;
      else if (candidates.length >= limits.batchFiles) { summary.skipped++; summary.truncated = true; }
      else candidates.push(file);
    }
    const records = [], all = [];
    let bytes = 0, completed = 0;
    const fail = (file, code) => { summary.failed++; if (summary.errors.length < 5) summary.errors.push({ name: String(file.webkitRelativePath || file.name).slice(0, 120), error: code }); };
    for (const file of candidates) {
      try {
        bytes += file.size;
        if (bytes > limits.batchBytes) { summary.truncated = true; summary.skipped++; continue; }
        const result = await this.exclusive(() => this.importOne(file));
        all.push(result.record);
        if (result.existing) summary.existing++;
        else { summary.added++; records.push(result.record); }
      } catch (error) {
        fail(file, /^[a-z][a-z_]{0,60}$/.test(error?.message || '') ? error.message : 'unsupported_or_corrupt_audio');
      }
      completed++;
      if (progress) this.dispatchEvent({ type: 'import-progress', completed, total: candidates.length, added: summary.added, failed: summary.failed });
    }
    const saved = await this.persistLibrary();
    for (const record of records) {
      if (record.persisted && saved) record.file = null;
      else if (record.persisted) { record.persisted = false; this.markSessionOnly(record); }
    }
    summary.sessionOnly = records.filter(r => !r.persisted).length;
    return { summary, records, all };
  }
  dispatchEvent(event) { for (const callback of [...this.listeners]) { try { callback(event); } catch {} } }
  markSessionOnly(record) {
    this.sessionBytes += record.size;
    this.store.deleteBlobs([record.id]).catch(() => {});
  }
  async importOne(file) {
    const limits = BROWSER_STORAGE_LIMITS;
    if (!file || !(file.size > 0)) throw Error('unsupported_or_corrupt_audio');
    if (file.size > limits.fileBytes) throw Error('file_too_large');
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    for (const record of this.records.values()) if (record.key === key) return { existing: true, record };
    if (this.records.size >= limits.tracks) throw Error('library_capacity');
    const duration = await this.probeDuration(file);
    if (!(duration > 0)) throw Error('duration_unavailable');
    if (duration > limits.durationSeconds) throw Error('unsupported_duration');
    const analysis = await this.analyzeBlob(file, duration);
    const record = {
      id: 'local-' + browserUUID(this.env.crypto), title: sanitizeTitle(file.name), duration: analysis.duration || duration, channels: analysis.channels || 2,
      beatGrid: analysis.beatGrid, artwork: analysis.artwork, analysisVersion: analysis.complete ? 1 : 0, peaks: analysis.peaks, size: file.size, key, persisted: false, file,
    };
    const info = this.storageInfo();
    if (this.store.available && info.usedBytes + file.size <= limits.persistedBytes) {
      try { await this.store.putBlob(record.id, file); record.persisted = true; }
      catch (error) { this.storageWarning = quotaError(error) ? 'Browser storage is full; new files are kept for this session only.' : 'Browser storage could not save a file; it is kept for this session only.'; }
    } else if (this.store.available) this.storageWarning = 'The browser library storage limit was reached; new files are kept for this session only.';
    if (!record.persisted) {
      if (this.sessionBytes + file.size > limits.sessionBytes) { this.store.deleteBlobs([record.id]).catch(() => {}); throw Error('storage_limit_reached'); }
      this.sessionBytes += file.size;
    }
    this.records.set(record.id, record);
    // The File stays referenced until the metadata document is saved; persisted records then drop it.
    return { record };
  }
  async probeDuration(blob) {
    const audio = new this.env.Audio(), url = this.env.URL.createObjectURL(blob);
    try {
      audio.preload = 'metadata'; audio.src = url;
      await waitForMedia(audio, ['loadedmetadata'], ['error'], 15000);
      return Number.isFinite(audio.duration) ? audio.duration : 0;
    } catch (error) { throw Error(error.message === 'media_timeout' ? 'audio_command_timed_out' : 'unsupported_or_corrupt_audio'); }
    finally { try { audio.removeAttribute('src'); audio.load(); } catch {} this.env.URL.revokeObjectURL(url); }
  }
  /** Decodes at a reduced rate, derives peaks/grid, and releases the PCM immediately. */
  async analyzeBlob(blob, probedDuration) {
    const result = { complete: false, peaks: [], beatGrid: null, artwork: null, duration: probedDuration, channels: 2 };
    const Offline = this.env.OfflineAudioContext || this.env.webkitOfflineAudioContext;
    try {
      if (probedDuration * DECODE_RATE * 8 > 300 * 1048576) throw Error('analysis_too_large');
      let buffer = await blob.arrayBuffer();
      const decoded = await new Offline(2, 1, DECODE_RATE).decodeAudioData(buffer);
      buffer = null;
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
      const analysis = analyzeChannels(channels, decoded.sampleRate);
      result.peaks = analysis.peaks.map(v => Math.round(v * 10000) / 10000);
      result.beatGrid = analysis.beatGrid;
      result.channels = decoded.numberOfChannels;
      result.complete = true;
    } catch { /* playable but not analyzable: no waveform or BPM is invented */ }
    try {
      const picture = await findEmbeddedPicture(async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()), blob.size);
      result.artwork = await thumbnailFromPicture(picture, this.env);
    } catch {}
    return result;
  }
  async analyzeTrack(id) {
    const record = this.record(id);
    const blob = record.file || await this.store.getBlob(id);
    if (!blob) throw Error('file_unavailable');
    const analysis = await this.exclusive(() => this.analyzeBlob(blob, record.duration));
    const previous = { ...record };
    Object.assign(record, { beatGrid: analysis.beatGrid, artwork: analysis.artwork || record.artwork, peaks: analysis.complete ? analysis.peaks : record.peaks, analysisVersion: analysis.complete ? 1 : record.analysisVersion });
    if (record.persisted && !(await this.persistLibrary())) { Object.assign(record, previous); throw Error('library_save_failed'); }
    return { track: publicTrack(record), warning: this.warning() };
  }
  // ----- library persistence ----------------------------------------------
  async persistLibrary() {
    if (!this.store.available) return false;
    const persisted = [...this.records.values()].filter(r => r.persisted);
    const ids = new Set(persisted.map(r => r.id));
    const document = { version: 1, tracks: persisted.map(storedTrack), collections: this.collections.map(c => ({ ...c, trackIds: c.trackIds.filter(id => ids.has(id)) })) };
    try { await this.store.writeLibrary(document); return true; }
    catch (error) { this.storageWarning = quotaError(error) ? 'Browser storage is full; the library could not be saved on this device.' : 'The library could not be saved in this browser.'; return false; }
  }
  async forget(ids) {
    const inUse = new Set(this.engine.decks.flatMap(d => [d.trackId, d.target]).filter(Boolean));
    if (ids.some(id => inUse.has(id))) throw Error('track_in_use');
    const previous = new Map(this.records), previousCollections = structuredClone(this.collections);
    for (const id of ids) { const record = previous.get(id); if (record && !record.persisted) this.sessionBytes -= record.size; this.records.delete(id); }
    this.collections = cleanCollections(this.collections, this.records);
    if (this.store.available && !(await this.persistLibrary())) {
      this.records = previous; this.collections = previousCollections;
      throw Error('library_save_failed');
    }
    await this.store.deleteBlobs(ids.filter(id => previous.get(id)?.persisted)).catch(() => {});
    return this.libraryResult();
  }
  async collection(request) {
    const previous = structuredClone(this.collections), next = structuredClone(this.collections);
    let collection = next.find(c => c.id === request.id);
    if (request.type === 'collection-create') {
      collection = { id: 'collection-' + browserUUID(this.env.crypto), kind: request.kind, name: request.name.trim(), trackIds: [] };
      next.push(collection);
    } else {
      if (!collection) throw Error('unknown_collection');
      const known = ids => ids.every(id => this.records.has(id));
      switch (request.type) {
        case 'collection-rename': collection.name = request.name.trim(); break;
        case 'collection-delete': next.splice(next.indexOf(collection), 1); break;
        case 'collection-add': if (!known(request.trackIds)) throw Error('unknown_local_track'); collection.trackIds = [...new Set([...collection.trackIds, ...request.trackIds])]; break;
        case 'collection-remove': collection.trackIds = collection.trackIds.filter(id => !request.trackIds.includes(id)); break;
        case 'collection-move': {
          if (collection.kind !== 'playlist') throw Error('invalid_collection');
          const from = collection.trackIds.indexOf(request.trackId), to = from + request.direction;
          if (from < 0) throw Error('unknown_local_track');
          if (to >= 0 && to < collection.trackIds.length) [collection.trackIds[from], collection.trackIds[to]] = [collection.trackIds[to], collection.trackIds[from]];
          break;
        }
        default: throw Error('invalid_command');
      }
    }
    const cleaned = cleanCollections(next, this.records);
    if (cleaned.length !== next.length || cleaned.some((c, i) => c.trackIds.length !== next[i].trackIds.length)) throw Error('invalid_collection');
    this.collections = cleaned;
    if (this.store.available && !(await this.persistLibrary())) { this.collections = previous; throw Error('library_save_failed'); }
    return { collection: structuredClone(cleaned.find(c => c.id === (collection.id))) ?? null, ...this.libraryResult() };
  }
}

/** Resolves {bridge, support}; bridge is null (never throws) when this browser cannot play audio. */
export async function createBrowserBridge(env = globalThis) {
  const support = detectBrowserAudio(env);
  if (!support.supported) return { bridge: null, support };
  try {
    const bridge = new BrowserAudioBridge(env, new BrowserFileStore(env.indexedDB), support);
    await bridge.initialize();
    return { bridge, support };
  } catch {
    return { bridge: null, support: { ...support, supported: false, reasons: ['browser audio initialization'] } };
  }
}
