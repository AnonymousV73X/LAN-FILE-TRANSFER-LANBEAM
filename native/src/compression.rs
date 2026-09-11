//! Adaptive per-chunk compression.
//!
//! For each chunk, run a fast entropy/compressibility check before deciding
//! to compress. Skip compression entirely for already-compressed formats
//! (mp4, mkv, jpg, png, zip, etc.). Use zstd at level 1–3 — speed > ratio
//! since the WiFi link, not the CPU, is the bottleneck once decompressed.

use std::io::Cursor;

/// Sampled Shannon entropy estimate (bits/byte, 0..=8) using a 64KB sample.
/// Below ~7.5 bits/byte, zstd level 1 typically shrinks the data.
pub fn sampled_entropy(buf: &[u8]) -> f64 {
    if buf.is_empty() {
        return 0.0;
    }
    let sample = if buf.len() > 65536 { &buf[..65536] } else { buf };
    let mut counts = [0u32; 256];
    for &b in sample {
        counts[b as usize] += 1;
    }
    let n = sample.len() as f64;
    let mut h = 0.0f64;
    for &c in counts.iter() {
        if c == 0 {
            continue;
        }
        let p = c as f64 / n;
        h -= p * p.log2();
    }
    h
}

pub const ENTROPY_COMPRESS_THRESHOLD: f64 = 7.5; // bits/byte

pub fn should_compress(buf: &[u8]) -> bool {
    sampled_entropy(buf) < ENTROPY_COMPRESS_THRESHOLD
}

pub fn compress_zstd(input: &[u8], level: i32) -> std::io::Result<Vec<u8>> {
    // zstd::encode_all takes a reader + level; wrap our slice in a Cursor.
    let mut out = Vec::with_capacity(input.len() / 2);
    let mut reader = Cursor::new(input);
    zstd::stream::Encoder::new(&mut out, level)?.finish()?;
    Ok(out)
}

pub fn decompress_zstd(input: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 4);
    zstd::stream::Decoder::new(Cursor::new(input))?.read_to_end(&mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_entropy_low_for_zeros() {
        let zeros = vec![0u8; 65536];
        assert!(sampled_entropy(&zeros) < 0.1);
    }

    #[test]
    fn test_entropy_high_for_random() {
        // Pseudo-random — high entropy
        let mut buf = vec![0u8; 65536];
        for (i, b) in buf.iter_mut().enumerate() {
            *b = (i.wrapping_mul(2654435761) & 0xFF) as u8;
        }
        assert!(sampled_entropy(&buf) > 7.5);
    }

    #[test]
    fn test_compression_roundtrip() {
        let input = b"hello world ".repeat(1000);
        let compressed = compress_zstd(&input, 1).unwrap();
        assert!(compressed.len() < input.len());
        let decompressed = decompress_zstd(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }
}
