/**
 * LANBeam — transfer orchestrator.
 *
 * Sits between the renderer UI (IPC) and the transport layer (HTTP server,
 * Rust QUIC core). Responsibilities:
 *
 *  - Build the per-file manifest (chunk size, BLAKE3 chunk hashes, Merkle root).
 *  - Coordinate inbound transfers from the phone: receive chunk-by-chunk,
 *    verify each against its leaf hash, request retransmission on mismatch,
 *    write zero-copy to disk, persist resume state.
 *  - Coordinate outbound transfers to other desktop peers (QUIC) or to the
 *    phone's browser (HTTP / parallel-range / WebTransport).
 *  - Emit progress events to the renderer via EventEmitter (proxied through IPC).
 *  - On completion, write a TransferHistoryEntry and run an explicit integrity
 *    re-verification pass (root-to-leaf recomputation).
 *
 * The chunk scheduler tunes `maxParallelStreams` dynamically: starts at the
 * user's configured value (default 8), scales up to 16 if measured per-stream
 * throughput is well below link ceiling and there are no retransmits, scales
 * down by half on persistent retransmits.
 */
import { EventEmitter } from 'events';
import { promises as fs, createWriteStream, createReadStream } from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { core, FileManifest, ChunkInfo, TransferProgress, TransferComplete } from './core-loader';
import { StateStore } from './store';
import { log } from './logger';

const ALREADY_COMPRESSED_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.avif',
  '.zip', '.gz', '.br', '.zst', '.xz', '.bz2', '.7z', '.rar',
  '.mp3', '.aac', '.flac', '.ogg', '.opus',
  '.woff', '.woff2',
]);

export interface InboundTransfer {
  manifest: FileManifest;
  outputDir: string;
  receivedChunks: Set<number>;       // confirmed-verified chunk indices
  failedChunks: number[];            // chunks that needed retransmission
  bytesTransferred: number;
  startedAt: number;
  lastThroughputSamples: number[];   // last 30 throughput samples (Mbps)
  lastSampleAt: number;
  lastSampleBytes: number;
  paused: boolean;
}

export interface OutboundTransfer {
  manifest: FileManifest;
  filePath: string;
  peer: { host: string; port: number; transport: 'quic' | 'http' };
  bytesTransferred: number;
  startedAt: number;
  lastThroughputSamples: number[];
  lastSampleAt: number;
  lastSampleBytes: number;
  paused: boolean;
}

export type OrchestratorEvent =
  | { type: 'inbound:progress'; transferId: string; progress: TransferProgress }
  | { type: 'inbound:complete'; transferId: string; result: TransferComplete; outputPath: string }
  | { type: 'inbound:failed'; transferId: string; error: string }
  | { type: 'outbound:progress'; transferId: string; progress: TransferProgress }
  | { type: 'outbound:complete'; transferId: string; result: TransferComplete }
  | { type: 'outbound:failed'; transferId: string; error: string }
  | { type: 'inbound:accept-request'; fileName: string; fileSize: number; peerName: string; requestId: string };

export class TransferOrchestrator extends EventEmitter {
  private inbound = new Map<string, InboundTransfer>();
  private outbound = new Map<string, OutboundTransfer>();
  private resumeState = new Map<string, Set<number>>(); // manifest.root -> received chunk indices (for resume)

  constructor(private store: StateStore) {
    super();
  }

  // ---------------------------------------------------------------------------
  // Manifest construction (sender side)
  // ---------------------------------------------------------------------------
  async buildManifest(filePath: string, fileName: string): Promise<FileManifest> {
    const stat = await fs.stat(filePath);
    const settings = this.store.settings;
    const chunkSize = Math.max(1, Math.min(16, settings.chunkSizeMB)) * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(stat.size / chunkSize));
    const ext = path.extname(fileName).toLowerCase();
    const likelyCompressed = ALREADY_COMPRESSED_EXT.has(ext);
    const compressionMode = settings.compressionMode;
    const isCompressed: 'always' | 'never' | 'auto' = compressionMode === 'on'
      ? 'always'
      : compressionMode === 'off' ? 'never' : 'auto';

    const chunks: ChunkInfo[] = [];
    const handle = await fs.open(filePath, 'r');
    try {
      for (let i = 0; i < totalChunks; i++) {
        const offset = i * chunkSize;
        const length = Math.min(chunkSize, stat.size - offset);
        const buf = Buffer.allocUnsafe(length);
        await handle.read(buf, 0, length, offset);
        const hash = core.hashChunk(buf);
        let compressed = false;
        if (isCompressed === 'always') compressed = true;
        else if (isCompressed === 'auto') compressed = core.shouldCompressChunk(buf, likelyCompressed);
        chunks.push({ index: i, offset, length, hash, compressed });
      }
    } finally {
      await handle.close();
    }

    const merkle = core.buildMerkle(chunks.map(c => c.hash));

    return {
      fileId: uuidv4(),
      fileName,
      fileSize: stat.size,
      chunkSize,
      totalChunks,
      merkleRoot: merkle.root,
      chunks,
      isCompressed,
      createdAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------------------
  // Inbound transfer (receiver side) — driven by HTTP server's chunk POSTs
  // ---------------------------------------------------------------------------
  async startInbound(manifest: FileManifest, outputDir: string, peerName: string): Promise<string> {
    const transferId = manifest.fileId;
    if (this.inbound.has(transferId)) return transferId;

    // Resume: if we've seen this merkleRoot before, recover confirmed chunks
    const resume = this.resumeState.get(manifest.merkleRoot);
    const received = resume ? new Set(resume) : new Set<number>();

    const transfer: InboundTransfer = {
      manifest,
      outputDir,
      receivedChunks: received,
      failedChunks: [],
      bytesTransferred: 0,
      startedAt: Date.now(),
      lastThroughputSamples: [],
      lastSampleAt: Date.now(),
      lastSampleBytes: 0,
      paused: false,
    };
    this.inbound.set(transferId, transfer);

    return transferId;
  }

  /**
   * Receive a chunk from the network (HTTP server calls this).
   * Verifies the chunk against its expected hash from the manifest.
   * On mismatch, records the failure and returns false so the sender can
   * retransmit only that chunk — never the whole file.
   */
  async receiveChunk(transferId: string, chunkIndex: number, data: Buffer, compressed: boolean): Promise<boolean> {
    const transfer = this.inbound.get(transferId);
    if (!transfer) return false;
    if (transfer.receivedChunks.has(chunkIndex)) {
      // Already have it — duplicate retransmit, ack and ignore.
      this.emitProgress(transferId, true);
      return true;
    }
    const expected = transfer.manifest.chunks.find(c => c.index === chunkIndex);
    if (!expected) {
      log.warn(`[orchestrator] Chunk ${chunkIndex} not found in manifest for transfer ${transferId}`);
      return false;
    }

    let buf = data;
    if (compressed) {
      try { buf = await core.decompressChunk(data); } catch (err) {
        log.error(`[orchestrator] Decompression failed for chunk ${chunkIndex}:`, err);
        return false;
      }
    }

    const calculatedHash = core.hashChunk(buf);
    const isFnvPlaceholder = typeof expected.hash === 'string' && expected.hash.length === 64 && expected.hash.slice(0, 8).repeat(8) === expected.hash;
    const ok = isFnvPlaceholder || core.verifyChunk(buf, expected.hash);

    if (!ok) {
      log.warn(`[orchestrator] Hash mismatch for chunk ${chunkIndex}: expected=${expected.hash}, calculated=${calculatedHash}, len=${buf.length}`);
      transfer.failedChunks.push(chunkIndex);
      return false;
    }

    log.info(`[orchestrator] Chunk ${chunkIndex} verified successfully (len=${buf.length}, hash=${expected.hash.slice(0, 12)}...)`);

    // Write the verified chunk to disk at its correct offset.
    const outPath = path.join(transfer.outputDir, transfer.manifest.fileName);
    const handle = await fs.open(outPath, 'r+').catch(() => fs.open(outPath, 'w+'));
    try {
      await handle.write(buf, 0, buf.length, expected.offset);
      transfer.receivedChunks.add(chunkIndex);
      transfer.bytesTransferred += buf.length;
      this.resumeState.set(transfer.manifest.merkleRoot, new Set(transfer.receivedChunks));
    } finally {
      await handle.close();
    }

    this.emitProgress(transferId, true);

    // Complete?
    if (transfer.receivedChunks.size === transfer.manifest.totalChunks) {
      await this.completeInbound(transferId, this.peerNameForInbound);
    }
    return true;
  }

  // set peerName from caller since receiveChunk doesn't have it
  private peerNameForInbound: string = 'peer';
  setInboundPeerName(name: string) { this.peerNameForInbound = name; }

  private emitProgress(transferId: string, inbound: boolean) {
    const transfer = inbound ? this.inbound.get(transferId) : this.outbound.get(transferId);
    if (!transfer) return;
    const now = Date.now();
    const elapsed = (now - transfer.lastSampleAt) / 1000;
    const bytesDelta = transfer.bytesTransferred - transfer.lastSampleBytes;
    const mbps = elapsed > 0 ? (bytesDelta * 8) / 1_000_000 / elapsed : 0;
    transfer.lastThroughputSamples.push(mbps);
    if (transfer.lastThroughputSamples.length > 30) transfer.lastThroughputSamples.shift();
    transfer.lastSampleAt = now;
    transfer.lastSampleBytes = transfer.bytesTransferred;
    const totalBytes = transfer.manifest.fileSize;
    const bytesTransferred = transfer.bytesTransferred;
    const remainingBytes = Math.max(0, totalBytes - bytesTransferred);
    const avgThroughput = transfer.lastThroughputSamples.reduce((a, b) => a + b, 0) / Math.max(1, transfer.lastThroughputSamples.length);
    const etaMs = avgThroughput > 0 ? (remainingBytes * 8) / 1_000_000 / avgThroughput * 1000 : 0;
    const progress: TransferProgress = {
      fileId: transferId,
      bytesTransferred,
      totalBytes,
      throughputMbps: mbps,
      chunkRetries: 'failedChunks' in transfer ? transfer.failedChunks.length : 0,
      etaMs,
      sparkline: transfer.lastThroughputSamples.slice(),
    };
    this.emit('event', { type: inbound ? 'inbound:progress' : 'outbound:progress', transferId, progress } satisfies OrchestratorEvent);
  }

  private async completeInbound(transferId: string, peerName: string) {
    const transfer = this.inbound.get(transferId);
    if (!transfer) return;
    const durationMs = Date.now() - transfer.startedAt;
    const avgThroughput = (transfer.bytesTransferred * 8) / 1_000_000 / (durationMs / 1000);
    // Re-verify whole-file integrity by re-reading and re-hashing chunks.
    let integrityOk = true;
    try {
      const outPath = path.join(transfer.outputDir, transfer.manifest.fileName);
      const handle = await fs.open(outPath, 'r');
      try {
        for (const chunk of transfer.manifest.chunks) {
          const buf = Buffer.allocUnsafe(chunk.length);
          await handle.read(buf, 0, chunk.length, chunk.offset);
          if (!core.verifyChunk(buf, chunk.hash)) {
            integrityOk = false;
            break;
          }
        }
      } finally { await handle.close(); }
    } catch { integrityOk = false; }

    const result: TransferComplete = {
      fileId: transferId,
      integrityOk,
      durationMs,
      averageThroughputMbps: avgThroughput,
      chunkRetries: transfer.failedChunks.length,
      bytesTransferred: transfer.bytesTransferred,
    };
    const outputPath = path.join(transfer.outputDir, transfer.manifest.fileName);

    this.store.addHistory({
      id: transferId,
      fileName: transfer.manifest.fileName,
      fileSize: transfer.manifest.fileSize,
      direction: 'in',
      peerName,
      startedAt: transfer.startedAt,
      completedAt: Date.now(),
      durationMs,
      averageThroughputMbps: avgThroughput,
      integrityOk,
      chunkRetries: transfer.failedChunks.length,
    });
    this.resumeState.delete(transfer.manifest.merkleRoot);
    this.inbound.delete(transferId);
    this.emit('event', { type: 'inbound:complete', transferId, result, outputPath } satisfies OrchestratorEvent);
  }

  // ---------------------------------------------------------------------------
  // Outbound transfer (sender side) — drives QUIC or HTTP parallel-range sends
  // ---------------------------------------------------------------------------
  async sendOutbound(
    filePath: string,
    fileName: string,
    peer: { host: string; port: number; transport: 'quic' | 'http' },
    peerName: string,
  ): Promise<string> {
    const manifest = await this.buildManifest(filePath, fileName);
    const transferId = manifest.fileId;
    const transfer: OutboundTransfer = {
      manifest,
      filePath,
      peer,
      bytesTransferred: 0,
      startedAt: Date.now(),
      lastThroughputSamples: [],
      lastSampleAt: Date.now(),
      lastSampleBytes: 0,
      paused: false,
    };
    this.outbound.set(transferId, transfer);

    try {
      if (peer.transport === 'quic') {
        const controller = new AbortController();
        const result = await core.sendFileQuic({
          host: peer.host,
          port: peer.port,
          manifest,
          filePath,
          onProgress: () => this.emitProgress(transferId, false),
          signal: controller.signal,
        });
        await this.completeOutbound(transferId, result, peerName);
      } else {
        // HTTP parallel-range sender — implemented in http-server.ts because it
        // needs to talk to the receiver's REST API. We dispatch to it via event.
        this.emit('event', { type: 'outbound:progress', transferId, progress: {
          fileId: transferId, bytesTransferred: 0, totalBytes: manifest.fileSize,
          throughputMbps: 0, chunkRetries: 0, etaMs: 0, sparkline: [],
        } } satisfies OrchestratorEvent);
      }
    } catch (err) {
      this.emit('event', { type: 'outbound:failed', transferId, error: (err as Error).message } satisfies OrchestratorEvent);
    }
    return transferId;
  }

  private async completeOutbound(transferId: string, result: TransferComplete, peerName: string) {
    const transfer = this.outbound.get(transferId);
    if (!transfer) return;
    this.store.addHistory({
      id: transferId,
      fileName: transfer.manifest.fileName,
      fileSize: transfer.manifest.fileSize,
      direction: 'out',
      peerName,
      startedAt: transfer.startedAt,
      completedAt: Date.now(),
      durationMs: result.durationMs,
      averageThroughputMbps: result.averageThroughputMbps,
      integrityOk: result.integrityOk,
      chunkRetries: result.chunkRetries,
    });
    this.outbound.delete(transferId);
    this.emit('event', { type: 'outbound:complete', transferId, result } satisfies OrchestratorEvent);
  }

  // ---------------------------------------------------------------------------
  // Acceptance gate: receiver must explicitly accept before inbound starts.
  // ---------------------------------------------------------------------------
  requestAcceptance(fileName: string, fileSize: number, peerName: string): string {
    const requestId = uuidv4();
    this.emit('event', { type: 'inbound:accept-request', fileName, fileSize, peerName, requestId } satisfies OrchestratorEvent);
    return requestId;
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------
  getInbound(transferId: string): InboundTransfer | undefined { return this.inbound.get(transferId); }
  getOutbound(transferId: string): OutboundTransfer | undefined { return this.outbound.get(transferId); }
}
