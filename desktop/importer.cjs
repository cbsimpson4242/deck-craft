"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".aiff", ".aif"]);
// This one-shot decoder never opens an audio device. No shell, inherited secrets,
// unbounded stdout, diagnostics forwarding, or renderer-provided path.
function inspectAudio(binary, record) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--inspect"], { shell: false, env: { LANG: "C", ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
    let text = "", settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(Error(error)); } else resolve(value);
    };
    const timer = setTimeout(() => done("audio_inspection_timed_out"), 10000);
    child.stdout.on("data", chunk => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > 8192) done("invalid_audio_metadata");
    });
    child.stderr.on("data", () => {});
    child.on("error", () => done("audio_engine_unavailable"));
    child.stdin.on("error", () => done("audio_engine_unavailable"));
    child.on("close", code => {
      if (settled) return;
      try {
        const reply = JSON.parse(text);
        if (code !== 0 || !reply.ok) return done(/^[a-z_]{1,60}$/.test(reply.error) ? reply.error : "unsupported_or_corrupt_audio");
        done(null, reply.metadata);
      } catch { done("invalid_audio_metadata"); }
    });
    child.stdin.end(JSON.stringify({ id: "inspect", command: { type: "load", deck: "A", trackId: record.id, path: record.path, identity: record.identity } }) + "\n");
  });
}
async function importSelection(library, paths, { inspect, folder = false, progress = () => {} }) {
  const queue = paths.map(filename => ({ filename, depth: 0 }));
  const candidates = [], errors = [];
  let visited = 0, skipped = 0, truncated = false;
  // Bound traversal as well as import count; do not follow directory symlinks.
  while (queue.length && candidates.length < 1000 && visited < 20000) {
    const { filename, depth } = queue.shift(); visited++;
    try {
      const info = await fs.lstat(filename);
      if (info.isSymbolicLink()) { skipped++; continue; }
      if (info.isDirectory() && folder && depth <= 16) {
        const directory = await fs.opendir(filename);
        for await (const entry of directory) {
          if (queue.length + visited >= 20000) { truncated = true; break; }
          queue.push({ filename: path.join(filename, entry.name), depth: depth + 1 });
        }
      } else if (info.isFile() && AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase())) candidates.push(filename);
      else skipped++;
    } catch { skipped++; }
  }
  truncated ||= queue.length > 0;
  const tracks = new Map();
  let added = 0, existing = 0, failed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const filename = candidates[i]; let record;
    try {
      record = await library.select(filename);
      const known = Number.isFinite(record.duration);
      const track = known ? library.list().find(t => t.id === record.id) : library.commit(record.id, await inspect(record));
      tracks.set(track.id, track);
      if (known) existing++; else added++;
    } catch (error) {
      if (record && !record.duration) library.records.delete(record.id);
      failed++;
      if (errors.length < 20) errors.push({ name: path.basename(filename), error: /^[a-z_]{1,60}$/.test(error.message) ? error.message : "invalid_file" });
    }
    progress({ completed: i + 1, total: candidates.length, added, failed });
  }
  const saved = await library.save();
  return { tracks: [...tracks.values()], summary: { added, existing, failed, skipped, truncated, errors }, warning: saved ? "" : library.warning };
}
module.exports = { inspectAudio, importSelection };
