// Real Chromium regression for zoomed waveform quality. The native bridge is MOCKED and the
// waveform data is generated; this is renderer evidence only, not audio or native acceptance.
// Run: CHROMIUM=... TMPDIR=... node --test tests/wave-quality.test.js
// WAVE_APP_ROOT serves another checkout of the application (for before/after comparisons);
// DECKCRAFT_EVIDENCE_DIR + WAVE_SHOT_PREFIX save screenshots outside source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, reduceSession, serializeSession } from '../src/session.js';
import { registerLocalTrack } from '../src/catalog.js';
import { FIXTURE_DURATION, FIXTURE_IDS, GAP, SPIKE, detailFixture, legacyPeaks, encodeDetail } from './wave-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const appRoot = process.env.WAVE_APP_ROOT ? path.resolve(process.env.WAVE_APP_ROOT) : root;
const evidence = process.env.DECKCRAFT_EVIDENCE_DIR, prefix = process.env.WAVE_SHOT_PREFIX || 'after';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
const details = { dynamic: detailFixture('dynamic'), brickwall: detailFixture('brickwall') };
const tracks = Object.entries(FIXTURE_IDS).map(([kind, id]) => ({ id, title: kind === 'dynamic' ? 'Generated dynamic fixture.wav' : 'Generated compressed fixture.wav', duration: FIXTURE_DURATION, peaks: legacyPeaks(details[kind]) }));
function savedSession() {
  for (const track of tracks) registerLocalTrack(track);
  let state = createSession();
  state = reduceSession(state, { type: 'load', deck: 'A', trackId: FIXTURE_IDS.dynamic });
  state = reduceSession(state, { type: 'load', deck: 'B', trackId: FIXTURE_IDS.brickwall });
  for (const deck of ['A', 'B']) state = reduceSession(state, { type: 'deck', deck, field: 'position', value: 101.5 });
  return serializeSession(state);
}
function fixture() {
  return `(() => {
    localStorage.clear();
    localStorage.setItem('deck-craft.ui.v1',${JSON.stringify(savedSession())});
    const tracks = ${JSON.stringify(tracks)};
    const snapshot = { ready:true, seq:1, sourceId:'source-fixture', engineId:'engine-aa-bb', decks:['A','B','C','D'].map(id=>({id,trackId:null,duration:0,position:0,playing:false,level:80,loading:false})) };
    snapshot.decks[0]={...snapshot.decks[0],trackId:${JSON.stringify(FIXTURE_IDS.dynamic)},duration:${FIXTURE_DURATION},position:101.5,loadGeneration:1,waveGeneration:1};
    snapshot.decks[1]={...snapshot.decks[1],trackId:${JSON.stringify(FIXTURE_IDS.brickwall)},duration:${FIXTURE_DURATION},position:101.5,loadGeneration:1,waveGeneration:1};
    let listener;
    const mock = window.waveFixture = { calls:[], requests:[], emit(event) { listener(event); } };
    window.deckCraftNative = {
      onEvent(fn) { listener = fn; },
      async command(request) {
        mock.calls.push(request.type); mock.requests.push(request);
        const track = tracks.find(t => t.id === request.trackId);
        if (request.type === 'library') return { ok:true, tracks, collections:[], warning:'' };
        if (request.type === 'status') return { ok:true, snapshot };
        if (request.type === 'load' && track) return { ok:true, track, snapshot:{...snapshot,seq:++snapshot.seq} };
        if (request.type === 'seek') { const deck = snapshot.decks.find(d => d.id === request.deck); deck.position = request.position; return { ok:true, snapshot:{...snapshot,seq:++snapshot.seq} }; }
        return { ok:true, snapshot:{...snapshot,seq:++snapshot.seq} };
      }
    };
  })();`;
}
// Runs inside the page: decode a screenshot and report per-column ink (saturated deck-tinted pixels,
// never the center line or the white ruler/playhead).
const analyzer = `async (b64, skip) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height), mid = height / 2, reach = mid * 43 / 45;
  const ink = new Uint8Array(width), extent = new Float32Array(width), lum = new Float32Array(width);
  const row = Math.round(mid - reach * 0.42);
  for (let x = 0; x < width; x++) {
    if (skip.some(([a, b]) => x >= a && x <= b)) { ink[x] = 2; continue; }
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4, r = data[i], gr = data[i + 1], b = data[i + 2];
      if (Math.abs(y + 0.5 - mid) >= 1.5 && Math.max(r, gr, b) - Math.min(r, gr, b) >= 40) { ink[x] = 1; extent[x] = Math.max(extent[x], Math.abs(y + 0.5 - mid)); }
      if (y === row) lum[x] = 0.3 * r + 0.59 * gr + 0.11 * b;
    }
  }
  return { width, height, reach, ink: [...ink], extent: [...extent], lum: [...lum] };
}`;

test('MOCKED native bridge: zoomed waveforms stay continuous, use real detail and align with the displayed interval', async t => {
  let chrome, ws, server, profile;
  const errors = [], pending = new Map();
  let sequence = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 45000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    server = createServer(async (req, res) => {
      try {
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname), filename = path.resolve(appRoot, '.' + name);
        if (!filename.startsWith(appRoot)) { res.writeHead(403).end(); return; }
        let body = await readFile(filename);
        if (name === '/index.html') body = body.toString().replace('<script type="module"', '<script>' + fixture() + '</script><script type="module"');
        res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(body);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const scratch = process.env.TMPDIR || path.join(root, 'node_modules/.cache');
    await mkdir(scratch, { recursive: true });
    profile = await mkdtemp(path.join(scratch, 'deckcraft-wave-'));
    chrome = spawn(process.env.CHROMIUM || '/usr/bin/chromium', ['--headless=new', '--no-proxy-server', '--disable-background-networking', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', () => {});
    let port;
    await until(async () => { try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!port; } catch { return false; } }, 'Chromium');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find(x => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.addEventListener('message', event => {
      const m = JSON.parse(String(event.data));
      if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    await call('Runtime.enable'); await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
    await until(() => evaluate("Boolean(document.querySelector('section.deck[data-deck=A] .wavebox.scroll'))"), 'deck A waveform');
    await delay(400);

    const scrollBox = deck => `section.deck[data-deck="${deck}"] .wavebox.scroll`;
    const boxState = selector => evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); const m = b.querySelector('.position-marker').getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, cx: r.x + r.width / 2, cy: r.y + r.height / 2, width: r.width, height: r.height, marker: m.x - r.x + m.width / 2, zoom: Number(b.dataset.waveZoom), top: !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.wavebox') }; })()`);
    const zoomTo = async (selector, target) => {
      for (let i = 0; i < 16; i++) {
        const s = await boxState(selector);
        // Wheel steps are multiplicative, so intermediate targets are reached from above or below.
        if (target === 1 || target === 32 ? Math.abs(s.zoom - target) < 0.01 : Math.abs(Math.log(s.zoom / target)) < 0.14) return s;
        assert.ok(s.top, 'wheel target is on screen');
        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.cx, y: s.cy, deltaX: 0, deltaY: s.zoom < target ? -120 : 120 });
        await delay(60);
      }
      throw Error('zoom did not settle');
    };
    const measure = async (selector, label, extraSkip = []) => {
      await delay(120);
      const s = await boxState(selector);
      const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: s.x, y: s.y, width: s.width, height: s.height, scale: 1 } });
      if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, `${prefix}-${label}.png`), Buffer.from(shot.data, 'base64')); }
      const measured = await evaluate(`(${analyzer})(${JSON.stringify(shot.data)}, ${JSON.stringify([[Math.round(s.marker) - 6, Math.round(s.marker) + 6], ...extraSkip])})`);
      return { ...measured, state: s };
    };
    const coverage = (m, from = 0, to = m.width) => { let n = 0, d = 0; for (let x = Math.floor(from); x < Math.min(m.width, Math.ceil(to)); x++) { if (m.ink[x] === 2) continue; d++; n += m.ink[x]; } return d ? n / d : 1; };
    const xAt = (m, seconds, position = 101.5, zoom = 32) => m.width * (0.5 + (seconds - position) * zoom / FIXTURE_DURATION);

    const stored = () => evaluate("JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]))");
    const storedBefore = await stored();
    const callsBefore = await evaluate('waveFixture.calls.length');

    // 1. Existing library data (512 persisted peaks only), maximum zoom.
    await zoomTo(scrollBox('A'), 32);
    assert.equal((await boxState(scrollBox('B'))).zoom, 5, 'wheel on deck A leaves deck B at its own zoom');
    await zoomTo(scrollBox('B'), 32);
    const legacyA = await measure(scrollBox('A'), 'legacy-peaks-A-zoom32'), legacyB = await measure(scrollBox('B'), 'legacy-peaks-B-zoom32');
    // 2. Real native detail arrives for the loaded tracks.
    await evaluate(`waveFixture.emit({ type:'waveform-detail', sourceId:'source-fixture',engineId:'engine-aa-bb',loadGeneration:1,deck:'A', trackId:${JSON.stringify(FIXTURE_IDS.dynamic)}, detail:${JSON.stringify(encodeDetail(details.dynamic))} }); waveFixture.emit({ type:'waveform-detail', sourceId:'source-fixture',engineId:'engine-aa-bb',loadGeneration:1,deck:'B', trackId:${JSON.stringify(FIXTURE_IDS.brickwall)}, detail:${JSON.stringify(encodeDetail(details.brickwall))} });`);
    await delay(300);
    const detailA = await measure(scrollBox('A'), 'detail-A-zoom32'), detailB = await measure(scrollBox('B'), 'detail-B-zoom32');
    for (const z of [5, 1]) { await zoomTo(scrollBox('A'), z); await measure(scrollBox('A'), `detail-A-zoom${z}`); await zoomTo(scrollBox('B'), z); await measure(scrollBox('B'), `detail-B-zoom${z}`); }
    await zoomTo(scrollBox('A'), 32);

    // Continuity: no stretched-line gaps between neighbouring columns of a loud signal.
    assert.ok(coverage(legacyA) >= 0.97, `legacy peaks at 32x keep continuous columns, got ${coverage(legacyA).toFixed(3)}`);
    assert.ok(coverage(legacyB) >= 0.97, `compressed legacy peaks at 32x, got ${coverage(legacyB).toFixed(3)}`);
    // Real detail: digital silence stays empty, one transient bin is visible at its time, loud audio fills the rest.
    const gapFrom = xAt(detailA, GAP.start) + 3, gapTo = xAt(detailA, GAP.end) - 3;
    assert.equal(coverage(detailA, gapFrom, gapTo), 0, 'silent interval draws no waveform');
    const left = coverage(detailA, 0, xAt(detailA, GAP.start) - 3), right = coverage(detailA, xAt(detailA, GAP.end) + 3, detailA.width);
    assert.ok(left >= 0.97 && right >= 0.97, `neighbouring audio is continuous (${left.toFixed(3)} / ${right.toFixed(3)}, gap x ${xAt(detailA, GAP.start).toFixed(1)}-${xAt(detailA, GAP.end).toFixed(1)}, ink ${detailA.ink.join('')})`);
    const sx = xAt(detailA, SPIKE), around = detailA.extent.slice(Math.floor(sx) - 3, Math.ceil(sx) + 4);
    assert.ok(Math.max(...around) >= detailA.reach * 0.85, 'transient reaches its full height at the right time');
    const near = []; for (let x = Math.floor(sx) - 40; x <= Math.ceil(sx) + 40; x++) if (Math.abs(x - sx) > 4 && detailA.ink[x] === 1) near.push(detailA.extent[x]);
    near.sort((p, q) => p - q);
    assert.ok(near.length && near[Math.floor(near.length / 2)] < detailA.reach * 0.6, 'typical neighbouring audio stays lower than the transient');
    // Compressed master: the peak envelope is a full-height block but real RMS data keeps visible structure inside it.
    assert.ok(coverage(detailB) >= 0.97);
    const lums = detailB.lum.filter((_, i) => detailB.ink[i] === 1);
    assert.ok(Math.max(...lums) - Math.min(...lums) > 35, 'RMS core varies inside a brickwalled peak envelope');
    const legacyLums = legacyB.lum.filter((_, i) => legacyB.ink[i] === 1);
    assert.ok(Math.max(...legacyLums) - Math.min(...legacyLums) < Math.max(...lums) - Math.min(...lums), 'detail adds structure the 512 peaks cannot');

    // Zoom and detail delivery are presentation only.
    assert.equal(await stored(), storedBefore, 'no session or workspace storage written by zoom or detail');
    assert.equal(await evaluate('waveFixture.calls.length'), callsBefore, 'no native command issued by zoom or detail');

    // 3. Timeline waveform (a canvas component): clicking the transient seeks into the displayed interval at the drawn position.
    await evaluate("document.querySelector('.canvas-entry').click()");
    await until(() => evaluate("Boolean(document.querySelector('[data-editor=\"add\"][data-kind=\"waveform\"]'))"), 'canvas palette');
    await evaluate("document.querySelector('[data-editor=\"add\"][data-kind=\"waveform\"]').click()");
    await delay(300);
    await evaluate("window.__timeline = [...document.querySelectorAll('.canvas-stage .wavebox[data-wave-deck=\"A\"]:not(.overview)')].find(b => b.getClientRects().length); window.__timeline.dataset.waveTimeline = 'yes'");
    const timeline = '.wavebox[data-wave-timeline]';
    await zoomTo(timeline, 32);
    const t = await measure(timeline, 'timeline-A-zoom32');
    assert.ok(coverage(t, xAt(t, GAP.end) + 3, t.width) >= 0.97, 'timeline columns are continuous');
    const tx = xAt(t, SPIKE), shown = t.extent.slice(Math.floor(tx) - 3, Math.ceil(tx) + 4);
    assert.ok(Math.max(...shown) >= t.reach * 0.85, 'timeline transient is drawn at its time');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.state.x + tx, y: t.state.cy, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.state.x + tx, y: t.state.cy, button: 'left', clickCount: 1 });
    await until(() => evaluate("waveFixture.requests.some(r => r.type === 'seek' && r.position > 102)"), 'seek command');
    const seek = await evaluate("waveFixture.requests.filter(r => r.type === 'seek').at(-1).position");
    // The seek input rounds to its existing 0.1 s step.
    assert.ok(Math.abs(seek - SPIKE) < 3 * (FIXTURE_DURATION / 32 / t.width) + 0.05 + 1e-6, `click seeks to the drawn transient: ${seek}`);
    assert.deepEqual(errors, []);
  } finally {
    ws?.close(); chrome?.kill('SIGTERM'); server?.close();
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
});
