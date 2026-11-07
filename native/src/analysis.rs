//! Bounded offline onset analysis; constant grid only, not a downbeat classifier.
use crate::{Identity, checked_file, decode};
use rodio::Source;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeatGrid {
    pub bpm: f64,
    pub offset: f64,
    pub confidence: f64,
}
pub fn detect(envelope: &[f64], hz: f64) -> Option<BeatGrid> {
    if envelope.len() < (hz * 6.0) as usize {
        return None;
    }
    let max = envelope.iter().copied().fold(0.0f64, f64::max);
    let min = envelope.iter().copied().fold(f64::INFINITY, f64::min);
    if max < 1e-5 || max - min < max * 0.12 {
        return None;
    }
    let mut onset = vec![0.0; envelope.len()];
    let mut previous = 0.0;
    for (i, &x) in envelope.iter().enumerate() {
        onset[i] = (x - previous).max(0.0);
        previous = x;
    }
    let energy = onset.iter().map(|v| v * v).sum::<f64>();
    if energy < 1e-7 {
        return None;
    }
    let lo = (hz * 60.0 / 200.0) as usize;
    let hi = (hz * 60.0 / 60.0) as usize;
    let correlation = |lag: usize| {
        onset[lag..]
            .iter()
            .zip(&onset[..onset.len() - lag])
            .map(|(a, b)| a * b)
            .sum::<f64>()
            / energy
    };
    let mut best = (0, 0.0f64);
    for lag in lo..=hi {
        let c = correlation(lag);
        if c > best.1 {
            best = (lag, c);
        }
    }
    if best.1 < 0.32 {
        return None;
    }
    for lag in lo..best.0 {
        if correlation(lag) > best.1 * 0.94 {
            best = (lag, correlation(lag));
            break;
        }
    }
    let lag = best.0;
    let a = correlation(lag - 1);
    let b = correlation(lag);
    let c = correlation(lag + 1);
    let delta = if (a - 2.0 * b + c).abs() > 1e-12 {
        0.5 * (a - c) / (a - 2.0 * b + c)
    } else {
        0.0
    }
    .clamp(-0.5, 0.5);
    let period = (lag as f64 + delta) / hz;
    let mut phases = vec![0.0; lag];
    for (i, &v) in onset.iter().enumerate() {
        let p = ((i as f64 / hz) % period / period * lag as f64).round() as usize % lag;
        phases[p] += v;
    }
    let phase = phases
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))?
        .0;
    let offset = phase as f64 / lag as f64 * period;
    let aligned = onset
        .iter()
        .enumerate()
        .filter(|(i, _)| {
            let p = (*i as f64 / hz - offset).rem_euclid(period);
            p.min(period - p) < 0.04
        })
        .map(|(_, v)| v)
        .sum::<f64>();
    if aligned / onset.iter().sum::<f64>().max(1e-12) < 0.45 {
        return None;
    }
    if !(60.0..=200.0).contains(&(60.0 / period)) {
        return None;
    }
    Some(BeatGrid {
        bpm: (60.0 / period * 100.0).round() / 100.0,
        offset,
        confidence: b.min(1.0),
    })
}
pub fn inspect(path: &str, identity: &Identity) -> Result<serde_json::Value, &'static str> {
    inspect_with_cancel(path, identity, || false)
}
pub fn inspect_with_cancel(
    path: &str,
    identity: &Identity,
    cancel: impl Fn() -> bool,
) -> Result<serde_json::Value, &'static str> {
    let started = std::time::Instant::now();
    let mut decoder = decode(checked_file(path, identity)?)?;
    let duration = decoder.total_duration().unwrap().as_secs_f64();
    let channels = decoder.channels().get();
    let rate = decoder.sample_rate().get();
    let mut env = Vec::with_capacity(12000);
    let mut sum = 0.0;
    let mut count = 0usize;
    let bin = (rate as usize / 200).max(1);
    let mut saw = false;
    for frame in 0..(duration.min(60.0) * rate as f64) as usize {
        if frame % 4096 == 0 && (cancel() || started.elapsed() > std::time::Duration::from_secs(20))
        {
            return Err("analysis_cancelled");
        }

        let mut energy = 0.0;
        let mut n = 0;
        for _ in 0..channels {
            if let Some(s) = decoder.next() {
                energy += (s as f64).abs();
                n += 1;
                saw = true;
            }
        }
        if n == 0 {
            break;
        }
        sum += energy / channels as f64;
        count += 1;
        if count == bin {
            env.push(sum / bin as f64);
            sum = 0.0;
            count = 0;
        }
    }
    if !saw {
        return Err("unsupported_or_corrupt_audio");
    }
    let grid = detect(&env, rate as f64 / bin as f64);
    let artwork = crate::artwork::extract(path, identity);
    Ok(
        serde_json::json!({"duration":duration,"channels":channels,"sampleRate":rate,"analysisVersion":1,"beatGrid":grid,"artwork":artwork}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_clicks_and_offset() {
        for bpm in [75.0, 100.0, 120.0, 128.0, 174.0] {
            let mut e = vec![0.0; 12000];
            for n in 0..200 {
                let t = 0.17 + n as f64 * 60.0 / bpm;
                let i = (t * 200.0).round() as usize;
                if i < e.len() {
                    e[i] = 1.0;
                }
            }
            let g = detect(&e, 200.0).unwrap();
            assert!((g.bpm - bpm).abs() < 0.7, "{bpm}: {g:?}");
            let period = 60.0 / bpm;
            let d = (g.offset - 0.17).rem_euclid(period);
            assert!(d.min(period - d) < 0.02, "{g:?}");
        }
    }
    #[test]
    fn no_invented_grid() {
        assert!(detect(&vec![0.0; 12000], 200.0).is_none());
        assert!(detect(&vec![0.1; 12000], 200.0).is_none());
        assert!(detect(&vec![0.0; 400], 200.0).is_none());
    }
}
