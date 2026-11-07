import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DECK_IDS, registerLocalTrack } from "../src/catalog.js";
import { createSession, serializeSession } from "../src/session.js";
import { createStore, STORAGE_KEY } from "../src/store.js";
import { NativeSession } from "../src/native.js";
import { MIXER_KNOBS, MIXER_VALUE_FIELDS } from "../src/mixer.js";
const require = createRequire(import.meta.url);
const { validateIPC } = require("../desktop/policy.cjs");
const token = "local-12345678-1234-1234-1234-123456789abc";
const track = { id: token, title: "Generated tone.wav", duration: 60, peaks: [] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake engine that behaves like native/src/main.rs: strip values live on the deck, replies carry snapshots. */
function engine({ ready = true } = {}) {
  const calls = [];
  const decks = DECK_IDS.map((id) => ({ id, trackId: null, playing: false, position: 0, duration: 60, ...Object.fromEntries(MIXER_VALUE_FIELDS.map((f) => [f, f === "level" ? 78 : 50])) }));
  const live = { crossfader: 50, seq: 0, ready, engineId: "engine-abc-123" };
  const snap = () => ({ engineId: live.engineId, seq: ++live.seq, ready: live.ready, crossfader: live.crossfader, decks: structuredClone(decks) });
  const bridge = {
    callbacks: [],
    onEvent(callback) { this.callbacks.push(callback); },
    async command(request) {
      calls.push(structuredClone(request));
      const d = decks.find((x) => x.id === request.deck);
      if (MIXER_VALUE_FIELDS.includes(request.type)) d[request.type] = request.value;
      else if (request.type === "crossfader") live.crossfader = request.value;
      else if (request.type === "load") { d.trackId = request.trackId; d.position = 0; return { ok: true, track, snapshot: snap() }; }
      else if (request.type === "seek") d.position = request.position;
      else if (request.type === "play") d.playing = true;
      else if (request.type === "pause") d.playing = false;
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
  Object.assign(saved.decks.A, { trackId: token, position: 5, gain: 80, hi: 10, mid: 60, low: 33, filter: 20, level: 65 });
  Object.assign(saved.decks.B, { filter: 75, hi: 90 });
  Object.assign(saved.decks.D, { low: 5 });
  saved.mixer.crossfader = 25;
  const memory = new Map([[STORAGE_KEY, serializeSession(saved)]]);
  const store = createStore({ getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) });
  return { store, memory, saved };
}

test("saved gain/EQ/filter/level/crossfader are restored to the engine before any restored source loads, and defaults never overwrite them", async () => {
  const { store, saved } = savedStore();
  const fake = engine();
  const seenAtLoad = [];
  const original = fake.bridge.command.bind(fake.bridge);
  fake.bridge.command = async (request) => {
    if (request.type === "load") seenAtLoad.push(structuredClone(store.get().decks.A));
    return original(request);
  };
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say() {} });
  // The engine reports its neutral defaults during start-up, as the real bridge does.
  for (const cb of fake.bridge.callbacks) cb({ type: "state", snapshot: fake.snap() });
  await native.initialize();
  const index = (predicate) => fake.calls.findIndex(predicate);
  const firstLoad = index((c) => c.type === "load");
  assert.ok(firstLoad > 0);
  for (const id of DECK_IDS)
    for (const field of MIXER_VALUE_FIELDS)
      assert.ok(index((c) => c.type === field && c.deck === id && c.value === saved.decks[id][field]) < firstLoad, `${id} ${field} restored before load`);
  assert.ok(index((c) => c.type === "crossfader" && c.value === 25) < firstLoad);
  assert.ok(!fake.calls.some((c) => c.type === "play"), "restoring never plays");
  assert.equal(seenAtLoad.length, 1);
  assert.deepEqual(MIXER_VALUE_FIELDS.map((f) => seenAtLoad[0][f]), [65, 80, 10, 60, 33, 20], "saved values survived the engine's defaults");
  for (const id of DECK_IDS) for (const f of MIXER_VALUE_FIELDS) assert.equal(fake.decks.find((d) => d.id === id)[f], saved.decks[id][f]);
  assert.equal(store.get().mixer.crossfader, 25);
  assert.equal(store.get().decks.A.playing, false);
  assert.equal(native.mixerSynced, true);
});

test("a knob drag is heard live: first value at once, rate-limited, always ending on the latest value", async () => {
  const { store } = savedStore();
  const fake = engine();
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say() {} });
  await native.initialize();
  fake.calls.length = 0;
  for (let value = 1; value <= 30; value++) assert.equal(native.dispatch({ type: "deck", deck: "B", field: "hi", value }), true);
  assert.equal(fake.calls.filter((c) => c.type === "hi").length, 1, "leading edge goes out immediately");
  await wait(120);
  const sent = fake.calls.filter((c) => c.type === "hi");
  assert.ok(sent.length <= 3, `rate limited: ${sent.length}`);
  assert.equal(sent.at(-1).value, 30, "final value always reaches the engine");
  assert.equal(fake.decks[1].hi, 30);
  assert.equal(store.get().decks.B.hi, 30, "UI value comes from the native receipt");
  // Different deck / different knob do not share a limiter.
  fake.calls.length = 0;
  native.dispatch({ type: "deck", deck: "A", field: "filter", value: 40 });
  native.dispatch({ type: "deck", deck: "C", field: "filter", value: 60 });
  native.dispatch({ type: "deck", deck: "C", field: "gain", value: 70 });
  assert.deepEqual(fake.calls.map((c) => [c.type, c.deck, c.value]), [["filter", "A", 40], ["filter", "C", 60], ["gain", "C", 70]]);
  // The crossfader and channel level use the same limiter.
  fake.calls.length = 0;
  for (let value = 10; value <= 40; value += 10) native.dispatch({ type: "mixer", field: "crossfader", value });
  for (let value = 10; value <= 40; value += 10) native.dispatch({ type: "deck", deck: "D", field: "level", value });
  await wait(100);
  assert.equal(fake.live.crossfader, 40);
  assert.equal(fake.decks[3].level, 40);
});

test("double-click reset and each knob map to the exact semantic command", async () => {
  const { store } = savedStore();
  const fake = engine();
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say() {} });
  await native.initialize();
  fake.calls.length = 0;
  for (const [i, field] of MIXER_KNOBS.entries()) await native.perform({ type: "deck", deck: DECK_IDS[i % 4], field, value: 50 });
  assert.deepEqual(
    fake.calls.map((c) => [c.type, c.deck, c.value]),
    MIXER_KNOBS.map((field, i) => [field, DECK_IDS[i % 4], 50]),
  );
  await assert.rejects(native.perform({ type: "fx", effect: "echo", field: "wet", value: 3 }), /not implemented/);
  await assert.rejects(native.perform({ type: "deck", deck: "A", field: "pitch", value: 3 }), /not implemented/);
});

test("stale, superseded and disconnected receipts cannot move strip values or replay music", async () => {
  const { store } = savedStore();
  const fake = engine();
  const messages = [];
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say: (m) => messages.push(m) });
  await native.initialize();
  const base = fake.snap();
  const move = (seq, A, extra = {}) => ({ ...base, seq, decks: base.decks.map((d) => (d.id === "A" ? { ...d, ...A } : d)), ...extra });
  native.accept(move(base.seq + 10, { hi: 44 }));
  assert.equal(store.get().decks.A.hi, 44);
  native.accept(move(base.seq + 5, { hi: 99 }));
  assert.equal(store.get().decks.A.hi, 44, "older sequence ignored");
  native.accept({ ...move(1, { hi: 7 }), engineId: "engine-def-456" });
  assert.equal(store.get().decks.A.hi, 44, "a different engine is not adopted without a reconnect");
  native.accept({ ...move(base.seq + 20, { hi: 12, playing: true }), terminal: true, ready: false });
  assert.equal(store.get().decks.A.hi, 44);
  assert.equal(store.get().decks.A.playing, false);
  assert.equal(native.mixerSynced, false);
  fake.calls.length = 0;
  // Reconnect restores the strip again, still paused.
  fake.bridge.command = ((original) => async (request) => {
    if (request.type === "reconnect") { fake.live.engineId = "engine-fed-789"; fake.live.seq = 0; }
    return original(request);
  })(fake.bridge.command);
  await native.reconnect();
  assert.ok(fake.calls.some((c) => c.type === "hi" && c.deck === "A" && c.value === 44), "restores the last known value");
  assert.ok(!fake.calls.some((c) => c.type === "play"), "reconnect never replays");
});

test("strip controls wait for both connected output and restored mixer settings", async () => {
  const inputs = Array.from({ length: 3 }, () => ({ disabled: null, closest: () => ({ classList: { toggle() {} } }) }));
  const fake = engine({ ready: false });
  const { store } = savedStore();
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say() {} });
  globalThis.document = { querySelectorAll: (selector) => (selector.includes('input[data-field="gain"]') ? inputs : []) };
  try {
    await native.initialize();
    native.paintStrip();
    assert.ok(inputs.every((input) => input.disabled === true), "offline: disabled");
    fake.live.ready = true;
    native.accept(fake.snap(), true);
    native.paintStrip();
    assert.ok(inputs.every((input) => input.disabled === true), "ready but not restored: disabled");
    await native.initialize();
    native.paintStrip();
    assert.ok(inputs.every((input) => input.disabled === false), "ready and restored: enabled");
  } finally {
    delete globalThis.document;
  }
});

test("the privileged bridge admits the five strip commands with exact finite bounded values only", () => {
  for (const type of MIXER_KNOBS) {
    assert.deepEqual(validateIPC({ type, deck: "C", value: 37.5 }), { type, deck: "C", value: 37.5 });
    for (const bad of [
      { type, deck: "E", value: 1 },
      { type, deck: "A", value: -0.01 },
      { type, deck: "A", value: 100.01 },
      { type, deck: "A", value: NaN },
      { type, deck: "A", value: Infinity },
      { type, deck: "A", value: "5" },
      { type, deck: "A" },
      { type, value: 1 },
      { type, deck: "A", value: 1, path: "/etc/passwd" },
    ])
      assert.throws(() => validateIPC(bad), undefined, JSON.stringify(bad));
  }
});

test("strip changes are persisted immediately, not on the next periodic checkpoint", () => {
  const { store, memory } = savedStore();
  store.dispatch({ type: "native-clock", snapshot: { ready: true, crossfader: 25, decks: DECK_IDS.map((id) => ({ id, trackId: null, playing: false, position: 0, ...Object.fromEntries(MIXER_VALUE_FIELDS.map((f) => [f, store.get().decks[id][f]])) })) } });
  const before = memory.get(STORAGE_KEY);
  store.dispatch({ type: "native-clock", snapshot: { ready: true, crossfader: 25, decks: DECK_IDS.map((id) => ({ id, trackId: null, playing: false, position: 0, ...Object.fromEntries(MIXER_VALUE_FIELDS.map((f) => [f, f === "low" && id === "C" ? 11 : store.get().decks[id][f]])) })) } });
  assert.notEqual(memory.get(STORAGE_KEY), before);
  assert.equal(JSON.parse(memory.get(STORAGE_KEY)).decks.C.low, 11);
});


test("a partial mixer restore failure preserves saved settings and prevents playback until a successful retry", async () => {
  const { store, saved } = savedStore();
  const fake = engine();
  const command = fake.bridge.command.bind(fake.bridge);
  const messages = [];
  fake.bridge.command = async request => request.type === "mid" && request.deck === "B"
    ? { ok: false, error: "audio_command_rejected" } : command(request);
  const native = new NativeSession(fake.bridge, store, { redraw() {}, say: message => messages.push(message) });
  await native.initialize();
  assert.equal(native.mixerSynced, false);
  for (const cb of fake.bridge.callbacks) cb({ type: "state", snapshot: fake.snap() });
  for (const id of DECK_IDS) for (const field of MIXER_VALUE_FIELDS)
    assert.equal(store.get().decks[id][field], saved.decks[id][field], `${id} ${field} survives the incomplete restore`);
  native.dispatch({ type: "deck", deck: "A", field: "playing", value: true });
  assert.ok(!fake.calls.some(c => c.type === "load" || c.type === "play"));
  assert.match(messages.at(-1), /Reconnect audio/);
  fake.bridge.command = command;
  await native.initialize();
  assert.equal(native.mixerSynced, true);
  for (const id of DECK_IDS) for (const field of MIXER_VALUE_FIELDS)
    assert.equal(fake.decks.find(d => d.id === id)[field], saved.decks[id][field]);
  assert.ok(!fake.calls.some(c => c.type === "play"), "successful retry still restores paused");
});
