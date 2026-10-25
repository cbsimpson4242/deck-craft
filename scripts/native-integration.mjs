import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const runProgram = promisify(execFile);
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AudioClient } from "../desktop/audio-client.cjs";
import { LocalLibrary } from "../desktop/library.cjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.ALSA_CONFIG_PATH || !process.env.PULSE_SERVER?.startsWith("unix:") || !process.env.DECKCRAFT_TEST_PAREC)
  throw Error(
    "Use an isolated Unix PulseAudio null sink with ALSA_CONFIG_PATH, PULSE_SERVER and DECKCRAFT_TEST_PAREC. This test never chooses physical output implicitly.",
  );
const temporary = await mkdtemp(path.join(os.tmpdir(), "deckcraft-native-"));
const evidence = process.env.DECKCRAFT_EVIDENCE_DIR;
const checks = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture(seconds = 8) {
  const rate = 48000,
    frames = rate * seconds,
    b = Buffer.alloc(44 + frames * 4);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * (i < rate * 4 ? 440 : 880) * i) / rate) * 6000);
    b.writeInt16LE(value, 44 + i * 4);
    b.writeInt16LE(value, 46 + i * 4);
  }
  return b;
}
const chunks = [];
let bytes = 0;
const recorder = spawn(
  process.env.DECKCRAFT_TEST_PAREC,
  [
    "--server=" + process.env.PULSE_SERVER,
    "--device=deckcraft_test.monitor",
    "--raw",
    "--format=s16le",
    "--rate=48000",
    "--channels=2",
    "--latency-msec=30",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
recorder.stdout.on("data", (b) => {
  chunks.push(b);
  bytes += b.length;
});
let recorderError = "";
recorder.stderr.on("data", (b) => {
  recorderError += b;
});
const audio = new AudioClient(process.env.DECKCRAFT_TEST_ENGINE || path.join(root, "native/target/debug/deck-craft-audio"));
const frames = [];
audio.on("state", (s) =>
  frames.push({
    seq: s.seq,
    ready: s.ready,
    decks: s.decks.map((d) => ({ id: d.id, trackId: d.trackId, position: d.position, playing: d.playing })),
  }),
);
let peaks;
audio.on("waveform", (w) => {
  peaks = w.peaks;
});
function latest() {
  const b = Buffer.concat(chunks);
  return b.subarray(Math.max(0, b.length - 48000));
}
function rms(b) {
  let sum = 0,
    n = 0;
  for (let i = 0; i + 1 < b.length; i += 2) {
    const v = b.readInt16LE(i) / 32768;
    sum += v * v;
    n++;
  }
  return Math.sqrt(sum / Math.max(n, 1));
}
function tone(b, hz) {
  let s = 0,
    c = 0,
    n = 0;
  for (let i = 0; i + 3 < b.length; i += 4) {
    const v = b.readInt16LE(i) / 32768;
    s += v * Math.sin((2 * Math.PI * hz * n) / 48000);
    c += v * Math.cos((2 * Math.PI * hz * n) / 48000);
    n++;
  }
  return Math.hypot(s, c) / Math.max(n, 1);
}
try {
  const file = path.join(temporary, "Generated two-tone fixture.wav");
  await writeFile(file, fixture());
  const library = new LocalLibrary(temporary);
  const record = await library.select(file);
  let state = await audio.request({ type: "status" });
  assert.equal(state.ready, true, "isolated native output must really open");
  checks.push("Native ALSA output connected to isolated real-time PulseAudio null sink");
  for (const [extension, args] of [
    ["mp3", ["-c:a", "libmp3lame", "-ar", "44100"]],
    ["flac", ["-c:a", "flac"]],
    ["ogg", ["-c:a", "libvorbis"]],
    ["m4a", ["-c:a", "aac"]],
    ["aac", ["-c:a", "aac", "-f", "adts"]],
    ["aiff", ["-c:a", "pcm_s16be"]],
    ["alac.m4a", ["-c:a", "alac"]],
  ]) {
    const variant = path.join(temporary, "Generated format fixture." + extension);
    await runProgram(process.env.FFMPEG || "ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-y",
      "-i",
      file,
      ...args,
      variant,
    ]);
    const selected = await library.select(variant);
    const decoded = await audio.request({
      type: "load",
      deck: "A",
      trackId: selected.id,
      path: selected.path,
      identity: selected.identity,
    });
    assert.ok(decoded.decks[0].duration > 7.8 && decoded.decks[0].duration < 8.3, extension + " duration");
    assert.equal(decoded.decks[0].channels, 2);
    const sought = await audio.request({ type: "seek", deck: "A", position: 4.5 });
    assert.ok(Math.abs(sought.decks[0].position - 4.5) < 0.02, extension + " seek");
    checks.push("Actual " + extension.toUpperCase() + " encode → native decode and paused seek");
  }
  state = await audio.request({ type: "load", deck: "A", trackId: record.id, path: record.path, identity: record.identity });
  let d = state.decks[0];
  assert.equal(d.trackId, record.id);
  assert.equal(d.duration, 8);
  assert.equal(d.channels, 2);
  assert.equal(d.sampleRate, 48000);
  assert.equal(d.playing, false);
  checks.push("Real PCM decode and paused transactional deck load");
  await audio.request({ type: "play", deck: "A" });
  const deadline = Date.now() + 4000;
  do {
    await delay(100);
    state = await audio.request({ type: "status" });
  } while (state.decks[0].position <= 0.5 && Date.now() < deadline);
  await delay(200);
  assert.equal(state.decks[0].playing, true);
  assert.ok(state.decks[0].position > 0.3, JSON.stringify(state.decks[0]));
  const audible = rms(latest());
  assert.ok(audible > 0.003, "native output must contain measured nonzero PCM: " + audible + " " + recorderError);
  checks.push("Native play advances sample-derived position and produces captured PCM");
  state = await audio.request({ type: "pause", deck: "A" });
  const paused = state.decks[0].position;
  await delay(350);
  state = await audio.request({ type: "status" });
  assert.equal(state.decks[0].playing, false);
  assert.ok(Math.abs(paused - state.decks[0].position) < 0.02);
  checks.push("Pause stops native source-clock advancement");
  state = await audio.request({ type: "seek", deck: "A", position: 4.5 });
  assert.ok(Math.abs(state.decks[0].position - 4.5) < 0.02);
  await audio.request({ type: "play", deck: "A" });
  await delay(800);
  const seekSignal = { hz440: tone(latest(), 440), hz880: tone(latest(), 880) };
  assert.ok(seekSignal.hz880 > seekSignal.hz440 * 5 && seekSignal.hz880 > 0.002, JSON.stringify(seekSignal));
  checks.push("Paused seek changes actual output from 440 Hz to 880 Hz");
  await audio.request({ type: "crossfader", value: 100 });
  await delay(700);
  const muted = rms(latest());
  assert.ok(muted < 0.0001, "crossfader must actually mute deck A: " + muted);
  checks.push("Native A/B crossfader changes captured audio, not only UI state");
  await audio.request({ type: "crossfader", value: 50 });
  await assert.rejects(audio.request({ type: "seek", deck: "A", position: 9 }), /invalid_position/);
  checks.push("Out-of-range seek rejected without replacing deck");
  await audio.request({ type: "seek", deck: "A", position: 7.8 });
  await delay(600);
  state = await audio.request({ type: "status" });
  assert.equal(state.decks[0].playing, false);
  assert.equal(state.decks[0].position, 8);
  await audio.request({ type: "play", deck: "A" });
  await delay(300);
  state = await audio.request({ type: "status" });
  assert.equal(state.decks[0].playing, true);
  assert.ok(state.decks[0].position < 1);
  checks.push("Natural end pauses; explicit play rebuilds and restarts ended source");
  const bad = path.join(temporary, "corrupt.wav");
  await writeFile(bad, "not audio");
  const invalid = await library.select(bad);
  await assert.rejects(
    audio.request({ type: "load", deck: "A", trackId: invalid.id, path: invalid.path, identity: invalid.identity }),
    /unsupported_or_corrupt_audio/,
  );
  state = await audio.request({ type: "status" });
  assert.equal(state.decks[0].trackId, record.id);
  assert.equal(state.decks[0].playing, true);
  assert.ok(state.decks.slice(1).every((d) => d.trackId === null && !d.playing));
  checks.push("Failed replacement retains playing source and leaves B/C/D unchanged");
  assert.equal(peaks?.length, 512);
  assert.ok(peaks.some((p) => p > 0.1));
  checks.push("Waveform peaks are computed from decoded PCM");
  audio.child.kill("SIGKILL");
  await delay(800);
  assert.equal(audio.snapshot.ready, false);
  assert.equal(audio.snapshot.decks[0].playing, false);
  assert.ok(rms(latest()) < 0.0001);
  await assert.rejects(audio.request({ type: "play", deck: "A" }), /disconnected/);
  checks.push("Engine death stops captured output, reports disconnected and never replays");
  const report = {
    checks,
    audibleRms: audible,
    mutedRms: muted,
    seekSignal,
    capturedBytes: bytes,
    nativeFrames: frames.length,
    physicalDeviceTested: false,
  };
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, "native-report.json"), JSON.stringify(report, null, 2));
    await writeFile(path.join(evidence, "native-output.s16le"), Buffer.concat(chunks));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  recorder.kill();
  await audio.stop();
  await rm(temporary, { recursive: true, force: true });
}
