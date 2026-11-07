//! Embedded JPEG/PNG only; decoded under explicit limits and re-encoded without tags.
use crate::{Identity, checked_file};
use std::io::Cursor;
use symphonia::core::{
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::{Limit, MetadataOptions, StandardVisualKey},
    probe::Hint,
};
fn thumbnail(data: &[u8]) -> Option<String> {
    if data.len() > 2 * 1024 * 1024 {
        return None;
    }
    let (pixels, w, h, channels) = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        let mut d = png::Decoder::new(Cursor::new(data));
        d.set_limits(png::Limits {
            bytes: 32 * 1024 * 1024,
        });
        d.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut r = d.read_info().ok()?;
        let info = r.info();
        if info.width == 0 || info.height == 0 || info.width > 2048 || info.height > 2048 {
            return None;
        }
        let mut b = vec![0; r.output_buffer_size()?];
        let i = r.next_frame(&mut b).ok()?;
        b.truncate(i.buffer_size());
        (
            b,
            i.width as usize,
            i.height as usize,
            i.color_type.samples(),
        )
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        use zune_jpeg::zune_core::{colorspace::ColorSpace, options::DecoderOptions};
        let mut d = zune_jpeg::JpegDecoder::new_with_options(
            Cursor::new(data),
            DecoderOptions::default()
                .jpeg_set_out_colorspace(ColorSpace::RGB)
                .set_max_width(2048)
                .set_max_height(2048),
        );
        d.decode_headers().ok()?;
        let i = d.info()?;
        let b = d.decode().ok()?;
        (b, i.width as usize, i.height as usize, 3)
    } else {
        return None;
    };
    if w == 0 || h == 0 || channels == 0 || pixels.len() < w * h * channels {
        return None;
    }
    let mut small = vec![0u8; 64 * 64 * 3];
    for y in 0..64 {
        for x in 0..64 {
            let p = ((y * h / 64) * w + x * w / 64) * channels;
            for c in 0..3 {
                small[(y * 64 + x) * 3 + c] = pixels[p + if channels < 3 { 0 } else { c }];
            }
        }
    }
    let mut encoded = Vec::new();
    {
        let mut e = png::Encoder::new(&mut encoded, 64, 64);
        e.set_color(png::ColorType::Rgb);
        e.set_depth(png::BitDepth::Eight);
        e.write_header().ok()?.write_image_data(&small).ok()?;
    }
    if encoded.len() > 16384 {
        return None;
    }
    const B: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::from("data:image/png;base64,");
    for ch in encoded.chunks(3) {
        let a = ch[0] as usize;
        let b = *ch.get(1).unwrap_or(&0) as usize;
        let c = *ch.get(2).unwrap_or(&0) as usize;
        out.push(B[a >> 2] as char);
        out.push(B[((a & 3) << 4) | (b >> 4)] as char);
        out.push(if ch.len() > 1 {
            B[((b & 15) << 2) | (c >> 6)] as char
        } else {
            '='
        });
        out.push(if ch.len() > 2 { B[c & 63] as char } else { '=' });
    }
    Some(out)
}
pub fn extract(path: &str, identity: &Identity) -> Option<String> {
    let file = checked_file(path, identity).ok()?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let opts = MetadataOptions {
        limit_metadata_bytes: Limit::Maximum(2 * 1024 * 1024),
        limit_visual_bytes: Limit::Maximum(2 * 1024 * 1024),
    };
    let mut result = symphonia::default::get_probe()
        .format(&Hint::new(), stream, &FormatOptions::default(), &opts)
        .ok()?;
    let mut visuals = Vec::new();
    if let Some(m) = result.metadata.get().as_ref().and_then(|m| m.current()) {
        visuals.extend_from_slice(m.visuals());
    }
    if let Some(m) = result.format.metadata().current() {
        visuals.extend_from_slice(m.visuals());
    }
    visuals.sort_by_key(|v| v.usage != Some(StandardVisualKey::FrontCover));
    visuals.iter().find_map(|v| thumbnail(&v.data))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_and_too_large() {
        assert!(thumbnail(b"<svg/>").is_none());
        assert!(thumbnail(&vec![0; 2 * 1024 * 1024 + 1]).is_none());
    }
    #[test]
    fn strips_metadata_and_bounds_thumbnail() {
        let mut v = Vec::new();
        {
            let mut e = png::Encoder::new(&mut v, 2, 2);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            e.write_header()
                .unwrap()
                .write_image_data(&[255; 12])
                .unwrap();
        }
        let t = thumbnail(&v).unwrap();
        assert!(t.starts_with("data:image/png;base64,iVBOR"));
        assert!(t.len() < 22000);
    }
}
