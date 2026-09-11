//! LANBeam native core.
//!
//! Exposes a small async API surface to the Electron main process via napi-rs:
//!
//!   - `hash_chunk(buf)`                : BLAKE3 hash of a chunk (hex)
//!   - `estimate_entropy(buf)`         : sampled Shannon entropy (bits/byte)
//!   - `should_compress_chunk(buf, ext_already_compressed)` : bool
//!   - `compress_chunk(buf)`            : zstd level-1 (Vec<u8>)
//!   - `decompress_chunk(buf)`          : zstd decompress (Vec<u8>)
//!   - `build_merkle(hashes)`           : { root, leaves }
//!   - `verify_chunk(buf, expected)`    : bool
//!   - `start_quic_server(opts)`        : { port, close() }
//!   - `send_file_quic(opts)`            : TransferComplete
//!   - `generate_synthetic_benchmark_file(path, size_mb, mode)`
//!
//! Heavy-lift modules: `chunker`, `compression`, `merkle`, `transport`, `io`.

#[macro_use]
extern crate napi_derive;

pub mod chunker;
pub mod compression;
pub mod merkle;
pub mod transport;
pub mod io;

use napi::{bindgen_prelude::*, Result as NapiResult, Task};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
#[napi]
pub fn hash_chunk(buf: Buffer) -> String {
    let h = blake3::hash(buf.as_ref());
    h.to_hex().to_string()
}

#[napi]
pub fn estimate_entropy(buf: Buffer) -> f64 {
    compression::sampled_entropy(buf.as_ref())
}

#[napi]
pub fn should_compress_chunk(buf: Buffer, already_compressed: bool) -> bool {
    if already_compressed {
        return false;
    }
    compression::should_compress(buf.as_ref())
}

// ---------------------------------------------------------------------------
// Compression (async — zstd can be CPU-heavy on big chunks)
// ---------------------------------------------------------------------------
#[napi]
pub struct CompressTask {
    pub buf: Vec<u8>,
}

#[napi]
impl Task for CompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        compression::compress_zstd(&self.buf, 1)
            .map_err(|e| Error::from_reason(format!("zstd compress: {e}")))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        env.create_buffer_with_data(output).map(|b| b.into())
    }
}

#[napi]
pub fn compress_chunk(buf: Buffer) -> AsyncTask<CompressTask> {
    AsyncTask::new(CompressTask { buf: buf.to_vec() })
}

#[napi]
pub struct DecompressTask {
    pub buf: Vec<u8>,
}

#[napi]
impl Task for DecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        compression::decompress_zstd(&self.buf)
            .map_err(|e| Error::from_reason(format!("zstd decompress: {e}")))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        env.create_buffer_with_data(output).map(|b| b.into())
    }
}

#[napi]
pub fn decompress_chunk(buf: Buffer) -> AsyncTask<DecompressTask> {
    AsyncTask::new(DecompressTask { buf: buf.to_vec() })
}

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------
#[napi(object)]
pub struct MerkleResult {
    pub root: String,
    pub leaves: Vec<String>,
}

#[napi]
pub fn build_merkle(hashes: Vec<String>) -> MerkleResult {
    let (root, leaves) = merkle::build(&hashes);
    MerkleResult {
        root: root.unwrap_or_default(),
        leaves: leaves.into_iter().map(|h| h.to_hex().to_string()).collect(),
    }
}

#[napi]
pub fn verify_chunk(buf: Buffer, expected_hash: String) -> bool {
    let actual = blake3::hash(buf.as_ref());
    let actual_hex = actual.to_hex().to_string();
    // Constant-time comparison
    if actual_hex.len() != expected_hash.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (a, b) in actual_hex.bytes().zip(expected_hash.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// QUIC server / file sender — async tasks
// ---------------------------------------------------------------------------
#[napi(object)]
pub struct QuicServerHandleJs {
    pub port: u16,
    // Opaque id — closing happens via stop_quic_server(id)
    pub server_id: String,
}

#[napi(object)]
pub struct TransferCompleteJs {
    pub file_id: String,
    pub integrity_ok: bool,
    pub duration_ms: f64,
    pub average_throughput_mbps: f64,
    pub chunk_retries: i32,
    pub bytes_transferred: f64,
}

#[napi(object)]
pub struct TransferProgressJs {
    pub file_id: String,
    pub bytes_transferred: f64,
    pub total_bytes: f64,
    pub throughput_mbps: f64,
    pub chunk_retries: i32,
    pub eta_ms: f64,
    pub sparkline: Vec<f64>,
}

#[napi(object)]
pub struct QuicServerOptions {
    pub port: u16,
    pub cert_pem: Buffer,
    pub key_pem: Buffer,
}

#[napi(object)]
pub struct SendFileOptions {
    pub host: String,
    pub port: u16,
    pub file_id: String,
    pub file_path: String,
    pub file_size: f64,
    pub chunk_size: f64,
    pub max_parallel_streams: i32,
}

// Tasks
pub struct StartQuicServerTask {
    pub opts: QuicServerOptions,
}

#[napi]
impl Task for StartQuicServerTask {
    type Output = QuicServerHandleJs;
    type JsValue = QuicServerHandleJs;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| Error::from_reason(format!("tokio rt: {e}")))?;
        let (port, server_id) = rt.block_on(async {
            transport::start_quic_server(self.opts.port, self.opts.cert_pem.as_ref(), self.opts.key_pem.as_ref())
                .await
                .map_err(|e| Error::from_reason(format!("quic server: {e}")))
        })?;
        Ok(QuicServerHandleJs { port, server_id })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn start_quic_server(opts: QuicServerOptions) -> AsyncTask<StartQuicServerTask> {
    AsyncTask::new(StartQuicServerTask { opts })
}

pub struct SendFileQuicTask {
    pub opts: SendFileOptions,
}

#[napi]
impl Task for SendFileQuicTask {
    type Output = TransferCompleteJs;
    type JsValue = TransferCompleteJs;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| Error::from_reason(format!("tokio rt: {e}")))?;
        let result = rt.block_on(async {
            transport::send_file_quic(
                &self.opts.host,
                self.opts.port,
                &self.opts.file_id,
                &self.opts.file_path,
                self.opts.file_size as u64,
                self.opts.chunk_size as usize,
                self.opts.max_parallel_streams.max(1) as usize,
            ).await
        }).map_err(|e| Error::from_reason(format!("send_file_quic: {e}")))?;
        Ok(TransferCompleteJs {
            file_id: result.file_id,
            integrity_ok: result.integrity_ok,
            duration_ms: result.duration_ms,
            average_throughput_mbps: result.average_throughput_mbps,
            chunk_retries: result.chunk_retries,
            bytes_transferred: result.bytes_transferred as f64,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn send_file_quic(opts: SendFileOptions) -> AsyncTask<SendFileQuicTask> {
    AsyncTask::new(SendFileQuicTask { opts })
}

// ---------------------------------------------------------------------------
// Benchmark file generator
// ---------------------------------------------------------------------------
pub struct GenBenchmarkFileTask {
    pub path: String,
    pub size_mb: u64,
    pub mode: String,
}

#[napi]
impl Task for GenBenchmarkFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> NapiResult<Self::Output> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| Error::from_reason(format!("tokio rt: {e}")))?;
        rt.block_on(async {
            io::generate_synthetic_file(&self.path, self.size_mb, &self.mode)
                .await
                .map_err(|e| Error::from_reason(format!("gen benchmark: {e}")))
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn generate_synthetic_benchmark_file(path: String, size_mb: u64, mode: String) -> AsyncTask<GenBenchmarkFileTask> {
    AsyncTask::new(GenBenchmarkFileTask { path, size_mb, mode })
}
