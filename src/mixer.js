// Pure description of the native channel strip. Knobs are saved as 0..100 with 50 neutral; this
// module only *labels* them. The engine (native/src/dsp.rs) owns the audio, and the golden vectors
// in tests/mixer-map.test.js match its documented_knob_mapping_vectors test.
//   GAIN   -12..+12 dB, linear in dB.
//   HI/MID/LOW phase-aligned LR4 bands at 250 Hz / 2.5 kHz. Nonzero -24..+12 dB; zero full kill.
//   FILTER below 50 = low-pass 20 kHz -> 100 Hz, above 50 = high-pass 20 Hz -> 12 kHz (12 dB/oct,
//          exponential in the knob); exactly 50 = bypassed. Cutoffs are limited to 45 % of the
//          source sample rate by the engine, which only matters below 44.1 kHz.
export const MIXER_KNOBS = ['gain', 'hi', 'mid', 'low', 'filter'];
export const MIXER_VALUE_FIELDS = ['level', ...MIXER_KNOBS];
export const NEUTRAL = 50;
const clampKnob = value => Math.max(0, Math.min(100, Number.isFinite(value) ? value : NEUTRAL));
export const gainDb = value => (clampKnob(value) - NEUTRAL) / NEUTRAL * 12;
export const eqDb = value => {
  const t = (clampKnob(value) - NEUTRAL) / NEUTRAL;
  return t < 0 ? t * 24 : t * 12;
};
/** `{kind:'off'|'lpf'|'hpf', hz}`; `hz` is null when the filter is bypassed. */
export function filterSweep(value) {
  const p = (clampKnob(value) - NEUTRAL) / NEUTRAL;
  if (p < 0) return { kind: 'lpf', hz: 20000 * Math.pow(100 / 20000, -p) };
  if (p > 0) return { kind: 'hpf', hz: 20 * Math.pow(12000 / 20, p) };
  return { kind: 'off', hz: null };
}
export function dbText(db) {
  const r = Math.round(db * 10) / 10;
  return r === 0 ? '0 dB' : (r > 0 ? '+' : '−') + Math.abs(r).toFixed(1) + ' dB';
}
export function hzText(hz) {
  if (hz < 1000) return Math.round(hz) + ' Hz';
  return (hz / 1000).toFixed(hz < 10000 ? 2 : 1) + ' kHz';
}
/** Short readout: `+3.6 dB`, `−24.0 dB`, `LPF 1.41 kHz`, `HPF 490 Hz`, `OFF`. */
export function knobReadout(field, value) {
  if (field === 'gain') return dbText(gainDb(value));
  if (field === 'filter') {
    const sweep = filterSweep(value);
    return sweep.kind === 'off' ? 'OFF' : sweep.kind.toUpperCase() + ' ' + hzText(sweep.hz);
  }
  return clampKnob(value)===0 ? 'KILL' : dbText(eqDb(value));
}
/** Spoken value for `aria-valuetext`. */
export function knobValueText(field, value) {
  if (field === 'filter') {
    const sweep = filterSweep(value);
    return sweep.kind === 'off' ? 'Filter off' : (sweep.kind === 'lpf' ? 'Low-pass ' : 'High-pass ') + hzText(sweep.hz);
  }
  return knobReadout(field, value).replace('−', 'minus ').replace('+', 'plus ');
}
const NAMES = { gain: 'Gain', hi: 'High EQ', mid: 'Mid EQ', low: 'Low EQ', filter: 'Filter' };
export const knobTitle = (deck, field, value) => `Deck ${deck} ${NAMES[field] || field}: ${knobReadout(field, value)}. Double-click to reset.`;

/** Validated linear native peak to the meter's -54 .. +3 dB display. */
export function meterFraction(peak) {
  if(typeof peak!=='number'||!Number.isFinite(peak)||peak<=0)return 0;
  return Math.max(0,Math.min(1,(20*Math.log10(Math.min(peak,16))+54)/57));
}
