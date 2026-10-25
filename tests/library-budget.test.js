import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { LocalLibrary } = require("../desktop/library.cjs");
const BUDGET = 16 * 1024 * 1024;
// Synthetic metadata only; no music or host paths are read by these fixtures.
function record(i, source = "/synthetic/audio.wav") {
  return {
    id: `local-00000000-0000-0000-0000-${i.toString(16).padStart(12, "0")}`,
    path: source,
    identity: { dev: "1", ino: String(i), size: 16, mtimeNs: "1" },
    duration: 30,
    channels: 2,
    sampleRate: 48000,
  };
}
const encode = (records) => JSON.stringify({ version: 1, tracks: [...records.values()] });
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deckcraft-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new LocalLibrary(dir);
}
async function reopen(library) {
  const restored = new LocalLibrary(library.directory);
  await restored.restore();
  assert.equal(restored.warning, "");
  return restored;
}
test("review counterexample: successful 2000-waveform save must restore every opaque ID", async (t) => {
  const library = await fixture(t);
  const first = record(1);
  library.records.set(first.id, first);
  assert.equal(await library.save(), true);
  const previous = await readFile(library.filename);
  for (let i = 1; i <= 2000; i++) {
    const r = { ...record(i), peaks: Array(512).fill(0.1234567890123456) };
    library.records.set(r.id, r);
  }
  assert.ok(Buffer.byteLength(encode(library.records)) > BUDGET);
  if (await library.save()) {
    const restored = await reopen(library);
    assert.deepEqual([...restored.records.keys()], [...library.records.keys()]);
  } else {
    assert.match(library.warning, /capacity|limit|budget/i);
    assert.deepEqual(await readFile(library.filename), previous);
    assert.equal((await reopen(library)).get(first.id).path, first.path);
  }
});
test("supported waveform snapshots retain exact amplitudes, private paths and opaque IDs", async (t) => {
  const library = await fixture(t);
  for (let i = 1; i <= 1500; i++) {
    const r = { ...record(i), peaks: Array.from({ length: 512 }, (_, j) => j / 511) };
    library.records.set(r.id, r);
  }
  assert.equal(await library.save(), true);
  assert.ok((await stat(library.filename)).size <= BUDGET);
  const restored = await reopen(library);
  assert.deepEqual([...restored.records], [...library.records]);
  const track = restored.list()[0];
  assert.equal(Object.hasOwn(track, "path"), false);
  assert.equal(JSON.stringify(track).includes("/synthetic/"), false);
});
// Build a valid snapshot exactly at the UTF-8 byte boundary (not character count).
function boundaryRecords() {
  const records = new Map();
  let size = Buffer.byteLength(encode(records));
  let i = 1;
  while (true) {
    const r = record(i++, "/" + "界".repeat(1300));
    const added = Buffer.byteLength(JSON.stringify(r)) + (records.size ? 1 : 0);
    if (size + added + 5000 > BUDGET) break;
    records.set(r.id, r);
    size += added;
  }
  const last = record(i, "/");
  const remaining = BUDGET - size - Buffer.byteLength(JSON.stringify(last)) - 1;
  last.path += "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  assert.ok(last.path.length <= 4096);
  records.set(last.id, last);
  assert.equal(Buffer.byteLength(encode(records)), BUDGET);
  return { records, last };
}
test("exact byte boundary restores; one-byte metadata growth preserves durable registry and retries", async (t) => {
  const library = await fixture(t);
  const { records, last } = boundaryRecords();
  library.records = records;
  assert.equal(await library.save(), true);
  assert.equal((await stat(library.filename)).size, BUDGET);
  assert.equal((await reopen(library)).records.size, records.size);
  const previous = await readFile(library.filename);
  library.commit(last.id, { duration: 300, channels: 2, sampleRate: 48000 });
  assert.equal(await library.save(), false);
  assert.match(library.warning, /capacity|limit|budget/i);
  assert.deepEqual(await readFile(library.filename), previous);
  assert.equal((await reopen(library)).get(last.id).duration, 30);
  library.commit(last.id, { duration: 30, channels: 2, sampleRate: 48000 });
  assert.equal(await library.save(), true);
  assert.equal(library.warning, "");
  assert.deepEqual((await readdir(library.directory)).sort(), ["library.json"]);
});
test("waveform growth and record-count overflow cannot replace a good durable library", async (t) => {
  const library = await fixture(t);
  const { records, last } = boundaryRecords();
  library.records = records;
  assert.equal(await library.save(), true);
  const previous = await readFile(library.filename);
  assert.ok(library.waveform(last.id, Array(512).fill(0.1234567890123456)));
  assert.equal(await library.save(), false);
  assert.deepEqual(await readFile(library.filename), previous);
  library.records = new Map(
    Array.from({ length: 10001 }, (_, i) => {
      const r = record(i + 1);
      return [r.id, r];
    }),
  );
  assert.equal(await library.save(), false);
  assert.match(library.warning, /capacity|limit|budget/i);
  assert.deepEqual(await readFile(library.filename), previous);
});
test("legacy over-budget restore is visible and leaves the saved file untouched", async (t) => {
  const library = await fixture(t);
  const oversized = Buffer.alloc(BUDGET + 1, 32);
  await writeFile(library.filename, oversized);
  await library.restore();
  assert.ok(library.warning);
  assert.equal(library.records.size, 0);
  assert.deepEqual(await readFile(library.filename), oversized);
});
test("invalid metadata cannot discard a previous record during a later save", async (t) => {
  const library = await fixture(t);
  const r = record(1);
  library.records.set(r.id, r);
  assert.equal(await library.save(), true);
  assert.throws(() => library.commit(r.id, { duration: NaN, channels: 2, sampleRate: 48000 }), /invalid_audio_metadata/);
  assert.equal(library.waveform(r.id, Array(512).fill(Infinity)), null);
  assert.equal(await library.save(), true);
  assert.deepEqual((await reopen(library)).get(r.id), r);
});
test("10000 records save/restore; admission refuses the next record without changing IDs", async (t) => {
  const library = await fixture(t);
  for (let i = 1; i <= 10000; i++) {
    const r = record(i);
    library.records.set(r.id, r);
  }
  assert.equal(await library.save(), true);
  assert.equal((await reopen(library)).records.size, 10000);
  const source = path.join(library.directory, "synthetic.wav");
  await writeFile(source, "synthetic");
  await assert.rejects(library.select(source), /library_capacity/);
  assert.equal(library.records.size, 10000);
});
