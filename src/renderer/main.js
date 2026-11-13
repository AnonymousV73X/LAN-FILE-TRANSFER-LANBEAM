const explorerState = {
  devices: [],
  currentDeviceId: null,
  currentPath: "",
  items: [],
  historyStack: [],
  searchScope: "folder",
  searchDebounceTimer: null,
  selectedPaths: new Set(),
  devicePaths: {}, // last visited path per deviceId
  isSplitView: false,
  splitLeft: {
    deviceId: null,
    currentPath: "",
    items: [],
    historyStack: [],
    selectedPaths: new Set(),
    searchQuery: "",
  },
  splitRight: {
    deviceId: null,
    currentPath: "",
    items: [],
    historyStack: [],
    selectedPaths: new Set(),
    searchQuery: "",
  },
};
function initCustomDropdown(id, onChange) {
  const root = document.getElementById(id);
  if (!root) return;
  const trigger = root.querySelector(".dropdown-trigger");
  const selectedLabel = root.querySelector(".dropdown-selected");
  const items = root.querySelectorAll(".dropdown-item");

  trigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    // Close other dropdowns
    document.querySelectorAll(".custom-dropdown.open").forEach((d) => {
      if (d !== root) d.classList.remove("open");
    });
    root.classList.toggle("open");
  });

  items.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const val = item.dataset.value;
      root.dataset.value = val;
      if (selectedLabel) selectedLabel.textContent = item.textContent;
      items.forEach((it) => it.classList.toggle("selected", it === item));
      root.classList.remove("open");
      onChange?.(val);
    });
  });
}

document.addEventListener("click", () => {
  document
    .querySelectorAll(".custom-dropdown.open")
    .forEach((d) => d.classList.remove("open"));
});
function updateHistoryNav(show) {
  let isEnabled;
  if (typeof show === "boolean") {
    isEnabled = show;
    try {
      localStorage.setItem("lanbeam:showHistory", show ? "true" : "false");
    } catch (_) {}
  } else if (
    state.settings &&
    typeof state.settings.showHistory === "boolean"
  ) {
    isEnabled = state.settings.showHistory;
  } else {
    try {
      isEnabled = localStorage.getItem("lanbeam:showHistory") === "true";
    } catch (_) {
      isEnabled = false;
    }
  }

  const btn = document.getElementById("nav-history-btn");
  if (btn) btn.style.display = isEnabled ? "flex" : "none";
  if (!isEnabled && state.view === "history") {
    renderView("home");
  }
}

/* ==========================================================================
   LANBeam desktop renderer logic.
   - Single-page view swap (Home / Devices / History / Settings) into #content.
   - Theme swatch picker updates --accent-color live across the whole app.
   - Wire-up, device list, transfer events, sparkline, benchmark.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// In-app modal alert — replaces native window.alert() so notices blend with
// the LANBeam AMOLED+cyan theme. Single-action (OK). Auto-focused, ESC to
// dismiss, Enter to confirm. Lazily created on first use.
// ---------------------------------------------------------------------------
const MODAL_ICONS = {
  info: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

let _modalOverlay = null;
let _modalResolve = null;

function _ensureModal() {
  if (_modalOverlay && document.body.contains(_modalOverlay))
    return _modalOverlay;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-top">
        <div class="modal-icon"></div>
        <div class="modal-text">
          <div class="modal-title"></div>
          <div class="modal-message"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-primary" data-modal-action="ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _modalOverlay = overlay;

  const okBtn = overlay.querySelector('[data-modal-action="ok"]');
  const dismiss = (result) => {
    if (!_modalOverlay) return;
    _modalOverlay.classList.remove("open");
    const r = _modalResolve;
    _modalResolve = null;
    // Restore focus to previously-focused element handled by caller.
    if (r) r(result);
  };
  okBtn?.addEventListener("click", () => dismiss(true));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss(false); // click on backdrop = cancel
  });
  // Keyboard: Enter = OK, Esc = cancel.
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dismiss(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismiss(false);
    }
  });
  return overlay;
}

/**
 * Show a themed modal alert.
 * @param {object} opts
 * @param {string} opts.title - Headline (short).
 * @param {string} opts.message - Body text.
 * @param {'info'|'error'|'warn'} [opts.kind='info'] - Icon + accent.
 * @param {string} [opts.confirmText='OK'] - Label for the action button.
 * @returns {Promise<boolean>} Resolves true on confirm, false on dismiss.
 */
function showModalAlert({
  title,
  message,
  kind = "info",
  confirmText = "OK",
} = {}) {
  const overlay = _ensureModal();
  const iconEl = overlay.querySelector(".modal-icon");
  if (iconEl) {
    iconEl.className = "modal-icon" + (kind === "error" ? " error" : "");
    iconEl.innerHTML = MODAL_ICONS[kind] || MODAL_ICONS.info;
  }
  overlay.querySelector(".modal-title").textContent = title || "";
  overlay.querySelector(".modal-message").textContent = message || "";
  const okBtn = overlay.querySelector('[data-modal-action="ok"]');
  if (okBtn) okBtn.textContent = confirmText;
  // Remember currently focused element so we can restore focus on dismiss.
  const previouslyFocused = document.activeElement;
  overlay.classList.add("open");
  // Focus the OK button after the open transition for keyboard users.
  requestAnimationFrame(() => okBtn?.focus());
  return new Promise((resolve) => {
    _modalResolve = (result) => {
      previouslyFocused?.focus?.();
      resolve(!!result);
    };
  });
}

const state = {
  view: "home",
  qr: null,
  pairedDevices: [],
  peers: [],
  history: [],
  settings: null,
  wifi: null,
  spark: [],
  currentTransfer: null,
  ipUrl: "", // direct-IP fallback link (shown under the QR)
  permanentHost: "", // 'lanbeam.local' — the permanent mDNS name
};

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------
// Every view is built ONCE, kept mounted in its own pane and only shown/hidden
// afterwards: no DOM rebuild, no re-binding, live elements (transfer card,
// device lists) keep updating while hidden, so switching is instant. Panes for
// the other views are pre-built in idle time right after first paint.
const _panes = {};
const _viewBinders = {
  home: () => bindHome(),
  devices: () => bindDevices(),
  history: () => renderHistory(),
  cloudsync: () => refreshCloudSync(),
  settings: () => bindSettings(),
  explorer: () => bindExplorer(),
  speedtest: () => bindSpeedTest(),
  cloudsync: () => bindCloudSync(),
};
const _viewRefresh = {
  home: () => {
    if (state.qr) renderQr();
    renderDevices();
  },
  devices: () => renderDevicesView(),
  history: () => renderHistory(),
  // Instant Shell: re-populate control VALUES on every open (listeners are
  // bound once in bindSettings). This closes the old hole where a pane
  // prewarmed before state:get landed kept showing template defaults.
  settings: () => syncSettingsControls(),
  explorer: () => refreshExplorer(),
  speedtest: () => {},
};
let _prewarmScheduled = false;
// Instant Shell prewarm — mount every remaining view one frame apart,
// starting the frame after the first view paints. Deterministic (idle
// callbacks can be starved for seconds on a cold-boot machine, which is
// exactly when the user starts clicking) yet budgeted: one binder per
// frame keeps input responsive on the weakest CPUs. Settings and History
// go first — the heaviest panes and the ones users open first. The 1.2s
// timer backstop covers backgrounded windows where rAF is paused.
function _scheduleInstantShellPrewarm() {
  const order = ["settings", "history", "devices", "speedtest"];
  let i = 0;
  const step = () => {
    if (i >= order.length) return;
    const v = order[i++];
    try {
      _mountView(v);
    } catch (err) {
      console.error("[lanbeam] prewarm failed:", v, err);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  setTimeout(() => {
    for (const v of order) {
      try {
        _mountView(v);
      } catch {}
    }
  }, 1200);
}
function _mountView(view) {
  let pane = _panes[view];
  if (pane && pane.isConnected) return { pane, fresh: false };
  const content = $("#content");
  const tpl = document.getElementById(`view-${view}`);
  if (!content || !tpl) return { pane: null, fresh: false };
  pane = document.createElement("div");
  pane.className = "view-pane";
  pane.dataset.pane = view;
  pane.style.display = "none";
  pane.appendChild(tpl.content.cloneNode(true));
  content.appendChild(pane);
  _panes[view] = pane;
  _viewBinders[view]?.();
  return { pane, fresh: true };
}
// Built-in profiler: every view switch logs "script" (JS time) and "paint"
// (time until the frame is on screen); anything >50ms on the main thread is
// reported as a long task. Open DevTools (Ctrl+Shift+I) -> Console to read it.
try {
  new PerformanceObserver((l) =>
    l
      .getEntries()
      .forEach((e) =>
        console.warn(`[perf] long task ${e.duration.toFixed(0)}ms`),
      ),
  ).observe({ entryTypes: ["longtask"] });
} catch {}
function renderView(view) {
  const _t0 = performance.now();
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-view") === view);
  });
  _floatShow(!!state.floatActive);
  const { pane, fresh } = _mountView(view);
  if (!pane) return;
  for (const v in _panes)
    _panes[v].style.display = v === view ? "contents" : "none";
  if (!fresh) _viewRefresh[view]?.();
  const _tJs = performance.now() - _t0;
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      console.info(
        `[perf] view=${view} ${fresh ? "BUILT" : "cached"} script=${_tJs.toFixed(1)}ms paint=${(performance.now() - _t0).toFixed(1)}ms history=${state.history.length}`,
      ),
    ),
  );
  if (!_prewarmScheduled) {
    _prewarmScheduled = true;
    _scheduleInstantShellPrewarm();
  }
}

// ---------------------------------------------------------------------------
// Home view
// ---------------------------------------------------------------------------
function bindHome() {
  // Drop zone handlers
  const dz = $("#dropzone");
  const input = $("#dropzone-input");
  if (dz && input) {
    dz.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      // Snapshot the File objects FIRST, then clear the value. Without the
      // clear, re-picking the SAME file in a later round leaves the input's
      // value unchanged — Chromium never fires `change`, and the send dies
      // before it starts, with no error anywhere. (The "re-send the same
      // file fails silently" bug.) File objects — and Electron's File.path —
      // stay fully valid after the reset.
      const picked = Array.from(input.files || []);
      input.value = "";
      if (picked.length) onFilesPicked(picked);
    });
    ["dragenter", "dragover"].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.add("dragover");
      }),
    );
    ["dragleave", "drop"].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.remove("dragover");
      }),
    );
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      const dt = e.dataTransfer;
      if (dt?.files?.length) onFilesPicked(Array.from(dt.files));
    });
  }

  // Render QR if available
  if (state.qr) renderQr();
  renderDevices();
}

function renderQr() {
  const img = document.getElementById("qr-image");
  if (img && state.qr) {
    img.src = state.qr.png;
    img.style.display = "";
    const skel = document.getElementById("qr-skeleton");
    if (skel) skel.remove();
    const frame = document.getElementById("qr-frame");
    if (frame) frame.classList.add("qr-loaded");
  }
  const urlInput = document.getElementById("qr-url-text");
  if (urlInput && state.qr) urlInput.value = state.qr.url;
  // The magnifier cursor is regenerated per-render so a freshly mounted home
  // pane always carries the current theme tint (see applyQrCursor).
  applyQrCursor();
  const copyBtn = document.getElementById("qr-copy-btn");
  if (copyBtn && state.qr) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(state.qr.url);
      const prev = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = prev;
      }, 1500);
    };
  }
  // Bookmark hint removed.
  const alt = document.getElementById("qr-alt-url");
  if (alt) {
    alt.hidden = true;
    alt.innerHTML = "";
  }
  // Click / Enter / Space on the QR frame opens the enlarged lightbox.
  const frame = document.getElementById("qr-frame");
  if (frame && !frame.dataset.qrBound) {
    frame.dataset.qrBound = "1";
    frame.addEventListener("click", openQrLightbox);
    frame.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openQrLightbox();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// QR lightbox — clicking the QR card pops the code up ENLARGED on a pure
// white, max-brightness card so the camera locks on instantly. While the
// lightbox is open we ask Electron to keep the display awake (no dimming or
// sleep mid-scan). Esc / click-outside / ✕ close it.
// ---------------------------------------------------------------------------
let _qrLightbox = null;
let _qrLightboxPrevFocus = null;

function _qrPowerSave(on) {
  try {
    window.lanbeam?.app?.setPowerSave?.(!!on);
  } catch {}
}

function openQrLightbox() {
  if (!state.qr) return;
  closeQrLightbox(true); // rebuild each open so the code is always current
  const lb = document.createElement("div");
  lb.className = "qr-lightbox";
  lb.setAttribute("role", "dialog");
  lb.setAttribute("aria-modal", "true");
  lb.setAttribute("aria-label", "Enlarged pairing QR code");
  lb.innerHTML = `
    <div class="qr-lightbox-card">
      <button class="qr-lightbox-close" aria-label="Close enlarged QR code">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="qr-lightbox-frame"><img src="${state.qr.png}" alt="Pair QR code enlarged" draggable="false" /></div>
      <div class="qr-lightbox-url" data-tip="${escapeHtml(state.qr.url)}">${escapeHtml(state.qr.url)}</div>
      <div class="qr-lightbox-hint">Point your phone camera at the code to pair</div>
    </div>
  `;
  document.body.appendChild(lb);
  _qrLightbox = lb;
  _qrLightboxPrevFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  requestAnimationFrame(() => {
    lb.classList.add("open");
    lb.querySelector(".qr-lightbox-close")?.focus();
  });
  lb.addEventListener("click", (e) => {
    if (e.target === lb) closeQrLightbox();
  });
  lb.querySelector(".qr-lightbox-close")?.addEventListener("click", () =>
    closeQrLightbox(),
  );
  document.addEventListener("keydown", _qrLightboxKeydown);
  _qrPowerSave(true); // display stays awake at full brightness while scanning
}

function _qrLightboxKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeQrLightbox();
  }
}

function closeQrLightbox(immediate = false) {
  const lb = _qrLightbox;
  if (!lb) return;
  _qrLightbox = null;
  document.removeEventListener("keydown", _qrLightboxKeydown);
  _qrPowerSave(false);
  const finish = () => {
    try {
      lb.remove();
    } catch {}
  };
  if (immediate) {
    finish();
  } else {
    lb.classList.remove("open");
    setTimeout(finish, 220);
  }
  if (_qrLightboxPrevFocus?.isConnected) _qrLightboxPrevFocus.focus();
  _qrLightboxPrevFocus = null;
}

const FONT_VARS = {
  figtree: "var(--font-figtree)",
  outfit: "var(--font-outfit)",
  system: "var(--font-system)",
};
// Instant Shell theme cache — read by the anti-FOUC <head> script BEFORE
// first paint and reconciled against the real settings once state:get
// lands. Persisted on every applyAccent/applyFont so the app never boots
// in the wrong theme, no matter how slow the disk is.
function readCachedTheme() {
  try {
    return JSON.parse(localStorage.getItem("lanbeam:theme") || "null");
  } catch {
    return null;
  }
}
function writeCachedTheme(patch) {
  try {
    const t = { ...readCachedTheme(), ...patch };
    localStorage.setItem("lanbeam:theme", JSON.stringify(t));
  } catch {}
}
// Pure variable setter — no IPC, no swatches, no cursor rebuild. Shared by
// the boot-time cache paint (must be side-effect free) and applyAccent.
function applyThemeVars(color, fontChoice) {
  const rs = document.documentElement.style;
  rs.setProperty("--accent-color", color);
  const rgb = hexToRgb(color);
  if (rgb) {
    rs.setProperty("--accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    rs.setProperty("--accent-soft", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
    rs.setProperty(
      "--accent-very-soft",
      `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.06)`,
    );
  }
  if (fontChoice) {
    rs.setProperty("--font-sans", FONT_VARS[fontChoice] || FONT_VARS.figtree);
  }
}
function applyFont(choice) {
  const fontVal = FONT_VARS[choice] || FONT_VARS.figtree;
  document.documentElement.style.setProperty("--font-sans", fontVal);
  writeCachedTheme({ fc: choice });
  if (state.settings) {
    state.settings.fontChoice = choice;
    window.lanbeam?.settings?.update?.({ fontChoice: choice });
  }
}

// Single source of truth for presence: the main process owns `online`
// (open presence stream / in-flight transfer request), so cards flip in
// milliseconds. Falls back to lastSeen only for payloads without the flag.
function isOnline(d) {
  if (!d) return false;
  if (typeof d.online === "boolean") return d.online;
  return Date.now() - (d.lastSeen || 0) < 30 * 1000;
}

// One physical device = one card. Prefer the online record, then newest.
function dedupeDevices(list) {
  const best = new Map();
  for (const d of list) {
    const key = d.deviceId
      ? d.ip
        ? `${d.kind}::${d.name}::${d.ip}`
        : `id::${d.deviceId}`
      : `n::${d.name}`;
    const cur = best.get(key);
    if (
      !cur ||
      (isOnline(d) && !isOnline(cur)) ||
      (isOnline(d) === isOnline(cur) && (d.lastSeen || 0) > (cur.lastSeen || 0))
    )
      best.set(key, d);
  }
  return [...best.values()];
}

function renderDevices() {
  const host = document.getElementById("device-cards");
  if (!host) return;
  const activeTransferPeer = state.currentTransferId
    ? (state.currentTransfer?.peerName ?? null)
    : null;

  const activeDevices = dedupeDevices(
    state.pairedDevices.filter(
      (d) =>
        isOnline(d) || (activeTransferPeer && d.name === activeTransferPeer),
    ),
  ).sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
  if (!activeDevices.length) {
    host.innerHTML = `<div class="empty-hint">No active devices online. Just quickly scan QR CODE and connect your device (Make sure it's on the same network).</div>`;
  } else {
    host.innerHTML = activeDevices.map((d) => deviceCardHtml(d, true)).join("");
  }
  const count = activeDevices.length;
  const counter = document.getElementById("device-count");
  if (counter)
    counter.textContent = `${count} device${count === 1 ? "" : "s"} online`;
}

function linkSummary() {
  // Real radio info from the OS (netsh / iw / airport) — never a fake "WiFi 6E".
  const w = state.wifi;
  if (w && w.connected && w.generation && w.generation !== "Unknown") {
    const parts = [w.generation];
    if (w.band) parts.push(w.band);
    if (w.phyRateMbps) parts.push(w.phyRateMbps + " Mbps");
    return parts.join(" · ");
  }
  if (w && w.connected) return "WiFi";
  return "LAN";
}

function deviceCardHtml(d, online) {
  const kindIcon =
    d.kind === "phone"
      ? phoneIcon
      : d.kind === "desktop"
        ? desktopIcon
        : phoneIcon;
  // Two clean lines — the status lives in a compact pill beside the name and
  // the link summary is a quiet text line below. No icon soup, no kind label
  // (the device icon already says phone/desktop; details live in the popup).
  const badge = online
    ? '<span class="device-badge online">Connected</span>'
    : `<span class="device-badge">Offline · ${escapeHtml(timeAgo(d.lastSeen))}</span>`;
  return `
    <div class="device-card clickable" data-device-id="${escapeHtml(d.deviceId)}" role="button" tabindex="0" aria-label="Show details for ${escapeHtml(d.name)}">
      <div class="device-icon">${kindIcon}</div>
      <div class="device-info">
        <div class="device-top">
          <span class="device-name">${escapeHtml(d.name)}</span>
          ${badge}
        </div>
        <div class="device-sub">${escapeHtml(linkSummary())}</div>
      </div>
      <div class="device-chevron">${chevronIcon}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Pending shares (from NovaTune) — send automatically once a device is online
// ---------------------------------------------------------------------------
function setPendingShares(list) {
  state.pendingShares = list || [];
  renderShareBanner();
  flushPendingShares();
}

function renderShareBanner() {
  let b = document.getElementById("share-pending");
  const n = (state.pendingShares || []).length;
  if (!n) return b?.remove();
  if (!b) {
    b = document.createElement("div");
    b.id = "share-pending";
    b.className = "share-pending";
    b.addEventListener("click", (e) => {
      if (e.target.closest("[data-cancel]")) {
        window.lanbeam.share.clear();
        setPendingShares([]);
      } else if (e.target.closest("[data-send]")) {
        state._shareHold = false;
        flushPendingShares();
      }
    });
    document.body.appendChild(b);
  }
  const first = escapeHtml(state.pendingShares[0].name);
  b.innerHTML = `<span class="share-pending-text">${n === 1 ? first : first + " +" + (n - 1) + " more"} — waiting for a device</span>
    <button type="button" data-send>Send</button><button type="button" data-cancel>Cancel</button>`;
}

async function flushPendingShares() {
  const files = state.pendingShares || [];
  if (!files.length || state._shareBusy || state._shareHold) return;
  const online = dedupeDevices(state.pairedDevices.filter(isOnline));
  if (!online.length) return;
  state._shareBusy = true;
  try {
    const peer =
      online.length === 1 ? online[0] : await chooseDevicePopover(online);
    if (!peer) {
      state._shareHold = true; // cancelled — wait for a new connection or "Send"
      return;
    }
    const batch = files.slice();
    window.lanbeam.share.clear(batch.map((f) => f.path));
    state.pendingShares = state.pendingShares.filter((f) => !batch.includes(f));
    renderShareBanner();
    onFilesPicked(batch, peer);
  } finally {
    state._shareBusy = false;
  }
}

async function onFilesPicked(files, targetDevice) {
  const ONLINE_MS = 30 * 1000;
  const now = Date.now();
  let peer = targetDevice;
  try {
    if (!peer) {
      const onlinePeers = dedupeDevices(state.pairedDevices.filter(isOnline));
      if (!onlinePeers.length) {
        showModalAlert({
          title: "No device connected",
          message:
            "No connected devices are online right now. Please scan the QR code with your phone first.",
          kind: "warn",
          confirmText: "Got it",
        });
        return;
      }
      // Mesh choice: ONE device online → send immediately (zero extra clicks).
      // 2+ online → a small picker asks which one. Esc / backdrop cancels.
      if (onlinePeers.length === 1) {
        peer = onlinePeers[0];
      } else {
        peer = await chooseDevicePopover(onlinePeers);
        if (!peer) return; // cancelled — files stay untouched
      }
    }

    // Multi-file queue mode:
    //   Sequential   = one card at a time; the next file only starts AFTER
    //                  the current transfer fully completes or fails.
    //   Simultaneous = all files start immediately, each with its own card.
    const isSimultaneous =
      state.settings && state.settings.sendQueueMode === "simultaneous";

    // Initialise resolver map -- the transfer:event handler resolves
    // these when a transfer's complete/failed event fires.
    if (!state._seqResolvers) state._seqResolvers = new Map();

    const stageAndCard = async function (file) {
      const fp = file.path || file.name;
      const name =
        file.name || (typeof fp === "string" ? fp.split(/[\/]/).pop() : "file");
      if (!fp) {
        failTransferCard(
          'Cannot read "' + name + '" — the file has no local path',
        );
        return null;
      }
      try {
        const tid = await window.lanbeam.transfer.send({
          filePath: fp,
          fileName: name,
          peerHost: peer.ip || peer.host || "127.0.0.1",
          peerPort: peer.port || 0,
          transport: "http",
          peerName: peer.name,
          targetDeviceId: peer.deviceId,
        });
        if (tid) {
          updateTransferCard(
            {
              fileId: tid,
              fileName: name,
              totalBytes: file.size || 0,
              bytesTransferred: 0,
              peerName: peer.name,
              throughputMbps: 0,
              etaMs: 0,
              sparkline: [],
            },
            "out",
          );
        }
        return tid;
      } catch (err) {
        console.error("Failed to send file:", name, err);
        failTransferCard(err && err.message ? err.message : "send failed");
        return null;
      }
    };

    // Returns a Promise that resolves when the given transfer finishes.
    // The transfer:event handler resolves these via state._seqResolvers.
    const waitForTransfer = function (tid) {
      return new Promise(function (resolve) {
        if (!tid) return resolve(false);
        // Already completed before we got here (fast LAN race condition) — resolve now
        if (state._completedTids && state._completedTids.has(tid)) {
          state._completedTids.delete(tid);
          return resolve(true);
        }
        state._seqResolvers.set(tid, resolve);
        // Safety valve: unblock after 5 min in case an event is ever lost
        setTimeout(
          function () {
            if (state._seqResolvers.has(tid)) {
              state._seqResolvers.delete(tid);
              resolve(false);
            }
          },
          5 * 60 * 1000,
        );
      });
    };

    if (isSimultaneous) {
      // All files launch at once -- each gets its own independent card
      await Promise.all(files.map(stageAndCard));
    } else {
      // Sequential: one card visible at a time; wait for full completion
      for (const file of files) {
        const tid = await stageAndCard(file);
        if (tid) await waitForTransfer(tid);
      }
    }
  } catch (err) {
    // The send TRIGGER itself broke (device picker, card DOM, IPC wiring).
    // This is exactly the "fails silently, no clue why" class of bug — the
    // flow must never die without telling the user what happened.
    console.error("Send flow failed:", err);
    try {
      showModalAlert({
        title: "Could not start the send",
        message:
          (err && err.message) ||
          "Something went wrong while preparing the transfer. Try again — if it keeps happening, restart the app.",
        kind: "error",
        confirmText: "OK",
      });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Device picker — the PC-side twin of the phone's bottom sheet. Only appears
// when 2+ devices are online; one click targets that device.
// ---------------------------------------------------------------------------
let _pickOverlay = null;

function chooseDevicePopover(devices) {
  return new Promise((resolve) => {
    if (_pickOverlay) {
      _pickOverlay.remove();
      _pickOverlay = null;
    }
    const overlay = document.createElement("div");
    overlay.className = "pick-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Choose a device");
    const rows = devices
      .slice()
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .map((d) => {
        const kindIcon =
          d.kind === "phone"
            ? phoneIcon
            : d.kind === "desktop"
              ? desktopIcon
              : phoneIcon;
        return `
          <button type="button" class="pick-row" data-pick-id="${escapeHtml(d.deviceId)}">
            <span class="pick-row-icon">${kindIcon}</span>
            <span class="pick-row-name">${escapeHtml(d.name || "Device")}</span>
            <span class="device-badge online">Connected</span>
            <span class="pick-row-chev">${chevronIcon}</span>
          </button>
        `;
      })
      .join("");
    overlay.innerHTML = `
      <div class="pick-modal">
        <div class="pick-title">Send to</div>
        <div class="pick-list">${rows}</div>
        <button type="button" class="pick-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(overlay);
    _pickOverlay = overlay;
    const finish = (device) => {
      overlay.classList.remove("open");
      setTimeout(() => {
        try {
          overlay.remove();
        } catch {}
      }, 180);
      if (_pickOverlay === overlay) _pickOverlay = null;
      document.removeEventListener("keydown", onKey);
      resolve(device || null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        finish(null);
        return;
      }
      const row = e.target.closest(".pick-row");
      if (!row) return;
      const d = devices.find(
        (x) => x.deviceId === row.getAttribute("data-pick-id"),
      );
      finish(d || null);
    });
    overlay
      .querySelector(".pick-cancel")
      ?.addEventListener("click", () => finish(null));
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => {
      overlay.classList.add("open");
      overlay.querySelector(".pick-row")?.focus();
    });
  });
}

// ---------------------------------------------------------------------------
// Device info popup — click any device card to see full, accurate details.
// Every row is backed by real captured data (pairing record, HTTP-layer IP,
// User-Agent, OS WiFi query, transfer history) so nothing shows blank.
// ---------------------------------------------------------------------------
const DEVICE_MODAL_ICONS = {
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  unpair:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

function parseDesktopUserAgent(ua) {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /Windows NT 10/.test(ua)
    ? "Windows 10/11"
    : /Windows/.test(ua)
      ? "Windows"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Linux/.test(ua)
          ? "Linux"
          : /Android/.test(ua)
            ? "Android"
            : null;
  return [browser, os].filter(Boolean).join(" on ") || null;
}

/** Friendly description of the phone's browser+OS from its pairing-time UA. */
function describeDevice(d) {
  if (d.kind === "phone") {
    const fromUa = parseDesktopUserAgent(d.userAgent || "");
    return fromUa || "Mobile browser";
  }
  if (d.kind === "desktop") return "LANBeam desktop";
  return "Unknown device type";
}

function deviceFilesShared(d) {
  return state.history.filter((h) => h && h.peerName === d.name).length;
}

let _deviceModalOverlay = null;

function _ensureDeviceModal() {
  if (_deviceModalOverlay && document.body.contains(_deviceModalOverlay))
    return _deviceModalOverlay;
  const overlay = document.createElement("div");
  overlay.className = "device-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="device-modal">
      <div class="device-modal-head">
        <div class="device-modal-icon"></div>
        <div class="device-modal-title-wrap">
          <div class="device-modal-title"></div>
          <div class="device-modal-sub"></div>
        </div>
        <button class="device-modal-close" aria-label="Close">${DEVICE_MODAL_ICONS.close}</button>
      </div>
      <div class="device-modal-body"></div>
      <div class="device-modal-actions">
        <button class="device-modal-btn primary" data-dm-action="send">${DEVICE_MODAL_ICONS.send}<span>Send files</span></button>
        <button class="device-modal-btn danger" data-dm-action="unpair">${DEVICE_MODAL_ICONS.trash}<span>Unpair</span></button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _deviceModalOverlay = overlay;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDeviceModal();
  });
  overlay
    .querySelector(".device-modal-close")
    ?.addEventListener("click", closeDeviceModal);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDeviceModal();
    }
  });
  return overlay;
}

function closeDeviceModal() {
  if (!_deviceModalOverlay) return;
  _deviceModalOverlay.classList.remove("open");
  setTimeout(() => {
    try {
      _deviceModalOverlay?.remove();
    } catch {}
    _deviceModalOverlay = null;
  }, 200);
}

function modalRow(label, valueHtml, opts = {}) {
  return `
    <div class="dm-row ${opts.mono ? "mono" : ""}">
      <span class="dm-label">${escapeHtml(label)}</span>
      <span class="dm-value">${valueHtml}</span>
    </div>
  `;
}

function copyBtnHtml(text, title) {
  return `<button class="dm-copy" data-dm-copy="${escapeHtml(text)}" data-tip="${escapeHtml(title || "Copy")}">${DEVICE_MODAL_ICONS.copy}</button>`;
}

function showDeviceModal(deviceId) {
  const d = state.pairedDevices.find((x) => x.deviceId === deviceId);
  if (!d) return;
  const online = isOnline(d);
  const overlay = _ensureDeviceModal();

  const kindIcon =
    d.kind === "phone"
      ? phoneIcon
      : d.kind === "desktop"
        ? desktopIcon
        : phoneIcon;
  overlay.querySelector(".device-modal-icon").innerHTML = kindIcon;
  overlay.querySelector(".device-modal-title").textContent =
    d.name || "Unknown device";
  overlay.querySelector(".device-modal-sub").innerHTML =
    `<span class="status-dot ${online ? "status-dot-online" : ""}"></span> ${online ? "Connected" : "Last seen " + timeAgo(d.lastSeen)}`;

  const wifi = state.wifi;
  const linkText =
    wifi && wifi.connected
      ? [
          wifi.generation && wifi.generation !== "Unknown"
            ? wifi.generation
            : "WiFi",
          wifi.band,
          wifi.phyRateMbps ? wifi.phyRateMbps + " Mbps" : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "LAN";

  const sharedCount = deviceFilesShared(d);
  const rows = [
    modalRow(
      "Status",
      `${online ? '<span class="dm-pill ok">Online</span>' : `<span class="dm-pill">Offline · ${escapeHtml(timeAgo(d.lastSeen))}</span>`}`,
    ),
    modalRow(
      "Type",
      escapeHtml(
        d.kind === "phone"
          ? "Phone (browser)"
          : d.kind === "desktop"
            ? "Desktop"
            : d.kind || "device",
      ),
    ),
    modalRow("Running", escapeHtml(describeDevice(d))),
    modalRow("Link", escapeHtml(linkText)),
    modalRow(
      "IP address",
      d.ip
        ? `${escapeHtml(d.ip)}${copyBtnHtml(d.ip, "Copy IP")}`
        : '<span class="dm-unknown">Pending — appears after the next activity</span>',
    ),
    modalRow(
      "Paired",
      escapeHtml(d.pairedAt ? new Date(d.pairedAt).toLocaleString() : "—"),
    ),
    modalRow("Files shared", escapeHtml(String(sharedCount))),
    modalRow(
      "Device ID",
      `<span class="dm-trunc">${escapeHtml(d.deviceId)}</span>${copyBtnHtml(d.deviceId, "Copy device ID")}`,
    ),
    modalRow(
      "Fingerprint",
      `<span class="dm-trunc">${escapeHtml(String(d.fingerprint || "").slice(0, 24))}…</span>${d.fingerprint ? copyBtnHtml(d.fingerprint, "Copy fingerprint") : ""}`,
    ),
  ];
  overlay.querySelector(".device-modal-body").innerHTML = rows.join("");

  // Copy buttons (delegated on the overlay — survives body re-renders).
  overlay.querySelectorAll("[data-dm-copy]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.getAttribute("data-dm-copy"));
        const prev = btn.innerHTML;
        btn.innerHTML = "✓";
        setTimeout(() => {
          btn.innerHTML = prev;
        }, 1200);
      } catch {}
    };
  });

  const sendBtn = overlay.querySelector('[data-dm-action="send"]');
  const unpairBtn = overlay.querySelector('[data-dm-action="unpair"]');
  sendBtn.onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      if (input.files?.length) onFilesPicked(Array.from(input.files), d);
      input.remove();
    });
    input.click();
  };

  // Unpair = two-tap confirm inside the modal (no native confirm()).
  let armed = false;
  unpairBtn.onclick = async () => {
    if (!armed) {
      armed = true;
      unpairBtn.classList.add("armed");
      unpairBtn.innerHTML = `${DEVICE_MODAL_ICONS.unpair}<span>Tap again to confirm</span>`;
      setTimeout(() => {
        if (!unpairBtn.isConnected) return;
        armed = false;
        unpairBtn.classList.remove("armed");
        unpairBtn.innerHTML = `${DEVICE_MODAL_ICONS.trash}<span>Unpair</span>`;
      }, 2600);
      return;
    }
    // Optimistic: update the UI first, roll back if the IPC call fails.
    const _prevDevices = state.pairedDevices;
    state.pairedDevices = state.pairedDevices.filter(
      (x) => x.deviceId !== d.deviceId,
    );
    closeDeviceModal();
    if (state.view === "home") renderDevices();
    if (state.view === "devices") renderDevicesView();
    toast("Device removed");
    try {
      await window.lanbeam.devices.remove(d.deviceId);
    } catch (err) {
      console.error("Unpair failed:", err);
      state.pairedDevices = _prevDevices;
      if (state.view === "home") renderDevices();
      if (state.view === "devices") renderDevicesView();
      toast("Could not remove device");
    }
  };

  overlay.classList.add("open");
}

/** Discovered (mDNS) peers get a lighter popup — only discovery data exists. */
function showPeerModal(peerId) {
  const p = state.peers.find((x) => x.deviceId === peerId);
  if (!p) return;
  const overlay = _ensureDeviceModal();
  overlay.querySelector(".device-modal-icon").innerHTML = desktopIcon;
  overlay.querySelector(".device-modal-title").textContent =
    p.name || "Discovered peer";
  overlay.querySelector(".device-modal-sub").innerHTML =
    '<span class="status-dot status-dot-online"></span> Discovered via mDNS';
  const rows = [
    modalRow("Status", '<span class="dm-pill">Not paired</span>'),
    modalRow("Host", escapeHtml(p.host || "unknown host")),
    modalRow("Port", escapeHtml(String(p.port ?? "—"))),
    modalRow(
      "Device ID",
      `<span class="dm-trunc">${escapeHtml(p.deviceId || "")}</span>${p.deviceId ? copyBtnHtml(p.deviceId, "Copy device ID") : ""}`,
    ),
  ];
  overlay.querySelector(".device-modal-body").innerHTML = rows.join("");
  // Peers can't be sent to / unpaired — hide the action row.
  overlay.querySelector(".device-modal-actions").style.display = "none";
  overlay.querySelectorAll("[data-dm-copy]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.getAttribute("data-dm-copy"));
        const prev = btn.innerHTML;
        btn.innerHTML = "✓";
        setTimeout(() => {
          btn.innerHTML = prev;
        }, 1200);
      } catch {}
    };
  });
  overlay.classList.add("open");
}

// Global delegation: one set of listeners covers Home + Devices views and
// survives every re-render of the device grids.
document.addEventListener("click", (e) => {
  const peerCard = e.target.closest(".device-card[data-peer-id]");
  if (peerCard) {
    showPeerModal(peerCard.getAttribute("data-peer-id"));
    return;
  }
  const card = e.target.closest(".device-card[data-device-id]");
  if (card) showDeviceModal(card.getAttribute("data-device-id"));
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card =
    e.target instanceof Element
      ? e.target.closest(".device-card.clickable[data-device-id]")
      : null;
  if (card) {
    e.preventDefault();
    showDeviceModal(card.getAttribute("data-device-id"));
  }
});

function toast(msg) {
  // Small themed toast at the bottom-center of the window.
  let t = document.querySelector(".lanbeam-toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "lanbeam-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------------------
// Speed Test view — engine self-test through the real local server, plus a
// pointer to the phone card for the over-the-air measurement. Results are
// rendered as big numbers with a plain-language verdict; failures show the
// reason (never silent).
// ---------------------------------------------------------------------------
function bindSpeedTest() {
  const runBtn = document.getElementById("st-run");
  const out = document.getElementById("st-results");
  if (!runBtn || !out) return;
  if (runBtn.dataset.stBound) return;
  runBtn.dataset.stBound = "1";
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    runBtn.textContent = "Testing…";
    out.innerHTML =
      '<div class="bench-row">Running — 32MB single stream, then 6 parallel lanes…</div>';
    try {
      const r = await window.lanbeam.speedtest.run();
      const boost = r.single.mbps > 0 ? r.lanes.mbps / r.single.mbps : 0;
      let verdict;
      if (r.single.mbps >= 2000) {
        verdict =
          "Engine is more than fast enough for any 1GbE/Wi-Fi link — the network, not the PC, is the limit.";
      } else if (boost >= 1.4) {
        verdict = `Parallel lanes lift this PC's sends by about ×${boost.toFixed(1)} — and large PC→phone sends already use them (up to 12 lanes on the phone, across two addresses of this PC).`;
      } else {
        verdict =
          "Single stream already saturates the engine here; gains would have to come from the network side.";
      }
      out.innerHTML = `
        <div class="st-hero">
          <div class="st-hero-num"><b>${r.single.mbps}</b><span>Mbps · single stream</span></div>
          <div class="st-hero-num"><b>${r.lanes.mbps}</b><span>Mbps · ${r.lanes.count} lanes</span></div>
          <div class="st-hero-num"><b>×${boost.toFixed(1)}</b><span>multi-lane boost</span></div>
        </div>
        <div class="bench-row">${escapeHtml(verdict)}</div>
        <div class="bench-row" style="opacity:.6">${r.single.bytes} bytes verified per phase · ${r.single.ms}ms / ${r.lanes.ms}ms</div>`;
    } catch (err) {
      out.innerHTML = `<div class="bench-row">Speed test failed — ${escapeHtml(err && err.message ? err.message : String(err))}. Is the local server running?</div>`;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run engine test";
    }
  });
}

// ---------------------------------------------------------------------------
// Devices view
// ---------------------------------------------------------------------------
function bindDevices() {
  renderDevicesView();
  // One-tap roster cleanup: drop every OFFLINE device record (the walls of
  // stale "Android Phone · 3d ago" ghosts), keep everything online.
  document
    .getElementById("clear-offline-btn")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("clear-offline-btn");
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      try {
        const res = await window.lanbeam.devices.clearOffline();
        const removed = res?.removed ?? 0;
        if (res?.devices) {
          state.pairedDevices = res.devices;
          renderDevicesView();
        }
        toast(
          removed > 0
            ? `Removed ${removed} offline device${removed === 1 ? "" : "s"}`
            : "No offline devices to clear",
        );
      } catch (err) {
        console.error("Clear offline failed:", err);
        toast("Could not clear offline devices");
      } finally {
        btn.disabled = false;
      }
    });
}
function renderDevicesView() {
  const host = document.getElementById("device-cards-page");
  const peerHost = document.getElementById("peer-cards-page");
  // Instant Shell: signature cache — skip the full innerHTML rebuild when
  // nothing identity-relevant changed. The old code re-rendered the whole
  // page on every open, every 20s tick and every mDNS blip.
  const sig = [
    state.pairedDevices
      .map(
        (d) =>
          `${d.deviceId}:${d.kind}:${d.name}:${d.online ? 1 : 0}:${d.lastSeen || 0}`,
      )
      .join(","),
    state.peers
      .map((p) => `${p.deviceId}:${p.name}:${p.host}:${p.port}`)
      .join(","),
    state.wifi
      ? `${state.wifi.linkRateMbps || ""}:${state.wifi.band || ""}`
      : "",
  ].join("|");
  const anyHost = host || peerHost;
  if (anyHost && anyHost._devSig === sig && host?.childElementCount) return;
  if (anyHost) anyHost._devSig = sig;
  if (host) {
    if (!state.pairedDevices.length) {
      host.innerHTML = `<div class="empty-hint">No paired devices yet.</div>`;
    } else {
      host.innerHTML = dedupeDevices(state.pairedDevices)
        .sort(
          (x, y) =>
            Number(isOnline(y)) - Number(isOnline(x)) ||
            (y.lastSeen || 0) - (x.lastSeen || 0),
        )
        .map((d) => deviceCardHtml(d, isOnline(d)))
        .join("");
    }
  }
  if (peerHost) {
    if (!state.peers.length) {
      peerHost.innerHTML = `<div class="empty-hint">No other LANBeam instances discovered.</div>`;
    } else {
      peerHost.innerHTML = state.peers
        .map(
          (p) => `
        <div class="device-card" data-peer-id="${escapeHtml(p.deviceId)}">
          <div class="device-icon">${desktopIcon}</div>
          <div class="device-info">
            <div class="device-top">
              <span class="device-name">${escapeHtml(p.name)}</span>
              <span class="device-badge online">Discovered</span>
            </div>
            <div class="device-sub">${escapeHtml(p.host || "unknown host")} : ${p.port}</div>
          </div>
          <div class="device-chevron">${chevronIcon}</div>
        </div>
      `,
        )
        .join("");
    }
  }
}

// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------
const _histDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const _histRowCache = new Map(); // entry id/key -> row html (entries are immutable)
const _OPEN_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const _FOLDER_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

(function () {
  const st = document.createElement("style");
  st.textContent =
    '.history-row{content-visibility:auto;contain-intrinsic-size:auto 56px}.view-pane[style*="contents"]{display:contents}';
  document.head.appendChild(st);
})();

function historyRowHtml(h) {
  const key = `${h.id || ""}|${h.completedAt || ""}|${h.fileName}|${state.settings?.speedUnit || ""}`;
  const hit = _histRowCache.get(key);
  if (hit) return hit;
  const target = h.filePath && h.filePath.length ? h.filePath : h.fileName;
  const avg = formatSpeed(h.averageThroughputMbps);
  const completedAt = h.completedAt
    ? _histDate.format(new Date(h.completedAt))
    : "—";
  const status = h.status || (h.integrityOk ? "complete" : "failed");
  const isCancelled = status === "cancelled";
  const isFailed = status === "failed" || (!h.integrityOk && !isCancelled);
  const statusLabel = isCancelled
    ? "✕ Cancelled"
    : isFailed
      ? "✗ Failed"
      : "✓ Verified";
  const statusClass = isCancelled
    ? "h-integrity-warn"
    : isFailed
      ? "h-integrity-bad"
      : "h-integrity-ok";
  const direction = h.direction === "out" ? "out" : "in";
  const peerName = h.peerName || "Unknown device";
  const html = `
      <div class="history-row" data-history-target="${escapeHtml(target)}" data-history-direction="${direction}" tabindex="0" role="button" aria-label="Open ${escapeHtml(h.fileName)}">
        <div class="h-name">
          <span class="h-name-text">${escapeHtml(h.fileName)}</span>
          <span class="h-name-sub">· ${directionLabel(direction)} · ${escapeHtml(peerName)}</span>
        </div>
        <div class="h-speed">${isCancelled || isFailed ? "—" : `${avg.value} ${avg.unit}`}</div>
        <div class="${statusClass}">${statusLabel}</div>
        <div class="h-time">${completedAt}</div>
        <div class="h-actions">
          <button class="h-action-btn" data-history-action="open" data-tip="Open file" aria-label="Open file">${_OPEN_ICON}</button>
          <button class="h-action-btn" data-history-action="folder" data-tip="Show in folder" aria-label="Show in folder">${_FOLDER_ICON}</button>
        </div>
      </div>`;
  if (_histRowCache.size > 800) _histRowCache.clear();
  _histRowCache.set(key, html);
  return html;
}

async function _histOpen(target, folder) {
  if (!target) return;
  const ok = folder
    ? await window.lanbeam.history.showInFolder(target)
    : await window.lanbeam.history.openFile(target);
  if (!ok) {
    showModalAlert({
      title: "File not found",
      message:
        "The file doesn't exist on disk anymore — it may have been moved, renamed, or deleted since the transfer.",
      kind: "warn",
      confirmText: "Got it",
    });
  }
}

function renderHistory() {
  const host = document.getElementById("history-list");
  if (!host) return;
  const sig = `${state.historyRev || 0}|${state.history.length}|${state.settings?.speedUnit || ""}`;
  if (host._histSig === sig && host.childElementCount) return; // already painted — instant
  host._histSig = sig;
  const valid = state.history.filter(
    (h) =>
      h &&
      typeof h === "object" &&
      typeof h.fileName === "string" &&
      h.fileName.length > 0,
  );
  if (!valid.length) {
    host.innerHTML = `<div class="empty-hint">No transfers yet.</div>`;
    return;
  }
  // One delegated listener per host (bound once) instead of 3 per row.
  if (!host._histBound) {
    host._histBound = true;
    host.addEventListener("click", (e) => {
      const row = e.target.closest(".history-row");
      if (!row) return;
      const target = row.getAttribute("data-history-target") || "";
      const btn = e.target.closest("[data-history-action]");
      _histOpen(
        target,
        !!btn && btn.getAttribute("data-history-action") === "folder",
      );
    });
    host.addEventListener("keydown", (e) => {
      const row = e.target.closest && e.target.closest(".history-row");
      if (!row) return;
      const target = row.getAttribute("data-history-target") || "";
      if (e.key === "Enter") {
        e.preventDefault();
        _histOpen(target, false);
      } else if (e.key && e.key.toLowerCase() === "f") {
        e.preventDefault();
        _histOpen(target, true);
      }
    });
  }
  // First paint: first 30 rows immediately; the rest in idle slices so the
  // view opens instantly no matter how long the history is.
  const FIRST = 30,
    SLICE = 40;
  const token = (host._histToken = (host._histToken || 0) + 1);
  try {
    host.innerHTML = valid.slice(0, FIRST).map(historyRowHtml).join("");
  } catch (err) {
    console.error("[lanbeam] renderHistory failed:", err);
    host.innerHTML = `<div class="empty-hint">History temporarily unavailable.</div>`;
    return;
  }
  let idx = FIRST;
  const pump = () => {
    if (host._histToken !== token || !host.isConnected || idx >= valid.length)
      return;
    try {
      host.insertAdjacentHTML(
        "beforeend",
        valid
          .slice(idx, idx + SLICE)
          .map(historyRowHtml)
          .join(""),
      );
    } catch {}
    idx += SLICE;
    requestAnimationFrame(pump);
  };
  if (idx < valid.length) requestAnimationFrame(pump);
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------
// Instant Shell: populate Settings control VALUES from state.settings.
// Split from the one-time listener binding (bindSettings) so a prewarmed
// pane syncs its values on every open via _viewRefresh.settings — even
// when it was mounted before the first state:get landed.
function syncSettingsControls() {
  if (!state.settings) return;
  const chunk = document.getElementById("setting-chunk");
  const chunkVal = document.getElementById("setting-chunk-val");
  const streams = document.getElementById("setting-streams");
  const streamsVal = document.getElementById("setting-streams-val");
  const warn = document.getElementById("setting-warn");
  const historyToggle = document.getElementById("setting-history");
  {
    if (chunk) chunk.value = String(state.settings.chunkSizeMB);
    if (chunkVal) chunkVal.textContent = String(state.settings.chunkSizeMB);
    if (streams) streams.value = String(state.settings.maxParallelStreams);
    if (streamsVal)
      streamsVal.textContent = String(state.settings.maxParallelStreams);
    if (warn) warn.checked = !state.settings.warnOnSlowWifi;
    const isHistEnabled =
      typeof state.settings.showHistory === "boolean"
        ? state.settings.showHistory
        : localStorage.getItem("lanbeam:showHistory") === "true";
    if (historyToggle) historyToggle.checked = isHistEnabled;

    // Set initial custom dropdown selections
    const compRoot = document.getElementById("dropdown-compression");
    if (compRoot) {
      const mode = state.settings.compressionMode || "auto";
      compRoot.dataset.value = mode;
      const it = compRoot.querySelector(`.dropdown-item[data-value="${mode}"]`);
      if (it) {
        compRoot.querySelector(".dropdown-selected").textContent =
          it.textContent;
        compRoot
          .querySelectorAll(".dropdown-item")
          .forEach((el) => el.classList.toggle("selected", el === it));
      }
    }
    const fontRoot = document.getElementById("dropdown-font");
    if (fontRoot) {
      const font = state.settings.fontChoice || "figtree";
      fontRoot.dataset.value = font;
      const it = fontRoot.querySelector(`.dropdown-item[data-value="${font}"]`);
      if (it) {
        fontRoot.querySelector(".dropdown-selected").textContent =
          it.textContent;
        fontRoot
          .querySelectorAll(".dropdown-item")
          .forEach((el) => el.classList.toggle("selected", el === it));
      }
    }
    const uiScaleRoot = document.getElementById("dropdown-uiscale");
    if (uiScaleRoot) {
      const scale = state.settings.uiScale || "auto";
      uiScaleRoot.dataset.value = scale;
      const it = uiScaleRoot.querySelector(
        `.dropdown-item[data-value="${scale}"]`,
      );
      if (it) {
        uiScaleRoot.querySelector(".dropdown-selected").textContent =
          it.textContent;
        uiScaleRoot
          .querySelectorAll(".dropdown-item")
          .forEach((el) => el.classList.toggle("selected", el === it));
      }
    }
    const recvRoot = document.getElementById("dropdown-receive");
    if (recvRoot) {
      const mode = state.settings.receiveMode === "ask" ? "ask" : "auto";
      recvRoot.dataset.value = mode;
      const it = recvRoot.querySelector(`.dropdown-item[data-value="${mode}"]`);
      if (it) {
        recvRoot.querySelector(".dropdown-selected").textContent =
          it.textContent;
        recvRoot
          .querySelectorAll(".dropdown-item")
          .forEach((el) => el.classList.toggle("selected", el === it));
      }
    }
    const sendModeRoot = document.getElementById("dropdown-sendmode");
    if (sendModeRoot) {
      const smode =
        state.settings.sendQueueMode === "simultaneous"
          ? "simultaneous"
          : "sequential";
      sendModeRoot.dataset.value = smode;
      const it = sendModeRoot.querySelector(
        `.dropdown-item[data-value="${smode}"]`,
      );
      if (it) {
        sendModeRoot.querySelector(".dropdown-selected").textContent =
          it.textContent;
        sendModeRoot
          .querySelectorAll(".dropdown-item")
          .forEach((el) => el.classList.toggle("selected", el === it));
      }
    }
    const speedRoot = document.getElementById("dropdown-speed");
    if (speedRoot) {
      const su = ["mbps", "mBps", "gBps", "gbps"].includes(
        state.settings.speedUnit,
      )
        ? state.settings.speedUnit
        : "mBps";
      speedRoot.dataset.value = su;
      const it = speedRoot.querySelector(`.dropdown-item[data-value="${su}"]`);
      if (it) {
        speedRoot.querySelector(".dropdown-selected").textContent =
          it.textContent;
        speedRoot
          .querySelectorAll(".dropdown-item")
          .forEach((el) => el.classList.toggle("selected", el === it));
      }
    }
  }
  // Swatch highlight follows the live accent — lives here (not in the
  // one-time binder) so opening the pane after a theme change marks the
  // right swatch without a remount.
  document.querySelectorAll("#settings-swatches .swatch").forEach((sw) => {
    if (
      state.settings?.accentColor &&
      sw.dataset.color === state.settings.accentColor
    ) {
      sw.classList.add("active");
    } else {
      sw.classList.remove("active");
    }
  });
}

function bindSettings() {
  const chunk = document.getElementById("setting-chunk");
  const chunkVal = document.getElementById("setting-chunk-val");
  const streams = document.getElementById("setting-streams");
  const streamsVal = document.getElementById("setting-streams-val");
  const warn = document.getElementById("setting-warn");
  const historyToggle = document.getElementById("setting-history");
  syncSettingsControls();
  chunk?.addEventListener("input", () => {
    if (chunkVal) chunkVal.textContent = chunk.value;
    window.lanbeam.settings.update({ chunkSizeMB: parseInt(chunk.value, 10) });
  });
  streams?.addEventListener("input", () => {
    if (streamsVal) streamsVal.textContent = streams.value;
    window.lanbeam.settings.update({
      maxParallelStreams: parseInt(streams.value, 10),
    });
  });

  const ddInput = document.getElementById("setting-downloaddir");
  const showDir = async (d) => {
    if (!ddInput) return;
    const def = await window.lanbeam.transfer.defaultDownloadDir();
    ddInput.value = d || def;
    ddInput.title = ddInput.value;
  };
  showDir(state.settings?.downloadDir);
  document
    .getElementById("setting-downloaddir-pick")
    ?.addEventListener("click", async () => {
      const before = state.settings?.downloadDir;
      const dir = await window.lanbeam.transfer.pickDownloadDir();
      if (dir && dir !== before) {
        state.settings.downloadDir = dir;
        toast("Incoming files will be saved to the new folder");
      }
      showDir(dir);
    });
  document
    .getElementById("setting-downloaddir-reset")
    ?.addEventListener("click", async () => {
      const def = await window.lanbeam.transfer.resetDownloadDir();
      state.settings.downloadDir = "";
      showDir(def);
      toast("Using default folder");
    });
  initCustomDropdown("dropdown-compression", (val) => {
    window.lanbeam.settings.update({ compressionMode: val });
  });
  initCustomDropdown("dropdown-font", (val) => {
    applyFont(val);
  });
  initCustomDropdown("dropdown-uiscale", (val) => {
    window.lanbeam.settings.update({ uiScale: val });
  });
  initCustomDropdown("dropdown-receive", (val) => {
    window.lanbeam.settings.update({
      receiveMode: val === "ask" ? "ask" : "auto",
    });
    toast(val === "ask" ? "Receiving: ask every time" : "Receiving: automatic");
  });
  initCustomDropdown("dropdown-sendmode", (val) => {
    window.lanbeam.settings.update({
      sendQueueMode: val === "simultaneous" ? "simultaneous" : "sequential",
    });
    toast(
      val === "simultaneous"
        ? "Multi-file: simultaneous (parallel)"
        : "Multi-file: sequential (one by one)",
    );
  });
  initCustomDropdown("dropdown-speed", (val) => {
    const labels = { mbps: "Mbps", mBps: "MB/s", gBps: "GB/s", gbps: "Gbps" };
    window.lanbeam.settings.update({ speedUnit: val });
    toast(`Speed shown in ${labels[val] || "MB/s"} — on the PC and your phone`);
  });
  warn?.addEventListener("change", () => {
    window.lanbeam.settings.update({ warnOnSlowWifi: warn.checked });
  });
  historyToggle?.addEventListener("change", () => {
    const show = historyToggle.checked;
    window.lanbeam.settings.update({ showHistory: show });
    updateHistoryNav(show);
  });

  // Settings swatches: click listeners only (the active highlight is
  // synced by syncSettingsControls on every open).
  const settingsSwatches = document.querySelectorAll(
    "#settings-swatches .swatch",
  );
  settingsSwatches.forEach((sw) => {
    sw.addEventListener("click", () =>
      applyAccent(sw.dataset.color || "#00E5FF", settingsSwatches),
    );
  });

  // Benchmark
  const benchRun = document.getElementById("bench-run");
  const benchResults = document.getElementById("bench-results");
  if (benchRun && benchResults) {
    benchRun.addEventListener("click", async () => {
      benchRun.disabled = true;
      benchRun.textContent = "Running…";
      try {
        const results = await window.lanbeam.benchmark.run();
        renderBenchResults(results);
      } catch (err) {
        benchResults.innerHTML = `<div class="bench-row">Error: ${escapeHtml(err.message)}</div>`;
      } finally {
        benchRun.disabled = false;
        benchRun.textContent = "Run benchmark";
      }
    });
  }
}

function renderBenchResults(results) {
  const host = document.getElementById("bench-results");
  if (!host) return;
  host.innerHTML = results
    .map(
      (r) => `
    <div class="bench-row">
      <strong>${r.spec.label}</strong> — baseline ${r.baselineThroughputMbps.toFixed(1)} Mbps · optimized ${r.optimizedThroughputMbps.toFixed(1)} Mbps · uplift ${r.upliftPct.toFixed(1)}% · integrity ${r.integrityOk ? "OK" : "FAIL"} · CPU ${r.cpuUsagePct.toFixed(0)}%
    </div>
  `,
    )
    .join("");
}

function applyAccent(color, swatchEls) {
  // Recompute soft variants from the hex. Every glow/badge/status in the app
  // derives from --accent-rgb, so switching theme re-tints the WHOLE palette
  // (no leftover cyan/green glows from the old hardcoded shadows).
  applyThemeVars(color, state.settings?.fontChoice);
  // Cache the precomputed rgb string too — the <head> anti-FOUC script is
  // kept dependency-free and just sets the vars it finds.
  const rgb = hexToRgb(color);
  writeCachedTheme({
    a: color,
    r: rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : null,
  });
  (swatchEls || []).forEach((sw) =>
    sw.classList.toggle("active", sw.dataset.color === color),
  );
  window.lanbeam?.settings?.update?.({ accentColor: color });
  // The QR magnifier cursor is a data-URI SVG — CSS data URIs cannot read
  // var(--accent-color), so it is rebuilt here on every accent change.
  applyQrCursor();
}

// Brand-tinted magnifier cursor for the QR card. The stylesheet ships a
// hardcoded-cyan fallback; this rewrites it as an INLINE style using the
// live --accent-color, so the glass follows the user's theme instead of
// staying boot-time blue forever. Purely cosmetic — zero behaviour change.
function applyQrCursor() {
  const frames = document.querySelectorAll(".qr-frame");
  if (!frames.length) return;
  let accent = "";
  try {
    accent = (
      getComputedStyle(document.documentElement).getPropertyValue(
        "--accent-color",
      ) || ""
    ).trim();
  } catch {}
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accent)) accent = "#00E5FF";
  const rgb = hexToRgb(accent) || { r: 0, g: 229, b: 255 };
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'>` +
    `<circle cx='11' cy='11' r='6.5' fill='rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)' stroke='${accent}' stroke-width='1.8'/>` +
    `<line x1='15.8' y1='15.8' x2='21.5' y2='21.5' stroke='${accent}' stroke-width='1.8' stroke-linecap='round'/>` +
    `</svg>`;
  const cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 11 11, zoom-in`;
  frames.forEach((f) => {
    f.style.cursor = cursor;
  });
}

function hexToRgb(hex) {
  const m = hex
    .replace("#", "")
    .match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

// ---------------------------------------------------------------------------
// Sparkline rendering (SVG polyline + soft area fill)
// ---------------------------------------------------------------------------
function renderSparkline(values) {
  const svg = document.getElementById("sparkline");
  if (!svg) return;
  if (!values || !values.length) {
    svg.innerHTML = "";
    return;
  }
  const w = 100,
    h = 30,
    pad = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = (w - pad * 2) / Math.max(1, values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (h - pad * 2) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const rgb = hexToRgb(
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-color")
      .trim() || "#00E5FF",
  );
  const stroke = rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : "#00E5FF";
  const fillId = "spark-grad";
  svg.innerHTML = `
    <defs>
      <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${pad},${h - pad} ${points.join(" ")} ${w - pad},${h - pad}" fill="url(#${fillId})"/>
    <polyline points="${points.join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  `;
}

// ---------------------------------------------------------------------------
// Transfer-complete toast popup
// ---------------------------------------------------------------------------
// When a transfer finishes, we show a small card in the bottom-right corner
// that auto-dismisses after 5 seconds. The card offers Open / Open-folder
// actions and a Close button. Multiple transfers are catered for: each gets
// its own toast that stacks vertically (column-reverse so the newest lands
// at the bottom, closest to the user's eye). Hover pauses the auto-dismiss
// countdown; clicking any action or Close dismisses the toast immediately.
// ---------------------------------------------------------------------------
const TOAST_AUTO_DISMISS_MS = 5000;
let _toastsStack = null;

function _ensureToastsStack() {
  if (_toastsStack && document.body.contains(_toastsStack)) return _toastsStack;
  const stack = document.createElement("div");
  stack.className = "toasts-stack";
  stack.setAttribute("aria-live", "polite");
  stack.setAttribute("aria-atomic", "true");
  document.body.appendChild(stack);
  _toastsStack = stack;
  return stack;
}

const TOAST_ICON_DONE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const TOAST_ICON_FAIL =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
const TOAST_ICON_OPEN =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const TOAST_ICON_FOLDER =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const TOAST_ICON_HISTORY =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const TOAST_ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/**
 * Show a transfer-complete toast.
 * @param {object} r - The TransferComplete payload (must include the full
 *                     history-entry fields: fileName, fileSize, direction,
 *                     peerName, filePath, averageThroughputMbps, integrityOk).
 */

// ---------------------------------------------------------------------------
// Transfer completion sound -- synthesised via Web Audio API, no external
// file needed. Plays a brief two-tone chime only when the window is out of
// focus (document.hidden). Silently skips if AudioContext is unavailable.
// ---------------------------------------------------------------------------
function playTransferCompleteSound() {
  try {
    if (!window.AudioContext && !window.webkitAudioContext) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [
      [880, 0, 0.12],
      [1320, 0.13, 0.22],
    ].forEach(function (spec) {
      const freq = spec[0],
        start = spec[1],
        end = spec[2];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.18, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + end);
    });
    setTimeout(function () {
      try {
        ctx.close();
      } catch (e) {}
    }, 600);
  } catch (e) {}
}

function showCompletionToast(r) {
  if (!r || typeof r !== "object") return;
  const fileName = r.fileName || "File";
  const filePath = r.filePath && r.filePath.length ? r.filePath : fileName;
  const direction = r.direction === "out" ? "out" : "in";
  const peerName = r.peerName || "Unknown device";
  const integrityOk = r.integrityOk === true;
  const throughput =
    typeof r.averageThroughputMbps === "number" &&
    isFinite(r.averageThroughputMbps)
      ? r.averageThroughputMbps
      : 0;
  const sizeStr = formatBytes(r.fileSize || r.bytesTransferred || 0);
  const speedStr = formatSpeed(throughput);
  const dirStr = direction === "in" ? "Received from" : "Sent to";
  // Outgoing (PC→phone): the file already lives on this PC — "Open" / "Folder"
  // are pointless for the user who just picked it. The only useful action is
  // reviewing the record, so the card gets a single "Go to History" button.
  // Incoming keeps Open / Folder — the file is genuinely new to this machine.
  const isOut = direction === "out";
  const actionsHtml = isOut
    ? `<button class="toast-action-btn toast-action-btn-primary" data-toast-action="history" data-tip="Go to History">${TOAST_ICON_HISTORY}<span>Go to History</span></button>`
    : `<button class="toast-action-btn toast-action-btn-primary" data-toast-action="open" data-tip="Open file">${TOAST_ICON_OPEN}<span>Open</span></button>
      <button class="toast-action-btn" data-toast-action="folder" data-tip="Show in folder">${TOAST_ICON_FOLDER}<span>Folder</span></button>`;

  const stack = _ensureToastsStack();
  const card = document.createElement("div");
  card.className = "toast-card" + (integrityOk ? "" : " fail");
  card.setAttribute("role", "status");
  card.innerHTML = `
    <div class="toast-card-head">
      <div class="toast-card-icon">${integrityOk ? TOAST_ICON_DONE : TOAST_ICON_FAIL}</div>
      <div class="toast-card-body">
        <div class="toast-card-title">${integrityOk ? "Transfer complete" : "Transfer failed"}</div>
        <div class="toast-card-name">${escapeHtml(fileName)}</div>
        <div class="toast-card-meta">
          <span>${escapeHtml(dirStr)} ${escapeHtml(peerName)}</span>
          <span class="sep">·</span>
          <span>${sizeStr}</span>
          <span class="sep">·</span>
          <span class="speed">${speedStr.value} ${speedStr.unit}</span>
          <span class="sep">·</span>
          <span class="${integrityOk ? "ok" : "bad"}">${integrityOk ? "✓ Verified" : "✗ Failed"}</span>
        </div>
      </div>
      <button class="toast-close-btn" data-toast-action="close" data-tip="Dismiss" aria-label="Dismiss">${TOAST_ICON_CLOSE}</button>
    </div>
    <div class="toast-card-actions">
      ${actionsHtml}
    </div>
    <div class="toast-progress-track"><div class="toast-progress-fill"></div></div>
  `;

  // Auto-dismiss countdown state — implemented with rAF for smoothness and
  // pause-on-hover. We track remaining ms and a startedAt timestamp so the
  // bar always reflects the true remaining time.
  let remainingMs = TOAST_AUTO_DISMISS_MS;
  let rafHandle = null;
  let lastTickAt = 0;
  let paused = false;
  let dismissed = false;
  const fillEl = card.querySelector(".toast-progress-fill");
  // Sync the bar's transition duration to the remaining time.
  const syncBar = (ms) => {
    if (!fillEl) return;
    const pct = Math.max(0, Math.min(1, ms / TOAST_AUTO_DISMISS_MS));
    fillEl.style.transition = "none";
    fillEl.style.transform = `scaleX(${pct})`;
    // Force reflow so the next transition kicks in cleanly.
    void fillEl.offsetWidth;
  };
  const animateDown = (ms) => {
    syncBar(ms);
    if (ms <= 0) {
      dismiss();
      return;
    }
    fillEl.style.transition = `transform ${ms}ms linear`;
    fillEl.style.transform = "scaleX(0)";
  };
  const tick = (now) => {
    if (dismissed) return;
    if (paused) {
      lastTickAt = now;
      rafHandle = requestAnimationFrame(tick);
      return;
    }
    const dt = lastTickAt ? now - lastTickAt : 0;
    lastTickAt = now;
    remainingMs -= dt;
    if (remainingMs <= 0) {
      remainingMs = 0;
      syncBar(0);
      dismiss();
      return;
    }
    syncBar(remainingMs);
    rafHandle = requestAnimationFrame(tick);
  };
  const startCountdown = () => {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    lastTickAt = 0;
    rafHandle = requestAnimationFrame(tick);
  };
  const pauseCountdown = () => {
    paused = true;
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    // Freeze the bar where it is.
    if (fillEl) {
      const computed = getComputedStyle(fillEl).transform;
      fillEl.style.transition = "none";
      fillEl.style.transform = computed;
    }
  };
  const resumeCountdown = () => {
    paused = false;
    lastTickAt = 0;
    // Re-start the smooth countdown from the remaining time.
    animateDown(remainingMs);
    rafHandle = requestAnimationFrame(tick);
  };

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    card.classList.add("hiding");
    card.classList.remove("show");
    setTimeout(() => {
      try {
        card.remove();
      } catch {}
      // If the stack is empty, remove it so it doesn't capture pointer events
      // or interfere with subsequent renders.
      if (_toastsStack && _toastsStack.children.length === 0) {
        try {
          _toastsStack.remove();
        } catch {}
        _toastsStack = null;
      }
    }, 260);
  }

  // Wire action buttons.
  const openBtn = card.querySelector('[data-toast-action="open"]');
  const folderBtn = card.querySelector('[data-toast-action="folder"]');
  const closeBtn = card.querySelector('[data-toast-action="close"]');

  const onOpen = async () => {
    const ok = await window.lanbeam.history.openFile(filePath);
    if (!ok) {
      showModalAlert({
        title: "File not found",
        message:
          "The file may have been moved, renamed, or deleted since the transfer.",
        kind: "warn",
        confirmText: "Got it",
      });
    } else {
      dismiss();
    }
  };
  const onFolder = async () => {
    const ok = await window.lanbeam.history.showInFolder(filePath);
    if (!ok) {
      showModalAlert({
        title: "File not found",
        message:
          "The file doesn't exist on disk anymore — it may have been moved, renamed, or deleted since the transfer.",
        kind: "warn",
        confirmText: "Got it",
      });
    } else {
      dismiss();
    }
  };

  openBtn?.addEventListener("click", onOpen);
  folderBtn?.addEventListener("click", onFolder);
  closeBtn?.addEventListener("click", () => dismiss());
  // Sent-to-phone cards: jump straight to the History view.
  card
    .querySelector('[data-toast-action="history"]')
    ?.addEventListener("click", () => {
      dismiss();
      renderView("history");
    });

  // Hover pauses the countdown; mouse-leave resumes.
  card.addEventListener("mouseenter", pauseCountdown);
  card.addEventListener("mouseleave", resumeCountdown);
  // Focus (keyboard users) also pauses.
  card.addEventListener("focusin", pauseCountdown);
  card.addEventListener("focusout", resumeCountdown);

  // Stack the card and trigger the show transition.
  stack.appendChild(card);
  // Force a layout so the initial transform applies, then start the show.
  requestAnimationFrame(() => {
    card.classList.add("show");
    // Start the countdown once the show animation has begun.
    requestAnimationFrame(() => {
      // Initialize the bar at full and animate it down across the full
      // duration. The rAF tick loop also syncs to remaining time on each
      // frame, so hover-pause / resume naturally work.
      animateDown(remainingMs);
      lastTickAt = 0;
      rafHandle = requestAnimationFrame(tick);
    });
  });
}

// ---------------------------------------------------------------------------
// Transfer event handling
// ---------------------------------------------------------------------------
function bindTransferEvents() {
  document.addEventListener("click", async (e) => {
    const b =
      e.target.closest && e.target.closest("#transfer-cancel, #float-cancel");
    if (!b || !state.currentTransferId) return;
    if (b.disabled) return;
    b.disabled = true;
    document
      .querySelectorAll("#transfer-cancel, #float-cancel")
      .forEach((x) => {
        x.disabled = true;
        x.textContent = "Cancelling…";
      });
    const fs_ = document.getElementById("ft-stats");
    if (fs_) fs_.textContent = "Cancelling…";
    state.cancellingId = state.currentTransferId;
    const st = document.getElementById("progress-stats");
    if (st) st.textContent = "Cancelling…";
    try {
      await window.lanbeam.transfer.cancel(state.currentTransferId);
    } catch {
      _resetCancelBtn();
    }
  });
  window.lanbeam.transfer.onEvent((ev) => {
    if (ev.type === "inbound:progress" || ev.type === "outbound:progress") {
      state.currentTransferId = ev.transferId;
      if (ev.transferId === state.cancellingId) return; // keep the "Cancelling…" UI steady
      updateTransferCard(
        ev.progress,
        ev.type === "outbound:progress" ? "out" : "in",
      );
    } else if (
      ev.type === "inbound:complete" ||
      ev.type === "outbound:complete"
    ) {
      finalizeTransferCard(ev.result);
      // The orchestrator now emits the full history-entry payload (fileName,
      // filePath, direction, peerName, startedAt, completedAt, ...). So
      // prepending `ev.result` keeps state.history consistent with the store.
      state.history = [ev.result, ...state.history];
      state.historyRev = (state.historyRev || 0) + 1;
      if (state.view === "history") renderHistory();
      // Surface the new file as a self-dismissing toast with Open / Folder
      // actions so the user can act on it without having to navigate to
      // the History view. Multiple transfers stack vertically.
      showCompletionToast(ev.result);
      // Play completion chime when window is hidden/backgrounded
      if (document.hidden) playTransferCompleteSound();
      // Unblock sequential queue. Also track in _completedTids so waitForTransfer
      // resolves instantly if the event raced ahead of resolver registration.
      {
        const _tid = (ev.result && ev.result.fileId) || ev.transferId;
        if (_tid) {
          if (!state._completedTids) state._completedTids = new Set();
          state._completedTids.add(_tid);
        }
        if (state._seqResolvers && _tid) {
          const _res = state._seqResolvers.get(_tid);
          if (_res) {
            _res(true);
            state._seqResolvers.delete(_tid);
          }
        }
      }
    } else if (ev.type === "inbound:failed" || ev.type === "outbound:failed") {
      failTransferCard(ev.error, ev.transferId);
      // Unblock sequential queue on failure so remaining files can proceed
      {
        const _ftid = ev.transferId;
        if (_ftid) {
          if (!state._completedTids) state._completedTids = new Set();
          state._completedTids.add(_ftid);
        }
        if (state._seqResolvers && _ftid) {
          const _fres = state._seqResolvers.get(_ftid);
          if (_fres) {
            _fres(false);
            state._seqResolvers.delete(_ftid);
          }
        }
      }
    } else if (ev.type === "inbound:accept-request") {
      // receiveMode 'ask' → the desktop user decides: pop the Accept /
      // Decline card and answer the held /api/transfer/start through IPC.
      // 'auto' (default) → the server already accepted; just acknowledge.
      if (state.settings?.receiveMode === "ask") {
        showApprovalCard(ev);
      } else {
        toast(
          `Receiving ${ev.fileName || "file"} from ${ev.peerName || "device"}`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Approval card — receiveMode 'ask'. A paired device wants to send a file;
// nothing moves until this card is answered. Accept/Decline resolves the
// phone's held /api/transfer/start request through transfer.respond IPC.
// ---------------------------------------------------------------------------
let _approveOverlay = null;

function showApprovalCard(ev) {
  if (_approveOverlay) {
    try {
      _approveOverlay.remove();
    } catch {}
    _approveOverlay = null;
  }
  const overlay = document.createElement("div");
  overlay.className = "approve-overlay";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  const kindIcon =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
  const sizeStr = ev.fileSize ? formatBytes(ev.fileSize) : "";
  overlay.innerHTML = `
    <div class="approve-card">
      <div class="approve-head">
        <div class="approve-icon">${kindIcon}</div>
        <div class="approve-text">
          <div class="approve-title">Incoming transfer</div>
          <div class="approve-sub">${escapeHtml(ev.peerName || "A paired device")} wants to send ${sizeStr ? escapeHtml(sizeStr) + " " : ""}to this PC</div>
        </div>
      </div>
      <div class="approve-file">${escapeHtml(ev.fileName || "file")}</div>
      <div class="approve-actions">
        <button type="button" class="approve-btn decline" data-approve="0">Decline</button>
        <button type="button" class="approve-btn accept" data-approve="1">Accept</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _approveOverlay = overlay;
  const answer = (accepted) => {
    overlay.classList.remove("open");
    setTimeout(() => {
      try {
        overlay.remove();
      } catch {}
    }, 180);
    if (_approveOverlay === overlay) _approveOverlay = null;
    document.removeEventListener("keydown", onKey);
    try {
      window.lanbeam?.transfer?.respond?.(ev.requestId, accepted);
    } catch {}
    if (!accepted) toast("Transfer declined");
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      answer(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      answer(true);
    }
  };
  overlay.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-approve]");
    if (btn) answer(btn.getAttribute("data-approve") === "1");
  });
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(() => {
    overlay.classList.add("open");
    overlay.querySelector('[data-approve="1"]')?.focus();
  });
}

function renderSparklineToSvg(svg, values, tid) {
  if (!svg) return;
  if (!values || !values.length) {
    svg.innerHTML = "";
    return;
  }
  const w = 100,
    h = 30,
    pad = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = (w - pad * 2) / Math.max(1, values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (h - pad * 2) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const rgb = hexToRgb(
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-color")
      .trim() || "#00E5FF",
  );
  const stroke = rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : "#00E5FF";
  const fillId = "spark-grad-" + tid;
  svg.innerHTML = `
    <defs>
      <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${pad},${h - pad} ${points.join(" ")} ${w - pad},${h - pad}" fill="url(#${fillId})"/>
    <polyline points="${points.join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  `;
}

function isVideoFileName(fileName) {
  return /\.(mp4|mkv|mov|avi|webm|flv|wmv|m4v|3gp|ts)$/i.test(fileName || "");
}

function getTransferCardIconSvg(fileName, tid) {
  if (isVideoFileName(fileName)) {
    return `<svg class="transfer-file-icon" id="ticon-${tid}" viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M19.5617 7C19.7904 5.69523 18.7863 4.5 17.4617 4.5H6.53788C5.21323 4.5 4.20922 5.69523 4.43784 7"></path>
        <path d="M17.4999 4.5C17.5283 4.24092 17.5425 4.11135 17.5427 4.00435C17.545 2.98072 16.7739 2.12064 15.7561 2.01142C15.6497 2 15.5194 2 15.2588 2H8.74099C8.48035 2 8.35002 2 8.24362 2.01142C7.22584 2.12064 6.45481 2.98072 6.45704 4.00434C6.45727 4.11135 6.47146 4.2409 6.49983 4.5"></path>
        <path d="M21.1935 16.793C20.8437 19.2739 20.6689 20.5143 19.7717 21.2572C18.8745 22 17.5512 22 14.9046 22H9.09536C6.44881 22 5.12553 22 4.22834 21.2572C3.33115 20.5143 3.15626 19.2739 2.80648 16.793L2.38351 13.793C1.93748 10.6294 1.71447 9.04765 2.66232 8.02383C3.61017 7 5.29758 7 8.67239 7H15.3276C18.7024 7 20.3898 7 21.3377 8.02383C22.0865 8.83268 22.1045 9.98979 21.8592 12" stroke-linecap="round"></path>
        <path d="M14.5812 13.6159C15.1396 13.9621 15.1396 14.8582 14.5812 15.2044L11.2096 17.2945C10.6669 17.6309 10 17.1931 10 16.5003L10 12.32C10 11.6273 10.6669 11.1894 11.2096 11.5258L14.5812 13.6159Z"></path>
      </svg>`;
  }
  return `<svg class="transfer-file-icon" id="ticon-${tid}" viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2"/>
        <polygon points="10,9 16,12 10,15" fill="currentColor" stroke="none"/>
      </svg>`;
}

function _createCardElement(tid, direction = "in", fileName = "") {
  const card = document.createElement("div");
  card.className = "transfer-card";
  card.id = `tcard-${tid}`;
  card.dataset.tid = tid;
  card.dataset.direction = direction;
  card.innerHTML = `
    <div class="transfer-info">
      ${getTransferCardIconSvg(fileName, tid)}
      <div class="transfer-text">
        <div class="transfer-name" id="tname-${tid}">—</div>
        <div class="transfer-meta" id="tmeta-${tid}">— · —</div>
      </div>
    </div>
    <div class="transfer-progress">
      <div class="progress-bar">
        <div class="progress-fill" id="tfill-${tid}" style="width:0%"></div>
      </div>
      <div class="progress-stats" id="tstats-${tid}">0% · 0 / 0 · ETA —</div>
    </div>
    <div class="transfer-speed">
      <div class="speed-readout">
        <span class="speed-value" id="tspeed-${tid}">0.0</span>
        <span class="speed-unit" id="tunit-${tid}">Mbps</span>
      </div>
      <div class="speed-label">Current speed</div>
      <svg class="speed-sparkline" id="tspark-${tid}" viewBox="0 0 100 30" preserveAspectRatio="none"></svg>
    </div>
    <div class="transfer-actions">
      <button type="button" class="ghost-btn transfer-cancel-btn" data-tid="${escapeHtml(tid)}">Cancel transfer</button>
    </div>`;

  const cancelBtn = card.querySelector(".transfer-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling…";
      const stats = card.querySelector(`#tstats-${tid}`);
      if (stats) stats.textContent = "Cancelling…";
      try {
        await window.lanbeam.transfer.cancel(tid);
      } catch {
        cancelBtn.disabled = false;
        cancelBtn.textContent = "Cancel transfer";
      }
    });
  }
  return card;
}

function updateTransferCard(p, direction = "in") {
  const tid = p.fileId || state.currentTransferId || "active";
  updateFloatCard(p, direction);
  const section = document.getElementById("transfer-section");
  if (!section) return;

  section.style.display = "flex";
  let card = document.getElementById(`tcard-${tid}`);
  if (!card) {
    card = _createCardElement(tid, direction, p.fileName);
    section.appendChild(card);
    requestAnimationFrame(() =>
      card.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  }

  if (p.fileName) {
    const nameEl = card.querySelector(`#tname-${tid}`);
    if (nameEl) nameEl.textContent = p.fileName;
    const oldIcon = card.querySelector(`#ticon-${tid}`);
    if (oldIcon && isVideoFileName(p.fileName)) {
      const parent = oldIcon.parentElement;
      if (parent) {
        const temp = document.createElement("div");
        temp.innerHTML = getTransferCardIconSvg(p.fileName, tid);
        const newIcon = temp.firstElementChild;
        if (newIcon) parent.replaceChild(newIcon, oldIcon);
      }
    }
  }
  const metaEl = card.querySelector(`#tmeta-${tid}`);
  if (metaEl) {
    const peer = p.peerName || "Remote device";
    const totalSize = p.totalBytes > 0 ? formatBytes(p.totalBytes) : "—";
    metaEl.textContent = `${totalSize} · ${direction === "out" ? "\u2192 to" : "\u2190 from"} ${peer}`;
  }
  const pct = p.totalBytes > 0 ? (p.bytesTransferred / p.totalBytes) * 100 : 0;
  const fill = card.querySelector(`#tfill-${tid}`);
  if (fill) fill.style.width = `${Math.min(100, pct).toFixed(1)}%`;
  const stats = card.querySelector(`#tstats-${tid}`);
  if (stats) {
    stats.textContent = p.stalled
      ? `${Math.min(100, pct).toFixed(0)}% · ${formatBytes(p.bytesTransferred)} / ${formatBytes(p.totalBytes)} · Paused — waiting to reconnect`
      : `${Math.min(100, pct).toFixed(0)}% · ${formatBytes(p.bytesTransferred)} / ${formatBytes(p.totalBytes)} · ETA ${formatEta(p.etaMs)}`;
    if (!(p.bytesTransferred > 0)) {
      stats.textContent =
        direction === "out"
          ? "Staged · waiting for receiver…"
          : "Preparing · waiting for first data…";
    }
  }
  const speedVal = card.querySelector(`#tspeed-${tid}`);
  const speedUnit = card.querySelector(`#tunit-${tid}`);
  const { value, unit } = formatSpeed(p.throughputMbps);
  if (speedVal) speedVal.textContent = value;
  if (speedUnit) speedUnit.textContent = unit;

  const sparkEl = card.querySelector(`#tspark-${tid}`);
  if (sparkEl) {
    renderSparklineToSvg(sparkEl, p.sparkline?.slice(-30) || [], tid);
  }
  state.currentTransfer = p;
}

// ---------------------------------------------------------------------------
// Floating transfer card — mirrors the active transfer on every section
// except Home (where the full card already lives).
// ---------------------------------------------------------------------------
let _floatHideT = null;
function _ensureFloat() {
  let el = document.getElementById("float-transfer");
  if (el) return el;
  el = document.createElement("div");
  el.id = "float-transfer";
  el.className = "float-transfer";
  el.hidden = true;
  el.innerHTML = `
    <div class="transfer-info">
      <span class="float-icon-wrap">${getTransferCardIconSvg("file", "float")}</span>
      <div class="transfer-text">
        <div class="transfer-name" id="ft-name">—</div>
        <div class="transfer-meta" id="ft-meta">— · —</div>
      </div>
    </div>
    <div class="transfer-progress">
      <div class="progress-bar">
        <div class="progress-fill" id="ft-fill" style="width:0%"></div>
      </div>
      <div class="progress-stats" id="ft-stats">0% · 0 / 0 · ETA —</div>
    </div>
    <div class="transfer-speed">
      <div class="speed-readout">
        <span class="speed-value" id="ft-speed">0.0</span>
        <span class="speed-unit" id="ft-unit">Mbps</span>
      </div>
      <div class="speed-label">Speed</div>
      <svg class="speed-sparkline" id="ft-spark" viewBox="0 0 100 30" preserveAspectRatio="none"></svg>
    </div>`;
  document.body.appendChild(el);
  return el;
}
function _floatShow(show) {
  const el = _ensureFloat();
  el.hidden = !(show && state.view !== "home");
}
function updateFloatCard(p, direction) {
  if (_floatHideT) {
    clearTimeout(_floatHideT);
    _floatHideT = null;
  }
  const el = _ensureFloat();
  state.floatActive = true;
  const pct =
    p.totalBytes > 0
      ? Math.min(100, (p.bytesTransferred / p.totalBytes) * 100)
      : 0;

  if (p.fileName) {
    const nameEl = el.querySelector("#ft-name");
    if (nameEl) nameEl.textContent = p.fileName;
    const iconWrap = el.querySelector(".float-icon-wrap");
    if (iconWrap) {
      iconWrap.innerHTML = getTransferCardIconSvg(p.fileName, "float");
    }
  }

  const metaEl = el.querySelector("#ft-meta");
  if (metaEl) {
    const peer = p.peerName || "Remote device";
    const totalSize = p.totalBytes > 0 ? formatBytes(p.totalBytes) : "—";
    metaEl.textContent = `${totalSize} · ${direction === "out" ? "\u2192 to" : "\u2190 from"} ${peer}`;
  }

  const fill = el.querySelector("#ft-fill");
  if (fill) fill.style.width = `${pct.toFixed(1)}%`;

  const stats = el.querySelector("#ft-stats");
  if (stats) {
    if (p.stalled) {
      stats.textContent = `${pct.toFixed(0)}% · ${formatBytes(p.bytesTransferred)} / ${formatBytes(p.totalBytes)} · Paused — reconnecting`;
    } else if (p.bytesTransferred > 0) {
      stats.textContent = `${pct.toFixed(0)}% · ${formatBytes(p.bytesTransferred)} / ${formatBytes(p.totalBytes)} · ETA ${formatEta(p.etaMs)}`;
    } else {
      stats.textContent =
        direction === "out"
          ? "Staged · waiting for receiver…"
          : "Preparing · waiting for data…";
    }
  }

  const sp = formatSpeed(p.throughputMbps);
  const speedVal = el.querySelector("#ft-speed");
  const speedUnit = el.querySelector("#ft-unit");
  if (speedVal) speedVal.textContent = sp.value;
  if (speedUnit) speedUnit.textContent = sp.unit;

  const sparkEl = el.querySelector("#ft-spark");
  if (sparkEl && p.sparkline) {
    renderSparklineToSvg(sparkEl, p.sparkline.slice(-30), "float");
  }

  _floatShow(true);
}
function endFloatCard(text, hideMs, full) {
  const el = document.getElementById("float-transfer");
  if (!el) return;
  if (text) {
    const stats = el.querySelector("#ft-stats");
    if (stats) stats.textContent = text;
  }
  if (full) {
    const fill = el.querySelector("#ft-fill");
    if (fill) fill.style.width = "100%";
  }
  if (_floatHideT) clearTimeout(_floatHideT);
  _floatHideT = setTimeout(() => {
    state.floatActive = false;
    el.hidden = true;
  }, hideMs);
}

let hideTransferTimeout = null;

function _resetCancelBtn() {
  const b = document.getElementById("transfer-cancel");
  if (b) {
    b.disabled = false;
    b.textContent = "Cancel transfer";
    b.style.display = "";
  }
  const fb = document.getElementById("float-cancel");
  if (fb) {
    fb.disabled = false;
    fb.textContent = "Cancel";
    fb.style.display = "";
  }
  state.cancellingId = null;
}
function _hideCancelBtn() {
  const b = document.getElementById("transfer-cancel");
  if (b) b.style.display = "none";
  state.cancellingId = null;
}

function finalizeTransferCard(result) {
  const tid = result?.fileId || state.currentTransferId;
  const card =
    (tid ? document.getElementById(`tcard-${tid}`) : null) ||
    document.querySelector(".transfer-card");
  endFloatCard(
    "Complete \u00b7 " +
      formatSpeed(result.averageThroughputMbps).value +
      " " +
      formatSpeed(result.averageThroughputMbps).unit +
      " avg",
    3500,
    true,
  );
  if (card) {
    const cancelBtn = card.querySelector(".transfer-cancel-btn");
    if (cancelBtn) cancelBtn.style.display = "none";
    const avg = formatSpeed(result.averageThroughputMbps);
    const stats = card.querySelector(`.progress-stats`);
    if (stats)
      stats.textContent = `Complete · ${avg.value} ${avg.unit} avg · integrity ${result.integrityOk ? "OK" : "FAILED"}`;
    const fill = card.querySelector(`.progress-fill`);
    if (fill) fill.style.width = `100%`;
    const metaEl = card.querySelector(`.transfer-meta`);
    if (metaEl) {
      const dirText = result.direction === "out" ? "Sent to" : "Received from";
      metaEl.textContent = `${formatBytes(result.fileSize)} · ${dirText} ${result.peerName || "device"}`;
    }
    setTimeout(() => {
      card.remove();
      const section = document.getElementById("transfer-section");
      if (section && !section.querySelector(".transfer-card")) {
        section.style.display = "none";
      }
    }, 3500);
  }
}

function failTransferCard(error, tid = null) {
  const targetId = tid || state.currentTransferId;
  const card = targetId
    ? document.getElementById(`tcard-${targetId}`)
    : document.querySelector(".transfer-card");
  endFloatCard(
    error === "Cancelled"
      ? "Transfer cancelled"
      : `Transfer failed \u2014 ${error || "unknown error"}`,
    5000,
    false,
  );
  window.lanbeam.state
    .get()
    .then((st) => {
      if (st && st.history) {
        state.history = st.history;
        state.historyRev = (state.historyRev || 0) + 1;
        if (state.view === "history") renderHistory();
      }
    })
    .catch(() => {});
  if (card) {
    const cancelBtn = card.querySelector(".transfer-cancel-btn");
    if (cancelBtn) cancelBtn.style.display = "none";
    const stats = card.querySelector(`.progress-stats`);
    if (stats)
      stats.textContent =
        error === "Cancelled"
          ? "Transfer cancelled"
          : `Transfer failed — ${error || "unknown error"}`;
    setTimeout(() => {
      card.remove();
      const section = document.getElementById("transfer-section");
      if (section && !section.querySelector(".transfer-card")) {
        section.style.display = "none";
      }
    }, 5000);
  }
}

// ---------------------------------------------------------------------------
// Utility: formatting
// ---------------------------------------------------------------------------
function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function formatSpeed(mbps) {
  // Honours Settings → Speed unit (mirrored to the phone via /api/state):
  //   'mbps' — megabits/s with the classic Kbps/Gbps laddering (the old look)
  //   'mBps' — megabytes/s (default: file sizes are in MB/GB, so this is the
  //            unit that actually means something to a human)
  //   'gBps' — gigabytes/s (10GbE / loopback territory)
  //   'gbps' — gigabits/s
  const unit = state.settings?.speedUnit || "mBps";
  const v = typeof mbps === "number" && isFinite(mbps) ? Math.max(0, mbps) : 0;
  if (unit === "mbps") {
    if (v >= 1000) return { value: (v / 1000).toFixed(2), unit: "Gbps" };
    if (v >= 1) return { value: v.toFixed(1), unit: "Mbps" };
    return { value: (v * 1000).toFixed(0), unit: "Kbps" };
  }
  if (unit === "gbps") return { value: (v / 1000).toFixed(2), unit: "Gbps" };
  if (unit === "gBps") return { value: (v / 8000).toFixed(2), unit: "GB/s" };
  return { value: (v / 8).toFixed(1), unit: "MB/s" };
}
function formatEta(ms) {
  if (!isFinite(ms) || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function directionLabel(d) {
  return d === "in" ? "↓ Received" : "↑ Sent";
}
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------
const phoneIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>`;
const desktopIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
const chevronIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------
function bindWindowControls() {
  const closeBtn = document.getElementById("win-close");
  const minBtn = document.getElementById("win-min");
  const maxBtn = document.getElementById("win-max");

  closeBtn?.addEventListener("click", () => window.lanbeam.app.close());
  minBtn?.addEventListener("click", () => window.lanbeam.app.minimize());
  maxBtn?.addEventListener("click", () => window.lanbeam.app.toggleMaximize());
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------
function bindNav() {
  document.querySelectorAll(".nav-item").forEach((el) => {
    const v = el.getAttribute("data-view");
    // Instant Shell: the moment the pointer heads for a nav button, mount
    // that view. Human hover-to-click latency (100-300ms) becomes free
    // build time, so the click itself is a pure display toggle. Idempotent
    // — _mountView returns the cached pane when it is already built.
    if (v) {
      el.addEventListener("pointerenter", () => {
        try {
          _mountView(v);
        } catch {}
      });
    }
    el.addEventListener("click", () => renderView(v));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  bindWindowControls();
  bindNav();

  // Instant Shell: the <head> anti-FOUC script already painted the cached
  // theme before this file even parsed. Re-assert it here (belt and
  // suspenders for first run / cleared storage), THEN render home — the
  // first view paints in the user's theme, never the default cyan.
  const cachedTheme = readCachedTheme();
  if (cachedTheme?.a) applyThemeVars(cachedTheme.a, cachedTheme.fc);

  // Render home immediately so UI is never blank on launch
  renderView("home");

  // Network switched (new Wi-Fi / IP): update the URL and radio info live.
  window.lanbeam.network?.onChanged?.((d) => {
    state.ipUrl = d.ipUrl || "";
    if (state.view === "home") renderQr();
    window.lanbeam.wifi
      .query()
      .then((w) => {
        state.wifi = w;
        if (state.view === "home") renderDevices();
        if (state.view === "devices") renderDevicesView();
      })
      .catch(() => {});
    toast("Network changed — pairing code updated");
  });

  // QR pairing subscriptions
  window.lanbeam.pairing.onQr((data) => {
    state.qr = data;
    if (state.view === "home") renderQr();
  });

  // Paired devices updates. Watches for a connection while the enlarged QR lightbox is open
  // — pairing succeeded, so send a toast showing connection successful and close the enlarged QR.
  let _prevOnlineIds = null;
  window.lanbeam.devices.onUpdated((devices) => {
    const onlineNow = new Set(
      (devices || []).filter((d) => d && isOnline(d)).map((d) => d.deviceId),
    );
    const lightboxWasOpen = !!_qrLightbox;
    let freshlyConnectedName = null;

    if (_prevOnlineIds !== null) {
      for (const d of devices || []) {
        if (d && onlineNow.has(d.deviceId) && !_prevOnlineIds.has(d.deviceId)) {
          freshlyConnectedName = d.name || "Device";
          break;
        }
      }
    } else if (onlineNow.size > 0) {
      // First update while lightbox might be open
      for (const d of devices || []) {
        if (d && onlineNow.has(d.deviceId)) {
          freshlyConnectedName = d.name || "Device";
          break;
        }
      }
    }

    _prevOnlineIds = onlineNow;
    state.pairedDevices = devices;
    if (freshlyConnectedName) state._shareHold = false;
    flushPendingShares();
    if (state.view === "home") renderDevices();
    if (state.view === "devices") renderDevicesView();

    // If the enlarged QR lightbox is open and any device connected:
    if (lightboxWasOpen && (freshlyConnectedName || onlineNow.size > 0)) {
      const devName =
        freshlyConnectedName ||
        devices?.find((d) => onlineNow.has(d.deviceId))?.name ||
        "Device";
      toast(`${devName} connected successfully!`);
      closeQrLightbox();
    }
  });

  // Peers (mDNS)
  window.lanbeam.peers.onUpdated((peers) => {
    state.peers = peers;
    if (state.view === "devices") renderDevicesView();
  });

  // Transfer events
  bindTransferEvents();

  // NovaTune hand-off: queued files wait here until a device is online.
  window.lanbeam.share.onPending(setPendingShares);
  window.lanbeam.share
    .getPending()
    .then(setPendingShares)
    .catch(() => {});
  setInterval(flushPendingShares, 2000);

  // Settings updates
  window.lanbeam.settings.onUpdated((s) => {
    state.settings = { ...state.settings, ...s };
    if (typeof s.showHistory === "boolean") {
      updateHistoryNav(s.showHistory);
    } else {
      updateHistoryNav();
    }
  });

  // Load initial state
  try {
    const s = await window.lanbeam.state.get();
    if (s) {
      state.settings = s.settings;
      state.pairedDevices = s.pairedDevices || [];
      state.history = s.history || [];
      state.historyRev = (state.historyRev || 0) + 1;
      state.ipUrl = s.ipUrl || "";
      state.permanentHost = s.permanentHost || "";
      if (s.qr) {
        state.qr = s.qr;
      }
      // Reconcile the REAL theme against the cached one painted at t=0.
      // Only re-apply when it actually differs — no flash, no redundant
      // style recalc, no duplicate settings writes on a healthy boot.
      const realAccent = s.settings?.accentColor || "#00E5FF";
      if (realAccent !== (cachedTheme?.a || "#00E5FF"))
        applyAccent(realAccent, []);
      const realFont = s.settings?.fontChoice || "figtree";
      if (realFont !== (cachedTheme?.fc || "figtree")) applyFont(realFont);
      const initialShowHistory =
        typeof s.settings?.showHistory === "boolean"
          ? s.settings.showHistory
          : localStorage.getItem("lanbeam:showHistory") === "true";
      updateHistoryNav(initialShowHistory);

      if (state.view === "home") {
        renderQr();
        renderDevices();
      }
    }
  } catch (err) {
    console.error("Failed to get initial state:", err);
  }

  // Re-render device cards every 20s so online/offline status updates
  // automatically. Skipped while the window is hidden in the tray — zero
  // background CPU when nobody is looking at the app.
  setInterval(() => {
    if (document.hidden) return;
    if (state.view === "home") renderDevices();
    if (state.view === "devices") renderDevicesView();
  }, 20000);
  // Reconcile with the main process on focus/visibility so the UI can never
  // stay stale after the window was hidden or throttled.
  const resync = async () => {
    try {
      const st = await window.lanbeam.state.get();
      if (st?.pairedDevices) {
        state.pairedDevices = st.pairedDevices;
        if (state.view === "home") renderDevices();
        if (state.view === "devices") renderDevicesView();
      }
    } catch {}
  };
  window.addEventListener("focus", resync);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resync();
  });

  // Real radio info for device cards + the device popup (generation/band/rate).
  const refreshWifi = async () => {
    try {
      const prev = state.wifi;
      state.wifi = await window.lanbeam.wifi.query();
      // First successful query: repaint the cards so the link line shows the
      // real radio (WiFi 5 · 5 GHz · 400 Mbps) immediately, not just "LAN"
      // until the 20s interval happens to fire.
      if (!prev && state.wifi) {
        if (state.view === "home") renderDevices();
        if (state.view === "devices") renderDevicesView();
      }
    } catch {}
  };
  refreshWifi();
  setInterval(() => {
    if (!document.hidden) refreshWifi();
  }, 30000);
}

boot().catch((err) => console.error("renderer boot failed:", err));

// ─────────────────────────────────────────────────────────────────────
// OTA Update Banner — fires when main process detects a newer release.
// Shows a slim top bar: "Update X.Y.Z ready — Restart to install" with
// a progress bar while downloading. Identical UX to NovaTune.
// ─────────────────────────────────────────────────────────────────────
(function initUpdateBanner() {
  if (!window.lanbeam?.update) return;

  // Inject banner element once
  const banner = document.createElement("div");
  banner.id = "update-banner";
  banner.style.cssText = [
    "display:none",
    "position:fixed",
    "bottom:0",
    "left:0",
    "right:0",
    "z-index:9999",
    "background:var(--accent,#00c2a8)",
    "color:#000",
    "font-size:13px",
    "font-weight:600",
    "padding:10px 18px",
    "display:none",
    "align-items:center",
    "gap:12px",
    "box-shadow:0 -2px 16px rgba(0,0,0,.4)",
  ].join(";");

  banner.innerHTML = `
    <span id="update-msg" style="flex:1">🚀 Update available — downloading…</span>
    <div id="update-progress-wrap" style="width:120px;height:6px;background:rgba(0,0,0,.2);border-radius:3px;overflow:hidden;display:none">
      <div id="update-progress-bar" style="height:100%;width:0%;background:#000;border-radius:3px;transition:width .3s"></div>
    </div>
    <button id="update-install-btn" style="display:none;background:#000;color:var(--accent,#00c2a8);border:none;border-radius:6px;padding:5px 14px;font-size:12px;font-weight:700;cursor:pointer">
      Restart &amp; Install
    </button>
    <button id="update-dismiss-btn" style="background:transparent;border:none;color:#000;opacity:.6;font-size:16px;cursor:pointer;padding:0 4px;line-height:1">&times;</button>
  `;
  document.body.appendChild(banner);

  const msg = document.getElementById("update-msg");
  const pWrap = document.getElementById("update-progress-wrap");
  const pBar = document.getElementById("update-progress-bar");
  const iBtn = document.getElementById("update-install-btn");
  const dBtn = document.getElementById("update-dismiss-btn");

  function showBanner() {
    banner.style.display = "flex";
  }
  function hideBanner() {
    banner.style.display = "none";
  }

  dBtn?.addEventListener("click", hideBanner);
  iBtn?.addEventListener("click", () => window.lanbeam.update.install());

  // Main emits 'update:available' when a newer release is found
  window.lanbeam.update.onAvailable((info) => {
    if (msg)
      msg.textContent = `🚀 LANBeam ${info.version} is available — downloading update…`;
    showBanner();
  });

  // Download progress
  window.lanbeam.update.onProgress((p) => {
    if (pWrap) pWrap.style.display = "block";
    if (pBar) pBar.style.width = p.percent.toFixed(1) + "%";
    const mb = (p.transferred / 1048576).toFixed(1);
    const tot = (p.total / 1048576).toFixed(1);
    if (msg) msg.textContent = `⬇ Downloading update… ${mb} / ${tot} MB`;
  });

  // Update fully downloaded — show install button
  window.lanbeam.update.onDownloaded(() => {
    if (pWrap) pWrap.style.display = "none";
    if (msg) msg.textContent = "✅ Update downloaded — restart to install";
    if (iBtn) iBtn.style.display = "inline-block";
    showBanner();
  });

  // Error — silently hide (don't panic the user over a failed update check)
  window.lanbeam.update.onError(() => hideBanner());
})();

/* ==========================================================================
   Explorer View Implementation
   ========================================================================== */

function bindExplorer() {
  console.log("[Explorer] Binding explorer view elements...");
  const upBtn = document.getElementById("explorer-up-btn");
  const refreshBtn = document.getElementById("explorer-refresh-btn");
  const searchInput = document.getElementById("explorer-search-input");
  const scopeBtn = document.getElementById("explorer-search-scope-btn");
  const clearBtn = document.getElementById("explorer-search-clear-btn");

  console.log("[Explorer] Elements status:", {
    upBtn: !!upBtn,
    refreshBtn: !!refreshBtn,
    searchInput: !!searchInput,
    scopeBtn: !!scopeBtn,
    clearBtn: !!clearBtn,
  });

  upBtn?.addEventListener("click", () => {
    console.log("[Explorer] Up button clicked");
    navigateExplorerUp();
  });

  refreshBtn?.addEventListener("click", async () => {
    console.log("[Explorer] Refresh button clicked");
    if (refreshBtn.classList.contains("spinning")) return;
    refreshBtn.classList.add("spinning");
    const startTime = Date.now();
    try {
      await loadExplorerDirectory(
        explorerState.currentDeviceId,
        explorerState.currentPath,
      );
    } finally {
      const elapsed = Date.now() - startTime;
      const minSpin = Math.max(0, 500 - elapsed);
      setTimeout(() => {
        refreshBtn.classList.remove("spinning");
      }, minSpin);
    }
  });

  // Scope toggle button
  scopeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    explorerState.searchScope =
      explorerState.searchScope === "drive" ? "folder" : "drive";
    console.log("[Explorer] Scope toggled to:", explorerState.searchScope);
    if (explorerState.searchScope === "drive") {
      scopeBtn.textContent = "Whole Drive";
      scopeBtn.classList.add("scope-drive");
      if (searchInput) searchInput.placeholder = "Search whole drive...";
    } else {
      scopeBtn.textContent = "In Folder";
      scopeBtn.classList.remove("scope-drive");
      if (searchInput) searchInput.placeholder = "Search folder...";
    }
    if (searchInput && searchInput.value.trim()) {
      triggerExplorerSearch(searchInput.value.trim());
    }
  });

  // Live search input
  searchInput?.addEventListener("input", (e) => {
    const val = e.target.value;
    console.log("[Explorer] Search input changed:", val);
    if (clearBtn) clearBtn.style.display = val ? "inline-flex" : "none";

    clearTimeout(explorerState.searchDebounceTimer);
    if (!val.trim()) {
      console.log("[Explorer] Empty query, restoring full directory items");
      renderExplorerList(explorerState.items);
      return;
    }

    const delay = explorerState.searchScope === "folder" ? 50 : 250;
    explorerState.searchDebounceTimer = setTimeout(() => {
      triggerExplorerSearch(val.trim());
    }, delay);
  });

  // Clear button
  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    console.log("[Explorer] Search cleared");
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
    }
    clearBtn.style.display = "none";
    renderExplorerList(explorerState.items);
  });

  window.lanbeam.explorer?.onDevicesUpdated?.(() => {
    loadExplorerDevices();
  });

  const splitBtn = document.getElementById("explorer-split-btn");
  splitBtn?.addEventListener("click", () => {
    toggleExplorerSplitView();
  });

  initExplorerSplitControls();

  loadExplorerDevices();
}

function refreshExplorer() {
  console.log("[Explorer] refreshExplorer called");
  if (explorerState.currentDeviceId && explorerState.currentPath) {
    loadExplorerDirectory(
      explorerState.currentDeviceId,
      explorerState.currentPath,
    );
  } else {
    loadExplorerDevices();
  }
}

async function loadExplorerDevices() {
  // show skeleton tabs
  const bar0 = document.getElementById("explorer-devices-bar");
  if (bar0 && !bar0.querySelector(".explorer-device-tab")) {
    bar0.innerHTML = [1, 2, 3]
      .map(
        () =>
          '<div class="skeleton-shimmer" style="display:inline-block;width:100px;height:32px;border-radius:20px;margin-right:8px;vertical-align:middle"></div>',
      )
      .join("");
  }
  try {
    const devices = await window.lanbeam.explorer.getDevices();
    console.log("[Explorer] getDevices returned:", devices);
    explorerState.devices = devices || [];
    renderExplorerDevicesBar();
    updateExplorerSplitSelects();
    if (!explorerState.currentDeviceId && devices.length > 0) {
      selectExplorerDevice(devices[0].id, devices[0].rootPath);
    }
  } catch (err) {
    console.error("[Explorer] Failed to load devices:", err);
  }
}

function renderExplorerDevicesBar() {
  const bar = document.getElementById("explorer-devices-bar");
  if (!bar) return;
  bar.innerHTML = "";

  explorerState.devices.forEach((dev) => {
    const tabWrap = document.createElement("div");
    tabWrap.style.cssText =
      "display: inline-flex; align-items: center; position: relative;";

    const btn = document.createElement("button");
    btn.className =
      "explorer-device-tab" +
      (dev.id === explorerState.currentDeviceId ? " active" : "");

    const isFtp = dev.id.startsWith("ftp-");
    const iconSvg = isFtp
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
      : dev.kind === "phone"
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>';

    btn.innerHTML = `${iconSvg} <span>${escapeHtml(dev.name)}</span>`;
    btn.addEventListener("click", () => {
      selectExplorerDevice(dev.id, dev.rootPath);
    });
    tabWrap.appendChild(btn);

    if (isFtp) {
      const delBtn = document.createElement("button");
      delBtn.className = "explorer-ftp-del-btn";
      delBtn.title = "Disconnect FTP";
      delBtn.innerHTML = "×";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await window.lanbeam.explorer.removeFtpDevice(dev.id);
        if (explorerState.currentDeviceId === dev.id) {
          const fallback = explorerState.devices.find((d) => d.id !== dev.id);
          if (fallback) selectExplorerDevice(fallback.id, fallback.rootPath);
        }
      });
      tabWrap.appendChild(delBtn);
    }

    bar.appendChild(tabWrap);
  });

  // "+ Add FTP" button
  const addBtn = document.createElement("button");
  addBtn.className = "explorer-device-tab explorer-add-ftp-btn";
  addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> <span>Add FTP</span>`;
  addBtn.addEventListener("click", () => {
    openFtpModal();
  });
  bar.appendChild(addBtn);
}

function openFtpModal() {
  const existing = document.getElementById("explorer-ftp-modal");
  if (existing) existing.remove();

  // Smart IP Prediction:
  // 1. Look for paired phone IP in state.pairedDevices
  // 2. Or extrapolate from PC's own subnet (e.g. 192.168.1.xxx)
  let predictedHost = "";
  let predictedLabel = "";

  if (Array.isArray(state.pairedDevices)) {
    const phone = state.pairedDevices.find((d) => d.ip && d.ip !== "127.0.0.1");
    if (phone) {
      predictedHost = phone.ip;
      predictedLabel = phone.name ? phone.name + " Storage" : "";
    }
  }

  if (!predictedHost && state.ipUrl) {
    try {
      const u = new URL(state.ipUrl);
      const parts = u.hostname.split(".");
      if (parts.length === 4) {
        predictedHost = parts.slice(0, 3).join(".") + ".";
      }
    } catch (_) {}
  }

  if (!predictedHost) {
    predictedHost = "192.168.1.";
  }

  const modal = document.createElement("div");
  modal.id = "explorer-ftp-modal";
  modal.className = "modal-overlay open";
  modal.innerHTML = `
    <div class="modal-card" style="max-width: 440px; text-align: left; padding: 22px;">
      <div style="font-family: var(--font-sans); font-size: 17px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--accent-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        Connect Phone FTP Storage
      </div>
      <p style="font-size: 13px; color: var(--text-muted); line-height: 1.4; margin-bottom: 16px;">
        Check your phone File Manager or WiFi FTP app. The local subnet is prefilled below so you only need to confirm the IP and port.
      </p>

      <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 18px;">
        <div style="display: grid; grid-template-columns: 2.5fr 1fr; gap: 10px;">
          <div>
            <label style="display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Phone IP / Host *</label>
            <input type="text" id="ftp-input-host" value="${escapeHtml(predictedHost)}" placeholder="192.168.1.xxx" style="width: 100%; box-sizing: border-box; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px 12px; color: #fff; font-family: var(--font-sans); font-size: 13px; outline: none;" autofocus />
          </div>
          <div>
            <label style="display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Port *</label>
            <input type="number" id="ftp-input-port" value="2121" placeholder="2121" style="width: 100%; box-sizing: border-box; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px 12px; color: #fff; font-family: var(--font-sans); font-size: 13px; outline: none;" />
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div>
            <label style="display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Username (optional)</label>
            <input type="text" id="ftp-input-user" placeholder="anonymous" style="width: 100%; box-sizing: border-box; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px 12px; color: #fff; font-family: var(--font-sans); font-size: 13px; outline: none;" />
          </div>
          <div>
            <label style="display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Password (optional)</label>
            <input type="password" id="ftp-input-pass" placeholder="leave blank if none" style="width: 100%; box-sizing: border-box; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px 12px; color: #fff; font-family: var(--font-sans); font-size: 13px; outline: none;" />
          </div>
        </div>
        <div>
          <label style="display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Drive Label (optional)</label>
          <input type="text" id="ftp-input-name" value="${escapeHtml(predictedLabel)}" placeholder="e.g. Galaxy S24 Storage" style="width: 100%; box-sizing: border-box; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px 12px; color: #fff; font-family: var(--font-sans); font-size: 13px; outline: none;" />
        </div>
      </div>

      <div id="ftp-modal-status" style="display: none; font-size: 12px; line-height: 1.4; color: #ff6b6b; margin-bottom: 14px; padding: 8px 12px; border-radius: 6px; background: rgba(255, 107, 107, 0.1); border: 1px solid rgba(255, 107, 107, 0.2);"></div>

      <div style="display: flex; justify-content: flex-end; gap: 10px;">
        <button type="button" class="modal-btn" id="ftp-modal-cancel">Cancel</button>
        <button type="button" class="modal-btn modal-btn-primary" id="ftp-modal-connect">Connect Drive</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const hostInput = modal.querySelector("#ftp-input-host");
  const portInput = modal.querySelector("#ftp-input-port");
  const userInput = modal.querySelector("#ftp-input-user");
  const passInput = modal.querySelector("#ftp-input-pass");
  const nameInput = modal.querySelector("#ftp-input-name");
  const statusEl = modal.querySelector("#ftp-modal-status");
  const cancelBtn = modal.querySelector("#ftp-modal-cancel");
  const connectBtn = modal.querySelector("#ftp-modal-connect");

  cancelBtn.addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  const doConnect = async () => {
    let rawHost = (hostInput.value || "").trim().replace(/^ftp:\/\//i, "");
    let port = parseInt(portInput.value, 10) || 21;

    // Handle full URL pasted into host input
    if (rawHost.includes(":")) {
      const parts = rawHost.split(":");
      rawHost = parts[0];
      port = parseInt(parts[1], 10) || port;
    }
    if (rawHost.includes("/")) {
      rawHost = rawHost.split("/")[0];
    }

    if (!rawHost || rawHost.endsWith(".")) {
      statusEl.style.color = "#ff6b6b";
      statusEl.textContent =
        "Please finish entering a complete IP address (e.g. 192.168.1.110)";
      statusEl.style.display = "block";
      return;
    }

    statusEl.style.color = "var(--text-muted)";
    statusEl.style.background = "rgba(255,255,255,0.05)";
    statusEl.style.borderColor = "rgba(255,255,255,0.1)";
    statusEl.textContent =
      "Testing connection to " + rawHost + ":" + port + "...";
    statusEl.style.display = "block";
    connectBtn.disabled = true;

    try {
      const res = await window.lanbeam.explorer.addFtpDevice({
        host: rawHost,
        port,
        user: userInput.value.trim() || undefined,
        password: passInput.value || undefined,
        name: nameInput.value.trim() || undefined,
      });

      if (!res.ok) {
        statusEl.style.color = "#ff6b6b";
        statusEl.style.background = "rgba(255, 107, 107, 0.1)";
        statusEl.style.borderColor = "rgba(255, 107, 107, 0.2)";
        statusEl.textContent = res.error || "Connection failed";
        connectBtn.disabled = false;
        return;
      }

      modal.remove();
      await loadExplorerDevices();
      selectExplorerDevice(res.device.id, `ftp://${res.device.id}/`);
    } catch (err) {
      statusEl.style.color = "#ff6b6b";
      statusEl.style.background = "rgba(255, 107, 107, 0.1)";
      statusEl.style.borderColor = "rgba(255, 107, 107, 0.2)";
      statusEl.textContent = "Error: " + err.message;
      connectBtn.disabled = false;
    }
  };

  connectBtn.addEventListener("click", doConnect);
  hostInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doConnect();
  });
  portInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doConnect();
  });
  passInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doConnect();
  });
}

function selectExplorerDevice(deviceId, rootPath) {
  console.log("[Explorer] Selecting device:", deviceId, rootPath);
  explorerState.currentDeviceId = deviceId;
  explorerState.historyStack = [];
  renderExplorerDevicesBar();
  // Restore last visited path for this device, or fall back to root
  const restoredPath = explorerState.devicePaths[deviceId] || rootPath || "";
  loadExplorerDirectory(deviceId, restoredPath);
}

async function loadExplorerDirectory(deviceId, path) {
  console.log("[Explorer] loadExplorerDirectory:", { deviceId, path });
  const listEl = document.getElementById("explorer-list");
  if (listEl) {
    listEl.innerHTML = Array.from({ length: 6 })
      .map(
        () => `
      <div class="skeleton-row">
        <div class="skeleton-shimmer" style="width: 22px; height: 22px; border-radius: 4px; flex-shrink: 0;"></div>
        <div class="skeleton-shimmer" style="width: ${Math.floor(Math.random() * 40 + 35)}%; height: 16px;"></div>
        <div style="flex: 1;"></div>
        <div class="skeleton-shimmer" style="width: 60px; height: 14px;"></div>
        <div class="skeleton-shimmer" style="width: 90px; height: 14px; margin-left: 24px;"></div>
      </div>
    `,
      )
      .join("");
  }
  try {
    const res = await window.lanbeam.explorer.listDirectory({ deviceId, path });
    console.log(
      "[Explorer] listDirectory returned:",
      res.currentPath,
      res.items?.length,
      "items",
    );
    explorerState.currentPath = res.currentPath;
    explorerState.items = res.items;
    explorerState.devicePaths[deviceId] = res.currentPath; // remember for next switch

    const sInput = document.getElementById("explorer-search-input");
    const cBtn = document.getElementById("explorer-search-clear-btn");
    if (sInput && sInput.value) {
      sInput.value = "";
      if (cBtn) cBtn.style.display = "none";
    }

    renderExplorerBreadcrumbs(res.currentPath);
    renderExplorerList(res.items);
  } catch (err) {
    console.error("[Explorer] listDirectory failed:", err);
    if (listEl) {
      let rawMsg = err.message || "";
      let cleanMsg = rawMsg;
      let hint = "";

      if (rawMsg.includes("ECONNREFUSED")) {
        cleanMsg = "Connection refused by phone FTP server.";
        hint =
          "Make sure the FTP Server or File Manager on your phone is turned ON and listening on the expected port.";
      } else if (
        rawMsg.includes("Authentication failed") ||
        rawMsg.includes("530")
      ) {
        cleanMsg = "Authentication failed (Incorrect Username or Password).";
        hint =
          "Disconnect this tab (click ×) and reconnect with the correct credentials, or enable anonymous login on your phone.";
      } else if (
        rawMsg.includes("ETIMEDOUT") ||
        rawMsg.includes("EHOSTUNREACH")
      ) {
        cleanMsg = "Phone unreachable on the local network.";
        hint =
          "Verify that both your PC and phone are connected to the exact same Wi-Fi network.";
      }

      listEl.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; max-width: 480px; margin: 0 auto;">
          <div style="font-size: 32px; margin-bottom: 12px; opacity: 0.85;">⚠️</div>
          <div style="font-size: 15px; font-weight: 600; color: #ff6b6b; margin-bottom: 6px;">${escapeHtml(cleanMsg)}</div>
          ${hint ? `<div style="font-size: 13px; color: var(--text-muted); line-height: 1.5; margin-bottom: 16px;">${escapeHtml(hint)}</div>` : ""}
          <div style="display: flex; justify-content: center; gap: 10px;">
            <button class="modal-btn" onclick="refreshExplorer()" style="padding: 6px 16px;">Retry Connection</button>
            <button class="modal-btn" onclick="openFtpModal()" style="padding: 6px 16px; border-color: var(--accent-color); color: var(--accent-color);">Edit / Reconnect</button>
          </div>
        </div>
      `;
    }
  }
}

async function triggerExplorerSearch(query) {
  console.log("[Explorer] triggerExplorerSearch:", {
    query,
    scope: explorerState.searchScope,
    currentPath: explorerState.currentPath,
    currentDeviceId: explorerState.currentDeviceId,
    inMemoryCount: explorerState.items?.length,
  });

  const listEl = document.getElementById("explorer-list");
  if (!query) {
    renderExplorerList(explorerState.items);
    return;
  }

  // Instant in-memory filter if folder scope and items are loaded
  if (
    explorerState.searchScope === "folder" &&
    explorerState.items &&
    explorerState.items.length > 0
  ) {
    const q = query.toLowerCase();
    const localMatches = explorerState.items.filter((it) =>
      it.name.toLowerCase().includes(q),
    );
    console.log(
      "[Explorer] In-folder filter matched:",
      localMatches.length,
      "items",
    );
    renderExplorerList(localMatches);
    return;
  }

  if (listEl) {
    listEl.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted);"><span style="display:inline-block; animation: spinRefresh 0.75s linear infinite; margin-right: 8px;">⏳</span>Searching ${explorerState.searchScope === "drive" ? "drive" : "folder"} for "${escapeHtml(query)}"...</div>`;
  }

  try {
    const results = await window.lanbeam.explorer.search({
      scope: explorerState.searchScope,
      targetPath: explorerState.currentPath,
      query: query,
      deviceId: explorerState.currentDeviceId,
    });
    console.log(
      "[Explorer] Search backend returned:",
      results?.length,
      "results",
    );
    renderExplorerList(results || []);
    if (!results || results.length === 0) {
      if (listEl) {
        listEl.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted);">No matches found for "${escapeHtml(query)}"</div>`;
      }
    }
  } catch (err) {
    console.error("[Explorer] Search error:", err);
    if (listEl) {
      listEl.innerHTML = `<div style="padding: 24px; text-align: center; color: #ff6b6b;">Search error: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderExplorerBreadcrumbs(currentPath) {
  const bc = document.getElementById("explorer-breadcrumbs");
  if (!bc) return;
  bc.innerHTML = "";

  const isPhone = currentPath.startsWith("phone://");
  const isFtp = currentPath.startsWith("ftp://");
  let segments = [];
  if (isFtp) {
    // e.g. ftp://ftp-192_168_1_50-2121/foo/bar
    const afterScheme = currentPath.replace(/^ftp:\/\//, "");
    const parts = afterScheme.split("/").filter(Boolean);
    const devId = parts[0] || "ftp";
    const subParts = parts.slice(1);
    segments = ["FTP", ...subParts];
  } else {
    segments = currentPath.split(/[\\/]/).filter(Boolean);
  }

  const A = 12;
  const COLLAPSE_THRESHOLD = 4; // collapse if more than this many segments

  const SW = 1.5;
  const roundedPoly = (pts, radii) => {
    const n = pts.length;
    let d = "";
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i + n - 1) % n],
        p1 = pts[i],
        p2 = pts[(i + 1) % n];
      const v1 = [p0[0] - p1[0], p0[1] - p1[1]],
        v2 = [p2[0] - p1[0], p2[1] - p1[1]];
      const l1 = Math.hypot(...v1),
        l2 = Math.hypot(...v2);
      const r = Math.min(radii[i], l1 / 2, l2 / 2);
      const a = [p1[0] + (v1[0] / l1) * r, p1[1] + (v1[1] / l1) * r];
      const b = [p1[0] + (v2[0] / l2) * r, p1[1] + (v2[1] / l2) * r];
      const k = 0.5523;
      const c1 = [a[0] + (p1[0] - a[0]) * k, a[1] + (p1[1] - a[1]) * k];
      const c2 = [b[0] + (p1[0] - b[0]) * k, b[1] + (p1[1] - b[1]) * k];
      d +=
        (i ? "L" : "M") +
        a[0] +
        " " +
        a[1] +
        "C" +
        c1[0] +
        " " +
        c1[1] +
        " " +
        c2[0] +
        " " +
        c2[1] +
        " " +
        b[0] +
        " " +
        b[1];
    }
    return d + "Z";
  };

  const attachShape = (el, first, last) => {
    const NS = "http://www.w3.org/2000/svg";
    const sv = document.createElementNS(NS, "svg");
    sv.setAttribute("class", "pl-shape");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("stroke-width", SW);
    path.setAttribute("stroke-linejoin", "round");
    sv.appendChild(path);
    el.insertBefore(sv, el.firstChild);
    const draw = () => {
      const w = el.offsetWidth,
        h = el.offsetHeight;
      if (!w || !h) return;
      const o = SW / 2,
        x0 = o,
        y0 = o,
        x1 = w - o,
        y1 = h - o,
        ym = h / 2;
      const T = 3.5,
        P = (h - SW) / 2;
      let pts, rad;
      if (first && last) {
        pts = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ];
        rad = [P, P, P, P];
      } else if (first) {
        pts = [
          [x0, y0],
          [x1 - A, y0],
          [x1, ym],
          [x1 - A, y1],
          [x0, y1],
        ];
        rad = [P, T, T, T, P];
      } else if (last) {
        pts = [
          [x0 + A, y0],
          [x1, y0],
          [x1, y1],
          [x0 + A, y1],
          [x0, ym],
        ];
        rad = [T, P, P, T, T];
      } else {
        pts = [
          [x0 + A, y0],
          [x1 - A, y0],
          [x1, ym],
          [x1 - A, y1],
          [x0 + A, y1],
          [x0, ym],
        ];
        rad = [T, T, T, T, T, T];
      }
      path.setAttribute("d", roundedPoly(pts, rad));
    };
    draw();
    new ResizeObserver(draw).observe(el);
  };

  const svg = (d) =>
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const ICON_TERM = "M4 17 10 11 4 5M12 19h8";
  const ICON_PHONE =
    "M8 2h8M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 16v.01";
  const ICON_FOLDER =
    "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z";

  // Build path for a given segment index
  const getTargetPath = (idx) => {
    if (isFtp) {
      if (idx === 0) return `ftp://${explorerState.currentDeviceId}/`;
      const sub = segments.slice(1, idx + 1).join("/");
      return `ftp://${explorerState.currentDeviceId}/${sub}`;
    }
    if (isPhone) return "phone://" + segments.slice(0, idx + 1).join("/");
    if (idx === 0)
      return segments[0].endsWith(":") ? segments[0] + "\\" : segments[0];
    const root = segments[0].endsWith(":") ? segments[0] + "\\" : segments[0];
    return root + segments.slice(1, idx + 1).join("\\");
  };

  const makeSeg = (seg, idx, isFirst, isLast) => {
    const segColor = isLast
      ? "var(--accent-color)"
      : "rgba(235, 240, 245, 0.45)";
    const textColor = isLast
      ? "var(--accent-color)"
      : "var(--text-primary, #ffffff)";
    const el = document.createElement("div");
    el.className =
      "pl-seg" +
      (isFirst ? " pl-seg-first" : "") +
      (isLast ? " pl-seg-last" : "");
    el.style.setProperty("--pl-c", segColor);
    el.style.setProperty("--pl-text", textColor);
    let icon = "";
    if (isFirst) icon = svg(isPhone || isFtp ? ICON_PHONE : ICON_TERM);
    else if (isLast) icon = svg(ICON_FOLDER);
    el.innerHTML = `<span class="pl-in">${icon ? `<span class="pl-seg-icon">${icon}</span>` : ""}<span class="pl-seg-label">${escapeHtml(seg)}</span></span>`;
    attachShape(el, isFirst, isLast);
    el.addEventListener("click", () => {
      if (!isLast) {
        explorerState.historyStack.push(explorerState.currentPath);
        loadExplorerDirectory(
          explorerState.currentDeviceId,
          getTargetPath(idx),
        );
      }
    });
    return el;
  };

  if (segments.length <= COLLAPSE_THRESHOLD) {
    // Short path — render all segments normally
    segments.forEach((seg, idx) => {
      bc.appendChild(makeSeg(seg, idx, idx === 0, idx === segments.length - 1));
    });
  } else {
    // Long path — show: [root] [...] [parent] [current]
    // root
    bc.appendChild(makeSeg(segments[0], 0, true, false));

    // collapsed "..." pill with dropdown of hidden segments
    const hiddenStart = 1;
    const hiddenEnd = segments.length - 2; // exclusive: hide segments 1..n-3

    const ellipsisSeg = document.createElement("div");
    ellipsisSeg.className = "pl-seg pl-seg-ellipsis";
    ellipsisSeg.style.setProperty("--pl-c", "rgba(235, 240, 245, 0.35)");
    ellipsisSeg.style.setProperty("--pl-text", "var(--text-muted)");
    ellipsisSeg.innerHTML = `<span class="pl-in"><span class="pl-seg-label">…</span></span>`;
    attachShape(ellipsisSeg, false, false);
    ellipsisSeg.style.cursor = "pointer";
    ellipsisSeg.style.position = "relative";

    // Build dropdown
    const dropdown = document.createElement("div");
    dropdown.className = "pl-ellipsis-dropdown";
    dropdown.style.cssText = `
      display: none;
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      background: var(--bg-elev-2, #1a1a1a);
      border: 1px solid rgba(235,240,245,0.15);
      border-radius: 8px;
      padding: 4px;
      z-index: 999;
      min-width: 160px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    `;

    for (let i = hiddenStart; i <= hiddenEnd; i++) {
      const item = document.createElement("div");
      item.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-radius: 6px; cursor: pointer;
        font-family: var(--font-sans); font-size: 12px;
        color: var(--text-primary); white-space: nowrap;
      `;
      item.innerHTML = `<span style="opacity:0.5">${svg(ICON_FOLDER)}</span>${escapeHtml(segments[i])}`;
      item.addEventListener(
        "mouseover",
        () => (item.style.background = "rgba(255,255,255,0.07)"),
      );
      item.addEventListener("mouseout", () => (item.style.background = ""));
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.style.display = "none";
        explorerState.historyStack.push(explorerState.currentPath);
        loadExplorerDirectory(explorerState.currentDeviceId, getTargetPath(i));
      });
      dropdown.appendChild(item);
    }

    ellipsisSeg.appendChild(dropdown);
    ellipsisSeg.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.style.display =
        dropdown.style.display === "none" ? "block" : "none";
    });
    document.addEventListener(
      "click",
      () => {
        dropdown.style.display = "none";
      },
      { capture: false },
    );
    bc.appendChild(ellipsisSeg);

    // parent (second-to-last)
    if (segments.length >= 3) {
      bc.appendChild(
        makeSeg(
          segments[segments.length - 2],
          segments.length - 2,
          false,
          false,
        ),
      );
    }
    // current (last)
    bc.appendChild(
      makeSeg(segments[segments.length - 1], segments.length - 1, false, true),
    );
  }
}

function showTransferTargetModal(item, sourceDeviceId) {
  const existing = document.getElementById("explorer-transfer-modal");
  if (existing) existing.remove();

  const isFromFtp = sourceDeviceId && sourceDeviceId.startsWith("ftp-");
  const modal = document.createElement("div");
  modal.id = "explorer-transfer-modal";
  modal.className = "modal-overlay open";

  const sizeText = item.size ? formatBytes(item.size) : "";

  // Identify connected target devices
  const ftpDevices = explorerState.devices.filter((d) =>
    d.id.startsWith("ftp-"),
  );
  const pcDevices = explorerState.devices.filter(
    (d) => !d.id.startsWith("ftp-"),
  );
  const firstFtp = ftpDevices[0];
  const firstPc = pcDevices[0] || { id: "pc-c" };

  let targetOptionsHtml = "";

  if (isFromFtp) {
    // === FROM FTP STORAGE ===
    // Priority 1: Save to LANBeam Default Folder
    // Priority 2: Custom PC Folder picker (Browse...)
    targetOptionsHtml = `
      <!-- Option 1: Default LANBeam Folder -->
      <div id="transfer-opt-primary" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: rgba(var(--accent-rgb), 0.08); border: 1px solid var(--accent-color); border-radius: 12px; cursor: pointer; transition: transform 0.15s, background 0.15s;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">📥</span>
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">Save to Default LANBeam Folder</div>
            <div id="transfer-opt-path-sub" style="font-size: 11px; color: var(--text-muted); margin-top: 2px; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Loading...</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--accent-color); font-weight: 600;">Default →</span>
      </div>

      <!-- Option 2: Choose folder on PC -->
      <div id="transfer-opt-browse" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; cursor: pointer; transition: border-color 0.15s, background 0.15s;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">📂</span>
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">Choose Custom PC Folder...</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Browse any drive or directory on this PC</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--text-muted); font-weight: 500;">Browse →</span>
      </div>
    `;
  } else {
    // === FROM PC DRIVE ===
    // Priority 1: Send directly to Connected Phone FTP Storage
    // Priority 2: Custom PC Folder picker (Browse...)
    const ftpTitle = firstFtp
      ? `Send to ${escapeHtml(firstFtp.name)}`
      : "Send to Phone FTP";
    const ftpSub = firstFtp
      ? "Uploads directly to connected phone storage"
      : "No phone FTP connected yet (connect from + Add FTP)";

    targetOptionsHtml = `
      <!-- Option 1: Send to Phone FTP (Priority) -->
      <div id="transfer-opt-primary" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: ${firstFtp ? "rgba(var(--accent-rgb), 0.08)" : "rgba(255,255,255,0.03)"}; border: 1px solid ${firstFtp ? "var(--accent-color)" : "rgba(255,255,255,0.1)"}; border-radius: 12px; cursor: ${firstFtp ? "pointer" : "default"}; transition: transform 0.15s, background 0.15s;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">📱</span>
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">${ftpTitle}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${ftpSub}</div>
          </div>
        </div>
        <span style="font-size: 13px; color: ${firstFtp ? "var(--accent-color)" : "var(--text-muted)"}; font-weight: 600;">${firstFtp ? "Send →" : "Offline"}</span>
      </div>

      <!-- Option 2: Copy to another PC folder -->
      <div id="transfer-opt-browse" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; cursor: pointer; transition: border-color 0.15s, background 0.15s;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">📁</span>
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">Copy to Another Folder...</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Select destination folder on PC</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--text-muted); font-weight: 500;">Browse →</span>
      </div>
    `;
  }

  modal.innerHTML = `
    <div class="modal-card" style="max-width: 520px; width: 92vw; text-align: left; padding: 24px; border: 1px solid rgba(var(--accent-rgb), 0.25); border-radius: 16px; background: #0d0e12; box-shadow: 0 20px 48px rgba(0,0,0,0.85);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
        <div style="display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; color: #fff;">
          <span style="display: inline-flex; width: 32px; height: 32px; border-radius: 8px; background: rgba(var(--accent-rgb), 0.12); align-items: center; justify-content: center; color: var(--accent-color);">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          </span>
          Transfer ${item.isDirectory ? "Folder" : "File"}
        </div>
        <button type="button" id="transfer-modal-close" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 18px; padding: 4px;">✕</button>
      </div>

      <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 12px 14px; margin-bottom: 20px; display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 22px;">${item.isDirectory ? "📁" : "📄"}</span>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 13px; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.name)}</div>
          ${sizeText ? `<div style="font-size: 11px; color: var(--accent-color); margin-top: 2px;">${sizeText}</div>` : ""}
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px;">
        ${targetOptionsHtml}
      </div>

      <div id="transfer-modal-error" style="display: none; font-size: 12px; color: #ff6b6b; margin-top: 10px; line-height: 1.4;"></div>
    </div>
  `;

  document.body.appendChild(modal);

  const primaryBtn = modal.querySelector("#transfer-opt-primary");
  const browseBtn = modal.querySelector("#transfer-opt-browse");
  const closeBtn = modal.querySelector("#transfer-modal-close");
  const pathSubEl = modal.querySelector("#transfer-opt-path-sub");
  const errorEl = modal.querySelector("#transfer-modal-error");

  let defaultDir = state.settings?.downloadDir || "";
  window.lanbeam.transfer?.defaultDownloadDir?.().then((dir) => {
    if (!defaultDir) defaultDir = dir;
    if (pathSubEl) pathSubEl.textContent = defaultDir || "Downloads\\LANBeam";
  });

  const closeModal = () => modal.remove();
  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  const executeTransfer = async (targetDir, targetDeviceId) => {
    modal.remove();
    const isOut = !sourceDeviceId.startsWith("ftp-");
    const tid = "ftp-transfer-active";
    updateTransferCard(
      {
        fileId: tid,
        fileName: item.name,
        totalBytes: item.size || 0,
        bytesTransferred: 0,
        peerName: isOut ? firstFtp?.name || "Phone Storage" : "Phone Storage",
        throughputMbps: 0,
        etaMs: 0,
        sparkline: [],
      },
      isOut ? "out" : "in",
    );

    try {
      const res = await window.lanbeam.explorer.transfer({
        transferId: tid,
        sourcePath: item.path,
        targetDir: targetDir,
        sourceDeviceId: sourceDeviceId,
        targetDeviceId: targetDeviceId,
        totalBytes: item.size || 0,
      });
      if (!res.ok) {
        failTransferCard(res.error || "Transfer failed", tid);
      }
    } catch (err) {
      failTransferCard(err.message || "Transfer error", tid);
    }
  };

  if (isFromFtp) {
    // 1. FTP -> Default PC folder
    primaryBtn?.addEventListener("click", () => {
      executeTransfer(defaultDir || "C:\\", firstPc.id);
    });
    // 2. FTP -> Pick PC folder
    browseBtn?.addEventListener("click", async () => {
      try {
        const picked = await window.lanbeam.transfer.pickDownloadDir();
        if (picked) executeTransfer(picked, firstPc.id);
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = "Browse failed: " + err.message;
          errorEl.style.display = "block";
        }
      }
    });
  } else {
    // 1. PC -> Phone FTP (Priority)
    primaryBtn?.addEventListener("click", () => {
      if (!firstFtp) {
        openFtpModal();
        return;
      }
      const remoteDir =
        explorerState.devicePaths[firstFtp.id] || firstFtp.rootPath || "/";
      executeTransfer(remoteDir, firstFtp.id);
    });
    // 2. PC -> Another PC folder
    browseBtn?.addEventListener("click", async () => {
      try {
        const picked = await window.lanbeam.transfer.pickDownloadDir();
        if (picked) executeTransfer(picked, firstPc.id);
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = "Browse failed: " + err.message;
          errorEl.style.display = "block";
        }
      }
    });
  }
}


function updateExplorerSelectionUI() {
  const listEl = document.getElementById("explorer-list");
  if (!listEl) return;
  const rows = listEl.querySelectorAll(".explorer-row");
  rows.forEach((r) => {
    const itemPath = r.getAttribute("data-item-path");
    if (explorerState.selectedPaths.has(itemPath)) {
      r.classList.add("selected");
    } else {
      r.classList.remove("selected");
    }
  });

  let bar = document.getElementById("explorer-batch-bar");
  const count = explorerState.selectedPaths.size;
  if (!bar && count > 0) {
    bar = document.createElement("div");
    bar.id = "explorer-batch-bar";
    bar.className = "explorer-batch-bar";
    bar.innerHTML = `
      <div class="explorer-batch-count">
        <span class="explorer-batch-count-badge" id="explorer-batch-count-num">0</span>
        <span>Selected</span>
      </div>
      <button type="button" class="explorer-batch-btn-transfer" id="explorer-batch-transfer-btn">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Transfer Selected
      </button>
      <button type="button" class="explorer-batch-btn-clear" id="explorer-batch-clear-btn">Deselect</button>
    `;
    const expBody = document.querySelector(".explorer-body") || document.body;
    expBody.appendChild(bar);

    bar.querySelector("#explorer-batch-clear-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      explorerState.selectedPaths.clear();
      updateExplorerSelectionUI();
    });

    bar.querySelector("#explorer-batch-transfer-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const selectedItems = explorerState.items.filter((it) => explorerState.selectedPaths.has(it.path));
      if (selectedItems.length > 0) {
        showBatchTransferTargetModal(selectedItems, explorerState.currentDeviceId);
      }
    });
  }

  if (bar) {
    const badge = bar.querySelector("#explorer-batch-count-num");
    if (badge) badge.textContent = count;
    if (count > 0) {
      bar.classList.add("active");
    } else {
      bar.classList.remove("active");
    }
  }
}

function initExplorerLasso() {
  const listEl = document.getElementById("explorer-list");
  if (!listEl || listEl._lassoInitialized) return;
  listEl._lassoInitialized = true;

  let isSelecting = false;
  let startX = 0;
  let startY = 0;
  let lassoBox = null;

  listEl.addEventListener("mousedown", (e) => {
    // Only left click outside row action buttons & checkboxes
    if (e.button !== 0) return;
    if (e.target.closest(".explorer-row-action-btn") || e.target.closest(".explorer-row-checkbox")) return;

    // If not holding Ctrl/Shift and clicking empty area, clear previous selection
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.target.closest(".explorer-row")) {
      explorerState.selectedPaths.clear();
      updateExplorerSelectionUI();
    }

    // Start lasso only on background click or if dragging
    const isRow = e.target.closest(".explorer-row");
    const rect = listEl.getBoundingClientRect();
    startX = e.clientX - rect.left + listEl.scrollLeft;
    startY = e.clientY - rect.top + listEl.scrollTop;

    let hasMoved = false;

    const onMouseMove = (moveEv) => {
      const curX = moveEv.clientX - rect.left + listEl.scrollLeft;
      const curY = moveEv.clientY - rect.top + listEl.scrollTop;
      const dx = curX - startX;
      const dy = curY - startY;

      if (!hasMoved && Math.hypot(dx, dy) > 5) {
        hasMoved = true;
        isSelecting = true;
        if (!lassoBox) {
          lassoBox = document.createElement("div");
          lassoBox.className = "explorer-lasso-box";
          listEl.appendChild(lassoBox);
        }
      }

      if (isSelecting && lassoBox) {
        const left = Math.min(startX, curX);
        const top = Math.min(startY, curY);
        const width = Math.abs(dx);
        const height = Math.abs(dy);

        lassoBox.style.left = left + "px";
        lassoBox.style.top = top + "px";
        lassoBox.style.width = width + "px";
        lassoBox.style.height = height + "px";

        // Check intersections with rows
        const lBoxRect = {
          left: left,
          top: top,
          right: left + width,
          bottom: top + height,
        };

        const rows = listEl.querySelectorAll(".explorer-row");
        rows.forEach((r) => {
          const rTop = r.offsetTop;
          const rBottom = rTop + r.offsetHeight;
          const rLeft = r.offsetLeft;
          const rRight = rLeft + r.offsetWidth;

          const intersects = !(
            rLeft > lBoxRect.right ||
            rRight < lBoxRect.left ||
            rTop > lBoxRect.bottom ||
            rBottom < lBoxRect.top
          );

          const itemPath = r.getAttribute("data-item-path");
          if (intersects) {
            explorerState.selectedPaths.add(itemPath);
          } else if (!moveEv.ctrlKey && !moveEv.metaKey) {
            // Unselect if not dragging with Ctrl
            explorerState.selectedPaths.delete(itemPath);
          }
        });
        updateExplorerSelectionUI();
      }
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (lassoBox) {
        lassoBox.remove();
        lassoBox = null;
      }
      isSelecting = false;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });
}

function renderExplorerList(items) {
  const listEl = document.getElementById("explorer-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!explorerState.selectedPaths) explorerState.selectedPaths = new Set();

  if (!items || items.length === 0) {
    listEl.innerHTML =
      '<div style="padding: 24px; text-align: center; color: var(--text-muted);">Empty folder</div>';
    return;
  }

  let lastClickedIndex = -1;

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "explorer-row";
    row.setAttribute("data-item-path", item.path);
    row.setAttribute("data-item-index", index);

    const isSelected = explorerState.selectedPaths.has(item.path);
    if (isSelected) row.classList.add("selected");

    const iconSvg = item.isDirectory
      ? '<span class="item-icon folder"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>'
      : '<span class="item-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></span>';

    const checkSvg = `<span class="explorer-row-checkbox" data-tip="Select"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,8 6,12 14,4"/></svg></span>`;

    const sizeText = item.isDirectory ? "--" : formatBytes(item.size);
    const dateText = item.mtime
      ? new Date(item.mtime).toLocaleDateString()
      : "";

    row.innerHTML = `
      <span class="col-check">${checkSvg}</span>
      <span class="col-name">${iconSvg} <span>${escapeHtml(item.name)}</span></span>
      <span class="col-size">${sizeText}</span>
      <span class="col-date">${dateText}</span>
      <span class="col-actions" style="margin-left: 12px; display: inline-flex; gap: 6px;">
        <button type="button" class="explorer-row-action-btn" data-tip="Transfer">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>
      </span>
    `;

    // Checkbox click — toggle selection without navigation
    const cb = row.querySelector(".explorer-row-checkbox");
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (explorerState.selectedPaths.has(item.path)) {
        explorerState.selectedPaths.delete(item.path);
        row.classList.remove("selected");
        cb.setAttribute("data-tip", "Select");
      } else {
        explorerState.selectedPaths.add(item.path);
        row.classList.add("selected");
        cb.setAttribute("data-tip", "Selected");
      }
      lastClickedIndex = index;
      updateExplorerSelectionUI();
    });

    const actionBtn = row.querySelector(".explorer-row-action-btn");
    actionBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showTransferTargetModal(item, explorerState.currentDeviceId);
    });

    row.addEventListener("click", (e) => {
      e.stopPropagation();

      // Ctrl+click: toggle selection
      if (e.ctrlKey || e.metaKey) {
        if (explorerState.selectedPaths.has(item.path)) {
          explorerState.selectedPaths.delete(item.path);
          row.classList.remove("selected");
        } else {
          explorerState.selectedPaths.add(item.path);
          row.classList.add("selected");
        }
        lastClickedIndex = index;
        updateExplorerSelectionUI();
        return;
      }

      // Shift+click: range select
      if (e.shiftKey && lastClickedIndex >= 0) {
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);
        const rows = listEl.querySelectorAll(".explorer-row");
        for (let i = start; i <= end; i++) {
          const r = rows[i];
          const p = r.getAttribute("data-item-path");
          if (p) {
            explorerState.selectedPaths.add(p);
            r.classList.add("selected");
          }
        }
        updateExplorerSelectionUI();
        return;
      }

      // If any items are selected, plain click toggles this item in selection
      if (explorerState.selectedPaths.size > 0) {
        if (explorerState.selectedPaths.has(item.path)) {
          explorerState.selectedPaths.delete(item.path);
          row.classList.remove("selected");
        } else {
          explorerState.selectedPaths.add(item.path);
          row.classList.add("selected");
        }
        lastClickedIndex = index;
        updateExplorerSelectionUI();
        return;
      }

      // Normal click with no selection active
      lastClickedIndex = index;
      if (item.isDirectory) {
        if (e.altKey) {
          showTransferTargetModal(item, explorerState.currentDeviceId);
        } else {
          explorerState.historyStack.push(explorerState.currentPath);
          loadExplorerDirectory(explorerState.currentDeviceId, item.path);
        }
      } else {
        showTransferTargetModal(item, explorerState.currentDeviceId);
      }
    });

    listEl.appendChild(row);
  });

  // Store items on the list for lasso use
  listEl._explorerItems = items;
  initExplorerLasso(listEl, items);
  updateExplorerSelectionUI();
}

function navigateExplorerUp() {
  if (explorerState.historyStack.length > 0) {
    const prev = explorerState.historyStack.pop();
    loadExplorerDirectory(explorerState.currentDeviceId, prev);
    return;
  }
  const curr = explorerState.currentPath;
  const parent = curr.replace(/[/\\][^/\\]+[/\\]?$/, "");
  if (parent && parent !== curr) {
    loadExplorerDirectory(explorerState.currentDeviceId, parent);
  }
}


function showBatchTransferTargetModal(items, sourceDeviceId) {
  if (!items || items.length === 0) return;
  if (items.length === 1) {
    showTransferTargetModal(items[0], sourceDeviceId);
    return;
  }

  const existing = document.getElementById("explorer-transfer-modal");
  if (existing) existing.remove();

  const isFromFtp = sourceDeviceId && sourceDeviceId.startsWith("ftp-");
  const modal = document.createElement("div");
  modal.id = "explorer-transfer-modal";
  modal.className = "modal-overlay open";

  const totalBytes = items.reduce((acc, it) => acc + (it.size || 0), 0);
  const sizeText = totalBytes ? formatBytes(totalBytes) : "";

  const ftpDevices = explorerState.devices.filter((d) => d.id.startsWith("ftp-"));
  const pcDevices = explorerState.devices.filter((d) => !d.id.startsWith("ftp-"));
  const firstFtp = ftpDevices[0];
  const firstPc = pcDevices[0] || { id: "pc-c" };

  let targetOptionsHtml = "";
  if (isFromFtp) {
    targetOptionsHtml = `
      <div id="transfer-opt-primary" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: rgba(var(--accent-rgb), 0.08); border: 1px solid var(--accent-color); border-radius: 12px; cursor: pointer; transition: transform 0.15s, background 0.15s;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">📥</span>
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">Save All to Default Folder</div>
            <div id="transfer-opt-path-sub" style="font-size: 11px; color: var(--text-muted); margin-top: 2px; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Loading...</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--accent-color); font-weight: 600;">Queue All →</span>
      </div>
      <div id="transfer-opt-browse" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; cursor: pointer; transition: border-color 0.15s, background 0.15s;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">📂</span>
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">Choose Custom PC Folder...</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Browse any folder on this PC for all ${items.length} items</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--text-muted); font-weight: 500;">Browse →</span>
      </div>
    `;
  } else {
    const ftpTitle = firstFtp ? `Send All to ${escapeHtml(firstFtp.name)}` : "Send to Phone FTP";
    const ftpSub = firstFtp ? `Uploads all ${items.length} items to phone storage` : "No phone FTP connected";
    targetOptionsHtml = `
      <div id="transfer-opt-primary" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: ${firstFtp ? "rgba(var(--accent-rgb), 0.08)" : "rgba(255,255,255,0.03)"}; border: 1px solid ${firstFtp ? "var(--accent-color)" : "rgba(255,255,255,0.1)"}; border-radius: 12px; cursor: ${firstFtp ? "pointer" : "default"}; transition: transform 0.15s, background 0.15s;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">📱</span>
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">${ftpTitle}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${ftpSub}</div>
          </div>
        </div>
        <span style="font-size: 13px; color: ${firstFtp ? "var(--accent-color)" : "var(--text-muted)"}; font-weight: 600;">${firstFtp ? "Queue All →" : "Offline"}</span>
      </div>
      <div id="transfer-opt-browse" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: var(--bg-elev-1); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; cursor: pointer; transition: border-color 0.15s, background 0.15s;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">📁</span>
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">Copy to Another Folder...</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Select destination folder on PC</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--text-muted); font-weight: 500;">Browse →</span>
      </div>
    `;
  }

  modal.innerHTML = `
    <div class="modal-card" style="max-width: 520px; width: 92vw; text-align: left; padding: 24px; border: 1px solid rgba(var(--accent-rgb), 0.25); border-radius: 16px; background: #0d0e12; box-shadow: 0 20px 48px rgba(0,0,0,0.85);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
        <div style="display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; color: #fff;">
          <span style="display: inline-flex; width: 32px; height: 32px; border-radius: 8px; background: rgba(var(--accent-rgb), 0.12); align-items: center; justify-content: center; color: var(--accent-color);">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          </span>
          Batch Transfer (${items.length} items)
        </div>
        <button type="button" id="transfer-modal-close" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 18px; padding: 4px;">✕</button>
      </div>

      <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 12px 14px; margin-bottom: 20px; display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 22px;">📦</span>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 13px; color: #fff;">${items.length} files & folders queued</div>
          ${sizeText ? `<div style="font-size: 11px; color: var(--accent-color); margin-top: 2px;">Total size: ${sizeText}</div>` : ""}
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px;">
        ${targetOptionsHtml}
      </div>

      <div id="transfer-modal-error" style="display: none; font-size: 12px; color: #ff6b6b; margin-top: 10px; line-height: 1.4;"></div>
    </div>
  `;

  document.body.appendChild(modal);

  const primaryBtn = modal.querySelector("#transfer-opt-primary");
  const browseBtn = modal.querySelector("#transfer-opt-browse");
  const closeBtn = modal.querySelector("#transfer-modal-close");
  const pathSubEl = modal.querySelector("#transfer-opt-path-sub");

  let defaultDir = state.settings?.downloadDir || "";
  window.lanbeam.transfer?.defaultDownloadDir?.().then((dir) => {
    if (!defaultDir) defaultDir = dir;
    if (pathSubEl) pathSubEl.textContent = defaultDir || "Downloads\\LANBeam";
  });

  const closeModal = () => modal.remove();
  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  const executeBatch = async (targetDir, targetDeviceId) => {
    modal.remove();
    explorerState.selectedPaths.clear();
    updateExplorerSelectionUI();

    const isOut = !sourceDeviceId.startsWith("ftp-");
    const peerName = isOut ? (firstFtp?.name || "Phone Storage") : "Phone Storage";

    toast(`Starting queue of ${items.length} transfers...`);

    // Sequential queue loop
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const tid = "batch-xfer-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      updateTransferCard(
        {
          fileId: tid,
          fileName: `[${i + 1}/${items.length}] ${it.name}`,
          totalBytes: it.size || 0,
          bytesTransferred: 0,
          peerName: peerName,
          throughputMbps: 0,
          etaMs: 0,
          sparkline: [],
        },
        isOut ? "out" : "in",
      );

      try {
        await window.lanbeam.explorer.transfer({
          transferId: tid,
          sourcePath: it.path,
          targetDir: targetDir,
          sourceDeviceId: sourceDeviceId,
          targetDeviceId: targetDeviceId,
          totalBytes: it.size || 0,
        });
        // explorer.transfer() already awaits completion — proceed to next item
      } catch (err) {
        console.error("Batch item failed:", it.name, err);
        failTransferCard(err.message || "Transfer error", tid);
      }
    }
    toast(`Completed all ${items.length} transfers!`);
  };

  if (isFromFtp) {
    primaryBtn?.addEventListener("click", () => executeBatch(defaultDir || "C:\\", firstPc.id));
    browseBtn?.addEventListener("click", async () => {
      const picked = await window.lanbeam.transfer.pickDownloadDir();
      if (picked) executeBatch(picked, firstPc.id);
    });
  } else {
    primaryBtn?.addEventListener("click", () => {
      if (!firstFtp) { openFtpModal(); return; }
      const remoteDir = explorerState.devicePaths[firstFtp.id] || firstFtp.rootPath || "/";
      executeBatch(remoteDir, firstFtp.id);
    });
    browseBtn?.addEventListener("click", async () => {
      const picked = await window.lanbeam.transfer.pickDownloadDir();
      if (picked) executeBatch(picked, firstPc.id);
    });
  }
}

/* ==========================================================================
   Explorer Split View (Dual-Pane Side-by-Side FTP / PC)
   ========================================================================== */

function toggleExplorerSplitView() {
  explorerState.isSplitView = !explorerState.isSplitView;
  const splitBtn = document.getElementById("explorer-split-btn");
  const singleBody = document.getElementById("explorer-single-body");
  const splitContainer = document.getElementById("explorer-split-container");
  const devBar = document.getElementById("explorer-devices-bar");
  const breadcrumbs = document.getElementById("explorer-breadcrumbs");
  const upBtn = document.getElementById("explorer-up-btn");
  const searchBox = document.querySelector(".explorer-search-box");

  if (explorerState.isSplitView) {
    splitBtn?.classList.add("active");
    if (singleBody) singleBody.style.display = "none";
    if (splitContainer) splitContainer.style.display = "grid";
    if (devBar) devBar.style.display = "none";
    if (breadcrumbs) breadcrumbs.style.display = "none";
    if (upBtn) upBtn.style.display = "none";
    if (searchBox) searchBox.style.display = "none";

    setupExplorerSplitDefaults();
  } else {
    splitBtn?.classList.remove("active");
    if (singleBody) singleBody.style.display = "flex";
    if (splitContainer) splitContainer.style.display = "none";
    if (devBar) devBar.style.display = "flex";
    if (breadcrumbs) breadcrumbs.style.display = "flex";
    if (upBtn) upBtn.style.display = "inline-flex";
    if (searchBox) searchBox.style.display = "flex";
  }
}

function updateExplorerSplitSelects() {
  const leftRoot = document.getElementById("dropdown-explorer-left-device");
  const rightRoot = document.getElementById("dropdown-explorer-right-device");
  if (!leftRoot || !rightRoot) return;

  const devices = explorerState.devices || [];

  const setupDropdown = (root, currentDevId, onSelect) => {
    const trigger = root.querySelector(".dropdown-trigger");
    const label = root.querySelector(".dropdown-selected");
    const menu = root.querySelector(".dropdown-menu");
    if (!trigger || !label || !menu) return;

    const currentDev = devices.find(d => d.id === currentDevId);
    if (currentDev) {
      const icon = currentDev.id.startsWith("ftp-") ? "📱" : "💻";
      label.textContent = `${icon} ${currentDev.name}`;
      root.dataset.value = currentDev.id;
    } else {
      label.textContent = "Select storage...";
    }

    menu.innerHTML = "";
    devices.forEach((dev) => {
      const isFtp = dev.id.startsWith("ftp-");
      const icon = isFtp ? "📱" : "💻";
      const item = document.createElement("div");
      item.className = "dropdown-item" + (dev.id === currentDevId ? " selected" : "");
      item.dataset.value = dev.id;
      item.textContent = `${icon} ${dev.name}`;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        label.textContent = `${icon} ${dev.name}`;
        root.dataset.value = dev.id;
        menu.querySelectorAll(".dropdown-item").forEach(it => it.classList.toggle("selected", it === item));
        root.classList.remove("open");
        onSelect(dev.id);
      });
      menu.appendChild(item);
    });

    // Add connect FTP item option
    const addFtpItem = document.createElement("div");
    addFtpItem.className = "dropdown-item";
    addFtpItem.style.cssText = "color: var(--accent-color); font-weight: 600; border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px;";
    addFtpItem.innerHTML = `<span>+ Connect Phone FTP...</span>`;
    addFtpItem.addEventListener("click", (e) => {
      e.stopPropagation();
      root.classList.remove("open");
      openFtpModal();
    });
    menu.appendChild(addFtpItem);
  };

  setupDropdown(leftRoot, explorerState.splitLeft.deviceId, (devId) => {
    const dev = explorerState.devices.find(d => d.id === devId);
    explorerState.splitLeft.deviceId = devId;
    explorerState.splitLeft.historyStack = [];
    explorerState.splitLeft.selectedPaths.clear();
    const p = explorerState.devicePaths[devId] || dev?.rootPath || "";
    loadSplitPaneDirectory("left", devId, p);
  });

  setupDropdown(rightRoot, explorerState.splitRight.deviceId, (devId) => {
    const dev = explorerState.devices.find(d => d.id === devId);
    explorerState.splitRight.deviceId = devId;
    explorerState.splitRight.historyStack = [];
    explorerState.splitRight.selectedPaths.clear();
    const p = explorerState.devicePaths[devId] || dev?.rootPath || "";
    loadSplitPaneDirectory("right", devId, p);
  });
}

function setupExplorerSplitDefaults() {
  const devices = explorerState.devices || [];
  const pcDev = devices.find(d => !d.id.startsWith("ftp-")) || devices[0];
  const ftpDev = devices.find(d => d.id.startsWith("ftp-")) || devices[1] || devices[0];

  if (!explorerState.splitLeft.deviceId && pcDev) {
    explorerState.splitLeft.deviceId = pcDev.id;
    explorerState.splitLeft.currentPath = explorerState.devicePaths[pcDev.id] || pcDev.rootPath || "";
  }
  if (!explorerState.splitRight.deviceId && ftpDev) {
    explorerState.splitRight.deviceId = ftpDev.id;
    explorerState.splitRight.currentPath = explorerState.devicePaths[ftpDev.id] || ftpDev.rootPath || "";
  }

  updateExplorerSplitSelects();
  if (explorerState.splitLeft.deviceId) {
    loadSplitPaneDirectory("left", explorerState.splitLeft.deviceId, explorerState.splitLeft.currentPath);
  }
  if (explorerState.splitRight.deviceId) {
    loadSplitPaneDirectory("right", explorerState.splitRight.deviceId, explorerState.splitRight.currentPath);
  }
}

function initExplorerSplitControls() {
  const leftDropdown = document.getElementById("dropdown-explorer-left-device");
  const rightDropdown = document.getElementById("dropdown-explorer-right-device");

  const bindTrigger = (root) => {
    if (!root) return;
    const trigger = root.querySelector(".dropdown-trigger");
    trigger?.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".custom-dropdown.open").forEach((d) => {
        if (d !== root) d.classList.remove("open");
      });
      root.classList.toggle("open");
    });
  };

  bindTrigger(leftDropdown);
  bindTrigger(rightDropdown);

  const leftUp = document.getElementById("explorer-left-up-btn");
  const rightUp = document.getElementById("explorer-right-up-btn");
  const leftRefresh = document.getElementById("explorer-left-refresh-btn");
  const rightRefresh = document.getElementById("explorer-right-refresh-btn");
  const btnTransferRight = document.getElementById("explorer-split-transfer-right");
  const btnTransferLeft = document.getElementById("explorer-split-transfer-left");

  leftUp?.addEventListener("click", () => navigateSplitPaneUp("left"));
  rightUp?.addEventListener("click", () => navigateSplitPaneUp("right"));

  leftRefresh?.addEventListener("click", () => {
    if (explorerState.splitLeft.deviceId) {
      loadSplitPaneDirectory("left", explorerState.splitLeft.deviceId, explorerState.splitLeft.currentPath);
    }
  });

  rightRefresh?.addEventListener("click", () => {
    if (explorerState.splitRight.deviceId) {
      loadSplitPaneDirectory("right", explorerState.splitRight.deviceId, explorerState.splitRight.currentPath);
    }
  });

  btnTransferRight?.addEventListener("click", () => {
    executeSplitTransfer("left", "right");
  });

  btnTransferLeft?.addEventListener("click", () => {
    executeSplitTransfer("right", "left");
  });

  setupSplitPaneDragDrop("left");
  setupSplitPaneDragDrop("right");

  // Search / filter
  ["left", "right"].forEach(side => {
    const input = document.getElementById(`explorer-${side}-search`);
    const paneState = side === "left" ? explorerState.splitLeft : explorerState.splitRight;
    input?.addEventListener("input", () => {
      paneState.searchQuery = input.value.toLowerCase().trim();
      renderSplitPaneList(side);
    });
  });
}

function navigateSplitPaneUp(side) {
  const paneState = side === "left" ? explorerState.splitLeft : explorerState.splitRight;
  if (paneState.historyStack.length > 0) {
    const prev = paneState.historyStack.pop();
    loadSplitPaneDirectory(side, paneState.deviceId, prev);
    return;
  }
  const curr = paneState.currentPath;
  const parent = curr.replace(/[/\\][^/\\]+[/\\]?$/, "");
  if (parent && parent !== curr) {
    loadSplitPaneDirectory(side, paneState.deviceId, parent);
  }
}

async function loadSplitPaneDirectory(side, deviceId, dirPath) {
  const paneState = side === "left" ? explorerState.splitLeft : explorerState.splitRight;
  const listEl = document.getElementById(`explorer-${side}-list`);
  const pathBar = document.getElementById(`explorer-${side}-path-bar`);

  if (listEl) {
    listEl.innerHTML = Array.from({ length: 4 })
      .map(() => `
        <div class="skeleton-row" style="padding: 8px 12px;">
          <div class="skeleton-shimmer" style="width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0;"></div>
          <div class="skeleton-shimmer" style="width: 50%; height: 14px;"></div>
          <div style="flex:1;"></div>
          <div class="skeleton-shimmer" style="width: 50px; height: 12px;"></div>
        </div>
      `).join("");
  }

  try {
    const res = await window.lanbeam.explorer.listDirectory({ deviceId, path: dirPath });
    paneState.deviceId = deviceId;
    paneState.currentPath = res.currentPath;
    paneState.items = res.items || [];
    explorerState.devicePaths[deviceId] = res.currentPath;

    if (pathBar) {
      const fullPath = res.currentPath || "/";
      const isFtp = deviceId && deviceId.startsWith("ftp-");
      const sep = isFtp ? "/" : (fullPath.includes("\\") ? "\\" : "/");
      // For Windows: parts = ["C:", "Users", "user"] — skip [0] since it's the drive root crumb
      const allParts = fullPath.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
      const drivePart = !isFtp && allParts.length ? allParts[0] : null; // e.g. "C:"
      const parts = isFtp ? allParts : allParts.slice(1); // skip drive from segment list

      pathBar.innerHTML = "";

      // Root crumb
      const rootCrumb = document.createElement("span");
      rootCrumb.className = "path-crumb";
      rootCrumb.textContent = isFtp ? "/" : (drivePart || sep);
      const rootTarget = isFtp ? "/" : (drivePart ? drivePart + sep : sep);
      rootCrumb.addEventListener("click", () => {
        paneState.historyStack.push(paneState.currentPath);
        loadSplitPaneDirectory(side, deviceId, rootTarget);
      });
      pathBar.appendChild(rootCrumb);

      // Segment crumbs
      parts.forEach((part, idx) => {
        const isLast = idx === parts.length - 1;
        const sepEl = document.createElement("span");
        sepEl.className = "path-crumb-sep";
        sepEl.textContent = isFtp ? "/" : "\\";
        pathBar.appendChild(sepEl);

        const crumb = document.createElement("span");
        crumb.className = "path-crumb" + (isLast ? " active" : "");
        crumb.textContent = part;
        if (!isLast) {
          const targetPath = isFtp
            ? "/" + parts.slice(0, idx + 1).join("/")
            : drivePart + sep + parts.slice(0, idx + 1).join(sep);
          crumb.addEventListener("click", () => {
            paneState.historyStack.push(paneState.currentPath);
            loadSplitPaneDirectory(side, deviceId, targetPath);
          });
        }
        pathBar.appendChild(crumb);
      });
    }

    // Clear search on navigation
    paneState.searchQuery = "";
    const searchInput = document.getElementById(`explorer-${side}-search`);
    if (searchInput) searchInput.value = "";

    renderSplitPaneList(side);
  } catch (err) {
    if (listEl) {
      const isFtp = deviceId && deviceId.startsWith("ftp-");
      const reconnectHtml = isFtp
        ? `<button type="button" class="explorer-reconnect-btn" id="explorer-${side}-reconnect-btn">
             <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
             <span>Reconnect FTP</span>
           </button>`
        : '';
      listEl.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--danger-color, #ef4444); font-size: 12.5px; display: flex; flex-direction: column; align-items: center; justify-content: center;">
          <div style="font-weight: 600; margin-bottom: 4px;">Connection Error</div>
          <div style="color: var(--text-muted); font-size: 12px; max-width: 280px; word-break: break-word;">${escapeHtml(err.message || "Failed to load directory")}</div>
          ${reconnectHtml}
        </div>
      `;
      if (isFtp) {
        listEl.querySelector(`#explorer-${side}-reconnect-btn`)?.addEventListener("click", () => {
          loadSplitPaneDirectory(side, deviceId, dirPath);
        });
      }
    }
  }
}

function renderSplitPaneList(side) {
  const paneState = side === "left" ? explorerState.splitLeft : explorerState.splitRight;
  const listEl = document.getElementById(`explorer-${side}-list`);
  if (!listEl) return;
  listEl.innerHTML = "";

  const items = paneState.items;
  if (!items || items.length === 0) {
    listEl.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px;">Empty folder</div>';
    return;
  }

  const q = paneState.searchQuery || "";
  const filtered = q ? items.filter(it => it.name.toLowerCase().includes(q)) : items;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px;">No matches</div>';
    return;
  }

  filtered.forEach((item) => {
    const row = document.createElement("div");
    row.className = "explorer-row";
    row.draggable = true;
    row.setAttribute("data-item-path", item.path);

    const isSelected = paneState.selectedPaths.has(item.path);
    if (isSelected) row.classList.add("selected");

    const iconSvg = item.isDirectory
      ? '<span class="item-icon folder"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>'
      : '<span class="item-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></span>';

    const checkSvg = `<span class="explorer-row-checkbox" data-tip="Select"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,8 6,12 14,4"/></svg></span>`;
    const sizeText = item.isDirectory ? "--" : formatBytes(item.size);

    row.innerHTML = `
      <span class="col-check">${checkSvg}</span>
      <span class="col-name" style="font-size: 12.5px;">${iconSvg} <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.name)}</span></span>
      <span class="col-size" style="width: 70px; font-size: 11px;">${sizeText}</span>
    `;

    // Click: folders navigate in, files toggle selection
    row.addEventListener("click", (e) => {
      if (e.target.closest(".explorer-row-checkbox")) return; // handled below
      if (item.isDirectory) {
        paneState.historyStack.push(paneState.currentPath);
        loadSplitPaneDirectory(side, paneState.deviceId, item.path);
      } else {
        if (paneState.selectedPaths.has(item.path)) {
          paneState.selectedPaths.delete(item.path);
          row.classList.remove("selected");
        } else {
          paneState.selectedPaths.add(item.path);
          row.classList.add("selected");
        }
      }
    });

    // Checkbox: always toggle selection regardless of type
    const cb = row.querySelector(".explorer-row-checkbox");
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (paneState.selectedPaths.has(item.path)) {
        paneState.selectedPaths.delete(item.path);
        row.classList.remove("selected");
      } else {
        paneState.selectedPaths.add(item.path);
        row.classList.add("selected");
      }
    });

    // Drag start
    row.addEventListener("dragstart", (e) => {
      const draggedItems = paneState.selectedPaths.has(item.path)
        ? items.filter(it => paneState.selectedPaths.has(it.path))
        : [item];

      e.dataTransfer.setData("application/json", JSON.stringify({
        sourceSide: side,
        sourceDeviceId: paneState.deviceId,
        items: draggedItems,
      }));
      e.dataTransfer.effectAllowed = "copy";
    });

    listEl.appendChild(row);
  });
}

function setupSplitPaneDragDrop(side) {
  const paneEl = document.getElementById(`explorer-pane-${side}`);
  if (!paneEl) return;

  paneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    paneEl.classList.add("drag-over");
  });

  paneEl.addEventListener("dragleave", (e) => {
    if (!paneEl.contains(e.relatedTarget)) {
      paneEl.classList.remove("drag-over");
    }
  });

  paneEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    paneEl.classList.remove("drag-over");

    try {
      const dataStr = e.dataTransfer.getData("application/json");
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (!data.items || data.items.length === 0) return;
      if (data.sourceSide === side && data.sourceDeviceId === (side === "left" ? explorerState.splitLeft.deviceId : explorerState.splitRight.deviceId)) {
        return;
      }

      const targetPane = side === "left" ? explorerState.splitLeft : explorerState.splitRight;
      const targetDir = targetPane.currentPath || (targetPane.deviceId?.startsWith("ftp-") ? "/" : "C:\\");

      await runSplitTransferBatch(data.items, data.sourceDeviceId, targetPane.deviceId, targetDir, side);
    } catch (err) {
      console.error("[Split Explorer] Drag drop failed:", err);
      toast(err.message || "Drop failed");
    }
  });
}

async function executeSplitTransfer(fromSide, toSide) {
  const fromPane = fromSide === "left" ? explorerState.splitLeft : explorerState.splitRight;
  const toPane = toSide === "left" ? explorerState.splitLeft : explorerState.splitRight;

  const selectedItems = fromPane.items.filter(it => fromPane.selectedPaths.has(it.path));
  if (selectedItems.length === 0) {
    toast(`Please select files in the ${fromSide} pane first.`);
    return;
  }

  const targetDir = toPane.currentPath || (toPane.deviceId?.startsWith("ftp-") ? "/" : "C:\\");
  await runSplitTransferBatch(selectedItems, fromPane.deviceId, toPane.deviceId, targetDir, toSide);
}

async function runSplitTransferBatch(items, sourceDeviceId, targetDeviceId, targetDir, destSide) {
  const isOut = !sourceDeviceId.startsWith("ftp-");
  const targetDev = explorerState.devices.find(d => d.id === targetDeviceId);
  const peerName = targetDev?.name || (isOut ? "Phone Storage" : "PC Storage");

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const tid = "split-xfer-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    updateTransferCard(
      {
        fileId: tid,
        fileName: items.length > 1 ? `[${i + 1}/${items.length}] ${it.name}` : it.name,
        totalBytes: it.isDirectory ? 0 : (it.size || 0),
        bytesTransferred: 0,
        peerName: peerName,
        throughputMbps: 0,
        etaMs: 0,
        sparkline: [],
      },
      isOut ? "out" : "in",
    );

    try {
      await window.lanbeam.explorer.transfer({
        transferId: tid,
        sourcePath: it.path,
        targetDir: targetDir,
        sourceDeviceId: sourceDeviceId,
        targetDeviceId: targetDeviceId,
        totalBytes: it.isDirectory ? 0 : (it.size || 0),
      });
    } catch (err) {
      console.error("Split transfer failed:", it.name, err);
      failTransferCard(err.message || "Transfer error", tid);
    }
  }

  toast(`Transferred ${items.length} item(s) successfully!`);

  // Clear selections on both panes after transfer
  explorerState.splitLeft.selectedPaths.clear();
  explorerState.splitRight.selectedPaths.clear();
  renderSplitPaneList("left");
  renderSplitPaneList("right");

  loadSplitPaneDirectory(destSide, targetDeviceId, targetDir);
}

// ── Global data-tip tooltip (body-level, never clipped) ──────────────────
(function () {
  const tip = document.createElement('div');
  tip.id = 'ui-tooltip';
  document.body.appendChild(tip);

  let autoHide = null;

  function showTip(el) {
    clearTimeout(autoHide);
    const text = el.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    const rect = el.getBoundingClientRect();
    tip.classList.remove('visible');
    
    // Position tooltip: if element is in the left sidebar, show to the right side of the element
    if (rect.left < 80) {
      tip.style.left = (rect.right + 10) + 'px';
      tip.style.top = (rect.top + rect.height / 2) + 'px';
      tip.style.transform = 'translateY(-50%) translateX(2px)';
      requestAnimationFrame(() => {
        tip.style.transform = 'translateY(-50%) translateX(0)';
        tip.classList.add('visible');
      });
    } else {
      // Top tooltip centered over target
      let targetLeft = rect.left + rect.width / 2;
      tip.style.left = Math.max(10, targetLeft) + 'px';
      tip.style.top = (rect.top - 32) + 'px';
      tip.style.transform = 'translateX(-50%) translateY(2px)';
      requestAnimationFrame(() => {
        tip.style.transform = 'translateX(-50%) translateY(0)';
        tip.classList.add('visible');
      });
    }
    autoHide = setTimeout(hideTip, 3000);
  }

  function hideTip() {
    clearTimeout(autoHide);
    tip.classList.remove('visible');
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el); else hideTip();
  }, true);

  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) hideTip();
  }, true);

  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('mousedown', hideTip, true);
})();



// ============================================================================
// Cloud Sync Controller (PikPak <-> GDrive <-> Local via Rclone)
// ============================================================================
let _cloudState = {
  profile: null,
  sourceRemote: "PIKKY",
  sourcePath: "",
  sourceFiles: [],
  sourceSelected: new Set(),
  destRemote: "GDRIVE",
  destPath: "",
  destFiles: [],
  currentJobId: null
};

async function bindCloudSync() {
  const root = _panes["cloudsync"];
  if (!root) return;

  // Listen to live transfer updates from main process
  window.lanbeam.cloud?.onTransferProgress((status) => {
    _renderCloudProgress(status);
  });

  // Modal open/close
  root.querySelector("#cloud-btn-profiles")?.addEventListener("click", () => {
    const modal = root.querySelector("#cloud-profile-modal");
    if (modal) {
      modal.style.display = "flex";
      const confArea = modal.querySelector("#cloud-conf-text");
      if (confArea && _cloudState.profile) {
        confArea.value = _cloudState.profile.rcloneConfig || "";
      }
    }
  });

  root.querySelector("#cloud-modal-close")?.addEventListener("click", () => {
    const modal = root.querySelector("#cloud-profile-modal");
    if (modal) modal.style.display = "none";
  });

  // Upload rclone.conf file
  root.querySelector("#cloud-conf-file-input")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result;
      const confArea = root.querySelector("#cloud-conf-text");
      if (confArea && typeof content === "string") {
        confArea.value = content;
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  root.querySelector("#cloud-conf-save-btn")?.addEventListener("click", async () => {
    const val = root.querySelector("#cloud-conf-text")?.value || "";
    const p = _cloudState.profile || { id: "default", name: "Default" };
    p.rcloneConfig = val;
    await window.lanbeam.cloud.saveProfile(p);
    _cloudState.profile = p;
    const modal = root.querySelector("#cloud-profile-modal");
    if (modal) modal.style.display = "none";
    refreshCloudSync();
  });

  // Source controls
  initCustomDropdown("dropdown-cloud-source-remote", (val) => {
    _cloudState.sourceRemote = val;
    _cloudState.sourcePath = "";
    const pathInput = root.querySelector("#cloud-source-path");
    if (pathInput) pathInput.value = "";
    _loadCloudSourceFiles();
  });

  root.querySelector("#cloud-source-refresh")?.addEventListener("click", () => _loadCloudSourceFiles());
  root.querySelector("#cloud-source-up")?.addEventListener("click", () => {
    if (!_cloudState.sourcePath) return;
    const parts = _cloudState.sourcePath.replace(/\\/g, "/").split("/").filter(Boolean);
    parts.pop();
    _cloudState.sourcePath = parts.join("/");
    const input = root.querySelector("#cloud-source-path");
    if (input) input.value = _cloudState.sourcePath;
    _loadCloudSourceFiles();
  });

  root.querySelector("#cloud-source-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      _cloudState.sourcePath = e.target.value.trim();
      _loadCloudSourceFiles();
    }
  });

  // Destination controls
  initCustomDropdown("dropdown-cloud-dest-remote", (val) => {
    _cloudState.destRemote = val;
    _cloudState.destPath = "";
    const pathInput = root.querySelector("#cloud-dest-path");
    if (pathInput) pathInput.value = "";
    _loadCloudDestFiles();
  });

  root.querySelector("#cloud-dest-refresh")?.addEventListener("click", () => _loadCloudDestFiles());
  root.querySelector("#cloud-dest-up")?.addEventListener("click", () => {
    if (!_cloudState.destPath) return;
    const parts = _cloudState.destPath.replace(/\\/g, "/").split("/").filter(Boolean);
    parts.pop();
    _cloudState.destPath = parts.join("/");
    const input = root.querySelector("#cloud-dest-path");
    if (input) input.value = _cloudState.destPath;
    _loadCloudDestFiles();
  });

  root.querySelector("#cloud-dest-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      _cloudState.destPath = e.target.value.trim();
      _loadCloudDestFiles();
    }
  });

  // Start Transfer
  root.querySelector("#cloud-start-btn")?.addEventListener("click", async () => {
    if (!_cloudState.profile) {
      alert("Please configure remotes first!");
      return;
    }
    const selected = Array.from(_cloudState.sourceSelected);
    try {
      const jobId = await window.lanbeam.cloud.startTransfer({
        profileId: _cloudState.profile.id,
        sourceRemote: _cloudState.sourceRemote,
        sourceSubPath: _cloudState.sourcePath,
        destRemote: _cloudState.destRemote,
        destSubPath: _cloudState.destPath,
        selectedItems: selected
      });
      _cloudState.currentJobId = jobId;
      const jobCard = root.querySelector("#cloud-job-card");
      if (jobCard) jobCard.style.display = "block";
      const desc = root.querySelector("#cloud-job-desc");
      if (desc) {
        if (selected.length === 1) {
          desc.textContent = `${selected[0]} -> ${_cloudState.destRemote}:${_cloudState.destPath || '/'}`;
        } else if (selected.length > 1) {
          desc.textContent = `${selected.length} items -> ${_cloudState.destRemote}:${_cloudState.destPath || '/'}`;
        } else {
          desc.textContent = `All items -> ${_cloudState.destRemote}:${_cloudState.destPath || '/'}`;
        }
      }
    } catch (err) {
      alert("Transfer launch error: " + err.message);
    }
  });

  // Cancel Transfer
  root.querySelector("#cloud-cancel-btn")?.addEventListener("click", async () => {
    if (_cloudState.currentJobId) {
      await window.lanbeam.cloud.cancelTransfer(_cloudState.currentJobId);
    }
  });

  refreshCloudSync();
}

async function refreshCloudSync() {
  const root = _panes["cloudsync"];
  if (!root || !window.lanbeam.cloud) return;
  const profiles = await window.lanbeam.cloud.listProfiles();
  if (profiles && profiles.length > 0) {
    _cloudState.profile = profiles[0];
  } else {
    _cloudState.profile = { id: "default", name: "Default", rcloneConfig: "" };
  }
  _loadCloudSourceFiles();
  _loadCloudDestFiles();
}

async function _loadCloudSourceFiles() {
  const root = _panes["cloudsync"];
  if (!root || !_cloudState.profile) return;
  const listEl = root.querySelector("#cloud-source-files");
  if (!listEl) return;
  listEl.innerHTML = '<div class="cloud-empty">Fetching directory...</div>';

  try {
    const items = await window.lanbeam.cloud.listRemoteFiles({
      profileId: _cloudState.profile.id,
      remote: _cloudState.sourceRemote,
      subPath: _cloudState.sourcePath
    });
    _cloudState.sourceFiles = items;
    _cloudState.sourceSelected.clear();
    _renderCloudFiles(listEl, items, true);
  } catch (err) {
    const isAuth = err.message && (err.message.includes("unauthenticated") || err.message.includes("please re-login") || err.message.includes("invalid_grant"));
    listEl.innerHTML = `
      <div class="cloud-empty" style="color:var(--text-muted); padding: 18px 12px;">
        <div style="font-size:24px; margin-bottom:8px;">${isAuth ? "🔑" : "⚠️"}</div>
        <div style="color:#fff; font-weight:600; margin-bottom:4px;">${isAuth ? "Remote Authentication Needed" : "Unable to list files"}</div>
        <div style="font-size:11px; margin-bottom:12px; color:var(--text-muted);">${escapeHtml(err.message)}</div>
        ${isAuth ? '<button class="cloud-btn-subtle" id="cloud-err-reauth-btn">Configure Remotes</button>' : ''}
      </div>`;
    listEl.querySelector("#cloud-err-reauth-btn")?.addEventListener("click", () => {
      const modal = root.querySelector("#cloud-profile-modal");
      if (modal) modal.style.display = "flex";
    });
  }
}

async function _loadCloudDestFiles() {
  const root = _panes["cloudsync"];
  if (!root || !_cloudState.profile) return;
  const listEl = root.querySelector("#cloud-dest-files");
  if (!listEl) return;
  listEl.innerHTML = '<div class="cloud-empty">Fetching directory...</div>';

  try {
    const items = await window.lanbeam.cloud.listRemoteFiles({
      profileId: _cloudState.profile.id,
      remote: _cloudState.destRemote,
      subPath: _cloudState.destPath
    });
    _cloudState.destFiles = items;
    _renderCloudFiles(listEl, items, false);
  } catch (err) {
    const isAuth = err.message && (err.message.includes("unauthenticated") || err.message.includes("please re-login") || err.message.includes("invalid_grant"));
    listEl.innerHTML = `
      <div class="cloud-empty" style="color:var(--text-muted); padding: 18px 12px;">
        <div style="font-size:24px; margin-bottom:8px;">${isAuth ? "🔑" : "⚠️"}</div>
        <div style="color:#fff; font-weight:600; margin-bottom:4px;">${isAuth ? "Remote Authentication Needed" : "Unable to list destination"}</div>
        <div style="font-size:11px; margin-bottom:12px; color:var(--text-muted);">${escapeHtml(err.message)}</div>
        ${isAuth ? '<button class="cloud-btn-subtle" id="cloud-err-dest-reauth-btn">Configure Remotes</button>' : ''}
      </div>`;
    listEl.querySelector("#cloud-err-dest-reauth-btn")?.addEventListener("click", () => {
      const modal = root.querySelector("#cloud-profile-modal");
      if (modal) modal.style.display = "flex";
    });
  }
}

function _renderCloudFiles(container, items, isSource) {
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="cloud-empty">Folder is empty</div>';
    return;
  }
  container.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "cloud-file-row";

    const icon = item.IsDir
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';

    const sizeStr = item.IsDir ? "DIR" : _formatCloudBytes(item.Size || 0);

    const checkboxHtml = isSource ? `
      <div class="cloud-item-check" data-tip="Select to beam">
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><polyline points="2 6 5 9 10 3"/></svg>
      </div>` : "";

    row.innerHTML = `
      ${checkboxHtml}
      ${icon}
      <span class="cloud-file-name" data-tip="${escapeHtml(item.Name)}">${escapeHtml(item.Name)}</span>
      <span class="cloud-file-size">${sizeStr}</span>
    `;

    // Checkbox click selects/deselects item
    const checkEl = row.querySelector(".cloud-item-check");
    if (checkEl) {
      checkEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (_cloudState.sourceSelected.has(item.Name)) {
          _cloudState.sourceSelected.delete(item.Name);
          row.classList.remove("selected");
        } else {
          _cloudState.sourceSelected.add(item.Name);
          row.classList.add("selected");
        }
      });
    }

    row.addEventListener("click", () => {
      if (item.IsDir) {
        if (isSource) {
          _cloudState.sourcePath = _cloudState.sourcePath ? `${_cloudState.sourcePath}/${item.Name}` : item.Name;
          const input = _panes["cloudsync"]?.querySelector("#cloud-source-path");
          if (input) input.value = _cloudState.sourcePath;
          _loadCloudSourceFiles();
        } else {
          _cloudState.destPath = _cloudState.destPath ? `${_cloudState.destPath}/${item.Name}` : item.Name;
          const input = _panes["cloudsync"]?.querySelector("#cloud-dest-path");
          if (input) input.value = _cloudState.destPath;
          _loadCloudDestFiles();
        }
      } else if (isSource) {
        if (_cloudState.sourceSelected.has(item.Name)) {
          _cloudState.sourceSelected.delete(item.Name);
          row.classList.remove("selected");
        } else {
          _cloudState.sourceSelected.add(item.Name);
          row.classList.add("selected");
        }
      }
    });

    container.appendChild(row);
  }
}

function _renderCloudProgress(status) {
  const root = _panes["cloudsync"];
  if (!root) return;
  const card = root.querySelector("#cloud-job-card");
  if (!card) return;

  if (status.status === "completed") {
    // Brief flash of 100% then auto-dismiss
    const bar = root.querySelector("#cloud-progress-bar");
    if (bar) bar.style.width = "100%";
    const stText = root.querySelector("#cloud-job-status-text");
    if (stText) stText.textContent = "COMPLETED";
    const logEl = root.querySelector("#cloud-live-log");
    if (logEl) {
      logEl.textContent = status.logs?.[status.logs.length - 1] || "✓ Done";
      logEl.style.color = "var(--accent-color, #a855f7)";
    }
    card.style.display = "block";
    setTimeout(() => {
      card.style.display = "none";
      // Uncheck all selected source files
      _cloudState.sourceSelected.clear();
      _cloudState.currentJobId = null;
      root.querySelectorAll(".cloud-item-check").forEach((cb) => {
        cb.checked = false;
      });
      root.querySelectorAll(".cloud-file-row.selected").forEach((row) => {
        row.classList.remove("selected");
      });
    }, 2000);
    return;
  }

  card.style.display = "block";
  const stText = root.querySelector("#cloud-job-status-text");
  if (stText) stText.textContent = status.status.toUpperCase();

  const bar = root.querySelector("#cloud-progress-bar");
  if (bar) bar.style.width = `${status.stats.progressPct || 0}%`;

  const trans = root.querySelector("#cloud-stat-transferred");
  if (trans) trans.textContent = status.stats.transferred || "0 B";

  const tot = root.querySelector("#cloud-stat-total");
  if (tot) tot.textContent = status.stats.total || "0 B";

  const spd = root.querySelector("#cloud-stat-speed");
  if (spd) spd.textContent = status.stats.speed || "0 B/s";

  const eta = root.querySelector("#cloud-stat-eta");
  if (eta) eta.textContent = status.stats.eta || "—";

  const logEl = root.querySelector("#cloud-live-log");
  if (logEl) {
    if (status.error) {
      logEl.textContent = `Error: ${status.error}`;
      logEl.style.color = "var(--danger-color, #ef4444)";
    } else if (status.logs && status.logs.length > 0) {
      logEl.textContent = status.logs[status.logs.length - 1];
      logEl.style.color = "var(--text-muted)";
    }
  }
}

function _formatCloudBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
