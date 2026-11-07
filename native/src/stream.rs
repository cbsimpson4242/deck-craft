//! Filesystem reads, decode and seek are worker-only. Device callbacks see only
//! a bounded SPSC PCM ring and atomics; retired buffers are freed off callback.
use crate::{Identity, checked_file, decode};
use rodio::{ChannelCount, SampleRate, Source};
use rtrb::{Consumer, Producer, PushError, RingBuffer};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

pub struct StreamState {
    pub position_frames: AtomicU64,
    pub rate_bits: AtomicU64,
    pub pitch_lock: AtomicBool,
    pub underrun_samples: AtomicU64,
    pub finished: AtomicBool,
    pub failed: AtomicBool,
    pub consumer_dropped: AtomicBool,
    pub release_producer: AtomicBool,
}
pub struct PcmSource {
    consumer: Option<Consumer<(f32, f64)>>,
    state: Arc<StreamState>,
    channels: ChannelCount,
    rate: SampleRate,
    duration: Duration,
    consumed: u64,
    offset: u64,
    silence_remaining: u16,
}
pub struct Prepared {
    pub source: PcmSource,
    pub state: Arc<StreamState>,
    pub duration: f64,
    pub channels: u16,
    pub sample_rate: u32,
}
impl PcmSource {
    pub fn advance_to(&mut self, target: f64) -> bool {
        let target_frames = target * self.rate.get() as f64;
        while (self.state.position_frames.load(Ordering::Relaxed) as f64) < target_frames {
            if self
                .consumer
                .as_ref()
                .is_none_or(|c| c.slots() < self.channels.get() as usize)
            {
                return false;
            }
            for _ in 0..self.channels.get() {
                if let Some(c) = self.consumer.as_mut() {
                    if let Ok((_, p)) = c.pop() {
                        self.state
                            .position_frames
                            .store(self.offset + p.round() as u64, Ordering::Relaxed);
                    }
                }
            }
        }
        true
    }
}
impl Iterator for PcmSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.state.failed.load(Ordering::Relaxed) {
            return None;
        }
        if self.silence_remaining > 0 {
            self.silence_remaining -= 1;
            return Some(0.0);
        }
        if self.consumed % self.channels.get() as u64 == 0
            && self.consumer.as_ref()?.slots() < self.channels.get() as usize
        {
            if self.state.finished.load(Ordering::Acquire) {
                return None;
            }
            self.silence_remaining = self.channels.get() - 1;
            self.state
                .underrun_samples
                .fetch_add(self.channels.get() as u64, Ordering::Relaxed);
            return Some(0.0);
        }
        match self.consumer.as_mut()?.pop() {
            Ok((sample, position)) => {
                self.consumed += 1;
                if self.consumed % self.channels.get() as u64 == 0 {
                    self.state
                        .position_frames
                        .store(self.offset + position.round() as u64, Ordering::Relaxed);
                }
                Some(sample)
            }
            Err(_) => {
                if self.state.finished.load(Ordering::Acquire) {
                    None
                } else {
                    self.state.underrun_samples.fetch_add(1, Ordering::Relaxed);
                    Some(0.0)
                }
            }
        }
    }
}
impl Source for PcmSource {
    fn current_span_len(&self) -> Option<usize> {
        if self.silence_remaining == 0
            && self.consumed % self.channels.get() as u64 == 0
            && self.state.finished.load(Ordering::Acquire)
            && self
                .consumer
                .as_ref()
                .is_none_or(|c| c.slots() < self.channels.get() as usize)
        {
            Some(0)
        } else {
            None
        }
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.rate
    }
    fn total_duration(&self) -> Option<Duration> {
        Some(self.duration)
    }
}
impl Drop for PcmSource {
    fn drop(&mut self) {
        // Keep the producer alive while dropping the consumer, so this callback can
        // never be the final owner that deallocates the ring's sample allocation.
        drop(self.consumer.take());
        self.state.consumer_dropped.store(true, Ordering::Release);
    }
}
fn push(producer: &mut Producer<(f32, f64)>, state: &StreamState, mut sample: (f32, f64)) -> bool {
    loop {
        if state.consumer_dropped.load(Ordering::Acquire) {
            return false;
        }
        match producer.push(sample) {
            Ok(()) => return true,
            Err(PushError::Full(value)) => {
                sample = value;
                thread::sleep(Duration::from_millis(2));
            }
        }
    }
}
pub fn prepare(path: &str, identity: &Identity, position: f64) -> Result<Prepared, &'static str> {
    prepare_tempo(path, identity, position, 1.0, true)
}
pub fn prepare_tempo(
    path: &str,
    identity: &Identity,
    position: f64,
    tempo: f64,
    locked: bool,
) -> Result<Prepared, &'static str> {
    let mut decoder = decode(checked_file(path, identity)?)?;
    let duration = decoder.total_duration().unwrap().as_secs_f64();
    if position < 0.0 || position > duration {
        return Err("invalid_position");
    }
    let position = position.min((duration - 0.001).max(0.0));
    if position > 0.0 {
        decoder
            .try_seek(Duration::from_secs_f64(position))
            .map_err(|_| "seek_failed")?;
    }
    let channels = decoder.channels();
    let rate = decoder.sample_rate();
    let capacity = rate.get() as usize * channels.get() as usize / 10;
    let (mut producer, consumer) = RingBuffer::<(f32, f64)>::new(capacity);
    let offset = (position * rate.get() as f64).round() as u64;
    let state = Arc::new(StreamState {
        position_frames: AtomicU64::new(offset),
        rate_bits: AtomicU64::new(tempo.to_bits()),
        pitch_lock: AtomicBool::new(locked),
        underrun_samples: AtomicU64::new(0),
        finished: AtomicBool::new(false),
        failed: AtomicBool::new(false),
        consumer_dropped: AtomicBool::new(false),
        release_producer: AtomicBool::new(false),
    });
    let mut processor = crate::stretch::Processor::new(decoder, channels.get() as usize, rate.get());
    let initial = processor.block(tempo, locked);
    if initial.is_empty() {
        return Err("unsupported_or_corrupt_audio");
    }
    for sample in initial {
        producer.push(sample).map_err(|_| "audio_buffer_failed")?;
    }
    let worker_state = state.clone();
    thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            while !worker_state.consumer_dropped.load(Ordering::Acquire) {
                let tempo = f64::from_bits(worker_state.rate_bits.load(Ordering::Acquire));
                let locked = worker_state.pitch_lock.load(Ordering::Acquire);
                let block = processor.block(tempo, locked);
                if block.is_empty() {
                    break;
                }
                for sample in block {
                    if !push(&mut producer, &worker_state, sample) {
                        return;
                    }
                }
            }
        }));
        if result.is_err() {
            worker_state.failed.store(true, Ordering::Release);
        }
        worker_state.finished.store(true, Ordering::Release);
        // The control thread grants retirement after the consumer has disappeared.
        // This worker, not the audio callback, then releases the ring allocation.
        while !worker_state.release_producer.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(2));
        }
        drop(producer);
    });
    let source = PcmSource {
        consumer: Some(consumer),
        state: state.clone(),
        channels,
        rate,
        duration: Duration::from_secs_f64(duration - position),
        consumed: 0,
        offset,
        silence_remaining: 0,
    };
    Ok(Prepared {
        source,
        state,
        duration,
        channels: channels.get(),
        sample_rate: rate.get(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn underrun_silence_preserves_whole_stereo_frames_and_media_position() {
        let (mut producer, consumer) = RingBuffer::<(f32, f64)>::new(8);
        let state = Arc::new(StreamState {
            position_frames: AtomicU64::new(0),
            rate_bits: AtomicU64::new(1.0f64.to_bits()),
            pitch_lock: AtomicBool::new(true),
            underrun_samples: AtomicU64::new(0),
            finished: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            consumer_dropped: AtomicBool::new(false),
            release_producer: AtomicBool::new(false),
        });
        let mut source = PcmSource {
            consumer: Some(consumer),
            state: state.clone(),
            channels: ChannelCount::new(2).unwrap(),
            rate: SampleRate::new(48000).unwrap(),
            duration: Duration::from_secs(1),
            consumed: 0,
            offset: 0,
            silence_remaining: 0,
        };
        producer.push((0.25, 1.0)).unwrap();
        assert_eq!(source.next(), Some(0.0));
        assert_eq!(source.next(), Some(0.0));
        assert_eq!(state.position_frames.load(Ordering::Relaxed), 0);
        producer.push((0.75, 1.0)).unwrap();
        assert_eq!(source.next(), Some(0.25));
        assert_eq!(source.next(), Some(0.75));
        assert_eq!(state.position_frames.load(Ordering::Relaxed), 1);
    }

    fn stream_state() -> Arc<StreamState> {
        Arc::new(StreamState {
            position_frames: AtomicU64::new(0),
            rate_bits: AtomicU64::new(1.0f64.to_bits()),
            pitch_lock: AtomicBool::new(true),
            underrun_samples: AtomicU64::new(0),
            finished: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            consumer_dropped: AtomicBool::new(false),
            release_producer: AtomicBool::new(false),
        })
    }
    fn pcm_source(consumer: Consumer<(f32, f64)>, state: &Arc<StreamState>) -> PcmSource {
        PcmSource {
            consumer: Some(consumer),
            state: state.clone(),
            channels: ChannelCount::new(2).unwrap(),
            rate: SampleRate::new(48000).unwrap(),
            duration: Duration::from_secs(1),
            consumed: 0,
            offset: 0,
            silence_remaining: 0,
        }
    }
    #[test]
    fn channel_strip_leaves_position_underrun_accounting_and_retirement_to_the_stream() {
        use crate::dsp::{DeckControls, Knob, Strip};
        let (mut producer, consumer) = RingBuffer::<(f32, f64)>::new(4096);
        let state = stream_state();
        let controls = DeckControls::new(0.5);
        controls.set(Knob::Gain, 100.0);
        let mut strip = Strip::new(pcm_source(consumer, &state), controls);
        // Underrun: silence for whole frames, position untouched, counted by the stream.
        assert_eq!(strip.next(), Some(0.0));
        assert_eq!(strip.next(), Some(0.0));
        assert_eq!(state.position_frames.load(Ordering::Relaxed), 0);
        assert_eq!(state.underrun_samples.load(Ordering::Relaxed), 2);
        for frame in 1..=400 {
            producer.push((0.1, frame as f64)).unwrap();
            producer.push((0.1, frame as f64)).unwrap();
        }
        let out: Vec<f32> = (0..800).map(|_| strip.next().unwrap()).collect();
        assert_eq!(state.position_frames.load(Ordering::Relaxed), 400, "media position still counts consumed frames");
        // 0.1 x 0.5 fader x +12 dB, after the 2 ms start fade.
        assert!(out.iter().all(|v| v.is_finite()&&v.abs()<0.5),"strip processes real PCM while the stream owns frame accounting");
        assert!(!state.consumer_dropped.load(Ordering::Acquire));
        // Dropping the strip drops the PCM source: the consumer is released first, so the ring is
        // retired off the device thread exactly as before.
        drop(strip);
        assert!(state.consumer_dropped.load(Ordering::Acquire));
        drop(producer);
    }
}
