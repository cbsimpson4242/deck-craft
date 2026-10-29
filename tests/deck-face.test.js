import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_IDS, LAYOUTS, registerLocalTrack } from '../src/catalog.js';
import { createSession, reduceSession } from '../src/session.js';
import { deck, linearDeck, wave, pads, transport } from '../src/components.js';
import { createViewOptions, renderSession } from '../src/views.js';

const attrs = (html, pattern) => [...html.matchAll(pattern)];

test('every layout renders the approved reference deck face with no unavailable command bindings', () => {
  const state = createSession();
  for (const layout of LAYOUTS) {
    const html = renderSession(reduceSession(state, { type: 'layout', value: layout.id }), createViewOptions());
    assert.equal((html.match(/<section class="deck face /g) || []).length, layout.decks, layout.id);
    if (layout.id.startsWith('studio-') && layout.id !== 'studio-linear') {
      for (const part of ['dk-head', 'dk-strip', 'dk-overview', 'dk-pitch', 'dk-loop-length', 'class="pads"', 'dk-edit']) assert.ok(html.includes(part), `${layout.id} ${part}`);
      assert.match(html, /class="wavebox\s+scroll\s/, `${layout.id} scrolling waveform`);
    }
    // Placeholders must be disabled controls that carry no semantic action.
    for (const [button] of attrs(html, /<button[^>]*class="dk-ghost"[^>]*>/g)) assert.match(button, /disabled/);
    for (const [button] of attrs(html, /<div class="dk-edit"[\s\S]*?<\/div>/g)) assert.ok(!/data-action/.test(button), 'cue editing toolbar must not bind actions');
  }
});

test('cue bank shows eight positions but only four stored manual cues', () => {
  const html = pads('A', createSession());
  assert.equal((html.match(/data-action="hot-cue"/g) || []).length, 4);
  assert.equal((html.match(/class="pad-slot"/g) || []).length, 4);
  assert.deepEqual([...html.matchAll(/class="pad-slot"[^>]*>(\d)</g)].map(m => m[1]), ['5', '6', '7', '8']);
  assert.ok(!/data-index="[4-9]"/.test(html), 'slots 5-8 cannot dispatch a cue index');
});

test('loop length presets use the existing validated loopLength field only', () => {
  const state = createSession();
  const html = transport('A', state, true);
  assert.deepEqual([...html.matchAll(/data-action="loop-length"[^>]*data-value="(\d+)"/g)].map(m => m[1]), ['4', '8', '16']);
  for (const value of [4, 16, 8]) assert.equal(reduceSession(state, { type: 'deck', deck: 'A', field: 'loopLength', value }).decks.A.loopLength, value);
  assert.equal(reduceSession(state, { type: 'deck', deck: 'A', field: 'loopLength', value: 3 }), state, 'invalid length remains rejected');
  for (const unavailable of ['CUP', 'FLX', 'REV', 'IN', 'OUT']) assert.match(html, new RegExp(`class="dk-ghost" disabled[^>]*>${unavailable}<`));
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
  assert.notEqual(first.match(/data-wave-layer="column" d="[^"]*/)?.[0], second.match(/data-wave-layer="column" d="[^"]*/)?.[0], 'real peak data must change the drawing');
  assert.ok(first.length > 1000);
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
  assert.equal(wave('A', state, { scroll: true }).replace(/wave-\d+/g, 'wave-N'), wave('A', state, { scroll: true }).replace(/wave-\d+/g, 'wave-N'));
  const odd = registerLocalTrack({ id: 'local-dddddddd-dddd-dddd-dddd-dddddddddddd', title: '<img src=x onerror=alert(1)>', duration: 30, peaks: Array.from({ length: 512 }, () => 0.5) });
  const loaded = reduceSession(state, { type: 'load', deck: 'A', trackId: odd.id });
  for (const html of [deck('A', loaded), linearDeck('A', loaded, createViewOptions())]) {
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!/NaN|Infinity|undefined/.test(html));
  }
});

test('two- and four-deck faces keep deck identities and one shared model', () => {
  const state = createSession();
  for (const id of DECK_IDS) {
    const html = deck(id, state);
    assert.match(html, new RegExp(`data-deck="${id}"`));
    assert.match(html, /data-field="playing"/);
    assert.equal((html.match(/data-action="toggle-deck"[^>]*data-field="playing"/g) || []).length, 1, 'one Play control per deck face');
  }
});

test('a local file without tempo analysis says so instead of showing an empty highlighted box', () => {
  const local = registerLocalTrack({ id: 'local-33333333-3333-3333-3333-333333333333', title: 'Pending tempo fixture.wav', duration: 90, peaks: [] });
  const demo = deck('A', createSession(), 'compact');
  assert.doesNotMatch(demo, /dk-tempo pending/);
  assert.match(demo, /class="bpm-value">\d+\.\d\d</);
  const loaded = reduceSession(createSession(), { type: 'load', deck: 'A', trackId: local.id });
  const html = deck('A', loaded, 'compact');
  assert.match(html, /class="dk-tempo pending"/);
  assert.match(html, /class="bpm-value">—</);
  assert.match(html, />analysis pending</);
  assert.doesNotMatch(html, /key-value/);
});
