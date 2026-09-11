/* lanbeam-core — TypeScript type declarations for the Rust napi-rs module.
 * Auto-generated manually to match the API in native/src/lib.rs.
 */

export interface MerkleResult {
  root: string;
  leaves: string[];
}

export interface QuicServerHandleJs {
  port: number;
  serverId: string;
}

export interface QuicServerOptions {
  port: number;
  certPem: Buffer;
  keyPem: Buffer;
}

export interface SendFileOptions {
  host: string;
  port: number;
  fileId: string;
  filePath: string;
  fileSize: number;
  chunkSize: number;
  maxParallelStreams: number;
}

export interface TransferCompleteJs {
  fileId: string;
  integrityOk: boolean;
  durationMs: number;
  averageThroughputMbps: number;
  chunkRetries: number;
  bytesTransferred: number;
}

export interface TransferProgressJs {
  fileId: string;
  bytesTransferred: number;
  totalBytes: number;
  throughputMbps: number;
  chunkRetries: number;
  etaMs: number;
  sparkline: number[];
}

export function hashChunk(buf: Buffer): string;
export function estimateEntropy(buf: Buffer): number;
export function shouldCompressChunk(buf: Buffer, alreadyCompressed: boolean): boolean;
export function compressChunk(buf: Buffer): Promise<Buffer>;
export function decompressChunk(buf: Buffer): Promise<Buffer>;
export function buildMerkle(hashes: string[]): MerkleResult;
export function verifyChunk(buf: Buffer, expectedHash: string): boolean;
export function startQuicServer(opts: QuicServerOptions): Promise<QuicServerHandleJs>;
export function sendFileQuic(opts: SendFileOptions): Promise<TransferCompleteJs>;
export function generateSyntheticBenchmarkFile(path: string, sizeMb: number, mode: string): Promise<void>;
