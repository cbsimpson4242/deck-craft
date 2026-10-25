"use strict";
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");

/** A local, framed child-process connection. No listening port or shell. */
class AudioClient extends EventEmitter {
  constructor(binary, { env = process.env } = {}) {
    super();
    this.sourceId = randomUUID();
    this.snapshot = { sourceId: this.sourceId, ready: false, decks: [], error: "audio_engine_starting" };
    this.pending = new Map();
    this.engineId = null;
    this.sequence = 0;
    this.closed = false;
    this.buffer = "";
    const childEnv = {};
    for (const key of [
      "HOME",
      "USER",
      "LOGNAME",
      "PATH",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "PULSE_SERVER",
      "PULSE_RUNTIME_PATH",
      "ALSA_CONFIG_PATH",
      "ALSA_PLUGIN_DIR",
      "PIPEWIRE_REMOTE",
      "PIPEWIRE_RUNTIME_DIR",
      "LD_LIBRARY_PATH",
    ])
      if (env[key]) childEnv[key] = env[key];
    this.lastMessage = Date.now();
    this.child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: childEnv, shell: false });
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMessage > 3000) {
        this.fail("audio_command_timed_out");
        this.child.kill("SIGTERM");
      }
    }, 250);
    this.watchdog.unref();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 256 * 1024) {
        this.fail("invalid_engine_frame");
        this.child.kill();
        return;
      }
      for (let end; (end = this.buffer.indexOf("\n")) >= 0;) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          this.accept(JSON.parse(line));
        } catch {
          this.fail("invalid_engine_frame");
          this.child.kill();
          return;
        }
      }
    });
    // Never forward device/file diagnostics, paths or inherited environment to UI.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => {
      if (!this.child.pid) this.spawnFailed = true;
      this.fail("audio_engine_unavailable");
    });
    this.child.on("exit", () => this.fail("audio_engine_disconnected"));
  }
  accept(message) {
    if (this.closed) return;
    this.lastMessage = Date.now();
    if (
      typeof message.engineId !== "string" ||
      !/^engine-[a-f0-9]+-[a-f0-9]+$/.test(message.engineId) ||
      !Number.isSafeInteger(message.seq) ||
      message.seq <= this.sequence
    )
      throw Error("invalid_engine_sequence");
    if (this.engineId && message.engineId !== this.engineId) throw Error("invalid_engine_generation");
    this.engineId = message.engineId;
    this.sequence = message.seq;
    if (message.snapshot) {
      if (typeof message.snapshot.ready !== "boolean" || !Array.isArray(message.snapshot.decks) || message.snapshot.decks.length !== 4)
        throw Error("invalid_engine_snapshot");
      this.snapshot = { ...message.snapshot, sourceId: this.sourceId, terminal: false, engineId: this.engineId, seq: this.sequence };
      this.emit("state", this.snapshot);
    }
    if (message.kind === "reply") {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.ok) item.resolve(this.snapshot);
      else item.reject(Error(String(message.error || "audio_command_rejected")));
    } else if (message.kind === "waveform") this.emit("waveform", message);
  }
  request(command) {
    if (this.pending.size >= 128) return Promise.reject(Error("audio_command_busy"));
    if (this.closed) return Promise.reject(Error("audio_engine_disconnected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail("audio_command_timed_out");
        this.child.kill("SIGTERM");
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, command }) + "\n", (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(Error("audio_engine_disconnected"));
        }
      });
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(Error(error));
    }
    this.pending.clear();
    // Terminal ownership is local to this connection, never a fabricated native seq.
    this.snapshot = {
      ...this.snapshot,
      terminal: true,
      ready: false,
      error,
      decks: this.snapshot.decks.map((d) => ({ ...d, playing: false })),
    };
    this.emit("state", this.snapshot);
  }
  async stop() {
    if (!this.closed) {
      try {
        await Promise.race([this.request({ type: "shutdown" }), new Promise((r) => setTimeout(r, 300))]);
      } catch {}
    }
    this.child.stdin.destroy();
    this.fail("audio_engine_disconnected");
    const exited = () => this.spawnFailed || this.child.exitCode !== null || this.child.signalCode != null;
    const waitForExit = (ms) =>
      new Promise((resolve) => {
        if (exited()) return resolve(true);
        const done = (confirmed) => {
          clearTimeout(timer);
          this.child.removeListener("exit", onExit);
          resolve(confirmed);
        };
        const onExit = () => done(true);
        const timer = setTimeout(() => done(false), ms);
        this.child.once("exit", onExit);
        if (exited()) done(true);
      });
    if (exited()) return;
    this.child.kill("SIGTERM");
    if (await waitForExit(300)) return;
    this.child.kill("SIGKILL");
    if (!(await waitForExit(1000))) throw Error("audio_engine_stop_timed_out");
  }
}
module.exports = { AudioClient };
