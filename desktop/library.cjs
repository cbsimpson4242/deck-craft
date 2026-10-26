"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = 512 * 1024 * 1024;
const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const RECORD_LIMIT = 10000;
const COLLECTION_ID = /^collection-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validCollections(collections, records) {
  return Array.isArray(collections) && collections.length <= 200 &&
    new Set(collections.map(c => c?.id)).size === collections.length &&
    collections.reduce((n, c) => n + (c?.trackIds?.length || 0), 0) <= 20000 &&
    collections.every(c => c && COLLECTION_ID.test(c.id) && ["crate", "playlist"].includes(c.kind) &&
      typeof c.name === "string" && c.name.trim().length > 0 && c.name.length <= 80 &&
      Array.isArray(c.trackIds) && c.trackIds.length <= RECORD_LIMIT && new Set(c.trackIds).size === c.trackIds.length &&
      c.trackIds.every(id => ID.test(id) && validRecord(records.get(id))));
}
// Build only a bounded snapshot, before touching the previous durable registry.
function snapshotText(records, collections = []) {
  if (records.size > RECORD_LIMIT) throw Error("library_capacity");
  if (!validCollections(collections, records)) throw Error("invalid_collection");
  const ending = collections.length ? '],"collections":' + JSON.stringify(collections) + '}' : "]}";
  const chunks = ['{"version":1,"tracks":['];
  let bytes = Buffer.byteLength(chunks[0]) + Buffer.byteLength(ending);
  let count = 0;
  for (const r of records.values()) {
    if (!validRecord(r)) continue; // selections awaiting native metadata are not durable yet
    const record = {
      id: r.id,
      path: r.path,
      identity: { dev: r.identity.dev, ino: r.identity.ino, size: r.identity.size, mtimeNs: r.identity.mtimeNs },
      duration: r.duration,
      channels: r.channels,
      sampleRate: r.sampleRate,
      ...(r.peaks ? { peaks: r.peaks } : {}),
    };
    const chunk = (count++ ? "," : "") + JSON.stringify(record);
    bytes += Buffer.byteLength(chunk);
    if (bytes > SNAPSHOT_LIMIT) throw Error("library_capacity");
    chunks.push(chunk);
  }
  return chunks.join("") + ending;
}
function publicTrack(r) {
  return {
    id: r.id,
    title: path.basename(r.path),
    artist: "Local audio",
    genre: "Local files",
    bpm: 0,
    key: "—",
    duration: r.duration,
    color: "#96c7a8",
    local: true,
    peaks: r.peaks || [],
    channels: r.channels,
    sampleRate: r.sampleRate,
  };
}
function validRecord(r) {
  return (
    r &&
    ID.test(r.id) &&
    typeof r.path === "string" &&
    path.isAbsolute(r.path) &&
    r.path.length <= 4096 &&
    r.identity &&
    ["dev", "ino", "mtimeNs"].every((k) => typeof r.identity[k] === "string" && /^-?\d{1,30}$/.test(r.identity[k])) &&
    Number.isSafeInteger(r.identity.size) &&
    r.identity.size > 0 &&
    r.identity.size <= LIMIT &&
    Number.isFinite(r.duration) &&
    r.duration > 0 &&
    r.duration <= 7200 &&
    Number.isInteger(r.channels) &&
    r.channels > 0 &&
    r.channels <= 32 &&
    Number.isInteger(r.sampleRate) &&
    r.sampleRate >= 8000 &&
    r.sampleRate <= 384000 &&
    (!r.peaks || (Array.isArray(r.peaks) && r.peaks.length === 512 && r.peaks.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)))
  );
}
class LocalLibrary {
  constructor(directory) {
    this.directory = directory;
    this.filename = path.join(directory, "library.json");
    this.records = new Map();
    this.collections = [];
    this.warning = "";
    this.saveChain = Promise.resolve();
  }
  async restore() {
    try {
      const file = await fs.open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let text;
      try {
        const s = await file.stat();
        if (!s.isFile() || s.size > SNAPSHOT_LIMIT) throw Error("invalid");
        // Bound the actual read too, even if the file grows after stat.
        const buffer = Buffer.alloc(SNAPSHOT_LIMIT + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > SNAPSHOT_LIMIT) throw Error("invalid");
        text = buffer.toString("utf8", 0, length);
      } finally {
        await file.close();
      }
      const saved = JSON.parse(text);
      if (saved.version !== 1 || !Array.isArray(saved.tracks) || saved.tracks.length > RECORD_LIMIT) throw Error("invalid");
      for (const record of saved.tracks) {
        if (!validRecord(record)) throw Error("invalid");
        this.records.set(record.id, record);
      }
      const collections = saved.collections ?? [];
      if (!validCollections(collections, this.records)) throw Error("invalid");
      this.collections = collections.map(c => ({ id: c.id, name: c.name, kind: c.kind, trackIds: [...c.trackIds] }));
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.records.clear();
        this.collections = [];
        this.warning = "Saved local library could not be restored. Import your files again; no file has been deleted.";
      }
    }
  }
  async select(filename) {
    const canonical = await fs.realpath(filename);
    if (canonical.length > 4096) throw Error("invalid_file");
    const file = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let s;
    try {
      s = await file.stat({ bigint: true });
    } finally {
      await file.close();
    }
    if (!s.isFile() || s.size <= 0n || s.size > BigInt(LIMIT)) throw Error("invalid_file");
    const identity = { dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeNs: String(s.mtimeNs) };
    for (const r of this.records.values()) if (r.path === canonical && JSON.stringify(r.identity) === JSON.stringify(identity)) return r;
    if (this.records.size >= RECORD_LIMIT) throw Error("library_capacity");
    const r = { id: "local-" + randomUUID(), path: canonical, identity };
    this.records.set(r.id, r);
    return r;
  }
  get(id) {
    if (!ID.test(id) || !this.records.has(id)) throw Error("unknown_local_track");
    return this.records.get(id);
  }
  commit(id, meta) {
    const r = this.get(id);
    const candidate = { ...r, duration: meta.duration, channels: meta.channels, sampleRate: meta.sampleRate };
    if (!validRecord(candidate)) throw Error("invalid_audio_metadata");
    this.records.set(id, candidate);
    return publicTrack(candidate);
  }
  waveform(id, peaks) {
    const r = this.get(id);
    const candidate = { ...r, peaks };
    if (!validRecord(candidate)) return null;
    this.records.set(id, candidate);
    return publicTrack(candidate);
  }
  list() {
    return [...this.records.values()].filter(validRecord).map(publicTrack);
  }
  changeCollection(request) {
    const operation = this.saveChain.then(async () => {
      const previous = this.collections;
      const next = structuredClone(previous);
      let collection = next.find(c => c.id === request.id);
      if (request.type === "collection-create") {
        collection = { id: "collection-" + randomUUID(), kind: request.kind, name: request.name.trim(), trackIds: [] };
        next.push(collection);
      } else {
        if (!collection) throw Error("unknown_collection");
        switch (request.type) {
          case "collection-rename": collection.name = request.name.trim(); break;
          case "collection-delete": next.splice(next.indexOf(collection), 1); break;
          case "collection-add": collection.trackIds = [...new Set([...collection.trackIds, ...request.trackIds])]; break;
          case "collection-remove": collection.trackIds = collection.trackIds.filter(id => !request.trackIds.includes(id)); break;
          case "collection-move": {
            if (collection.kind !== "playlist" || ![-1, 1].includes(request.direction)) throw Error("invalid_collection");
            const from = collection.trackIds.indexOf(request.trackId), to = from + request.direction;
            if (from < 0) throw Error("unknown_local_track");
            if (to >= 0 && to < collection.trackIds.length) [collection.trackIds[from], collection.trackIds[to]] = [collection.trackIds[to], collection.trackIds[from]];
            break;
          }
          default: throw Error("invalid_command");
        }
      }
      if (!validCollections(next, this.records)) throw Error("invalid_collection");
      this.collections = next;
      if (!(await this.writeSnapshot())) {
        this.collections = previous;
        throw Error("library_save_failed");
      }
      return structuredClone(collection);
    });
    this.saveChain = operation.catch(() => {});
    return operation;
  }
  forget(ids) {
    const operation = this.saveChain.then(async () => {
      ids.forEach(id => this.get(id));
      const previous = this.records, collections = this.collections;
      this.records = new Map([...previous].filter(([id]) => !ids.includes(id)));
      this.collections = collections.map(c => ({ ...c, trackIds: c.trackIds.filter(id => !ids.includes(id)) }));
      if (!(await this.writeSnapshot())) {
        this.records = previous;
        this.collections = collections;
        throw Error("library_save_failed");
      }
    });
    this.saveChain = operation.catch(() => {});
    return operation;
  }
  save() {
    this.saveChain = this.saveChain.then(() => this.writeSnapshot());
    return this.saveChain;
  }
  async writeSnapshot() {
    const temporary = path.join(this.directory, ".library-" + randomUUID() + ".tmp");
    try {
      const text = snapshotText(this.records, this.collections);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await fs.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, this.filename);
      this.warning = "";
      return true;
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      this.warning =
        error.message === "library_capacity"
          ? "Local library capacity limit reached (16 MiB or 10,000 records). Changes were not saved; the previous saved library is unchanged. Playback remains available in this session."
          : "Local library changes could not be saved. The previous saved library is unchanged. Playback remains available in this session.";
      return false;
    }
  }
}
module.exports = { LocalLibrary, publicTrack, ID, COLLECTION_ID };
