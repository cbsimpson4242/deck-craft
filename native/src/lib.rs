pub mod stream;
use rodio::{Decoder, Source};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub const MAX_FRAME: usize = 16 * 1024;
pub const MAX_FILE: u64 = 512 * 1024 * 1024;
pub const MAX_DURATION: f64 = 7200.0;
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
    Crossfader {
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
        Command::Crossfader { value } => {
            if !value.is_finite() || !(0.0..=100.0).contains(value) {
                return Err("invalid_crossfader");
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
}
