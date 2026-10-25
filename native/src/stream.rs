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
    pub underrun_samples: AtomicU64,
    pub finished: AtomicBool,
    pub failed: AtomicBool,
    pub consumer_dropped: AtomicBool,
    pub release_producer: AtomicBool,
}
pub struct PcmSource {
    consumer: Option<Consumer<f32>>,
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
            Ok(sample) => {
                self.consumed += 1;
                if self.consumed % self.channels.get() as u64 == 0 {
                    self.state.position_frames.store(
                        self.offset + self.consumed / self.channels.get() as u64,
                        Ordering::Relaxed,
                    );
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
fn push(producer: &mut Producer<f32>, state: &StreamState, mut sample: f32) -> bool {
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
    let capacity = rate.get() as usize * channels.get() as usize / 2;
    let (mut producer, consumer) = RingBuffer::<f32>::new(capacity);
    let offset = (position * rate.get() as f64).round() as u64;
    let state = Arc::new(StreamState {
        position_frames: AtomicU64::new(offset),
        underrun_samples: AtomicU64::new(0),
        finished: AtomicBool::new(false),
        failed: AtomicBool::new(false),
        consumer_dropped: AtomicBool::new(false),
        release_producer: AtomicBool::new(false),
    });
    let initial = rate.get() as usize * channels.get() as usize / 10;
    let mut count = 0;
    for _ in 0..initial {
        match decoder.next() {
            Some(sample) => {
                let sample = if sample.is_finite() {
                    sample.clamp(-1.0, 1.0)
                } else {
                    0.0
                };
                producer.push(sample).map_err(|_| "audio_buffer_failed")?;
                count += 1;
            }
            None => {
                state.finished.store(true, Ordering::Release);
                break;
            }
        }
    }
    if count == 0 {
        return Err("unsupported_or_corrupt_audio");
    }
    let worker_state = state.clone();
    thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            while !worker_state.consumer_dropped.load(Ordering::Acquire) {
                let Some(sample) = decoder.next() else {
                    break;
                };
                let sample = if sample.is_finite() {
                    sample.clamp(-1.0, 1.0)
                } else {
                    0.0
                };
                if !push(&mut producer, &worker_state, sample) {
                    break;
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
        let (mut producer, consumer) = RingBuffer::<f32>::new(8);
        let state = Arc::new(StreamState {
            position_frames: AtomicU64::new(0),
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
        producer.push(0.25).unwrap();
        assert_eq!(source.next(), Some(0.0));
        assert_eq!(source.next(), Some(0.0));
        assert_eq!(state.position_frames.load(Ordering::Relaxed), 0);
        producer.push(0.75).unwrap();
        assert_eq!(source.next(), Some(0.25));
        assert_eq!(source.next(), Some(0.75));
        assert_eq!(state.position_frames.load(Ordering::Relaxed), 1);
    }
}
