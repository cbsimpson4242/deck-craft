import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLocalTrack, replaceLocalLibrary, setLocalWaveDetail, waveDetailById, trackById, WAVE_DETAIL_MAX_BINS } from '../src/catalog.js';
import { createSession, reduceSession, serializeSession } from '../src/session.js';
import { waveViewport } from '../src/wave-zoom.js';
import { paintWaveBox } from '../src/components.js';
import { waveSource, sampleWave, drawWave, paintWaveCanvas } from '../src/wave-render.js';
import { FIXTURE_DURATION, FIXTURE_IDS, GAP, SPIKE, detailFixture, legacyPeaks, encodeDetail } from './wave-fixtures.mjs';

// Generated, synthetic data only.
const dynamic = detailFixture('dynamic'), loud = detailFixture('brickwall');
const register = (id, peaks) => registerLocalTrack({ id, title: 'Generated fixture.wav', duration: FIXTURE_DURATION, peaks });
const recorder = () => {
  const rects = [], ctx = { rects, fillStyle: '', globalAlpha: 1, clearRect() {}, fillRect(x, y, w, h) { rects.push({ x, y, w, h, color: this.fillStyle, alpha: this.globalAlpha, ruler: true }); }, beginPath() {}, fill() {}, rect(x, y, w, h) { rects.push({ x, y, w, h, color: this.fillStyle, alpha: this.globalAlpha }); } };
  return ctx;
};
const columnsDrawn = (rects, W) => { const seen = new Set(); for (const r of rects) if (!r.ruler && r.alpha > 0.9) for (let x = r.x; x < r.x + r.w; x++) seen.add(x); return W - seen.size; };
function canvasFor(width = 800, height = 100) {
  const ctx = recorder(), canvas = { ownerDocument: { defaultView: { devicePixelRatio: 1 } }, clientWidth: width, clientHeight: height, width: 0, height: 0, style: { getPropertyValue: () => '#d2fa69' }, getContext: () => ctx };
  return { canvas, ctx };
}

test('detail must be exact base64 bins for a known track, bounded to a few decks and dropped with its track', () => {
  const id = FIXTURE_IDS.dynamic;
  register(id, legacyPeaks(dynamic));
  const wire = encodeDetail(dynamic);
  assert.equal(setLocalWaveDetail('local-00000000-0000-4000-8000-000000000000', wire), null, 'unknown track');
  for (const bad of [null, {}, { ...wire, bins: 100 }, { ...wire, bins: WAVE_DETAIL_MAX_BINS + 1 }, { ...wire, bins: 1.5 }, { ...wire, peak: wire.peak.slice(4) }, { ...wire, rms: wire.rms + 'AAAA' }, { ...wire, peak: '!'.repeat(wire.peak.length) }, { ...wire, peak: 7 }])
    assert.equal(setLocalWaveDetail(id, bad), null);
  assert.equal(waveDetailById(id), undefined);
  const before = JSON.stringify(trackById(id).peaks), saved = serializeSession(createSession());
  const stored = setLocalWaveDetail(id, wire);
  assert.equal(stored.bins, dynamic.bins);assert.deepEqual([...stored.peak], [...dynamic.peak]);assert.deepEqual([...stored.rms], [...dynamic.rms]);
  assert.equal(JSON.stringify(trackById(id).peaks), before, 'persisted peaks untouched');
  assert.equal(serializeSession(createSession()), saved);
  // Ten tracks never keep more than eight envelopes; a library update drops removed tracks.
  const ids = Array.from({ length: 10 }, (_, i) => `local-00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  for (const other of ids) { register(other, []); setLocalWaveDetail(other, wire); }
  assert.equal(ids.filter(other => waveDetailById(other)).length, 8);
  assert.equal(waveDetailById(id), undefined, 'oldest entry evicted');
  replaceLocalLibrary([{ id: ids[9], title: 'kept.wav', duration: 30 }]);
  assert.equal(ids.filter(other => waveDetailById(other)).length, 1);
  assert.ok(waveDetailById(ids[9]));
});

test('sampling follows the displayed interval at every zoom: transients survive, silence stays silent, ends are absent', () => {
  const id = FIXTURE_IDS.dynamic;
  register(id, legacyPeaks(dynamic));setLocalWaveDetail(id, encodeDetail(dynamic));
  const source = waveSource(trackById(id)), W = 800, ratio = SPIKE / FIXTURE_DURATION;
  assert.equal(source.detail, true);
  for (const zoom of [1, 2, 5, 12, 32]) {
    const v = waveViewport(ratio, zoom, true), s = sampleWave(source, v.start, v.end, W);
    assert.equal(s.amp.length, W);
    // The loudest column is the one-bin transient, drawn at SPIKE's position within one pixel.
    let at = 0;for (let c = 1; c < W; c++) if (s.amp[c] > s.amp[at]) at = c;
    assert.ok(s.amp[at] >= 0.99, `transient survives max-pooling at ${zoom}x`);
    const expected = (ratio - v.start) / (v.end - v.start) * W;
    assert.ok(Math.abs(at + 0.5 - expected) <= 1 + (1 / 64 / FIXTURE_DURATION) / ((v.end - v.start) / W), `transient at ${at}, expected ${expected} (${zoom}x)`);
  }
  // Digital silence is drawn as no waveform, and neighbours are not smeared into it at deep zoom.
  const v = waveViewport(101.5 / FIXTURE_DURATION, 32, true), s = sampleWave(source, v.start, v.end, W);
  const x = t => Math.floor((t / FIXTURE_DURATION - v.start) / (v.end - v.start) * W);
  for (let c = x(GAP.start) + 2; c < x(GAP.end) - 2; c++) assert.equal(s.amp[c], 0);
  assert.ok(s.amp[x(GAP.start) - 3] > 0 && s.amp[x(GAP.end) + 3] > 0);
  // Before the start and after the end there is nothing to draw (no invented data).
  const edge = sampleWave(source, -0.05, 0.05, 100);
  assert.ok(edge.amp.slice(0, 49).every(a => a === -1) && edge.amp.slice(51).every(a => a >= 0));
  const end = sampleWave(source, 0.95, 1.05, 100);
  assert.ok(end.amp.slice(0, 49).every(a => a >= 0) && end.amp.slice(51).every(a => a === -1));
  // RMS never exceeds the peak that contains it.
  for (const zoom of [1, 32]) { const w = waveViewport(0.4, zoom), r = sampleWave(source, w.start, w.end, W); for (let c = 0; c < W; c++) assert.ok(r.core[c] <= r.amp[c] + 1e-6); }
});

test('persisted 512-peak data is continuous when zoomed, and a local file without peaks draws nothing', () => {
  const id = 'local-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const track = register(id, legacyPeaks(loud));
  const source = waveSource(track);
  assert.equal(source.detail, undefined);
  const v = waveViewport(0.5, 32), s = sampleWave(source, v.start, v.end, 1000);
  assert.ok(s.amp.every(a => a >= 0.98), 'no empty columns between the coarse peaks');
  for (let c = 1; c < 1000; c++) assert.ok(Math.abs(s.amp[c] - s.amp[c - 1]) < 0.02, 'interpolated display never invents a step');
  assert.equal(waveSource(register('local-dddddddd-dddd-4ddd-8ddd-dddddddddddd', [])), null);
  const { canvas, ctx } = canvasFor();
  assert.equal(paintWaveCanvas(canvas, trackById('local-dddddddd-dddd-4ddd-8ddd-dddddddddddd'), v), false);
  assert.equal(ctx.rects.length, 0);
});

test('drawn columns tile the displayed interval with no stretched-line gaps at any zoom, within bounded work', () => {
  const id = FIXTURE_IDS.brickwall;
  register(id, legacyPeaks(loud));setLocalWaveDetail(id, encodeDetail(loud));
  const track = trackById(id);
  for (const [scroll, zoom] of [[true, 1], [true, 5], [true, 32], [false, 1], [false, 7], [false, 32]]) {
    const { canvas, ctx } = canvasFor(1000, 120), v = waveViewport(0.5, zoom, scroll);
    const t0 = performance.now();
    assert.equal(paintWaveCanvas(canvas, track, v, { scroll }), true);
    assert.ok(performance.now() - t0 < 250, 'one paint is bounded work');
    assert.equal(canvas.width, 1000);assert.equal(canvas.height, 120);
    assert.equal(columnsDrawn(ctx.rects, 1000), 0, `every column of a loud signal is filled at ${zoom}x`);
    assert.ok(ctx.rects.filter(r => !r.ruler).length <= 1000 * 3, 'at most three rectangles per pixel column');
    for (const r of ctx.rects) { assert.ok(r.x >= 0 && r.x + r.w <= 1000 && r.y >= 0 && r.y + r.h <= 120, JSON.stringify(r)); }
  }
  // Painting an unchanged viewport again does no work; moving it by a pixel does.
  const { canvas, ctx } = canvasFor(), v = waveViewport(0.4, 8, true);
  paintWaveCanvas(canvas, track, v, { scroll: true });const count = ctx.rects.length;
  paintWaveCanvas(canvas, track, v, { scroll: true });assert.equal(ctx.rects.length, count);
  paintWaveCanvas(canvas, track, waveViewport(0.4 + 1 / 8 / 800, 8, true), { scroll: true });assert.ok(ctx.rects.length > count);
});

test('silence leaves no waveform; the RMS core sits inside the peak envelope; huge or tiny canvases stay bounded', () => {
  const id = FIXTURE_IDS.dynamic;
  register(id, legacyPeaks(dynamic));setLocalWaveDetail(id, encodeDetail(dynamic));
  const source = waveSource(trackById(id)), v = waveViewport(101.5 / FIXTURE_DURATION, 32, true), W = 800, H = 100;
  const ctx = recorder();drawWave(ctx, W, H, 1, source, sampleWave(source, v.start, v.end, W), { from: v.start });
  const x = t => Math.floor((t / FIXTURE_DURATION - v.start) / (v.end - v.start) * W);
  const wave = ctx.rects.filter(r => !r.ruler && r.alpha > 0.5);
  assert.ok(!wave.some(r => r.x > x(GAP.start) + 2 && r.x < x(GAP.end) - 2), 'nothing is drawn inside digital silence');
  const outer = new Map(), inner = new Map();
  for (const r of wave) (r.alpha > 0.9 ? outer : inner).set(r.x, r);
  for (const [px, core] of inner) { const o = outer.get(px); if (o) { assert.ok(core.y >= o.y - 1 && core.y + core.h <= o.y + o.h + 1, `core inside envelope at ${px}`); } }
  const { canvas } = canvasFor(100000, 100000);
  assert.equal(paintWaveCanvas(canvas, trackById(id), v), true);
  assert.ok(canvas.width <= 4096 && canvas.height <= 512);
  assert.equal(paintWaveCanvas(canvasFor(0, 40).canvas, trackById(id), v), false, 'hidden boxes are skipped');
});

test('viewport alignment: the transient drawn by a zoomed timeline lies at the same time as its seek input maps to', () => {
  const id = FIXTURE_IDS.dynamic;
  register(id, legacyPeaks(dynamic));setLocalWaveDetail(id, encodeDetail(dynamic));
  const track = trackById(id), W = 900;
  for (const [position, zoom, scroll] of [[101.5, 32, false], [SPIKE, 32, false], [SPIKE, 8, false], [102.5, 20, false], [101.5, 32, true], [SPIKE, 8, true]]) {
    const { canvas, ctx } = canvasFor(W, 100), seek = {}, marker = { style: {} }, props = {};
    const box = { dataset: { waveZoom: String(zoom), waveDuration: String(FIXTURE_DURATION) }, classList: { contains: name => name === 'scroll' && scroll }, style: { setProperty: (k, v) => { props[k] = v; } }, querySelector: sel => sel === '.wave-seek' ? seek : sel === 'canvas.wave-canvas' ? canvas : sel === '.position-marker' ? marker : null };
    paintWaveBox(box, position / FIXTURE_DURATION, track);
    const spike = ctx.rects.filter(r => !r.ruler && r.alpha > 0.9).sort((a, b) => b.h - a.h)[0];
    const v = waveViewport(position / FIXTURE_DURATION, zoom, scroll), pixel = (SPIKE / FIXTURE_DURATION - v.start) / (v.end - v.start) * W;
    assert.ok(Math.abs(spike.x + 0.5 - pixel) <= 1.5 + W * zoom / dynamic.bins, `${scroll ? 'scroll' : 'timeline'} ${zoom}x drawn at ${spike.x}, expected ${pixel}`);
    if (!scroll) {
      const seconds = Number(seek.min) + (spike.x + 0.5) / W * (Number(seek.max) - Number(seek.min));
      assert.ok(Math.abs(seconds - SPIKE) <= 2 * (Number(seek.max) - Number(seek.min)) / W + 0.02, `seek interval maps ${spike.x} to ${seconds}, expected ${SPIKE}`);
      assert.ok(Math.abs(Number(props['--wave-start']) - v.start) < 1e-12);
    }
  }
});

test('decks keep separate sources; detail for one track never changes another, nor musical state', () => {
  const a = 'local-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', b = 'local-ffffffff-ffff-4fff-8fff-ffffffffffff';
  register(a, legacyPeaks(dynamic));register(b, legacyPeaks(loud));setLocalWaveDetail(a, encodeDetail(dynamic));
  const before = waveSource(trackById(b));
  setLocalWaveDetail(b, encodeDetail(loud));
  assert.equal(waveSource(trackById(a)).detail, true);
  assert.notEqual(waveSource(trackById(a)), waveSource(trackById(b)));
  assert.equal(before.detail, undefined);
  let state = createSession();state = reduceSession(state, { type: 'load', deck: 'A', trackId: a });state = reduceSession(state, { type: 'load', deck: 'B', trackId: b });
  const saved = serializeSession(state);
  setLocalWaveDetail(a, encodeDetail(dynamic));
  assert.equal(serializeSession(state), saved);
});

test('an envelope for a track still on a deck is never evicted by newer envelopes', () => {
  const wire = encodeDetail(dynamic), keep = 'local-11111111-1111-4111-8111-111111111111';
  register(keep, []);setLocalWaveDetail(keep, wire);
  const others = Array.from({ length: 12 }, (_, i) => `local-22222222-2222-4222-8222-${String(i + 1).padStart(12, '0')}`);
  for (const other of others) { register(other, []); setLocalWaveDetail(other, wire, [keep]); }
  assert.ok(waveDetailById(keep), 'loaded track keeps its envelope');
  assert.equal([keep, ...others].filter(id => waveDetailById(id)).length, 8, 'still bounded to eight');
  assert.equal(waveDetailById(others[0]), undefined);
});

test("renderer detail rejects extra fields, noncanonical encoding and RMS above peak", () => {
  const id = FIXTURE_IDS.dynamic; register(id, []);
  const wire = encodeDetail(dynamic);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padded = encodeDetail({ bins: 512, peak: new Uint8Array(512).fill(20), rms: new Uint8Array(512).fill(10) });
  const i = padded.peak.length - 2;
  const noncanonical = padded.peak.slice(0, i) + alphabet[alphabet.indexOf(padded.peak[i]) + 1] + padded.peak.slice(i + 1);
  for (const bad of [{ ...wire, extra: true }, { ...padded, peak: noncanonical }, { ...padded, rms: Buffer.alloc(512, 21).toString("base64") }])
    assert.equal(setLocalWaveDetail(id, bad), null);
});
