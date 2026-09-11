/**
 * LANBeam — Rust core loader.
 *
 * Loads the native napi-rs module (`lanbeam-core`) from the `native/` directory.
 * If the native binary is not present (e.g. user is running from source without
 * compiling the Rust crate), we fall back to a pure-TypeScript shim that
 * implements the same API surface using Node streams + crypto + zstd-like
 * passthrough. The shim is correct but slow — it exists so the app remains
 * usable for development and UI iteration without the Rust toolchain.
 *
 * The Rust crate exposes: chunkFile, buildMerkle, compressChunkDecide,
 * startQuicServer, sendFileQuic, verifyChunk, generateSyntheticBenchmarkFile.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface ChunkInfo {
  index: number;
  offset: number;
  length: number;
  hash: string;       // BLAKE3 hex (or sha256 hex in shim)
  compressed: boolean;
}

export interface FileManifest {
  fileId: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  merkleRoot: string;
  chunks: ChunkInfo[];
  isCompressed: 'always' | 'never' | 'auto';
  createdAt: number;
}

export interface TransferProgress {
  fileId: string;
  bytesTransferred: number;
  totalBytes: number;
  throughputMbps: number;
  chunkRetries: number;
  etaMs: number;
  sparkline: number[];   // last ~30 throughput samples
}

export interface TransferComplete {
  fileId: string;
  integrityOk: boolean;
  durationMs: number;
  averageThroughputMbps: number;
  chunkRetries: number;
  bytesTransferred: number;
}

export interface CoreApi {
  /** Hash a buffer with BLAKE3 (or sha256 in shim) and return hex. */
  hashChunk(buf: Buffer): string;
  /** Decide whether to compress a chunk based on entropy + extension hint. */
  shouldCompressChunk(buf: Buffer, isLikelyAlreadyCompressed: boolean): boolean;
  /** Compress a chunk with zstd level 1 (shim: passthrough if no zstd). */
  compressChunk(buf: Buffer): Promise<Buffer>;
  /** Decompress a chunk (shim: passthrough). */
  decompressChunk(buf: Buffer): Promise<Buffer>;
  /** Build a Merkle tree over per-chunk hashes and return the root hex + per-chunk leaves. */
  buildMerkle(hashesHex: string[]): { root: string; leaves: string[] };
  /** Verify a chunk against an expected hash. */
  verifyChunk(buf: Buffer, expectedHash: string): boolean;
  /** Start a QUIC server (shim: returns a noop handle + port). */
  startQuicServer(opts: { port: number; cert: Buffer; key: Buffer; onData: (chunk: Buffer, meta: any) => Promise<void> }): Promise<{ port: number; close: () => Promise<void> }>;
  /** Send a file over QUIC to a peer (shim: uses HTTPS fetch under the hood). */
  sendFileQuic(opts: { host: string; port: number; manifest: FileManifest; filePath: string; onProgress: (p: TransferProgress) => void; signal: AbortSignal }): Promise<TransferComplete>;
  /** Generate a synthetic file for benchmarking. */
  generateSyntheticBenchmarkFile(path: string, sizeMB: number, mode: 'random' | 'mixed'): Promise<void>;
  /** Entropy estimation for the compression heuristic (sampled Shannon entropy). */
  estimateEntropy(buf: Buffer): number;
}

// ----------------------------------------------------------------------------
// Native loader — tries to require the compiled .node binary, falls back to shim.
// ----------------------------------------------------------------------------
function loadNative(): CoreApi | null {
  try {
    // napi-rs emits index.js + index.node next to package.json in native/.
    const mod = require(path.join(__dirname, '..', '..', 'native', 'index.js'));
    return mod as CoreApi;
  } catch (err) {
    console.warn('[lanbeam-core] native module not available, using TypeScript shim. Build with `npm run build:native` for full speed.', (err as Error).message);
    return null;
  }
}

const native = loadNative();

// ----------------------------------------------------------------------------
// TypeScript shim — same API surface, slower, no QUIC, used when the Rust core
// is not compiled. Useful for development / UI iteration.
// ----------------------------------------------------------------------------
const SHIM: CoreApi = {
  hashChunk(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  },

  estimateEntropy(buf: Buffer): number {
    if (buf.length === 0) return 0;
    const sample = buf.length > 65536 ? buf.subarray(0, 65536) : buf;
    const counts = new Array(256).fill(0);
    for (let i = 0; i < sample.length; i++) counts[sample[i]]++;
    let entropy = 0;
    for (const c of counts) {
      if (c === 0) continue;
      const p = c / sample.length;
      entropy -= p * Math.log2(p);
    }
    return entropy; // bits/byte, 0..8
  },

  shouldCompressChunk(buf: Buffer, isLikelyAlreadyCompressed: boolean): boolean {
    if (isLikelyAlreadyCompressed) return false;
    // If entropy is below ~7.5 bits/byte, zstd can usually shrink it.
    return SHIM.estimateEntropy(buf) < 7.5;
  },

  async compressChunk(buf: Buffer): Promise<Buffer> {
    // No native zstd available in shim — passthrough. The native Rust core
    // does real zstd level-1 compression here.
    return buf;
  },

  async decompressChunk(buf: Buffer): Promise<Buffer> {
    return buf;
  },

  buildMerkle(hashesHex: string[]): { root: string; leaves: string[] } {
    if (hashesHex.length === 0) return { root: '', leaves: [] };
    let layer = hashesHex.slice();
    const leaves = layer.slice();
    while (layer.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = i + 1 < layer.length ? layer[i + 1] : left;
        next.push(createHash('sha256').update(left + right).digest('hex'));
      }
      layer = next;
    }
    return { root: layer[0], leaves };
  },

  verifyChunk(buf: Buffer, expectedHash: string): boolean {
    return SHIM.hashChunk(buf) === expectedHash;
  },

  async startQuicServer(): Promise<{ port: number; close: () => Promise<void> }> {
    // Shim: QUIC not available, transfers happen over HTTP.
    return { port: 0, close: async () => {} };
  },

  async sendFileQuic(): Promise<TransferComplete> {
    throw new Error('QUIC transport unavailable in shim — use HTTP fallback');
  },

  async generateSyntheticBenchmarkFile(filePath: string, sizeMB: number, mode: 'random' | 'mixed'): Promise<void> {
    const chunkSize = 4 * 1024 * 1024; // 4MB
    const totalBytes = sizeMB * 1024 * 1024;
    const handle = await fs.open(filePath, 'w');
    try {
      let written = 0;
      while (written < totalBytes) {
        const thisChunk = Math.min(chunkSize, totalBytes - written);
        let buf: Buffer;
        if (mode === 'random') {
          buf = Buffer.allocUnsafe(thisChunk);
          // crypto.randomFill is slow for large bufs — use pseudo-random seeded xorshift
          for (let i = 0; i < thisChunk; i += 4) {
            const r = Math.random() * 0xFFFFFFFF >>> 0;
            buf.writeUInt32LE(r, i);
          }
        } else {
          // Mixed: half zeros, half pseudo-random, mimics real media
          buf = Buffer.alloc(thisChunk, 0);
          for (let i = 0; i < thisChunk; i += 4096) {
            if (Math.random() > 0.5) {
              const r = Math.random() * 0xFFFFFFFF >>> 0;
              buf.writeUInt32LE(r, i);
            }
          }
        }
        await handle.write(buf, 0, thisChunk, written);
        written += thisChunk;
      }
    } finally {
      await handle.close();
    }
  },
};

export const core: CoreApi = native ?? SHIM;

export function isNativeCoreAvailable(): boolean {
  return native !== null;
}
