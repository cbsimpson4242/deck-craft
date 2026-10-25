import test from "node:test";
import assert from "node:assert/strict";
import { registerLocalTrack } from "../src/catalog.js";
import { createStore } from "../src/store.js";
import { NativeSession } from "../src/native.js";
const token = "local-12345678-1234-1234-1234-123456789abc";
const track = { id: token, title: "Generated <audio> fixture.wav", duration: 20, peaks: [] };
function snapshot(seq, { playing = false, loaded = true, position = 0 } = {}) {
  return {
    engineId: "engine-abc-123",
    seq,
    ready: true,
    crossfader: 50,
    decks: ["A", "B", "C", "D"].map((id) => ({
      id,
      trackId: id === "A" && loaded ? token : null,
      playing: id === "A" && playing,
      position: id === "A" ? position : 0,
      level: 78,
      channels: 2,
      sampleRate: 48000,
      duration: 20,
    })),
  };
}
function store() {
  registerLocalTrack(track);
  const s = createStore({ getItem: () => null, setItem: () => {} });
  s.dispatch({ type: "load", deck: "A", trackId: token });
  return s;
}
for (const boundary of ["load", "cue", "hotCue", "pause", "play", "import"]) {
  test(`queued seek cannot cross a newer ${boundary} ownership boundary`, async () => {
    const replacement = { ...track, id: "local-12345678-1234-1234-1234-123456789abe" };
    registerLocalTrack(replacement);
    const s = store();
    const calls = [];
    let seq = 1;
    let current = snapshot(seq);
    const bridge = {
      onEvent() {},
      async command(request) {
        calls.push(request);
        const next = structuredClone(current);
        next.seq = ++seq;
        if (["load", "pick"].includes(request.type)) {
          next.decks[0].trackId = replacement.id;
          next.decks[0].position = 0;
        }
        if (request.type === "seek") next.decks[0].position = request.position;
        next.decks[0].playing = request.type === "play";
        current = next;
        return { ok: true, snapshot: next, track: replacement };
      },
    };
    const n = new NativeSession(bridge, s, { redraw() {}, say() {} });
    n.initialized = true;
    n.accept(current, true);
    n.dispatch({ type: "deck", deck: "A", field: "position", value: 12 });
    if (boundary === "import") await n.importAudio("A");
    else
      await n.perform(
        boundary === "load"
          ? { type: "load", deck: "A", trackId: replacement.id }
          : ["play", "pause"].includes(boundary)
            ? { type: "deck", deck: "A", field: "playing", value: boundary === "play" }
            : { type: boundary, deck: "A", index: 0 },
      );
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.ok(!calls.some((r) => r.type === "seek" && r.position === 12), "old seek must not gain a new owner after supersession");
    assert.notEqual(s.get().decks.A.position, 12);
  });
}

for (const field of ["playing", "position"]) {
  test(`a newer pause cancels asynchronous ensure-loaded ${field}`, async () => {
    const calls = [];
    let release;
    let seq = 2;
    const s = store();
    const bridge = {
      onEvent: () => {},
      command: (request) => {
        calls.push(request.type);
        if (request.type === "load")
          return new Promise((resolve) => {
            release = () => resolve({ ok: true, track, snapshot: snapshot(++seq) });
          });
        return Promise.resolve({ ok: true, snapshot: snapshot(++seq, { loaded: request.type !== "pause" }) });
      },
    };
    const native = new NativeSession(bridge, s, { redraw: () => {}, say: () => {} });
    native.initialized = true;
    native.accept(snapshot(1, { loaded: false }), true);
    const play = native.perform({ type: "deck", deck: "A", field, value: field === "playing" ? true : 12 }).catch(() => {});
    await native.perform({ type: "deck", deck: "A", field: "playing", value: false });
    release();
    await play;
    assert.ok(!calls.includes("play"), "superseded Play may not resume after Pause");
    assert.ok(!calls.includes("seek"), "superseded preparation may not seek after Pause");
  });
}
test("old sequence and old-engine replies cannot rewind native transport", () => {
  const s = store();
  const n = new NativeSession({ onEvent: () => {} }, s, { redraw: () => {}, say: () => {} });
  n.accept(snapshot(5, { position: 8, playing: true }), true);
  n.accept(snapshot(4, { position: 1 }));
  assert.equal(s.get().decks.A.position, 8);
  const current = { ...snapshot(1, { position: 10 }), engineId: "engine-def-456" };
  n.accept(current, true);
  n.accept(snapshot(99, { position: 2, playing: true }));
  assert.equal(s.get().decks.A.position, 10);
  assert.equal(s.get().decks.A.playing, false);
});
test("wrong-source or disconnected receipts never claim the old deck is playing", () => {
  const s = store();
  const n = new NativeSession({ onEvent: () => {} }, s, { redraw: () => {}, say: () => {} });
  n.accept(snapshot(1, { playing: true, position: 2 }), true);
  assert.equal(s.get().decks.A.playing, true);
  n.accept(snapshot(2, { loaded: false }));
  assert.equal(s.get().decks.A.trackId, token);
  assert.equal(s.get().decks.A.playing, false);
  n.accept({ ...snapshot(3, { playing: true }), ready: false });
  assert.equal(s.get().decks.A.playing, false);
});
