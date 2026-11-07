import test from "node:test";
import assert from "node:assert/strict";
import { DECK_IDS, registerLocalTrack, trackById } from "../src/catalog.js";
import { createSession, serializeSession, reduceSession } from "../src/session.js";
import { createStore, STORAGE_KEY } from "../src/store.js";
import { NativeSession } from "../src/native.js";
import { MIXER_KNOBS, MIXER_VALUE_FIELDS } from "../src/mixer.js";
import { BROWSER_PROFILE, NATIVE_PROFILE } from "../src/backends.js";
import { waveRuler, waveSource } from "../src/wave-render.js";
import { nativeLibrary } from "../src/library.js";
import { deck, lane } from "../src/components.js";

// Regressions for the merged tempo/analysis work and the full-kill mixer. They describe what each
// backend promises to the user (which controls are live, which commands may reach an engine, and what
// restoration may and may not send), not how NativeSession is written.
const token = "local-aaaaaaaa-1111-2222-3333-123456789abc";
const track = { id: token, title: "Merge fixture.wav", duration: 90, peaks: [], bpm: 120, beatGrid: { bpm: 120, offset: 0.25, confidence: 0.9 }, analysisVersion: 1 };

function engine({ browser = false } = {}) {
  const calls = [];
  const decks = DECK_IDS.map((id) => ({ id, trackId: null, playing: false, position: 0, duration: 90, rate: 1, pitchLock: true, synced: false,
    ...Object.fromEntries(MIXER_VALUE_FIELDS.map((f) => [f, f === "level" ? 78 : 50])) }));
  const live = { crossfader: 50, seq: 0, master: null };
  // The browser engine's receipts carry no gain/EQ/filter/meter/assign fields and no mixer capability flags.
  const strip = (d) => browser ? { id: d.id, trackId: d.trackId, playing: d.playing, position: d.position, duration: d.duration, level: d.level, rate: d.rate, pitchLock: d.pitchLock, synced: d.synced } : { ...d, assign: "thru", meter: { l: 0, r: 0 } };
  const snap = () => ({ engineId: "engine-merge-1", seq: ++live.seq, ready: true, crossfader: live.crossfader, master: live.master,
    capabilities: browser ? { pitchLock: true } : { channelEq: true, channelMeters: true, crossfaderAssign: true }, decks: decks.map(strip) });
  const bridge = {
    backend: browser ? { id: "browser" } : undefined,
    callbacks: [],
    onEvent(cb) { this.callbacks.push(cb); },
    async command(request) {
      calls.push(structuredClone(request));
      const d = decks.find((x) => x.id === request.deck);
      if (browser && MIXER_KNOBS.includes(request.type)) return { ok: false, error: "audio_command_rejected" };
      if (MIXER_VALUE_FIELDS.includes(request.type)) d[request.type] = request.value;
      else if (request.type === "crossfader") live.crossfader = request.value;
      else if (request.type === "load") { d.trackId = request.trackId; d.position = 0; return { ok: true, track, snapshot: snap() }; }
      else if (request.type === "tempo") { d.rate = request.rate; d.pitchLock = request.pitchLock; }
      else if (request.type === "seek") d.position = request.position;
      else if (request.type === "master") live.master = request.deck;
      else if (request.type === "status") return { ok: true, snapshot: snap() };
      else if (request.type === "retain-track") return { ok: true };
      return { ok: true, snapshot: snap() };
    },
  };
  return { bridge, calls, decks, live, snap };
}
function savedStore() {
  registerLocalTrack(track);
  const saved = createSession();
  Object.assign(saved.decks.A, { trackId: token, position: 12, gain: 70, hi: 0, mid: 40, low: 65, filter: 30, level: 60, pitch: 4, pitchLock: false });
  saved.mixer.crossfader = 35;
  saved.master = "A";
  const memory = new Map([[STORAGE_KEY, serializeSession(saved)]]);
  return { saved, store: createStore({ getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) }) };
}
function fakeDom(controls) {
  const previous = globalThis.document;
  const made = {};
  const make = (key, extra = {}) => (made[key] = { disabled: false, title: "", classList: { toggle() {}, add() {} }, closest: () => null, ...extra });
  const groups = {
    '[data-action="eq-kill"],[data-action="assign"]': [make("kill"), make("assign")],
    'input[data-action="crossfader"]': [make("crossfader")],
  };
  for (const field of MIXER_VALUE_FIELDS) groups[`input[data-field="${field}"]`] = [make(field)];
  globalThis.document = { querySelectorAll: (selector) => groups[selector] || [] };
  return { made, restore: () => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; } };
}

test("native restore sends the whole saved strip, then tempo and master, in that order and leaves transport paused", async () => {
  const { store, saved } = savedStore();
  const fake = engine();
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say: () => {} });
  await native.initialize();
  assert.equal(native.mixerSynced, true);
  const types = fake.calls.map((c) => c.type);
  const firstLoad = types.indexOf("load");
  for (const field of MIXER_VALUE_FIELDS) assert.ok(types.indexOf(field) >= 0 && types.indexOf(field) < firstLoad, `${field} restored before the source loads`);
  const tempo = fake.calls.find((c) => c.type === "tempo");
  assert.deepEqual([tempo.deck, tempo.rate, tempo.pitchLock], ["A", 1.04, false]);
  assert.ok(types.indexOf("tempo") > firstLoad, "tempo is applied to the loaded source");
  assert.ok(fake.calls.some((c) => c.type === "master" && c.deck === "A"));
  assert.ok(!types.includes("play"), "restoration never starts audio");
  for (const field of MIXER_VALUE_FIELDS) assert.equal(fake.decks[0][field], saved.decks.A[field]);
  assert.equal(fake.decks[0].hi, 0, "a killed band is restored as a kill");
});

test("browser restore sends only levels and the crossfader; advanced strip values stay saved, untouched and disabled", async () => {
  const { store, saved } = savedStore();
  const fake = engine({ browser: true });
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say: () => {} });
  assert.equal(native.profile, BROWSER_PROFILE);
  await native.initialize();
  assert.equal(native.mixerSynced, true, "unsupported strip values must not block playback");
  const sent = new Set(fake.calls.map((c) => c.type));
  for (const field of MIXER_KNOBS) assert.ok(!sent.has(field), `${field} is never sent to the browser engine`);
  assert.ok(!sent.has("assign") && sent.has("level") && sent.has("crossfader"));
  // A browser receipt cannot rewrite the saved EQ/gain/filter or the saved band-kill memory.
  for (const cb of fake.bridge.callbacks) cb({ type: "state", snapshot: fake.snap() });
  for (const field of MIXER_KNOBS) assert.equal(store.get().decks.A[field], saved.decks.A[field], field);
  const dom = fakeDom();
  try {
    native.paintStrip();
    for (const field of MIXER_KNOBS) assert.equal(dom.made[field].disabled, true, `${field} disabled`);
    assert.equal(dom.made.kill.disabled, true);
    assert.match(dom.made.gain.title, /browser/i);
    assert.equal(dom.made.level.disabled, false);
    assert.equal(dom.made.crossfader.disabled, false);
  } finally { dom.restore(); }
  const messages = [];
  native.say = (m) => messages.push(m);
  fake.calls.length = 0;
  native.dispatch({ type: "deck", deck: "A", field: "hi", value: 20 });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!fake.calls.some((c) => c.type === "hi"), "an unavailable EQ command is not forwarded");
  assert.ok(messages.length >= 1);
});

test("native keeps gain/EQ/filter/kill/assign real while tempo, master and sync are also real", async () => {
  const { store } = savedStore();
  const fake = engine();
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say: () => {} });
  assert.equal(native.profile, NATIVE_PROFILE);
  await native.initialize();
  const dom = fakeDom();
  try {
    native.paintStrip();
    for (const field of MIXER_VALUE_FIELDS) assert.equal(dom.made[field].disabled, false, `${field} enabled`);
    assert.equal(dom.made.kill.disabled, false);
  } finally { dom.restore(); }
  fake.calls.length = 0;
  native.dispatch({ type: "deck", deck: "A", field: "pitch", value: 6 });
  native.dispatch({ type: "deck", deck: "A", field: "hi", value: 80 });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(fake.calls.some((c) => c.type === "tempo" && c.deck === "A" && Math.abs(c.rate - 1.06) < 1e-9));
  assert.ok(fake.calls.some((c) => c.type === "hi" && c.value === 80));
});

test("one receipt can carry tempo, lock, sync, a killed band and an assignment without losing either feature set", () => {
  registerLocalTrack(track);
  let s = reduceSession(createSession(), { type: "load", deck: "A", trackId: token });
  s = reduceSession(s, { type: "deck", deck: "A", field: "hi", value: 70 });
  s = reduceSession(s, { type: "eq-kill", deck: "A", band: "hi", kill: true });
  assert.equal(s.decks.A.hi, 0);
  const snapshot = { ready: true, master: "A", crossfader: 50, decks: [{ id: "A", trackId: token, position: 4, playing: true, rate: 1.05, pitchLock: false, synced: true, assign: "right", gain: 55, hi: 0, mid: 50, low: 50, filter: 50, level: 78 }] };
  const next = reduceSession(s, { type: "native-clock", snapshot, mixer: true });
  const a = next.decks.A;
  assert.deepEqual([a.pitch, a.pitchLock, a.sync, a.assign, a.gain, a.hi], [5, false, true, "right", 55, 0]);
  assert.equal(next.master, "A");
  assert.equal(a.eqRestore.hi, 70, "the remembered knob position survives tempo receipts");
  // During mixer restoration the engine's defaults must not overwrite saved strip values, but tempo receipts still apply.
  const restoring = reduceSession(s, { type: "native-clock", snapshot, mixer: false });
  assert.equal(restoring.decks.A.gain, s.decks.A.gain);
  assert.equal(restoring.decks.A.assign, s.decks.A.assign);
});

test("beat-grid marks follow the displayed interval and tempo never moves the source-time ruler", () => {
  registerLocalTrack(track);
  const t = trackById(token);
  // 120 BPM from 0.25 s: beats at 0.25, 0.75, ... in source time. The ruler is in track fractions, so it is
  // independent of the deck's tempo (tempo changes playback speed, not where the grid sits in the file).
  const marks = waveRuler(t, waveSource(t) ?? { offset: 0 }, true, 0, 10 / 90);
  assert.ok(marks.length >= 19 && marks.length <= 21, `${marks.length} marks in 10 s`);
  assert.ok(Math.abs(marks[0].u - 0.25 / 90) < 1e-9);
  assert.deepEqual(marks.slice(0, 5).map((m) => m.strong), [true, false, false, false, true]);
  const far = waveRuler(t, { offset: 0 }, true, 0, 1);
  assert.ok(far.length <= 401, "a whole-track ruler is thinned and bounded");
  assert.deepEqual(waveRuler({ ...t, beatGrid: null }, { offset: 0 }, true, 0, 1 / 9).length > 0, true, "without a grid it keeps the time ruler");
});

test("deck panel and lane show measured BPM following the tempo fader, and real master/lock/load controls", () => {
  registerLocalTrack(track);
  let s = reduceSession(createSession(), { type: "load", deck: "A", trackId: token });
  s = reduceSession(s, { type: "deck", deck: "A", field: "pitch", value: 5 });
  const panel = deck("A", s), strip = lane("A", s);
  assert.match(panel, /126\.00/);
  assert.match(strip, /126\.00/);
  for (const control of ['data-action="master"', 'data-field="pitchLock"', 'data-action="deck-load"', 'data-field="sync"']) assert.ok(panel.includes(control), control);
  // The mixer stays untouched by the tempo work.
  assert.match(panel, /data-deck="A"/);
});

test("the library lists art, measured BPM and rows without retired checkbox or load controls", () => {
  registerLocalTrack({ ...track, artwork: undefined });
  const html = nativeLibrary(createSession());
  assert.match(html, /library-artwork/);
  assert.match(html, /120\.00/);
  assert.doesNotMatch(html, /type="checkbox"|load-target|load-cell|class="load"/);
  assert.match(html, /aria-selected="false"/);
});
