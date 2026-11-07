//! Per-channel mixer strip, applied inside the device-facing PCM iterator.
//!
//! Signal path of one channel (source channel layout, before rodio converts to the output):
//!
//! ```text
//! decoded PCM -> gain trim -> 3-band split (full kill) -> channel fader -> PEAK METER
//!             -> crossfader side gain x master headroom -> rodio mixer sum
//! ```
//!
//! The meter therefore reads the signal after trim, EQ and the channel fader, and before the
//! crossfader. Everything on the per-sample path is fixed-size arithmetic over atomics: no heap
//! allocation, lock or blocking call. All memory (including the filter state of up to 32
//! channels) is part of the strip value created on the control thread.
//!
//! Band split. Two 4th-order Linkwitz-Riley crossovers (24 dB/octave, -6 dB at the corner) at
//! [`LOW_CROSSOVER_HZ`] and [`HIGH_CROSSOVER_HZ`]:
//!
//! ```text
//! low  = AP2( LP1(x) )     mid = LP2( HP1(x) )     high = HP2( HP1(x) )
//! ```
//!
//! `AP2` is `LP2 + HP2` of the second crossover, which for an LR4 pair is an exact all-pass, so
//! the low band stays phase-aligned with mid/high. With all three band gains at unity the sum is
//! `AP2(AP1(x))`: a flat magnitude response (phase rotation only). Each band gain is applied to
//! its band output, so a band gain of exactly `0.0` removes that band *exactly*; with all three
//! at zero the channel is digital silence. This is a crossover EQ, not a brick-wall filter:
//! signal near a corner frequency is shared by two bands and is only partly removed by killing
//! one of them (a kill leaves the neighbour's -6 dB skirt there).

use rodio::{ChannelCount, SampleRate, Source};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};

pub const LOW_CROSSOVER_HZ: f64 = 250.0;
pub const HIGH_CROSSOVER_HZ: f64 = 2500.0;
/// Conservative master headroom for four summed channels (unchanged since the first mixer).
pub const MASTER_HEADROOM: f32 = 0.25;
/// Maximum interleaved channels a strip can hold; matches the decoder admission limit.
pub const MAX_STRIP_CHANNELS: usize = 32;
/// Meters never report above this linear peak (about +24 dBFS), whatever the boosts.
pub const METER_CEILING: f32 = 16.0;
/// Time constant of live gain changes. Targets move on the control thread; the audio side
/// converges exponentially and then snaps (below -100 dB) so a zero target is exactly zero.
const SMOOTH_SECONDS: f64 = 0.005;
const SNAP: f64 = 1.0e-5;
const METER_BLOCK_FRAMES: u32 = 256;
const METER_RELEASE_SECONDS: f64 = 0.3;
const DENORMAL_FLOOR: f64 = 1.0e-24;

/// Knob position 0..=100 -> linear gain. Exactly 0 at 0 (kill); a squared taper up to unity at
/// 50 (the neutral detent) and +6 dB at 100.
pub fn knob_to_gain(percent: f64) -> f32 {
    if !percent.is_finite() || percent <= 0.0 {
        0.0
    } else if percent <= 50.0 {
        let x = percent / 50.0;
        (x * x) as f32
    } else {
        10f64.powf((percent.min(100.0) - 50.0) / 50.0 * 6.0 / 20.0) as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Thru,
    Right,
}
impl Side {
    pub fn parse(text: &str) -> Result<Side, &'static str> {
        match text {
            "left" => Ok(Side::Left),
            "thru" => Ok(Side::Thru),
            "right" => Ok(Side::Right),
            _ => Err("invalid_assignment"),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Left => "left",
            Side::Thru => "thru",
            Side::Right => "right",
        }
    }
}

/// Equal-power crossfader curve for position 0..=100 -> (left, right) gains.
pub fn crossfader_gains(position: f64) -> (f64, f64) {
    let angle = position.clamp(0.0, 100.0) / 100.0 * std::f64::consts::FRAC_PI_2;
    (angle.cos(), angle.sin())
}
/// What the crossfader does to a channel with this assignment, times master headroom.
pub fn side_gain(side: Side, position: f64) -> f32 {
    let (left, right) = crossfader_gains(position);
    let fade = match side {
        Side::Left => left,
        Side::Right => right,
        Side::Thru => 1.0,
    };
    // cos(pi/2) is not exactly zero in floating point; the far end of the fader is silent.
    let fade = if fade < 1.0e-9 { 0.0 } else { fade };
    MASTER_HEADROOM * fade as f32
}

/// Control-thread -> audio-thread parameters and audio-thread -> control-thread meters.
/// One per deck; it outlives the sources that are loaded and replaced on that deck.
pub struct StripShared {
    gain: AtomicU32,
    low: AtomicU32,
    mid: AtomicU32,
    high: AtomicU32,
    level: AtomicU32,
    side: AtomicU32,
    peak_left: AtomicU32,
    peak_right: AtomicU32,
    meter_reset: AtomicBool,
}
fn load(cell: &AtomicU32) -> f32 {
    f32::from_bits(cell.load(Ordering::Relaxed))
}
fn store(cell: &AtomicU32, value: f32) {
    cell.store(value.to_bits(), Ordering::Relaxed);
}
impl Default for StripShared {
    fn default() -> Self {
        let one = 1.0f32.to_bits();
        Self {
            gain: AtomicU32::new(one),
            low: AtomicU32::new(one),
            mid: AtomicU32::new(one),
            high: AtomicU32::new(one),
            level: AtomicU32::new(one),
            side: AtomicU32::new(one),
            peak_left: AtomicU32::new(0),
            peak_right: AtomicU32::new(0),
            meter_reset: AtomicBool::new(false),
        }
    }
}
impl StripShared {
    /// Linear gains. Non-finite or negative requests are ignored as zero.
    pub fn set_targets(&self, gain: f32, low: f32, mid: f32, high: f32, level: f32, side: f32) {
        let clean = |v: f32| if v.is_finite() && v > 0.0 { v } else { 0.0 };
        store(&self.gain, clean(gain));
        store(&self.low, clean(low));
        store(&self.mid, clean(mid));
        store(&self.high, clean(high));
        store(&self.level, clean(level));
        store(&self.side, clean(side));
    }
    /// Linear peak after trim, EQ and the channel fader, before the crossfader: (left, right).
    pub fn meter(&self) -> (f32, f32) {
        let clean = |v: f32| if v.is_finite() { v.clamp(0.0, METER_CEILING) } else { 0.0 };
        (clean(load(&self.peak_left)), clean(load(&self.peak_right)))
    }
    /// Forget held peaks: used on pause, play, seek and load so a resumed channel never shows
    /// the level it had before it stopped.
    pub fn reset_meter(&self) {
        store(&self.peak_left, 0.0);
        store(&self.peak_right, 0.0);
        self.meter_reset.store(true, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy)]
struct Coeffs {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}
impl Coeffs {
    /// Second-order Butterworth section (Q = 1/sqrt 2); two in series form one LR4 filter.
    fn section(corner: f64, rate: f64, high_pass: bool) -> Coeffs {
        let corner = corner.min(rate * 0.4);
        let k = (std::f64::consts::PI * corner / rate).tan();
        let q = std::f64::consts::FRAC_1_SQRT_2;
        let norm = 1.0 / (1.0 + k / q + k * k);
        let (b0, b1) = if high_pass {
            (norm, -2.0 * norm)
        } else {
            (k * k * norm, 2.0 * k * k * norm)
        };
        Coeffs {
            b0,
            b1,
            b2: b0,
            a1: 2.0 * (k * k - 1.0) * norm,
            a2: (1.0 - k / q + k * k) * norm,
        }
    }
}
#[derive(Clone, Copy, Default)]
struct Section {
    z1: f64,
    z2: f64,
}
#[inline]
fn biquad(c: &Coeffs, s: &mut Section, x: f64) -> f64 {
    let y = c.b0 * x + s.z1;
    s.z1 = c.b1 * x - c.a1 * y + s.z2;
    s.z2 = c.b2 * x - c.a2 * y;
    if s.z1.abs() < DENORMAL_FLOOR {
        s.z1 = 0.0;
    }
    if s.z2.abs() < DENORMAL_FLOOR {
        s.z2 = 0.0;
    }
    y
}
#[inline]
fn lr4(c: &Coeffs, s: &mut [Section; 2], x: f64) -> f64 {
    let y = biquad(c, &mut s[0], x);
    biquad(c, &mut s[1], y)
}
struct Crossovers {
    lp1: Coeffs,
    hp1: Coeffs,
    lp2: Coeffs,
    hp2: Coeffs,
}
#[derive(Clone, Copy, Default)]
struct ChannelFilters {
    lp1: [Section; 2],
    hp1: [Section; 2],
    lp2_low: [Section; 2],
    hp2_low: [Section; 2],
    lp2_high: [Section; 2],
    hp2_high: [Section; 2],
}
impl ChannelFilters {
    #[inline]
    fn split(&mut self, c: &Crossovers, x: f64) -> (f64, f64, f64) {
        let below = lr4(&c.lp1, &mut self.lp1, x);
        let above = lr4(&c.hp1, &mut self.hp1, x);
        // Phase-align the low band with the second crossover: LP2 + HP2 is an all-pass.
        let low = lr4(&c.lp2, &mut self.lp2_low, below) + lr4(&c.hp2, &mut self.hp2_low, below);
        let mid = lr4(&c.lp2, &mut self.lp2_high, above);
        let high = lr4(&c.hp2, &mut self.hp2_high, above);
        (low, mid, high)
    }
}
struct Smoothed(f64);
impl Smoothed {
    #[inline]
    fn follow(&mut self, target: f64, alpha: f64) -> f64 {
        let delta = target - self.0;
        if delta.abs() <= SNAP {
            self.0 = target;
        } else {
            self.0 += delta * alpha;
        }
        self.0
    }
}

/// The strip's sample processor. Feed interleaved samples in order; it tracks the channel.
pub struct ChannelProcessor {
    channels: usize,
    column: usize,
    crossovers: Crossovers,
    filters: [ChannelFilters; MAX_STRIP_CHANNELS],
    alpha: f64,
    gain: Smoothed,
    low: Smoothed,
    mid: Smoothed,
    high: Smoothed,
    level: Smoothed,
    side: Smoothed,
    // Current frame's smoothed values, held across the channels of the frame.
    frame: [f64; 6],
    block_peak: [f32; 2],
    envelope: [f32; 2],
    block_frames: u32,
    release: f32,
    shared: Arc<StripShared>,
}
impl ChannelProcessor {
    pub fn new(channels: u16, sample_rate: u32, shared: Arc<StripShared>) -> Self {
        let rate = sample_rate as f64;
        let start = |cell: &AtomicU32| Smoothed(load(cell) as f64);
        let processor = Self {
            channels: (channels as usize).clamp(1, MAX_STRIP_CHANNELS),
            column: 0,
            crossovers: Crossovers {
                lp1: Coeffs::section(LOW_CROSSOVER_HZ, rate, false),
                hp1: Coeffs::section(LOW_CROSSOVER_HZ, rate, true),
                lp2: Coeffs::section(HIGH_CROSSOVER_HZ, rate, false),
                hp2: Coeffs::section(HIGH_CROSSOVER_HZ, rate, true),
            },
            filters: [ChannelFilters::default(); MAX_STRIP_CHANNELS],
            alpha: 1.0 - (-1.0 / (SMOOTH_SECONDS * rate)).exp(),
            gain: start(&shared.gain),
            low: start(&shared.low),
            mid: start(&shared.mid),
            high: start(&shared.high),
            level: start(&shared.level),
            side: start(&shared.side),
            frame: [0.0; 6],
            block_peak: [0.0; 2],
            envelope: [0.0; 2],
            block_frames: 0,
            release: (-(METER_BLOCK_FRAMES as f64) / (METER_RELEASE_SECONDS * rate)).exp() as f32,
            shared,
        };
        // A freshly built strip (load, seek, restart) starts with a silent meter.
        processor.shared.reset_meter();
        processor
    }
    #[inline]
    fn start_frame(&mut self) {
        let s = &*self.shared;
        let a = self.alpha;
        self.frame = [
            self.gain.follow(load(&s.gain) as f64, a),
            self.low.follow(load(&s.low) as f64, a),
            self.mid.follow(load(&s.mid) as f64, a),
            self.high.follow(load(&s.high) as f64, a),
            self.level.follow(load(&s.level) as f64, a),
            self.side.follow(load(&s.side) as f64, a),
        ];
        if s.meter_reset.load(Ordering::Relaxed) && s.meter_reset.swap(false, Ordering::Relaxed) {
            self.block_peak = [0.0; 2];
            self.envelope = [0.0; 2];
            self.block_frames = 0;
        }
    }
    #[inline]
    fn end_frame(&mut self) {
        if self.channels == 1 {
            self.block_peak[1] = self.block_peak[0];
        }
        self.block_frames += 1;
        if self.block_frames >= METER_BLOCK_FRAMES {
            self.block_frames = 0;
            for c in 0..2 {
                let held = self.envelope[c] * self.release;
                let next = self.block_peak[c].max(if held < 1.0e-6 { 0.0 } else { held });
                self.envelope[c] = next;
                self.block_peak[c] = 0.0;
            }
            store(&self.shared.peak_left, self.envelope[0].min(METER_CEILING));
            store(&self.shared.peak_right, self.envelope[1].min(METER_CEILING));
        }
    }
    /// Process the next interleaved sample.
    #[inline]
    pub fn process(&mut self, sample: f32) -> f32 {
        if self.column == 0 {
            self.start_frame();
        }
        let column = self.column;
        let input = if sample.is_finite() { sample as f64 } else { 0.0 };
        let [gain, low, mid, high, level, side] = self.frame;
        let (b_low, b_mid, b_high) = self.filters[column].split(&self.crossovers, input * gain);
        let channel = ((b_low * low + b_mid * mid + b_high * high) * level) as f32;
        if column < 2 {
            self.block_peak[column] = self.block_peak[column].max(channel.abs());
        }
        let out = channel * side as f32;
        self.column += 1;
        if self.column == self.channels {
            self.column = 0;
            self.end_frame();
        }
        if out.is_finite() { out } else { 0.0 }
    }
}

/// A rodio source wrapped by the mixer strip.
pub struct ChannelStrip<S: Source<Item = f32>> {
    inner: S,
    dsp: ChannelProcessor,
}
impl<S: Source<Item = f32>> ChannelStrip<S> {
    pub fn new(inner: S, shared: Arc<StripShared>) -> Self {
        let dsp = ChannelProcessor::new(inner.channels().get(), inner.sample_rate().get(), shared);
        Self { inner, dsp }
    }
}
impl<S: Source<Item = f32>> Iterator for ChannelStrip<S> {
    type Item = f32;
    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;
        Some(self.dsp.process(sample))
    }
}
impl<S: Source<Item = f32>> Source for ChannelStrip<S> {
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
    use std::f64::consts::TAU;

    const RATE: u32 = 48000;

    fn shared(gain: f32, low: f32, mid: f32, high: f32, level: f32, side: f32) -> Arc<StripShared> {
        let s = Arc::new(StripShared::default());
        s.set_targets(gain, low, mid, high, level, side);
        s
    }
    /// RMS of the left channel over the last half second of `seconds` of a stereo tone.
    fn tone_rms(processor: &mut ChannelProcessor, hz: f64, amp: f64, seconds: f64) -> f64 {
        let frames = (seconds * RATE as f64) as usize;
        let tail = frames - RATE as usize / 2;
        let (mut sum, mut n) = (0.0, 0.0);
        for i in 0..frames {
            let x = (amp * (TAU * hz * i as f64 / RATE as f64).sin()) as f32;
            let l = processor.process(x);
            processor.process(x);
            if i >= tail {
                sum += (l as f64) * (l as f64);
                n += 1.0;
            }
        }
        (sum / n).sqrt()
    }
    fn db(ratio: f64) -> f64 {
        20.0 * ratio.max(1.0e-12).log10()
    }
    fn input_rms(amp: f64) -> f64 {
        amp / 2f64.sqrt()
    }
    fn processor(s: &Arc<StripShared>) -> ChannelProcessor {
        ChannelProcessor::new(2, RATE, s.clone())
    }

    #[test]
    fn knob_mapping_is_exact_at_the_ends_and_neutral_at_the_detent() {
        assert_eq!(knob_to_gain(0.0), 0.0);
        assert_eq!(knob_to_gain(-5.0), 0.0);
        assert_eq!(knob_to_gain(f64::NAN), 0.0);
        assert_eq!(knob_to_gain(50.0), 1.0);
        assert!((knob_to_gain(25.0) - 0.25).abs() < 1.0e-6);
        assert!((db(knob_to_gain(100.0) as f64) - 6.0).abs() < 0.01);
        assert!(knob_to_gain(0.5) > 0.0, "only the zero position kills a band");
        let mut last = 0.0;
        for step in 0..=100 {
            let g = knob_to_gain(step as f64);
            assert!(g >= last, "monotonic");
            last = g;
        }
    }

    #[test]
    fn neutral_response_is_flat_across_the_spectrum() {
        for hz in [30.0, 60.0, 120.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0, 18000.0] {
            let s = shared(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
            let got = tone_rms(&mut processor(&s), hz, 0.5, 2.0);
            let error = db(got / input_rms(0.5));
            assert!(error.abs() < 0.1, "{hz} Hz neutral error {error} dB");
        }
    }

    #[test]
    fn each_kill_removes_its_band_and_leaves_the_others() {
        // (killed band, in-band tone, tones that must survive)
        let cases = [("low", 0usize, 60.0, [1000.0, 8000.0]), ("mid", 1, 800.0, [60.0, 8000.0]), ("high", 2, 8000.0, [60.0, 1000.0])];
        for (name, index, killed_hz, kept) in cases {
            let mut gains = [1.0f32; 3];
            gains[index] = 0.0;
            let s = shared(1.0, gains[0], gains[1], gains[2], 1.0, 1.0);
            let removed = db(tone_rms(&mut processor(&s), killed_hz, 0.5, 2.0) / input_rms(0.5));
            assert!(removed < -30.0, "{name} kill leaves {killed_hz} Hz at {removed} dB");
            for hz in kept {
                let kept_db = db(tone_rms(&mut processor(&s), hz, 0.5, 2.0) / input_rms(0.5));
                assert!(kept_db.abs() < 0.5, "{name} kill changed {hz} Hz by {kept_db} dB");
            }
        }
    }

    #[test]
    fn a_kill_is_a_crossover_not_a_brick_wall_at_the_corner() {
        // At a corner frequency both neighbouring bands carry half the amplitude (-6 dB each).
        let s = shared(1.0, 0.0, 1.0, 1.0, 1.0, 1.0);
        let at_corner = db(tone_rms(&mut processor(&s), LOW_CROSSOVER_HZ, 0.5, 2.0) / input_rms(0.5));
        assert!(at_corner > -9.0 && at_corner < -3.0, "corner level {at_corner} dB is the neighbour's skirt");
    }

    #[test]
    fn all_three_kills_are_digital_silence_for_any_input() {
        let s = shared(1.0, 0.0, 0.0, 0.0, 1.0, 1.0);
        let mut p = processor(&s);
        let mut noise = 12345u32;
        for i in 0..96000 {
            noise = noise.wrapping_mul(1664525).wrapping_add(1013904223);
            let x = (noise >> 8) as f32 / 8388608.0 - 1.0;
            let loud = if i % 977 == 0 { 1.0 } else { x };
            assert_eq!(p.process(loud), 0.0, "sample {i}");
        }
        assert_eq!(s.meter(), (0.0, 0.0), "a silent channel meters nothing");
    }

    #[test]
    fn live_kill_ramps_without_a_step_and_lands_on_exact_zero() {
        let s = shared(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
        let mut p = processor(&s);
        let mut last = 0.0f32;
        let mut max_step = 0.0f32;
        let mut steady_peak = 0.0f32;
        for i in 0..RATE as usize {
            if i == 20000 {
                s.set_targets(1.0, 0.0, 0.0, 0.0, 1.0, 1.0);
            }
            let x = (0.8 * (TAU * 220.0 * i as f64 / RATE as f64).sin()) as f32;
            let y = p.process(x);
            p.process(x);
            if i < 20000 && i > 4000 {
                steady_peak = steady_peak.max(y.abs());
            }
            max_step = max_step.max((y - last).abs());
            last = y;
            if i > 20000 + RATE as usize / 5 {
                assert_eq!(y, 0.0, "exactly silent {i} frames in");
            }
        }
        // A 0.8-amplitude 220 Hz sine moves at most ~0.023 per sample; the 5 ms ramp may not exceed
        // that by more than a small factor (an unramped kill would step by up to the full level).
        assert!(max_step < 0.06, "largest sample-to-sample change {max_step}");
        assert!(steady_peak > 0.7);
    }

    #[test]
    fn restoring_a_band_is_also_bounded() {
        let s = shared(1.0, 0.0, 0.0, 0.0, 1.0, 1.0);
        let mut p = processor(&s);
        let (mut last, mut max_step) = (0.0f32, 0.0f32);
        for i in 0..RATE as usize / 2 {
            if i == 4000 {
                s.set_targets(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
            }
            let x = (0.8 * (TAU * 220.0 * i as f64 / RATE as f64).sin()) as f32;
            let y = p.process(x);
            p.process(x);
            max_step = max_step.max((y - last).abs());
            last = y;
        }
        assert!(max_step < 0.06, "largest sample-to-sample change {max_step}");
    }

    #[test]
    fn boost_and_cut_follow_the_knob_taper() {
        let s = shared(1.0, 1.0, knob_to_gain(100.0), 1.0, 1.0, 1.0);
        let boosted = db(tone_rms(&mut processor(&s), 800.0, 0.25, 2.0) / input_rms(0.25));
        assert!((boosted - 6.0).abs() < 0.3, "mid boost {boosted}");
        let s = shared(1.0, 1.0, knob_to_gain(25.0), 1.0, 1.0, 1.0);
        let cut = db(tone_rms(&mut processor(&s), 800.0, 0.5, 2.0) / input_rms(0.5));
        assert!((cut + 12.0).abs() < 1.0, "mid cut {cut}");
    }

    #[test]
    fn meter_reads_after_gain_eq_and_fader_but_before_the_crossfader() {
        let amp = 0.5f64;
        // fader 0.5, crossfader/headroom at 0.25
        let s = shared(1.0, 1.0, 1.0, 1.0, 0.5, 0.25);
        let mut p = processor(&s);
        tone_rms(&mut p, 1000.0, amp, 1.0);
        let (l, r) = s.meter();
        assert!((l - 0.25).abs() < 0.03 && (r - 0.25).abs() < 0.03, "meter {l} {r} should read 0.5 x fader 0.5, not the crossfader");
        // the crossfader moving all the way down does not move the meter
        s.set_targets(1.0, 1.0, 1.0, 1.0, 0.5, 0.0);
        tone_rms(&mut p, 1000.0, amp, 1.0);
        let (l2, _) = s.meter();
        assert!((l2 - l).abs() < 0.02, "crossfader leaked into the meter: {l} -> {l2}");
        // killing the mid band the tone lives in empties the meter
        s.set_targets(1.0, 1.0, 0.0, 1.0, 0.5, 0.25);
        tone_rms(&mut p, 1000.0, amp, 2.0);
        assert!(s.meter().0 < 0.01, "EQ kill must show on the meter: {:?}", s.meter());
        // and an explicit reset empties it at once
        s.set_targets(1.0, 1.0, 1.0, 1.0, 0.5, 0.25);
        tone_rms(&mut p, 1000.0, amp, 1.0);
        assert!(s.meter().0 > 0.2);
        // let the filters ring out first: a reset must not be judged against genuine ring-down
        for _ in 0..RATE as usize {
            p.process(0.0);
        }
        assert!(s.meter().0 > 0.0, "the release is still holding a reading");
        s.reset_meter();
        assert_eq!(s.meter(), (0.0, 0.0));
        for _ in 0..4096 {
            p.process(0.0);
        }
        assert_eq!(s.meter(), (0.0, 0.0), "the held peak does not come back after a reset");
    }

    #[test]
    fn meter_channels_are_independent_and_mono_feeds_both() {
        let s = shared(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
        let mut p = processor(&s);
        for i in 0..RATE as usize {
            let x = (0.6 * (TAU * 1000.0 * i as f64 / RATE as f64).sin()) as f32;
            p.process(x);
            p.process(0.0);
        }
        let (l, r) = s.meter();
        assert!(l > 0.5 && r < 0.01, "left {l} right {r}");
        let s = shared(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
        let mut mono = ChannelProcessor::new(1, RATE, s.clone());
        for i in 0..RATE as usize {
            mono.process((0.4 * (TAU * 1000.0 * i as f64 / RATE as f64).sin()) as f32);
        }
        let (l, r) = s.meter();
        assert!(l > 0.35 && (l - r).abs() < 1.0e-6, "mono {l} {r}");
    }

    #[test]
    fn meter_release_is_bounded_and_ceiling_applies() {
        let s = shared(knob_to_gain(100.0), 1.0, 1.0, 1.0, 1.0, 1.0);
        let mut p = processor(&s);
        for i in 0..RATE as usize / 2 {
            let x = (1.0 * (TAU * 1000.0 * i as f64 / RATE as f64).sin()) as f32;
            p.process(x);
            p.process(x);
        }
        let (loud, _) = s.meter();
        assert!(loud > 1.5 && loud <= METER_CEILING, "boosted peak {loud} may exceed full scale (it is a pre-master reading)");
        s.set_targets(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
        for _ in 0..RATE as usize / 10 * 2 {
            p.process(0.0);
        }
        let (after, _) = s.meter();
        assert!(after < loud && after > 0.0, "release decays but is not instant: {loud} -> {after}");
        for _ in 0..RATE as usize * 6 * 2 {
            p.process(0.0);
        }
        assert_eq!(s.meter().0, 0.0, "release reaches exactly zero");
    }

    #[test]
    fn non_finite_input_cannot_poison_the_filters() {
        let s = shared(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
        let mut p = processor(&s);
        for i in 0..2000 {
            let x = if i == 100 { f32::NAN } else if i == 200 { f32::INFINITY } else { 0.3 };
            assert!(p.process(x).is_finite());
        }
        let after = tone_rms(&mut p, 1000.0, 0.5, 1.0);
        assert!(after > 0.3);
    }

    #[test]
    fn crossfader_assignment_curves() {
        let at = |side, pos| side_gain(side, pos) / MASTER_HEADROOM;
        assert!((at(Side::Left, 0.0) - 1.0).abs() < 1.0e-6);
        assert_eq!(at(Side::Left, 100.0), 0.0);
        assert_eq!(at(Side::Right, 0.0), 0.0);
        assert!((at(Side::Right, 100.0) - 1.0).abs() < 1.0e-6);
        for pos in [0.0, 17.0, 50.0, 83.0, 100.0] {
            assert!((at(Side::Thru, pos) - 1.0).abs() < 1.0e-6);
            let (l, r) = (at(Side::Left, pos), at(Side::Right, pos));
            assert!((l * l + r * r - 1.0).abs() < 1.0e-5, "equal power at {pos}");
        }
        assert!((at(Side::Left, 50.0) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1.0e-6);
        assert_eq!(Side::parse("left"), Ok(Side::Left));
        assert_eq!(Side::parse("thru"), Ok(Side::Thru));
        assert_eq!(Side::parse("right"), Ok(Side::Right));
        assert!(Side::parse("both").is_err() && Side::parse("").is_err());
        assert_eq!(Side::Right.as_str(), "right");
    }

    #[test]
    fn strip_wraps_a_real_source_without_changing_its_format() {
        let samples: Vec<f32> = (0..9600).map(|i| (i as f32 * 0.01).sin() * 0.5).collect();
        let source = rodio::buffer::SamplesBuffer::new(ChannelCount::new(2).unwrap(), SampleRate::new(RATE).unwrap(), samples.clone());
        let s = shared(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
        let strip = ChannelStrip::new(source, s);
        assert_eq!(strip.channels().get(), 2);
        assert_eq!(strip.sample_rate().get(), RATE);
        assert_eq!(strip.count(), samples.len(), "the strip never adds or drops samples");
    }
}
