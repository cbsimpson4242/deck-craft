// Pure, bounded track analysis for the browser backend. This ports the native
// constant-grid onset estimator; it runs on decoded PCM already in memory and
// never touches the network. Nothing here is a downbeat or key classifier.

const ENVELOPE_HZ_TARGET = 200;
const ANALYSIS_SECONDS = 60;
export const WAVEFORM_BINS = 512;

/** Constant-grid estimate from a rectified-energy envelope. Returns null when unreliable. */
export function detectBeatGrid(envelope, hz) {
  if (!(hz > 0) || envelope.length < Math.floor(hz * 6)) return null;
  let max = 0, min = Infinity;
  for (const value of envelope) { if (value > max) max = value; if (value < min) min = value; }
  if (max < 1e-5 || max - min < max * 0.12) return null;
  const onset = new Float64Array(envelope.length);
  let previous = 0, energy = 0, total = 0;
  for (let i = 0; i < envelope.length; i++) {
    const rise = Math.max(envelope[i] - previous, 0);
    onset[i] = rise; previous = envelope[i]; energy += rise * rise; total += rise;
  }
  if (energy < 1e-7) return null;
  const lo = Math.floor(hz * 60 / 200), hi = Math.floor(hz * 60 / 60);
  if (lo < 1 || hi >= onset.length) return null;
  const correlation = lag => {
    let sum = 0;
    for (let i = lag; i < onset.length; i++) sum += onset[i] * onset[i - lag];
    return sum / energy;
  };
  let bestLag = 0, bestValue = 0;
  for (let lag = lo; lag <= hi; lag++) {
    const c = correlation(lag);
    if (c > bestValue) { bestLag = lag; bestValue = c; }
  }
  if (bestValue < 0.32) return null;
  for (let lag = lo; lag < bestLag; lag++) {
    const c = correlation(lag);
    if (c > bestValue * 0.94) { bestLag = lag; bestValue = c; break; }
  }
  const lag = bestLag, a = correlation(lag - 1), b = correlation(lag), c = correlation(lag + 1);
  const denominator = a - 2 * b + c;
  const delta = Math.max(-0.5, Math.min(0.5, Math.abs(denominator) > 1e-12 ? 0.5 * (a - c) / denominator : 0));
  const period = (lag + delta) / hz;
  const phases = new Float64Array(lag);
  for (let i = 0; i < onset.length; i++) {
    const p = Math.round(((i / hz) % period) / period * lag) % lag;
    phases[p] += onset[i];
  }
  let phase = 0;
  for (let i = 0; i < lag; i++) if (phases[i] >= phases[phase]) phase = i;
  const offset = phase / lag * period;
  let aligned = 0;
  for (let i = 0; i < onset.length; i++) {
    const p = (((i / hz - offset) % period) + period) % period;
    if (Math.min(p, period - p) < 0.04) aligned += onset[i];
  }
  if (aligned / Math.max(total, 1e-12) < 0.45) return null;
  const bpm = 60 / period;
  if (!(bpm >= 60 && bpm <= 200)) return null;
  return { bpm: Math.round(bpm * 100) / 100, offset, confidence: Math.min(b, 1) };
}

/** Mean rectified amplitude per ~5 ms bin over at most the first minute (same shape as the native inspector). */
export function onsetEnvelope(channels, sampleRate, maxSeconds = ANALYSIS_SECONDS) {
  const frames = Math.min(channels[0]?.length || 0, Math.floor(maxSeconds * sampleRate));
  const bin = Math.max(1, Math.floor(sampleRate / ENVELOPE_HZ_TARGET));
  const envelope = new Float64Array(Math.floor(frames / bin));
  let sawSignal = false;
  for (let b = 0; b < envelope.length; b++) {
    let sum = 0;
    for (let i = b * bin; i < (b + 1) * bin; i++) {
      let energy = 0;
      for (const channel of channels) energy += Math.abs(channel[i]);
      sum += energy / channels.length;
    }
    if (sum > 0) sawSignal = true;
    envelope[b] = sum / bin;
  }
  return { envelope, hz: sampleRate / bin, sawSignal };
}

/** 512 absolute-peak bins across the whole track, clamped to 0..1. */
export function waveformPeaks(channels, bins = WAVEFORM_BINS) {
  const frames = channels[0]?.length || 0;
  const peaks = new Array(bins).fill(0);
  if (!frames) return peaks;
  for (const channel of channels) {
    for (let i = 0; i < frames; i++) {
      const bucket = Math.min(bins - 1, Math.floor(i / frames * bins));
      const value = Math.abs(channel[i]);
      if (Number.isFinite(value) && value > peaks[bucket]) peaks[bucket] = Math.min(value, 1);
    }
  }
  return peaks;
}

/** Everything derived from decoded PCM: waveform peaks and the (possibly absent) beat grid. */
export function analyzeChannels(channels, sampleRate) {
  const { envelope, hz } = onsetEnvelope(channels, sampleRate);
  return { peaks: waveformPeaks(channels), beatGrid: detectBeatGrid(envelope, hz) };
}
