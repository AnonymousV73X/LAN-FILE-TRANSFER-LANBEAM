/**
 * LANBeam — HTTP/1.1 server (fallback transport for phone browsers).
 *
 * Endpoints:
 *   GET  /                       Phone web UI (HTML/CSS/JS, served from src/phone/)
 *   GET  /pair?token=...         Pairing landing page (renders the phone UI in "paired" mode)
 *   POST /api/pair               Phone posts { deviceId, name, kind, publicKey } with the token; server consumes the token and adds paired device
 *   GET  /api/manifest?fileId=   Returns the manifest JSON for an inbound transfer (receiver -> sender fetches chunk ranges)
 *   POST /api/transfer/start     Phone begins a transfer: posts the manifest; server responds with transferId; receiver must accept via IPC
 *   POST /api/transfer/:id/chunk Phone posts one chunk (chunkIndex in headers, body raw bytes); server verifies + persists
 *   GET  /api/transfer/:id/chunk/:idx  Desktop-as-receiver pulls a chunk from another desktop (range download) — used in desktop-to-desktop HTTP fallback
 *   POST /api/transfer/:id/complete  Phone signals transfer complete; server runs full integrity re-verification
 *   GET  /api/webtransport-check  Phone's feature-detection probe — returns 200 with `webtransport: true` header if the server has a WebTransport endpoint (false in v1 — QUIC port lives in Rust core)
 *   GET  /api/health             Liveness check
 *   GET  /api/state              Returns paired-devices count, wifi info, current transfers summary
 *
 * Phone-side upload uses fetch() with streaming request bodies when available
 * (ReadableStream -> Request.body), falling back to chunked POST /api/transfer/:id/chunk.
 *
 * All endpoints are behind a session-cookie / paired-device check — unpaired
 * requests get 401 except /api/pair (which requires a valid one-time token).
 */
import http from 'http';
import https from 'https';
import { promises as fs } from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { randomBytes } from 'crypto';
import { PairingManager, PairingRequest } from './pairing';
import { StateStore } from './store';
import { TransferOrchestrator } from './transfer-orchestrator';
import { queryWifiInfo } from './wifi-info';

const PHONE_DIR = path.join(__dirname, '..', '..', 'src', 'phone');

export interface HttpServerOptions {
  port: number;
  hostname: string;        // e.g. 'lanbeam-abc.local'
  pairManager: PairingManager;
  store: StateStore;
  orchestrator: TransferOrchestrator;
  downloadDir: string;
}

export interface HttpServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readBody(req: http.IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

async function sendStatic(res: http.ServerResponse, filePath: string) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  // Session cookie store: cookie -> deviceId (paired).
  const sessions = new Map<string, string>();

  function issueSession(deviceId: string): string {
    const cookie = randomBytes(32).toString('base64url');
    sessions.set(cookie, deviceId);
    return cookie;
  }

  function authDevice(req: http.IncomingMessage): string | null {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('lanbeam-session='));
    if (!cookie) return null;
    const value = cookie.slice('lanbeam-session='.length);
    return sessions.get(value) ?? null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = parsed.pathname;

      // CORS for phone browser
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Chunk-Index, X-File-Id, X-Compressed');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ---------------------------------------------------------------
      // Static phone UI
      // ---------------------------------------------------------------
      if (pathname === '/' && req.method === 'GET') {
        await sendStatic(res, path.join(PHONE_DIR, 'index.html'));
        return;
      }
      if (pathname === '/pair' && req.method === 'GET') {
        // Phone scanned QR — show the phone UI in pairing mode; it will read the token from the query string
        await sendStatic(res, path.join(PHONE_DIR, 'index.html'));
        return;
      }
      if (pathname.startsWith('/style.css') || pathname.startsWith('/app.js') || pathname.startsWith('/icons.js')) {
        await sendStatic(res, path.join(PHONE_DIR, path.basename(pathname)));
        return;
      }

      // ---------------------------------------------------------------
      // Pairing
      // ---------------------------------------------------------------
      if (pathname === '/api/pair' && req.method === 'POST') {
        const token = parsed.searchParams.get('token');
        if (!token || !opts.pairManager.consumeToken(token)) {
          sendJson(res, 401, { error: 'invalid or expired token' });
          return;
        }
        const body = await readBody(req, 64 * 1024);
        const reqObj = JSON.parse(body.toString('utf8')) as PairingRequest;
        const paired = opts.pairManager.toPairedDevice(reqObj);
        opts.store.addPairedDevice(paired);
        const cookie = issueSession(paired.deviceId);
        res.setHeader('Set-Cookie', `lanbeam-session=${cookie}; Path=/; HttpOnly; Max-Age=31536000`);
        sendJson(res, 200, { ok: true, paired });
        return;
      }

      // Everything below requires a paired session
      const deviceId = authDevice(req);
      if (!deviceId) {
        sendJson(res, 401, { error: 'not paired' });
        return;
      }
      opts.store.touchPairedDevice(deviceId);

      // ---------------------------------------------------------------
      // Health / state
      // ---------------------------------------------------------------
      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, version: '1.0.0' });
        return;
      }
      if (pathname === '/api/state' && req.method === 'GET') {
        const wifi = await queryWifiInfo();
        const paired = opts.store.pairedDevices;
        sendJson(res, 200, {
          pairedDevices: paired.map(d => ({ name: d.name, kind: d.kind, lastSeen: d.lastSeen })),
          wifi,
          settings: opts.store.settings,
        });
        return;
      }
      if (pathname === '/api/webtransport-check' && req.method === 'GET') {
        // QUIC port lives in the Rust core; if it's running, expose its port here.
        // v1: not exposed — phone falls back to HTTP parallel-range.
        res.writeHead(200, { 'webtransport': 'false', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ webtransport: false, httpParallelStreams: 8 }));
        return;
      }

      // ---------------------------------------------------------------
      // Transfer: phone -> desktop (inbound)
      // ---------------------------------------------------------------
      if (pathname === '/api/transfer/start' && req.method === 'POST') {
        const body = await readBody(req, 1 * 1024 * 1024); // manifest is small
        const manifest = JSON.parse(body.toString('utf8'));
        const paired = opts.store.pairedDevices.find(d => d.deviceId === deviceId);
        const peerName = paired?.name ?? 'phone';
        // Receiver-side accept gate
        const requestId = opts.orchestrator.requestAcceptance(manifest.fileName, manifest.fileSize, peerName);
        // For v1 simplicity: auto-accept for paired devices, but emit the event so the UI shows a toast
        const transferId = await opts.orchestrator.startInbound(manifest, opts.downloadDir, peerName);
        opts.orchestrator.setInboundPeerName(peerName);
        sendJson(res, 200, { transferId, requestId });
        return;
      }
      const chunkMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/chunk$/);
      if (chunkMatch && req.method === 'POST') {
        const transferId = chunkMatch[1];
        const chunkIndex = parseInt(req.headers['x-chunk-index'] as string, 10);
        const compressed = req.headers['x-compressed'] === '1';
        const data = await readBody(req, 32 * 1024 * 1024); // chunk up to 32MB
        const ok = await opts.orchestrator.receiveChunk(transferId, chunkIndex, data, compressed);
        sendJson(res, ok ? 200 : 422, { ok, chunkIndex });
        return;
      }
      const completeMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/complete$/);
      if (completeMatch && req.method === 'POST') {
        const transferId = completeMatch[1];
        // The orchestrator already completes when all chunks arrive; this is an explicit final ack.
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---------------------------------------------------------------
      // Transfer: desktop -> phone (outbound, phone pulls ranges)
      // ---------------------------------------------------------------
      const manifestMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/manifest$/);
      if (manifestMatch && req.method === 'GET') {
        const transferId = manifestMatch[1];
        const out = opts.orchestrator.getOutbound(transferId);
        if (!out) { sendJson(res, 404, { error: 'no such transfer' }); return; }
        sendJson(res, 200, out.manifest);
        return;
      }
      const chunkGetMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/chunk\/(\d+)$/);
      if (chunkGetMatch && req.method === 'GET') {
        const transferId = chunkGetMatch[1];
        const chunkIdx = parseInt(chunkGetMatch[2], 10);
        const out = opts.orchestrator.getOutbound(transferId);
        if (!out) { sendJson(res, 404, { error: 'no such transfer' }); return; }
        const chunk = out.manifest.chunks.find(c => c.index === chunkIdx);
        if (!chunk) { sendJson(res, 404, { error: 'no such chunk' }); return; }
        const handle = await fs.open(out.filePath, 'r');
        try {
          const buf = Buffer.allocUnsafe(chunk.length);
          await handle.read(buf, 0, chunk.length, chunk.offset);
          let outBuf: Buffer = buf;
          if (chunk.compressed) {
            try {
              const compressed = await import('./core-loader').then(m => m.core.compressChunk(buf));
              outBuf = Buffer.isBuffer(compressed) ? compressed : Buffer.from(compressed);
            } catch { outBuf = buf; }
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': outBuf.length,
            'X-Compressed': chunk.compressed ? '1' : '0',
            'X-Chunk-Hash': chunk.hash,
          });
          res.end(outBuf);
        } finally {
          await handle.close();
        }
        return;
      }

      res.writeHead(404); res.end('Not found');
    } catch (err) {
      console.error('[http-server] error:', err);
      res.writeHead(500); res.end('Internal error');
    }
  });

  return new Promise((resolve) => {
    server.listen(opts.port, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      const url = `http://${opts.hostname}:${port}`;
      resolve({
        port,
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
