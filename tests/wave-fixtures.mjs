// Generated, synthetic waveform data only. No music, file paths or private metadata.
// The shape mimics native analysis output: 512 persisted peaks plus a transient detail
// envelope of 8-bit peak/RMS bins (see docs/NATIVE-DESKTOP.md).
export const FIXTURE_DURATION = 240;
export const FIXTURE_BINS = Math.min(32768, Math.max(512, Math.ceil(FIXTURE_DURATION * 64)));
export const FIXTURE_IDS = {
  dynamic: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  brickwall: 'local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
// Known events inside the dynamic fixture, used to check placement, silence and transients.
export const GAP = { start: 100.0, end: 100.4 };
export const SPIKE = 103.0;
const hash = i => { let x = (i * 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
export function detailFixture(kind) {
  const bins = FIXTURE_BINS, peak = new Uint8Array(bins), rms = new Uint8Array(bins);
  for (let i = 0; i < bins; i++) {
    const t = (i + 0.5) / bins * FIXTURE_DURATION, phase = (t % 0.5) / 0.5, kick = Math.exp(-phase * 6);
    let p, r;
    if (kind === 'brickwall') {
      p = 0.985 + 0.015 * hash(i);
      r = t < 8 ? 0.12 : 0.28 + 0.3 * kick;
    } else {
      const intro = t < 20 ? 0.35 : 1;
      p = (0.16 + 0.78 * kick * (0.6 + 0.4 * Math.sin(t / 5) ** 2)) * intro;
      r = p * (0.35 + 0.15 * hash(i + 7));
      if (t >= GAP.start && t < GAP.end) { p = 0; r = 0; }
      else if (Math.abs(t - SPIKE) < 0.4) { p = 0.2; r = 0.1; }
      if (Math.floor(t * bins / FIXTURE_DURATION) === Math.floor(SPIKE * bins / FIXTURE_DURATION)) { p = 1; r = 0.22; }
    }
    peak[i] = Math.round(Math.min(1, p) * 255);
    rms[i] = Math.min(peak[i], Math.round(Math.min(1, r) * 255));
  }
  return { bins, peak, rms };
}
// The persisted 512 peaks are the maximum of each detail interval, like the native engine's own bins.
export function legacyPeaks(detail) {
  return Array.from({ length: 512 }, (_, k) => {
    let m = 0;
    for (let i = Math.floor(k * detail.bins / 512); i < Math.floor((k + 1) * detail.bins / 512); i++) m = Math.max(m, detail.peak[i]);
    return m / 255;
  });
}
export const encodeDetail = d => ({ bins: d.bins, peak: Buffer.from(d.peak).toString('base64'), rms: Buffer.from(d.rms).toString('base64') });
