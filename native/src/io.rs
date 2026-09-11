//! Zero-copy I/O helpers.
//!
//! On Linux/macOS we'd use `io_uring` / `sendfile` here. On Windows we'd use
//! `TransmitFile`. Rust's `tokio::fs` already gives us a single buffer
//! hand-off (no intermediate copies), so the practical difference from a
//! naive `BufReader::read_to_end` is small — but the explicit allocation
//! of a chunk-sized buffer (matching the Merkle leaf size) avoids the
//! resize-then-copy growth pattern that V8/Node would otherwise incur.

use std::io;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// Read `len` bytes from `file` starting at `offset`. Allocates exactly one
/// buffer of the requested size — no intermediate Vec, no BufReader growth.
pub async fn pread(file: &mut File, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    file.seek(io::SeekFrom::Start(offset)).await?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Write `data` to `file` starting at `offset`. Single `write_all_at` call.
pub async fn pwrite(file: &mut File, offset: u64, data: &[u8]) -> io::Result<()> {
    file.seek(io::SeekFrom::Start(offset)).await?;
    file.write_all(data).await
}

/// Generate a synthetic benchmark file of `size_mb` megabytes.
///   - mode "random": pure pseudo-random bytes (worst case for compression).
///   - mode "mixed":  realistic mixed-media pattern — half zeros, half pseudo-random
///     in 4KB blocks (mimics compressed video / image payloads).
pub async fn generate_synthetic_file(path: &str, size_mb: u64, mode: &str) -> io::Result<()> {
    let total_bytes = size_mb * 1024 * 1024;
    let chunk_size = 4 * 1024 * 1024usize;
    let mut file = tokio::fs::File::create(path).await?;
    let mut written = 0u64;

    while written < total_bytes {
        let this_chunk = (total_bytes - written).min(chunk_size as u64) as usize;
        let mut buf = vec![0u8; this_chunk];
        if mode == "random" {
            // Pseudo-random fill — fast (xorshift32), not crypto-strong.
            let mut state: u32 = (written as u32).wrapping_add(0x9E3779B9);
            for chunk in buf.chunks_mut(4) {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let bytes = state.to_le_bytes();
                for (i, b) in chunk.iter_mut().enumerate() {
                    *b = bytes[i.min(3)];
                }
            }
        } else {
            // Mixed: alternating 4KB blocks of zeros and pseudo-random.
            for (i, block) in buf.chunks_mut(4096).enumerate() {
                if i % 2 == 0 {
                    // zeros — already zeroed by vec!
                } else {
                    let mut state: u32 = (i as u32).wrapping_mul(2654435761);
                    for word in block.chunks_mut(4) {
                        state ^= state << 13;
                        state ^= state >> 17;
                        state ^= state << 5;
                        let bytes = state.to_le_bytes();
                        for (j, b) in word.iter_mut().enumerate() {
                            *b = bytes[j.min(3)];
                        }
                    }
                }
            }
        }
        file.write_all(&buf).await?;
        written += this_chunk as u64;
    }
    file.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_pread_pwrite_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.bin");
        let mut file = tokio::fs::OpenOptions::new()
            .read(true).write(true).create(true).truncate(true)
            .open(&path).await.unwrap();
        let data = b"hello world!";
        pwrite(&mut file, 0, data).await.unwrap();
        let read = pread(&mut file, 0, data.len()).await.unwrap();
        assert_eq!(read, data);
    }

    #[tokio::test]
    async fn test_generate_synthetic_random() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("rand.bin");
        generate_synthetic_file(path.to_str().unwrap(), 1, "random").await.unwrap();
        let metadata = tokio::fs::metadata(&path).await.unwrap();
        assert_eq!(metadata.len(), 1024 * 1024);
    }

    #[tokio::test]
    async fn test_generate_synthetic_mixed() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mixed.bin");
        generate_synthetic_file(path.to_str().unwrap(), 1, "mixed").await.unwrap();
        let metadata = tokio::fs::metadata(&path).await.unwrap();
        assert_eq!(metadata.len(), 1024 * 1024);
    }
}
