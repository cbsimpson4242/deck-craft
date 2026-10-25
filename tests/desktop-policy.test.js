import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateIPC, authorize, APP_URL } = require("../desktop/policy.cjs");
const { LocalLibrary } = require("../desktop/library.cjs");
const { AudioClient } = require("../desktop/audio-client.cjs");
const { EventEmitter } = require("node:events");
test("privileged IPC admits only scoped semantic commands and finite bounded values", () => {
  for (const command of [
    { type: "shell", value: "anything" },
    { type: "load", deck: "A", trackId: "../../other" },
    { type: "seek", deck: "A", position: NaN },
    { type: "seek", deck: "A", position: Infinity },
    { type: "level", deck: "Z", value: 5 },
    { type: "level", deck: "A", value: 101 },
    { type: "status", path: "/etc/passwd" },
    { type: "reconnect", host: "example.invalid" },
    [],
    null,
  ])
    assert.throws(() => validateIPC(command));
  assert.deepEqual(validateIPC({ type: "seek", deck: "D", position: 12.5 }), { type: "seek", deck: "D", position: 12.5 });
  const frame = { url: APP_URL, routingId: 1, processId: 3 };
  const contents = { isDestroyed: () => false, getURL: () => APP_URL, mainFrame: frame };
  const window = { webContents: contents };
  assert.ok(authorize({ sender: contents, senderFrame: frame }, window));
  assert.ok(!authorize({ sender: contents, senderFrame: { ...frame, routingId: 2 } }, window));
  assert.ok(!authorize({ sender: contents, senderFrame: { ...frame, url: "https://example.invalid/" } }, window));
  assert.ok(!authorize({ sender: {}, senderFrame: frame }, window));
});
test("private library restores opaque tokens and atomically saves concurrent metadata + waveform", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deckcraft-library-"));
  try {
    const filename = path.join(dir, "Generated <audio> fixture.wav");
    await writeFile(filename, "synthetic input");
    const library = new LocalLibrary(path.join(dir, "private"));
    const record = await library.select(filename);
    const track = library.commit(record.id, { duration: 30, channels: 2, sampleRate: 48000 });
    assert.ok(!Object.hasOwn(track, "path"));
    assert.ok(!JSON.stringify(track).includes(dir));
    const first = library.save();
    library.waveform(record.id, Array(512).fill(0.25));
    await Promise.all([first, library.save()]);
    assert.equal((await stat(path.join(dir, "private"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dir, "private/library.json"))).mode & 0o777, 0o600);
    const restored = new LocalLibrary(path.join(dir, "private"));
    await restored.restore();
    assert.equal(restored.list()[0].id, record.id);
    assert.equal(restored.list()[0].peaks.length, 512);
    assert.equal(restored.get(record.id).path, filename);
    await assert.rejects(library.select(dir), /invalid_file/);
    assert.throws(() => library.get("local-not-approved"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("malformed saved library recovers without deleting user files or unrelated state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deckcraft-recovery-"));
  try {
    await writeFile(path.join(dir, "library.json"), "{invalid");
    await writeFile(path.join(dir, "unrelated.txt"), "keep");
    const library = new LocalLibrary(dir);
    await library.restore();
    assert.deepEqual(library.list(), []);
    assert.ok(library.warning);
    assert.equal(await readFile(path.join(dir, "unrelated.txt"), "utf8"), "keep");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("native connection rejects sequence/generation changes and cannot resurrect after close", () => {
  const client = Object.create(AudioClient.prototype);
  EventEmitter.call(client);
  Object.assign(client, { closed: false, pending: new Map(), sequence: 0, engineId: null, snapshot: { ready: false, decks: [] } });
  const snapshot = { ready: true, decks: ["A", "B", "C", "D"].map((id) => ({ id, playing: false })) };
  client.accept({ kind: "state", engineId: "engine-abc-123", seq: 1, snapshot });
  assert.throws(() => client.accept({ kind: "state", engineId: "engine-abc-123", seq: 1, snapshot }));
  assert.throws(() => client.accept({ kind: "state", engineId: "engine-def-123", seq: 2, snapshot }));
  client.fail("audio_engine_disconnected");
  client.accept({ kind: "state", engineId: "engine-abc-123", seq: 3, snapshot });
  assert.equal(client.snapshot.ready, false);
});
