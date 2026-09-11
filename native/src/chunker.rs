//! Adaptive chunking — file is split into N fixed-size chunks (default 4MB)
//! matching the BLAKE3 leaf size of the Merkle tree.
//!
//! Chunking at 2–4MB (never below 1MB) is the sweet spot for high-bandwidth
//! WiFi links: small enough to pipeline across many QUIC streams without
//! blocking, large enough that per-chunk overhead (hashing, compression
//! decision, stream setup) is negligible vs the wire time.

use std::path::Path;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub const DEFAULT_CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4 MB
pub const MIN_CHUNK_SIZE: usize = 1024 * 1024;          // 1 MB lower bound
pub const MAX_CHUNK_SIZE: usize = 16 * 1024 * 1024;     // 16 MB upper bound

#[derive(Debug, Clone)]
pub struct ChunkSpec {
    pub index: u32,
    pub offset: u64,
    pub length: usize,
}

pub fn clamp_chunk_size(mb: usize) -> usize {
    let bytes = mb.saturating_mul(1024 * 1024);
    bytes.clamp(MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
}

/// Pre-compute chunk specs (index, offset, length) for a file of `total` bytes
/// at `chunk_size` per chunk. Pure function — no I/O — so the manifest
/// builder can call it without touching the disk.
pub fn plan_chunks(total: u64, chunk_size: usize) -> Vec<ChunkSpec> {
    if total == 0 {
        return vec![ChunkSpec { index: 0, offset: 0, length: 0 }];
    }
    let n = ((total + chunk_size as u64 - 1) / chunk_size as u64) as u32;
    (0..n)
        .map(|i| {
            let offset = i as u64 * chunk_size as u64;
            let remaining = total - offset;
            let length = (remaining as usize).min(chunk_size);
            ChunkSpec { index: i, offset, length }
        })
        .collect()
}

/// Read exactly one chunk from the file at the given offset.
/// Uses a single buffer hand-off — no intermediate copies.
pub async fn read_chunk(file: &mut File, spec: &ChunkSpec) -> std::io::Result<Vec<u8>> {
    file.seek(std::io::SeekFrom::Start(spec.offset)).await?;
    let mut buf = vec![0u8; spec.length];
    file.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Zero-copy-ish file read iterator: opens the file once and streams chunks
/// in order. Caller is responsible for hashing/compression/network send.
pub struct ChunkReader {
    file: File,
    specs: Vec<ChunkSpec>,
    next: usize,
}

impl ChunkReader {
    pub async fn open(path: &Path, chunk_size: usize) -> std::io::Result<Self> {
        let file = File::open(path).await?;
        let total = file.metadata().await?.len();
        let specs = plan_chunks(total, chunk_size);
        Ok(Self { file, specs, next: 0 })
    }

    pub fn total_chunks(&self) -> usize { self.specs.len() }

    pub async fn next_chunk(&mut self) -> std::io::Result<Option<(ChunkSpec, Vec<u8>)>> {
        if self.next >= self.specs.len() {
            return Ok(None);
        }
        let spec = self.specs[self.next].clone();
        let buf = read_chunk(&mut self.file, &spec).await?;
        self.next += 1;
        Ok(Some((spec, buf)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plan_chunks_small() {
        let specs = plan_chunks(100, 30);
        assert_eq!(specs.len(), 4); // 30 + 30 + 30 + 10
        assert_eq!(specs[3].length, 10);
    }

    #[test]
    fn test_plan_chunks_exact() {
        let specs = plan_chunks(90, 30);
        assert_eq!(specs.len(), 3);
        assert!(specs.iter().all(|s| s.length == 30));
    }

    #[test]
    fn test_clamp() {
        assert_eq!(clamp_chunk_size(0), MIN_CHUNK_SIZE);
        assert_eq!(clamp_chunk_size(4), 4 * 1024 * 1024);
        assert_eq!(clamp_chunk_size(100), MAX_CHUNK_SIZE);
    }
}
