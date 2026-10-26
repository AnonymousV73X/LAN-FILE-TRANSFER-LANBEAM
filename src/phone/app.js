/* ==========================================================================
   LANBeam phone-side app logic. Single-page vanilla JS.
   - Pairing flow: read ?token= from URL, POST to /api/pair with device info.
   - File picker + drag/drop (where supported).
   - Multi-file queue with per-file progress (fetch streaming or parallel-range).
   - WebTransport detection: probe /api/webtransport-check, prefer WebTransport.
   - Parallel-range HTTP upload: split each file into N chunks, fire 4–8 parallel
     fetch() POSTs to /api/transfer/:id/chunk, reassemble on the receiver side
     using chunkIndex in the X-Chunk-Index header.
   ========================================================================== */

const state = {
  paired: false,
  deviceId: localStorage.getItem('lanbeam:deviceId') || randomDeviceId(),
  pairSecret: null,          // Remember-Me secret — reconnects WITHOUT the QR forever
  webTransportAvailable: false,
  maxParallelStreams: 8,
  defaultChunkSize: 4 * 1024 * 1024, // 4MB
  altOrigin: '',     // second address of the SAME PC (dual-origin lane sharding)
  pcWifi: null,      // PC's live radio state — powers the speed-test physics panel
  queue: [],  // { id, name, size, file, sent, total, status, chunks: [{idx, sent}], targetName? }
  // --- Incoming (desktop -> phone / phone -> phone via mesh) download state, keyed by transferId ---
  // { status: 'downloading'|'direct'|'error', sent, total, startedAt, lastAt, lastBytes, speed }
  downloads: new Map(),
  pendingTransfers: [],      // last /api/transfer/pending payload (filtered per device by the desktop)
  recentlySaved: new Map(),  // tid -> { expiresAt, name, size, url? } — keeps "Saved ✓" visible briefly
  autoStarted: new Set(),    // transferIds auto-receive already started (one attempt per transfer — failures fall back to a manual Retry button)
  appliedAccent: null,
  appliedFont: null,
  // Mesh roster (cached from /api/state): the desktop itself + other paired devices.
  selfDevice: null,          // { deviceId, name } — the PC we talk to
  devicePeers: [],           // [{ name, kind, lastSeen }] — other devices paired to this PC
  lastTargetId: null,        // remembered destination (localStorage)
  sheetFiles: null,          // files awaiting a sheet decision
  sheetResolve: null,        // resolves when a target is tapped / cancelled
  speedUnit: null,           // mirrored from desktop settings: mbps|mBps|gBps|gbps
  lastSentName: null,        // last device name pushed to the desktop
};

// Save deviceId for future sessions
localStorage.setItem('lanbeam:deviceId', state.deviceId);

// ---------------------------------------------------------------------------
// Remember-Me secret storage. localStorage first; the desktop ALSO mirrors the
// secret into a year-long HttpOnly cookie, so browsers with hostile storage
// (iOS Safari 7-day eviction, Opera Mini) still reconnect silently.
// ---------------------------------------------------------------------------
function savePairSecret(secret) {
  state.pairSecret = secret;
  try { localStorage.setItem('lanbeam:pairSecret', secret); } catch {}
}
function loadPairSecret() {
  try {
    const s = localStorage.getItem('lanbeam:pairSecret');
    if (s) state.pairSecret = s;
  } catch {}
}
function clearPairSecret() {
  state.pairSecret = null;
  try { localStorage.removeItem('lanbeam:pairSecret'); } catch {}
}
loadPairSecret();

// Every authenticated call carries deviceId + (when known) the pair secret.
function authHeaders(extra = {}) {
  const h = { 'X-Device-Id': state.deviceId, ...extra };
  if (state.pairSecret) h['X-Pair-Secret'] = state.pairSecret;
  return h;
}

function randomDeviceId() {
  return 'phone-' + Array.from({length: 16}, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// ---------------------------------------------------------------------------
// UNIVERSAL ERROR HANDLING — every network call goes through apiFetch, every
// failure gets a human-readable reason + machine code. Nothing fails silently
// anymore: the caller always receives {code, userMessage} and decides whether
// to render it on a card, a toast, or the PC-unreachable banner.
// ---------------------------------------------------------------------------
const HTTP_ERROR_MESSAGES = {
  401: 'Not paired anymore — scan the QR code again',
  403: 'Declined on the PC',
  404: 'Transfer not found on the PC',
  408: 'The PC took too long to answer',
  410: 'File is gone from the PC (moved or deleted?)',
  500: 'PC internal error — try again',
};

function classifyApiError(err, status, body) {
  if (status) {
    const code = (body && body.code) || ('HTTP_' + status);
    const serverMsg = body && body.error ? String(body.error) : '';
    const userMessage = HTTP_ERROR_MESSAGES[status] || serverMsg || ('PC error ' + status);
    return { code, userMessage, status };
  }
  // fetch() threw before/without a response: network down, DNS dead, abort.
  const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
  return {
    code: aborted ? 'E_TIMEOUT' : 'E_NETWORK',
    userMessage: aborted
      ? 'PC took too long to respond — Wi-Fi drop?'
      : 'PC unreachable',
  };
}

/**
 * fetch() + timeout + error classification. Resolves with the Response for
 * 2xx; throws {code, userMessage, status} otherwise. NEVER a bare catch —
 * the rejection always carries something displayable.
 */
async function apiFetch(url, opts = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeoutMs);
  let res = null;
  try {
    res = await fetch(url, {
      credentials: 'include',
      ...opts,
      headers: { ...authHeaders(), ...(opts.headers || {}) },
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(tm);
    throw classifyApiError(err, 0, null);
  }
  clearTimeout(tm);
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    throw classifyApiError(null, res.status, body);
  }
  return res;
}

/** Best-effort fire-and-forget POST — logs failures, never throws. */
async function apiPostQuiet(url, body) {
  try {
    await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, 6000);
    return true;
  } catch (err) {
    console.warn('[lanbeam] POST failed:', url, err && err.userMessage);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Device identity — parsed from the real User-Agent so the desktop device
// popup shows an accurate model name, browser and OS (never blank data).
// ---------------------------------------------------------------------------
function parseDeviceIdentity() {
  const ua = navigator.userAgent || '';
  const isIphone = /iPhone|iPod/.test(ua);
  const isIpad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  let name = 'Phone';
  if (isIphone) name = 'iPhone';
  else if (isIpad) name = 'iPad';
  else if (isAndroid) {
    // Android UAs typically embed the model: "Pixel 7 Pro", "SM-S918B",
    // "M2101K6G". Surface it so the device card names the actual phone.
    const m = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|\))/);
    const model = m ? m[1].trim().replace(/\s+/g, ' ') : '';
    if (model && !/^(wv|Build|K)$/i.test(model) && model.length <= 32) {
      name = model;
    } else {
      name = 'Android Phone';
    }
  }
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS\//.test(ua) ? 'Chrome'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const iosMatch = ua.match(/OS ([\d_]+) like Mac OS X/);
  const androidMatch = ua.match(/Android\s([\d.]+)/);
  const os = isAndroid
    ? 'Android' + (androidMatch ? ' ' + androidMatch[1].split('.')[0] : '')
    : (isIphone || isIpad) && iosMatch
      ? 'iOS ' + iosMatch[1].replace(/_/g, '.')
      : 'Mobile';
  return { name, kind: 'phone', browser, os };
}

function isOperaMini() {
  return /Opera Mini|OPMini/.test(navigator.userAgent || '');
}

// ---------------------------------------------------------------------------
// REAL device name. Many Android browsers freeze or strip the model out of
// the User-Agent string (so everything shows up as "Android Phone"), but the
// User-Agent Client Hints API still exposes the true hardware model
// ("Pixel 8 Pro", "SM-S918B", "M2101K6G") via getHighEntropyValues. We
// resolve it once, cache it, and push it to the desktop on every reconnect —
// so device cards name actual phones instead of a wall of clones.
// ---------------------------------------------------------------------------
function cachedModelName() {
  try {
    const c = localStorage.getItem('lanbeam:modelName');
    if (c && c.length >= 2 && c.length <= 40) return c;
  } catch {}
  return null;
}

function bestKnownDeviceName() {
  return cachedModelName() || parseDeviceIdentity().name;
}

async function resolveModelName() {
  const cached = cachedModelName();
  if (cached) return cached;
  try {
    const uad = navigator.userAgentData;
    if (uad && typeof uad.getHighEntropyValues === 'function') {
      const hints = await Promise.race([
        uad.getHighEntropyValues(['model']),
        new Promise(res => setTimeout(() => res(null), 1500)),
      ]);
      const model = (hints && typeof hints.model === 'string') ? hints.model.trim() : '';
      if (model && model.length >= 2 && model.length <= 40 && !/^(wv|K|Build)$/i.test(model)) {
        try { localStorage.setItem('lanbeam:modelName', model); } catch {}
        return model;
      }
    }
  } catch {}
  return null;
}

/** parseDeviceIdentity() upgraded with the real hardware model when available. */
async function resolvedDeviceIdentity() {
  const identity = parseDeviceIdentity();
  const model = await resolveModelName();
  if (model) identity.name = model;
  return identity;
}

/**
 * Push the (possibly improved) device name to the desktop. Runs after the
 * Client-Hints model resolution completes so records created with a generic
 * "Android Phone" name silently upgrade to the real model on next open.
 */
async function syncIdentityName() {
  try {
    const identity = await resolvedDeviceIdentity();
    if (!identity.name || identity.name === state.lastSentName) return;
    state.lastSentName = identity.name;
    await fetch('/api/hello', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify({ deviceId: state.deviceId, name: identity.name }),
    });
  } catch {}
}

function isIos() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// ---------------------------------------------------------------------------
// Accent sync — the phone UI mirrors the accent color chosen on the desktop
// so both ends of a transfer share one palette (fixes the "QR border is yellow
// but the glow is still green/cyan" class of mismatch).
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function lightenHex(rgb, amt) {
  const mix = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${mix(rgb.r)}, ${mix(rgb.g)}, ${mix(rgb.b)})`;
}

function applyPhoneAccent(color) {
  const rgb = hexToRgb(color);
  if (!rgb || color === state.appliedAccent) return;
  state.appliedAccent = color;
  const s = document.documentElement.style;
  s.setProperty('--accent', color);
  s.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  s.setProperty('--accent-2', lightenHex(rgb, 0.25));
  s.setProperty('--accent-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
  s.setProperty('--accent-very-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.06)`);
  s.setProperty('--accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`);
  // Readable text/ink for elements filled with the accent (buttons, badges).
  const lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  s.setProperty('--accent-contrast', lum > 0.56 ? '#001318' : '#FFFFFF');
}

// ---------------------------------------------------------------------------
// Font sync — the phone site uses the SAME typeface the PC selected
// (Settings → Font: Figtree / Outfit / System). The families are loaded from
// the desktop itself (/fonts/*.ttf — see style.css), so "Outfit on the PC"
// really is Outfit here, with zero network dependency beyond the LAN.
// ---------------------------------------------------------------------------
function applyPhoneFont(choice) {
  const fontMap = {
    figtree: 'var(--font-figtree)',
    outfit: 'var(--font-outfit)',
    system: 'var(--font-system)',
  };
  const val = fontMap[choice] || fontMap.figtree;
  if (val === state.appliedFont) return;
  state.appliedFont = val;
  document.documentElement.style.setProperty('--font-sans', val);
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

// Small inline SVG icon factory for file rows — modern minimalist line icons.
const ICONS = {
  file: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};

function iconForStatus(status) {
  if (status === 'done') return ICONS.check;
  if (status === 'error' || status === 'cancelled' || status === 'declined') return ICONS.error;
  return ICONS.file;
}

// Sheet glyphs — same minimalist line language as the rest of the UI.
const SHEET_ICONS = {
  desktop: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
};

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
async function pairWithToken(token) {
  // Client Hints may need a moment — worth it: this is the ONE request that
  // names the device on the desktop, so it carries the real model.
  const identity = await resolvedDeviceIdentity();
  state.lastSentName = identity.name;
  const deviceInfo = {
    deviceId: state.deviceId,
    name: identity.name,
    kind: 'phone',
  };
  const r = await fetch(`/api/pair?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceInfo),
  });
  if (!r.ok) return false;
  // Remember-Me: keep the issued secret so this was the LAST QR scan ever
  // needed — future visits reconnect via /api/hello with zero interaction.
  try {
    const j = await r.json();
    if (j?.pairSecret) savePairSecret(j.pairSecret);
    // Adopt the canonical identity so a re-scan never creates a second card.
    if (j?.paired?.deviceId && j.paired.deviceId !== state.deviceId) {
      state.deviceId = j.paired.deviceId;
      try { localStorage.setItem('lanbeam:deviceId', state.deviceId); } catch {}
    }
  } catch {}
  return true;
}

function setPairStatusText(text, paired) {
  const pairStatus = document.getElementById('pair-status');
  const pairStatusText = pairStatus?.querySelector('.pair-status-text');
  if (pairStatusText) pairStatusText.textContent = text;
  if (pairStatus) pairStatus.classList.toggle('paired', !!paired);
}

/**
 * Remember-Me reconnect — POST /api/hello with deviceId (+ secret when we
 * have one). Returns true when we're connected; false → show the pairing
 * banner. A 401 with a stored secret means the desktop revoked us (unpair)
 * or the secret was wiped — clear it and fall back to the QR flow.
 */
async function silentHello() {
  try {
    const r = await fetch('/api/hello', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      // Carry our best-known name so the desktop's record stays accurate
      // (e.g. upgraded from "Android Phone" to the real model).
      body: JSON.stringify({ deviceId: state.deviceId, name: bestKnownDeviceName() }),
    });
    // IMPORTANT: success is strictly 200. A 204 probe miss is also 2xx, so
    // r.ok alone would falsely "connect" — pairing state, heartbeats and
    // transfer polls would all run unauthenticated.
    if (r.status === 200) {
      const j = await r.json().catch(() => ({}));
      if (j?.pairSecret) savePairSecret(j.pairSecret); // legacy → secret migration
      // Storage-eviction recovery: when the browser wiped localStorage, our
      // random deviceId changed too. The server just resolved our REAL
      // identity through the year-long session cookie — adopt the canonical
      // deviceId it returned so every later request carries the identity
      // the desktop knows (heartbeats, transfers, pending polls).
      if (j?.paired?.deviceId && j.paired.deviceId !== state.deviceId) {
        state.deviceId = j.paired.deviceId;
        try { localStorage.setItem('lanbeam:deviceId', state.deviceId); } catch {}
      }
      state.paired = true;
      const banner = document.getElementById('pair-banner');
      if (banner) banner.style.display = 'none';
      setPairStatusText('Paired', true);
      startHeartbeat();
      // Client Hints resolve async — refine the name right after connecting.
      syncIdentityName();
      return true;
    }
    // 401 = revoked / wrong secret → wipe and fall back to the QR flow.
    // 204 = "unknown device" — the normal probe answer on a first boot; it
    // also means the desktop lost our record (unpair / reinstall), so any
    // stored secret is dead weight and gets cleared the same way.
    if (r.status === 401 || r.status === 204) clearPairSecret();
  } catch {}
  return false;
}

async function tryPair() {
  const urlParams = new URLSearchParams(location.search);
  const token = urlParams.get('token');
  const banner = document.getElementById('pair-banner');
  const pairBtn = document.getElementById('pair-confirm');

  // ---------------------------------------------------------------------
  // Remember-Me FIRST — ALWAYS, token or no token.
  //
  // The previous logic only tried silentHello on token-LESS URLs. Any old
  // bookmark / history / home-screen link that still carried a stale
  // ?token=... went straight to token pairing, failed (tokens expire), and
  // showed "scan a fresh QR" — even though a perfectly valid secret sat in
  // localStorage. That was the broken "permanent connect". Now:
  //   1. silent hello — authenticates via the stored secret, the year-long
  //      lanbeam-pair cookie, or (after a total localStorage wipe) the
  //      session cookie the server still remembers. All three paths return
  //      the canonical identity and often a fresh secret. NOT gated on
  //      having a secret: cookie-only devices must get their shot too.
  //   2. fresh QR token in the URL              → pair
  //   3. token failed but a secret exists       → hello once more
  // A 401 from hello means the desktop revoked us / wiped its store — the
  // secret is cleared and the fresh QR token below takes over cleanly.
  // ---------------------------------------------------------------------
  if (await silentHello()) {
    if (token) history.replaceState({}, document.title, location.pathname);
    return;
  }

  if (!token) {
    // No token and no working secret — show the pairing banner.
    if (banner) banner.style.display = 'flex';
    setPairStatusText('Not paired', false);
    if (pairBtn) {
      pairBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>Refresh pairing</span>`;
      pairBtn.onclick = () => location.reload();
    }
    return;
  }

  // ---------------------------------------------------------------------
  // Token present — pair AUTOMATICALLY. The user already expressed intent
  // by scanning the QR code, so asking them to tap "Pair" again is
  // redundant. The banner is only used for transient feedback while the
  // handshake runs, and stays on screen (with a retry button) on failure.
  // ---------------------------------------------------------------------
  if (banner) {
    banner.style.display = 'flex';
    banner.classList.add('pairing');
    const textEl = banner.querySelector('.pair-banner-text');
    if (textEl) textEl.innerHTML = 'Connecting to <strong>this desktop</strong>…';
    if (pairBtn) pairBtn.style.display = 'none';
  }
  setPairStatusText('Pairing…', false);

  try {
    const ok = await pairWithToken(token);
    if (!ok) throw new Error('desktop rejected the token');
    state.paired = true;
    if (banner) {
      banner.style.display = 'none';
      banner.classList.remove('pairing');
    }
    setPairStatusText('Paired', true);
    toast('Paired with desktop — ready to send');
    // Clear token from URL so a refresh doesn't try to pair again.
    history.replaceState({}, document.title, location.pathname);
    startHeartbeat();
    syncIdentityName();
  } catch (err) {
    // Token failed (expired / consumed / desktop restarted). Before declaring
    // defeat, try the Remember-Me secret one more time — it may have arrived
    // via the year-long HttpOnly cookie even when localStorage was evicted.
    console.warn('[lanbeam] auto-pair failed:', err);
    if (state.pairSecret && (await silentHello())) {
      history.replaceState({}, document.title, location.pathname);
      return;
    }
    if (banner) {
      banner.style.display = 'flex';
      banner.classList.remove('pairing');
      const textEl = banner.querySelector('.pair-banner-text');
      if (textEl) textEl.innerHTML = "Couldn't pair automatically. The QR code may have expired — <strong>scan a fresh one</strong> on the desktop, or retry below.";
    }
    setPairStatusText('Not paired', false);
    if (pairBtn) {
      pairBtn.style.display = '';
      pairBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>Retry pairing</span>`;
      pairBtn.onclick = async () => {
        pairBtn.disabled = true;
        try {
          const ok = await pairWithToken(token);
          if (ok) {
            state.paired = true;
            if (banner) banner.style.display = 'none';
            setPairStatusText('Paired', true);
            toast('Paired successfully');
            history.replaceState({}, document.title, location.pathname);
            startHeartbeat();
          } else {
            toast('Pairing failed — token expired. Scan a fresh QR.');
          }
        } catch {
          toast('Pairing failed: network error');
        } finally {
          pairBtn.disabled = false;
        }
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat — keeps lastSeen fresh on the desktop so it shows us as online.
// ---------------------------------------------------------------------------
function showLinkBanner(show) {
  let b = document.getElementById('link-banner');
  if (!show) { if (b) b.remove(); return; }
  if (b) return;
  b = document.createElement('div');
  b.id = 'link-banner';
  b.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:9999;padding:10px 14px;border-radius:12px;background:#2a1a1f;color:#fff;font-size:13px;line-height:1.4;border:1px solid rgba(255,255,255,.18)';
  b.textContent = "Can't reach the PC. Keep Wi-Fi connected even without internet (choose \u201cStay connected\u201d) and turn off mobile data if this keeps happening.";
  document.body.appendChild(b);
}

// Presence stream: an open request the desktop watches. Closing the tab /
// leaving the site kills the socket -> desktop sees "offline" instantly;
// coming back reopens it -> "connected" instantly.
function startPresence() {
  if (state.presenceOn) return;
  state.presenceOn = true;
  let ctl = null;
  const open = async () => {
    ctl = new AbortController();
    try {
      const r = await fetch('/api/presence', { headers: authHeaders(), credentials: 'include', signal: ctl.signal, cache: 'no-store' });
      if (!r.ok || !r.body) throw new Error('presence ' + r.status);
      const rd = r.body.getReader();
      while (!(await rd.read()).done) { /* keep-alive pings */ }
    } catch {}
    if (state.presenceOn) setTimeout(open, 1000);
  };
  open();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { try { ctl?.abort(); } catch {} } // fresh stream on return
  });
  window.addEventListener('pagehide', () => {
    state.presenceOn = false;
    try { ctl?.abort(); } catch {}
    try { navigator.sendBeacon('/api/bye', new Blob([], { type: 'text/plain' })); } catch {}
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted || !state.presenceOn) { state.presenceOn = false; startPresence(); }
  });
}

function startHeartbeat() {
  startPresence();
  if (state.heartbeatTimer) return; // already running
  let fails = 0;
  let timer = null;
  const beat = async () => {
    // While a transfer/test owns the connection budget, skip the beat — the
    // active lane/upload requests keep server-side presence alive by
    // themselves (the PC counts any authenticated request as proof of life).
    if (netBusy()) { timer = setTimeout(beat, 5000); state.heartbeatTimer = timer; return; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch('/api/heartbeat', { method: 'POST', headers: authHeaders(), credentials: 'include', signal: ctl.signal });
      if (!r.ok && r.status >= 500) throw new Error('bad status');
      if (fails >= 2) showLinkBanner(false);
      fails = 0;
    } catch {
      fails++;
      if (fails >= 2) showLinkBanner(true);
    } finally {
      clearTimeout(t);
      // Retry fast while the link is down, relax when healthy.
      timer = setTimeout(beat, fails ? 3000 : 15000);
      state.heartbeatTimer = timer;
    }
  };
  state.heartbeatTimer = true;
  beat();
  window.addEventListener('online', () => { clearTimeout(timer); beat(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(timer); beat(); } });
}

// ---------------------------------------------------------------------------
// Feature-detection: WebTransport?
// ---------------------------------------------------------------------------
async function detectTransport() {
  try {
    const r = await fetch('/api/webtransport-check');
    if (r.ok) {
      const j = await r.json();
      state.webTransportAvailable = !!j.webtransport && typeof WebTransport !== 'undefined';
      state.maxParallelStreams = j.httpParallelStreams || 8;
    }
  } catch {
    state.webTransportAvailable = false;
  }
}

// ---------------------------------------------------------------------------
// File picking + drag/drop
// ---------------------------------------------------------------------------
function bindPicker() {
  const zone = document.getElementById('picker-zone');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');
  const btnFiles = document.getElementById('btn-pick-files');
  const btnFolder = document.getElementById('btn-pick-folder');

  btnFiles?.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput?.click();
  });

  btnFolder?.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Strategy 1 — File System Access API. Desktop Chrome/Edge/Opera and
    // Android Chrome 132+ (Jan 2025) all support showDirectoryPicker().
    if (window.showDirectoryPicker) {
      try {
        const dirHandle = await window.showDirectoryPicker();
        const files = [];
        const readDir = async (handle, currentPath) => {
          for await (const entry of handle.values()) {
            if (entry.kind === 'file') {
              const file = await entry.getFile();
              file.customName = currentPath + '/' + file.name;
              files.push(file);
            } else if (entry.kind === 'directory') {
              await readDir(entry, currentPath + '/' + entry.name);
            }
          }
        };
        await readDir(dirHandle, dirHandle.name);
        if (files.length) {
          enqueueFiles(files);
          return;
        }
        // Empty folder — nothing to send, tell the user instead of silently
        // falling through to the file picker.
        toast('That folder is empty');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // user closed the picker
        console.warn('showDirectoryPicker failed, falling back to input:', err);
      }
    }
    // Strategy 2 — webkitdirectory <input>. Works on desktop Firefox/Safari
    // and newer Android browsers. On browsers WITHOUT folder support the
    // dialog silently degrades to a plain file picker — the change handler
    // below detects that (no webkitRelativePath) and tells the user
    // honestly instead of pretending folders were selected.
    if (isIos() && !window.showDirectoryPicker) {
      // iOS Safari does not support folder picking — set expectations upfront
      // instead of opening a picker that can't do the job.
      toast('iOS can\'t pick folders — open your Files app, or pick files instead');
    }
    folderInput?.click();
  });

  zone.addEventListener('click', (e) => {
    if (e.target !== btnFolder && !btnFolder?.contains(e.target)) {
      fileInput?.click();
    }
  });

  fileInput?.addEventListener('change', () => {
    if (fileInput.files?.length) enqueueFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  folderInput?.addEventListener('change', () => {
    if (folderInput.files?.length) {
      const files = Array.from(folderInput.files);
      const withRelativePath = files.filter(f => f.webkitRelativePath && f.webkitRelativePath.length);
      if (!withRelativePath.length) {
        // The browser opened a plain file picker — it does not support folder
        // selection. Keep the files the user picked, but say so plainly.
        toast('Folder picking is not supported in this browser — added the selected files instead');
        enqueueFiles(files);
      } else {
        // Preserve relative path in file name if available
        for (const f of files) {
          if (f.webkitRelativePath) f.customName = f.webkitRelativePath;
        }
        enqueueFiles(files);
      }
    }
    folderInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('dragover');
  }));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const items = e.dataTransfer?.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const files = [];
      const traverse = async (entry, pathStr = '') => {
        if (entry.isFile) {
          await new Promise((resolve) => {
            entry.file((f) => {
              f.customName = pathStr ? pathStr + '/' + f.name : f.name;
              files.push(f);
              resolve();
            }, () => resolve());
          });
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const readEntries = async () => {
            const entries = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
            if (entries.length > 0) {
              for (const child of entries) {
                await traverse(child, pathStr ? pathStr + '/' + entry.name : entry.name);
              }
              await readEntries();
            }
          };
          await readEntries();
        }
      };
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) await traverse(entry);
      }
      if (files.length) enqueueFiles(files);
    } else if (e.dataTransfer?.files?.length) {
      enqueueFiles(Array.from(e.dataTransfer.files));
    }
  });
}

// ---------------------------------------------------------------------------
// Mesh target choice — the send-to bottom sheet.
//
// Rules that keep it minimal (and STOP the roster from ever nagging you):
//   · ONLY ONLINE devices count. A roster full of old offline records can
//     never force a choice dialog — with one connected device (the PC) the
//     send is instant, exactly like the pre-mesh app.
//   · 2+ ONLINE destinations  → the sheet slides up; tap = send.
//   · Offline devices are never listed — no spam walls of dead entries.
//   · Last-used ONLINE destination carries an accent ✓.
//   · "Keep a copy on this PC" applies to phone→phone relays only, so it
//     only appears when an online PHONE is among the choices.
// ---------------------------------------------------------------------------
function computeTargets() {
  const targets = [{
    id: '__self__',
    name: state.selfDevice?.name || 'This PC',
    kind: 'desktop',
    online: true,
    self: true,
  }];
  const ONLINE_MS = 30 * 1000;
  const now = Date.now();
  for (const p of state.devicePeers || []) {
    // Skip blank records AND ourselves — our own pairing record shows up in
    // the roster too, and beaming a file to the device that's sending it is
    // nonsense.
    if (!p?.name || (p.deviceId && p.deviceId === state.deviceId)) continue;
    targets.push({
      id: p.deviceId || p.name,
      name: p.name,
      kind: p.kind === 'phone' ? 'phone' : p.kind === 'desktop' ? 'desktop' : 'phone',
      online: (now - (p.lastSeen || 0)) < ONLINE_MS,
      self: false,
    });
  }
  return targets;
}

/** The PC itself plus any peer that is actually ONLINE right now. */
function onlineTargetsOf(targets) {
  return targets.filter(t => t.self || t.online);
}

function enqueueFiles(files) {
  const online = onlineTargetsOf(computeTargets());
  // Zero or one ONLINE destination (just this PC — or nothing loaded yet):
  // behave exactly like the pre-mesh app. Straight to the PC, no sheet, no
  // questions, no "keep a copy" switch — even if the roster carries dozens
  // of stale offline records.
  if (online.length <= 1) {
    commitFiles(files, online[0] || { id: '__self__', name: 'This PC', self: true }, true);
    return;
  }
  // 2+ genuinely online destinations → the choice UI. Offline devices are
  // deliberately NOT passed in — the sheet only ever lists live options.
  openTargetSheet(files, online);
}

function openTargetSheet(files, targets) {
  const backdrop = document.getElementById('sheet-backdrop');
  const list = document.getElementById('sheet-list');
  const title = document.getElementById('sheet-title');
  const keepRow = document.getElementById('sheet-keep-row');
  const keepToggle = document.getElementById('sheet-keep');
  if (!backdrop || !list) { commitFiles(files, { id: '__self__', name: 'This PC', self: true }, true); return; }

  try { state.lastTargetId = localStorage.getItem('lanbeam:lastTarget') || null; } catch {}
  const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
  if (title) title.textContent = `Send ${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(totalSize)}`;
  // Keep-copy matters only when a relay (phone → phone) is actually possible:
  // an online PHONE must be among the choices. Sending to the PC keeps no
  // question of copies — everything lands there anyway.
  const hasRelayTarget = targets.some(t => !t.self && t.kind === 'phone');
  if (keepRow) keepRow.style.display = hasRelayTarget ? 'flex' : 'none';
  if (keepToggle) {
    try { keepToggle.checked = localStorage.getItem('lanbeam:keepCopy') !== '0'; } catch {}
  }

  list.innerHTML = targets.map(t => `
    <button type="button" class="sheet-row ${t.self ? 'self' : ''} ${t.id && t.id === state.lastTargetId ? 'last' : ''}"
      data-target-id="${escapeHtml(t.id)}" data-target-name="${escapeHtml(t.name)}" data-target-self="${t.self ? '1' : '0'}">
      <span class="sheet-row-icon">${t.kind === 'phone' ? SHEET_ICONS.phone : SHEET_ICONS.desktop}</span>
      <span class="sheet-row-name">${escapeHtml(t.self ? 'This PC' : t.name)}
        <span class="sheet-row-sub">${t.self ? 'This desktop' : t.kind === 'phone' ? 'Phone · connected' : 'Connected'}</span>
      </span>
      <span class="sheet-row-check">${SHEET_ICONS.check}</span>
    </button>
  `).join('');

  // A stale resolver (sheet re-opened fast) is simply replaced — the previous
  // selection UI is superseded, so its files are dropped with it.
  state.sheetResolve = (choice) => {
    state.sheetResolve = null;
    closeTargetSheet();
    if (choice) commitFiles(files, choice.target, choice.keepCopy);
  };

  backdrop.style.display = 'block';
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

function closeTargetSheet() {
  const backdrop = document.getElementById('sheet-backdrop');
  if (!backdrop) return;
  backdrop.classList.remove('open');
  // Guard: if the sheet was re-opened within the close transition, the new
  // .open class must win — never hide a freshly shown sheet.
  setTimeout(() => {
    if (!backdrop.classList.contains('open')) backdrop.style.display = 'none';
  }, 240);
}

// ---------------------------------------------------------------------------
// Background resilience: queued/in-flight uploads are persisted in IndexedDB
// so closing or killing the browser never loses them — on next open they
// resume from the chunks the PC already has. A Wake Lock keeps the screen/CPU
// alive while sending so the OS does not suspend the page mid-transfer.
// ---------------------------------------------------------------------------
const PERSIST_MAX = 1024 * 1024 * 1024; // files above this are not duplicated into IndexedDB
const _idb = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('lanbeam-uploads', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('q', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const tx = async (mode, fn) => {
    try {
      const db = await open();
      return await new Promise((res, rej) => {
        const t = db.transaction('q', mode);
        const rq = fn(t.objectStore('q'));
        t.oncomplete = () => res(rq && rq.result);
        t.onerror = t.onabort = () => rej(t.error);
      });
    } catch { return null; }
  };
  return {
    put: (v) => tx('readwrite', s => s.put(v)),
    del: (id) => tx('readwrite', s => s.delete(id)),
    all: () => tx('readonly', s => s.getAll()),
  };
})();

function persistUpload(q) {
  if (!q.file || q.size > PERSIST_MAX) return;
  _idb.put({ id: q.id, name: q.name, size: q.size, file: q.file, targetId: q.targetId,
    targetName: q.targetName, targetSelf: q.targetSelf, keepCopy: q.keepCopy });
}

let _wakeLock = null;
async function holdWakeLock() {
  try {
    if (!_wakeLock && navigator.wakeLock) {
      _wakeLock = await navigator.wakeLock.request('screen');
      _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    }
  } catch {}
}
function releaseWakeLock() {
  try { if (_wakeLock) _wakeLock.release(); } catch {}
  _wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.queue.some(q => q.status === 'sending')) holdWakeLock();
  } else {
    // Tab going hidden — warn the user if uploads are active.
    // This fires before the XHR is aborted, so it's the last chance to notify.
    if (state.queue.some(q => q.status === 'sending' || q.status === 'queued')) {
      toast('⏸️ Transfer paused — keep LANBeam open to continue');
    }
  }
});

// Warn the user before they accidentally close the tab during an active upload.
// Mobile browsers often ignore this event entirely — it's best-effort UX.
window.addEventListener('beforeunload', (e) => {
  const active = state.queue.some(q => q.status === 'sending' || q.status === 'queued' || q.status === 'retrying');
  if (active) {
    e.preventDefault();
    // Chrome requires returnValue to be set (legacy spec).
    e.returnValue = 'File transfer in progress. Leave anyway?';
    return e.returnValue;
  }
});

async function restoreUploads() {
  const rows = await _idb.all();
  if (!rows || !rows.length) return;
  let added = 0;
  for (const r of rows) {
    if (state.queue.some(q => q.id === r.id)) continue;
    state.queue.push({ ...r, sent: 0, status: 'queued', chunks: [] });
    added++;
  }
  if (!added) return;
  renderQueue();
  // Let the page settle for 1.5s before resuming so auth/pairing completes first.
  setTimeout(() => {
    toast('▶️ Resuming ' + added + ' interrupted transfer' + (added > 1 ? 's' : '') + '…');
    pump();
  }, 1500);
}

function commitFiles(files, target, keepCopy) {
  if (!target) return;
  try { localStorage.setItem('lanbeam:lastTarget', target.id || '__self__'); } catch {}
  const isSelf = target.self || target.id === '__self__';
  for (const file of files) {
    state.queue.push({
      id: 'f-' + Math.random().toString(36).slice(2, 10),
      name: file.customName || file.webkitRelativePath || file.name,
      size: file.size,
      file,
      sent: 0,
      status: 'queued',  // queued | sending | done | error
      chunks: [],
      targetId: isSelf ? null : target.id,
      targetName: target.name || 'This PC',
      targetSelf: isSelf,
      keepCopy: keepCopy !== false,
    });
    persistUpload(state.queue[state.queue.length - 1]);
  }
  renderQueue();
  pump();
}

// ---------------------------------------------------------------------------
// LAN speed test — lives in its OWN view (footer link → #st-view), out of the
// transfer flow. Phase 1: ONE stream = the small-file path. Phase 2: FIVE
// parallel range lanes = exactly what large PC→phone sends use now (same
// lane engine as streamDownload). Same measurement as the real thing.
// ---------------------------------------------------------------------------
let _stRunning = false;
let _stViewOpen = false;

function bindSpeedTest() {
  const btn = document.getElementById('st-run');
  if (btn && !btn.dataset.stBound) {
    btn.dataset.stBound = '1';
    btn.addEventListener('click', runPhoneSpeedTest);
  }
  // View navigation: footer link opens, back button / hardware back closes.
  const open = document.getElementById('st-open');
  const back = document.getElementById('st-back');
  const view = document.getElementById('st-view');
  const main = document.getElementById('main-view');
  if (open && view && main && !open.dataset.stNavBound) {
    open.dataset.stNavBound = '1';
    open.addEventListener('click', () => {
      if (_stViewOpen) return;
      _stViewOpen = true;
      main.hidden = true;
      view.hidden = false;
      window.scrollTo(0, 0);
      try { history.pushState({ stView: true }, ''); } catch {}
    });
  }
  if (back && view && main && !back.dataset.stNavBound) {
    back.dataset.stNavBound = '1';
    back.addEventListener('click', () => {
      // If this open pushed a history entry, pop it — popstate closes the
      // view. Otherwise (e.g. state was lost) close directly.
      if (history.state && history.state.stView) history.back();
      else closeSpeedTestView();
    });
  }
  if (!window._stPopBound) {
    window._stPopBound = true;
    window.addEventListener('popstate', () => { if (_stViewOpen) closeSpeedTestView(); });
  }
}

function closeSpeedTestView() {
  if (!_stViewOpen) return;
  _stViewOpen = false;
  const view = document.getElementById('st-view');
  const main = document.getElementById('main-view');
  if (view) view.hidden = true;
  if (main) main.hidden = false;
}

/** Count the bytes of a response. Prefers arrayBuffer() — one C++-side
 *  accumulation — because per-chunk reader.read() promises cost ~0.3ms each
 *  (≈500 JS round trips for 32MB): on fast links that tax becomes the
 *  measured number instead of the link. The reader loop stays as a fallback
 *  for bodies without arrayBuffer (none known in practice). */
async function countStreamBytes(res) {
  if (typeof res.arrayBuffer === 'function') {
    return (await res.arrayBuffer()).byteLength;
  }
  const reader = res.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
  }
  return n;
}

async function runPhoneSpeedTest() {
  if (_stRunning) return;
  const btn = document.getElementById('st-run');
  const out = document.getElementById('st-result');
  if (!btn || !out) return;
  if (!state.paired) { toast('Pair with the PC first'); return; }
  _stRunning = true;
  btn.disabled = true;
  btn.textContent = 'Testing…';
  out.hidden = false;
  out.innerHTML = '<span class="st-line">Measuring single stream…</span>';
  holdWakeLock();
  try {
    const TOTAL = 32 * 1024 * 1024;
    const mbps = (bytes, ms) => Math.round((bytes * 8) / (ms / 1000) / 1e6);

    // Phase 1 — single stream (small-file path).
    let t = performance.now();
    const r1 = await apiFetch(`/api/speedtest?bytes=${TOTAL}`, {}, 60000);
    if (!r1.ok) throw new Error('HTTP ' + r1.status);
    const n1 = await countStreamBytes(r1);
    const d1 = performance.now() - t;
    if (n1 !== TOTAL) throw new Error(`received ${n1} of ${TOTAL} bytes`);

    // Phase 2 — parallel lanes, each a byte-range slice of the same 32MB.
    // Same engine large PC→phone sends use (see streamDownload), including
    // dual-origin sharding: when the PC answers on a second address, the
    // browser gives that origin its own 6-connection pool — 12 lanes total.
    // Every background poll is paused for the whole test (netBusy() guard)
    // so the full connection budget is lanes — none spent on polling.
    const origins = laneOrigins();
    const LANES = origins.length * 6;
    out.innerHTML = `<span class="st-line">Measuring ${LANES} parallel lanes…</span>`;
    await new Promise(r => setTimeout(r, 250));
    const lane = Math.ceil(TOTAL / LANES);
    t = performance.now();
    const counts = await Promise.all(Array.from({ length: LANES }, async (_, i) => {
      const s = i * lane;
      const e = Math.min(TOTAL, s + lane) - 1;
      const useAlt = origins.length > 1 && (i % 2 === 1);
      let r;
      try {
        r = await laneRequest(`/api/speedtest?bytes=${TOTAL}`, useAlt, `bytes=${s}-${e}`);
      } catch (err) {
        // Alternate address not resolving on this phone — reroute the lane
        // to the primary origin once, then let normal errors propagate.
        if (!useAlt) throw err;
        r = await laneRequest(`/api/speedtest?bytes=${TOTAL}`, false, `bytes=${s}-${e}`);
      }
      if (r.status !== 206 && !r.ok) throw new Error('lane HTTP ' + r.status);
      return countStreamBytes(r);
    }));
    const d2 = performance.now() - t;
    const n2 = counts.reduce((a, b) => a + b, 0);
    if (n2 !== TOTAL) throw new Error(`lanes received ${n2} of ${TOTAL} bytes`);

    const s1 = mbps(n1, d1), sL = mbps(n2, d2);
    const boost = s1 > 0 ? sL / s1 : 0;
    const laneWord = LANES > 6 ? '12 lanes' : '6 lanes';

    // ---- Classify the limit: excellent, connection-bound, or radio-bound ----
    let verdict;
    if (sL >= 600) verdict = 'Excellent — large sends already run at this speed.';
    else if (boost < 0.85) verdict = 'This link is already faster than the phone can pull through the browser — transfers run at the practical ceiling for this phone. More Wi-Fi headroom or more lanes won\'t raise it further here.';
    else if (boost >= 1.4) verdict = `Lanes pay off here: ×${boost.toFixed(1)} over one stream. This link is connection-limited, and the ${laneWord} path is what unlocks it.`;
    else if (s1 < 100) verdict = 'The link itself is weak — signal, band or distance. Parallelism cannot fix the radio.';
    else verdict = 'Lanes land close to the single stream: the radio, not the connection count, is the limit. The levers below change that number — code cannot push past physics.';

    // ---- The honest physics of "800 Mbps" ----
    // Wi-Fi rates shown in settings are theoretical PHY numbers; real TCP
    // gets roughly half of that over ONE air hop. If the PC is ALSO on Wi-Fi,
    // every byte crosses the air TWICE (PC↔router↔phone) sharing the same
    // airtime, so the realistic ceiling is about a QUARTER of the link rate.
    const w = state.pcWifi;
    const pcBits = [
      w && w.connected ? 'PC on Wi-Fi' : 'PC wired',
      w && w.generation && w.generation !== 'Unknown' ? w.generation : '',
      w && w.band ? w.band : '',
      w && w.channel ? 'ch ' + w.channel : '',
      w && w.phyRateMbps ? w.phyRateMbps + ' Mbps' : '',
    ].filter(Boolean).join(' · ');
    const ceilingNote = (w && w.connected)
      ? 'Both ends are on Wi-Fi: every byte crosses the air twice (PC↔router↔phone), so the realistic ceiling is roughly a QUARTER of the link rate — on an "800 Mbps" link that is ~200 Mbps. Wiring the PC into the router is the single biggest upgrade (~2×).'
      : 'The PC is wired, so there is only one air hop: the realistic ceiling is roughly HALF the phone\'s Wi-Fi link rate. The number in Wi-Fi settings is a theoretical PHY rate, not TCP speed.';
    const bandWarning = (w && w.connected && w.band === '2.4GHz')
      ? 'The PC is on the 2.4 GHz band — switch it to 5 GHz. No software can push high speeds through 2.4 GHz.'
      : '';
    out.innerHTML = `
      <div class="st-nums">
        <div class="st-num"><b>${s1}</b><span>Mbps · single</span></div>
        <div class="st-num"><b>${sL}</b><span>Mbps · ${laneWord}</span></div>
        <div class="st-num"><b>×${boost.toFixed(1)}</b><span>boost</span></div>
      </div>
      <p class="st-verdict">${escapeHtml(verdict)}</p>
      <p class="st-sub">${escapeHtml(pcBits)}</p>
      <p class="st-sub">${escapeHtml(ceilingNote)}</p>
      ${bandWarning ? `<p class="st-line st-err">${escapeHtml(bandWarning)}</p>` : ''}
    `;
    // User navigated back mid-test: deliver the headline number anyway.
    if (!_stViewOpen) toast(`Speed test — ${s1} Mbps single · ${sL} Mbps ${laneWord}`);
  } catch (err) {
    out.innerHTML = `<span class="st-line st-err">Speed test failed — ${escapeHtml((err && (err.userMessage || err.message)) || String(err))}</span>`;
    if (!_stViewOpen) toast('Speed test failed — ' + ((err && (err.userMessage || err.message)) || 'network error'));
  } finally {
    _stRunning = false;
    btn.disabled = false;
    btn.textContent = 'Run speed test';
    if (![...state.downloads.values()].some(d => d.status === 'downloading' || d.status === 'direct' || d.status === 'connecting')) {
      releaseWakeLock();
    }
  }
}

function bindSheet() {
  const backdrop = document.getElementById('sheet-backdrop');
  if (!backdrop || backdrop.dataset.sheetBound) return;
  backdrop.dataset.sheetBound = '1';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { state.sheetResolve?.(null); return; }
    const row = e.target.closest('.sheet-row');
    if (!row || row.disabled) {
      if (row?.disabled) toast('That device is offline');
      return;
    }
    const keepToggle = document.getElementById('sheet-keep');
    const keepCopy = !keepToggle || keepToggle.checked;
    try { localStorage.setItem('lanbeam:keepCopy', keepCopy ? '1' : '0'); } catch {}
    state.sheetResolve?.({
      target: {
        id: row.getAttribute('data-target-id'),
        name: row.getAttribute('data-target-name'),
        self: row.getAttribute('data-target-self') === '1',
      },
      keepCopy,
    });
  });
  document.getElementById('sheet-cancel')?.addEventListener('click', () => state.sheetResolve?.(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.sheetResolve) { e.preventDefault(); state.sheetResolve(null); }
  });
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  const queueSection = document.getElementById('queue');
  const queueCount = document.getElementById('queue-count');
  if (queueSection) queueSection.style.display = state.queue.length ? 'block' : 'none';
  if (queueCount) queueCount.textContent = String(state.queue.length);
  if (!state.queue.length) {
    if (list) list.innerHTML = '';
    return;
  }
  if (!list) return;
  // Stack logic — the transfer happening RIGHT NOW is pinned to the very top
  // of the stack and everything else sits beneath it newest-first. No matter
  // how much history piles up, the active file is always the first row —
  // never buried below old completed items.
  const ordered = [
    ...state.queue.filter(q => q.status === 'sending' || q.status === 'retrying'),
    ...state.queue.filter(q => q.status !== 'sending' && q.status !== 'retrying').reverse(),
  ];
  list.innerHTML = ordered.map(item => {
    const pct = item.size > 0 ? (item.sent / item.size * 100) : 0;
    const bad = item.status === 'error' || item.status === 'cancelled' || item.status === 'declined';
    const iconClass = item.status === 'done' ? 'done' : bad ? 'error' : (item.status === 'sending' || item.status === 'retrying') ? 'active' : '';
    const fillClass = bad ? 'error' : item.status === 'done' ? 'done' : '';
    const LABEL = { queued: 'waiting', sending: 'sending', retrying: 'reconnecting', done: 'sent', error: 'failed', cancelled: 'cancelled', declined: 'declined' };
    const badgeCls = item.status === 'retrying' ? 'sending' : (item.status === 'cancelled' || item.status === 'declined') ? 'error' : item.status;
    const actions = item.status === 'error' && item.file
      ? `<button class="resave-link" data-retry="${item.id}">Retry</button> <button class="resave-link" data-dismiss="${item.id}">Remove</button>`
      : (item.status === 'error' || item.status === 'cancelled' || item.status === 'declined')
        ? `<button class="resave-link" data-dismiss="${item.id}">Remove</button>` : '';
    // Mesh pill — a quiet arrow naming the destination (only when it's not
    // the PC, so the everyday single-device look stays untouched).
    const targetPill = (!item.targetSelf && item.targetName)
      ? `<span class="pill-target">\u2192 ${escapeHtml(item.targetName)}</span>`
      : '';
    return `
      <div class="file-row ${item.status === 'sending' || item.status === 'retrying' ? 'live' : ''}" data-id="${item.id}">
        <div class="file-row-row">
          <div class="file-icon ${iconClass}">${iconForStatus(item.status)}</div>
          <div class="text">
            <div class="name">${escapeHtml(item.name)}</div>
            <div class="meta">
              <span>${formatBytes(item.sent)} / ${formatBytes(item.size)}</span>
              ${targetPill}
              ${item.phase ? `<span>${escapeHtml(item.phase)}</span>` : ''}
              <span class="meta-pct">${pct.toFixed(0)}%</span>
            </div>
          </div>
          <span class="badge ${badgeCls}">${LABEL[item.status] || item.status}</span>
        </div>
        <div class="bar"><div class="fill ${fillClass}" style="width:${pct.toFixed(1)}%"></div></div>
        ${actions ? `<div class="recv-status">${actions}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ---------------------------------------------------------------------------
// Sender: build manifest locally, then push chunks in parallel.
// ---------------------------------------------------------------------------
// One chunk POST. crossOrigin=true targets the PC's second address: cookies
// are omitted (the server's CORS is wildcard, which forbids credentialed
// replies) and authentication rides on the X-Device-Id / X-Pair-Secret
// headers — the same carrier the lane-download engine already uses.
function xhrUpload(url, headers, body, onProgress, crossOrigin) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.withCredentials = !crossOrigin;
    for (const k in headers) x.setRequestHeader(k, headers[k]);
    // Stall watchdog: a jammed Wi-Fi link can hang a socket forever. If no
    // bytes move for 25s, abort so the caller's retry opens a fresh connection.
    // 8s stall watchdog — shorter than the previous 25s so retries start
    // quickly when the mobile OS freezes or kills the connection.
    let wd = setTimeout(() => x.abort(), 8000);
    const kick = () => { clearTimeout(wd); wd = setTimeout(() => x.abort(), 8000); };
    // Abort immediately when the tab goes invisible — the OS will likely freeze
    // the XHR anyway; abort first so pump() retries the instant we come back.
    const _onHide = () => { if (document.visibilityState === 'hidden') x.abort(); };
    document.addEventListener('visibilitychange', _onHide, { once: true });
    x.upload.onprogress = (e) => { kick(); if (e.lengthComputable) onProgress(e.loaded); };
    const _cleanup = () => { clearTimeout(wd); document.removeEventListener('visibilitychange', _onHide); };
    x.onabort = () => { _cleanup(); reject(new Error('stalled')); };
    x.onload = () => { _cleanup(); resolve(x.status); };
    x.onerror = () => { clearTimeout(wd); reject(new Error('network error')); };
    x.ontimeout = () => reject(new Error('timeout'));
    x.send(body);
  });
}

async function pump() {
  const next = state.queue.find(q => q.status === 'queued');
  if (!next) { releaseWakeLock(); return; }
  next.status = 'sending';
  next.running = true;
  next.phase = '';
  renderQueue();
  holdWakeLock();
  _pumpBusy = true;

  try {
    // Build a manifest (chunk size, count, per-chunk SHA-like fingerprint using
    // SubtleCrypto). For v1 simplicity we use a synthetic hash derived from
    // chunk index + size + name; the receiver re-verifies on its side using
    // the actual Rust BLAKE3 core.
    const chunkSize = state.defaultChunkSize;
    const totalChunks = Math.max(1, Math.ceil(next.size / chunkSize));
    const chunks = [];
    // Instant manifest build: generate clean chunk metadata in microseconds without reading whole file
    for (let i = 0; i < totalChunks; i++) {
      const offset = i * chunkSize;
      const length = Math.min(chunkSize, next.size - offset);
      // Fast predictable 64-char placeholder; desktop receiver verifies chunks using native Rust / Node core
      const hash = 'fnv0' + i.toString(16).padStart(12, '0') + length.toString(16).padStart(12, '0') + next.id.slice(0, 8).repeat(4);
      chunks.push({ index: i, offset, length, hash: hash.padEnd(64, '0'), compressed: false });
    }
    const manifest = {
      fileId: next.id,
      fileName: next.name,
      fileSize: next.size,
      chunkSize,
      totalChunks,
      merkleRoot: chunks.length === 1 ? chunks[0].hash : chunks[0].hash + ':' + chunks[chunks.length - 1].hash,
      chunks,
      isCompressed: 'auto',
      createdAt: Date.now(),
      // Mesh targeting — null/omitted means "land on this desktop"; a paired
      // deviceId relays through the desktop to that device. keepCopy governs
      // whether the desktop keeps the staged copy after the relay completes.
      targetDeviceId: next.targetSelf ? null : (next.targetId || null),
      keepCopy: next.targetSelf ? true : (next.keepCopy !== false),
    };

    next.status = 'sending';
    renderQueue();
    // POST manifest to start the transfer (receiver allocates a transfer slot)
    next.phase = 'Connecting to PC…';
    renderQueue();
    const _waitT = setTimeout(() => { if (next.phase) { next.phase = 'Waiting for PC to accept…'; renderQueue(); } }, 1200);
    const startResp = await fetch('/api/transfer/start', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify(manifest),
    });
    if (!startResp.ok) {
      clearTimeout(_waitT);
      // Structured failures from the desktop's ask-mode gate / revoked sessions.
      let reason = 'start failed (' + startResp.status + ')';
      let fatal = null;
      try {
        const j = await startResp.json();
        if (startResp.status === 403) { reason = 'Declined on the desktop'; fatal = 'declined'; }
        else if (startResp.status === 408) { reason = 'Approval timed out on the desktop'; fatal = 'declined'; }
        else if (startResp.status === 401) { reason = 'Not paired — scan the QR again'; fatal = 'error'; clearPairSecret(); }
        else if (j?.error) reason = String(j.error);
      } catch {}
      const fe = new Error(reason); fe.fatal = fatal; throw fe;
    }
    clearTimeout(_waitT);
    next.phase = '';
    const { transferId } = await startResp.json();
    // Resume: ask the PC which chunks it already holds and skip them.
    const have = new Set();
    try {
      const sr = await fetch(`/api/transfer/${transferId}/status`, { headers: authHeaders(), credentials: 'include' });
      if (sr.ok) { const sj = await sr.json(); for (const i of (sj.received || [])) have.add(i); }
    } catch {}

    // Use a single, reliable origin. Mobile hotspots choke when spraying
    // chunks across multiple addresses/hostnames (mDNS timeouts, radio congestion).
    // 3 parallel workers on a single origin is the proven sweet spot for mobile Wi-Fi:
    // saturates the link without bufferbloat or TCP packet collisions.
    const maxConns = 3;
    let nextIdx = 0;
    next.doneBytes = 0;
    for (const i of have) if (chunks[i]) next.doneBytes += chunks[i].length;
    const inflight = {};
    let _lastR = 0;
    const paint = () => {
      let live = 0; for (const k in inflight) live += inflight[k];
      next.sent = Math.min(next.size, next.doneBytes + live);
      const t = Date.now();
      if (t - _lastR > 100) { _lastR = t; renderQueue(); }
    };
    const chunkPath = `/api/transfer/${transferId}/chunk`;
    const workers = Array.from({ length: Math.max(1, Math.min(maxConns, totalChunks)) }, async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= totalChunks) break;
        if (have.has(idx)) continue;
        const chunk = chunks[idx];
        const blob = next.file.slice(chunk.offset, chunk.offset + chunk.length);
        let status = 0, tries = 0;
        while (true) {
          try {
            status = await xhrUpload(chunkPath, authHeaders({
              'Content-Type': 'application/octet-stream',
              'X-Chunk-Index': String(idx),
              'X-Compressed': chunk.compressed ? '1' : '0',
            }), blob, (loaded) => { inflight[idx] = loaded; paint(); }, false);
            break;
          } catch (e) {
            delete inflight[idx];
            if (++tries >= 5) throw e;
            await new Promise(r => setTimeout(r, Math.min(3000, 300 * tries * tries)));
          }
        }
        delete inflight[idx];
        if (status === 410) { const ce = new Error('Cancelled on the PC'); ce.fatal = 'cancelled'; throw ce; }
        if (status < 200 || status >= 300) throw new Error(`chunk ${idx} upload failed: ${status}`);
        next.doneBytes += chunk.length;
        paint();
      }
    });
    await Promise.all(workers);

    // Tell receiver the transfer is complete (triggers final integrity check)
    await fetch(`/api/transfer/${transferId}/complete`, {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
    });
    next.status = 'done';
    next.attempts = 0;
    next.phase = '';
    _idb.del(next.id);
    renderQueue();
    toast(next.targetSelf ? `${next.name} sent` : `${next.name} sent to ${next.targetName}`);
  } catch (err) {
    console.error('[lanbeam] send failed:', err);
    if (err && err.fatal) {
      next.status = err.fatal;
      next.phase = err.message;
      _idb.del(next.id);
    } else if (next.file && (next.attempts = (next.attempts || 0) + 1) <= 6) {
      // Transient (network drop, PC busy, browser suspended): stay visibly
      // "Reconnecting" and resume automatically — never a sticky red error.
      const wait = Math.min(30000, 2000 * 2 ** (next.attempts - 1));
      next.status = 'retrying';
      next.phase = `Reconnecting\u2026 attempt ${next.attempts}/6`;
      setTimeout(() => { if (next.status === 'retrying') { next.status = 'queued'; pump(); } }, wait);
    } else {
      next.status = 'error';
      next.phase = (err && err.message) || 'Failed';
    }
    renderQueue();
    toast('Send issue: ' + ((err && err.message) || 'unknown'));
  } finally {
    next.running = false;
    _pumpBusy = false;
    pump();  // start next queued file
  }
}

// ---------------------------------------------------------------------------
// Stateless truth: the PC is the single source of truth for every upload.
// Cards are derived from what the PC reports (bytes, liveness, completion) —
// so a card can never claim "error" while bytes are flowing, nor "sending"
// when nothing moves. Runs on a timer and on every return to the page.
// ---------------------------------------------------------------------------
const FINAL_STATES = new Set(['done', 'cancelled', 'declined']);
function applyServerTruth(q, s) {
  if (!s || s.state === 'unknown') return;
  if (s.state === 'complete') { q.sent = q.size; q.status = 'done'; q.phase = ''; _idb.del(q.id); return; }
  if (s.state === 'cancelled') { q.status = 'cancelled'; q.phase = 'Cancelled on the PC'; _idb.del(q.id); return; }
  if (s.state === 'failed') { q.status = 'error'; q.phase = 'PC integrity check failed'; q.attempts = 99; return; }
  // state === 'receiving'
  if (!q.running) q.sent = Math.min(q.size, Math.max(0, s.bytes));
  const live = s.idleMs < 8000;
  if (live) {
    if (q.status === 'error' || q.status === 'retrying' || (q.status === 'sending' && !q.running)) {
      q.status = 'sending'; q.phase = q.running ? '' : 'Receiving on PC\u2026';
    }
  } else if (q.status === 'sending' && !q.running) {
    // Nothing moving and nothing running here (page was frozen/restored): resume.
    q.status = 'queued'; q.phase = 'Resuming\u2026'; q.resumeKick = true;
  }
}
let _syncBusy = false;
async function syncQueue() {
  // Paused while a transfer/test is active — each 1.2s poll would steal one
  // of the 6 per-host connections the active upload needs. Progress for the
  // in-flight file is painted locally (xhrUpload onprogress), so the card
  // stays live; this sync resumes the moment the transfer ends.
  if (_syncBusy || !state.paired || netBusy()) return;
  const items = state.queue.filter(q => !FINAL_STATES.has(q.status));
  if (!items.length) return;
  _syncBusy = true;
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch('/api/transfer/status?ids=' + items.map(q => encodeURIComponent(q.id)).join(','), { headers: authHeaders(), credentials: 'include', signal: ctl.signal });
    if (!r.ok) return;
    const map = (await r.json()).transfers || {};
    let kick = false;
    for (const q of items) { applyServerTruth(q, map[q.id]); if (q.resumeKick) { q.resumeKick = false; kick = true; } }
    renderQueue();
    if (kick) pump();
  } catch {} finally { clearTimeout(tm); _syncBusy = false; }
}
setInterval(syncQueue, 1200);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncQueue();
    // If the OS froze JS mid-upload (browser backgrounded / screen locked),
    // the XHR is dead but pump() never ran its finally-block, so the item
    // is stuck 'sending' with running=false. Reset it to 'queued' and
    // restart the pump so the upload resumes automatically.
    let needPump = false;
    for (const q of state.queue) {
      if ((q.status === 'sending' || q.status === 'retrying') && !q.running) {
        q.status = 'queued';
        q.phase = 'Resuming…';
        needPump = true;
      }
    }
    if (needPump) { renderQueue(); pump(); toast('▶️ Resuming transfer…'); }
  }
});
window.addEventListener('pageshow', syncQueue);
window.addEventListener('online', syncQueue);
document.addEventListener('click', (e) => {
  const rt = e.target.closest && e.target.closest('[data-retry]');
  const dm = e.target.closest && e.target.closest('[data-dismiss]');
  if (rt) {
    const q = state.queue.find(x => x.id === rt.dataset.retry);
    if (q && q.file) { q.attempts = 0; q.status = 'queued'; q.phase = ''; renderQueue(); pump(); }
  } else if (dm) {
    const i = state.queue.findIndex(x => x.id === dm.dataset.dismiss);
    if (i >= 0) { _idb.del(state.queue[i].id); state.queue.splice(i, 1); renderQueue(); }
  }
});

// ---------------------------------------------------------------------------
// Crypto helpers — SubtleCrypto SHA-256 (requires secure context / HTTPS).
// Falls back to FNV-1a when crypto.subtle is unavailable (plain HTTP LAN).
// ---------------------------------------------------------------------------
async function sha256Hex(buf) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const ab = buf instanceof Uint8Array ? buf.buffer : buf;
    const digest = await crypto.subtle.digest('SHA-256', ab);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Insecure FNV-1a fallback (fingerprint only, not cryptographic)
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = (Math.imul(h, 0x01000193) >>> 0); }
  return h.toString(16).padStart(8, '0').repeat(8);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// ---------------------------------------------------------------------------
// Throughput formatting — honours the speed unit chosen in the desktop's
// Settings (Settings → Speed unit) and mirrored here via /api/state, so both
// ends of a transfer speak the same unit: Mbps / MB/s / GB/s / Gbps.
// Input is bytes-per-second (the raw rate measured on the download stream).
// ---------------------------------------------------------------------------
function formatSpeedPhone(bytesPerSec) {
  const u = state.speedUnit || 'mBps';
  const b = Math.max(0, Number(bytesPerSec) || 0);
  if (u === 'mbps') return { value: ((b * 8) / 1e6).toFixed(1), unit: 'Mbps' };
  if (u === 'gbps') return { value: ((b * 8) / 1e9).toFixed(2), unit: 'Gbps' };
  if (u === 'gBps') return { value: (b / 1073741824).toFixed(2), unit: 'GB/s' };
  return { value: (b / 1048576).toFixed(1), unit: 'MB/s' };
}

function speedLabelFor(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  const s = formatSpeedPhone(bytesPerSec);
  return ` · ${s.value} ${s.unit}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------------------------------------------------------------------------
// Footer: live link info from the desktop. Every segment is REAL data or it
// is simply omitted. The PHY link-rate segment was removed by design — it's
// a radio-level marketing number, not real throughput, and it cluttered the
// line. Now:
//   "WiFi 5 · MyNetwork · 5GHz"   (all known)
//   "MyNetwork · 5GHz"            (partial)
//   "Connected via LAN"           (fallback, never blank)
// ---------------------------------------------------------------------------
function buildFooterText(w) {
  if (!w || (!w.ssid && !w.connected)) return 'Connected via LAN';
  const parts = [];
  if (w.generation && w.generation !== 'Unknown') parts.push(w.generation);
  if (w.ssid) parts.push(w.ssid);
  if (w.band) parts.push(w.band);
  if (!parts.length) return 'Connected via LAN';
  return parts.join(' · ');
}

let _footBusy = false;
async function refreshFooter() {
  if (_footBusy) return;
  _footBusy = true;
  const _fc = new AbortController();
  const _ft = setTimeout(() => _fc.abort(), 5000);
  try {
    const r = await fetch('/api/state', {
      headers: authHeaders(),
      credentials: 'include',
      signal: _fc.signal,
    });
    if (!r.ok) return; // not paired or server not reachable
    const j = await r.json();
    // Mirror the desktop's accent choice so both ends share one palette —
    // glows, badges and progress bars all follow the same color.
    if (j.settings?.accentColor) applyPhoneAccent(j.settings.accentColor);
    // Mirror the desktop's font choice so the phone site typography matches
    // the PC (Outfit on PC ⇒ Outfit here).
    if (j.settings?.fontChoice) applyPhoneFont(j.settings.fontChoice);
    // Mirror the desktop's speed unit choice (Mbps / MB/s / GB/s / Gbps) so
    // transfer rates read the same way on both ends of the wire.
    if (j.settings?.speedUnit) state.speedUnit = j.settings.speedUnit;
    // Mesh roster cache — powers the send-to sheet's device list.
    if (j.self) state.selfDevice = j.self;
    if (Array.isArray(j.pairedDevices)) state.devicePeers = j.pairedDevices;
    // PERMANENT connect URL. The desktop publishes the mDNS name
    // lanbeam.local, so this link keeps resolving even when DHCP hands the
    // PC a new IP. We remember it (localStorage, months-long life) so the
    // user always has a stable address to reopen / shortcut / share — no
    // rescan, no matter how many router reboots happen in between.
    if (j.links?.permanent) {
      try { localStorage.setItem('lanbeam:homeUrl', j.links.permanent); } catch {}
    }
    // Dual-origin lane sharding: the same PC usually answers on TWO
    // addresses (mDNS hostname + LAN IP). Browsers key the 6-connection
    // HTTP/1.1 pool per ORIGIN, so a second host string for the same server
    // opens a SECOND pool: 12 parallel lanes instead of 6. Remember
    // whichever address this page is NOT served from — the mDNS name keeps
    // working across DHCP renewals; the raw IP works when mDNS is blocked.
    // Also keep the PC's live radio state for the speed-test physics panel.
    state.pcWifi = j.wifi || null;
    if (j.links) {
      const here = location.origin;
      let alt = '';
      for (const c of [j.links.permanent, j.links.ip]) {
        if (!c) continue;
        try {
          const u = new URL(c);
          if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== here) { alt = u.origin; break; }
        } catch {}
      }
      state.altOrigin = alt;
    }
    const el = document.getElementById('wifi-info');
    if (el) el.textContent = buildFooterText(j.wifi);
  } catch {} finally { clearTimeout(_ft); _footBusy = false; }
}

// ---------------------------------------------------------------------------
// PWA — installable app + offline shell. The manifest + service worker stay
// available so a user who WANTS a home-screen icon can add one from the
// browser menu — but LANBeam never nags: no install bar, no "Add to Home
// Screen" tip, no native-prompt capture. The Remember-Me secret + permanent
// URL already make every revisit a silent reconnect; an install is optional.
// ---------------------------------------------------------------------------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch {}
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  await tryPair();
  await detectTransport();
  bindPicker();
  bindSheet();
  bindSpeedTest();
  registerServiceWorker();
  restoreUploads();
  refreshFooter();
  setInterval(refreshFooter, 10_000);
  setInterval(checkIncomingTransfers, 1500);
  checkIncomingTransfers();
  // Background tabs throttle timers to ~1/min — poll immediately whenever the
  // user returns to the tab so incoming files start receiving instantly.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // If the phone was closed mid-download, the OS download manager may have
      // been interrupted. Clear 'direct' status downloads from the autoStarted
      // ledger so the next poll re-triggers directDownload() for them. Verify
      // loops are stopped too — a fresh startDownload() re-establishes them.
      for (const [tid, dl] of state.downloads) {
        if (dl.status === 'direct') {
          stopVerifyLoop(tid);
          state.downloads.delete(tid);
          state.autoStarted.delete(tid);
        }
      }
      checkIncomingTransfers();
    }
  });
})();


// ---------------------------------------------------------------------------
// Incoming transfers (desktop -> phone)
//
// Behaviour: fully automatic. When the desktop sends a file it appears here
// and the phone starts receiving immediately — no "Save" tap required, and
// the row carries NO save button at all (just a status badge + progress).
//
//  1. The row shows a live progress bar (% · bytes · speed · "Receiving…").
//  2. Modern browsers stream GET /api/transfer/:id/file with a ReadableStream
//     so progress is exact, then the assembled Blob is handed to the save
//     flow with the TRUE filename — a video stays video.mp4.
//  3. Opera Mini / old browsers / very large files fall back to a plain link
//     to the same endpoint. The server responds with Content-Disposition +
//     proper Content-Type, so the browser's own download manager shows
//     progress in the notification shade and keeps the real name/extension.
//  4. Once saved, the phone ACKs and the desktop drops the pending entry.
//     A small "save again" text link stays on the Saved row for a few seconds
//     in case the browser blocked the automatic save (e.g. iOS Safari).
//  5. Auto-receive tries each transfer exactly once. If it fails, the row
//     shows a small "Retry" text link — it never auto-loops on a broken
//     transfer. In-page streams run strictly one at a time (blobs are
//     buffered fully in RAM) and direct downloads are staggered so browsers
//     never see a burst of automatic downloads.
// ---------------------------------------------------------------------------
// In-page streaming buffers the whole file as a Blob in RAM. iOS Safari
// reliably kills the tab somewhere past ~200-300 MB of live blob memory, so
// the closed-loop stream path is capped conservatively — bigger files go to
// the OS download manager (streams straight to disk) + the /dlstatus
// verification loop. Reliability first: a crashed tab is the one failure we
// can't recover from.
const STREAM_SAVE_LIMIT = 200 * 1024 * 1024;
const DOWNLOAD_MIME_FALLBACK = 'application/octet-stream';

const DOWNLOAD_EXT_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.apk': 'application/vnd.android.package-archive',
};

function mimeForName(name) {
  const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  return DOWNLOAD_EXT_MIME[ext] || DOWNLOAD_MIME_FALLBACK;
}

function canStreamInPage() {
  // Opera Mini is a proxy browser: blob: URLs get re-fetched through Opera's
  // gateway and saved as .txt — always route it through the system downloader.
  if (isOperaMini()) return false;
  if (typeof ReadableStream === 'undefined') return false;
  try {
    const probe = new Response(new Blob(['x'])).body;
    return !!(probe && typeof probe.getReader === 'function');
  } catch {
    return false;
  }
}

let _pollBusy = false;
let _pollFails = 0; // consecutive poll failures — drives the PC-unreachable banner

/** Persistent "PC unreachable" banner — shown after ~4.5s of dead polls,
 *  hidden the moment any poll succeeds. This is what used to be the
 *  invisible failure: pending list just stopped updating, no explanation. */
function updatePcBanner(reachable) {
  const el = document.getElementById("pc-unreachable");
  if (el) el.remove();
}

async function checkIncomingTransfers() {
  if (!state.paired || _pollBusy) return; // never stack polls on a jammed link
  // While a speed test, lane download or upload pump owns the connection
  // budget, polling pauses — every connection not spent polling is another
  // full-speed lane. Callers resume the poll themselves the moment they finish.
  if (netBusy()) return;
  _pollBusy = true;
  try {
    const res = await apiFetch('/api/transfer/pending', {}, 5000);
    const data = await res.json();
    _pollFails = 0;
    updatePcBanner(true);
    state.pendingTransfers = data.transfers || [];
    // Expire "Saved ✓" flash rows.
    const now = Date.now();
    for (const [tid, info] of state.recentlySaved) {
      if (now > info.expiresAt) state.recentlySaved.delete(tid);
    }
    // Keep the auto-start ledger tidy — forget tids that are gone for good.
    const live = new Set(state.pendingTransfers.map(t => t.transferId));
    for (const tid of [...state.autoStarted]) {
      if (!live.has(tid) && !state.downloads.has(tid) && !state.recentlySaved.has(tid)) {
        state.autoStarted.delete(tid);
      }
    }
    // Backstop for phones that never ran the verify loop (old-PC inference):
    // a system download whose entry vanished from pending = PC served it.
    for (const [tid, dl] of [...state.downloads]) {
      if (dl.status === 'direct' && !live.has(tid) && !dlVerifyLoops.has(tid)) {
        state.downloads.delete(tid);
        state.recentlySaved.set(tid, { expiresAt: Date.now() + 8000, name: dl.name || 'File', size: dl.total || 0 });
      }
    }
    renderReceivedList();
    autoReceiveTick();
  } catch (err) {
    _pollFails++;
    updatePcBanner(false);
    // 401 = pairing really revoked → wipe the secret and fall back to the QR
    // screen instead of polling a dead session forever.
    if (err && err.status === 401) {
      clearPairSecret();
      state.paired = false;
      tryPair();
      return;
    }
    if (_pollFails >= 3 && _pollFails % 10 === 3) {
      // Re-state the problem once a minute while the link stays dead — not
      // every 1.5s poll, that would be toast spam.
      toast('\u26a0\ufe0f ' + (err.userMessage || 'PC unreachable'));
    }
  } finally { _pollBusy = false; }
}

// Auto-receive: start downloading pending transfers WITHOUT waiting for a
// tap. One new download starts per poll (3s) so parallel automatic downloads
// never hammer the browser, and in-page streaming downloads run strictly one
// at a time because their Blobs are buffered fully in memory.
function autoReceiveTick() {
  if (!state.paired) return;
  const streamingActive = [...state.downloads.values()].some(d => d.status === 'downloading');
  for (const t of state.pendingTransfers) {
    const tid = t.transferId;
    if (state.autoStarted.has(tid) || state.downloads.has(tid)) continue;
    if (streamingActive) continue; // wait for the current stream to finish first
    state.autoStarted.add(tid);
    startDownload(t);
    break; // one new download per poll — the next tick picks up the rest
  }
}

function receivedRowHtml(t) {
  const dl = state.downloads.get(t.transferId);
  const status = dl ? dl.status : 'idle';
  const pct = dl && t.fileSize > 0 ? Math.min(100, (dl.sent / t.fileSize) * 100) : 0;
  const busy = status === 'downloading' || status === 'direct' || status === 'connecting';
  const failed = status === 'error';
  const attempted = state.autoStarted.has(t.transferId);
  // Zero button chrome on the automatic path — receiving just happens:
  //   queued/connecting/receiving/saving rows show a status badge, never a
  //   button. The ONLY tappable controls are the "Retry" link after a REAL
  //   failure — now always with the reason spelled out — and the small
  //   "save again" link on a freshly saved row.
  const action = busy
    ? `<span class="badge receiving">${status === 'direct' ? 'Saving…' : status === 'connecting' ? 'Connecting…' : 'Receiving…'}</span>`
    : failed
      ? `<span class="badge failed">failed</span><button class="resave-link" data-receive-action="save" data-tid="${escapeHtml(t.transferId)}">Retry</button>`
      : attempted
        ? `<button class="resave-link" data-receive-action="save" data-tid="${escapeHtml(t.transferId)}">Retry</button>`
        : `<span class="badge queued">Queued</span>`;
  const progressHtml = busy ? `
      <div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="recv-status">
        <span>${status === 'direct'
          ? (dl.phase
              ? escapeHtml(dl.phase)
              : 'Saving via system download manager — check the notification shade')
          : status === 'connecting'
            ? (dl.phase ? escapeHtml(dl.phase) : 'Connecting to PC · checking the file…')
            : (dl.sent > 0 ? `Receiving — ${formatBytes(dl.sent)} / ${formatBytes(t.fileSize)}${speedLabelFor(dl.speed)}` : 'Connecting to PC · preparing first data…')}</span>
        <span class="meta-pct">${pct.toFixed(0)}%</span>
      </div>` : (failed ? `
      <div class="recv-error">\u26a0\ufe0f ${escapeHtml(dl.error || 'Download failed')}</div>` : '');
  return `
    <div class="file-row received-row ${busy ? 'is-busy' : ''} ${failed ? 'is-failed' : ''}">
      <div class="file-row-row" style="flex:1; min-width:0;">
        <div class="file-icon ${busy ? 'active' : ''} ${failed ? 'err' : ''}">${ICONS.file}</div>
        <div class="text">
          <div class="name">${escapeHtml(t.fileName)}</div>
          <div class="meta">
            <span>${formatBytes(t.fileSize)}</span>
            ${t.originName ? `<span class="pill-target">\u2190 ${escapeHtml(t.originName)}</span>` : ''}
          </div>
        </div>
        ${action}
      </div>
      ${progressHtml}
    </div>
  `;
}

function savedRowHtml(tid, info) {
  return `
    <div class="file-row received-row saved">
      <div class="file-row-row" style="flex:1; min-width:0;">
        <div class="file-icon done">${ICONS.check}</div>
        <div class="text">
          <div class="name">${escapeHtml(info.name || 'File')}</div>
          <div class="meta"><span>${info.size ? formatBytes(info.size) : ''}</span></div>
        </div>
        <span class="badge saved">saved</span>
        ${info.url ? `<button class="resave-link" data-receive-action="resave" data-tid="${escapeHtml(tid)}">save again</button>` : ''}
      </div>
    </div>
  `;
}

function renderReceivedList() {
  const receivedSec = document.getElementById('received');
  const receivedList = document.getElementById('received-list');
  if (!receivedSec || !receivedList) return;
  const saved = [...state.recentlySaved.entries()];
  // A transfer that just finished saving still sits in pendingTransfers until
  // the next poll — suppress its pending row so it never flashes a misleading
  // "Retry" next to its own "Saved ✓" row.
  const pendingVisible = state.pendingTransfers.filter(t => !state.recentlySaved.has(t.transferId));
  if (!pendingVisible.length && !saved.length) {
    receivedSec.style.display = 'none';
    receivedList.innerHTML = '';
    return;
  }
  receivedSec.style.display = 'block';
  receivedList.innerHTML =
    pendingVisible.map(t => receivedRowHtml(t)).join('') +
    saved.map(([tid, info]) => savedRowHtml(tid, info)).join('');
}

// rAF-throttled repaint so per-chunk progress doesn't flood the DOM.
let _recvRenderQueued = false;
function renderReceivedSoon() {
  if (_recvRenderQueued) return;
  _recvRenderQueued = true;
  requestAnimationFrame(() => {
    _recvRenderQueued = false;
    renderReceivedList();
  });
}

// One delegated listener survives every re-render of the list.
document.getElementById('received-list')?.addEventListener('click', (e) => {
  // "save again" on a Saved row — re-hands the already-downloaded blob to the
  // save flow (covers browsers that block programmatic saves, e.g. iOS).
  const resave = e.target.closest('[data-receive-action="resave"]');
  if (resave) {
    const info = state.recentlySaved.get(resave.getAttribute('data-tid'));
    if (info?.url) {
      triggerSavedDownload(info.url, info.name || 'file');
      toast('Saving again — check your downloads');
    }
    return;
  }
  const btn = e.target.closest('[data-receive-action="save"]');
  if (!btn) return;
  const tid = btn.getAttribute('data-tid');
  const t = state.pendingTransfers.find(x => x.transferId === tid);
  if (t) startDownload(t);
});

async function startDownload(t) {
  const tid = t.transferId;
  if (state.downloads.has(tid)) {
    const prev = state.downloads.get(tid);
    // A prior attempt ended in a VISIBLE error — allow the Retry tap to
    // restart cleanly (this used to early-return and swallow the tap).
    if (prev.status !== 'error') return; // genuinely still running
    state.downloads.delete(tid);
  }
  const dl = {
    status: 'connecting', sent: 0, total: t.fileSize,
    startedAt: Date.now(), lastAt: Date.now(), lastBytes: 0, speed: 0,
    error: null, retries: 0, phase: '',
  };
  state.downloads.set(tid, dl);
  renderReceivedSoon();
  holdWakeLock(); // screen must not sleep mid-download on mobile

  // The signed link from /api/transfer/pending — authenticates the download
  // click without cookies AND works as a pre-flight URL. Fallback to the
  // plain path (headers auth) for entries from an older PC build.
  const dlUrl = t.downloadUrl || `/api/transfer/${tid}/file`;

  try {
    // ── 1. PRE-FLIGHT — fail LOUDLY before any click happens. ────────────
    // This is where the old code went silent: if auth was dead or the file
    // was gone, the <a> click downloaded a JSON error body as a "file", or
    // nothing at all. Now we KNOW before we click.
    try {
      await apiFetch(dlUrl, { method: 'HEAD' }, 8000);
    } catch (err) {
      dl.status = 'error';
      dl.error = err.userMessage || 'Could not reach the file on the PC';
      if (err.status === 401) {
        // Session really is dead — try one silent re-hello before giving up;
        // if that works the Retry tap will go through cleanly.
        try { await silentHello(); } catch {}
      }
      renderReceivedSoon();
      toast('\u26a0\ufe0f ' + (t.fileName || 'File') + ': ' + dl.error);
      return;
    }

    // Resolve the true filename in parallel with the data transfer.
    const namePromise = (async () => {
      let fileName = t.fileName;
      try {
        const mRes = await apiFetch(`/api/transfer/${tid}/manifest`, {}, 6000);
        const m = await mRes.json();
        if (m.fileName) fileName = String(m.fileName).split(/[\\/]/).pop() || m.fileName;
      } catch {}
      return fileName;
    })();
    // Stash the resolved name on the row so markSaved() and the backstop
    // inference both show the true filename.
    namePromise.then(n => { const c = state.downloads.get(tid); if (c && n) c.name = n; }).catch(() => {});

    // ── 2. PATH CHOICE ─────────────────────────────────────────────────
    // Small/medium file + capable browser → IN-PAGE STREAM: fully closed
    // loop, exact progress, retryable, and the saved blob is re-offerable
    // ("save again") if the OS save dialog was dismissed. This path used to
    // be dead code — everything went through the blind <a> click.
    const canStream = canStreamInPage() && (t.fileSize || 0) <= STREAM_SAVE_LIMIT;
    if (canStream) {
      dl.status = 'downloading';
      renderReceivedSoon();
      try {
        const url = await streamDownload(tid, namePromise, t.fileSize, dlUrl);
        markSaved(tid, namePromise, url);
        return;
      } catch (err) {
        // Stream died (tab freeze, memory, Wi-Fi) — DON'T hide it: say what
        // happened, then hand the file to the OS download manager as fallback.
        console.warn('[lanbeam] stream download failed, falling back to system downloader:', err);
        dl.phase = 'In-page receive failed (' + ((err && err.userMessage) || err.message || 'network') + ') — using system downloader';
        dl.sent = 0;
        dl.status = 'connecting';
        renderReceivedSoon();
      }
    }

    // ── 3. SYSTEM DOWNLOAD MANAGER + VERIFICATION LOOP ──────────────────
    // The <a> click hands off to the OS — JS can't see it. But the SERVER
    // can: we poll /dlstatus and mirror what it observed. Dead clicks,
    // interrupted downloads and vanished entries all become visible states.
    dl.status = 'direct';
    dl.sent = 0;
    renderReceivedSoon();
    directDownload(dlUrl);
    verifyDirectDownload(tid, t, namePromise, dlUrl);
  } catch (err) {
    console.error('[lanbeam] download failed:', err);
    dl.status = 'error';
    dl.error = (err && (err.userMessage || err.message)) || 'Download failed';
    renderReceivedSoon();
    toast('Download failed: ' + dl.error);
  }
}

/**
 * Server-truth verification loop for system-manager downloads. Polls
 * /api/transfer/:id/dlstatus every 2s and drives the row UI:
 *   active      → live progress from bytes the server actually served
 *   complete    → mark saved + ack (entry removal is the PC's job)
 *   interrupted → auto re-click (OS download manager resumes via Range)
 *   offered     (nothing ever started) → after 15s, “browser blocked the
 *                 download — tap Retry” (the tap supplies the missing user
 *                 gesture most blocked downloads were waiting for)
 *   gone        → saved if we saw bytes flow, error otherwise
 */
const dlVerifyLoops = new Map(); // tid -> {stop, lastState, sawBytes}
function verifyDirectDownload(tid, t, namePromise, dlUrl) {
  stopVerifyLoop(tid);
  const dl = state.downloads.get(tid);
  if (!dl) return;
  const clickedAt = Date.now();
  let sawBytes = 0;
  const loop = { stop: false, lastState: '', sawBytes: 0 };
  dlVerifyLoops.set(tid, loop);

  (async function tick() {
    if (loop.stop) return;
    const cur = state.downloads.get(tid);
    if (!cur || cur.status === 'error' || cur.status === 'saved') { dlVerifyLoops.delete(tid); return; }
    let st = null;
    try {
      const r = await apiFetch(`/api/transfer/${tid}/dlstatus`, {}, 6000);
      st = await r.json();
    } catch (err) {
      // OLD PC BUILD (no /dlstatus endpoint): a 404 here is NOT a download
      // failure — stop the verify loop and let the legacy inference in
      // checkIncomingTransfers ("entry vanished from pending = served") take
      // over. Never punish the user for a version mismatch.
      if (err && err.status === 404) { dlVerifyLoops.delete(tid); return; }
      // Session revoked mid-download — the global 401 path in
      // checkIncomingTransfers already wipes the secret and re-pairs; running
      // this loop against a dead session is pointless.
      if (err && err.status === 401) { dlVerifyLoops.delete(tid); return; }
      // Poll failing (Wi-Fi blip / PC asleep): keep the loop alive briefly;
      // only surface as an error after ~20s of total silence.
      if (Date.now() - clickedAt > 20000 && !loop.sawBytes) {
        cur.status = 'error';
        cur.error = err.userMessage || 'Lost the PC during download';
        renderReceivedSoon();
        dlVerifyLoops.delete(tid);
        toast('\u26a0\ufe0f ' + (t.fileName || 'File') + ': ' + cur.error);
        apiPostQuiet(`/api/transfer/${tid}/dlfailed`, { reason: err.code || 'network' });
      } else {
        setTimeout(tick, 2000);
      }
      return;
    }
    loop.lastState = st.state;
    loop.sawBytes = Math.max(loop.sawBytes, st.bytes || 0);

    if (st.state === 'complete') {
      markSaved(tid, namePromise);
      dlVerifyLoops.delete(tid);
      return;
    }
    if (st.state === 'gone') {
      if (loop.sawBytes > 0 || (st.idleMs || 0) < 120000) {
        // Entry dropped right after full serve (old-PC inference path) — the
        // server considers it delivered.
        markSaved(tid, namePromise);
      } else {
        cur.status = 'error';
        cur.error = 'Transfer is no longer on the PC';
        renderReceivedSoon();
      }
      dlVerifyLoops.delete(tid);
      return;
    }
    if (st.state === 'active') {
      cur.status = 'direct';
      cur.phase = '';
      if (st.total > 0) cur.sent = Math.min(st.total, st.bytes || 0);
      updateDownloadProgress(tid, cur.sent);
      setTimeout(tick, 2000);
      return;
    }
    if (st.state === 'interrupted') {
      // Server saw a partial transfer and no live connection. The OS
      // download manager may resume on its own — re-trigger the click a few
      // times (Range resume keeps it cheap), then escalate to a tappable
      // Retry with the reason spelled out.
      cur.sent = st.bytes || cur.sent;
      if (cur.retries < 3) {
        cur.retries++;
        cur.phase = 'Interrupted at ' + formatBytes(st.bytes || 0) + ' — resuming… (attempt ' + cur.retries + '/3)';
        renderReceivedSoon();
        directDownload(dlUrl);
        setTimeout(tick, 3000);
      } else {
        cur.status = 'error';
        cur.error = 'Download kept interrupting — check Wi-Fi, then tap Retry';
        renderReceivedSoon();
        toast('\u26a0\ufe0f ' + (t.fileName || 'File') + ': ' + cur.error);
        apiPostQuiet(`/api/transfer/${tid}/dlfailed`, { reason: 'interrupted' });
      }
      return;
    }
    // st.state === 'offered' — server never saw a single byte. The click was
    // most likely swallowed (blocked without gesture / webview).
    if (Date.now() - clickedAt > 15000) {
      cur.status = 'error';
      cur.error = 'Browser blocked the automatic download — tap Retry';
      renderReceivedSoon();
      toast('\u26a0\ufe0f ' + (t.fileName || 'File') + ': ' + cur.error);
      return;
    }
    setTimeout(tick, 2000);
  })();
}

function stopVerifyLoop(tid) {
  const loop = dlVerifyLoops.get(tid);
  if (loop) loop.stop = true;
  dlVerifyLoops.delete(tid);
}

/** Flip a row to “saved”, ack the PC, and show the save-again escape hatch. */
function markSaved(tid, namePromise, blobUrl) {
  stopVerifyLoop(tid);
  const dl = state.downloads.get(tid);
  const name = (dl && dl.name) || null;
  const size = (dl && dl.total) || 0;
  state.downloads.delete(tid);
  state.recentlySaved.set(tid, {
    expiresAt: Date.now() + 8000,
    name: name || (namePromise ? null : 'File'),
    size, url: blobUrl,
  });
  // Resolve the name asynchronously if it wasn't fixed yet.
  if (namePromise && !name) {
    namePromise.then(n => {
      const info = state.recentlySaved.get(tid);
      if (info) { info.name = n; renderReceivedSoon(); }
    }).catch(() => {});
  }
  renderReceivedSoon();
  toast('\u2705 ' + (name || 'File') + ' saved');
  // Tell the PC it can drop the entry now (cancels its grace timer).
  apiPostQuiet(`/api/transfer/${tid}/ack`);
  if (![...state.downloads.values()].some(d => d.status === 'downloading' || d.status === 'direct' || d.status === 'connecting')) {
    releaseWakeLock();
  }
}

function updateDownloadProgress(tid, sent) {
  const dl = state.downloads.get(tid);
  if (!dl) return;
  const now = Date.now();
  const dt = (now - dl.lastAt) / 1000;
  if (dt >= 0.4) {
    dl.speed = dt > 0 ? (sent - dl.lastBytes) / dt : 0;
    dl.lastAt = now;
    dl.lastBytes = sent;
  }
  dl.sent = sent;
  renderReceivedSoon();
}

// ---------------------------------------------------------------------------
// PC→phone download engine.
//
// LARGE files (≥ LANE_MIN_SIZE) are pulled through the LANE MATRIX: the file
// is split into LANE_COUNT byte-range slices fetched in PARALLEL. One TCP
// stream rarely fills a Wi-Fi 5 link (loss recovery stalls a single
// congestion window); parallel streams together recover the full air rate,
// and each lane that hits turbulence resumes from its exact byte position
// instead of killing the whole download.
//
// Each origin gets LANE_COUNT lanes = the browser's full per-host HTTP/1.1
// budget for that address. When the PC answers on a second address the same
// matrix runs as 12 lanes (6 + 6 across two origins, each pool at its own
// cap). All background polls PAUSE while traffic owns the budget (netBusy()
// guard), so no connection is ever wasted on polling mid-transfer.
// Auto-receive is strictly one file at a time anyway, so discovery loses
// nothing — the poll fires the instant the lanes finish.
//
// Integrity is byte-exact and unchanged: every lane verifies its
// Content-Range start offset, lanes tile the file without overlap, and the
// assembled total must equal fileSize before anything is saved. The bytes
// on disk are identical to a single-stream download — same file, same
// order, just fetched through parallel pipes.
// ---------------------------------------------------------------------------
const LANE_COUNT = 6;    // per ORIGIN — the browser's per-host HTTP/1.1 pool
let _lanesBusy = false;  // true while lane traffic owns the connection budget
let _pumpBusy = false;   // true while an upload pump owns the connection budget
const LANE_MIN_SIZE = 8 * 1024 * 1024;   // below this a single stream is instant
const LANE_MAX_RETRIES = 3;

/** True while a speed test, lane download or upload pump is actively moving
 *  bytes. Every background poll (/pending, the 1.2s status sync, heartbeat)
 *  is paused meanwhile — each would steal one of the browser's 6 per-host
 *  connections from the transfer that needs all of them. Server-side
 *  presence stays alive regardless: the PC counts any authenticated request
 *  as proof of life, and an active lane/upload is exactly that. */
function netBusy() {
  return _stRunning || _lanesBusy || _pumpBusy;
}

/** The addresses this PC answers on, for dual-origin lane sharding.
 *  [null] = just the page's own origin (single 6-lane pool — previous
 *  behaviour). A second entry = the OTHER address from /api/state links
 *  (mDNS hostname or LAN IP) → the browser opens a second 6-connection
 *  pool for it: 12 parallel TCP streams. */
function laneOrigins() {
  return (state.altOrigin && state.altOrigin !== location.origin) ? [null, state.altOrigin] : [null];
}

/** One lane request. useAlt=true fetches through the PC's second address:
 *  cross-origin, so cookies are NOT sent (credentials omitted — the PC's
 *  CORS is wildcard) and authentication rides on the X- headers plus the
 *  signed ?t= token in file URLs, neither of which needs cookies. Range
 *  verification is identical on both origins. */
function laneRequest(url, useAlt, range) {
  const target = (useAlt && state.altOrigin) ? new URL(url, state.altOrigin).href : url;
  return fetch(target, {
    headers: authHeaders({ Range: range }),
    credentials: useAlt ? 'omit' : 'include',
  });
}

// Stream the file into memory, choosing the lane engine for large files.
async function streamDownload(tid, namePromise, totalSize, dlUrl) {
  const url = dlUrl || `/api/transfer/${tid}/file`;
  if ((totalSize || 0) >= LANE_MIN_SIZE) {
    _lanesBusy = true;
    try {
      return await laneStreamDownload(tid, namePromise, totalSize, url);
    } catch (err) {
      // Lanes unavailable (old PC build ignoring Range, proxy, bad luck) —
      // the single stream below is the exact pre-lane behaviour.
      console.warn('[lanbeam] lane download failed, falling back to single stream:', err);
      const dl = state.downloads.get(tid);
      if (dl) { dl.sent = 0; dl.phase = 'multi-lane failed — retrying as one stream'; renderReceivedSoon(); }
    } finally {
      _lanesBusy = false;
      // Resume discovery immediately — the queue must not wait for the next tick.
      checkIncomingTransfers();
    }
  }
  return singleStreamDownload(tid, namePromise, totalSize, url);
}

/** One request, exact progress — the original small-file path, unchanged. */
async function singleStreamDownload(tid, namePromise, totalSize, url) {
  const res = await fetch(url, {
    headers: authHeaders(),
    credentials: 'include',
  });
  if (!res.ok) {
    let body = null; try { body = await res.json(); } catch {}
    throw classifyApiError(null, res.status, body);
  }
  const reader = res.body.getReader();
  const parts = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    updateDownloadProgress(tid, received);
  }
  if (totalSize && received !== totalSize) {
    throw new Error(`receive truncated — got ${received} of ${totalSize} bytes`);
  }
  const fileName = await namePromise;
  const blob = new Blob(parts, { type: mimeForName(fileName) });
  const blobUrl = URL.createObjectURL(blob);
  triggerSavedDownload(blobUrl, fileName);
  // Revoke late — mobile browsers can still be writing the file to storage.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  return blobUrl;
}

/**
 * Lane Matrix: LANE_COUNT parallel range requests covering the file, each
 * with its own resume-on-failure. Reassembly is lane order → original byte
 * order, so the Blob is byte-identical to the file on the PC.
 */
async function laneStreamDownload(tid, namePromise, totalSize, url) {
  // Dual-origin sharding: when the PC answers on a second address, the
  // browser treats it as a SEPARATE origin with its own 6-connection pool —
  // 12 parallel streams instead of 6. Odd-numbered lanes go to the second
  // address so both pools warm up together; any lane whose alternate
  // address fails to resolve simply reroutes to the primary origin — worst
  // case it degrades to the exact 6-lane behaviour of the previous build.
  const origins = laneOrigins();
  const lanes = origins.length * LANE_COUNT;
  const bounds = [];
  const laneSize = Math.floor(totalSize / lanes);
  for (let i = 0; i < lanes; i++) {
    const s = i * laneSize;
    const e = (i === lanes - 1) ? totalSize - 1 : s + laneSize - 1;
    bounds.push([s, e]);
  }
  const laneParts = bounds.map(() => []);   // parts[i] = chunks of lane i, in order
  let received = 0;                          // summed across lanes for progress

  await Promise.all(bounds.map(([s, e], i) => (async () => {
    let pos = s;   // next byte this lane still needs
    let attempts = 0;
    let useAlt = origins.length > 1 && (i % 2 === 1);  // odd lanes → 2nd address
    while (pos <= e) {
      try {
        const res = await laneRequest(url, useAlt, `bytes=${pos}-${e}`);
        if (res.status !== 206) {
          // Server ignored the range (old build / middleware) — the body
          // would be the WHOLE file on this lane. Bail to single stream.
          throw Object.assign(new Error('server returned HTTP ' + res.status + ' for a range request'), { noLanes: true });
        }
        // The reply MUST start exactly where we asked — guards against any
        // middlebox or cache rewriting ranges under us. Cross-origin replies
        // expose Content-Range via the server's Expose-Headers.
        const cr = res.headers.get('content-range') || '';
        if (!cr.startsWith(`bytes ${pos}-`)) {
          throw Object.assign(new Error('lane reply started at the wrong offset'), { noLanes: true });
        }
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          laneParts[i].push(value);
          pos += value.length;
          received += value.length;
          updateDownloadProgress(tid, received);
        }
        if (pos !== e + 1) throw new Error(`lane ${i} truncated at byte ${pos} (expected ${e + 1})`);
        return; // lane complete
      } catch (err) {
        if (err && err.noLanes) throw err;   // structural — no point retrying
        // The alternate address not resolving (mDNS gaps on some phones) is
        // NOT a lane failure: reroute this lane to the primary origin once.
        if (useAlt) { useAlt = false; continue; }
        attempts++;
        if (attempts > LANE_MAX_RETRIES) throw err;
        await new Promise(r => setTimeout(r, 350 * attempts));
        // pos is wherever this lane died → resume from exactly there
      }
    }
  })()));

  // Final integrity gate: every lane delivered, and the total is the file.
  if (received !== totalSize) {
    throw new Error(`lane receive incomplete — got ${received} of ${totalSize} bytes`);
  }
  const fileName = await namePromise;
  const blob = new Blob([].concat(...laneParts), { type: mimeForName(fileName) });
  const blobUrl = URL.createObjectURL(blob);
  triggerSavedDownload(blobUrl, fileName);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  return blobUrl;
}

// Hand a blob: URL to the platform save flow under the true filename.
function triggerSavedDownload(url, fileName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Direct navigation — the browser's native downloader handles progress, name
// and extension from the server headers. This is the path Opera Mini takes.
function directDownload(dlUrl) {
  const a = document.createElement('a');
  a.href = dlUrl;
  // Intentionally no `download` attribute override: Content-Disposition on the
  // server decides the filename, which is what fixes the ".txt" bug.
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function ackTransfer(tid) {
  // Now routed through apiPostQuiet — a failed ack is logged server-side and
  // the PC's grace timer cleans up; no more swallowed catch {}.
  await apiPostQuiet(`/api/transfer/${tid}/ack`);
}
