import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const runProgram = promisify(execFile);
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AudioClient } from "../desktop/audio-client.cjs";
import { LocalLibrary, publicWaveDetail } from "../desktop/library.cjs";
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
/** Equal-amplitude 60 Hz, 1 kHz and 10 kHz: one tone per EQ region, so one capture shows a whole frequency response. */
function triTone(seconds = 60) {
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
    let sum = 0;
    for (const hz of [60, 1000, 10000]) sum += 0.2 * Math.sin((2 * Math.PI * hz * i) / rate);
    const value = Math.round(sum * 32767);
    b.writeInt16LE(value, 44 + i * 4);
    b.writeInt16LE(value, 46 + i * 4);
  }
  return b;
}
/** Mono 16-bit WAV at any supported rate with equal-amplitude tones (strip checks off the 48 kHz device rate). */
function toneWav(rate, freqs, seconds = 20) {
  const frames = rate * seconds,
    b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const hz of freqs) sum += 0.2 * Math.sin((2 * Math.PI * hz * i) / rate);
    b.writeInt16LE(Math.round(sum * 32767), 44 + i * 2);
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
let recordId;
const frames = [];
audio.on("state", (s) =>
  frames.push({
    at: performance.now(),
    seq: s.seq,
    ready: s.ready,
    decks: s.decks.map((d) => ({ id: d.id, trackId: d.trackId, position: d.position, playing: d.playing })),
  }),
);
let peaks, detail;
const waves = new Map();
audio.on("waveform", (w) => {
  waves.set(w.trackId, w);
  if (w.trackId === recordId) {
    peaks = w.peaks;
    detail = w.detail;
  }
});
// 6 s stereo at 48 kHz: 0-2 s digital silence, 2-4 s loud 440 Hz tone, 4-6 s quiet tone, and one
// full-scale single-frame click at 5.0 s that a smoothed envelope would lose.
function shaped() {
  const rate = 48000,
    frames = rate * 6,
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
    const amplitude = i < rate * 2 ? 0 : i < rate * 4 ? 16000 : 1600;
    let value = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * amplitude);
    if (i === rate * 5 + 10) value = 32767;
    b.writeInt16LE(value, 44 + i * 4);
    b.writeInt16LE(value, 46 + i * 4);
  }
  return b;
}
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
  recordId = record.id;
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
    assert.ok(sought.decks[0].loadGeneration > decoded.decks[0].loadGeneration, "seek prepares a new stream");
    assert.equal(sought.decks[0].waveGeneration, decoded.decks[0].waveGeneration, "seek retains waveform source ownership");
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
  const cadenceStart = performance.now();
  await delay(550);
  const playingTicks = frames.filter((f) => f.at >= cadenceStart && f.decks[0].playing);
  const tickHz = (playingTicks.length - 1) * 1000 / (playingTicks.at(-1).at - playingTicks[0].at);
  assert.ok(playingTicks.length >= 15 && tickHz > 35 && tickHz < 85, 'native playback receipts remain bounded near 60 Hz: ' + tickHz);
  assert.ok(playingTicks.at(-1).decks[0].position > playingTicks[0].decks[0].position, 'the higher cadence carries advancing consumed-frame positions');
  checks.push('Measured native playing cadence: ' + tickHz.toFixed(1) + ' Hz from consumed-frame receipts');
  for (const position of [1.125, 5.375, 2.625, 5.123]) {
    const sought = await audio.request({ type: 'seek', deck: 'A', position });
    assert.equal(sought.decks[0].playing, true, 'scrub seek preserves playing state');
    assert.ok(Math.abs(sought.decks[0].position - position) < 0.025, 'acknowledged seek lands accurately: ' + position);
    assert.equal(sought.decks[0].trackId, record.id);
    assert.ok(sought.decks.slice(1).every((deck) => !deck.trackId && !deck.playing));
  }
  await delay(450);
  const scrubSignal = { hz440: tone(latest(), 440), hz880: tone(latest(), 880) };
  assert.ok(scrubSignal.hz880 > scrubSignal.hz440 * 5 && scrubSignal.hz880 > 0.002, JSON.stringify(scrubSignal));
  checks.push('Sequential fractional playing seeks land within 25 ms, preserve playback and other decks, and end in captured 880 Hz PCM');

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
  // Fine envelope from the same decode: 8 s at 64 bins/s clamps up to 512 bins; the fixture is a
  // constant-level sine (6000/32768 peak, about 0.13 RMS) with no silence.
  assert.ok(publicWaveDetail(detail), "native detail passes the desktop validator");
  const fine = { peak: Buffer.from(detail.peak, "base64"), rms: Buffer.from(detail.rms, "base64") };
  assert.equal(detail.bins, 512);
  const body = [...fine.peak.subarray(8, 504)];
  assert.ok(body.every((v) => v >= 44 && v <= 49), "peak bins match the generated sine level");
  assert.ok([...fine.rms.subarray(8, 504)].every((v) => v >= 31 && v <= 36), "RMS bins match the generated sine level");
  checks.push("Fine peak/RMS detail is measured from the decoded PCM and validated");
  // Silence, loud, quiet and a one-frame transient through the real decoder, pipe and validator, on
  // another deck while deck A keeps playing.
  const shapedFile = path.join(temporary, "Generated shaped fixture.wav");
  await writeFile(shapedFile, shaped());
  const shapedRecord = await library.select(shapedFile);
  await audio.request({ type: "load", deck: "C", trackId: shapedRecord.id, path: shapedRecord.path, identity: shapedRecord.identity });
  const arrival = Date.now() + 15000;
  while (!waves.has(shapedRecord.id) && Date.now() < arrival) await delay(50);
  const shapedWave = waves.get(shapedRecord.id);
  assert.ok(shapedWave, "shaped fixture waveform must arrive from the native engine");
  assert.ok(publicWaveDetail(shapedWave.detail));
  assert.equal(shapedWave.detail.bins, 512);
  const sp = [...Buffer.from(shapedWave.detail.peak, "base64")],
    sr = [...Buffer.from(shapedWave.detail.rms, "base64")];
  const bin = (seconds) => Math.floor((seconds / 6) * 512);
  assert.ok(sp.slice(0, bin(2) - 1).every((v) => v === 0) && sr.slice(0, bin(2) - 1).every((v) => v === 0), "digital silence is exactly zero");
  assert.ok(sp.slice(bin(2) + 2, bin(4) - 1).every((v) => v >= 122 && v <= 126), "loud region peak " + sp.slice(bin(2) + 2, bin(4) - 1));
  assert.ok(sr.slice(bin(2) + 2, bin(4) - 1).every((v) => v >= 84 && v <= 92), "loud region RMS");
  assert.ok(sp.slice(bin(4) + 2, bin(5) - 3).every((v) => v >= 11 && v <= 14), "quiet region peak");
  assert.ok(sp.slice(bin(5) + 3, 511).every((v) => v >= 11 && v <= 14), "quiet region peak after the click");
  const click = bin(5 + 10 / 48000);
  assert.equal(sp[click], 255, "single-frame click keeps full-scale peak in exactly its bin");
  assert.ok(sr[click] >= 10 && sr[click] <= 20 && sp[click - 2] <= 14 && sp[click + 2] <= 14, "click does not smear into its neighbours");
  assert.equal(shapedWave.peaks.length, 512);
  assert.ok(shapedWave.peaks.slice(0, bin(2) - 1).every((p) => p === 0), "persisted peaks agree about silence");
  checks.push("Silence, loud/quiet regions and a one-frame transient are measured through the real decoder and pipe");
  // ---- Channel strip: per-deck gain, three-band EQ and bipolar filter, measured in the captured PCM ----
  const strip = {};
  const db = (value, reference) => 20 * Math.log10(Math.max(value, 1e-9) / reference);
  await audio.request({ type: "pause", deck: "A" });
  const triFile = path.join(temporary, "Generated tri-tone fixture.wav");
  await writeFile(triFile, triTone());
  const tri = await library.select(triFile);
  for (const deck of ["C", "D"]) {
    state = await audio.request({ type: "load", deck, trackId: tri.id, path: tri.path, identity: tri.identity });
  }
  // A capture window is only meaningful if the engine did not starve (shared worker load can cause underruns,
  // which output silence and would corrupt a level measurement). Such windows are retried and counted, never ignored.
  strip.starvedWindowsRetried = 0;
  const underruns = async () => (await audio.request({ type: "status" })).decks.reduce((n, d) => n + d.underrunSamples, 0);
  // The recorder process can also lag under load, so "the last quarter second" may still be pre-change audio. A
  // measurement is accepted only after two consecutive windows, with at least 0.3 s of new captured audio between
  // them, agree on every tone to within 0.2 % (a 2e-6 absolute floor covers the 16-bit capture quantization at deeply filtered bins). Source underruns are checked over the entire wait/capture window.
  strip.unsettledWindows = 0;
  const converge = async (freqs) => {
    let previous = null;
    const trials = [];
    for (let attempt = 0; attempt < 16; attempt++) {
      const before = await underruns();
      await delay(attempt ? 350 : 750);
      const b = latest(),
        seen = bytes;
      const values = freqs.map((hz) => tone(b, hz));
      const after = await underruns();
      trials.push({ attempt, before, after, capturedBytes: seen, values });
      if (after !== before) {
        strip.starvedWindowsRetried++;
        previous = null;
        continue;
      }
      if (previous && seen - previous.seen >= 57600 && values.every((v, i) => Math.abs(v - previous.values[i]) <= 0.002 * Math.max(v, previous.values[i], 0.001))) return { values, rms: rms(b) };
      if (previous) strip.unsettledWindows++;
      previous = { values, seen };
    }
    throw Error("capture did not settle: " + JSON.stringify({ freqs, trials }));
  };
  const settle = async () => {
    const { values, rms: level } = await converge([60, 1000, 10000]);
    return { low: values[0], mid: values[1], high: values[2], rms: level };
  };
  const deckState = (id) => audio.snapshot.decks.find((d) => d.id === id);
  const KNOBS = ["gain", "hi", "mid", "low", "filter"];
  const setKnobs = async (deck, values) => {
    for (const [type, value] of Object.entries(values)) await audio.request({ type, deck, value });
  };
  const neutralKnobs = { gain: 50, hi: 50, mid: 50, low: 50, filter: 50 };
  await audio.request({ type: "level", deck: "C", value: 78 });
  await audio.request({ type: "play", deck: "C" });
  const base = await (async () => {
    await delay(500);
    return settle();
  })();
  // Channel level 78 % with 0.25 master headroom, 0.2 per tone, projection of a sine gives amplitude / 2.
  const expectedTone = (0.2 * 0.25 * 0.78) / 2;
  for (const key of ["low", "mid", "high"]) assert.ok(Math.abs(base[key] / expectedTone - 1) < 0.03, `neutral ${key} tone ${base[key]} vs ${expectedTone}`);
  for (const id of ["A", "B", "C", "D"]) for (const k of KNOBS) assert.equal(deckState(id)[k], 50, `${id} ${k} starts neutral`);
  strip.neutralBaseline = { ...base, expectedTone };
  checks.push("Neutral strip: deck C tri-tone reaches the capture at exactly the unprocessed channel level, flat in all three regions");
  const response = async (label, values, deck = "C") => {
    await setKnobs(deck, { ...neutralKnobs, ...values });
    for (const [k, v] of Object.entries({ ...neutralKnobs, ...values })) assert.equal(deckState(deck)[k], v, `${deck} snapshot ${k}`);
    const m = await settle();
    const r = { low: db(m.low, base.low), mid: db(m.mid, base.mid), high: db(m.high, base.high) };
    strip[label] = r;
    return r;
  };
  const near = (value, expected, tolerance, what) => assert.ok(Math.abs(value - expected) <= tolerance, `${what}: ${value.toFixed(2)} dB, expected ${expected} ± ${tolerance}`);
  for (const [knob, expected] of [[100, 12], [75, 6], [25, -6], [0, -12]]) {
    const r = await response(`gain ${knob}`, { gain: knob });
    for (const key of ["low", "mid", "high"]) near(r[key], expected, 0.1, `gain ${knob} ${key}`);
  }
  checks.push("Gain: +12, +6, -6 and -12 dB change all three captured tones by the expected ratio (3.98x … 0.25x)");
  let r = await response("hi 0", { hi: 0 });
  assert.ok(r.high < -18 && Math.abs(r.low) < 1 && Math.abs(r.mid) < 1, JSON.stringify(r));
  r = await response("hi 100", { hi: 100 });
  assert.ok(r.high > 8 && r.high < 13 && Math.abs(r.low) < 1 && Math.abs(r.mid) < 1, JSON.stringify(r));
  r = await response("mid 0", { mid: 0 });
  assert.ok(r.mid < -28 && r.low > -1.5 && r.high > -2.5, JSON.stringify(r));
  r = await response("mid 100", { mid: 100 });
  assert.ok(r.mid > 11 && r.mid < 13 && Math.abs(r.low) < 1.5 && Math.abs(r.high) < 2.5, JSON.stringify(r));
  r = await response("low 0", { low: 0 });
  assert.ok(r.low < -40 && Math.abs(r.mid) < 1 && Math.abs(r.high) < 1, JSON.stringify(r));
  r = await response("low 100", { low: 100 });
  assert.ok(r.low > 10 && r.low < 13 && Math.abs(r.mid) < 1 && Math.abs(r.high) < 1, JSON.stringify(r));
  checks.push("EQ: HI, MID and LOW each cut/boost only their own captured tone (full kill / +12 dB) and leave the others within the documented overlap");
  r = await response("filter 25 (LPF 1.41 kHz)", { filter: 25 });
  assert.ok(Math.abs(r.low) < 1 && r.mid > -3 && r.high < -28, JSON.stringify(r));
  r = await response("filter 0 (LPF 100 Hz)", { filter: 0 });
  assert.ok(r.low > -3 && r.mid < -30 && r.high < -38, JSON.stringify(r));
  r = await response("filter 75 (HPF 490 Hz)", { filter: 75 });
  assert.ok(r.low < -30 && Math.abs(r.mid) < 1.6 && Math.abs(r.high) < 1, JSON.stringify(r));
  r = await response("filter 100 (HPF 12 kHz)", { filter: 100 });
  assert.ok(r.low < -38 && r.mid < -38 && r.high < -2 && r.high > -10, JSON.stringify(r));
  checks.push("Filter: left of centre low-passes and right of centre high-passes the captured signal; extremes remove the opposite regions");
  r = await response("everything off-centre", { gain: 80, hi: 20, mid: 80, low: 20, filter: 30 });
  r = await response("returned to neutral", {});
  for (const key of ["low", "mid", "high"]) near(r[key], 0, 0.15, `neutral restored ${key}`);
  checks.push("Returning every knob to 50 restores the unprocessed captured level exactly (within 0.15 dB)");
  // Settings belong to the deck: paused edits, seek, reload and natural-end restart keep them.
  await audio.request({ type: "pause", deck: "C" });
  await delay(300);
  await setKnobs("C", { hi: 0, filter: 25 });
  assert.equal(deckState("C").playing, false);
  assert.equal(deckState("C").hi, 0);
  await audio.request({ type: "play", deck: "C" });
  await delay(400);
  let m = await settle();
  assert.ok(db(m.high, base.high) < -28 && Math.abs(db(m.low, base.low)) < 1.5, "edit made while paused applies on resume");
  state = await audio.request({ type: "seek", deck: "C", position: 20 });
  await delay(400);
  m = await settle();
  assert.ok(Math.abs(deckState("C").position - 20) < 3 && db(m.high, base.high) < -28, "seek keeps the strip");
  state = await audio.request({ type: "load", deck: "C", trackId: tri.id, path: tri.path, identity: tri.identity });
  assert.equal(state.decks[2].hi, 0, "reload keeps deck settings");
  assert.equal(state.decks[2].filter, 25);
  await audio.request({ type: "play", deck: "C" });
  await delay(400);
  m = await settle();
  assert.ok(db(m.high, base.high) < -28, "reloaded source is processed from its first audible block");
  await audio.request({ type: "seek", deck: "C", position: 59.7 });
  await delay(1500);
  assert.equal(deckState("C").playing, false, "natural end pauses");
  await audio.request({ type: "play", deck: "C" });
  await delay(400);
  m = await settle();
  assert.ok(deckState("C").playing && db(m.high, base.high) < -28, "natural-end restart keeps the strip");
  strip.persistence = { pausedEdit: true, seek: true, reload: true, endRestart: true };
  checks.push("Strip settings persist across paused edits, seek, reload and natural-end restart");
  // Per-deck isolation: D is untouched while C is processed; an unloaded deck keeps its settings until a source loads.
  await audio.request({ type: "pause", deck: "C" });
  await audio.request({ type: "play", deck: "D" });
  await delay(400);
  m = await settle();
  for (const [key, ref] of [["low", base.low], ["mid", base.mid], ["high", base.high]]) near(db(m[key], ref), 0, 0.2, `deck D unaffected by C ${key}`);
  assert.equal(deckState("D").hi, 50);
  assert.equal(deckState("C").hi, 0);
  await audio.request({ type: "level", deck: "D", value: 39 });
  m = await settle();
  near(db(m.mid, base.mid), -6.02, 0.3, "channel level halves D");
  await audio.request({ type: "level", deck: "D", value: 78 });
  await audio.request({ type: "pause", deck: "D" });
  await setKnobs("B", { filter: 25, low: 0 });
  assert.equal(deckState("B").trackId, null);
  assert.equal(deckState("B").filter, 25);
  await audio.request({ type: "load", deck: "B", trackId: tri.id, path: tri.path, identity: tri.identity });
  assert.equal(deckState("B").low, 0, "settings applied to an empty deck survive its first load");
  await audio.request({ type: "crossfader", value: 100 });
  await audio.request({ type: "play", deck: "B" });
  await delay(400);
  m = await settle();
  assert.ok(db(m.low, base.low) < -21 && db(m.high, base.high) < -28 && Math.abs(db(m.mid, base.mid)) < 3, "deck B plays with its own pre-load strip");
  await audio.request({ type: "pause", deck: "B" });
  await audio.request({ type: "crossfader", value: 50 });
  strip.isolation = { deckD: "neutral while C processed", deckB: "settings kept before first load" };
  checks.push("Per-deck isolation: C, D and B (set before load) are processed independently; channel level scales the shaped signal");
  // The same strip at other source rates and a mono layout: 192 kHz and 8 kHz files, resampled to the device afterwards.
  await audio.request({ type: "pause", deck: "B" });
  await audio.request({ type: "crossfader", value: 0 });
  strip.rates = {};
  for (const [rate, freqs, limits] of [
    [192000, [60, 1000, 10000], { hiCut: -18, filterCut: -28, leak: 1 }],
    // At 8 kHz the HI corner moves down to 2 kHz, so its transition reaches a little into 1 kHz.
    [8000, [60, 1000, 3000], { hiCut: -15, filterCut: -10, leak: 2.5 }],
  ]) {
    const file = path.join(temporary, `Generated ${rate} Hz tones.wav`);
    await writeFile(file, toneWav(rate, freqs));
    const sel = await library.select(file);
    state = await audio.request({ type: "load", deck: "A", trackId: sel.id, path: sel.path, identity: sel.identity });
    assert.equal(state.decks[0].sampleRate, rate);
    assert.equal(state.decks[0].channels, 1);
    await setKnobs("A", neutralKnobs);
    await audio.request({ type: "play", deck: "A" });
    await delay(500);
    const sample = async () => (await converge(freqs)).values;
    const ref = await sample();
    assert.ok(ref.every((v) => v > 0.005), `${rate} Hz source is audible: ${ref}`);
    const rel = async (values) => {
      await setKnobs("A", { ...neutralKnobs, ...values });
      return (await sample()).map((v, i) => db(v, ref[i]));
    };
    const table = { gain100: await rel({ gain: 100 }), hi0: await rel({ hi: 0 }), low0: await rel({ low: 0 }), filter25: await rel({ filter: 25 }), neutral: await rel({}) };
    for (const v of table.gain100) near(v, 12, 0.2, `${rate} Hz source gain +12`);
    assert.ok(table.hi0[2] < limits.hiCut && Math.abs(table.hi0[0]) < 1 && Math.abs(table.hi0[1]) < limits.leak, `${rate} hi cut ${table.hi0}`);
    assert.ok(table.low0[0] < -21 && Math.abs(table.low0[1]) < 1, `${rate} low cut ${table.low0}`);
    assert.ok(table.filter25[2] < limits.filterCut && Math.abs(table.filter25[0]) < 1, `${rate} LPF ${table.filter25}`);
    for (const v of table.neutral) near(v, 0, 0.15, `${rate} Hz source neutral restored`);
    strip.rates[rate] = table;
    await audio.request({ type: "pause", deck: "A" });
  }
  await audio.request({ type: "crossfader", value: 50 });
  checks.push("Strip also shapes 192 kHz and 8 kHz mono sources (gain, HI, LOW, LPF, neutral restore) in the captured output");
  // Neutral stays identical when everything is returned, then a stopped engine produces no strip output.
  await setKnobs("C", neutralKnobs);
  await setKnobs("B", neutralKnobs);
  strip.note = "captured through the isolated deckcraft_test null sink only";
  for(const deck of ["A","B","C","D"])await audio.request({type:"pause",deck});
  await audio.request({ type: "pause", deck: "A" });
  for (const id of ["A", "B", "C", "D"]) {
    const idx = ["A","B","C","D"].indexOf(id);
    await audio.request({type:"load",deck:id,trackId:record.id,path:record.path,identity:record.identity});
    for(const type of ["gain","hi","mid","low","filter"])await audio.request({type,deck:id,value:50});
    await audio.request({type:"level",deck:id,value:78});
    await audio.request({type:"assign",deck:id,side:"left"});
    await audio.request({type:"crossfader",value:0});
    await audio.request({type:"play",deck:id});
    await delay(650);
    let snap = await audio.request({type:"status"});
    const baseline = rms(latest());
    assert.ok(baseline > .005, id+" assigned left has captured audio: "+baseline);
    assert.ok(snap.decks[idx].meter.l > .05, id+" native meter reads actual signal");
    for (const band of ["hi","mid","low"]) await audio.request({type:band,deck:id,value:0});
    await delay(750);
    assert.ok(rms(latest()) < .0001, id+" all band kills produce captured silence");
    snap = await audio.request({type:"status"});
    assert.ok(snap.decks[idx].meter.l < .03, id+" meter follows EQ kill");
    for (const band of ["hi","mid","low"]) await audio.request({type:band,deck:id,value:50});
    await audio.request({type:"assign",deck:id,side:"right"});
    await delay(700);
    assert.ok(rms(latest()) < .0001, id+" right assignment mutes at left endpoint");
    snap = await audio.request({type:"status"});
    assert.ok(snap.decks[idx].meter.l > .05, id+" pre-crossfader meter stays live while faded out");
    await audio.request({type:"crossfader",value:100});
    await delay(650);
    assert.ok(rms(latest()) > .005, id+" right assignment audible at right endpoint");
    await audio.request({type:"pause",deck:id});
    snap=await audio.request({type:"status"});
    assert.deepEqual(snap.decks[idx].meter,{l:0,r:0},id+" paused meter silent");
    checks.push("Captured "+id+": full-kill silence, restored signal, both routing endpoints, pre-crossfader and paused meters");
  }
  await audio.request({type:"play",deck:"A"});
  await delay(500);
  assert.ok(rms(latest())>.003,"engine death is tested with actual captured audio playing");
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
    strip,
    capturedBytes: bytes,
    nativeFrames: frames.length,
    playingReceiptHz: tickHz,
    scrubSignal,
    physicalDeviceTested: false,
  };
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, "native-report.json"), JSON.stringify(report, null, 2));
    await writeFile(path.join(evidence, "native-output.s16le"), Buffer.concat(chunks));
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, "native-failure-output.s16le"), Buffer.concat(chunks));
    await writeFile(path.join(evidence, "native-failure.json"), JSON.stringify({ error: error.message, checks, frames }, null, 2));
  }
  throw error;
} finally {
  recorder.kill();
  await audio.stop();
  await rm(temporary, { recursive: true, force: true });
}
