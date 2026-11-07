// Real-browser audio verification for the in-browser backend.
// Serves dist over plain HTTP on a non-loopback address (not a secure context), drives
// Chromium over CDP with real input events and an injected OS file-chooser selection,
// and captures what the browser actually emits from an explicitly isolated PulseAudio
// null sink. It never selects a physical output. Evidence stays outside public source.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PULSE_SERVER?.startsWith('unix:') || !process.env.DECKCRAFT_TEST_PAREC || !process.env.CHROMIUM_FULL) throw Error('Explicit isolated Pulse sink (PULSE_SERVER, DECKCRAFT_TEST_PAREC) and CHROMIUM_FULL are required.');
const evidenceDir = process.env.DECKCRAFT_EVIDENCE_DIR;
const distDir = process.env.DECKCRAFT_DIST ? path.resolve(process.env.DECKCRAFT_DIST) : path.join(root, 'dist');
const scratch = process.env.TMPDIR || os.tmpdir();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const RATE = 48000;
const results = [], errors = [];
const record = (name, data = {}) => { results.push({ name, ...data }); console.log('✔', name, JSON.stringify(data)); };

// ---------- generated, synthetic fixtures ----------
function wav({ seconds, rate = 44100, sample }) {
  const frames = Math.round(seconds * rate), data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) { const v = Math.round(Math.max(-1, Math.min(1, sample(i / rate))) * 32767); data.writeInt16LE(v, 44 + i * 4); data.writeInt16LE(v, 46 + i * 4); }
  return data;
}
const tone = (hz, level = 0.6) => t => Math.sin(2 * Math.PI * hz * t) * level;
const clicks = (bpm, hz, offset = 0.17) => t => { const period = 60 / bpm, p = (((t - offset) % period) + period) % period; return p < 0.05 ? Math.sin(2 * Math.PI * hz * p) * Math.exp(-p / 0.012) * 0.9 : 0; };
const fixtures = {
  'tone-4s.wav': wav({ seconds: 4, sample: tone(440) }),
  'tone-step.wav': wav({ seconds: 6, sample: t => tone(t < 3 ? 440 : 880)(t) }),
  'tone-880.wav': wav({ seconds: 20, sample: tone(880) }),
  'tone-long.wav': wav({ seconds: 24, sample: tone(440) }),
  'clicks-120.wav': wav({ seconds: 40, sample: clicks(120, 1000) }),
  'clicks-126.wav': wav({ seconds: 40, sample: clicks(126, 2000) }),
  'silence.wav': wav({ seconds: 10, sample: () => 0 }),
  'corrupt.wav': Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '), Buffer.alloc(300, 7)]),
};
const dir = await mkdtemp(path.join(scratch, 'deckcraft-browser-audio-'));
const files = Object.fromEntries(await Promise.all(Object.entries(fixtures).map(async ([name, bytes]) => { const file = path.join(dir, name); await writeFile(file, bytes); return [name, file]; })));
const oversize = path.join(dir, 'oversize.wav'); await writeFile(oversize, Buffer.alloc(65 * 1024 * 1024));
let album = null;
if (process.env.FFMPEG) {
  const cover = path.join(dir, 'cover.png');
  await exec(process.env.FFMPEG, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2060c0:s=96x96', '-frames:v', '1', cover], { timeout: 30000 });
  album = {};
  for (const [name, args] of [['album.mp3', ['-c:a', 'libmp3lame', '-id3v2_version', '3']], ['album.flac', ['-c:a', 'flac']]]) {
    album[name] = path.join(dir, name);
    await exec(process.env.FFMPEG, ['-nostdin', '-v', 'error', '-i', files['tone-4s.wav'], '-i', cover, '-map', '0:a', '-map', '1:v', ...args, '-c:v', 'copy', '-disposition:v', 'attached_pic', album[name]], { timeout: 60000 }).catch(() => { delete album[name]; });
  }
}

// ---------- signal analysis over the captured sink output ----------
const chunks = [];
const recorder = spawn(process.env.DECKCRAFT_TEST_PAREC, ['--server=' + process.env.PULSE_SERVER, '--device=deckcraft_test.monitor', '--raw', '--format=s16le', '--rate=' + RATE, '--channels=2', '--latency-msec=20'], { stdio: ['ignore', 'pipe', 'ignore'] });
recorder.stdout.on('data', b => chunks.push(b));
const mark = () => Buffer.concat(chunks).length;
const capture = (from, to) => { const all = Buffer.concat(chunks), n = ((to ?? all.length) - from) / 4; const left = new Float32Array(n); for (let i = 0; i < n; i++) left[i] = all.readInt16LE(from + i * 4) / 32768; return left; };
const rms = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));
function frequency(x) { let first = null, last = null, count = 0; for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) { const at = i - 1 - x[i - 1] / (x[i] - x[i - 1]); if (first === null) first = at; last = at; count++; } return count > 1 ? RATE * (count - 1) / (last - first) : 0; }
function goertzel(x, hz) { let re = 0, im = 0; for (let i = 0; i < x.length; i++) { const a = 2 * Math.PI * hz * i / RATE; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); } return Math.hypot(re, im) / Math.max(1, x.length); }
function activeSpan(x, threshold = 0.004) {
  let first = -1, last = -1; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > threshold) { if (first < 0) first = i; last = i; }
  if (first < 0) return { seconds: 0, gapSeconds: 0, first: -1 };
  let gap = 0, run = 0; for (let i = first; i <= last; i++) { if (Math.abs(x[i]) < threshold / 2) run++; else { if (run >= 480) gap += run; run = 0; } }
  return { seconds: (last - first) / RATE - gap / RATE, gapSeconds: gap / RATE, first: first / RATE, last: last / RATE };
}
function burstPeaks(x, hz) {
  const win = Math.round(RATE * 0.005), hop = Math.round(RATE * 0.0025), env = [];
  for (let i = 0; i + win < x.length; i += hop) env.push([i / RATE, goertzel(x.subarray(i, i + win), hz)]);
  const max = Math.max(...env.map(e => e[1])), peaks = [];
  for (let i = 1; i < env.length - 1; i++) if (env[i][1] > max * 0.35 && env[i][1] >= env[i - 1][1] && env[i][1] > env[i + 1][1] && (!peaks.length || env[i][0] - peaks.at(-1) > 0.2)) peaks.push(env[i][0]);
  return peaks;
}

// ---------- static server on a non-loopback address (plain HTTP, not a secure context) ----------
const address = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;
if (!address) throw Error('A non-loopback IPv4 address is required to exercise an insecure origin.');
const requestLog = [];
const server = http.createServer(async (request, response) => {
  requestLog.push(request.method + ' ' + request.url);
  if (request.method === 'GET' && request.url === '/deck-craft.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(await readFile(path.join(distDir, 'deck-craft.html'))); }
  else { response.writeHead(404); response.end('not found'); }
});
await new Promise(resolve => server.listen(0, address, resolve));
const origin = `http://${address}:${server.address().port}`;
const pageUrl = origin + '/deck-craft.html';

// ---------- Chromium over CDP ----------
let chrome, ws, profile, sequence = 0;
const pending = new Map(), listeners = new Map();
const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 30000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
const on = (method, fn) => { listeners.set(method, [...(listeners.get(method) || []), fn]); };
const once = (method, ms = 15000) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Timed out waiting for ' + method)), ms); const fn = params => { clearTimeout(timer); listeners.set(method, listeners.get(method).filter(f => f !== fn)); resolve(params); }; on(method, fn); });
async function launch(extraScript) {
  profile = await mkdtemp(path.join(scratch, 'deckcraft-chromium-'));
  chrome = spawn(process.env.CHROMIUM_FULL, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PULSE_SINK: 'deckcraft_test' } });
  chrome.stderr.on('data', () => {});
  let port; for (let i = 0; i < 200 && !port; i++) { try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await delay(100); } }
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id) { const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); } }
    else { for (const fn of listeners.get(message.method) || []) fn(message.params); }
  });
  on('Runtime.exceptionThrown', p => errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable'); await call('DOM.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await call('Page.setInterceptFileChooserDialog', { enabled: true });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation + (extraScript || '') });
}
async function shutdown() {
  if (!chrome) return;
  try { await call('Browser.close'); } catch {}
  await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)]);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  ws?.close(); await rm(profile, { recursive: true, force: true }).catch(() => {}); chrome = null;
}
const instrumentation = `(() => {
  const urls = new Map(), media = new Set(); window.__ctxs = []; window.__net = { fetch: 0, xhr: 0, ws: 0, beacon: 0 };
  const create = URL.createObjectURL; URL.createObjectURL = function (blob) { const url = create.call(URL, blob); urls.set(url, blob.name || ''); return url; };
  const RealContext = window.AudioContext; if (RealContext) { window.AudioContext = class extends RealContext { constructor(...a) { super(...a); window.__ctxs.push(this); } }; }
  const source = RealContext && RealContext.prototype.createMediaElementSource; if (source) RealContext.prototype.createMediaElementSource = function (el) { media.add(el); return source.call(this, el); };
  const f = window.fetch; window.fetch = function () { window.__net.fetch++; return f.apply(this, arguments); };
  const x = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function () { window.__net.xhr++; return x.apply(this, arguments); };
  const W = window.WebSocket; window.WebSocket = function () { window.__net.ws++; return new W(...arguments); };
  if (navigator.sendBeacon) { const b = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (...a) => { window.__net.beacon++; return b(...a); }; }
  const element = name => [...media].reverse().find(e => e.src && urls.get(e.src) === name) || null;
  window.__probe = {
    created: () => media.size, element,
    keep(name) { (window.__kept ||= {})[name] = element(name); return !!window.__kept[name]; },
    same: name => window.__kept?.[name] === element(name),
    info(name) { const e = element(name); return e && { t: e.currentTime, paused: e.paused, ended: e.ended, rate: e.playbackRate, lock: e.preservesPitch, duration: e.duration, seeking: e.seeking }; },
  };
})();`;
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(fn, label, ms = 20000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (error) { last = error; } await delay(50); } throw Error('Timed out: ' + label + (last instanceof Error ? ' (' + last.message + ')' : '')); }
async function center(selector) {
  return evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => !e.closest('.design-preview') && !e.closest('[hidden]')); const e = all.find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}
// Import, Open file and Analyze live in the Settings dialog of the compact header; opening it is a real click on the cog.
const SETTINGS_CONTROL = /library-import|library-analyze|native-import|import-audio/;
async function click(selector) {
  if (SETTINGS_CONTROL.test(selector) && !(await evaluate("!!document.querySelector('.settings-dialog')?.open"))) {
    const cog = await until(() => center('.settings-open'), 'visible settings cog', 8000);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: cog.x, y: cog.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    await until(() => evaluate("!!document.querySelector('.settings-dialog')?.open"), 'settings open');
  }
  const point = await until(() => center(selector), 'visible ' + selector, 8000);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  await delay(220); // the app re-renders after transport changes; a person cannot click faster than this
}
const setRange = (selector, value) => evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => !el.closest('.design-preview')); if (!e) throw Error('missing ${selector.replaceAll("'", '')}'); e.value = ${JSON.stringify(String(value))}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const pressed = selector => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => !e.closest('.design-preview'))?.getAttribute('aria-pressed')`);
const rowId = title => evaluate(`[...document.querySelectorAll('tr[data-track-id]')].find(r => r.querySelector('.name-cell b')?.textContent === ${JSON.stringify(title)})?.dataset.trackId ?? null`);
const loadDeck = async (title, deck) => { const id = await until(() => rowId(title), 'library row ' + title); await evaluate(`document.querySelector('tr[data-track-id="${id}"]').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(deck.toLowerCase())}, altKey: true, bubbles: true }))`); await until(() => evaluate(`!!window.__probe.info(${JSON.stringify(title)})`), 'media element for ' + title); await delay(150); return id; };
async function chooseFiles(buttonSelector, paths) {
  const opened = once('Page.fileChooserOpened');
  await click(buttonSelector);
  const chooser = await opened;
  await call('DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
}
const feedback = () => text('.library-feedback');
const play = deck => click(`button[data-deck="${deck}"][data-field="playing"]`);
const probe = name => evaluate(`window.__probe.info(${JSON.stringify(name)})`);
const barText = () => text('.native-audio-state');
async function boot(label) {
  await call('Page.navigate', { url: pageUrl });
  await until(() => evaluate("!!document.querySelector('.native-audio-bar') && document.body.dataset.audioBackend === 'browser'"), label + ' browser backend ready');
  await until(() => evaluate("document.querySelector('.native-import') && !document.querySelector('.native-import').disabled"), label + ' audio initialized');
}

try {
  await launch();
  // ===== 1. insecure LAN origin, real feature availability =====
  await boot('startup');
  const env = await evaluate(`({ secure: isSecureContext, uuid: typeof crypto.randomUUID, worklet: typeof AudioWorklet, workletNode: typeof AudioContext !== 'undefined' && 'audioWorklet' in AudioContext.prototype, storage: typeof navigator.storage, nativeBridge: typeof deckCraftNative, backend: document.body.dataset.audioBackend, engine: document.querySelector('.engine-label')?.textContent, ctx: window.__ctxs.map(c => c.state) })`);
  assert.equal(env.secure, false); assert.equal(env.uuid, 'undefined'); assert.equal(env.nativeBridge, 'undefined'); assert.equal(env.backend, 'browser'); assert.equal(env.engine, 'BROWSER AUDIO');
  assert.equal(env.ctx[0], 'suspended', 'context starts gated by the browser autoplay policy');
  record('insecure-origin features', { ...env, origin: 'http://<non-loopback>' });
  const status = await text('.settings-audio-state'); assert.match(status, /Browser audio/); assert.doesNotMatch(status, /Linux|ALSA|native/i);
  assert.match(await text('.info-dialog'), /not the Rust engine/); assert.match(await text('.status-detail, .statusbar'), /Browser audio/);
  record('backend labelling', { status });

  // ===== 2. multi-file import through an injected OS chooser; analysis, errors, limits =====
  await chooseFiles('[data-action="library-import"][data-kind="files"]', [files['tone-4s.wav'], files['tone-step.wav'], files['tone-880.wav'], files['tone-long.wav'], files['clicks-120.wav'], files['clicks-126.wav'], files['silence.wav'], files['corrupt.wav'], oversize]);
  await until(async () => /added/.test(await feedback()) && /Importing|\d+ added/.test(await feedback()) && !/Importing/.test(await feedback()), 'import finished', 120000);
  const summary = await feedback();
  assert.match(summary, /7 added/); assert.match(summary, /2 failed/); assert.match(summary, /corrupt\.wav: unsupported or corrupt audio/); assert.match(summary, /oversize\.wav: file too large/);
  const rows = await evaluate(`[...document.querySelectorAll('tr[data-track-id]')].filter(r => r.dataset.trackId.startsWith('local-')).map(r => [r.querySelector('.name-cell b').textContent, r.querySelector('.bpm-cell').textContent, r.querySelector('.name-cell span').textContent])`);
  const bpm = name => rows.find(r => r[0] === name)?.[1];
  assert.ok(Math.abs(Number(bpm('clicks-120.wav')) - 120) < 0.3, 'bpm 120 got ' + bpm('clicks-120.wav'));
  assert.ok(Math.abs(Number(bpm('clicks-126.wav')) - 126) < 0.6, 'bpm 126 got ' + bpm('clicks-126.wav'));
  for (const quiet of ['silence.wav', 'tone-long.wav', 'tone-4s.wav']) assert.equal(bpm(quiet), '—', quiet + ' must not invent a BPM');
  record('multi-file import + analysis', { summary, rows: rows.map(r => [r[0], r[1]]) });
  const stored = await evaluate(`new Promise(r => { const q = indexedDB.open('deck-craft-browser-library'); q.onsuccess = () => { const s = q.result.transaction('blobs').objectStore('blobs').count(); s.onsuccess = () => r(s.result); }; })`);
  assert.equal(stored, 7); record('blobs persisted in browser IndexedDB', { stored });

  // cancel is visible
  const cancelOpened = once('Page.fileChooserOpened'); await click('[data-action="library-import"][data-kind="files"]'); await cancelOpened;
  await evaluate("document.querySelector('input[data-deckcraft-picker]').dispatchEvent(new Event('cancel'))");
  await until(async () => /cancel/i.test(await feedback()), 'cancel message'); record('chooser cancel is visible', { message: await feedback() });

  // single-file "Open file -> Deck" and folder selection use the same chooser path
  const folder = path.join(dir, 'chosen-folder'); await mkdir(folder);
  await writeFile(path.join(folder, 'folder-tone.wav'), wav({ seconds: 3, sample: tone(330) })); await writeFile(path.join(folder, 'notes.txt'), 'not audio');
  await chooseFiles('.native-import', [files['tone-4s.wav']]);
  await until(() => evaluate("!!window.__probe.info('tone-4s.wav')"), 'single-file pick loads the deck');
  assert.equal(await pressed('button[data-deck="A"][data-field="playing"]'), 'false', 'picking a file loads paused');
  await chooseFiles('[data-action="library-import"][data-kind="folder"]', [folder]);
  await until(async () => /^1 added · 0 already in library · 0 failed · 1 skipped/.test(await feedback()), 'folder import summary');
  record('single-file pick and folder import', { folder: await feedback() });

  // ===== 3. real playback: 440 Hz source, unlocked/locked tempo =====
  await loadDeck('tone-4s.wav', 'A');
  const idle = mark(); await delay(600); assert.ok(rms(capture(idle)) < 0.001, 'loading must not make sound');
  const tempoResults = [];
  for (const [lockOn, pitch] of [[false, 8], [false, -8], [true, 8], [true, -8]]) {
    await loadDeck('tone-4s.wav', 'A');
    await setRange('[data-action="deck-number"][data-deck="A"][data-field="pitch"]', pitch);
    const wantLock = lockOn; if ((await pressed('button[data-field="pitchLock"][data-deck="A"]')) !== String(wantLock)) await click('button[data-field="pitchLock"][data-deck="A"]');
    const rate = 1 + pitch / 100;
    await until(async () => { const i = await probe('tone-4s.wav'); return i && Math.abs(i.rate - rate) < 1e-6 && i.lock === wantLock; }, `rate ${rate} lock ${wantLock} applied to media element`);
    const begin = mark(), wall = performance.now(); await play('A');
    await until(async () => { const i = await probe('tone-4s.wav'); return !i.paused && i.t > 0.2; }, 'playback started', 8000);
    await until(async () => { const i = await probe('tone-4s.wav'); return i.ended || i.paused; }, 'natural end', 12000);
    const elapsed = (performance.now() - wall) / 1000; await delay(500);
    const heard = capture(begin), span = activeSpan(heard), mid = heard.subarray(Math.round((span.first + 1) * RATE), Math.round((span.first + 2) * RATE));
    const hz = frequency(mid), expectHz = lockOn ? 440 : 440 * rate, signal = span.seconds;
    assert.ok(Math.abs(hz - expectHz) < 3.5, JSON.stringify({ hz, expectHz, lockOn, pitch }));
    assert.ok(Math.abs(signal - 4 / rate) < 0.12, JSON.stringify({ signal, expected: 4 / rate, lockOn, pitch }));
    tempoResults.push({ lock: lockOn, rate, hz: Math.round(hz * 10) / 10, signalSeconds: Math.round(signal * 1000) / 1000, gapSeconds: span.gapSeconds, wallSeconds: Math.round(elapsed * 100) / 100 });
    assert.equal(await pressed('button[data-deck="A"][data-field="playing"]'), 'false', 'UI reflects natural end');
  }
  record('tempo ±8% with/without pitch lock changes the audible signal', { tempoResults });
  // restart after natural end plays from the beginning again
  await setRange('[data-action="deck-number"][data-deck="A"][data-field="pitch"]', 0);
  { const begin = mark(); await play('A'); await delay(1200); const x = capture(begin); assert.ok(Math.abs(frequency(x.subarray(Math.round(0.6 * RATE))) - 440) < 3.5); const i = await probe('tone-4s.wav'); assert.ok(i.t < 2.2, 'restarts from the beginning'); record('play after natural end restarts from zero', { position: i.t }); }
  await click('button[data-deck="A"][data-field="playing"]'); // pause

  // ===== 4. pause, seek and source clock =====
  await loadDeck('tone-step.wav', 'A');
  await setRange('[data-action="deck-number"][data-deck="A"][data-field="pitch"]', 0);
  let begin = mark(); await play('A'); await delay(1500);
  let before = await probe('tone-step.wav'); await play('A'); await delay(400);
  const paused = await probe('tone-step.wav'); const hold = mark(); await delay(700);
  assert.ok(paused.paused && rms(capture(hold)) < 0.002, 'pause silences output'); assert.ok(Math.abs((await probe('tone-step.wav')).t - paused.t) < 0.01, 'paused clock holds still');
  assert.ok(Math.abs(frequency(capture(begin).subarray(Math.round(0.5 * RATE), Math.round(1.3 * RATE))) - 440) < 3.5);
  await setRange('[data-action="deck-number"][data-deck="A"][data-field="position"]', 4.0);
  await until(async () => Math.abs((await probe('tone-step.wav')).t - 4.0) < 0.15, 'paused seek lands on 4 s');
  assert.equal(await pressed('button[data-deck="A"][data-field="playing"]'), 'false', 'seek never starts playback');
  begin = mark(); await play('A'); await delay(1000);
  const seeked = frequency(capture(begin).subarray(Math.round(0.4 * RATE))); assert.ok(Math.abs(seeked - 880) < 5, 'seeked region is the 880 Hz half: ' + seeked);
  await setRange('[data-action="deck-number"][data-deck="A"][data-field="position"]', 0.5); await delay(500);
  begin = mark(); await delay(700); assert.ok(Math.abs(frequency(capture(begin)) - 440) < 3.5, 'seek while playing jumps back to the 440 Hz half');
  record('pause/seek/source clock', { pausedAt: paused.t, seekedHz: Math.round(seeked), afterPlayingSeekHz: 440 });
  await play('A');

  // ===== 5. decks are independent; level and crossfader change the output =====
  await loadDeck('tone-long.wav', 'A'); await loadDeck('tone-880.wav', 'B');
  await setRange('[data-action="crossfader"]', 50);
  await setRange('[data-action="deck-number"][data-deck="A"][data-field="pitch"]', 0); await setRange('[data-action="deck-number"][data-deck="B"][data-field="pitch"]', 0);
  await play('A'); await delay(400); const a0 = await probe('tone-long.wav'); const t0 = performance.now();
  await play('B'); await delay(1500);
  const mixed = capture(Math.max(0, mark() - Math.round(RATE * 4 * 1.0)));
  const e440 = goertzel(mixed, 440), e880 = goertzel(mixed, 880); assert.ok(e440 > 0.01 && e880 > 0.01, 'both decks are audible at the centre: ' + JSON.stringify({ e440, e880 }));
  await play('B'); await delay(300); const a1 = await probe('tone-long.wav'); const wall = (performance.now() - t0) / 1000;
  assert.ok(Math.abs((a1.t - a0.t) - wall) < 0.25, 'deck A kept its own clock while B started and stopped: ' + JSON.stringify({ dt: a1.t - a0.t, wall }));
  await play('B'); await delay(300);
  for (const [fader, expect] of [[0, 'A'], [100, 'B']]) {
    await setRange('[data-action="crossfader"]', fader); await delay(1300);
    const x = capture(mark() - Math.round(RATE * 4 * 0.5)), a = goertzel(x, 440), b = goertzel(x, 880);
    if (expect === 'A') assert.ok(a > 20 * b, 'crossfader A-side: ' + JSON.stringify({ a, b })); else assert.ok(b > 20 * a, 'crossfader B-side: ' + JSON.stringify({ a, b }));
  }
  await setRange('[data-action="crossfader"]', 50);
  await setRange('[data-action="deck-number"][data-deck="B"][data-field="level"]', 0); await delay(1300);
  { const x = capture(mark() - Math.round(RATE * 4 * 0.5)); assert.ok(goertzel(x, 880) < goertzel(x, 440) / 20, 'channel level 0 silences that deck'); }
  record('independent decks, crossfader and level', { e440, e880 });
  await setRange('[data-action="deck-number"][data-deck="B"][data-field="level"]', 78); await play('B'); await delay(300);

  // ===== 6. layouts are views of the same playing audio source =====
  const keep = await evaluate(`window.__probe.keep('tone-long.wav')`); assert.ok(keep);
  const createdBefore = await evaluate('window.__probe.created()'); let lastT = (await probe('tone-long.wav')).t; const layoutBegin = mark(); let transitions = 0;
  const presentation = [
    ['library workspace', "document.querySelector('[data-action=\"mode\"][data-value=\"prepare\"]').click()"],
    ['perform workspace', "document.querySelector('[data-action=\"mode\"][data-value=\"perform\"]').click()"],
    ['deck pair C/D', "document.querySelector('[data-action=\"pair\"][data-value=\"cd\"]').click()"],
    ['deck pair A/B', "document.querySelector('[data-action=\"pair\"][data-value=\"ab\"]').click()"],
    ['theme change', "(() => { const s = document.querySelector('.theme-picker'); s.value = s.value === 'ember' ? 'graphite' : 'ember'; s.dispatchEvent(new Event('change', { bubbles: true })); })()"],
  ];
  for (const [layout, action] of presentation) {
    await evaluate(action);
    await delay(500); const i = await probe('tone-long.wav'); assert.equal(await evaluate("window.__probe.same('tone-long.wav')"), true, 'same media element after ' + layout); assert.ok(i.t > lastT && !i.paused, 'source clock continues across ' + layout); lastT = i.t; transitions++;
  }
  assert.equal(await evaluate('window.__probe.created()'), createdBefore, 'presentation changes create no new audio sources');
  const layoutAudio = capture(layoutBegin); assert.ok(Math.abs(frequency(layoutAudio.subarray(Math.round(0.3 * RATE))) - 440) < 3.5);
  const layoutSpan = activeSpan(layoutAudio); assert.ok(layoutSpan.gapSeconds < 0.05, 'no audible gap during presentation changes: ' + layoutSpan.gapSeconds);
  record('presentation changes (workspace, pair, theme) keep one playing audio source', { transitions, gapSeconds: layoutSpan.gapSeconds });
  await play('A');

  // ===== 6b. the backend status line and library controls fit every layout and width =====
  const fits = [];
  // Widths covered by the existing responsive suite; a 1024 px header overflow predates the audio backend.
  for (const width of [1920, 1440, 1280, 390, 360]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 800 : 1000, deviceScaleFactor: 1, mobile: false });
    for (const layout of ['ab', 'cd']) {
      await evaluate(`document.querySelector('[data-action="pair"][data-value="${layout}"]').click()`); await delay(120);
      const fit = await evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth, bar: (() => { const b = document.querySelector('.native-audio-bar').getBoundingClientRect(); return b.right <= innerWidth + 1 && b.left >= -1; })(), wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && e.getClientRects().length).slice(0, 6).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)) })`);
      assert.deepEqual({ overflow: fit.overflow, bar: fit.bar }, { overflow: false, bar: true }, `${layout} at ${width}: ${JSON.stringify(fit.wide)}`); fits.push(`${layout}@${width}`);
    }
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-action="pair"][data-value="ab"]').click()`); await delay(200);
  assert.equal((await probe('tone-long.wav')).paused, true);
  record('backend UI fits both deck pairs at five widths', { cases: fits.length });

  // ===== 7. master + explicit Sync with measured beat phase =====
  await loadDeck('clicks-120.wav', 'A'); await loadDeck('clicks-126.wav', 'B');
  await setRange('[data-action="deck-number"][data-deck="A"][data-field="pitch"]', 0); await setRange('[data-action="deck-number"][data-deck="B"][data-field="pitch"]', 0);
  await setRange('[data-action="crossfader"]', 50);
  if ((await pressed('button[data-field="pitchLock"][data-deck="B"]')) !== 'true') await click('button[data-field="pitchLock"][data-deck="B"]');
  await setRange('[data-action="deck-number"][data-deck="A"][data-field="position"]', 5.21); await setRange('[data-action="deck-number"][data-deck="B"][data-field="position"]', 8.4);
  await delay(600); await click('button[data-action="master"][data-deck="A"]'); assert.equal(await pressed('button[data-action="master"][data-deck="A"]'), 'true');
  await play('A'); await play('B'); await delay(2500);
  const phaseOf = (e, bpm) => ((e.t - 0.17) * bpm / 60) % 1;
  // Both media clocks are read in one synchronous page evaluation so a busy main thread cannot skew the comparison.
  const gap = async () => { const [a, b] = await evaluate("[window.__probe.info('clicks-120.wav'), window.__probe.info('clicks-126.wav')]"); let d = phaseOf(a, 120) - phaseOf(b, 126); d -= Math.round(d); return { d, a, b }; };
  const unsynced = await gap();
  const syncBegin = mark(); await click('button[data-field="sync"][data-deck="B"]');
  await until(async () => (await pressed('button[data-field="sync"][data-deck="B"]')) === 'true', 'sync engaged');
  const bInfo = await probe('clicks-126.wav'); assert.ok(Math.abs(bInfo.rate - 120 / 126) < 0.003, 'follower rate matches master BPM: ' + bInfo.rate);
  await delay(5000); const synced = await gap(); assert.ok(Math.abs(synced.d) * 0.5 < 0.03, 'media beat phase aligned: ' + synced.d);
  const heard = capture(syncBegin + Math.round(RATE * 4 * 1.5)), pa = burstPeaks(heard, 1000), pb = burstPeaks(heard, 2000);
  const offsets = pa.map(t => { const n = pb.reduce((best, u) => Math.abs(u - t) < Math.abs(best - t) ? u : best, pb[0]); return n - t; }).filter(v => Math.abs(v) < 0.25);
  const spread = Math.max(...offsets) - Math.min(...offsets), mean = offsets.reduce((s, v) => s + v, 0) / offsets.length;
  assert.ok(offsets.length >= 5 && Math.abs(mean) < 0.03 && spread < 0.04, 'audible click timing: ' + JSON.stringify({ mean, spread, n: offsets.length }));
  record('explicit sync: media phase and audible click timing', { unsyncedPhaseBeats: unsynced.d, syncedPhaseBeats: synced.d, followerRate: bInfo.rate, audibleMeanOffsetMs: Math.round(mean * 1000), audibleSpreadMs: Math.round(spread * 1000), clicksCompared: offsets.length });
  // master tempo change carries the follower
  await setRange('[data-action="deck-number"][data-deck="A"][data-field="pitch"]', 4); await until(async () => { const b = await probe('clicks-126.wav'); return Math.abs(b.rate - (120 * 1.04 / 126)) < 0.003; }, 'follower follows master tempo');
  assert.equal(await pressed('button[data-field="sync"][data-deck="B"]'), 'true', 'tempo change on master keeps follower synced');
  // independent transport clears sync, as in the native engine
  await setRange('[data-action="deck-number"][data-deck="B"][data-field="position"]', 12);
  await until(async () => (await pressed('button[data-field="sync"][data-deck="B"]')) === 'false', 'independent seek clears sync');
  await click('button[data-field="sync"][data-deck="B"]'); await until(async () => (await pressed('button[data-field="sync"][data-deck="B"]')) === 'true', 're-sync');
  await play('A'); await until(async () => (await pressed('button[data-field="sync"][data-deck="B"]')) === 'false', 'master pause clears follower sync');
  assert.equal((await probe('clicks-126.wav')).paused, false, 'follower keeps playing when the master pauses');
  await play('B'); await setRange('[data-action="deck-number"][data-deck="A"][data-field="pitch"]', 0);
  record('sync follows master tempo and clears on independent transport', {});

  // ===== 8. fail closed when the context is suspended; never auto-replay =====
  await loadDeck('tone-long.wav', 'A'); await play('A'); await delay(800); assert.equal((await probe('tone-long.wav')).paused, false);
  await evaluate('window.__ctxs[0].suspend()'); await until(async () => (await probe('tone-long.wav')).paused, 'suspend pauses the deck');
  await evaluate('window.__ctxs[0].resume()'); await delay(1200); assert.equal((await probe('tone-long.wav')).paused, true, 'no automatic replay after the context returns');
  assert.equal(await pressed('button[data-deck="A"][data-field="playing"]'), 'false');
  assert.match(await barText(), /suspended/i, 'the suspended output is announced in the status band');
  record('suspended context stops playback and does not auto-replay', { status: await barText() });
  begin = mark(); await play('A'); await delay(1200); assert.ok(Math.abs(frequency(capture(begin).subarray(Math.round(0.5 * RATE))) - 440) < 3.5); await play('A');

  // ===== 9. safety: forgetting a loaded track is refused; privacy =====
  // The compact library has no Remove control; forgetting a loaded track is refused by the bridge (covered by tests/browser-audio.test.js).
  // Selecting the loaded track's row is a plain selection: it changes no deck and starts nothing.
  const loadedId = await rowId('tone-long.wav'); await evaluate(`document.querySelector('tr[data-track-id="${loadedId}"]').click()`);
  assert.equal(await evaluate(`document.querySelector('tr[data-track-id="${loadedId}"]').getAttribute('aria-selected')`), 'true');
  assert.equal(await evaluate("document.querySelectorAll('tr[aria-selected=true]').length"), 1);
  record('row selection loads nothing', { selected: 1 });
  const net = await evaluate('window.__net'); assert.deepEqual(net, { fetch: 0, xhr: 0, ws: 0, beacon: 0 });
  const resources = await evaluate("performance.getEntriesByType('resource').map(e => e.name)");
  assert.deepEqual(requestLog.sort(), ['GET /deck-craft.html']); assert.deepEqual(resources, []);
  record('no upload or network side channel', { net, requests: requestLog });

  // ===== 10. reload: persisted library, paused restore, no unsolicited audio =====
  await loadDeck('tone-long.wav', 'A'); await setRange('[data-action="deck-number"][data-deck="A"][data-field="position"]', 6.5); await delay(500);
  await call('Page.reload'); await until(async () => evaluate("document.body.dataset.audioBackend === 'browser' && !!document.querySelector('.native-import') && !document.querySelector('.native-import').disabled"), 'reload ready');
  const reloadMark = mark(); await delay(2000);
  const restoredRows = await evaluate(`[...document.querySelectorAll('tr[data-track-id]')].filter(r => r.dataset.trackId.startsWith('local-')).length`); assert.equal(restoredRows, 8);
  const restored = await probe('tone-long.wav'); assert.ok(restored && restored.paused && Math.abs(restored.t - 6.5) < 0.3, JSON.stringify(restored));
  assert.ok(rms(capture(reloadMark)) < 0.001, 'nothing plays after reload');
  begin = mark(); await play('A'); await delay(1300); assert.ok(rms(capture(begin)) > 0.01 && Math.abs(frequency(capture(begin).subarray(Math.round(0.5 * RATE))) - 440) < 3.5, 'Play after reload works on the first gesture');
  assert.ok((await probe('tone-long.wav')).t > 6.8); await play('A');
  record('reload restores library from IndexedDB, paused, silent', { restoredRows, position: restored.t });
  await evaluate("document.body.dataset.audioBackend"); // keep page alive for the next phase
  const mixerSecond = await text('.mixer-dialog>p'); assert.match(mixerSecond, /channel levels and the crossfader only/);

  // ===== 11. embedded artwork from real tag formats =====
  if (album && Object.keys(album).length) {
    await chooseFiles('[data-action="library-import"][data-kind="files"]', Object.values(album));
    await until(() => evaluate(`[...document.querySelectorAll('tr[data-track-id] .name-cell b')].filter(b => /^album\\./.test(b.textContent)).length >= ${Object.keys(album).length}`), 'album import', 60000);
    const art = await evaluate(`[...document.querySelectorAll('tr[data-track-id] .library-artwork img, tr[data-track-id] .library-artwork [style*="data:image/png"]')].length`);
    const arts = await evaluate(`[...document.querySelectorAll('tr[data-track-id]')].filter(r => /album\\./.test(r.querySelector('.name-cell b').textContent)).map(r => [r.querySelector('.name-cell b').textContent, r.querySelector('.library-artwork').innerHTML.includes('data:image/png;base64,iVBOR')])`);
    assert.ok(arts.length && arts.every(a => a[1]), 'embedded art present for ' + JSON.stringify(arts)); record('embedded artwork extracted in the browser', { arts, art });
  } else record('embedded artwork extracted in the browser', { skipped: 'no ffmpeg available' });

  await shutdown();

  // ===== 12. quota pressure: visible warning, session-only sources =====
  await launch(); await call('Page.navigate', { url: pageUrl }); await until(() => evaluate("document.body.dataset.audioBackend === 'browser'"), 'quota page');
  await call('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 * 1024 }).catch(error => record('quota override unavailable', { error: error.message }));
  await boot('quota');
  await chooseFiles('[data-action="library-import"][data-kind="files"]', [files['tone-long.wav']]);
  await until(async () => /^1 added/.test(await feedback()), 'quota import');
  const quotaFeedback = await feedback(), quotaWarning = await text('.persistence-warning'); 
  assert.match(quotaFeedback + quotaWarning, /this session only/i); record('storage exhaustion is visible and falls back to session-only', { feedback: quotaFeedback, warning: quotaWarning });
  await loadDeck('tone-long.wav', 'A'); begin = mark(); await play('A'); await delay(1300); assert.ok(rms(capture(begin)) > 0.01, 'a session-only source still plays'); await play('A');
  await shutdown();

  // ===== 13. unsupported browser APIs degrade honestly =====
  await launch('delete window.AudioContext; delete window.webkitAudioContext;'); await call('Page.navigate', { url: pageUrl });
  await until(() => evaluate("!!document.querySelector('.deckbar')"), 'degraded page');
  const degraded = await evaluate(`({ backend: document.body.dataset.audioBackend ?? null, footer: document.querySelector('.status-detail')?.textContent ?? '', bar: !!document.querySelector('.native-audio-bar') })`);
  assert.equal(degraded.backend, null); assert.match(degraded.footer, /browser audio unavailable here \(missing: Web Audio/); assert.equal(degraded.bar, false);
  record('missing Web Audio keeps the UI-only fixtures and says why', degraded);
  await shutdown();

  assert.deepEqual(errors, [], 'no uncaught page errors');
  console.log('ALL BROWSER AUDIO CHECKS PASSED');
} catch (error) {
  console.error('FAILED', error.stack || error); process.exitCode = 1;
} finally {
  await shutdown().catch(() => {}); recorder.kill(); server.close();
  if (evidenceDir) { await mkdir(evidenceDir, { recursive: true }); await writeFile(path.join(evidenceDir, 'browser-audio-results.json'), JSON.stringify({ results, errors }, null, 2)); await writeFile(path.join(evidenceDir, 'browser-audio-capture.s16le'), Buffer.concat(chunks)); }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
