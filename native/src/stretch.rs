//! Streaming waveform-similarity overlap-add. All work and allocations are on
//! preparation/producer workers. Stereo (and multichannel) uses one shared offset.
use std::collections::VecDeque;
pub struct Processor<I: Iterator<Item = f32>> {
    input: I,
    channels: usize,
    hop: usize,
    search: usize,
    data: VecDeque<f32>,
    base: usize,
    read: usize,
    eof: bool,
    position: f64,
    tail: Vec<f32>,
}
impl<I: Iterator<Item = f32>> Processor<I> {
    pub fn new(input: I, channels: usize, rate: u32) -> Self {
        Self {
            input,
            channels,
            hop: (rate as usize / 50).max(1),
            search: (rate as usize / 200).max(1),
            data: VecDeque::new(),
            base: 0,
            read: 0,
            eof: false,
            position: 0.0,
            tail: Vec::new(),
        }
    }
    fn fill(&mut self, end: usize) {
        while self.read < end && !self.eof {
            let mut got = false;
            for _ in 0..self.channels {
                match self.input.next() {
                    Some(v) => {
                        self.data.push_back(if v.is_finite() {
                            v.clamp(-1.0, 1.0)
                        } else {
                            0.0
                        });
                        got = true;
                    }
                    None => {
                        self.eof = true;
                        self.data.push_back(0.0);
                    }
                }
            }
            if got {
                self.read += 1;
            } else {
                for _ in 0..self.channels {
                    self.data.pop_back();
                }
                break;
            }
        }
    }
    fn at(&self, frame: usize, c: usize) -> f32 {
        if frame < self.base {
            return 0.0;
        }
        *self
            .data
            .get((frame - self.base) * self.channels + c)
            .unwrap_or(&0.0)
    }
    pub fn block(&mut self, rate: f64, locked: bool) -> Vec<(f32, f64)> {
        let start = self.position;
        let nominal = start.floor() as usize;
        self.fill(nominal + self.hop * 3 + self.search + 4);
        if self.eof && self.position >= self.read as f64 {
            return Vec::new();
        }
        let frames = self
            .hop
            .min(((self.read as f64 - start) / rate).ceil().max(0.0) as usize);
        let mut out = Vec::with_capacity(frames * self.channels);
        if !locked || (rate - 1.0).abs() < 1e-9 {
            self.tail.clear();
            for n in 0..frames {
                let p = start + n as f64 * rate;
                let i = p.floor() as usize;
                let f = (p - i as f64) as f32;
                for c in 0..self.channels {
                    out.push((
                        self.at(i, c) * (1.0 - f) + self.at(i + 1, c) * f,
                        (p + rate).min(self.read as f64),
                    ));
                }
            }
        } else {
            let mut anchor = nominal;
            if self.tail.len() == self.hop * self.channels {
                let mut best = f64::NEG_INFINITY;
                let lower = nominal.saturating_sub(self.search).max(self.base);
                let upper = nominal + self.search;
                // Coarse search then refine to sample precision.
                for pass in [8usize, 1] {
                    let (lo, hi) = if pass == 8 {
                        (lower, upper)
                    } else {
                        (anchor.saturating_sub(8).max(lower), (anchor + 8).min(upper))
                    };
                    for p in (lo..=hi).step_by(pass) {
                        let (mut cross, mut aa, mut bb) = (0.0, 1e-12, 1e-12);
                        for n in (0..self.hop).step_by(8) {
                            for c in 0..self.channels.min(2) {
                                let a = self.tail[n * self.channels + c] as f64;
                                let b = self.at(p + n, c) as f64;
                                cross += a * b;
                                aa += a * a;
                                bb += b * b;
                            }
                        }
                        let score = cross / (aa * bb).sqrt();
                        if score > best {
                            best = score;
                            anchor = p;
                        }
                    }
                }
            }
            for n in 0..frames {
                let mix = n as f32 / self.hop as f32;
                for c in 0..self.channels {
                    let fresh = self.at(anchor + n, c);
                    let sample = if self.tail.len() == self.hop * self.channels {
                        self.tail[n * self.channels + c] * (1.0 - mix) + fresh * mix
                    } else {
                        fresh
                    };
                    out.push((
                        sample,
                        (start + (n + 1) as f64 * rate).min(self.read as f64),
                    ));
                }
            }
            self.tail = (0..self.hop)
                .flat_map(|n| (0..self.channels).map(move |c| (n, c)))
                .map(|(n, c)| self.at(anchor + self.hop + n, c))
                .collect();
        }
        self.position = (start + frames as f64 * rate).min(self.read as f64);
        let retain = (self.position as usize).saturating_sub(self.search + self.hop);
        while self.base < retain && !self.data.is_empty() {
            for _ in 0..self.channels {
                self.data.pop_front();
            }
            self.base += 1;
        }
        out
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn render(rate: f64, locked: bool) -> Vec<f32> {
        let sr = 8000;
        let input =
            (0..sr * 3).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / sr as f32).sin());
        let mut p = Processor::new(input, 1, sr);
        let mut out = Vec::new();
        loop {
            let b = p.block(rate, locked);
            if b.is_empty() {
                break;
            }
            out.extend(b.iter().map(|x| x.0));
        }
        out
    }
    fn frequency(v: &[f32]) -> f64 {
        let x = &v[4000..12000];
        x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() as f64
    }
    #[test]
    fn changing_settings_keeps_stereo_and_clock_coherent() {
        let samples = (0..48000).flat_map(|i| {
            let v = (i as f32 * 0.1).sin();
            [v, -v]
        });
        let mut p = Processor::new(samples, 2, 8000);
        let mut last = 0.0;
        for i in 0..100 {
            let out = p.block(if i % 2 == 0 { 0.92 } else { 1.08 }, i % 3 != 0);
            for frame in out.chunks_exact(2) {
                assert!(frame[0].0.is_finite());
                assert!((frame[0].0 + frame[1].0).abs() < 1e-6);
                assert_eq!(frame[0].1, frame[1].1);
                assert!(frame[0].1 > last);
                last = frame[0].1;
            }
        }
    }
    #[test]
    fn locked_pitch_and_unlocked_speed() {
        for r in [0.92, 1.08] {
            let a = render(r, false);
            let b = render(r, true);
            assert!((a.len() as f64 - 24000.0 / r).abs() < 3.0);
            assert_eq!(a.len(), b.len());
            assert!((frequency(&a) - 440.0 * r).abs() < 2.0);
            assert!((frequency(&b) - 440.0).abs() < 2.0, "{}", frequency(&b));
        }
    }
}
