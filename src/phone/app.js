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
  if (status === 'error') return ICONS.error;
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
function startHeartbeat() {
  if (state.heartbeatTimer) return; // already running
  const beat = () => {
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
    }).catch(() => {}); // fire-and-forget; network hiccups are fine
  };
  beat(); // immediate first beat
  state.heartbeatTimer = setInterval(beat, 15000); // every 15s
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
  }
  renderQueue();
  pump();
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
    ...state.queue.filter(q => q.status === 'sending'),
    ...state.queue.filter(q => q.status !== 'sending').reverse(),
  ];
  list.innerHTML = ordered.map(item => {
    const pct = item.size > 0 ? (item.sent / item.size * 100) : 0;
    const iconClass = item.status === 'done' ? 'done' : item.status === 'error' ? 'error' : item.status === 'sending' ? 'active' : '';
    const fillClass = item.status === 'error' ? 'error' : item.status === 'done' ? 'done' : '';
    // Mesh pill — a quiet arrow naming the destination (only when it's not
    // the PC, so the everyday single-device look stays untouched).
    const targetPill = (!item.targetSelf && item.targetName)
      ? `<span class="pill-target">\u2192 ${escapeHtml(item.targetName)}</span>`
      : '';
    return `
      <div class="file-row ${item.status === 'sending' ? 'live' : ''}" data-id="${item.id}">
        <div class="file-row-row">
          <div class="file-icon ${iconClass}">${iconForStatus(item.status)}</div>
          <div class="text">
            <div class="name">${escapeHtml(item.name)}</div>
            <div class="meta">
              <span>${formatBytes(item.sent)} / ${formatBytes(item.size)}</span>
              ${targetPill}
              <span class="meta-pct">${pct.toFixed(0)}%</span>
            </div>
          </div>
          <span class="badge ${item.status}">${item.status}</span>
        </div>
        <div class="bar"><div class="fill ${fillClass}" style="width:${pct.toFixed(1)}%"></div></div>
      </div>
    `;
  }).join('');
}

// ---------------------------------------------------------------------------
// Sender: build manifest locally, then push chunks in parallel.
// ---------------------------------------------------------------------------
async function pump() {
  const next = state.queue.find(q => q.status === 'queued');
  if (!next) return;
  next.status = 'sending';
  renderQueue();

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
    const startResp = await fetch('/api/transfer/start', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify(manifest),
    });
    if (!startResp.ok) {
      // Structured failures from the desktop's ask-mode gate / revoked sessions.
      let reason = 'start failed (' + startResp.status + ')';
      try {
        const j = await startResp.json();
        if (startResp.status === 403) reason = 'Declined on the desktop';
        else if (startResp.status === 408) reason = 'Approval timed out on the desktop';
        else if (startResp.status === 401) { reason = 'Not paired — scan the QR again'; clearPairSecret(); }
        else if (j?.error) reason = String(j.error);
      } catch {}
      throw new Error(reason);
    }
    const { transferId } = await startResp.json();

    // Pump chunks in parallel — up to maxParallelStreams concurrent fetches.
    let nextIdx = 0;
    const workers = Array.from({ length: Math.min(state.maxParallelStreams, totalChunks) }, async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= totalChunks) break;
        const chunk = chunks[idx];
        const blob = next.file.slice(chunk.offset, chunk.offset + chunk.length);
        const buf = await blob.arrayBuffer();
        const r = await fetch(`/api/transfer/${transferId}/chunk`, {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Index': String(idx),
            'X-Compressed': chunk.compressed ? '1' : '0',
          }),
          credentials: 'include',
          body: buf,
        });
        if (!r.ok) throw new Error(`chunk ${idx} upload failed: ${r.status}`);
        next.sent += chunk.length;
        renderQueue();
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
    renderQueue();
    toast(next.targetSelf ? `${next.name} sent` : `${next.name} sent to ${next.targetName}`);
  } catch (err) {
    console.error('[lanbeam] send failed:', err);
    next.status = 'error';
    renderQueue();
    toast('Send failed: ' + err.message);
  } finally {
    pump();  // start next queued file
  }
}

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

async function refreshFooter() {
  try {
    const r = await fetch('/api/state', {
      headers: authHeaders(),
      credentials: 'include',
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
    const el = document.getElementById('wifi-info');
    if (el) el.textContent = buildFooterText(j.wifi);
  } catch {}
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
  registerServiceWorker();
  refreshFooter();
  setInterval(refreshFooter, 10_000);
  setInterval(checkIncomingTransfers, 3000);
  checkIncomingTransfers();
  // Background tabs throttle timers to ~1/min — poll immediately whenever the
  // user returns to the tab so incoming files start receiving instantly.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkIncomingTransfers();
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
const STREAM_SAVE_LIMIT = 700 * 1024 * 1024; // above this, use the system downloader (memory safety)
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

async function checkIncomingTransfers() {
  if (!state.paired) return;
  try {
    const res = await fetch('/api/transfer/pending', {
      headers: authHeaders(),
      credentials: 'include',
    });
    if (!res.ok) return;
    const data = await res.json();
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
    renderReceivedList();
    autoReceiveTick();
  } catch {}
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
  const busy = status === 'downloading' || status === 'direct';
  const attempted = state.autoStarted.has(t.transferId);
  // Zero button chrome on the automatic path — receiving just happens:
  //   queued/receiving/saving rows show a status badge, never a button.
  //   The ONLY tappable controls are the tiny "Retry" link after a real
  //   failure (one auto attempt per transfer, never a loop) and the small
  //   "save again" link on a freshly saved row (browser blocked the save).
  const action = busy
    ? `<span class="badge receiving">${status === 'direct' ? 'Saving…' : 'Receiving…'}</span>`
    : attempted
      ? `<button class="resave-link" data-receive-action="save" data-tid="${escapeHtml(t.transferId)}">Retry</button>`
      : `<span class="badge queued">Queued</span>`;
  const progressHtml = busy ? `
      <div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="recv-status">
        <span>${status === 'direct'
          ? 'Saving via system download manager — check the notification shade'
          : `Receiving — ${formatBytes(dl.sent)} / ${formatBytes(t.fileSize)}${speedLabelFor(dl.speed)}`}</span>
        <span class="meta-pct">${pct.toFixed(0)}%</span>
      </div>` : '';
  return `
    <div class="file-row received-row ${busy ? 'is-busy' : ''}">
      <div class="file-row-row" style="flex:1; min-width:0;">
        <div class="file-icon ${busy ? 'active' : ''}">${ICONS.file}</div>
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
  if (state.downloads.has(tid)) return; // already running
  state.downloads.set(tid, {
    status: 'downloading', sent: 0, total: t.fileSize,
    startedAt: Date.now(), lastAt: Date.now(), lastBytes: 0, speed: 0,
  });
  renderReceivedSoon();
  try {
    // Authoritative copy of the name from the manifest (handles renames).
    let fileName = t.fileName;
    try {
      const mRes = await fetch(`/api/transfer/${tid}/manifest`, {
        headers: authHeaders(),
        credentials: 'include',
      });
      if (mRes.ok) {
        const m = await mRes.json();
        if (m.fileName) fileName = String(m.fileName).split(/[\\/]/).pop() || m.fileName;
        if (m.fileSize) state.downloads.get(tid).total = m.fileSize;
      }
    } catch {}

    const size = state.downloads.get(tid).total || t.fileSize;
    if (canStreamInPage() && size <= STREAM_SAVE_LIMIT) {
      const url = await streamDownload(tid, fileName, size);
      await ackTransfer(tid);
      state.downloads.delete(tid);
      // Keep the blob URL around briefly so "save again" can re-trigger the
      // platform save flow if the browser blocked the automatic one.
      state.recentlySaved.set(tid, { expiresAt: Date.now() + 8000, name: fileName, size, url });
      toast(fileName + ' saved to your device');
    } else {
      // Opera Mini / legacy browsers / huge files: hand the transfer to the
      // browser's own download manager. The server sends Content-Type +
      // Content-Disposition so the real filename and extension survive.
      directDownload(tid);
      state.downloads.get(tid).status = 'direct';
      renderReceivedSoon();
      toast('Download started — check the notification shade');
      // Give the user time to finish in the system downloader, then stop
      // advertising the file so it disappears from "From desktop".
      setTimeout(async () => {
        const dl = state.downloads.get(tid);
        if (dl && dl.status === 'direct') {
          try { await ackTransfer(tid); } catch {}
          state.downloads.delete(tid);
          state.recentlySaved.set(tid, { expiresAt: Date.now() + 8000, name: fileName, size });
          renderReceivedSoon();
        }
      }, 3 * 60 * 1000);
    }
    renderReceivedSoon();
  } catch (err) {
    console.error('[lanbeam] download failed:', err);
    state.downloads.delete(tid); // "Retry" link returns so the user can retry
    renderReceivedSoon();
    toast('Download failed: ' + err.message);
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

// Stream the whole file over ONE request with exact in-page progress.
async function streamDownload(tid, fileName, totalSize) {
  const res = await fetch(`/api/transfer/${tid}/file`, {
    headers: authHeaders(),
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Server returned ' + res.status);
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
  // Assemble with the correct MIME type so the platform treats it as the real
  // file type, and save under the true name — video.mp4 stays video.mp4.
  const blob = new Blob(parts, { type: mimeForName(fileName) });
  const url = URL.createObjectURL(blob);
  triggerSavedDownload(url, fileName);
  // Revoke late — mobile browsers can still be writing the file to storage.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return url;
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
function directDownload(tid) {
  const a = document.createElement('a');
  a.href = `/api/transfer/${tid}/file`;
  // Intentionally no `download` attribute override: Content-Disposition on the
  // server decides the filename, which is what fixes the ".txt" bug.
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function ackTransfer(tid) {
  try {
    await fetch(`/api/transfer/${tid}/ack`, {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
    });
  } catch {} // non-fatal: desktop will drop the entry when it can
}
