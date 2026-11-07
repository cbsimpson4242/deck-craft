import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { LocalLibrary, publicWaveDetail } = require("../desktop/library.cjs");
const { AudioClient } = require("../desktop/audio-client.cjs");
// Synthetic metadata and generated envelopes only.
const encode = (bytes) => Buffer.from(bytes).toString("base64");
const detail = (bins, peak = (i) => i % 256, rms = (i) => Math.min(peak(i), (i * 7) % 256)) => ({
  bins,
  peak: encode(Uint8Array.from({ length: bins }, (_, i) => peak(i))),
  rms: encode(Uint8Array.from({ length: bins }, (_, i) => rms(i))),
});
const record = (i) => ({
  id: `local-00000000-0000-0000-0000-${i.toString(16).padStart(12, "0")}`,
  path: "/synthetic/audio.wav",
  identity: { dev: "1", ino: String(i), size: 16, mtimeNs: "1" },
  duration: 240,
  channels: 2,
  sampleRate: 48000,
});

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// Same decoded bytes, but unused trailing bits set: decodable, yet not what the engine emits.
const noncanonical = (text) => { const i = text.length - 3; return text.slice(0, i) + ALPHABET[ALPHABET.indexOf(text[i]) + 1] + text.slice(i + 1); };
test("only exactly formed native detail reaches the renderer", () => {
  for (const bins of [512, 513, 640, 15360, 32767, 32768]) assert.deepEqual(publicWaveDetail(detail(bins)), detail(bins));
  const good = detail(640);
  for (const bad of [
    null, undefined, [], "text", 5, {},
    { ...good, extra: 1 }, { bins: good.bins, peak: good.peak },
    { ...good, bins: 511 }, { ...good, bins: 32769 }, { ...good, bins: 640.5 }, { ...good, bins: "640" },
    { ...good, peak: good.peak.slice(0, -4) }, { ...good, rms: good.rms + "AAAA" },
    { ...good, peak: good.peak.slice(0, -1) + "!" }, { ...good, peak: 7 }, { ...good, rms: null },
    // Non-canonical padding/alphabet and an RMS above its peak are refused.
    { ...good, peak: noncanonical(good.peak) },
    detail(640, () => 10, () => 11),
  ])
    assert.equal(publicWaveDetail(bad), null, JSON.stringify(bad)?.slice(0, 60));
  const result = publicWaveDetail({ ...good, __proto__: { polluted: true } });
  assert.ok(result && !("polluted" in result));
});

test("the full native waveform message fits the child-output frame limit and passes through the authenticated client", () => {
  const worst = { kind: "waveform", engineId: "engine-abc-123", seq: 2, deck: "A", trackId: record(1).id, loadGeneration: 4294967295, peaks: Array(512).fill(0.123456789012345), detail: detail(32768) };
  const line = JSON.stringify(worst) + "\n";
  // audio-client.cjs fails the engine above 256 KiB of unframed output; keep a wide margin for coalesced state lines.
  assert.ok(line.length < 128 * 1024, `message is ${line.length} bytes`);
  const client = Object.create(AudioClient.prototype);
  EventEmitter.call(client);
  Object.assign(client, { closed: false, pending: new Map(), sequence: 0, engineId: null, snapshot: { ready: false, decks: [] } });
  const seen = [];
  client.on("waveform", (message) => seen.push(message));
  client.accept({ ...JSON.parse(line), seq: 1 });
  assert.equal(seen.length, 1);
  assert.deepEqual(publicWaveDetail(seen[0].detail), worst.detail);
  assert.throws(() => client.accept({ ...JSON.parse(line), seq: 1 }), /invalid_engine_sequence/);
});

test("session-only detail adds nothing to the registry, snapshot or per-track persistence budget", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deckcraft-detail-"));
  try {
    const library = new LocalLibrary(dir);
    const r = record(1);
    library.records.set(r.id, r);
    assert.ok(library.waveform(r.id, Array(512).fill(0.25)));
    assert.equal(await library.save(), true);
    const saved = await readFile(library.filename);
    // The IPC handler validates detail separately and never hands it to the library.
    assert.ok(publicWaveDetail(detail(32768)));
    assert.equal(await library.save(), true);
    assert.deepEqual(await readFile(library.filename), saved);
    assert.equal(JSON.parse(saved).tracks[0].peaks.length, 512);
    assert.deepEqual(Object.keys(JSON.parse(saved).tracks[0]).sort(), ["channels", "duration", "id", "identity", "path", "peaks", "sampleRate"]);
    assert.equal(Object.hasOwn(library.list()[0], "detail"), false);
    // The existing waveform API still rejects anything but exactly 512 valid peaks.
    assert.equal(library.waveform(r.id, Array(2048).fill(0.1)), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Exercise the actual main-process callback across its asynchronous persistence boundary.
test("waveform forwarding rechecks deck/load and connection ownership after saving", async () => {
  const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const body = source.split('client.on("waveform", async (message) => {')[1].split("\n    });")[0];
  for (const change of ["same-track-reload", "different-track", "engine-death", "reconnect", "seek", "current"]) {
    const client = { engineId: "engine-aa-bb", closed: false, snapshot: { decks: [{ id: "A", trackId: record(1).id, loadGeneration: 7, waveGeneration: 7 }] } };
    const sent = []; let release;
    const context = { client, audio: client, publicWaveDetail, notify: m => sent.push(m), library: {
      commit() {}, waveform() { return { id: record(1).id }; }, save() { return new Promise(r => { release = r; }); }
    }};
    const handler = vm.runInNewContext("(async (message) => {" + body + "})", context);
    const pending = handler({ engineId: client.engineId, deck: "A", trackId: record(1).id, loadGeneration: 7, detail: detail(512) });
    assert.ok(release, "callback reached real save boundary");
    if (change === "same-track-reload") client.snapshot.decks[0].waveGeneration++;
    if (change === "seek") client.snapshot.decks[0].loadGeneration++;
    if (change === "different-track") client.snapshot.decks[0].trackId = record(2).id;
    if (change === "engine-death") client.closed = true;
    if (change === "reconnect") context.audio = {};
    release(true); await pending;
    assert.equal(sent.length, ["current", "seek"].includes(change) ? 2 : 0, change);
    if (change === "current") {
      assert.equal(sent[1].deck, "A"); assert.equal(sent[1].loadGeneration, 7);
      assert.equal(sent[1].engineId, client.engineId);
    }
  }
});
