pub mod analysis;
pub mod artwork;
pub mod dsp;
pub mod fullkill;
pub mod stream;
pub mod stretch;
use rodio::{Decoder, Source};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub const MAX_FRAME: usize = 16 * 1024;
pub const MAX_FILE: u64 = 512 * 1024 * 1024;
pub const MAX_DURATION: f64 = 7200.0;
/// Unsolicited state snapshots carry the consumed-frame position. While any deck plays they follow the
/// approximately 60 Hz; while a deck is only preparing they confirm progress; otherwise they are a slow
/// heartbeat (the host watchdog needs a message within three seconds). The loop blocks on its channel with
/// a timeout for the remaining time, so none of this is a busy loop, and no file, decode or device-callback
/// work happens on this cadence.
pub const SNAPSHOT_PLAYING_MS: u64 = 16;
pub const SNAPSHOT_LOADING_MS: u64 = 50;
pub const SNAPSHOT_IDLE_MS: u64 = 250;
pub fn snapshot_interval(playing: bool, loading: bool) -> std::time::Duration {
    std::time::Duration::from_millis(if playing {
        SNAPSHOT_PLAYING_MS
    } else if loading {
        SNAPSHOT_LOADING_MS
    } else {
        SNAPSHOT_IDLE_MS
    })
}

/// Persisted waveform: exactly this many peaks per track (validated by the desktop library).
pub const PEAK_BINS: usize = 512;
/// Session-only detail envelope: about 64 bins per second of audio, clamped to this range. At most
/// two 8-bit values per bin (peak and RMS) cross the pipe, never more than 64 KiB of raw data.
pub const DETAIL_MIN_BINS: usize = 512;
pub const DETAIL_MAX_BINS: usize = 32768;
pub const DETAIL_BINS_PER_SECOND: f64 = 64.0;
pub fn detail_bin_count(duration: f64) -> usize {
    if !duration.is_finite() || duration <= 0.0 {
        return DETAIL_MIN_BINS;
    }
    ((duration * DETAIL_BINS_PER_SECOND).ceil() as usize).clamp(DETAIL_MIN_BINS, DETAIL_MAX_BINS)
}
pub struct Waveform {
    pub peaks: Vec<f32>,
    pub detail_peak: Vec<u8>,
    pub detail_rms: Vec<u8>,
}
/// One pass over decoded interleaved samples. `count` is the expected number of samples (duration x
/// rate x channels). Returns None as soon as `cancelled` reports true (checked every 8192 samples).
/// Values are measured from the decoded PCM, never interpolated: peak is the largest absolute
/// sample in the bin; RMS is the root mean square of the bin's samples. Digital silence is exactly 0.
pub fn analyze_waveform(
    samples: impl Iterator<Item = f32>,
    count: f64,
    detail_bins: usize,
    mut cancelled: impl FnMut() -> bool,
) -> Option<Waveform> {
    let detail_bins = detail_bins.clamp(1, DETAIL_MAX_BINS);
    let count = count.max(1.0);
    let mut peaks = vec![0.0f32; PEAK_BINS];
    let mut detail_peak = vec![0.0f32; detail_bins];
    let mut squares = vec![0.0f64; detail_bins];
    let mut seen = vec![0u32; detail_bins];
    for (n, sample) in samples.enumerate() {
        if n % 8192 == 0 && cancelled() {
            return None;
        }
        let u = n as f64 / count;
        let bin = ((u * PEAK_BINS as f64).floor() as usize).min(PEAK_BINS - 1);
        let fine = ((u * detail_bins as f64).floor() as usize).min(detail_bins - 1);
        if sample.is_finite() {
            let magnitude = sample.abs().min(1.0);
            peaks[bin] = peaks[bin].max(magnitude);
            // An estimated duration can be shorter than the decode. Samples past the expected end
            // belong to no detail bin; folding them into the last one would draw a false tail.
            if u < 1.0 {
                detail_peak[fine] = detail_peak[fine].max(magnitude);
                squares[fine] += (magnitude as f64) * (magnitude as f64);
            }
        }
        if u < 1.0 {
            seen[fine] = seen[fine].saturating_add(1);
        }
    }
    let quantize = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    let detail_rms = squares
        .iter()
        .zip(&seen)
        .map(|(sum, n)| quantize(if *n == 0 { 0.0 } else { (sum / *n as f64).sqrt() }))
        .collect::<Vec<u8>>();
    let detail_peak = detail_peak.iter().map(|v| quantize(*v as f64)).collect::<Vec<u8>>();
    // Rounding keeps RMS <= peak per bin; enforce it for the wire format regardless.
    let detail_rms = detail_rms.iter().zip(&detail_peak).map(|(r, p)| (*r).min(*p)).collect();
    Some(Waveform {
        peaks,
        detail_peak,
        detail_rms,
    })
}
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        out.push(TABLE[(b[0] >> 2) as usize] as char);
        out.push(TABLE[(((b[0] & 3) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(((b[1] & 15) << 2) | (b[2] >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(b[2] & 63) as usize] as char } else { '=' });
    }
    out
}
pub fn fatal_output_error(kind: rodio::CpalErrorKind) -> bool {
    !matches!(
        kind,
        rodio::CpalErrorKind::RealtimeDenied
            | rodio::CpalErrorKind::Xrun
            | rodio::CpalErrorKind::DeviceChanged
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Identity {
    pub dev: String,
    pub ino: String,
    pub size: u64,
    pub mtime_ns: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Status,
    Load {
        deck: String,
        #[serde(rename = "trackId")]
        track_id: String,
        path: String,
        identity: Identity,
    },
    Play {
        deck: String,
    },
    Pause {
        deck: String,
    },
    Seek {
        deck: String,
        position: f64,
    },
    Level {
        deck: String,
        value: f64,
    },
    Assign { deck: String, side: String },
    Crossfader {
        value: f64,
    },
    Tempo {
        deck: String,
        rate: f64,
        #[serde(rename = "pitchLock")]
        pitch_lock: bool,
    },
    Master {
        deck: String,
    },
    Sync {
        deck: String,
    },
    /// Per-deck input trim, -12..+12 dB (0..=100, 50 = 0 dB).
    Gain {
        deck: String,
        value: f64,
    },
    /// Three-band EQ: high shelf, mid peak, low shelf (0..=100, 50 = flat).
    Hi {
        deck: String,
        value: f64,
    },
    Mid {
        deck: String,
        value: f64,
    },
    Low {
        deck: String,
        value: f64,
    },
    /// Bipolar sweep filter: below 50 low-pass, above 50 high-pass, exactly 50 = bypass.
    Filter {
        deck: String,
        value: f64,
    },
    Shutdown,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub command: Command,
}
pub fn deck_index(deck: &str) -> Result<usize, &'static str> {
    match deck {
        "A" => Ok(0),
        "B" => Ok(1),
        "C" => Ok(2),
        "D" => Ok(3),
        _ => Err("invalid_deck"),
    }
}
pub fn validate(command: &Command) -> Result<(), &'static str> {
    match command {
        Command::Status | Command::Shutdown => Ok(()),
        Command::Tempo { deck, rate, .. } => {
            deck_index(deck)?;
            if !rate.is_finite() || !(0.92..=1.08).contains(rate) {
                return Err("invalid_tempo");
            }
            Ok(())
        }
        Command::Master { deck } | Command::Sync { deck } => deck_index(deck).map(|_| ()),
        Command::Play { deck } | Command::Pause { deck } => deck_index(deck).map(|_| ()),
        Command::Seek { deck, position } => {
            deck_index(deck)?;
            if !position.is_finite() || *position < 0.0 || *position > MAX_DURATION {
                return Err("invalid_position");
            }
            Ok(())
        }
        Command::Level { deck, value } => {
            deck_index(deck)?;
            if !value.is_finite() || !(0.0..=100.0).contains(value) {
                return Err("invalid_level");
            }
            Ok(())
        }
        Command::Assign { deck, side } => {
            deck_index(deck)?;
            crate::fullkill::Side::parse(side).map(|_| ())
        }
        Command::Crossfader { value } => {
            if !value.is_finite() || !(0.0..=100.0).contains(value) {
                return Err("invalid_crossfader");
            }
            Ok(())
        }
        Command::Gain { deck, value }
        | Command::Hi { deck, value }
        | Command::Mid { deck, value }
        | Command::Low { deck, value }
        | Command::Filter { deck, value } => {
            deck_index(deck)?;
            if !value.is_finite() || !(0.0..=100.0).contains(value) {
                return Err("invalid_mixer_value");
            }
            Ok(())
        }
        Command::Load {
            deck,
            track_id,
            path,
            identity,
        } => {
            deck_index(deck)?;
            if !track_id.starts_with("local-")
                || track_id.len() != 42
                || !track_id[6..]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() || b == b'-')
            {
                return Err("invalid_track");
            }
            if path.is_empty()
                || path.len() > 4096
                || !std::path::Path::new(path).is_absolute()
                || identity.size == 0
                || identity.size > MAX_FILE
            {
                return Err("invalid_file");
            }
            Ok(())
        }
    }
}

pub fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unterminated_frame",
                ))
            };
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(available.len());
        if frame.len() + count > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame_too_large",
            ));
        }
        frame.extend_from_slice(&available[..count]);
        reader.consume(count);
        if frame.last() == Some(&b'\n') {
            return Ok(Some(frame));
        }
    }
}
pub fn checked_file(path: &str, identity: &Identity) -> Result<File, &'static str> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "file_unavailable")?;
    let m = file.metadata().map_err(|_| "file_unavailable")?;
    let modified = (m.mtime() as i128) * 1_000_000_000 + (m.mtime_nsec() as i128);
    if !m.is_file()
        || m.len() == 0
        || m.len() > MAX_FILE
        || m.dev().to_string() != identity.dev
        || m.ino().to_string() != identity.ino
        || m.len() != identity.size
        || modified.to_string() != identity.mtime_ns
    {
        return Err("file_changed");
    }
    Ok(file)
}
pub fn identity(file: &File) -> Identity {
    let m = file.metadata().unwrap();
    Identity {
        dev: m.dev().to_string(),
        ino: m.ino().to_string(),
        size: m.len(),
        mtime_ns: ((m.mtime() as i128) * 1_000_000_000 + (m.mtime_nsec() as i128)).to_string(),
    }
}
pub fn decode(file: File) -> Result<rodio::Decoder<std::io::BufReader<File>>, &'static str> {
    let decoder = Decoder::try_from(file).map_err(|_| "unsupported_or_corrupt_audio")?;
    let duration = decoder
        .total_duration()
        .ok_or("duration_unavailable")?
        .as_secs_f64();
    if !duration.is_finite() || duration <= 0.0 || duration > MAX_DURATION {
        return Err("unsupported_duration");
    }
    if decoder.channels().get() > 32 || !(8000..=384000).contains(&decoder.sample_rate().get()) {
        return Err("unsupported_audio_format");
    }
    Ok(decoder)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_cadence_is_bounded_and_idle_stays_inside_the_watchdog() {
        use std::time::Duration;
        assert_eq!(snapshot_interval(true, false), Duration::from_millis(16));
        assert_eq!(snapshot_interval(true, true), Duration::from_millis(16));
        assert_eq!(snapshot_interval(false, true), Duration::from_millis(50));
        assert_eq!(snapshot_interval(false, false), Duration::from_millis(250));
        for (playing, loading) in [(true, false), (false, true), (false, false)] {
            let interval = snapshot_interval(playing, loading);
            assert!(interval >= Duration::from_millis(8), "never a busy loop");
            assert!(interval < Duration::from_millis(1000), "well inside the 3 s host watchdog");
        }
        assert!(snapshot_interval(true, false) < snapshot_interval(false, true));
        assert!(snapshot_interval(false, true) < snapshot_interval(false, false));
    }


    #[test]
    fn recoverable_device_notices_do_not_disconnect_output() {
        assert!(!fatal_output_error(rodio::CpalErrorKind::RealtimeDenied));
        assert!(!fatal_output_error(rodio::CpalErrorKind::Xrun));
        assert!(!fatal_output_error(rodio::CpalErrorKind::DeviceChanged));
        assert!(fatal_output_error(rodio::CpalErrorKind::DeviceNotAvailable));
        assert!(fatal_output_error(rodio::CpalErrorKind::StreamInvalidated));
    }

    #[test]
    fn rejects_unavailable_and_nonfinite_commands() {
        assert!(
            validate(&Command::Seek {
                deck: "Z".into(),
                position: 2.0
            })
            .is_err()
        );
        assert!(
            validate(&Command::Seek {
                deck: "A".into(),
                position: f64::NAN
            })
            .is_err()
        );
        assert!(
            validate(&Command::Seek {
                deck: "A".into(),
                position: f64::INFINITY
            })
            .is_err()
        );
        assert!(
            validate(&Command::Level {
                deck: "A".into(),
                value: 101.0
            })
            .is_err()
        );
        assert!(validate(&Command::Crossfader { value: -1.0 }).is_err());
        for (command, ok) in [
            (Command::Gain { deck: "A".into(), value: 50.0 }, true),
            (Command::Hi { deck: "D".into(), value: 0.0 }, true),
            (Command::Mid { deck: "B".into(), value: 100.0 }, true),
            (Command::Low { deck: "C".into(), value: 12.5 }, true),
            (Command::Filter { deck: "A".into(), value: 50.0 }, true),
            (Command::Gain { deck: "E".into(), value: 50.0 }, false),
            (Command::Hi { deck: "A".into(), value: -0.1 }, false),
            (Command::Mid { deck: "A".into(), value: 100.1 }, false),
            (Command::Low { deck: "A".into(), value: f64::NAN }, false),
            (Command::Filter { deck: "A".into(), value: f64::INFINITY }, false),
        ] {
            assert_eq!(validate(&command).is_ok(), ok, "{command:?}");
        }
        assert!(
            validate(&Command::Seek {
                deck: "D".into(),
                position: 12.5
            })
            .is_ok()
        );
    }
    #[test]
    fn strict_semantic_schema() {
        for rate in [0.91, 1.09, f64::NAN, f64::INFINITY] {
            assert!(
                validate(&Command::Tempo {
                    deck: "A".into(),
                    rate,
                    pitch_lock: true
                })
                .is_err()
            );
        }
        for raw in [
            r#"{"id":"x","command":{"type":"tempo","deck":"A","rate":1,"pitchLock":true,"path":"bad"}}"#,
            r#"{"id":"x","command":{"type":"tempo","deck":"A","rate":1,"pitchLock":1}}"#,
            r#"{"id":"x","command":{"type":"sync","deck":"A","master":"B"}}"#,
        ] {
            assert!(serde_json::from_str::<Request>(raw).is_err());
        }

        assert!(
            serde_json::from_str::<Request>(
                r#"{"id":"x","command":{"type":"seek","deck":"A","position":true}}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Request>(
                r#"{"id":"x","command":{"type":"seek","deck":"A","position":2,"path":"other"}}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Request>(
                r#"{"id":"x","command":{"type":"shell","value":"arbitrary"}}"#
            )
            .is_err()
        );
    }
    #[test]
    fn mixer_commands_use_the_same_strict_semantic_shape() {
        for kind in ["gain", "hi", "mid", "low", "filter"] {
            let ok = format!(r#"{{"id":"x","command":{{"type":"{kind}","deck":"B","value":37.5}}}}"#);
            assert!(serde_json::from_str::<Request>(&ok).is_ok(), "{kind}");
            for bad in [
                format!(r#"{{"id":"x","command":{{"type":"{kind}","deck":"B","value":"37"}}}}"#),
                format!(r#"{{"id":"x","command":{{"type":"{kind}","deck":"B","value":1,"path":"/x"}}}}"#),
                format!(r#"{{"id":"x","command":{{"type":"{kind}","value":1}}}}"#),
            ] {
                assert!(serde_json::from_str::<Request>(&bad).is_err(), "{bad}");
            }
        }
    }
    #[test]
    fn bounds_frames_before_allocation() {
        let mut reader = io::Cursor::new(vec![b'x'; MAX_FRAME + 100]);
        assert!(read_frame(&mut reader).is_err());
        let mut reader = io::Cursor::new(b"{}\n{}\n".to_vec());
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"{}\n");
        assert!(read_frame(&mut reader).unwrap().is_some());
        assert!(read_frame(&mut reader).unwrap().is_none());
    }
    #[test]
    fn decodes_real_pcm_and_binds_the_selected_file() {
        let parent = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap().join("target"));
        std::fs::create_dir_all(&parent).unwrap();
        let path = parent.join(format!(
            "deckcraft-native-fixture-{}.wav",
            std::process::id()
        ));
        {
            let mut w = hound::WavWriter::create(
                &path,
                hound::WavSpec {
                    channels: 2,
                    sample_rate: 48000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for i in 0..96000 {
                let n =
                    ((i as f64 * 440.0 * std::f64::consts::TAU / 48000.0).sin() * 3000.0) as i16;
                w.write_sample(n).unwrap();
                w.write_sample(n).unwrap();
            }
            w.finalize().unwrap();
        }
        let f = File::open(&path).unwrap();
        let good = identity(&f);
        let decoder = decode(checked_file(path.to_str().unwrap(), &good).unwrap()).unwrap();
        assert!((decoder.total_duration().unwrap().as_secs_f64() - 2.0).abs() < 0.001);
        assert!(decoder.take(4000).any(|x| x.abs() > 0.01));
        let mut bad = good.clone();
        bad.ino = "0".into();
        assert!(checked_file(path.to_str().unwrap(), &bad).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn base64_matches_reference_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xfb, 0xff, 0xfe]), "+//+");
    }
    #[test]
    fn detail_resolution_is_bounded_and_scales_with_duration() {
        assert_eq!(detail_bin_count(f64::NAN), DETAIL_MIN_BINS);
        assert_eq!(detail_bin_count(1.0), DETAIL_MIN_BINS);
        assert_eq!(detail_bin_count(240.0), 15360);
        assert_eq!(detail_bin_count(MAX_DURATION), DETAIL_MAX_BINS);
        assert!(detail_bin_count(1e12) <= DETAIL_MAX_BINS);
        // Two 8-bit channels per bin stay far below the child-output safety limit.
        assert!(base64(&vec![255u8; DETAIL_MAX_BINS]).len() * 2 < 128 * 1024);
    }
    #[test]
    fn analysis_measures_silence_tone_and_a_single_transient_without_interpolation() {
        // 10 s mono at 1 kHz: 4 s silence, 4 s of +-0.5 square wave, one full-scale click at 7 s.
        let rate = 1000usize;
        let samples: Vec<f32> = (0..10 * rate)
            .map(|i| {
                if i == 7 * rate + 3 {
                    1.0
                } else if (4 * rate..8 * rate).contains(&i) {
                    if i % 2 == 0 { 0.5 } else { -0.5 }
                } else {
                    0.0
                }
            })
            .collect();
        let bins = detail_bin_count(10.0);
        let w = analyze_waveform(samples.iter().copied(), samples.len() as f64, bins, || false).unwrap();
        assert_eq!((w.peaks.len(), w.detail_peak.len(), w.detail_rms.len()), (PEAK_BINS, bins, bins));
        let at = |seconds: f64| ((seconds / 10.0) * bins as f64) as usize;
        assert!(w.detail_peak[..at(3.9)].iter().all(|v| *v == 0) && w.detail_rms[..at(3.9)].iter().all(|v| *v == 0), "silence is exactly 0");
        assert!(w.detail_peak[at(8.2)..].iter().all(|v| *v == 0));
        // Away from the click the tone reads 0.5 peak and 0.5 RMS (square wave).
        for i in at(4.2)..at(6.8) {
            assert_eq!(w.detail_peak[i], 128);
            assert_eq!(w.detail_rms[i], 128);
        }
        // The click occupies exactly its bin: full-scale peak, but a tiny RMS.
        let click = at(7.003);
        assert_eq!(w.detail_peak[click], 255);
        assert!(w.detail_rms[click] < 255 && w.detail_rms[click] >= 128);
        assert!(w.detail_peak[click - 3] == 128 && w.detail_peak[click + 3] == 128);
        assert!(w.detail_rms.iter().zip(&w.detail_peak).all(|(r, p)| r <= p));
        // The persisted peaks keep the original meaning (max absolute sample per 1/512).
        assert_eq!(w.peaks[0], 0.0);
        assert!(w.peaks[(7.003 / 10.0 * 512.0) as usize] == 1.0);
    }
    #[test]
    fn analysis_ignores_nonfinite_samples_clamps_and_can_be_cancelled() {
        let samples = vec![f32::NAN, f32::INFINITY, -4.0, 0.25, f32::NEG_INFINITY];
        let w = analyze_waveform(samples.iter().copied(), 5.0, 512, || false).unwrap();
        assert!(w.peaks.iter().all(|p| p.is_finite() && *p <= 1.0));
        assert_eq!(w.detail_peak.iter().max(), Some(&255));
        // Too few samples are valid (short decode): trailing bins stay silent, not interpolated.
        let short = analyze_waveform([0.5f32; 10].into_iter(), 1000.0, 512, || false).unwrap();
        assert!(short.detail_peak[300..].iter().all(|v| *v == 0));
        // A cancelled generation produces nothing.
        let mut calls = 0;
        assert!(analyze_waveform(vec![0.1f32; 100_000].into_iter(), 100_000.0, 512, || { calls += 1; calls > 1 }).is_none());
    }
    #[test]
    fn detail_does_not_fold_samples_past_the_expected_length_into_the_last_bin() {
        // The decode is twice as long as the (estimated) duration: the extra loud half is ignored by
        // the detail envelope, whose last bin stays silent, while the persisted peaks keep their meaning.
        let samples: Vec<f32> = (0..2000).map(|i| if i < 1000 { 0.0 } else { 0.9 }).collect();
        let w = analyze_waveform(samples.iter().copied(), 1000.0, 512, || false).unwrap();
        assert!(w.detail_peak.iter().all(|v| *v == 0) && w.detail_rms.iter().all(|v| *v == 0));
        assert_eq!(w.peaks[PEAK_BINS - 1], 0.9);
    }
    #[test]
    fn analysis_of_a_really_decoded_file_reports_its_loud_and_silent_regions() {
        let parent = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap().join("target"));
        std::fs::create_dir_all(&parent).unwrap();
        let path = parent.join(format!("deckcraft-wave-fixture-{}.wav", std::process::id()));
        {
            let mut w = hound::WavWriter::create(&path, hound::WavSpec { channels: 2, sample_rate: 8000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int }).unwrap();
            for i in 0..8000 * 6 {
                // 0-2 s silence, 2-4 s tone at about 0.5, 4-6 s quiet tone at about 0.05.
                let amp = if i < 16000 { 0.0 } else if i < 32000 { 0.5 } else { 0.05 };
                let v = ((i as f64 * 440.0 * std::f64::consts::TAU / 8000.0).sin() * amp * 32767.0) as i16;
                w.write_sample(v).unwrap();
                w.write_sample(v).unwrap();
            }
            w.finalize().unwrap();
        }
        let f = File::open(&path).unwrap();
        let id = identity(&f);
        let decoder = decode(checked_file(path.to_str().unwrap(), &id).unwrap()).unwrap();
        let duration = decoder.total_duration().unwrap().as_secs_f64();
        let count = duration * decoder.sample_rate().get() as f64 * decoder.channels().get() as f64;
        let bins = detail_bin_count(duration);
        let w = analyze_waveform(decoder, count, bins, || false).unwrap();
        let at = |seconds: f64| (seconds / duration * bins as f64) as usize;
        assert!(w.detail_peak[..at(1.9)].iter().all(|v| *v == 0));
        assert!(w.detail_peak[at(2.1)..at(3.9)].iter().all(|v| (120..=130).contains(v)));
        assert!(w.detail_peak[at(4.1)..at(5.9)].iter().all(|v| (10..=16).contains(v)));
        assert!(w.detail_rms[at(2.1)..at(3.9)].iter().all(|v| (80..=130).contains(v)));
        std::fs::remove_file(path).unwrap();
    }
}
