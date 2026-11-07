import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAudioBridge, createBrowserBridge, detectBrowserAudio, validateBrowserCommand } from '../src/browser-audio.js';
import { BROWSER_STORAGE_LIMITS, BrowserFileStore, browserUUID } from '../src/browser-store.js';
import { clickPCM, createFakeEnv, fakeFile, fakeIndexedDB } from './browser-fakes.js';

// bytes[0] picks the fake decoder result: 0 = undecodable, 255 = silence, otherwise a click track at that BPM
const decode = bytes => bytes[0] === 0 ? null : bytes[0] === 255 ? [new Float32Array(24000 * 20), new Float32Array(24000 * 20)] : clickPCM(bytes[0]);
const audioFile = (name, bpm, options = {}) => fakeFile(name, { bytes: new Uint8Array(4096).fill(bpm), duration: 40, ...options });
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const booted = [];
after(() => booted.forEach(bridge => bridge?.dispose()));
async function boot(options = {}) {
  const env = createFakeEnv({ contextState: 'running', decode, ...options });
  const { bridge, support } = await createBrowserBridge(env);
  const events = []; bridge?.onEvent(event => events.push(event));
  booted.push(bridge);
  return { env, bridge, support, events };
}
async function addTracks(env, bridge, ...files) {
  env.nextPick = files;
  const result = await bridge.command({ type: 'import', kind: 'files' });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
const idOf = (result, name) => result.tracks.find(track => track.title === name).id;
const deckOf = (snapshot, id) => snapshot.decks.find(deck => deck.id === id);

test('commands use the native semantic shapes; unknown fields, ranges and types are rejected', () => {
  for (const ok of [{ type: 'status' }, { type: 'tempo', deck: 'A', rate: 1.08, pitchLock: true }, { type: 'seek', deck: 'B', position: 0 }, { type: 'import', kind: 'folder' }, { type: 'crossfader', value: 100 }])
    assert.deepEqual(validateBrowserCommand(ok), ok);
  const bad = [null, [], 'play', {}, { type: 'constructor' }, { type: '__proto__' }, { type: 'play' }, { type: 'play', deck: 'E' }, { type: 'play', deck: 'A', extra: 1 },
    { type: 'tempo', deck: 'A', rate: 1.2, pitchLock: true }, { type: 'tempo', deck: 'A', rate: 0.9, pitchLock: true }, { type: 'tempo', deck: 'A', rate: 1, pitchLock: 'yes' }, { type: 'tempo', deck: 'A', rate: NaN, pitchLock: false },
    { type: 'seek', deck: 'A', position: -1 }, { type: 'seek', deck: 'A', position: 7201 }, { type: 'level', deck: 'A', value: 101 }, { type: 'crossfader', value: -1 },
    { type: 'load', deck: 'A', trackId: 'afterlight' }, { type: 'import', kind: 'path' }, { type: 'pick', deck: 'A', path: '/etc/passwd' }, { type: 'forget', trackIds: [] },
    { type: 'collection-create', kind: 'crate', name: '  ' }, { type: 'collection-rename', id: 'x', name: 'y' }, { type: 'collection-move', id: 'collection-00000000-0000-0000-0000-000000000000', trackId: 'local-00000000-0000-0000-0000-000000000000', direction: 2 }];
  for (const request of bad) assert.throws(() => validateBrowserCommand(request), /^Error: invalid_/, JSON.stringify(request));
});

test('capability detection never requires a secure context and reports pitch lock honestly', async () => {
  const env = createFakeEnv();
  const support = detectBrowserAudio(env);
  assert.deepEqual({ supported: support.supported, pitchLock: support.pitchLock, secureContext: support.secureContext, indexedDB: support.indexedDB }, { supported: true, pitchLock: true, secureContext: false, indexedDB: true });
  assert.equal(detectBrowserAudio(createFakeEnv({ pitchLock: false })).pitchLock, false);
  const missing = createFakeEnv(); delete missing.AudioContext;
  const outcome = await createBrowserBridge(missing);
  assert.equal(outcome.bridge, null); assert.deepEqual(outcome.support.reasons, ['Web Audio']);
  const broken = await createBrowserBridge(createFakeEnv({ contextThrows: true }));
  assert.ok(broken.bridge); assert.equal((await broken.bridge.command({ type: 'status' })).snapshot.ready, false);
  assert.equal((await broken.bridge.command({ type: 'play', deck: 'A' })).error, 'audio_output_unavailable');
});

test('identifiers fall back to getRandomValues when randomUUID is unavailable', () => {
  const uuid = browserUUID({ getRandomValues: bytes => bytes.fill(171) });
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(browserUUID({ randomUUID: () => 'native-value' }), 'native-value');
  assert.throws(() => browserUUID({}), /secure_random_unavailable/);
});

test('import analyzes files, reports every failure and keeps the originals in browser storage only', async () => {
  const { env, bridge } = await boot();
  const slow = audioFile('long.wav', 100, { duration: BROWSER_STORAGE_LIMITS.durationSeconds + 1 });
  const huge = fakeFile('huge.wav', { size: 10 }); Object.defineProperty(huge, 'size', { value: BROWSER_STORAGE_LIMITS.fileBytes + 1 });
  const result = await addTracks(env, bridge, audioFile('Clicks 120.wav', 120), audioFile('Silence.wav', 255), audioFile('broken.wav', 0), audioFile('corrupt.wav', 120, { corrupt: true }), slow, huge, fakeFile('empty.wav', { size: 0 }));
  assert.equal(result.summary.added, 3); assert.equal(result.summary.failed, 4);
  const errors = Object.fromEntries(result.summary.errors.map(e => [e.name, e.error]));
  assert.equal(errors['corrupt.wav'], 'unsupported_or_corrupt_audio'); assert.equal(errors['long.wav'], 'unsupported_duration'); assert.equal(errors['huge.wav'], 'file_too_large');
  const clicks = result.tracks.find(t => t.title === 'Clicks 120.wav'), silence = result.tracks.find(t => t.title === 'Silence.wav'), broken = result.tracks.find(t => t.title === 'broken.wav');
  assert.equal(broken.analysisVersion, 0); assert.deepEqual(broken.peaks, []); assert.equal(broken.beatGrid, null, 'playable but undecodable files get no invented waveform or BPM');
  assert.ok(Math.abs(clicks.beatGrid.bpm - 120) < 0.7); assert.equal(clicks.peaks.length, 512); assert.equal(clicks.local, true); assert.equal(clicks.persisted, true);
  assert.equal(silence.beatGrid, null); assert.equal(silence.bpm, 0);
  assert.ok(!('path' in clicks) && !('file' in clicks));
  assert.equal(env.indexedDB.stores.blobs.size, 3); assert.equal(env.indexedDB.stores.meta.get('library').tracks.length, 3);
});

test('duplicates are detected, folder imports skip non-audio, batches and capacity are bounded', async () => {
  const { env, bridge } = await boot();
  const same = audioFile('Same.wav', 120, { modified: 7 });
  await addTracks(env, bridge, same);
  const again = await addTracks(env, bridge, audioFile('Same.wav', 120, { modified: 7 }));
  assert.deepEqual([again.summary.added, again.summary.existing], [0, 1]);
  env.nextPick = [fakeFile('cover.jpg', {}), fakeFile('notes.txt', {}), audioFile('song.mp3', 110)];
  const folder = await bridge.command({ type: 'import', kind: 'folder' });
  assert.deepEqual([folder.summary.added, folder.summary.skipped], [1, 2]);
  env.nextPick = Array.from({ length: BROWSER_STORAGE_LIMITS.batchFiles + 5 }, (_, i) => audioFile(`bulk-${i}.wav`, 90 + (i % 5)));
  const bulk = await bridge.command({ type: 'import', kind: 'files' });
  assert.equal(bulk.summary.added, BROWSER_STORAGE_LIMITS.batchFiles); assert.equal(bulk.summary.truncated, true); assert.equal(bulk.summary.skipped, 5);
});

test('cancel, missing user activation and concurrent pickers are explicit', async () => {
  const { env, bridge } = await boot();
  env.nextPick = 'cancel';
  assert.deepEqual(await bridge.command({ type: 'import', kind: 'files' }), { ok: true, cancelled: true });
  env.nextPick = [];
  assert.deepEqual(await bridge.command({ type: 'import', kind: 'files' }), { ok: true, cancelled: true });
  env.navigator.userActivation.isActive = false;
  assert.equal((await bridge.command({ type: 'import', kind: 'files' })).error, 'gesture_required');
  env.navigator.userActivation.isActive = true; env.nextPick = [audioFile('one.wav', 120)];
  const first = bridge.command({ type: 'import', kind: 'files' });
  assert.equal((await bridge.command({ type: 'pick', deck: 'A' })).error, 'library_busy');
  assert.equal((await first).ok, true);
});

test('storage exhaustion degrades to visible session-only sources and survives no IndexedDB', async () => {
  const quota = await boot({ indexedDB: fakeIndexedDB({ failPuts: name => name === 'blobs' }) });
  const result = await addTracks(quota.env, quota.bridge, audioFile('Full.wav', 120));
  assert.equal(result.summary.sessionOnly, 1); assert.equal(result.tracks[0].persisted, false); assert.match(result.warning, /session only/);
  const loaded = await quota.bridge.command({ type: 'load', deck: 'A', trackId: result.tracks[0].id });
  assert.equal(loaded.ok, true, 'a session-only source is still playable');
  const none = await boot({ indexedDB: null });
  const noStore = await addTracks(none.env, none.bridge, audioFile('Memory.wav', 120));
  assert.equal(noStore.tracks[0].persisted, false); assert.match(noStore.warning, /blocked local file storage/);
  const metadata = await boot({ indexedDB: fakeIndexedDB({ failPuts: name => name === 'meta' }) });
  const unsaved = await addTracks(metadata.env, metadata.bridge, audioFile('Meta.wav', 120));
  assert.equal(unsaved.tracks[0].persisted, false); assert.equal(unsaved.summary.sessionOnly, 1);
  assert.equal(metadata.env.indexedDB.stores.blobs.size, 0, 'unreferenced blobs are removed when metadata cannot be saved');
});

test('persisted library and collections restore in a new session; orphans are collected', async () => {
  const first = await boot();
  const imported = await addTracks(first.env, first.bridge, audioFile('Kept.wav', 120), audioFile('Other.wav', 100));
  const created = await first.bridge.command({ type: 'collection-create', kind: 'playlist', name: 'Set one' });
  await first.bridge.command({ type: 'collection-add', id: created.collection.id, trackIds: imported.tracks.map(t => t.id) });
  first.env.indexedDB.stores.blobs.set('local-00000000-0000-0000-0000-00000000dead', new Blob(['x']));
  const second = await boot({ indexedDB: first.env.indexedDB });
  const library = await second.bridge.command({ type: 'library' });
  assert.deepEqual(library.tracks.map(t => t.title).sort(), ['Kept.wav', 'Other.wav']);
  assert.equal(library.collections[0].name, 'Set one'); assert.equal(library.collections[0].trackIds.length, 2);
  assert.equal(first.env.indexedDB.stores.blobs.has('local-00000000-0000-0000-0000-00000000dead'), false);
  const loaded = await second.bridge.command({ type: 'load', deck: 'B', trackId: idOf(library, 'Kept.wav') });
  assert.equal(loaded.ok, true); assert.equal(deckOf(loaded.snapshot, 'B').playing, false, 'restored sources load paused');
  assert.equal(second.env.audios.filter(a => a.src).length >= 1, true);
});

test('collections validate, roll back when the save fails, and forget protects loaded sources', async () => {
  let fail = false;
  const env0 = { failPuts: () => fail };
  const { env, bridge } = await boot({ indexedDB: fakeIndexedDB(env0) });
  const result = await addTracks(env, bridge, audioFile('A.wav', 120), audioFile('B.wav', 100));
  const [a, b] = result.tracks.map(t => t.id);
  const crate = await bridge.command({ type: 'collection-create', kind: 'crate', name: ' Crate ' });
  assert.equal(crate.collection.name, 'Crate');
  assert.equal((await bridge.command({ type: 'collection-add', id: crate.collection.id, trackIds: ['local-00000000-0000-0000-0000-000000000000'] })).error, 'unknown_local_track');
  assert.equal((await bridge.command({ type: 'collection-move', id: crate.collection.id, trackId: a, direction: 1 })).error, 'invalid_collection');
  fail = true;
  assert.equal((await bridge.command({ type: 'collection-add', id: crate.collection.id, trackIds: [a] })).error, 'library_save_failed');
  fail = false;
  assert.deepEqual((await bridge.command({ type: 'library' })).collections[0].trackIds, [], 'failed save rolled back');
  await bridge.command({ type: 'load', deck: 'C', trackId: a });
  assert.equal((await bridge.command({ type: 'forget', trackIds: [a] })).error, 'track_in_use');
  const forgotten = await bridge.command({ type: 'forget', trackIds: [b] });
  assert.equal(forgotten.ok, true); assert.deepEqual(forgotten.tracks.map(t => t.id), [a]); assert.equal(env.indexedDB.stores.blobs.has(b), false);
  assert.equal((await bridge.command({ type: 'load', deck: 'A', trackId: b })).error, 'unknown_local_track');
});

test('load is transactional, plays only after context resume, and a newer pause beats a starting play', async () => {
  const { env, bridge, events } = await boot({ contextState: 'suspended' });
  const imported = await addTracks(env, bridge, audioFile('One.wav', 120), audioFile('Bad.wav', 100));
  const one = idOf(imported, 'One.wav'), bad = idOf(imported, 'Bad.wav');
  assert.equal((await bridge.command({ type: 'play', deck: 'A' })).error, 'deck_unloaded');
  const loaded = await bridge.command({ type: 'load', deck: 'A', trackId: one });
  assert.equal(loaded.ok, true); assert.equal(deckOf(loaded.snapshot, 'A').trackId, one); assert.equal(deckOf(loaded.snapshot, 'A').playing, false);
  const urlsAfterLoad = env.urls.size;
  env.urls.forEach((blob, url) => { if (blob.name === 'Bad.wav') blob.fixture.corrupt = true; });
  assert.equal((await bridge.command({ type: 'load', deck: 'A', trackId: bad })).ok, true, 'probe-time fixtures are decodable until played'); // Bad.wav analyzed fine
  assert.equal((await bridge.command({ type: 'load', deck: 'A', trackId: one })).ok, true);
  assert.equal(env.urls.size <= urlsAfterLoad + 1, true, 'object URLs of replaced sources are released');
  env.contexts[0].setState('suspended'); env.contextBlocked = true;
  assert.equal((await bridge.command({ type: 'play', deck: 'A' })).error, 'audio_context_blocked');
  env.contextBlocked = false;
  const played = await bridge.command({ type: 'play', deck: 'A' });
  assert.equal(played.ok, true); assert.equal(env.contexts[0].state, 'running'); assert.equal(deckOf(played.snapshot, 'A').playing, true);
  await bridge.command({ type: 'pause', deck: 'A' });
  env.holdPlay = true;
  const starting = bridge.command({ type: 'play', deck: 'A' });
  await settle(); const paused = await bridge.command({ type: 'pause', deck: 'A' });
  const outcome = await starting;
  assert.equal(outcome.ok, true); assert.equal(deckOf(outcome.snapshot, 'A').playing, false); assert.equal(deckOf(paused.snapshot, 'A').playing, false);
  env.holdPlay = false; env.playError = 'NotAllowedError';
  assert.equal((await bridge.command({ type: 'play', deck: 'A' })).error, 'autoplay_blocked');
  env.playError = null;
  const seqs = events.filter(e => e.type === 'state').map(e => e.snapshot.seq); assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
});

test('seek, natural end and restart use the media clock and never start playback', async () => {
  const { env, bridge } = await boot();
  const imported = await addTracks(env, bridge, audioFile('Seek.wav', 120));
  await bridge.command({ type: 'load', deck: 'A', trackId: idOf(imported, 'Seek.wav') });
  const element = env.audios.find(a => a.src);
  const seek = await bridge.command({ type: 'seek', deck: 'A', position: 12.5 });
  assert.equal(element.currentTime, 12.5); assert.equal(deckOf(seek.snapshot, 'A').position, 12.5); assert.equal(deckOf(seek.snapshot, 'A').playing, false);
  assert.equal((await bridge.command({ type: 'seek', deck: 'A', position: 99 })).error, 'invalid_position');
  await bridge.command({ type: 'play', deck: 'A' });
  element.currentTime = 20; assert.equal(deckOf((await bridge.command({ type: 'status' })).snapshot, 'A').position, 20, 'position is the measured element time');
  element.finish();
  const ended = (await bridge.command({ type: 'status' })).snapshot; assert.equal(deckOf(ended, 'A').playing, false);
  await bridge.command({ type: 'play', deck: 'A' });
  assert.equal(element.seeks.at(-1), 0, 'a play after the natural end restarts from zero'); assert.equal(element.paused, false);
});

test('tempo and pitch lock are written to the media element; unsupported lock is never reported active', async () => {
  const { env, bridge } = await boot();
  const imported = await addTracks(env, bridge, audioFile('Tempo.wav', 120));
  await bridge.command({ type: 'load', deck: 'A', trackId: idOf(imported, 'Tempo.wav') });
  const element = env.audios.find(a => a.src);
  let r = await bridge.command({ type: 'tempo', deck: 'A', rate: 1.08, pitchLock: false });
  assert.deepEqual([element.playbackRate, element.preservesPitch, element.defaultPlaybackRate], [1.08, false, 1.08]);
  assert.deepEqual([deckOf(r.snapshot, 'A').rate, deckOf(r.snapshot, 'A').pitchLock], [1.08, false]);
  r = await bridge.command({ type: 'tempo', deck: 'A', rate: 0.92, pitchLock: true });
  assert.deepEqual([element.playbackRate, element.preservesPitch], [0.92, true]); assert.equal(deckOf(r.snapshot, 'A').pitchLock, true);
  const reloaded = await bridge.command({ type: 'load', deck: 'A', trackId: idOf(imported, 'Tempo.wav') });
  const fresh = env.audios.filter(a => a.src).at(-1);
  assert.deepEqual([fresh.playbackRate, fresh.preservesPitch, deckOf(reloaded.snapshot, 'A').rate], [0.92, true, 0.92], 'rate and lock survive loading another source');
  const unsupported = await boot({ pitchLock: false });
  const imported2 = await addTracks(unsupported.env, unsupported.bridge, audioFile('Tempo.wav', 120));
  await unsupported.bridge.command({ type: 'load', deck: 'A', trackId: idOf(imported2, 'Tempo.wav') });
  assert.equal((await unsupported.bridge.command({ type: 'tempo', deck: 'A', rate: 1.05, pitchLock: true })).error, 'pitch_lock_unsupported');
  const flat = await unsupported.bridge.command({ type: 'tempo', deck: 'A', rate: 1, pitchLock: true });
  assert.equal(deckOf(flat.snapshot, 'A').pitchLock, false); assert.equal(flat.snapshot.capabilities.pitchLock, false);
  const free = await unsupported.bridge.command({ type: 'tempo', deck: 'A', rate: 1.05, pitchLock: false });
  assert.equal(deckOf(free.snapshot, 'A').rate, 1.05);
});

test('explicit master and Sync align measured beat phase, follow master tempo and clear on independent transport', async () => {
  const { env, bridge } = await boot();
  const imported = await addTracks(env, bridge, audioFile('Master.wav', 120), audioFile('Follower.wav', 126), audioFile('Tone.wav', 255), audioFile('Far.wav', 150));
  const [m, f, t, far] = ['Master.wav', 'Follower.wav', 'Tone.wav', 'Far.wav'].map(n => idOf(imported, n));
  for (const [deck, id] of [['A', m], ['B', f], ['C', t], ['D', far]]) await bridge.command({ type: 'load', deck, trackId: id });
  const grid = Object.fromEntries(imported.tracks.map(x => [x.id, x.beatGrid]));
  const el = Object.fromEntries(['Master.wav', 'Follower.wav'].map(n => [n, env.audios.filter(a => a.src && env.urls.get(a.src)?.name === n).at(-1)]));
  assert.equal((await bridge.command({ type: 'sync', deck: 'B' })).error, 'sync_master_required');
  await bridge.command({ type: 'master', deck: 'A' });
  assert.equal((await bridge.command({ type: 'sync', deck: 'A' })).error, 'sync_same_deck');
  assert.equal((await bridge.command({ type: 'sync', deck: 'C' })).error, 'beat_grid_unavailable');
  assert.equal((await bridge.command({ type: 'sync', deck: 'D' })).error, 'sync_tempo_out_of_range');
  el['Master.wav'].currentTime = 10.31; el['Follower.wav'].currentTime = 3.2;
  const synced = await bridge.command({ type: 'sync', deck: 'B' });
  assert.equal(synced.ok, true, JSON.stringify(synced)); assert.equal(deckOf(synced.snapshot, 'B').synced, true);
  const gm = grid[m], gf = grid[f];
  assert.ok(Math.abs(deckOf(synced.snapshot, 'B').rate - gm.bpm / gf.bpm) < 1e-9);
  const phase = (time, g) => { const p = (time - g.offset) * g.bpm / 60; return p - Math.floor(p); };
  let diff = phase(10.31, gm) - phase(el['Follower.wav'].currentTime, gf); diff -= Math.round(diff);
  assert.ok(Math.abs(diff) < 0.02, 'follower landed on the master beat phase: ' + diff);
  const tempo = await bridge.command({ type: 'tempo', deck: 'A', rate: 1.04, pitchLock: true });
  assert.ok(Math.abs(deckOf(tempo.snapshot, 'B').rate - gm.bpm * 1.04 / gf.bpm) < 1e-9); assert.equal(deckOf(tempo.snapshot, 'B').synced, true);
  const rejected = await bridge.command({ type: 'tempo', deck: 'A', rate: 0.92, pitchLock: true });
  assert.equal(rejected.error, 'sync_tempo_out_of_range', 'a master tempo that would push a follower out of range is refused as a whole');
  const after = (await bridge.command({ type: 'status' })).snapshot;
  assert.equal(deckOf(after, 'A').rate, 1.04); assert.ok(Math.abs(deckOf(after, 'B').rate - gm.bpm * 1.04 / gf.bpm) < 1e-9);
  await bridge.command({ type: 'seek', deck: 'B', position: 9 });
  assert.equal(deckOf((await bridge.command({ type: 'status' })).snapshot, 'B').synced, false, 'independent seek clears follower sync');
  await bridge.command({ type: 'sync', deck: 'B' });
  await bridge.command({ type: 'seek', deck: 'A', position: 4 });
  assert.equal(deckOf((await bridge.command({ type: 'status' })).snapshot, 'B').synced, false, 'moving the master clears dependent sync');
  await bridge.command({ type: 'sync', deck: 'B' });
  await bridge.command({ type: 'master', deck: 'D' });
  assert.equal(deckOf((await bridge.command({ type: 'status' })).snapshot, 'B').synced, false, 'choosing another master clears sync');
  await bridge.command({ type: 'master', deck: 'A' });
  await bridge.command({ type: 'sync', deck: 'B' });
  await bridge.command({ type: 'pause', deck: 'A' });
  assert.equal(deckOf((await bridge.command({ type: 'status' })).snapshot, 'B').synced, false, 'pausing the master clears sync');
});

test('a suspended context stops every deck, reports it, and nothing restarts by itself', async () => {
  const { env, bridge, events } = await boot();
  const imported = await addTracks(env, bridge, audioFile('Hold.wav', 120));
  await bridge.command({ type: 'load', deck: 'A', trackId: idOf(imported, 'Hold.wav') });
  await bridge.command({ type: 'play', deck: 'A' });
  const element = env.audios.find(a => a.src);
  assert.equal(element.paused, false);
  env.contexts[0].setState('suspended');
  assert.equal(element.paused, true);
  const snapshot = (await bridge.command({ type: 'status' })).snapshot;
  assert.equal(deckOf(snapshot, 'A').playing, false); assert.equal(snapshot.error, 'audio_output_suspended'); assert.equal(snapshot.output.state, 'suspended');
  env.contexts[0].setState('running'); await settle(30);
  assert.equal(element.paused, true, 'resuming the context does not replay');
  assert.ok(events.some(e => e.snapshot?.error === 'audio_output_suspended'));
  const again = await bridge.command({ type: 'play', deck: 'A' });
  assert.equal(again.ok, true); assert.equal(deckOf(again.snapshot, 'A').playing, true); assert.equal(again.snapshot.error, null);
});

test('reconnect retires the old engine, releases its sources and starts a fresh one', async () => {
  const { env, bridge, events } = await boot();
  const imported = await addTracks(env, bridge, audioFile('Re.wav', 120));
  const loaded = await bridge.command({ type: 'load', deck: 'A', trackId: idOf(imported, 'Re.wav') });
  const oldIds = [loaded.snapshot.engineId, loaded.snapshot.sourceId];
  const liveUrls = env.urls.size;
  const result = await bridge.command({ type: 'reconnect' });
  const terminal = events.find(e => e.snapshot?.terminal);
  assert.deepEqual([terminal.snapshot.engineId, terminal.snapshot.sourceId], oldIds); assert.equal(terminal.snapshot.ready, false);
  assert.notEqual(result.snapshot.engineId, oldIds[0]); assert.notEqual(result.snapshot.sourceId, oldIds[1]);
  assert.equal(deckOf(result.snapshot, 'A').trackId, null, 'a new engine starts with empty decks; the UI reloads them paused');
  assert.ok(env.urls.size < liveUrls, 'object URLs of the retired engine were released'); assert.equal(env.contexts[0].state, 'closed'); assert.equal(env.contexts.length, 2);
});

test('the shared session drives the browser engine: import, load, play, pause, sync clears and no replay after failure', async () => {
  const { createStore } = await import('../src/store.js');
  const { NativeSession, restoreNativeCatalog } = await import('../src/native.js');
  const { setBackendActive, trackById } = await import('../src/catalog.js');
  const { env, bridge } = await boot();
  setBackendActive('browser');
  try {
    await restoreNativeCatalog(bridge);
    const memory = new Map();
    const store = createStore({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) });
    const messages = [];
    const session = new NativeSession(bridge, store, { redraw() {}, say: message => messages.push(message) });
    assert.equal(session.profile.id, 'browser');
    await session.initialize();
    env.nextPick = [audioFile('Shared.wav', 120)];
    await session.importAudio('A');
    const id = store.get().decks.A.trackId;
    assert.equal(trackById(id).local, true); assert.equal(store.get().decks.A.playing, false);
    session.dispatch({ type: 'deck', deck: 'A', field: 'playing', value: true });
    await settle(60);
    assert.equal(store.get().decks.A.playing, true, messages.join('; '));
    env.audios.find(a => a.src).currentTime = 7;
    bridge.emit(); await settle();
    assert.equal(store.get().decks.A.position, 7, 'UI position is the media clock');
    env.contexts[0].setState('suspended'); await settle();
    assert.equal(store.get().decks.A.playing, false); env.contexts[0].setState('running'); await settle(40);
    assert.equal(store.get().decks.A.playing, false, 'no automatic replay');
    assert.equal(session.pitchLockSupported, true);
  } finally { setBackendActive(null); }
});


test('Pause supersedes Play while the browser audio context is still resuming', async () => {
  const {env,bridge}=await boot();
  const tracks=await addTracks(env,bridge,audioFile('Resume.wav',120));
  await bridge.command({type:'load',deck:'A',trackId:tracks.tracks[0].id});
  const ctx=env.contexts[0];ctx.setState('suspended');
  let release;const gate=new Promise(resolve=>{release=resolve;});
  ctx.resume=()=>gate.then(()=>ctx.setState('running'));
  const pending=bridge.command({type:'play',deck:'A'});
  await settle();await bridge.command({type:'pause',deck:'A'});release();
  const result=await pending;
  assert.equal(deckOf(result.snapshot,'A').playing,false);
  assert.equal(bridge.engine.decks[0].audio.paused,true);
});

test('Pause or a changed master cancels a pending Sync seek without reasserting alignment',async()=>{
  const {env,bridge}=await boot();
  const tracks=await addTracks(env,bridge,audioFile('Master.wav',120),audioFile('Follower.wav',126));
  for(const [deck,name] of [['A','Master.wav'],['B','Follower.wav']])await bridge.command({type:'load',deck,trackId:idOf(tracks,name)});
  await bridge.command({type:'master',deck:'A'});
  const audio=bridge.engine.decks[1].audio;let finish;
  Object.defineProperty(audio,'currentTime',{get(){return this._time||0;},set(value){this._time=value;finish=()=>this.dispatchEvent(new Event('seeked'));}});
  for(const action of [{type:'pause',deck:'B'},{type:'master',deck:'B'}]){
    const pending=bridge.command({type:'sync',deck:'B'});await settle();
    await bridge.command(action);finish();
    const result=await pending;assert.equal(result.ok,false);assert.equal(result.error,'action_superseded');
    assert.equal(bridge.engine.decks[1].synced,false);assert.equal(audio.paused,true);
  }
});
