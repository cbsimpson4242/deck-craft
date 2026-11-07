// Minimal in-memory stand-ins for the browser APIs the audio backend uses.
// They model state and event ordering, not audio signal; the real-browser lane covers sound.
export class FakeAudio extends EventTarget {
  constructor(env) {
    super();
    Object.assign(this, { env, paused: true, ended: false, seeking: false, duration: NaN, playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: true, preload: '', loop: false });
    this._src = ''; this.pendingPlay = null; this.seeks = [];
    env.audios.push(this);
  }
  get src() { return this._src; }
  set src(value) {
    this._src = value;
    if (!value) return;
    queueMicrotask(() => {
      if (this._src !== value) return;
      const blob = this.env.urls.get(value);
      if (!blob || blob.fixture?.corrupt) this.dispatchEvent(new Event('error'));
      else { this.duration = blob.fixture?.duration ?? 30; this.dispatchEvent(new Event('loadedmetadata')); }
    });
  }
  removeAttribute(name) { if (name === 'src') this._src = ''; }
  load() { if (!this._src) { this.duration = NaN; this.currentTime = 0; this.dispatchEvent(new Event('emptied')); } }
  play() {
    if (this.env.playError) return Promise.reject(Object.assign(Error('blocked'), { name: this.env.playError }));
    this.paused = false; this.ended = false;
    this.dispatchEvent(new Event('play'));
    if (this.env.holdPlay) return new Promise((resolve, reject) => { this.pendingPlay = { resolve, reject }; });
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.pendingPlay) { this.pendingPlay.reject(Object.assign(Error('interrupted'), { name: 'AbortError' })); this.pendingPlay = null; }
    this.dispatchEvent(new Event('pause'));
  }
  set currentTime(value) { this._time = value; this.seeks?.push(value); queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
  get currentTime() { return this._time ?? 0; }
  finish() { this.paused = true; this.ended = true; this._time = this.duration; this.dispatchEvent(new Event('ended')); }
}
class FakeGain { constructor() { this.gain = { value: 1, setTargetAtTime: value => { this.gain.value = value; } }; } connect() {} disconnect() {} }
export class FakeContext {
  constructor(env) { this.env = env; this.state = env.contextState || 'suspended'; this.sampleRate = 48000; this.currentTime = 0; this.destination = {}; this.sources = []; env.contexts.push(this); if (env.contextThrows) throw Error('no audio'); }
  createGain() { return new FakeGain(); }
  createMediaElementSource(element) { const source = { element, connect() {}, disconnect() {} }; this.sources.push(source); return source; }
  async resume() { if (this.env.contextBlocked) return new Promise(() => {}); this.setState('running'); }
  async suspend() { this.setState('suspended'); }
  async close() { this.state = 'closed'; }
  setState(state) { if (this.state === state) return; this.state = state; this.onstatechange?.(); }
}
export class FakeOffline {
  constructor(env) { this.env = env; }
  async decodeAudioData(buffer) {
    const decoded = this.env.decode?.(new Uint8Array(buffer));
    if (!decoded) throw Error('EncodingError');
    return { numberOfChannels: decoded.length, sampleRate: 24000, duration: decoded[0].length / 24000, getChannelData: i => decoded[i] };
  }
}
class FakeInput extends EventTarget {
  constructor(env) { super(); this.env = env; this.dataset = {}; this.files = []; }
  click() { const pick = this.env.nextPick; queueMicrotask(() => { if (pick === 'cancel') this.dispatchEvent(new Event('cancel')); else { this.files = pick || []; this.dispatchEvent(new Event('change')); } }); }
  remove() { this.removed = true; }
}
export function fakeIndexedDB(options = {}) {
  const stores = { blobs: new Map(), meta: new Map() };
  const request = work => { const req = {}; queueMicrotask(() => { try { req.result = work(); req.onsuccess?.(); } catch (error) { req.error = error; req.onerror?.(); } }); return req; };
  const db = {
    transaction(names, mode) {
      const list = [].concat(names), tx = {};
      let failed = null;
      const settle = () => queueMicrotask(() => queueMicrotask(() => { if (failed) { tx.error = failed; tx.onabort?.(); tx.onerror?.(); } else tx.oncomplete?.(); }));
      tx.objectStore = name => ({
        put: (value, key) => { if (mode === 'readwrite' && options.failPuts?.(name, key)) failed = Object.assign(Error('quota'), { name: 'QuotaExceededError' }); else stores[name].set(key, value); settle(); },
        delete: key => { stores[name].delete(key); settle(); },
        get: key => request(() => stores[name].get(key)),
        getAllKeys: () => request(() => [...stores[name].keys()]),
        count: () => request(() => stores[name].size),
      });
      if (mode !== 'readwrite') settle();
      return tx;
    },
    createObjectStore() {},
    close() {},
  };
  return { stores, open() { const req = {}; queueMicrotask(() => { req.result = db; req.onupgradeneeded?.(); req.onsuccess?.(); }); return req; } };
}
export function createFakeEnv(options = {}) {
  const env = { audios: [], contexts: [], urls: new Map(), revoked: [], nextPick: null, contextState: options.contextState, contextThrows: options.contextThrows, isSecureContext: false };
  let urlCounter = 0;
  env.Audio = function (...args) { return new FakeAudio(env, ...args); };
  env.HTMLMediaElement = class { }; env.HTMLMediaElement.prototype.preservesPitch = true;
  if (options.pitchLock === false) delete env.HTMLMediaElement.prototype.preservesPitch;
  env.AudioContext = function () { return new FakeContext(env); };
  env.OfflineAudioContext = function () { return new FakeOffline(env); };
  env.URL = { createObjectURL: blob => { const url = 'blob:fake/' + ++urlCounter; env.urls.set(url, blob); return url; }, revokeObjectURL: url => { env.urls.delete(url); env.revoked.push(url); } };
  env.File = File; env.Blob = Blob;
  env.crypto = { getRandomValues: bytes => { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); return bytes; } };
  env.navigator = { userActivation: { isActive: true } };
  env.document = { body: { append: () => {} }, createElement: () => new FakeInput(env) };
  env.addEventListener = () => {}; env.removeEventListener = () => {};
  env.indexedDB = options.indexedDB === undefined ? fakeIndexedDB() : options.indexedDB;
  env.decode = options.decode;
  return env;
}
let fileCounter = 0;
export function fakeFile(name, { duration = 30, size = 4096, corrupt = false, modified, bytes } = {}) {
  const file = new File([bytes || new Uint8Array(size)], name, { type: 'audio/wav', lastModified: modified ?? 1000 + ++fileCounter });
  file.fixture = { duration, corrupt };
  return file;
}
/** Stereo click track at 24 kHz for the fake decoder. */
export function clickPCM(bpm, seconds = 40, offset = 0.17, rate = 24000) {
  const x = new Float32Array(Math.round(seconds * rate)), period = 60 / bpm;
  for (let n = 0; ; n++) { const start = Math.round((offset + n * period) * rate); if (start >= x.length) break; for (let i = 0; i < 600 && start + i < x.length; i++) x[start + i] = 0.9 * Math.exp(-i / 140) * Math.sin(i * 0.4); }
  return [x, x];
}
