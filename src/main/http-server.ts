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
import { promises as fs, createReadStream, type Stats as FsStats } from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { PairingManager, PairingRequest, issuePairSecret, hashPairSecret, legacyFingerprintFor } from './pairing';
import { StateStore } from './store';
import { TransferOrchestrator } from './transfer-orchestrator';
import { queryWifiInfo } from './wifi-info';
import { log } from './logger';

const PHONE_DIR = path.join(__dirname, '..', 'phone');
// Font files live with the desktop renderer; the phone web UI reuses the exact
// same families (Figtree / Outfit) so both ends of a transfer share one look.
const FONTS_DIR = path.join(__dirname, '..', 'renderer', 'fonts');

export interface HttpServerOptions {
  port: number;
  hostname: string;        // e.g. 'lanbeam-abc.local'
  pairManager: PairingManager;
  store: StateStore;
  orchestrator: TransferOrchestrator;
  downloadDir: string;
  onDevicePaired?: (device: any) => void;
  /**
   * Live connect links for /api/state. A closure because the definitive
   * URLs are only known after the server binds (port) and mDNS announces.
   *   permanent — http://lanbeam.local:<port> (survives DHCP IP changes)
   *   ip        — http://<best-lan-ip>:<port> (direct fallback)
   * The phone stores the permanent link so its shortcut reconnects for
   * months without ever scanning the QR again.
   */
  links?: () => { permanent?: string; ip?: string };
  /**
   * Shared secret for the built-in transfer-engine speed test. Lets the
   * desktop's own `speedtest:run` IPC self-test reach /api/speedtest without
   * being a paired device — the request travels through the REAL HTTP stack
   * (parser, auth, headers, sockets) so the number it produces is honest.
   * Phones authenticate to the same route with their normal pair secret.
   */
  speedtestKey?: string;
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

// MIME types for downloaded files. Mobile browsers (Opera Mini, UC, stock
// download managers) use Content-Type + Content-Disposition to pick the saved
// filename & extension — a video must land as video.mp4, never download.txt.
const DOWNLOAD_MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp', '.ts': 'video/mp2t', '.flv': 'video/x-flv',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.heif': 'image/heif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.amr': 'audio/amr',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar',
  '.gz': 'application/gzip', '.apk': 'application/vnd.android.package-archive',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml',
  '.epub': 'application/epub+zip', '.torrent': 'application/x-bittorrent',
};

function mimeForFile(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return DOWNLOAD_MIME[ext] ?? 'application/octet-stream';
}

/** Best-effort client IPv4 (strips IPv6-mapped prefix, takes first hop). */
function clientIp(req: http.IncomingMessage): string | undefined {
  const raw = req.socket.remoteAddress ?? '';
  let ip = raw.replace(/^::ffff:/, '');
  // Don't record loopback — a phone is never 127.0.0.1; if we see it the
  // socket info isn't meaningful (e.g. local curl during dev).
  if (!ip || ip === '::1' || ip === '127.0.0.1') return undefined;
  if (ip.includes('%')) ip = ip.split('%')[0]; // strip zone index
  return ip;
}

/** RFC 6266 Content-Disposition with both ASCII fallback and UTF-8 form. */
function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function readBody(req: http.IncomingMessage, limitBytes = 64 * 1024 * 1024, onData?: (total: number) => void): Promise<Buffer> {
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
      if (onData) onData(size);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('client aborted')));
    req.on('close', () => { if (!req.complete) reject(new Error('client closed')); });
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
    // no-cache (revalidate every time) for the phone web UI: mobile browsers —
    // Opera Mini in particular — otherwise keep serving a stale app.js for days
    // and users never receive fixes. These files are a few KB, so revalidation
    // cost is negligible.
    const noCache = ext === '.html' || ext === '.css' || ext === '.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  // Session cookie store: cookie -> deviceId (paired).
  const sessions = new Map<string, string>();
  // deviceId -> last presence-notification time (throttle for renderer IPC).
  // Live presence engine. A device is ONLINE while it has an open presence
  // stream, an in-flight request (uploads/downloads count), or recent activity.
  // Closing the tab drops the stream socket -> offline within ~PRESENCE_GRACE_MS.
  const PRESENCE_TTL_MS = 35_000;
  const PRESENCE_GRACE_MS = 1_500;
  interface Live { streams: number; inflight: number; expiresAt: number }
  const live = new Map<string, Live>();
  const liveOf = (id: string): Live => {
    let l = live.get(id);
    if (!l) { l = { streams: 0, inflight: 0, expiresAt: 0 }; live.set(id, l); }
    return l;
  };
  const isLive = (id: string) => {
    const l = live.get(id);
    return !!l && (l.streams > 0 || l.inflight > 0 || Date.now() < l.expiresAt);
  };
  /** Single place that flips presence and tells the renderer instantly. */
  function syncPresence(id: string) {
    if (opts.store.setOnline(id, isLive(id))) {
      const dev = opts.store.pairedDevices.find(d => d.deviceId === id);
      if (dev) opts.onDevicePaired?.(dev);
    }
  }
  function markActive(id: string, ttl = PRESENCE_TTL_MS) {
    liveOf(id).expiresAt = Date.now() + ttl;
    syncPresence(id);
  }
  const presenceSweeper = setInterval(() => {
    for (const id of opts.store.onlineDeviceIds()) syncPresence(id);
  }, 500);
  presenceSweeper.unref?.();
  // transferId -> bytes actually streamed out across ALL requests (a download
  // manager may fetch one file via several Range requests).
  const servedBytes = new Map<string, number>();

  // ─── Verified-receive plumbing (PC → phone) ────────────────────────────
  //
  // 1. SIGNED DOWNLOAD LINKS. The plain <a> click in directDownload() can
  //    carry NO custom headers — only cookies. If the session cookie died
  //    (desktop restart, browser eviction) the click used to download a JSON
  //    401 body as a "file". Every pending entry now ships a per-device,
  //    per-transfer token URL (?t=...) that authenticates the download even
  //    with zero cookies — and doubles as a HEAD-able pre-flight URL.
  // 2. GRACE REMOVAL. The outbound entry used to be dropped the moment the
  //    server flushed the last byte into the socket — but the phone may
  //    still have failed to store it (download manager gave up, tab died).
  //    Now the entry survives a grace window so the phone can retry / ack;
  //    /dlstatus tells the phone what the server actually observed.
  interface DlToken { transferId: string; deviceId: string; expiresAt: number }
  const dlTokens = new Map<string, DlToken>();
  const dlTokenCache = new Map<string, { token: string; expiresAt: number }>(); // `${deviceId}:${transferId}` -> token
  const DL_TOKEN_TTL_MS = 30 * 60_000;
  function mintDlToken(transferId: string, deviceId: string): string {
    const key = `${deviceId}:${transferId}`;
    const cached = dlTokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + DL_TOKEN_TTL_MS;
    dlTokens.set(token, { transferId, deviceId, expiresAt });
    dlTokenCache.set(key, { token, expiresAt });
    return token;
  }
  const dlTokenSweeper = setInterval(() => {
    const now = Date.now();
    for (const [t, e] of dlTokens) if (e.expiresAt < now) dlTokens.delete(t);
    for (const [k, c] of dlTokenCache) if (c.expiresAt < now) dlTokenCache.delete(k);
  }, 60_000);
  dlTokenSweeper.unref?.();

  // Delayed outbound-entry cleanup: run after a full serve (or dlfailed) so
  // the phone has a window to ack (instant removal) or retry (Range resume).
  const removalTimers = new Map<string, NodeJS.Timeout>();
  function scheduleOutboundGrace(transferId: string, delayMs = 60_000): void {
    if (removalTimers.has(transferId)) return;
    removalTimers.set(transferId, setTimeout(() => {
      removalTimers.delete(transferId);
      const entry = opts.orchestrator.getOutbound(transferId);
      const removed = opts.orchestrator.removeOutbound(transferId);
      if (removed && entry?.stagedBy === 'relay' && entry.keepCopy === false) fs.unlink(entry.filePath).catch(() => {});
    }, delayMs));
  }
  function cancelOutboundGrace(transferId: string): void {
    const t = removalTimers.get(transferId);
    if (t) { clearTimeout(t); removalTimers.delete(transferId); }
  }

  // ---------------------------------------------------------------------
  // Speed test payload: 32MB of true random bytes, generated ONCE per
  // server lifetime and served from RAM. Random (not a tiled pattern) on
  // purpose — a repeating block would compress on the wire and inflate the
  // number; this way the measurement is the RAW engine/radio rate. Slices
  // are handed out with Buffer.subarray (a zero-copy view, no allocation
  // per request).
  // ---------------------------------------------------------------------
  const SPEEDTEST_MAX_BYTES = 32 * 1024 * 1024;
  const SPEEDTEST_MIN_BYTES = 256 * 1024;
  let speedtestPayload: Buffer | null = null;
  function getSpeedtestPayload(): Buffer {
    if (!speedtestPayload) speedtestPayload = randomBytes(SPEEDTEST_MAX_BYTES);
    return speedtestPayload;
  }

  function issueSession(deviceId: string): string {
    const cookie = randomBytes(32).toString('base64url');
    sessions.set(cookie, deviceId);
    return cookie;
  }

  function authDevice(req: http.IncomingMessage): string | null {
    // Primary: session cookie (issued at pair time, valid in current process)
    const cookieHdr = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('lanbeam-session='));
    if (cookieHdr) {
      const value = cookieHdr.slice('lanbeam-session='.length);
      const deviceId = sessions.get(value);
      if (deviceId) return deviceId;
    }
    // Fallback: X-Device-Id header + Remember-Me secret.
    //
    // A device whose record carries a secret-hash fingerprint MUST present
    // the matching secret (X-Pair-Secret header or the lanbeam-pair cookie).
    // Devices paired before secrets existed (fingerprint = sha256(deviceId))
    // keep working header-only until their next app open migrates them —
    // identical security to the previous release, and the phone app now
    // sends the secret on every request anyway.
    const headerDeviceId = req.headers['x-device-id'] as string | undefined;
    {
      const sec = pairSecretFromRequest(req);
      if (sec) {
        const fp = hashPairSecret(sec);
        const byFp = opts.store.pairedDevices.find(d => d.fingerprint === fp);
        if (byFp) return byFp.deviceId; // secret IS the identity — survives deviceId loss
      }
    }
    if (headerDeviceId) {
      const found = opts.store.pairedDevices.find(d => d.deviceId === headerDeviceId);
      if (found) {
        const secret = pairSecretFromRequest(req);
        if (secret && hashPairSecret(secret) === found.fingerprint) return found.deviceId;
        if (!secret && found.fingerprint === legacyFingerprintFor(found.deviceId)) return found.deviceId;
      }
    }
    return null;
  }

  /** Remember-Me secret from the X-Pair-Secret header or the lanbeam-pair cookie. */
  function pairSecretFromRequest(req: http.IncomingMessage): string | null {
    const hdr = req.headers['x-pair-secret'] as string | undefined;
    if (hdr) return hdr;
    const pairCookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('lanbeam-pair='));
    return pairCookie ? pairCookie.slice('lanbeam-pair='.length) : null;
  }

  function setPairCookies(res: http.ServerResponse, deviceId: string, pairSecret: string) {
    const session = issueSession(deviceId);
    // Two carriers for the secret so it survives whatever the browser keeps:
    // localStorage (cleared by iOS Safari after 7 idle days on normal tabs)
    // AND a year-long HttpOnly cookie (survives storage eviction, private-mode
    // quirks, and Opera Mini's flaky localStorage).
    res.setHeader('Set-Cookie', [
      `lanbeam-session=${session}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax`,
      `lanbeam-pair=${pairSecret}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax`,
    ]);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = parsed.pathname;

      // CORS is intentionally wide open: pairing secrets and download tokens
      // are unguessable capabilities carried IN the request (headers / ?t=),
      // so any origin may present one. Dual-origin lane sharding relies on
      // this: the phone page is served from one address (e.g. the LAN IP) but
      // pulls its 12 parallel lanes from TWO addresses (IP + mDNS hostname),
      // which the browser treats as separate origins — each with its own
      // 6-connection HTTP/1.1 pool. Cross-origin lanes therefore must be able
      // to (a) send Range + auth headers (preflight), (b) READ Content-Range
      // back (Expose-Headers) — the lane engine verifies every reply starts
      // at the exact requested byte — and (c) cache the preflight so the 12
      // lanes don't pay an OPTIONS round-trip each.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Range, Range, X-Chunk-Index, X-File-Id, X-Compressed, X-Device-Id, X-Pair-Secret, X-Speedtest-Key, Authorization');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
      res.setHeader('Access-Control-Max-Age', '600');
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
      if (pathname.startsWith('/style.css') || pathname.startsWith('/app.js') || pathname.startsWith('/icons.js')
        || pathname.startsWith('/manifest.webmanifest') || pathname.startsWith('/sw.js')
        || pathname.startsWith('/icon-192.png') || pathname.startsWith('/icon-512.png')
        || pathname.startsWith('/apple-touch-icon.png')) {
        await sendStatic(res, path.join(PHONE_DIR, path.basename(pathname)));
        return;
      }
      // Web fonts for the phone UI — same Figtree/Outfit files the desktop app
      // uses, so the phone typography matches the PC exactly (PC font setting
      // is mirrored onto the phone via /api/state settings.fontChoice).
      if (pathname.startsWith('/fonts/')) {
        const fontName = path.basename(pathname);
        if (!/^([A-Za-z0-9._-]+)\.(ttf|woff2?)$/.test(fontName)) { res.writeHead(404); res.end('Not found'); return; }
        try {
          const data = await fs.readFile(path.join(FONTS_DIR, fontName));
          const ext = path.extname(fontName).toLowerCase();
          res.writeHead(200, {
            'Content-Type': ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : 'font/ttf',
            'Content-Length': data.length,
            'Cache-Control': 'public, max-age=604800', // fonts never change per build path
            'Access-Control-Allow-Origin': '*',
          });
          res.end(data);
        } catch {
          res.writeHead(404); res.end('Not found');
        }
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
        // Identity resolution — a returning phone must NEVER become a second card.
        const pairSec = pairSecretFromRequest(req);
        const sessCookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('lanbeam-session='));
        const sessId = sessCookie ? sessions.get(sessCookie.slice('lanbeam-session='.length)) : undefined;
        const existing =
          opts.store.findSameDevice({
            deviceId: reqObj.deviceId,
            fingerprint: pairSec ? hashPairSecret(pairSec) : undefined,
            name: reqObj.name, kind: reqObj.kind, ip: clientIp(req),
          }) || (sessId ? opts.store.pairedDevices.find(d => d.deviceId === sessId) : undefined);
        if (existing) reqObj.deviceId = existing.deviceId;
        const paired = opts.pairManager.toPairedDevice(reqObj);
        // Capture the phone's live network identity right at pairing time so
        // the desktop device popup shows accurate connection details.
        paired.ip = clientIp(req);
        paired.userAgent = req.headers['user-agent'];
        // Remember-Me: issue a persistent device secret. The phone keeps it;
        // the desktop stores only its sha256 as the fingerprint. From now on
        // this device reconnects silently — the QR was a one-time event.
        const pairSecret = issuePairSecret();
        paired.fingerprint = hashPairSecret(pairSecret);
        opts.store.addPairedDevice(paired);
        markActive(paired.deviceId);
        opts.onDevicePaired?.(opts.store.pairedDevices.find(d => d.deviceId === paired.deviceId) ?? paired);
        setPairCookies(res, paired.deviceId, pairSecret);
        sendJson(res, 200, { ok: true, paired, pairSecret });
        return;
      }

      // ---------------------------------------------------------------
      // Remember-Me silent reconnect. The phone opens the site WITHOUT a
      // QR token (bookmark / home-screen icon / history) and presents its
      // stored deviceId + pairSecret. On a hash match it is simply in —
      // no scan, no tap. Legacy devices (fingerprint = sha256(deviceId))
      // are migrated here too: they get a fresh secret issued and their
      // fingerprint upgraded, transparently, on this first hello.
      // ---------------------------------------------------------------
      if (pathname === '/api/hello' && req.method === 'POST') {
        const headerDeviceId = req.headers['x-device-id'] as string | undefined;
        let device = headerDeviceId ? opts.store.pairedDevices.find(d => d.deviceId === headerDeviceId) : undefined;
        // Storage-eviction recovery: iOS Safari (and others) can wipe
        // localStorage after idle periods — taking the phone's random
        // deviceId with it. The YEAR-LONG lanbeam-session cookie still maps
        // to the paired device though, so when the header id is unknown we
        // resolve the real identity through that cookie before giving up.
        // (The phone adopts the returned canonical deviceId — see app.js.)
        let recoveredViaSession = false;
        if (!device) {
          const helloSecret = pairSecretFromRequest(req);
          if (helloSecret) {
            const fp = hashPairSecret(helloSecret);
            device = opts.store.pairedDevices.find(d => d.fingerprint === fp);
          }
        }
        if (!device) {
          const sessionCookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('lanbeam-session='));
          const sessionDeviceId = sessionCookie ? sessions.get(sessionCookie.slice('lanbeam-session='.length)) : undefined;
          if (sessionDeviceId) {
            device = opts.store.pairedDevices.find(d => d.deviceId === sessionDeviceId);
            recoveredViaSession = !!device;
          }
        }
        if (!device) {
          // Unknown device — a NORMAL state: every first boot probes /api/hello
          // before any QR token exists. 204 No Content keeps the browser
          // console clean (4xx responses are logged as errors); 401 stays
          // reserved for a REAL trust failure (wrong secret / revoked), which
          // the phone answers by wiping its stored secret.
          res.writeHead(204);
          res.end();
          return;
        }
        // The phone may include its (possibly improved) display name — e.g.
        // the real hardware model resolved from User-Agent Client Hints.
        // Apply it BEFORE responding so device cards never keep a generic
        // "Android Phone" label when the real name is available.
        const applyNameFromBody = async () => {
          try {
            const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
            const nm = typeof body?.name === 'string' ? body.name.trim().slice(0, 40) : '';
            if (nm && nm.length >= 2 && nm !== device!.name) device!.name = nm;
          } catch {}
        };
        const welcomeBack = (pairSecretForCookies: string, nameBeforeHello: string, extra: Record<string, unknown> = {}) => {
          opts.store.touchPairedDevice(device!.deviceId, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
          if (device!.name !== nameBeforeHello) {
            // The hello body carried a better name — persist it (lastSeen
            // re-stamped so the snapshot we write back never rolls the
            // freshness clock backwards).
            device!.lastSeen = Date.now();
            opts.store.addPairedDevice(device!);
          }
          setPairCookies(res, device!.deviceId, pairSecretForCookies);
          markActive(device!.deviceId);
          opts.onDevicePaired?.(opts.store.pairedDevices.find(d => d.deviceId === device!.deviceId) ?? device!);
          // ALWAYS hand the secret back over this trusted channel: a phone
          // that reconnects via the lanbeam-pair COOKIE just had its
          // localStorage evicted — without this echo its localStorage would
          // never heal, and the next cookie eviction would cost the pairing.
          sendJson(res, 200, { ok: true, paired: { deviceId: device!.deviceId, name: device!.name, kind: device!.kind }, pairSecret: pairSecretForCookies, ...extra });
        };
        const secret = pairSecretFromRequest(req);
        const nameBeforeHello = device.name;
        if (secret && hashPairSecret(secret) === device.fingerprint) {
          // Trusted device — welcome back.
          await applyNameFromBody();
          welcomeBack(secret, nameBeforeHello);
          return;
        }
        if (recoveredViaSession) {
          // Storage was wiped but the year-long session cookie survived.
          // That cookie is 32 random bytes, HttpOnly, and only ever issued
          // by THIS server after a successful pair/hello — so it is exactly
          // as trustworthy as the secret itself. Refresh BOTH cookies and
          // hand the device its canonical identity back. (The phone adopts
          // paired.deviceId from the response body.)
          await applyNameFromBody();
          const pairSecret = issuePairSecret();
          device.fingerprint = hashPairSecret(pairSecret);
          device.lastSeen = Date.now();
          device.ip = clientIp(req) ?? device.ip;
          device.userAgent = req.headers['user-agent'] ?? device.userAgent;
          opts.store.addPairedDevice(device);
          welcomeBack(pairSecret, nameBeforeHello, { pairSecret, recovered: true });
          return;
        }
        if (!secret && device.fingerprint === legacyFingerprintFor(device.deviceId)) {
          // Pre-secret device — migrate it now and hand it its secret.
          await applyNameFromBody();
          const pairSecret = issuePairSecret();
          device.fingerprint = hashPairSecret(pairSecret);
          device.lastSeen = Date.now();
          device.ip = clientIp(req) ?? device.ip;
          device.userAgent = req.headers['user-agent'] ?? device.userAgent;
          opts.store.addPairedDevice(device);
          markActive(device.deviceId);
          opts.onDevicePaired?.(device);
          setPairCookies(res, device.deviceId, pairSecret);
          sendJson(res, 200, { ok: true, paired: { deviceId: device.deviceId, name: device.name, kind: device.kind }, pairSecret });
          return;
        }
        // Wrong/absent secret on an upgraded device — the phone should wipe
        // its stored secret and fall back to the QR screen.
        sendJson(res, 401, { error: 'secret mismatch' });
        return;
      }

      // Everything below requires a paired session. EXCEPTION: the file
      // endpoint accepts a signed download token (?t=...) — minted per device
      // when the pending list was served — so the OS download manager's plain
      // GET works even when cookies were evicted. The token only ever
      // authorizes ITS OWN transfer's file route, nothing else.
      let deviceId = authDevice(req);
      if (!deviceId) {
        const dlTok = parsed.searchParams.get('t');
        const fileMatchForTok = pathname.match(/^\/api\/transfer\/([^/]+)\/file$/);
        if (dlTok && fileMatchForTok) {
          const tok = dlTokens.get(dlTok);
          if (tok && tok.expiresAt > Date.now() && tok.transferId === fileMatchForTok[1]) {
            deviceId = tok.deviceId;
          }
        }
        // Transfer-engine self-test: the desktop's own speedtest:run IPC
        // authenticates with the shared key. 'engine-test' never lands in
        // pairedDevices (touchPairedDevice no-ops on unknown ids) — it only
        // keeps the common authenticated-request bookkeeping happy.
        if (!deviceId && pathname === '/api/speedtest' && opts.speedtestKey) {
          const supplied = parsed.searchParams.get('key') ?? (req.headers['x-speedtest-key'] as string | undefined);
          if (supplied && supplied === opts.speedtestKey) deviceId = 'engine-test';
        }
      }
      if (!deviceId) {
        sendJson(res, 401, { error: 'not paired', code: 'E_NOT_PAIRED' });
        return;
      }
      // Refresh lastSeen AND the live network identity on every authenticated
      // request — this is what keeps the device popup accurate over time.
      opts.store.touchPairedDevice(deviceId, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
      // Presence stream: an open socket = device is here. Its close event is
      // the millisecond-accurate "left the site" signal.
      if (pathname === '/api/presence' && req.method === 'GET') {
        const l = liveOf(deviceId);
        l.streams++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive' });
        res.write(':ok\n\n');
        syncPresence(deviceId);
        const ping = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 10_000);
        let closed = false;
        const onGone = () => {
          if (closed) return; closed = true;
          clearInterval(ping);
          l.streams = Math.max(0, l.streams - 1);
          if (l.streams === 0) l.expiresAt = Math.min(l.expiresAt, Date.now() + PRESENCE_GRACE_MS);
          syncPresence(deviceId);
        };
        res.on('close', onGone); req.on('close', onGone); res.on('error', onGone);
        return;
      }
      // Explicit goodbye (pagehide beacon) — instant offline unless a transfer is still running.
      if (pathname === '/api/bye' && req.method === 'POST') {
        const l = liveOf(deviceId);
        l.expiresAt = Date.now();
        setTimeout(() => syncPresence(deviceId), 400);
        res.writeHead(204); res.end();
        return;
      }
      // Any other authenticated request = proof of life; an open one (a long
      // upload/download) keeps the device online until it finishes.
      {
        const l = liveOf(deviceId);
        l.inflight++;
        l.expiresAt = Date.now() + PRESENCE_TTL_MS;
        syncPresence(deviceId);
        let fin = false;
        const done = () => {
          if (fin) return; fin = true;
          l.inflight = Math.max(0, l.inflight - 1);
          l.expiresAt = Date.now() + PRESENCE_TTL_MS;
        };
        res.on('close', done); res.on('finish', done);
      }

      // ---------------------------------------------------------------
      // Health / state
      // ---------------------------------------------------------------
      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, version: '1.0.0' });
        return;
      }
      if (pathname === '/api/heartbeat' && req.method === 'POST') {
        // touchPairedDevice + throttled presence notification already handled
        // by the common authenticated-request block above (this endpoint used
        // to notify the renderer unconditionally, spamming IPC every 15s and
        // bypassing the 5s presence throttle).
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/transfer/pending' && req.method === 'GET') {
        // Per-device filtering — the mesh rule. An entry addressed to a
        // specific device is visible ONLY to that device (phone B must never
        // see phone A's incoming file). Entries without a target (legacy
        // desktop sends) stay visible to everyone, as before.
        const pending = Array.from((opts.orchestrator as any).outbound?.values() ?? [])
          .filter((t: any) => !t.targetDeviceId || t.targetDeviceId === deviceId)
          .map((t: any) => ({
            transferId: t.manifest.fileId,
            fileName: t.manifest.fileName,
            fileSize: t.manifest.fileSize,
            originName: t.originName || (t.stagedBy === 'relay' ? 'Another device' : undefined),
            // Signed link — authenticates the download click without cookies
            // and doubles as the pre-flight URL for the verified receive loop.
            downloadUrl: `/api/transfer/${t.manifest.fileId}/file?t=${mintDlToken(t.manifest.fileId, deviceId)}`,
          }));
        sendJson(res, 200, { transfers: pending });
        return;
      }

      // ---------------------------------------------------------------
      // Speed test: pull raw incompressible bytes from RAM. Auth is either
      // a paired device (phone, normal secret headers) or the desktop's
      // engine-test key (see the auth fallback above). Supports HEAD and
      // single-byte-range GETs so multi-lane tests can slice it in parallel
      // exactly like a range download would.
      // ---------------------------------------------------------------
      if (pathname === '/api/speedtest' && (req.method === 'GET' || req.method === 'HEAD')) {
        const payload = getSpeedtestPayload();
        const bytesRaw = parseInt(parsed.searchParams.get('bytes') || '', 10);
        const size = Number.isFinite(bytesRaw)
          ? Math.min(SPEEDTEST_MAX_BYTES, Math.max(SPEEDTEST_MIN_BYTES, bytesRaw))
          : SPEEDTEST_MAX_BYTES;
        const stHeaders: Record<string, string | number> = {
          'Content-Type': 'application/octet-stream',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        };
        if (req.method === 'HEAD') {
          res.writeHead(200, { ...stHeaders, 'Content-Length': size });
          res.end();
          return;
        }
        const rm = req.headers.range ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null;
        if (rm) {
          let st = rm[1] ? parseInt(rm[1], 10) : 0;
          let en = rm[2] ? parseInt(rm[2], 10) : size - 1;
          if (!rm[1] && rm[2]) { st = Math.max(0, size - parseInt(rm[2], 10)); en = size - 1; }
          if (Number.isNaN(st) || Number.isNaN(en) || st > en || st >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            res.end();
            return;
          }
          en = Math.min(en, size - 1);
          res.writeHead(206, { ...stHeaders, 'Content-Range': `bytes ${st}-${en}/${size}`, 'Content-Length': en - st + 1 });
          res.end(payload.subarray(st, en + 1));
          return;
        }
        res.writeHead(200, { ...stHeaders, 'Content-Length': size });
        res.end(size === payload.length ? payload : payload.subarray(0, size));
        return;
      }
      if (pathname === '/api/state' && req.method === 'GET') {
        const wifi = await queryWifiInfo();
        const paired = opts.store.pairedDevices;
        sendJson(res, 200, {
          // deviceId is included so the phone's send-to sheet can address
          // relay targets precisely (name alone is not an identity).
          pairedDevices: paired.map(d => ({ deviceId: d.deviceId, name: d.name, kind: d.kind, lastSeen: d.lastSeen })),
          wifi,
          settings: opts.store.settings,
          // The desktop's own identity — the phone's target sheet lists it as
          // "This PC" (always online; it IS the server the phone talks to).
          self: { deviceId: opts.store.localDeviceId, name: hostname() },
          // Permanent + direct connect links. The phone persists the
          // permanent one (localStorage 'lanbeam:homeUrl') so the same URL
          // keeps resolving even after the desktop's DHCP lease changes.
          links: opts.links?.() ?? {},
        });
        return;
      }
      if (pathname === '/api/webtransport-check' && req.method === 'GET') {
        // QUIC port lives in the Rust core; if it's running, expose its port here.
        // v1: not exposed — phone falls back to HTTP parallel-range.
        // httpParallelStreams = the upload pump's connection budget: 2 origins
        // × 6 per-host HTTP/1.1 connections (dual-origin chunk sharding).
        res.writeHead(200, { 'webtransport': 'false', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ webtransport: false, httpParallelStreams: 12 }));
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

        // -------------------------------------------------------------
        // Mesh relay? The manifest may carry targetDeviceId — another
        // PAIRED device (not the sender itself). The upload still lands on
        // this desktop exactly like a normal inbound; once complete, the
        // inbound:complete listener below stages it as an outbound entry
        // addressed to the target. Relays skip the PC's ask-gate: the file
        // never lands for the desktop user, both ends are already paired.
        // -------------------------------------------------------------
        const targetId = typeof manifest.targetDeviceId === 'string' ? manifest.targetDeviceId : '';
        const target = targetId && targetId !== deviceId
          ? opts.store.pairedDevices.find(d => d.deviceId === targetId)
          : undefined;
        if (target) {
          const keepCopy = manifest.keepCopy !== false; // default: keep
          await opts.orchestrator.startInbound(manifest, opts.store.settings.downloadDir || opts.downloadDir, peerName);
          pendingRelays.set(manifest.fileId, {
            targetDeviceId: target.deviceId,
            targetName: target.name,
            originName: peerName,
            keepCopy,
          });
          log.info(`[http] Relay started: ${manifest.fileName} — ${peerName} → ${target.name} (keepCopy=${keepCopy})`);
          sendJson(res, 200, { transferId: manifest.fileId, relay: true, targetName: target.name });
          return;
        }

        // Normal phone → desktop transfer. Auto mode lands immediately;
        // ask mode holds this request open until the desktop user answers
        // the Accept / Decline card (or the approval times out).
        if (opts.orchestrator.getInbound(manifest.fileId)) {
          sendJson(res, 200, { transferId: manifest.fileId, resumed: true });
          return;
        }
        const requestId = opts.orchestrator.requestAcceptance(manifest.fileName, manifest.fileSize, peerName);
        let decision: 'accepted' | 'declined' | 'timeout' = 'accepted';
        if ((opts.store.settings.receiveMode ?? 'auto') === 'ask') {
          const gate = opts.orchestrator.requestAcceptanceDecision(manifest.fileName, manifest.fileSize, peerName);
          decision = await gate.decision;
          if (decision !== 'accepted') {
            sendJson(res, decision === 'timeout' ? 408 : 403, {
              error: decision === 'timeout' ? 'approval timed out on desktop' : 'declined on desktop',
              requestId: gate.requestId,
            });
            return;
          }
        }
        const transferId = await opts.orchestrator.startInbound(manifest, opts.store.settings.downloadDir || opts.downloadDir, peerName);
        sendJson(res, 200, { transferId, requestId });
        return;
      }
      if (pathname === '/api/transfer/status' && req.method === 'GET') {
        const ids = (new URL(req.url || '', 'http://x').searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
        const transfers: Record<string, unknown> = {};
        for (const id of ids) {
          const { received, ...st } = opts.orchestrator.getInboundStatus(id);
          transfers[id] = st;
        }
        sendJson(res, 200, { transfers });
        return;
      }
      const statusMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/status$/);
      if (statusMatch && req.method === 'GET') {
        const st = opts.orchestrator.getInboundStatus(statusMatch[1]);
        sendJson(res, 200, { exists: st.state === 'receiving', cancelled: st.state === 'cancelled', received: st.received });
        return;
      }
      const chunkMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/chunk$/);
      if (chunkMatch && req.method === 'POST') {
        const transferId = chunkMatch[1];
        const chunkIndex = parseInt(req.headers['x-chunk-index'] as string, 10);
        const compressed = req.headers['x-compressed'] === '1';
        if (opts.orchestrator.isCancelled(transferId)) {
          req.resume();
          sendJson(res, 410, { ok: false, cancelled: true });
          return;
        }
        let data: Buffer;
        try {
          data = await readBody(req, 32 * 1024 * 1024, (n) => opts.orchestrator.setInflight(transferId, chunkIndex, n)); // chunk up to 32MB
        } catch (err) {
          opts.orchestrator.clearInflight(transferId, chunkIndex);
          throw err;
        }
        log.debug(`[http] Received chunk upload: transfer=${transferId}, chunkIndex=${chunkIndex}, size=${data.length}, compressed=${compressed}`);
        const ok = await opts.orchestrator.receiveChunk(transferId, chunkIndex, data, compressed);
        opts.orchestrator.clearInflight(transferId, chunkIndex);
        if (!ok) {
          log.warn(`[http] Chunk verification failed for transfer=${transferId}, chunkIndex=${chunkIndex}`);
        }
        sendJson(res, ok ? 200 : 422, { ok, chunkIndex });
        return;
      }
      const completeMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/complete$/);
      if (completeMatch && req.method === 'POST') {
        const transferId = completeMatch[1];
        // Wait up to 3 seconds for orchestrator to finish any final chunk writes/inbound completion
        for (let i = 0; i < 30; i++) {
          if (!opts.orchestrator.getInbound(transferId)) break;
          await new Promise(r => setTimeout(r, 100));
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---------------------------------------------------------------
      // Phone downloads a desktop-sent file in ONE request. Real URL +
      // Content-Disposition means the browser's own download manager shows
      // progress and keeps the true filename/extension (video.mp4 stays
      // video.mp4 — never a .txt). Supports single Range for resumable
      // download managers.
      // ---------------------------------------------------------------
      const fileMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/file$/);
      if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const transferId = fileMatch[1];
        const out = opts.orchestrator.getOutbound(transferId);
        if (!out) { sendJson(res, 404, { error: 'no such transfer', code: 'E_NO_TRANSFER' }); return; }
        let stat: FsStats;
        try {
          stat = await fs.stat(out.filePath);
        } catch {
          sendJson(res, 410, { error: 'file no longer available', code: 'E_FILE_GONE' });
          return;
        }
        // Use only the base name for the download — any folder structure stays
        // desktop-side; phones always save a flat, correctly-named file.
        const downloadName = path.basename(out.manifest.fileName || path.basename(out.filePath));
        const mime = mimeForFile(downloadName);
        const baseHeaders: Record<string, string | number> = {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        };

        if (req.method === 'HEAD') {
          baseHeaders['Content-Length'] = stat.size;
          baseHeaders['Content-Disposition'] = contentDisposition(downloadName);
          res.writeHead(200, baseHeaders);
          res.end();
          return;
        }

        // ---- Serve bytes AND report progress -------------------------------
        // Every byte piped into the response is fed back to the orchestrator
        // (throttled) so the DESKTOP progress card tracks desktop -> phone
        // transfers live, and res 'finish' marks the transfer complete
        // (history entry + outbound:complete). Previously this endpoint was
        // completely invisible to the desktop UI: the card sat at 0% /
        // 0 Kbps and never learned the transfer had finished.
        const rangeHdr = req.headers.range;
        const isRangeReq = !!rangeHdr;
        const markServed = (n: number) => {
          const total = (servedBytes.get(transferId) ?? 0) + n;
          servedBytes.set(transferId, total);
          opts.orchestrator.reportOutboundServedBytes(transferId, n);
          if (total >= stat.size) {
            // Whole file has been handed over at some point — done. This path
            // also covers download managers that fetch via multiple Ranges
            // (no single non-range 'finish'), so grace-removal is scheduled
            // here too — otherwise the entry would live until an ack that a
            // dead phone can never send.
            opts.orchestrator.completeOutboundHttp(transferId)
              .then(() => scheduleOutboundGrace(transferId, 60_000))
              .catch(() => {});
          }
        };
        const wireProgress = (stream: import('stream').Readable, resp: http.ServerResponse) => {
          opts.orchestrator.noteOutboundStreamOpen(transferId);
          stream.on('data', (c: Buffer) => markServed(c.length));
          opts.orchestrator.registerOutboundAbort(transferId, () => { stream.destroy(); resp.destroy(); });
          // 'finish' = response fully flushed. For a non-range request that is
          // always the whole file, so completion is certain even if a previous
          // partial range never reached the full size.
          resp.on('finish', () => {
            if (!isRangeReq) {
              opts.orchestrator.completeOutboundHttp(transferId).then(() => {
                // Keep the entry for a grace window: the phone acks via
                // /ack when it actually saved the file (instant removal), and
                // a phone whose download died may still resume via Range.
                // Browsers that can never ack get cleaned up by the timer
                // (which also handles the zero-trace relay unlink).
                scheduleOutboundGrace(transferId, 60_000);
              }).catch(() => {});
            }
          });
          // 'close' fires on BOTH clean finish and mid-stream death — the
          // orchestrator uses it to flip the card to "interrupted" when the
          // phone vanished part-way through.
          resp.on('close', () => opts.orchestrator.noteOutboundStreamClose(transferId));
        };
        // 1MB read-ahead chunks: on a multi-hundred-Mbps LAN the 64KB
        // default means ~16 syscalls + stream-ticks per MB, which throttles
        // fast links. Bigger reads = fewer round trips through the event
        // loop, same bytes, no buffering delay (disk read-ahead is µs-scale).
        const READ_CHUNK = 1024 * 1024;
        const rangeMatch = rangeHdr ? rangeHdr.match(/^bytes=(\d*)-(\d*)$/) : null;
        if (rangeMatch) {
          let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
          let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : stat.size - 1;
          if (!rangeMatch[1] && rangeMatch[2]) {
            // suffix range: bytes=-N → last N bytes
            start = Math.max(0, stat.size - parseInt(rangeMatch[2], 10));
            end = stat.size - 1;
          }
          if (isNaN(start) || isNaN(end) || start > end || start >= stat.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
            res.end();
            return;
          }
          end = Math.min(end, stat.size - 1);
          res.writeHead(206, {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': end - start + 1,
            'Content-Disposition': contentDisposition(downloadName),
          });
          const stream = createReadStream(out.filePath, { start, end, highWaterMark: READ_CHUNK });
          stream.on('error', () => res.destroy());
          wireProgress(stream, res);
          stream.pipe(res);
          return;
        }

        res.writeHead(200, {
          ...baseHeaders,
          'Content-Length': stat.size,
          'Content-Disposition': contentDisposition(downloadName),
        });
        const stream = createReadStream(out.filePath, { highWaterMark: READ_CHUNK });
        stream.on('error', () => res.destroy());
        wireProgress(stream, res);
        stream.pipe(res);
        return;
      }

      // ---------------------------------------------------------------
      // Phone acknowledges it saved a desktop-sent file. Removes the
      // outbound entry so the file stops appearing in "From desktop".
      // ---------------------------------------------------------------
      const ackMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/ack$/);
      if (ackMatch && req.method === 'POST') {
        const transferId = ackMatch[1];
        // The phone SAVED the file — cancel any pending grace removal first
        // so the ack wins the race, then drop the entry immediately.
        cancelOutboundGrace(transferId);
        // Zero-trace relay: if the receiving phone says "saved" and the entry
        // was a relay staged with keepCopy=false, delete the desktop's staged
        // copy. Desktop-originated sends are NEVER deleted this way — they're
        // the user's own files.
        const entry = opts.orchestrator.getOutbound(transferId);
        const removed = opts.orchestrator.removeOutbound(transferId);
        if (removed && entry?.stagedBy === 'relay' && entry.keepCopy === false) {
          fs.unlink(entry.filePath).catch(() => {});
          log.info(`[http] Relay copy dropped after ack: ${path.basename(entry.filePath)}`);
        }
        sendJson(res, 200, { ok: true, removed });
        return;
      }

      // ---------------------------------------------------------------
      // Verified-receive endpoints. The phone polls dlstatus to render its
      // card from SERVER truth (bytes actually handed to sockets, live
      // streams, interruption) instead of guessing what the OS download
      // manager did, and reports dlfailed to cancel the grace removal so a
      // dead download can be retried instead of silently dropped.
      // ---------------------------------------------------------------
      const dlStatusMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/dlstatus$/);
      if (dlStatusMatch && req.method === 'GET') {
        sendJson(res, 200, opts.orchestrator.getOutboundStatus(dlStatusMatch[1]));
        return;
      }
      const dlFailedMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/dlfailed$/);
      if (dlFailedMatch && req.method === 'POST') {
        const transferId = dlFailedMatch[1];
        cancelOutboundGrace(transferId);
        log.warn(`[http] Phone reported a failed download for ${transferId} — entry kept for retry`);
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
        if (!out) { sendJson(res, 404, { error: 'no such transfer', code: 'E_NO_TRANSFER' }); return; }
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
      const code = (err as any)?.code;
      const msg = (err as any)?.message ?? '';
      const isClientDrop = code === 'ECONNRESET' || msg === 'aborted' ||
        msg === 'client aborted' || msg === 'client closed' || code === 'EPIPE';
      if (isClientDrop) {
        // Phone closed the connection mid-request (browser killed/backgrounded) —
        // log at debug level only; the chunk will simply be retried on reconnect.
        log.debug('[http-server] client dropped mid-request:', msg || code);
      } else {
        console.error('[http-server] error:', err);
      }
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'internal error', code: 'E_SERVER' })); }
    }
  });

  // -----------------------------------------------------------------
  // Throughput: give every accepted socket TCP_NODELAY (no Nagle small-
  // write coalescing — chunk POSTs and streamed downloads otherwise
  // stall up to 200ms per write burst on some stacks) and a periodic
  // keep-alive probe so long transfers don't get dropped by NAT tables.
  // -----------------------------------------------------------------
  server.on('connection', (socket) => {
    try {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
    } catch {}
  });

  // -----------------------------------------------------------------
  // Relay staging: when a targeted inbound upload completes, turn the
  // saved file into an outbound entry for the destination phone.
  // -----------------------------------------------------------------
  const pendingRelays = new Map<string, { targetDeviceId: string; targetName: string; originName: string; keepCopy: boolean }>();
  opts.orchestrator.on('event', (ev: any) => {
    if (ev.type === 'inbound:complete' && pendingRelays.has(ev.transferId)) {
      const relay = pendingRelays.get(ev.transferId)!;
      pendingRelays.delete(ev.transferId);
      opts.orchestrator.createRelayOutbound(
        ev.outputPath,
        ev.result?.fileName || 'file',
        { deviceId: relay.targetDeviceId, name: relay.targetName },
        relay.originName,
        relay.keepCopy,
      ).catch(err => log.error('[http] Relay staging failed:', err));
    } else if (ev.type === 'inbound:failed' && pendingRelays.has(ev.transferId)) {
      pendingRelays.delete(ev.transferId);
    }
  });

  // Slow / lossy LAN hardening: never time out a long chunk upload or file
  // stream, keep connections alive between chunks, disable Nagle.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.setTimeout(0);
  server.on('connection', (sock) => {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15_000);
    sock.on('error', () => {}); // a phone vanishing off Wi-Fi must never crash/log-spam the server
  });
  server.on('clientError', (_err, sock) => { try { sock.destroy(); } catch {} });

  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Preferred port is taken (e.g. another LANBeam instance or dev server).
          // Fall back to an OS-assigned random port so the app always starts.
          log.warn(`[http] Port ${port} in use — falling back to a random port`);
          server.removeAllListeners('error');
          tryListen(0);
        } else {
          reject(err);
        }
      });
      server.listen(port, () => {
        const addr = server.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : port;
        const url = `http://${opts.hostname}:${boundPort}`;
        resolve({
          port: boundPort,
          url,
          close: () => { clearInterval(presenceSweeper); clearInterval(dlTokenSweeper); for (const t of removalTimers.values()) clearTimeout(t); return new Promise<void>((r) => server.close(() => r())); },
        });
      });
    };
    // Nagle OFF on every socket, explicitly: small API replies (polls, acks,
    // manifests) must never sit in a 40ms coalescing timer behind bulk data.
    // Node 18+ defaults this ON for new sockets — this keeps it guaranteed
    // across Node versions and platforms. Zero cost, zero risk.
    server.on('connection', (socket) => { socket.setNoDelay(true); });
    tryListen(opts.port);
  });
}
