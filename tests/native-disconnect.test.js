import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AudioClient } from "../desktop/audio-client.cjs";
import { NativeSession } from "../src/native.js";
import { createStore } from "../src/store.js";
import { registerLocalTrack } from "../src/catalog.js";

const track = { id: "local-12345678-1234-1234-1234-123456789abd", title: "Synthetic fixture", duration: 20, peaks: [] };
function receipt(seq = 5, engineId = "engine-abc-123") {
  return {
    engineId,
    seq,
    ready: true,
    decks: ["A", "B", "C", "D"].map((id) => ({ id, trackId: track.id, playing: true, position: 4, level: 78 })),
  };
}
function client() {
  return Object.assign(new EventEmitter(), { snapshot: receipt(), pending: new Map(), closed: false, fail: AudioClient.prototype.fail });
}
test("real client failure wins same native seq and permanently retires its source", () => {
  registerLocalTrack(track);
  const s = createStore({ getItem: () => null, setItem: () => {} });
  s.dispatch({ type: "load", deck: "A", trackId: track.id });
  const c = client();
  const n = new NativeSession({ onEvent: (fn) => c.on("state", (snapshot) => fn({ type: "state", snapshot })) }, s, {
    redraw() {},
    say() {},
  });
  n.accept(c.snapshot, true);
  assert.equal(s.get().decks.A.playing, true);
  AudioClient.prototype.fail.call(c, "audio_engine_disconnected");
  assert.equal(c.snapshot.seq, 5, "local failures must not manufacture native sequence numbers");
  assert.equal(n.status.ready, false);
  assert.equal(s.get().decks.A.playing, false);
  n.accept(receipt(99), true);
  assert.equal(n.status.ready, false, "even a late state event may not revive a retired engine");
  n.accept({ ...receipt(1, "engine-def-456"), decks: receipt().decks.map((d) => ({ ...d, playing: false })) }, true);
  assert.equal(n.status.ready, true);
  n.accept(receipt(100), true);
  assert.equal(n.engineId, "engine-def-456");
  assert.equal(s.get().decks.A.playing, false);
});

test("a late successful load receipt cannot restore transport after client failure", async () => {
  registerLocalTrack(track);
  const s = createStore({ getItem: () => null, setItem: () => {} });
  s.dispatch({ type: "load", deck: "A", trackId: track.id });
  const c = client();
  let release;
  const n = new NativeSession(
    {
      onEvent: (fn) => c.on("state", (snapshot) => fn({ type: "state", snapshot })),
      command: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    s,
    { redraw() {}, say() {} },
  );
  n.accept(c.snapshot, true);
  const loading = n.perform({ type: "load", deck: "A", trackId: track.id });
  AudioClient.prototype.fail.call(c, "audio_engine_disconnected");
  release({ ok: true, snapshot: receipt(6), track });
  await assert.rejects(loading, /action_superseded/);
  assert.equal(n.status.ready, false);
  assert.equal(s.get().decks.A.playing, false);
});

test("failure before first native frame retires the connection source", () => {
  const s = createStore({ getItem: () => null, setItem: () => {} });
  const c = client();
  c.snapshot = { sourceId: "synthetic-source-1", ready: false, decks: [] };
  const n = new NativeSession({ onEvent: (fn) => c.on("state", (snapshot) => fn({ type: "state", snapshot })) }, s, {
    redraw() {},
    say() {},
  });
  AudioClient.prototype.fail.call(c, "audio_engine_unavailable");
  n.accept({ ...receipt(), sourceId: "synthetic-source-1" }, true);
  assert.equal(n.status.ready, false);
  n.accept({ ...receipt(1), sourceId: "synthetic-source-2", decks: receipt().decks.map((d) => ({ ...d, playing: false })) }, true);
  assert.equal(n.status.ready, true);
});

test("stop waits for confirmed exit, escalating a stubborn child", async () => {
  const c = client();
  c.closed = true;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdin: { destroy() {} } });
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL")
      setTimeout(() => {
        child.signalCode = signal;
        child.emit("exit", null, signal);
      }, 10);
    return true;
  };
  c.child = child;
  await AudioClient.prototype.stop.call(c);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL", "stop must not resolve before exit");
});

test("stop does not wait for an exit event after spawn already failed", async () => {
  const c = client();
  c.closed = true;
  c.spawnFailed = true;
  c.child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdin: { destroy() {} },
    kill() {
      assert.fail("no process was spawned");
    },
  });
  await AudioClient.prototype.stop.call(c);
});

test("stop rejects if child exit cannot be confirmed", async () => {
  const c = client();
  c.closed = true;
  c.child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdin: { destroy() {} },
    kill() {
      return true;
    },
  });
  await assert.rejects(AudioClient.prototype.stop.call(c), /audio_engine_stop_timed_out/);
});
