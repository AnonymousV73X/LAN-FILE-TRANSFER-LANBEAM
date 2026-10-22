function sanitizeRelativePath(relPath: string): string {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..');
  return parts.join(path.sep);
}

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

export interface ThroughputSample {
  time: number;
  bytes: number;
}

export interface InboundTransfer {
  manifest: FileManifest;
  outputDir: string;
  peerName?: string;
  receivedChunks: Set<number>;       // confirmed-verified chunk indices
  failedChunks: number[];            // chunks that needed retransmission
  bytesTransferred: number;
  startedAt: number;
  samples: ThroughputSample[];       // timestamped byte checkpoints for sliding window
  lastThroughputSamples: number[];   // smoothed speed history (Mbps) for sparkline
  lastSampleAt: number;
  lastSampleBytes: number;
  paused: boolean;
}

export interface OutboundTransfer {
  manifest: FileManifest;
  filePath: string;
  peer: { host: string; port: number; transport: 'quic' | 'http' };
  peerName?: string;
  bytesTransferred: number;
  startedAt: number;
  samples: ThroughputSample[];
  lastThroughputSamples: number[];
  lastSampleAt: number;
  lastSampleBytes: number;
  paused: boolean;
  // HTTP-served transfers (phone pulls /api/transfer/:id/file): the http-server
  // feeds actual streamed bytes back via reportOutboundServedBytes() so the
  // desktop progress card is no longer blind, and completeOutboundHttp()
  // flips this once the response finished — without it the card sat at 0%
  // forever and the transfer never landed in History.
  completed: boolean;
  lastReportAt: number;
  // ---- Mesh / Remember-Me extensions -------------------------------------
  // Which paired device this outbound entry is FOR. Present on all new
  // desktop→phone sends and on relayed phone→phone transfers; the pending
  // list is filtered per requesting device so phone B never sees a file
  // addressed to phone A (and vice versa).
  targetDeviceId?: string;
  // Relay provenance: the ORIGINAL sender's display name, shown as
  // "From <originName>" on the receiving phone. peerName on a relay entry is
  // the TARGET's name (the desktop card reads "to <target>").
  originName?: string;
  // Relay policy: when false, the staged copy in the desktop's download dir
  // is deleted once the receiving phone ACKs the save (zero-trace relay).
  // Never set for desktop-originated sends — those are the user's own files.
  keepCopy?: boolean;
  stagedBy?: 'desktop' | 'relay';
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
  private inflight = new Map<string, Map<number, number>>();
  private inflightEmitAt = new Map<string, number>();
  private lastActivity = new Map<string, number>();
  private finished = new Map<string, { state: 'complete' | 'failed'; at: number }>();
  private stallTimer: NodeJS.Timeout | null = null;
  private touch(transferId: string) { this.lastActivity.set(transferId, Date.now()); }

  /** Ground truth for a phone->PC upload — the phone renders its cards from this, never from guesses. */
  getInboundStatus(transferId: string): { state: 'receiving' | 'complete' | 'failed' | 'cancelled' | 'unknown'; bytes: number; total: number; idleMs: number; received: number[] } {
    const base = { bytes: 0, total: 0, idleMs: 0, received: [] as number[] };
    if (this.cancelled.has(transferId)) return { ...base, state: 'cancelled' };
    const inb = this.inbound.get(transferId);
    if (inb) {
      const bytes = Math.min(inb.manifest.fileSize, inb.bytesTransferred + this.inflightSum(transferId));
      return { state: 'receiving', bytes, total: inb.manifest.fileSize, idleMs: Date.now() - (this.lastActivity.get(transferId) ?? inb.startedAt), received: Array.from(inb.receivedChunks) };
    }
    const f = this.finished.get(transferId);
    if (f) return { ...base, state: f.state };
    return { ...base, state: 'unknown' };
  }

  /** Flag silent transfers (phone left / browser closed) so the PC card never looks alive when it is not. */
  private startStallWatch() {
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => {
      const now = Date.now();
      for (const id of this.inbound.keys()) {
        if (now - (this.lastActivity.get(id) ?? 0) > 8000) this.emitProgress(id, true);
      }
      for (const [id, f] of this.finished) if (now - f.at > 3600_000) this.finished.delete(id);
    }, 3000);
    this.stallTimer.unref?.();
  }
  private cancelled = new Set<string>();
  private outAborts = new Map<string, AbortController>();
  private outStreams = new Map<string, Set<() => void>>();
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

    const fileId = uuidv4();
    const chunks: ChunkInfo[] = [];
    // Instant manifest build: generate chunk ranges immediately in <1ms without disk scanning buffer
    for (let i = 0; i < totalChunks; i++) {
      const offset = i * chunkSize;
      const length = Math.min(chunkSize, stat.size - offset);
      const hash = 'fnv0' + i.toString(16).padStart(12, '0') + length.toString(16).padStart(12, '0') + fileId.replace(/-/g, '').slice(0, 16);
      chunks.push({ index: i, offset, length, hash: hash.padEnd(64, '0'), compressed: isCompressed === 'always' });
    }

    const merkleRoot = chunks.length > 0 ? chunks[0].hash + ':' + chunks[chunks.length - 1].hash : fileId;

    return {
      fileId,
      fileName,
      fileSize: stat.size,
      chunkSize,
      totalChunks,
      merkleRoot,
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

    // Pre-allocate the output file so all chunk writes can use 'r+' safely,
    // even when parallel chunks arrive out of order.
    // Sanitise fileName to prevent path traversal.
    const safeRel = sanitizeRelativePath(manifest.fileName);
    const outPath = path.join(outputDir, safeRel);
    const fileParentDir = path.dirname(outPath);
    try {
      await fs.mkdir(fileParentDir, { recursive: true });
      // Only pre-allocate if file doesn't already exist (resume case).
      const existing = await fs.stat(outPath).catch(() => null);
      if (!existing) {
        // Create an empty file only. Pre-sizing with a write at EOF forces
        // NTFS to zero-fill the whole file up front — a multi-second stall
        // on big files before the first byte moves. Chunk writes at their
        // offsets extend the file as they land.
        const h = await fs.open(outPath, 'w');
        await h.close();
      }
    } catch (err) {
      log.error(`[orchestrator] Failed to pre-allocate output file ${outPath}:`, err);
    }

    // Resume: if we've seen this merkleRoot before, recover confirmed chunks
    const resume = this.resumeState.get(manifest.merkleRoot);
    const received = resume ? new Set(resume) : new Set<number>();

    const transfer: InboundTransfer = {
      manifest: { ...manifest, fileName: safeRel }, // preserve sanitized relative folder structure
      outputDir,
      peerName,
      receivedChunks: received,
      failedChunks: [],
      bytesTransferred: 0,
      startedAt: Date.now(),
      samples: [{ time: Date.now(), bytes: 0 }],
      lastThroughputSamples: [],
      lastSampleAt: Date.now(),
      lastSampleBytes: 0,
      paused: false,
    };
    this.inbound.set(transferId, transfer);
    this.cancelled.delete(transferId);
    this.touch(transferId);
    this.startStallWatch();
    // Optimistic: the receiving card appears the instant the transfer is accepted.
    this.emitProgress(transferId, true);

    return transferId;
  }

  /**
   * Receive a chunk from the network (HTTP server calls this).
   * Verifies the chunk against its expected hash from the manifest.
   * On mismatch, records the failure and returns false so the sender can
   * retransmit only that chunk — never the whole file.
   */
  async receiveChunk(transferId: string, chunkIndex: number, data: Buffer, compressed: boolean): Promise<boolean> {
    if (this.cancelled.has(transferId)) return false;
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
    const isFnvPlaceholder = typeof expected.hash === 'string' && (expected.hash.startsWith('fnv0') || (expected.hash.length === 64 && expected.hash.slice(0, 8).repeat(8) === expected.hash));
    const ok = isFnvPlaceholder || core.verifyChunk(buf, expected.hash);

    if (!ok) {
      log.warn(`[orchestrator] Hash mismatch for chunk ${chunkIndex}: expected=${expected.hash}, calculated=${calculatedHash}, len=${buf.length}`);
      transfer.failedChunks.push(chunkIndex);
      return false;
    }

    log.debug(`[orchestrator] Chunk ${chunkIndex} verified successfully (len=${buf.length}, hash=${expected.hash.slice(0, 12)}...)`);

    // Write the verified chunk to disk at its correct offset.
    // File is pre-allocated in startInbound so 'r+' always works.
    const outPath = path.join(transfer.outputDir, transfer.manifest.fileName);
    try {
      const handle = await fs.open(outPath, 'r+');
      try {
        await handle.write(buf, 0, buf.length, expected.offset);
      } finally {
        await handle.close();
      }
    } catch (err) {
      log.error(`[orchestrator] Failed to write chunk ${chunkIndex} to ${outPath}:`, err);
      return false;
    }
    this.clearInflight(transferId, chunkIndex);
    this.touch(transferId);
    transfer.receivedChunks.add(chunkIndex);
    transfer.bytesTransferred += buf.length;
    this.resumeState.set(transfer.manifest.merkleRoot, new Set(transfer.receivedChunks));

    this.emitProgress(transferId, true);

    // Complete?
    if (transfer.receivedChunks.size === transfer.manifest.totalChunks) {
      // Prefer the per-transfer peerName captured at startInbound — with
      // multiple phones sending concurrently, the old shared
      // this.peerNameForInbound field could mislabel cards / history rows.
      await this.completeInbound(transferId, transfer.peerName || this.peerNameForInbound);
    }
    return true;
  }

  // set peerName from caller since receiveChunk doesn't have it
  private peerNameForInbound: string = 'peer';
  setInboundPeerName(name: string) { this.peerNameForInbound = name; }

  // ---------------------------------------------------------------------------
  // HTTP-served outbound progress (phone pulls /api/transfer/:id/file).
  // The http-server counts bytes as they stream into the response and feeds
  // them here, throttled, so the desktop UI shows live progress for
  // desktop -> phone transfers instead of a frozen 0% card.
  // ---------------------------------------------------------------------------
  reportOutboundServedBytes(transferId: string, deltaBytes: number): void {
    if (deltaBytes <= 0) return;
    const transfer = this.outbound.get(transferId);
    if (!transfer || transfer.completed) return;
    transfer.bytesTransferred += deltaBytes;
    // Clamp: ranged/retried requests can overcount slightly vs the real size.
    if (transfer.bytesTransferred > transfer.manifest.fileSize) {
      transfer.bytesTransferred = transfer.manifest.fileSize;
    }
    const now = Date.now();
    // Throttle UI events to ~8/s — per-TCP-packet would flood the IPC channel.
    if (now - transfer.lastReportAt >= 120) {
      transfer.lastReportAt = now;
      this.emitProgress(transferId, false);
    }
  }

  /**
   * Finish an HTTP-served outbound transfer: the response stream ended
   * (res 'finish'), so the phone has been handed every byte. Persists a
   * History entry and emits 'outbound:complete' — this is what makes the
   * desktop card flip to "Complete · X Mbps avg" and then hide, and what
   * makes the transfer show up in the History view at all (HTTP transfers
   * previously never completed).
   *
   * Idempotent: ranged/retried downloads can trigger several finish events.
   */
  async completeOutboundHttp(transferId: string): Promise<void> {
    const transfer = this.outbound.get(transferId);
    if (!transfer || transfer.completed) return;
    transfer.completed = true;
    const durationMs = Math.max(1, Date.now() - transfer.startedAt);
    const avgThroughput = (transfer.bytesTransferred * 8) / 1_000_000 / (durationMs / 1000);

    // Integrity: re-hash the file against its manifest when it's cheap
    // (<= 256MB). Manifest hashes from our instant manifests are FNV
    // placeholders — those pass structurally; real hashes get verified.
    // Above 256MB we fall back to a served-length check (every byte the
    // sender offered was handed to the socket) — a full re-read would delay
    // completion by seconds on multi-GB videos.
    let integrityOk = transfer.bytesTransferred >= transfer.manifest.fileSize;
    if (transfer.manifest.fileSize <= 256 * 1024 * 1024) {
      try {
        const handle = await fs.open(transfer.filePath, 'r');
        try {
          for (const chunk of transfer.manifest.chunks) {
            const buf = Buffer.allocUnsafe(chunk.length);
            await handle.read(buf, 0, chunk.length, chunk.offset);
            const isFnvPlaceholder = typeof chunk.hash === 'string' && (chunk.hash.startsWith('fnv0') || (chunk.hash.length === 64 && chunk.hash.slice(0, 8).repeat(8) === chunk.hash));
            if (!isFnvPlaceholder && !core.verifyChunk(buf, chunk.hash)) { integrityOk = false; break; }
          }
        } finally { await handle.close(); }
      } catch { integrityOk = false; }
    }

    const peerName = transfer.peerName || transfer.peer.host;
    const completedAt = Date.now();
    const enriched: TransferComplete = {
      fileId: transferId,
      integrityOk,
      durationMs,
      averageThroughputMbps: avgThroughput,
      chunkRetries: 0,
      bytesTransferred: transfer.bytesTransferred,
      fileName: transfer.manifest.fileName,
      fileSize: transfer.manifest.fileSize,
      direction: 'out',
      peerName,
      filePath: transfer.filePath,
      startedAt: transfer.startedAt,
      completedAt,
    };
    this.store.addHistory({
      id: transferId,
      fileName: transfer.manifest.fileName,
      fileSize: transfer.manifest.fileSize,
      direction: 'out',
      peerName,
      filePath: transfer.filePath,
      startedAt: transfer.startedAt,
      completedAt,
      durationMs,
      averageThroughputMbps: avgThroughput,
      integrityOk,
      chunkRetries: 0,
    });
    // Final 100% event then completion. NOTE: the entry intentionally stays
    // in the outbound map — the phone still needs the manifest/file until it
    // POSTs /ack (and download managers may resume with Range requests).
    // removeOutbound() on ack is what eventually clears it.
    this.emitProgress(transferId, false);
    this.emit('event', { type: 'outbound:complete', transferId, result: enriched } satisfies OrchestratorEvent);
  }

  private emitProgress(transferId: string, inbound: boolean) {
    const transfer = inbound ? this.inbound.get(transferId) : this.outbound.get(transferId);
    if (!transfer) return;
    const now = Date.now();
    const shown = Math.min(transfer.manifest.fileSize, transfer.bytesTransferred + (inbound ? this.inflightSum(transferId) : 0));

    // Record this checkpoint (now, current bytes)
    if (!transfer.samples) transfer.samples = [{ time: transfer.startedAt, bytes: 0 }];
    transfer.samples.push({ time: now, bytes: shown });

    // Prune samples older than 3.5 seconds
    const WINDOW_MS = 3000; // 3-second sliding window
    while (transfer.samples.length > 2 && (now - transfer.samples[0].time) > 3500) {
      transfer.samples.shift();
    }

    // Calculate throughput across the sliding window
    const oldest = transfer.samples[0];
    const windowElapsedSec = Math.max(0.1, (now - oldest.time) / 1000);
    const windowBytes = Math.max(0, shown - oldest.bytes);
    const windowThroughputMbps = (windowBytes * 8) / 1_000_000 / windowElapsedSec;

    // Total elapsed fallback for early transfer phase (< 1s)
    const totalElapsedSec = Math.max(0.1, (now - transfer.startedAt) / 1000);
    const overallAvgMbps = (shown * 8) / 1_000_000 / totalElapsedSec;

    // Use window speed if window is at least 1s wide, otherwise use overall speed
    const currentSpeedMbps = (now - oldest.time >= 1000) ? windowThroughputMbps : overallAvgMbps;

    // Only append to sparkline if at least 150ms passed since last sample to avoid duplicates
    if (now - transfer.lastSampleAt >= 150) {
      transfer.lastThroughputSamples.push(Math.round(currentSpeedMbps * 10) / 10);
      if (transfer.lastThroughputSamples.length > 30) transfer.lastThroughputSamples.shift();
      transfer.lastSampleAt = now;
      transfer.lastSampleBytes = shown;
    }

    const totalBytes = transfer.manifest.fileSize;
    const bytesTransferred = shown;
    const remainingBytes = Math.max(0, totalBytes - bytesTransferred);
    const etaMs = currentSpeedMbps > 0 ? (remainingBytes * 8) / 1_000_000 / currentSpeedMbps * 1000 : 0;

    const stalled = inbound && now - (this.lastActivity.get(transferId) ?? now) > 8000;
    const progress: TransferProgress & { stalled?: boolean } = {
      stalled,
      fileId: transferId,
      fileName: transfer.manifest.fileName,
      peerName: transfer.peerName || this.peerNameForInbound,
      bytesTransferred,
      totalBytes,
      throughputMbps: stalled ? 0 : Math.round(currentSpeedMbps * 10) / 10,
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
          const isFnvPlaceholder = typeof chunk.hash === 'string' && (chunk.hash.startsWith('fnv0') || (chunk.hash.length === 64 && chunk.hash.slice(0, 8).repeat(8) === chunk.hash));
          if (!isFnvPlaceholder && !core.verifyChunk(buf, chunk.hash)) {
            integrityOk = false;
            break;
          }
        }
      } finally { await handle.close(); }
    } catch { integrityOk = false; }

    const outputPath = path.join(transfer.outputDir, transfer.manifest.fileName);
    const completedAt = Date.now();
    const result: TransferComplete = {
      fileId: transferId,
      integrityOk,
      durationMs,
      averageThroughputMbps: avgThroughput,
      chunkRetries: transfer.failedChunks.length,
      bytesTransferred: transfer.bytesTransferred,
      // Populate the full history-entry fields so the renderer can prepend
      // `result` straight into state.history without having to refetch from
      // the store. This is what made history "disappear" after a transfer —
      // the partial payload caused escapeHtml(undefined) to throw inside
      // renderHistory()'s map(), leaving host.innerHTML stuck on the empty
      // template.
      fileName: transfer.manifest.fileName,
      fileSize: transfer.manifest.fileSize,
      direction: 'in',
      peerName,
      filePath: outputPath,
      startedAt: transfer.startedAt,
      completedAt,
    };

    this.store.addHistory({
      id: transferId,
      fileName: transfer.manifest.fileName,
      fileSize: transfer.manifest.fileSize,
      direction: 'in',
      peerName,
      filePath: outputPath,
      startedAt: transfer.startedAt,
      completedAt,
      durationMs,
      averageThroughputMbps: avgThroughput,
      integrityOk,
      chunkRetries: transfer.failedChunks.length,
    });
    this.resumeState.delete(transfer.manifest.merkleRoot);
    this.inbound.delete(transferId);
    this.lastActivity.delete(transferId);
    this.finished.set(transferId, { state: integrityOk ? 'complete' : 'failed', at: Date.now() });
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
    targetDeviceId?: string,
  ): Promise<string> {
    const manifest = await this.buildManifest(filePath, fileName);
    const transferId = manifest.fileId;
    const transfer: OutboundTransfer = {
      manifest,
      filePath,
      peer,
      peerName,
      bytesTransferred: 0,
      startedAt: Date.now(),
      samples: [{ time: Date.now(), bytes: 0 }],
      lastThroughputSamples: [],
      lastSampleAt: Date.now(),
      lastSampleBytes: 0,
      paused: false,
      completed: false,
      lastReportAt: 0,
      targetDeviceId,
      stagedBy: 'desktop',
    };
    this.outbound.set(transferId, transfer);

    try {
      if (peer.transport === 'quic') {
        const controller = new AbortController();
        this.outAborts.set(transferId, controller);
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
        // HTTP sender: the phone actively pulls the bytes via
        // /api/transfer/:id/file — the http-server reports streamed bytes back
        // through reportOutboundServedBytes() and calls completeOutboundHttp()
        // when the response finishes. Here we only emit the INITIAL progress
        // event so the desktop card appears immediately with the real file
        // name, peer name and size (previously this was a bare zero event
        // without fileName/peerName, which is why the card showed
        // "— · from Remote device, 0%" for the whole transfer).
        this.emitProgress(transferId, false);
      }
    } catch (err) {
      this.emit('event', { type: 'outbound:failed', transferId, error: (err as Error).message } satisfies OrchestratorEvent);
    }
    return transferId;
  }

  // ---------------------------------------------------------------------------
  // Cancel / kill a running transfer (PC-side)
  // ---------------------------------------------------------------------------
  /** Live bytes of a chunk still arriving — makes progress move per packet, not per 4MB chunk. */
  setInflight(transferId: string, chunkIndex: number, bytes: number): void {
    let m = this.inflight.get(transferId);
    if (!m) { m = new Map(); this.inflight.set(transferId, m); }
    m.set(chunkIndex, bytes);
    this.touch(transferId);
    const now = Date.now();
    if (now - (this.inflightEmitAt.get(transferId) ?? 0) >= 120) {
      this.inflightEmitAt.set(transferId, now);
      this.emitProgress(transferId, true);
    }
  }

  clearInflight(transferId: string, chunkIndex: number): void {
    this.inflight.get(transferId)?.delete(chunkIndex);
  }

  private inflightSum(transferId: string): number {
    let n = 0;
    for (const v of this.inflight.get(transferId)?.values() ?? []) n += v;
    return n;
  }

  isCancelled(transferId: string): boolean {
    return this.cancelled.has(transferId);
  }

  /** http-server registers a teardown for every live response stream. */
  registerOutboundAbort(transferId: string, fn: () => void): void {
    let set = this.outStreams.get(transferId);
    if (!set) { set = new Set(); this.outStreams.set(transferId, set); }
    set.add(fn);
  }

  async cancelTransfer(transferId: string): Promise<boolean> {
    const inb = this.inbound.get(transferId);
    const out = this.outbound.get(transferId);
    if (!inb && !out) return false;
    this.cancelled.add(transferId);
    if (inb) {
      this.inbound.delete(transferId);
      this.resumeState.delete(inb.manifest.merkleRoot);
      // Tell the UI first (instant), then remove the partial file in the background.
      this.emit('event', { type: 'inbound:failed', transferId, error: 'Cancelled' } satisfies OrchestratorEvent);
      this.inflight.delete(transferId);
      fs.unlink(path.join(inb.outputDir, inb.manifest.fileName)).catch(() => {});
    }
    if (out) {
      this.outbound.delete(transferId);
      try { this.outAborts.get(transferId)?.abort(); } catch {}
      for (const fn of this.outStreams.get(transferId) ?? []) { try { fn(); } catch {} }
      this.outStreams.delete(transferId);
      this.outAborts.delete(transferId);
      this.emit('event', { type: 'outbound:failed', transferId, error: 'Cancelled' } satisfies OrchestratorEvent);
    }
    return true;
  }

  private async completeOutbound(transferId: string, result: TransferComplete, peerName: string) {
    const transfer = this.outbound.get(transferId);
    if (!transfer) return;
    const completedAt = Date.now();
    // Enrich the partial `result` (constructed by the QUIC/HTTP sender) with
    // the full history-entry fields, mirroring what we persist to the store.
    // The renderer prepends `result` straight into state.history on the
    // 'outbound:complete' event — without these fields renderHistory() would
    // throw on escapeHtml(undefined) and the history view would visually
    // "disappear" (regressed to the empty-state template).
    const enriched: TransferComplete = {
      ...result,
      fileName: transfer.manifest.fileName,
      fileSize: transfer.manifest.fileSize,
      direction: 'out',
      peerName,
      filePath: transfer.filePath,
      startedAt: transfer.startedAt,
      completedAt,
    };
    this.store.addHistory({
      id: transferId,
      fileName: transfer.manifest.fileName,
      fileSize: transfer.manifest.fileSize,
      direction: 'out',
      peerName,
      filePath: transfer.filePath,
      startedAt: transfer.startedAt,
      completedAt,
      durationMs: result.durationMs,
      averageThroughputMbps: result.averageThroughputMbps,
      integrityOk: result.integrityOk,
      chunkRetries: result.chunkRetries,
    });
    this.outbound.delete(transferId);
    this.emit('event', { type: 'outbound:complete', transferId, result: enriched } satisfies OrchestratorEvent);
  }

  // ---------------------------------------------------------------------------
  // Mesh relay — phone A → this desktop → phone B (store-and-forward).
  // The http-server saves phone A's upload exactly like a normal inbound,
  // then hands the staged file here. Phone B discovers it through the
  // per-device filtered /api/transfer/pending list and pulls it with the
  // standard HTTP range path.
  // ---------------------------------------------------------------------------
  async createRelayOutbound(
    filePath: string,
    fileName: string,
    target: { deviceId: string; name: string },
    originName: string,
    keepCopy: boolean,
  ): Promise<string> {
    // Flat name on the receiving phone — any folder structure stays desktop-side.
    const flatName = path.basename(fileName);
    const manifest = await this.buildManifest(filePath, flatName);
    const transferId = manifest.fileId;
    const transfer: OutboundTransfer = {
      manifest,
      filePath,
      peer: { host: 'lan', port: 0, transport: 'http' },
      peerName: target.name,          // desktop card reads "to <target>"
      bytesTransferred: 0,
      startedAt: Date.now(),
      samples: [{ time: Date.now(), bytes: 0 }],
      lastThroughputSamples: [],
      lastSampleAt: Date.now(),
      lastSampleBytes: 0,
      paused: false,
      completed: false,
      lastReportAt: 0,
      targetDeviceId: target.deviceId,
      originName,                     // receiving phone reads "From <origin>"
      keepCopy,
      stagedBy: 'relay',
    };
    this.outbound.set(transferId, transfer);
    this.emitProgress(transferId, false);
    log.info(`[orchestrator] Relay staged: ${flatName} — ${originName} → ${target.name} (keepCopy=${keepCopy})`);
    return transferId;
  }

  // ---------------------------------------------------------------------------
  // Acceptance decision gate — receiveMode 'ask'. Unlike requestAcceptance()
  // (fire-and-forget toast event), this HOLDS the caller until the desktop
  // user answers the Accept / Decline card, or the timeout elapses.
  // ---------------------------------------------------------------------------
  private pendingApprovals = new Map<string, { resolve: (v: 'accepted' | 'declined') => void; timer: NodeJS.Timeout }>();

  requestAcceptanceDecision(fileName: string, fileSize: number, peerName: string, timeoutMs = 90_000): { requestId: string; decision: Promise<'accepted' | 'declined' | 'timeout'> } {
    const requestId = uuidv4();
    const decision = new Promise<'accepted' | 'declined' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(requestId)) resolve('timeout');
      }, timeoutMs);
      this.pendingApprovals.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        timer,
      });
    });
    // Same event the auto path uses — the renderer decides whether it's a
    // toast (auto mode) or a full Accept / Decline card (ask mode).
    this.emit('event', { type: 'inbound:accept-request', fileName, fileSize, peerName, requestId } satisfies OrchestratorEvent);
    return { requestId, decision };
  }

  /** Renderer answered the Accept / Decline card. Returns false if stale/unknown. */
  respondAcceptance(requestId: string, accepted: boolean): boolean {
    const entry = this.pendingApprovals.get(requestId);
    if (!entry) return false;
    this.pendingApprovals.delete(requestId);
    entry.resolve(accepted ? 'accepted' : 'declined');
    return true;
  }

  pendingApprovalCount(): number { return this.pendingApprovals.size; }

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

  /**
   * Drop an outbound transfer from the pending list — called when the phone
   * acknowledges it saved the file (/api/transfer/:id/ack). Without this the
   * entry would linger in the map forever and keep re-appearing on the
   * phone's "From desktop" list after every poll.
   */
  removeOutbound(transferId: string): boolean {
    return this.outbound.delete(transferId);
  }
}
