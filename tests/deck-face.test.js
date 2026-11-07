import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_IDS, registerLocalTrack } from '../src/catalog.js';
import { createSession, reduceSession } from '../src/session.js';
import { deck, lane, wave, pads, loopPads } from '../src/components.js';
import { createViewOptions, renderSession } from '../src/views.js';
import { waveSource, sampleWave } from '../src/wave-render.js';

test('the console renders the deck panel and lane with no unavailable command bindings', () => {
  const html = renderSession(createSession(), createViewOptions());
  for (const part of ['dp-head', 'class="platter"', 'class="transport"', 'class="pitch"', 'class="pads"', 'loop-pads', 'class="wavebox  scroll ', 'overview']) assert.ok(html.includes(part), part);
  // Placeholders must be disabled controls that carry no semantic action.
  const disabled = [...html.matchAll(/<button[^>]*disabled[^>]*>/g)].map(m => m[0]);
  assert.ok(disabled.length >= 8, 'ROLL, SLICER, IN and OUT stay visible but disabled');
  for (const button of disabled) assert.ok(!/data-action/.test(button), 'disabled placeholders must not bind actions: ' + button);
});

test('cue bank shows eight positions but only four stored manual cues', () => {
  const html = pads('A', createSession());
  assert.equal((html.match(/data-action="hot-cue"/g) || []).length, 4);
  assert.equal((html.match(/class="pad-slot"/g) || []).length, 4);
  assert.deepEqual([...html.matchAll(/class="pad-slot"[^>]*>(\d)</g)].map(m => m[1]), ['5', '6', '7', '8']);
  assert.ok(!/data-index="[4-9]"/.test(html), 'slots 5-8 cannot dispatch a cue index');
});

test('loop length pads use the existing validated loopLength field only', () => {
  const state = createSession();
  const html = loopPads('A', state);
  assert.deepEqual([...html.matchAll(/data-action="loop-length"[^>]*data-value="(\d+)"/g)].map(m => m[1]), ['1', '2', '4', '8', '16', '32']);
  for (const value of [4, 16, 8]) assert.equal(reduceSession(state, { type: 'deck', deck: 'A', field: 'loopLength', value }).decks.A.loopLength, value);
  assert.equal(reduceSession(state, { type: 'deck', deck: 'A', field: 'loopLength', value: 3 }), state, 'invalid length remains rejected');
  for (const unavailable of ['IN', 'OUT']) assert.match(html, new RegExp(`class="pad pad-off" disabled[^>]*><strong>${unavailable}<`));
});

test('local waveform draws decoded peaks as amplitude and never claims frequency analysis', () => {
  const quiet = Array.from({ length: 512 }, (_, i) => 0.05 + 0.02 * Math.sin(i / 7));
  const loud = Array.from({ length: 512 }, (_, i) => 0.95 - 0.02 * Math.sin(i / 7));
  const a = registerLocalTrack({ id: 'local-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Quiet fixture.wav', duration: 120, peaks: quiet });
  const b = registerLocalTrack({ id: 'local-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'Loud fixture.wav', duration: 120, peaks: loud });
  let state = reduceSession(createSession(), { type: 'load', deck: 'A', trackId: a.id });
  state = reduceSession(state, { type: 'load', deck: 'B', trackId: b.id });
  const first = wave('A', state, { scroll: true }), second = wave('B', state, { scroll: true });
  assert.match(first, /data-wave-color="amplitude"/);
  assert.match(first, /PCM amplitude waveform — not a beat grid/);
  assert.match(first, /<canvas class="waveform wave-canvas" data-wave-layer="column"/);
  const drawn = track => Array.from(sampleWave(waveSource(track), 0, 1, 64).amp);
  assert.notDeepEqual(drawn(a), drawn(b), 'real peak data must change the drawing');
  assert.ok(Math.max(...drawn(a)) < 0.1 && Math.min(...drawn(b)) > 0.9, 'sampled columns keep amplitude meaning');
  assert.doesNotMatch(first + second, /frequency|spectral|bass|treble/i);
  // Synthetic demo tracks are explicitly labeled fixtures.
  const demo = wave('C', createSession(), { scroll: true });
  assert.match(demo, /data-wave-color="fixture"/);
  assert.match(demo, /Synthetic waveform fixture — not analyzed audio/);
});

test('local track with no peaks renders no invented waveform', () => {
  const none = registerLocalTrack({ id: 'local-cccccccc-cccc-cccc-cccc-cccccccccccc', title: 'Pending.wav', duration: 60, peaks: [] });
  const state = reduceSession(createSession(), { type: 'load', deck: 'A', trackId: none.id });
  const html = wave('A', state, { scroll: true });
  assert.match(html, /PCM waveform analysis pending/);
  assert.ok(!html.includes('data-wave-layer'));
});

test('waveform rendering is deterministic, finite and escapes track text', () => {
  const state = createSession();
  assert.equal(wave('A', state, { scroll: true }), wave('A', state, { scroll: true }));
  const odd = registerLocalTrack({ id: 'local-dddddddd-dddd-dddd-dddd-dddddddddddd', title: '<img src=x onerror=alert(1)>', duration: 30, peaks: Array.from({ length: 512 }, () => 0.5) });
  const loaded = reduceSession(state, { type: 'load', deck: 'A', trackId: odd.id });
  for (const html of [deck('A', loaded), lane('A', loaded)]) {
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!/NaN|Infinity|undefined/.test(html));
  }
});

test('every deck keeps its identity and one shared model with one Play control', () => {
  const state = createSession();
  for (const id of DECK_IDS) {
    const html = deck(id, state);
    assert.match(html, new RegExp(`data-deck="${id}"`));
    assert.match(html, /data-field="playing"/);
    assert.equal((html.match(/data-action="toggle-deck"[^>]*data-field="playing"/g) || []).length, 1, 'one Play control per deck panel');
  }
});

test('a local file without tempo analysis says so instead of showing an empty highlighted box', () => {
  const local = registerLocalTrack({ id: 'local-33333333-3333-3333-3333-333333333333', title: 'Pending tempo fixture.wav', duration: 90, peaks: [] });
  const demo = deck('A', createSession());
  assert.match(demo, /class="bpm-value">\d+\.\d</);
  assert.match(demo, /class="key key-value"/);
  const loaded = reduceSession(createSession(), { type: 'load', deck: 'A', trackId: local.id });
  const html = deck('A', loaded);
  assert.match(html, /class="bpm-value">—</);
  assert.match(html, />ANALYSIS PENDING</);
  assert.doesNotMatch(html, /key-value/);
});
