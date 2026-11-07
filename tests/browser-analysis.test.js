import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChannels, detectBeatGrid, onsetEnvelope, waveformPeaks } from '../src/browser-analysis.js';
import { clickPCM } from './browser-fakes.js';

test('constant grids are recovered from known impulse trains with their offset', () => {
  for (const bpm of [75, 100, 120, 128, 174]) {
    const envelope = new Float64Array(12000);
    for (let n = 0; n < 200; n++) { const i = Math.round((0.17 + n * 60 / bpm) * 200); if (i < envelope.length) envelope[i] = 1; }
    const grid = detectBeatGrid(envelope, 200);
    assert.ok(grid && Math.abs(grid.bpm - bpm) < 0.7, `${bpm}: ${JSON.stringify(grid)}`);
    const period = 60 / bpm, d = (grid.offset - 0.17 + period * 4) % period;
    assert.ok(Math.min(d, period - d) < 0.02, JSON.stringify(grid));
  }
});

test('silence, steady material and short envelopes never invent a grid', () => {
  assert.equal(detectBeatGrid(new Float64Array(12000), 200), null);
  assert.equal(detectBeatGrid(new Float64Array(12000).fill(0.1), 200), null);
  assert.equal(detectBeatGrid(new Float64Array(400), 200), null);
  const tone = Float32Array.from({ length: 24000 * 20 }, (_, i) => 0.5 * Math.sin(i * 0.115));
  assert.equal(analyzeChannels([tone, tone], 24000).beatGrid, null);
  assert.equal(analyzeChannels([new Float32Array(24000 * 20), new Float32Array(24000 * 20)], 24000).beatGrid, null);
});

test('decoded click tracks produce a constant grid and a bounded peak profile', () => {
  for (const bpm of [100, 120, 128]) {
    const result = analyzeChannels(clickPCM(bpm), 24000);
    assert.ok(result.beatGrid && Math.abs(result.beatGrid.bpm - bpm) < 0.7, `${bpm} ${JSON.stringify(result.beatGrid)}`);
    assert.equal(result.peaks.length, 512);
    assert.ok(result.peaks.every(v => v >= 0 && v <= 1) && Math.max(...result.peaks) > 0.5);
  }
});

test('only the first minute shapes the envelope and bins are exactly 200 Hz at the decode rate', () => {
  const { envelope, hz } = onsetEnvelope([new Float32Array(24000 * 90).fill(0.2)], 24000);
  assert.equal(hz, 200); assert.equal(envelope.length, 60 * 200);
  assert.ok(envelope.every(v => Math.abs(v - 0.2) < 1e-6));
});

test('waveform peaks map the whole file into 512 clamped bins', () => {
  const x = new Float32Array(5120); x[0] = 0.3; x[5119] = 4; x[2560] = -0.8;
  const peaks = waveformPeaks([x]);
  assert.equal(peaks.length, 512); assert.ok(Math.abs(peaks[0] - 0.3) < 1e-6); assert.equal(peaks[511], 1); assert.ok(Math.abs(peaks[256] - 0.8) < 1e-6);
  assert.deepEqual(waveformPeaks([new Float32Array(0)]), new Array(512).fill(0));
});
