//! Per-deck channel strip: input gain, three-band EQ, bipolar sweep filter and the
//! channel fader / crossfader gain, applied to the device-facing PCM iterator.
//!
//! Real-time contract: after construction (on the control thread) the audio path
//! performs no allocation, locking, file access or decoding. It reads a handful of
//! relaxed atomics once per 32-frame block and runs fixed-size per-channel biquads.
//! Parameters are smoothed so a knob move never produces a step. Nothing is done on
//! the decode worker, so a control change is heard within one device buffer, not
//! after the half-second PCM ring has drained.
//!
//! Signal path: phase-aligned LR4 three-band full-kill crossover -> sweep filter -> trim/fader
//! -> native stereo peak meter -> crossfader/master headroom -> deck safety bound.
//! EQ zero removes the selected band. Neutral EQ has flat magnitude with crossover phase rotation;
//! the independent sweep filter still bypasses exactly at 50. The LR4 processor and its tests are
//! shared in fullkill.rs. Fixed filter storage and atomics preserve the no-I/O/no-lock callback contract.
use rodio::{ChannelCount, SampleRate, Source};
use crate::fullkill::{ChannelProcessor, StripShared};
use std::{
    f64::consts::PI,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

/// Knob value that means "no change". Knobs are stored as 0..=100 in the saved UI schema.
pub const NEUTRAL: f64 = 50.0;
/// Input gain: knob 0 = -12 dB, 50 = 0 dB, 100 = +12 dB, linear in dB.
pub const GAIN_RANGE_DB: f64 = 12.0;
/// EQ nominal nonzero taper: -24..+12 dB; zero is a distinct full-kill endpoint. 50 is neutral. Linear in dB
/// on each side of the detent.
pub const EQ_CUT_DB: f64 = 24.0;
pub const EQ_BOOST_DB: f64 = 12.0;
/// Low shelf corner, mid peak centre/Q and high shelf corner (RBJ cookbook, shelf slope S = 1).
/// See `high_shelf_corner` for the low-sample-rate adjustment.
pub const LOW_SHELF_HZ: f64 = 180.0;
pub const MID_PEAK_HZ: f64 = 1000.0;
pub const MID_PEAK_Q: f64 = 0.7;
pub const HIGH_SHELF_HZ: f64 = 5000.0;
/// Sweep filter: knob below 50 is a low-pass from 20 kHz (just left of centre) down to 100 Hz;
/// above 50 it is a high-pass from 20 Hz up to 12 kHz. 12 dB/octave, Q 0.8, exponential in knob.
pub const FILTER_LP_TOP_HZ: f64 = 20_000.0;
pub const FILTER_LP_BOTTOM_HZ: f64 = 100.0;
pub const FILTER_HP_BOTTOM_HZ: f64 = 20.0;
pub const FILTER_HP_TOP_HZ: f64 = 12_000.0;
pub const FILTER_Q: f64 = 0.8;
/// The filter output is cross-faded in over this knob distance from 50 so leaving the
/// detent is continuous (the near-neutral cutoffs sit above/below the audio band).
pub const FILTER_BLEND_SPAN: f64 = 0.02;
/// Parameters update on this many frames; gain is ramped linearly inside each block.
pub const BLOCK: usize = 32;
pub const MAX_CHANNELS: usize = 32;
const SMOOTHING_SECONDS: f64 = 0.008;
const FADE_IN_SECONDS: f64 = 0.002;
const KNEE: f64 = 0.9;
/// Centre/corner frequencies and cutoffs stay below this fraction of the sample rate.
const MAX_FRACTION_OF_RATE: f64 = 0.45;

pub fn gain_db(knob: f64) -> f64 {
    (knob.clamp(0.0, 100.0) - NEUTRAL) / NEUTRAL * GAIN_RANGE_DB
}
pub fn eq_db(knob: f64) -> f64 {
    let t = (knob.clamp(0.0, 100.0) - NEUTRAL) / NEUTRAL;
    if t < 0.0 { t * EQ_CUT_DB } else { t * EQ_BOOST_DB }
}
/// -1 = fully low-pass, 0 = off, +1 = fully high-pass.
pub fn filter_position(knob: f64) -> f64 {
    (knob.clamp(0.0, 100.0) - NEUTRAL) / NEUTRAL
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FilterKind {
    LowPass,
    HighPass,
}
/// Nominal (rate-independent) cutoff for a filter position. `None` at the detent.
pub fn filter_nominal(position: f64) -> Option<(FilterKind, f64)> {
    if position < 0.0 {
        let t = -position;
        Some((FilterKind::LowPass, FILTER_LP_TOP_HZ * (FILTER_LP_BOTTOM_HZ / FILTER_LP_TOP_HZ).powf(t)))
    } else if position > 0.0 {
        Some((FilterKind::HighPass, FILTER_HP_BOTTOM_HZ * (FILTER_HP_TOP_HZ / FILTER_HP_BOTTOM_HZ).powf(position)))
    } else {
        None
    }
}
/// High shelf corner: 5 kHz, lowered to a quarter of the source sample rate for rates below 20 kHz
/// so the HI band still sits in the top octaves of low-rate material (8 kHz source -> 2 kHz).
pub fn high_shelf_corner(rate: f64) -> f64 {
    HIGH_SHELF_HZ.min(0.25 * rate)
}
fn limit_hz(hz: f64, rate: f64) -> f64 {
    hz.min(MAX_FRACTION_OF_RATE * rate).max(1.0)
}

/// Normalised biquad coefficients (a0 = 1).
#[derive(Clone, Copy, Debug)]
pub struct Coef {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}
impl Coef {
    fn new(b: [f64; 3], a: [f64; 3]) -> Self {
        Coef { b0: b[0] / a[0], b1: b[1] / a[0], b2: b[2] / a[0], a1: a[1] / a[0], a2: a[2] / a[0] }
    }
    pub fn low_shelf(rate: f64, hz: f64, db: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w = 2.0 * PI * limit_hz(hz, rate) / rate;
        let (s, c) = w.sin_cos();
        let beta = 2.0 * a.sqrt() * (s / 2.0 * 2f64.sqrt());
        Self::new(
            [a * ((a + 1.0) - (a - 1.0) * c + beta), 2.0 * a * ((a - 1.0) - (a + 1.0) * c), a * ((a + 1.0) - (a - 1.0) * c - beta)],
            [(a + 1.0) + (a - 1.0) * c + beta, -2.0 * ((a - 1.0) + (a + 1.0) * c), (a + 1.0) + (a - 1.0) * c - beta],
        )
    }
    pub fn high_shelf(rate: f64, hz: f64, db: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w = 2.0 * PI * limit_hz(hz, rate) / rate;
        let (s, c) = w.sin_cos();
        let beta = 2.0 * a.sqrt() * (s / 2.0 * 2f64.sqrt());
        Self::new(
            [a * ((a + 1.0) + (a - 1.0) * c + beta), -2.0 * a * ((a - 1.0) + (a + 1.0) * c), a * ((a + 1.0) + (a - 1.0) * c - beta)],
            [(a + 1.0) - (a - 1.0) * c + beta, 2.0 * ((a - 1.0) - (a + 1.0) * c), (a + 1.0) - (a - 1.0) * c - beta],
        )
    }
    pub fn peak(rate: f64, hz: f64, db: f64, q: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w = 2.0 * PI * limit_hz(hz, rate) / rate;
        let (s, c) = w.sin_cos();
        let al = s / (2.0 * q);
        Self::new([1.0 + al * a, -2.0 * c, 1.0 - al * a], [1.0 + al / a, -2.0 * c, 1.0 - al / a])
    }
    pub fn filter(rate: f64, kind: FilterKind, hz: f64) -> Self {
        let w = 2.0 * PI * limit_hz(hz, rate) / rate;
        let (s, c) = w.sin_cos();
        let al = s / (2.0 * FILTER_Q);
        match kind {
            FilterKind::LowPass => Self::new([(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0], [1.0 + al, -2.0 * c, 1.0 - al]),
            FilterKind::HighPass => Self::new([(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0], [1.0 + al, -2.0 * c, 1.0 - al]),
        }
    }
    /// Magnitude of the transfer function at `hz` (analytic, for tests and documentation).
    pub fn magnitude(&self, hz: f64, rate: f64) -> f64 {
        let w = 2.0 * PI * hz / rate;
        let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let (nr, ni) = (self.b0 + self.b1 * c1 + self.b2 * c2, -(self.b1 * s1 + self.b2 * s2));
        let (dr, di) = (1.0 + self.a1 * c1 + self.a2 * c2, -(self.a1 * s1 + self.a2 * s2));
        ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()
    }
    /// Poles strictly inside the unit circle.
    pub fn stable(&self) -> bool {
        self.a2.abs() < 1.0 && self.a1.abs() < 1.0 + self.a2 && [self.b0, self.b1, self.b2, self.a1, self.a2].iter().all(|v| v.is_finite())
    }
}

#[derive(Clone, Copy, Default)]
struct Z {
    z1: f64,
    z2: f64,
}
impl Z {
    #[inline]
    fn run(&mut self, c: &Coef, x: f64) -> f64 {
        // Transposed direct form II; tiny residues are flushed so a long silence cannot
        // leave the state in slow denormal territory.
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        if self.z1.abs() < 1e-24 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-24 {
            self.z2 = 0.0;
        }
        y
    }
}

/// The five knob positions plus the (already linear) fader gain, shared lock-free between
/// the control thread (writer) and the audio callback (reader). One per deck; it outlives
/// every loaded source so settings persist across load, seek and natural-end restart.
pub struct DeckControls {
    knobs: [AtomicU64; 5],
    fader: AtomicU64,
    snap: AtomicBool,
    eq_shared: Arc<StripShared>,
    output: AtomicU64,
    peaks: [AtomicU64;2],
    meter_reset: AtomicBool,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Knob {
    Gain = 0,
    Hi = 1,
    Mid = 2,
    Low = 3,
    Filter = 4,
}
impl DeckControls {
    pub fn new(fader: f64) -> Arc<Self> {
        Arc::new(DeckControls {
            knobs: std::array::from_fn(|_| AtomicU64::new(NEUTRAL.to_bits())),
            fader: AtomicU64::new(fader.to_bits()),
            snap: AtomicBool::new(false),
            eq_shared: Arc::new(StripShared::default()),
            output: AtomicU64::new(1.0f64.to_bits()),
            peaks: std::array::from_fn(|_| AtomicU64::new(0)),
            meter_reset: AtomicBool::new(false),
        })
    }
    pub fn set(&self, knob: Knob, value: f64) {
        self.knobs[knob as usize].store(value.clamp(0.0, 100.0).to_bits(), Ordering::Relaxed);
        let band = |k| { let v = self.get(k); if v == 0.0 { 0.0 } else { 10f64.powf(eq_db(v)/20.0) as f32 } };
        self.eq_shared.set_targets(1.0,band(Knob::Low),band(Knob::Mid),band(Knob::Hi),1.0,1.0);
    }
    pub fn get(&self, knob: Knob) -> f64 {
        f64::from_bits(self.knobs[knob as usize].load(Ordering::Relaxed))
    }
    pub fn set_fader(&self, gain: f64) {
        self.fader.store(gain.max(0.0).to_bits(), Ordering::Relaxed);
    }
    pub fn fader(&self) -> f64 {
        f64::from_bits(self.fader.load(Ordering::Relaxed))
    }
    /// A paused source is not polled, so smoothing cannot progress. The control thread asks
    /// for the next block to adopt the targets immediately; resuming then has no glide.
    pub fn set_output(&self, gain:f64) { self.output.store(gain.max(0.0).to_bits(), Ordering::Relaxed); }
    pub fn output(&self)->f64 { f64::from_bits(self.output.load(Ordering::Relaxed)) }
    pub fn meter(&self)->(f64,f64) { (f64::from_bits(self.peaks[0].load(Ordering::Relaxed)),f64::from_bits(self.peaks[1].load(Ordering::Relaxed))) }
    pub fn reset_meter(&self) {
        for p in &self.peaks { p.store(0,Ordering::Relaxed); }
        self.meter_reset.store(true,Ordering::Relaxed);
    }
    pub fn request_snap(&self) {
        self.reset_meter();
        self.snap.store(true, Ordering::Relaxed);
    }
}

pub struct Dsp {
    eq: ChannelProcessor,
    output: f64,
    output_alpha: f64,
    meter_peak: [f64;2],
    meter_envelope: [f64;2],
    meter_frames: usize,
    meter_release: f64,
    controls: Arc<DeckControls>,
    rate: f64,
    channels: usize,
    alpha: f64,
    block_left: usize,
    // smoothed state
    filter_pos: f64,
    filter_coef: Coef,
    filter_kind: FilterKind,
    filter_active: bool,
    filter_blend: f64,
    gain: f64,
    gain_end: f64,
    gain_step: f64,
    fade_frames: usize,
    fade_pos: usize,
    state: [[Z; 4]; MAX_CHANNELS],
}
impl Dsp {
    /// Constructed on the control thread with inline per-channel state (no state allocation to free
    /// on the device thread). Targets are adopted immediately, so a freshly loaded or
    /// sought source starts with the deck's current settings and never glides from defaults.
    pub fn new(controls: Arc<DeckControls>, rate: u32, channels: u16) -> Self {
        let rate_f = rate as f64;
        controls.reset_meter();
        let mut dsp = Dsp {
            eq: ChannelProcessor::new(channels,rate,controls.eq_shared.clone()),
            output: controls.output(),
            output_alpha: 1.0 - (-1.0 / (rate_f * 0.005)).exp(),
            meter_peak:[0.0;2],meter_envelope:[0.0;2],meter_frames:0,
            meter_release:(-256.0 / (rate_f * 0.3)).exp(),
            controls,
            rate: rate_f,
            channels: (channels as usize).clamp(1, MAX_CHANNELS),
            alpha: 1.0 - (-(BLOCK as f64) / (rate_f * SMOOTHING_SECONDS)).exp(),
            block_left: 0,
            filter_pos: 0.0,
            filter_coef: Coef { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 },
            filter_kind: FilterKind::LowPass,
            filter_active: false,
            filter_blend: 0.0,
            gain: 0.0,
            gain_end: 0.0,
            gain_step: 0.0,
            fade_frames: ((rate_f * FADE_IN_SECONDS) as usize).max(1),
            fade_pos: 0,
            state: [[Z::default(); 4]; MAX_CHANNELS],
        };
        dsp.adopt(true);
        dsp
    }
    /// Test hook: no start-of-stream fade.
    pub fn without_fade(mut self) -> Self {
        self.fade_pos = self.fade_frames;
        self
    }
    fn targets(&self) -> (f64, f64) {
        let c = &self.controls;
        (
            filter_position(c.get(Knob::Filter)),
            c.fader() * 10f64.powf(gain_db(c.get(Knob::Gain)) / 20.0),
        )
    }
    fn approach(cur: f64, target: f64, alpha: f64, eps: f64) -> f64 {
        let next = cur + (target - cur) * alpha;
        if (target - next).abs() <= eps { target } else { next }
    }
    fn set_filter(&mut self, position: f64) {
        self.filter_pos = position;
        let Some((kind, hz)) = filter_nominal(position) else {
            self.filter_active = false;
            for z in &mut self.state {
                z[3] = Z::default();
            }
            return;
        };
        if !self.filter_active || kind != self.filter_kind {
            for z in &mut self.state {
                z[3] = Z::default();
            }
        }
        self.filter_active = true;
        self.filter_kind = kind;
        self.filter_coef = Coef::filter(self.rate, kind, hz);
        self.filter_blend = (position.abs() / FILTER_BLEND_SPAN).min(1.0);
    }
    /// Adopt (`snap`) or approach the current control targets; recomputes coefficients only
    /// for parameters that actually moved.
    fn adopt(&mut self, snap: bool) {
        let (filter, gain) = self.targets();
        let next = if snap { filter } else { Self::approach(self.filter_pos, filter, self.alpha, 1e-4) };
        if snap || next != self.filter_pos {
            self.set_filter(next);
        }
        let start = self.gain_end;
        if snap {
            self.gain = gain;
            self.gain_end = gain;
            self.gain_step = 0.0;
        } else {
            self.gain = start;
            self.gain_end = Self::approach(start, gain, self.alpha, 1e-7);
            self.gain_step = (self.gain_end - start) / BLOCK as f64;
        }
    }
    /// Call once per frame, before `process` of channel 0.
    #[inline]
    pub fn begin_frame(&mut self) {
        self.output += (self.controls.output()-self.output)*self.output_alpha;
        if (self.controls.output()-self.output).abs()<1e-7 { self.output=self.controls.output(); }
        if self.controls.meter_reset.swap(false,Ordering::Relaxed) {
            self.meter_peak=[0.0;2]; self.meter_envelope=[0.0;2];self.meter_frames=0;
        }
        if self.block_left == 0 {
            let snap = self.controls.snap.swap(false, Ordering::Relaxed);
            if snap { self.eq.snap_targets(); self.output=self.controls.output(); }
            self.adopt(snap);
            self.block_left = BLOCK;
        } else {
            self.gain += self.gain_step;
        }
        self.block_left -= 1;
    }
    #[inline]
    pub fn process(&mut self, channel: usize, sample: f32) -> f32 {
        let mut v = self.eq.process(sample) as f64;
        let state = &mut self.state[channel];
        if self.filter_active {
            let filtered = state[3].run(&self.filter_coef, v);
            v += self.filter_blend * (filtered - v);
        }
        v *= self.gain;
        if channel == 0 && self.fade_pos < self.fade_frames {
            self.fade_pos += 1;
        }
        if self.fade_pos < self.fade_frames {
            v *= self.fade_pos as f64 / self.fade_frames as f64;
        }
        if channel < 2 { self.meter_peak[channel]=self.meter_peak[channel].max(v.abs()); }
        if channel+1==self.channels {
            if self.channels==1 { self.meter_peak[1]=self.meter_peak[0]; }
            self.meter_frames+=1;
            if self.meter_frames>=256 {
                self.meter_frames=0;
                for ch in 0..2 {
                    self.meter_envelope[ch]=self.meter_peak[ch].max(self.meter_envelope[ch]*self.meter_release);
                    if self.meter_envelope[ch]<1e-6 {self.meter_envelope[ch]=0.0;}
                    self.controls.peaks[ch].store(self.meter_envelope[ch].min(16.0).to_bits(),Ordering::Relaxed);
                }
                self.meter_peak=[0.0;2];
            }
        }
        let out = bound(v*self.output);
        if out.is_finite() {
            out as f32
        } else {
            for z in &mut self.state {
                *z = [Z::default(); 4];
            }
            0.0
        }
    }
    pub fn channels(&self) -> usize {
        self.channels
    }
    /// Process an interleaved buffer in place (offline tests and tools).
    pub fn process_interleaved(&mut self, buffer: &mut [f32]) {
        let channels = self.channels;
        for (i, sample) in buffer.iter_mut().enumerate() {
            let channel = i % channels;
            if channel == 0 {
                self.begin_frame();
            }
            *sample = self.process(channel, *sample);
        }
    }
}
/// Transparent below 0.9 full scale; above that a smooth tanh knee that never exceeds 1.0.
/// This is a per-deck safety bound, not a loudness limiter.
pub fn bound(v: f64) -> f64 {
    let a = v.abs();
    if a <= KNEE { v } else { v.signum() * (KNEE + (1.0 - KNEE) * ((a - KNEE) / (1.0 - KNEE)).tanh()) }
}

/// Wraps the device-facing source; adds the strip without touching the stream's queue,
/// position accounting or off-callback retirement.
pub struct Strip<S: Source<Item = f32>> {
    inner: S,
    dsp: Dsp,
    channel: usize,
    channels: usize,
}
impl<S: Source<Item = f32>> Strip<S> {
    pub fn new(inner: S, controls: Arc<DeckControls>) -> Self {
        let dsp = Dsp::new(controls, inner.sample_rate().get(), inner.channels().get());
        let channels = dsp.channels();
        Strip { inner, dsp, channel: 0, channels }
    }
}
impl<S: Source<Item = f32>> Iterator for Strip<S> {
    type Item = f32;
    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;
        if self.channel == 0 {
            self.dsp.begin_frame();
        }
        let out = self.dsp.process(self.channel, sample);
        self.channel += 1;
        if self.channel == self.channels {
            self.channel = 0;
        }
        Some(out)
    }
}
impl<S: Source<Item = f32>> Source for Strip<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATES: [u32; 8] = [8000, 11025, 22050, 44100, 48000, 96000, 192000, 384000];

    fn controls(fader: f64, knobs: [(Knob, f64); 5]) -> Arc<DeckControls> {
        let c = DeckControls::new(fader);
        for (k, v) in knobs {
            c.set(k, v);
        }
        c
    }
    fn neutral() -> [(Knob, f64); 5] {
        [(Knob::Gain, 50.0), (Knob::Hi, 50.0), (Knob::Mid, 50.0), (Knob::Low, 50.0), (Knob::Filter, 50.0)]
    }
    fn with(knob: Knob, value: f64) -> Arc<DeckControls> {
        let mut k = neutral();
        k[knob as usize].1 = value;
        controls(1.0, k)
    }
    /// Steady-state amplitude of a sine through a mono strip, in dB relative to the input.
    fn measure(c: &Arc<DeckControls>, rate: u32, hz: f64) -> f64 {
        let amp = 0.02f64;
        let mut dsp = Dsp::new(c.clone(), rate, 1).without_fade();
        let settle = (rate as f64 * 0.3) as usize;
        let window = ((rate as f64 * 0.25) as usize).max(1);
        let (mut s, mut co) = (0.0, 0.0);
        for n in 0..settle + window {
            let phase = 2.0 * PI * hz * n as f64 / rate as f64;
            let mut one = [(amp * phase.sin()) as f32];
            dsp.process_interleaved(&mut one);
            if n >= settle {
                s += one[0] as f64 * phase.sin();
                co += one[0] as f64 * phase.cos();
            }
        }
        let magnitude = 2.0 * s.hypot(co) / window as f64;
        20.0 * (magnitude / amp).log10()
    }
    fn assert_near(actual: f64, expected: f64, tolerance: f64, what: &str) {
        assert!((actual - expected).abs() <= tolerance, "{what}: {actual:.3} dB, expected {expected:.3} ± {tolerance}");
    }

    #[test]
    fn documented_knob_mapping_vectors() {
        // The same vectors are asserted in tests/mixer-map.test.js for the UI labels.
        let gain: [(f64, f64); 5] = [(0.0, -12.0), (25.0, -6.0), (50.0, 0.0), (75.0, 6.0), (100.0, 12.0)];
        for (knob, db) in gain {
            assert!((gain_db(knob) - db).abs() < 1e-12);
        }
        let eq: [(f64, f64); 6] = [(0.0, -24.0), (25.0, -12.0), (50.0, 0.0), (75.0, 6.0), (100.0, 12.0), (49.0, -0.48)];
        for (knob, db) in eq {
            assert!((eq_db(knob) - db).abs() < 1e-12, "{knob}");
        }
        assert_eq!(filter_nominal(filter_position(50.0)), None);
        let hz = |knob: f64| filter_nominal(filter_position(knob)).unwrap();
        assert_eq!(hz(0.0).0, FilterKind::LowPass);
        assert!((hz(0.0).1 - 100.0).abs() < 1e-9);
        assert!((hz(25.0).1 - 1414.2135623730951).abs() < 1e-6);
        assert!((hz(49.0).1 - 17990.0).abs() < 5.0);
        assert_eq!(hz(75.0).0, FilterKind::HighPass);
        assert!((hz(75.0).1 - 489.89794855663564).abs() < 1e-6);
        assert!((hz(100.0).1 - 12000.0).abs() < 1e-9);
        assert!((hz(51.0).1 - 22.7).abs() < 0.1);
        // Out-of-range knobs are clamped, never extrapolated.
        assert_eq!(gain_db(500.0), 12.0);
        assert_eq!(eq_db(-9.0), -24.0);
    }

    #[test]
    fn filter_designs_are_stable_and_match_analytic_response_at_every_rate() {
        for rate in RATES {
            let r = rate as f64;
            for db in [-24.0, -12.0, -0.5, 0.5, 6.0, 12.0] {
                for c in [Coef::low_shelf(r, LOW_SHELF_HZ, db), Coef::peak(r, MID_PEAK_HZ, db, MID_PEAK_Q), Coef::high_shelf(r, high_shelf_corner(r), db)] {
                    assert!(c.stable(), "rate {rate} {db} dB");
                }
            }
            for knob in 0..=100 {
                if let Some((kind, hz)) = filter_nominal(filter_position(knob as f64)) {
                    assert!(Coef::filter(r, kind, hz).stable(), "rate {rate} knob {knob}");
                }
            }
            // Shelf asymptotes: low shelf at 40 Hz, high shelf near the top of the usable band.
            let low = Coef::low_shelf(r, LOW_SHELF_HZ, -24.0);
            assert_near(20.0 * low.magnitude(20.0, r).log10(), -24.0, 0.5, "low shelf at 20 Hz");
            let top = (0.4 * r).min(16_000.0);
            let high = Coef::high_shelf(r, high_shelf_corner(r), 12.0);
            let lift = 20.0 * high.magnitude(top, r).log10();
            assert!(lift > 6.0, "rate {rate}: high shelf lift {lift} at {top}");
        }
    }

    #[test]
    fn gain_is_exact_in_db() {
        for rate in [8000, 48000, 384000] {
            for (knob, db) in [(0.0, -12.0), (25.0, -6.0), (75.0, 6.0), (100.0, 12.0)] {
                let c = with(Knob::Gain, knob);
                for hz in [60.0, 1000.0, 3000.0] {
                    assert_near(measure(&c, rate, hz), db, 0.02, &format!("gain {knob} at {hz} Hz / {rate}"));
                }
            }
        }
    }

    #[test]
    fn each_eq_band_moves_only_its_own_region() {
        for rate in [44100, 48000, 96000, 384000] {
            // (knob, reference tone Hz of its own band, tones in the other bands)
            let cases = [(Knob::Low, 50.0, [3000.0, 12000.0]), (Knob::Mid, 1000.0, [50.0, 12000.0]), (Knob::Hi, 16000.0, [50.0, 1000.0])];
            for (knob, own, others) in cases {
                for (value, db) in [(0.0, -24.0), (25.0, -12.0), (100.0, 12.0)] {
                    let c = with(knob, value);
                    if value==0.0 { assert!(measure(&c,rate,own)< -30.0); } else { assert_near(measure(&c, rate, own), db, 1.0, &format!("{knob:?} {value} own band, rate {rate}")); }
                    for other in others {
                        let leak = measure(&c, rate, other).abs();
                        assert!(leak <= 3.0, "{knob:?} {value} leaks {leak:.2} dB into {other} Hz at {rate}");
                    }
                }
            }
        }
    }

    #[test]
    fn low_pass_and_high_pass_sweeps_attenuate_the_right_side() {
        for rate in [44100, 48000, 192000] {
            let lp = with(Knob::Filter, 25.0); // 1.41 kHz
            assert_near(measure(&lp, rate, 100.0), 0.0, 1.0, "LPF passband");
            assert_near(measure(&lp, rate, 1414.2), -2.0, 1.0, "LPF near cutoff");
            assert!(measure(&lp, rate, 10_000.0) < -30.0, "LPF stopband");
            let lp_full = with(Knob::Filter, 0.0); // 100 Hz
            assert!(measure(&lp_full, rate, 1000.0) < -35.0);
            let hp = with(Knob::Filter, 75.0); // 490 Hz
            assert_near(measure(&hp, rate, 8000.0), 0.0, 1.0, "HPF passband");
            assert_near(measure(&hp, rate, 489.9), -2.0, 1.0, "HPF near cutoff");
            assert!(measure(&hp, rate, 60.0) < -30.0, "HPF stopband");
            let hp_full = with(Knob::Filter, 100.0); // 12 kHz
            assert!(measure(&hp_full, rate, 1000.0) < -40.0);
        }
    }

    #[test]
    fn neutral_crossover_is_flat_in_magnitude_at_all_source_rates() {
        for rate in RATES {
            for hz in [50.0,250.0,1000.0,(rate as f64*0.35).min(16000.0)] {
                assert_near(measure(&controls(0.195,neutral()),rate,hz),20.0*0.195f64.log10(),0.05,"flat phase-aligned crossover");
            }
        }
    }
    #[test]
    fn full_kill_and_pre_crossfader_meters_use_the_actual_strip() {
        let c=controls(0.7,neutral());
        c.set_output(0.0);
        let mut dsp=Dsp::new(c.clone(),48000,2).without_fade();
        let mut tone:Vec<f32>=(0..96000).map(|i| (0.2*(2.0*PI*1000.0*(i/2) as f64/48000.0).sin()) as f32).collect();
        dsp.process_interleaved(&mut tone);
        assert!(tone.iter().all(|x| *x==0.0));
        assert!(c.meter().0>0.1 && c.meter().1>0.1,"meter remains live before crossfader");
        c.set_output(0.25);
        for k in [Knob::Low,Knob::Mid,Knob::Hi] {c.set(k,0.0);}
        let mut signal=vec![0.1f32;48000];
        dsp.process_interleaved(&mut signal);
        assert!(signal[24000..].iter().all(|x| *x==0.0),"all kills settle to digital silence");
        c.reset_meter(); assert_eq!(c.meter(),(0.0,0.0));
    }

    #[test]
    fn channels_are_independent_and_do_not_crosstalk() {
        let rate = 48000u32;
        let c = with(Knob::Hi, 0.0);
        let mut dsp = Dsp::new(c, rate, 2).without_fade();
        // Left: 12 kHz (heavily cut), right: silence, then swap.
        let mut buffer = Vec::new();
        for n in 0..rate as usize {
            buffer.push((0.02 * (2.0 * PI * 12000.0 * n as f64 / rate as f64).sin()) as f32);
            buffer.push(0.0);
        }
        dsp.process_interleaved(&mut buffer);
        assert!(buffer.iter().skip(1).step_by(2).all(|v| *v == 0.0), "right channel must stay silent");
        let peak_left = buffer.iter().step_by(2).skip(24000).fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak_left < 0.02 * 0.1, "left 12 kHz is cut by ~24 dB, got {peak_left}");
        // Channel 1 alone carries a tone below the shelf: unchanged amplitude at unity gain.
        let mut dsp = Dsp::new(with(Knob::Hi, 0.0), rate, 2).without_fade();
        let mut buffer = Vec::new();
        for n in 0..rate as usize {
            buffer.push(0.0);
            buffer.push((0.02 * (2.0 * PI * 200.0 * n as f64 / rate as f64).sin()) as f32);
        }
        dsp.process_interleaved(&mut buffer);
        assert!(buffer.iter().step_by(2).all(|v| *v == 0.0));
        let peak_right = buffer.iter().skip(1).step_by(2).skip(24000).fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak_right - 0.02).abs() < 0.0015, "{peak_right}");
    }

    #[test]
    fn decks_are_isolated_and_settings_survive_reload_seek_and_restart() {
        let deck_a = with(Knob::Low, 0.0);
        let deck_b = controls(1.0, neutral());
        assert!(measure(&deck_a, 48000, 50.0)< -40.0,"A is killed");
        assert_near(measure(&deck_b, 48000, 50.0), 0.0, 0.01, "B untouched by A");
        // A new source for the same deck (load, seek or restart) adopts the stored targets at its
        // very first block: no glide from defaults.
        let rate = 48000;
        let mut first = Dsp::new(deck_a.clone(), rate, 1).without_fade();
        let mut second = Dsp::new(deck_a.clone(), rate, 1).without_fade();
        let mut a: Vec<f32> = (0..4800).map(|n| (0.02 * (2.0 * PI * 50.0 * n as f64 / rate as f64).sin()) as f32).collect();
        let mut b = a.clone();
        first.process_interleaved(&mut a);
        second.process_interleaved(&mut b);
        assert_eq!(a, b, "a re-created strip must sound identical to the continuing one");
        let early_peak = b[..480].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(early_peak < 0.02 * 0.2 + 0.001, "first 10 ms already carry the -24 dB cut, got {early_peak}");
    }

    #[test]
    fn knob_changes_are_smoothed_without_overshoot_or_steps() {
        let rate = 48000;
        let c = controls(1.0, neutral());
        let mut dsp = Dsp::new(c.clone(), rate, 1).without_fade();
        let mut dc = vec![0.1f32; 2400];
        dsp.process_interleaved(&mut dc);
        c.set(Knob::Gain, 100.0); // +12 dB: 0.1 -> 0.398
        let mut ramp = vec![0.1f32; 48000];
        dsp.process_interleaved(&mut ramp);
        let target = 0.1 * 10f32.powf(0.6);
        assert!(ramp.windows(2).all(|w| w[1] >= w[0] - 1e-7), "monotonic, no overshoot");
        assert!(ramp.iter().all(|v| *v <= target + 1e-6));
        assert!((ramp[ramp.len() - 1] - target).abs() < 1e-5, "reaches the target and snaps to it");
        let biggest_step = ramp.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(biggest_step < 0.002, "no zipper step: {biggest_step}");
        let reach = ramp.iter().position(|v| (*v - target).abs() < target * 0.01).unwrap();
        assert!((200..2400).contains(&reach), "settles in about 5–50 ms, took {reach} samples");
        // Fader to zero ends in exact silence.
        c.set_fader(0.0);
        let mut mute = vec![0.1f32; 48000];
        dsp.process_interleaved(&mut mute);
        assert_eq!(*mute.last().unwrap(), 0.0);
        // EQ move on a tone: no sample-to-sample jump beyond the tone's own slew plus the gain change.
        let mut dsp = Dsp::new(controls(1.0, neutral()), rate, 1).without_fade();
        let c = dsp.controls.clone();
        let mut buffer: Vec<f32> = (0..96000).map(|n| (0.2 * (2.0 * PI * 100.0 * n as f64 / rate as f64).sin()) as f32).collect();
        let (head, tail) = buffer.split_at_mut(48000);
        dsp.process_interleaved(head);
        c.set(Knob::Low, 100.0);
        dsp.process_interleaved(tail);
        let slew = 0.2 * 2.0 * PI * 100.0 / rate as f64 * 4.0;
        let worst = buffer.windows(2).map(|w| (w[1] - w[0]).abs() as f64).fold(0.0, f64::max);
        assert!(worst < slew * 1.2, "worst step {worst} vs allowed {slew}");
    }

    #[test]
    fn paused_updates_snap_so_resuming_has_no_glide() {
        let rate = 48000;
        let c = controls(1.0, neutral());
        let mut dsp = Dsp::new(c.clone(), rate, 1).without_fade();
        let mut warm = vec![0.1f32; 960];
        dsp.process_interleaved(&mut warm);
        c.set(Knob::Gain, 100.0);
        c.request_snap();
        let mut next = vec![0.1f32; 8];
        dsp.process_interleaved(&mut next);
        assert!((next[0] - 0.1 * 10f32.powf(0.6)).abs() < 1e-5, "first sample after resume is already at target");
    }

    #[test]
    fn start_of_stream_fade_prevents_a_click() {
        let mut dsp = Dsp::new(controls(0.5, neutral()), 48000, 2);
        let mut buffer = vec![1.0f32; 48000];
        dsp.process_interleaved(&mut buffer);
        assert!(buffer[0] < 0.01 && buffer[1] < 0.01, "first frame near zero");
        assert!(buffer.windows(2).map(|w|(w[1]-w[0]).abs()).fold(0.0f32,f32::max)<0.02,"bounded start transition");
        assert!((buffer[47999] - 0.5).abs() < 1e-6, "full settled DC level");
    }

    #[test]
    fn extreme_settings_at_extreme_rates_stay_finite_and_bounded() {
        for rate in [8000u32, 384000] {
            for channels in [1u16, 2, 32] {
                for corner in 0..(1 << 3) {
                    let hi_lo = |bit: u32| if corner & (1 << bit) != 0 { 100.0 } else { 0.0 };
                    let c = controls(
                        1.0,
                        [(Knob::Gain, hi_lo(0)), (Knob::Hi, hi_lo(1)), (Knob::Mid, hi_lo(2)), (Knob::Low, hi_lo(0)), (Knob::Filter, hi_lo(1))],
                    );
                    let mut dsp = Dsp::new(c.clone(), rate, channels);
                    let frames = (rate / 4) as usize;
                    let mut seed = 0xdead_beef_u64 ^ corner as u64;
                    let mut buffer: Vec<f32> = (0..frames * channels as usize)
                        .map(|_| {
                            seed ^= seed << 13;
                            seed ^= seed >> 7;
                            seed ^= seed << 17;
                            (((seed >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0) as f32
                        })
                        .collect();
                    // Sweep every knob mid-stream, including across the detent.
                    let half = buffer.len() / 2 / channels as usize * channels as usize;
                    let (a, b) = buffer.split_at_mut(half);
                    dsp.process_interleaved(a);
                    for (i, k) in [Knob::Gain, Knob::Hi, Knob::Mid, Knob::Low, Knob::Filter].into_iter().enumerate() {
                        c.set(k, if (corner >> (i % 3)) & 1 == 0 { 100.0 } else { 0.0 });
                    }
                    dsp.process_interleaved(b);
                    assert!(buffer.iter().all(|v| v.is_finite() && v.abs() <= 1.0), "rate {rate} ch {channels} corner {corner}");
                }
            }
        }
        // Non-finite input never escapes.
        let mut dsp = Dsp::new(with(Knob::Filter, 20.0), 48000, 2);
        let mut buffer = vec![f32::NAN, f32::INFINITY, -f32::INFINITY, 0.5, 0.25, f32::NAN];
        dsp.process_interleaved(&mut buffer);
        assert!(buffer.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn deck_bound_is_transparent_below_the_knee_and_never_reaches_full_scale() {
        for v in [-0.9, -0.5, 0.0, 0.3, 0.9] {
            assert_eq!(bound(v), v);
        }
        for v in [0.91, 1.0, 2.0, 10.0, 1e9] {
            let y = bound(v);
            assert!(y > 0.9 && y <= 1.0 && y >= bound(v - 0.01).min(1.0) - 1e-12);
            assert_eq!(bound(-v), -y);
        }
        assert!(bound(100.0) <= 1.0);
    }

    struct Fixed {
        data: Vec<f32>,
        at: usize,
        channels: u16,
    }
    impl Iterator for Fixed {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            let v = self.data.get(self.at).copied();
            self.at += 1;
            v
        }
    }
    impl Source for Fixed {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> ChannelCount {
            ChannelCount::new(self.channels).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            SampleRate::new(48000).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }
    #[test]
    fn strip_wraps_a_source_keeping_channel_alignment_and_end_of_stream() {
        let c = controls(0.5, neutral());
        let data: Vec<f32> = (0..30000).map(|i| if i % 3 == 0 { 0.4 } else if i % 3 == 1 { -0.2 } else { 0.1 }).collect();
        let strip = Strip::new(Fixed { data: data.clone(), at: 0, channels: 3 }, c);
        assert_eq!(strip.channels().get(), 3);
        assert_eq!(strip.sample_rate().get(), 48000);
        let out: Vec<f32> = strip.collect();
        assert_eq!(out.len(), data.len(), "ends exactly when the inner source ends");
        for (i, (x, y)) in data.iter().zip(&out).enumerate().skip(24000) {
            assert!((y - x * 0.5).abs() < 1e-7, "sample {i} keeps its own channel");
        }
    }
}
