import test from "node:test";
import assert from "node:assert/strict";
import { createSession, reduceSession, restoreSession, serializeSession } from "../src/session.js";
import { DECK_IDS } from "../src/catalog.js";
import { MIXER_KNOBS, MIXER_VALUE_FIELDS, gainDb, eqDb, filterSweep, knobReadout, knobValueText, knobTitle } from "../src/mixer.js";
import { knob, mixer } from "../src/components.js";

test("knob dB and frequency mapping matches the documented native engine vectors", () => {
  // Mirrors native/src/dsp.rs documented_knob_mapping_vectors.
  for (const [value, db] of [[0, -12], [25, -6], [50, 0], [75, 6], [100, 12]]) assert.equal(gainDb(value), db);
  for (const [value, db] of [[0, -24], [25, -12], [50, 0], [75, 6], [100, 12]]) assert.equal(eqDb(value), db);
  assert.ok(Math.abs(eqDb(49) + 0.48) < 1e-12);
  assert.deepEqual(filterSweep(50), { kind: "off", hz: null });
  const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
  assert.equal(filterSweep(0).kind, "lpf");
  near(filterSweep(0).hz, 100, 1e-9);
  near(filterSweep(25).hz, 1414.2135623730951, 1e-6);
  near(filterSweep(49).hz, 17990, 5);
  assert.equal(filterSweep(75).kind, "hpf");
  near(filterSweep(75).hz, 489.89794855663564, 1e-6);
  near(filterSweep(100).hz, 12000, 1e-9);
  near(filterSweep(51).hz, 22.7, 0.1);
  // Bad input is neutral or clamped, never NaN.
  assert.equal(gainDb(NaN), 0);
  assert.equal(gainDb(500), 12);
  assert.equal(eqDb(-3), -24);
});

test("readouts and spoken values are real dB / frequency, not percentages", () => {
  assert.equal(knobReadout("gain", 50), "0 dB");
  assert.equal(knobReadout("gain", 80), "+7.2 dB");
  assert.equal(knobReadout("hi", 0), "KILL");
  assert.equal(knobReadout("mid", 100), "+12.0 dB");
  assert.equal(knobReadout("low", 49), "−0.5 dB");
  assert.equal(knobReadout("filter", 50), "OFF");
  assert.equal(knobReadout("filter", 25), "LPF 1.41 kHz");
  assert.equal(knobReadout("filter", 75), "HPF 490 Hz");
  assert.equal(knobReadout("filter", 0), "LPF 100 Hz");
  assert.equal(knobReadout("filter", 100), "HPF 12.0 kHz");
  assert.equal(knobValueText("hi", 0), "KILL");
  assert.equal(knobValueText("gain", 100), "plus 12.0 dB");
  assert.equal(knobValueText("filter", 50), "Filter off");
  assert.equal(knobValueText("filter", 25), "Low-pass 1.41 kHz");
  assert.equal(knobValueText("filter", 75), "High-pass 490 Hz");
  assert.match(knobTitle("C", "filter", 75), /Deck C Filter: HPF 490 Hz\. Double-click to reset\./);
});

test("every deck exposes gain, HI, MID, LOW and FILTER in the full mixer, with accessible values", () => {
  const state = createSession();
  state.decks.C.hi = 0;
  state.decks.D.filter = 75;
  const html = mixer(state, DECK_IDS);
  for (const id of DECK_IDS)
    for (const field of MIXER_KNOBS) assert.match(html, new RegExp(`data-deck="${id}" data-field="${field}" min="0" max="100" step="1"`), `${id} ${field}`);
  assert.match(html, /data-deck="C" data-field="hi"[^>]*aria-valuetext="KILL"/);
  assert.match(html, /data-deck="D" data-field="filter"[^>]*aria-valuetext="High-pass 490 Hz"/);
  assert.match(html, /<output class="knob-readout" aria-hidden="true">HPF 490 Hz<\/output>/);
  // A two-channel component uses the same shared knob control as the console mixer.
  assert.equal([...mixer(state,['A','B']).matchAll(/data-field="filter"/g)].length, 2);
  assert.match(knob("GAIN", "gain", "A", state), /aria-valuetext="0 dB"/);
});

test("session model keeps strip values bounded, saved and always restores paused", () => {
  let state = createSession();
  for (const id of DECK_IDS) for (const field of MIXER_KNOBS) assert.equal(state.decks[id][field], 50);
  state = reduceSession(state, { type: "deck", deck: "B", field: "mid", value: 120 });
  assert.equal(state.decks.B.mid, 100);
  state = reduceSession(state, { type: "deck", deck: "B", field: "mid", value: Number.NaN });
  assert.equal(state.decks.B.mid, 100);
  state = reduceSession(state, { type: "deck", deck: "C", field: "filter", value: 12.5 });
  const restored = restoreSession(serializeSession({ ...state, decks: { ...state.decks, C: { ...state.decks.C, playing: true } } })).state;
  assert.equal(restored.decks.B.mid, 100);
  assert.equal(restored.decks.C.filter, 12.5);
  assert.equal(restored.decks.C.playing, false);
});

function snapshot(overrides = {}, { ready = true, crossfader = 50 } = {}) {
  return {
    ready,
    crossfader,
    decks: DECK_IDS.map((id) => ({ id, trackId: null, playing: false, position: 0, ...Object.fromEntries(MIXER_VALUE_FIELDS.map((f) => [f, f === "level" ? 78 : 50])), ...(overrides[id] || {}) })),
  };
}
test("native receipts own strip values; the restore window and bad values never overwrite them", () => {
  let state = createSession();
  state = reduceSession(state, { type: "native-clock", snapshot: snapshot({ A: { gain: 80, hi: 10, mid: 60, low: 33, filter: 20, level: 65 } }, { crossfader: 30 }) });
  assert.deepEqual(MIXER_VALUE_FIELDS.map((f) => state.decks.A[f]), [65, 80, 10, 60, 33, 20]);
  assert.equal(state.mixer.crossfader, 30);
  const held = reduceSession(state, { type: "native-clock", mixer: false, snapshot: snapshot({ A: { gain: 0, filter: 100, level: 0 } }, { crossfader: 100 }) });
  assert.equal(held, state, "restore window: engine defaults cannot replace the saved session");
  for (const bad of [-1, 101, NaN, Infinity, "10", null]) {
    const next = reduceSession(state, { type: "native-clock", snapshot: snapshot({ A: { gain: bad, hi: bad } }) });
    assert.equal(next.decks.A.gain, 80);
    assert.equal(next.decks.A.hi, 10);
  }
  const offline = reduceSession(state, { type: "native-clock", snapshot: snapshot({ A: { gain: 5 } }, { ready: false }) });
  assert.equal(offline.decks.A.gain, 80, "an offline engine reports nothing");
});
