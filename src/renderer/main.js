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
  settings: () => bindSettings(),
};
const _viewRefresh = {
  home: () => {
    if (state.qr) renderQr();
    renderDevices();
  },
  devices: () => renderDevicesView(),
  history: () => renderHistory(),
  settings: () => {},
};
let _prewarmScheduled = false;
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
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 150));
    idle(() => {
      for (const v of ["devices", "history", "settings"]) {
        if (v === "settings" && !state.settings) continue; // binds from loaded settings
        try {
          _mountView(v);
        } catch (err) {
          console.error("[lanbeam] prewarm failed:", v, err);
        }
      }
    });
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
      if (input.files?.length) onFilesPicked(Array.from(input.files));
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
  if (img && state.qr) img.src = state.qr.png;
  const urlInput = document.getElementById("qr-url-text");
  if (urlInput && state.qr) urlInput.value = state.qr.url;
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
      <div class="qr-lightbox-url" title="${escapeHtml(state.qr.url)}">${escapeHtml(state.qr.url)}</div>
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

function applyFont(choice) {
  const fontMap = {
    figtree: "var(--font-figtree)",
    outfit: "var(--font-outfit)",
    system: "var(--font-system)",
  };
  const fontVal = fontMap[choice] || fontMap.figtree;
  document.documentElement.style.setProperty("--font-sans", fontVal);
  if (state.settings) {
    state.settings.fontChoice = choice;
    window.lanbeam?.settings?.update?.({ fontChoice: choice });
  }
}

function renderDevices() {
  const host = document.getElementById("device-cards");
  if (!host) return;
  const ONLINE_MS = 30 * 1000; // 30s = online
  const now = Date.now();

  const activeTransferPeer = state.currentTransferId
    ? (state.currentTransfer?.peerName ?? null)
    : null;

  const rawActive = state.pairedDevices
    .filter((d) => {
      if (now - d.lastSeen < ONLINE_MS) return true;
      if (activeTransferPeer && d.name === activeTransferPeer) return true;
      return false;
    })
    .sort((a, b) => b.lastSeen - a.lastSeen);

  // Deduplicate by name and IP to ensure only 1 card per physical device
  const seenKeys = new Set();
  const activeDevices = rawActive.filter((d) => {
    const key = (d.name || "") + "::" + (d.ip || d.deviceId);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
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

async function onFilesPicked(files, targetDevice) {
  const ONLINE_MS = 30 * 1000;
  const now = Date.now();
  let peer = targetDevice;
  if (!peer) {
    const onlinePeers = state.pairedDevices.filter(
      (d) => now - d.lastSeen < ONLINE_MS,
    );
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

  // Send all selected files sequentially / queue
  for (const file of files) {
    const fp = file.path || file.name;
    const name =
      file.name || (typeof fp === "string" ? fp.split(/[\\/]/).pop() : "file");
    // Optimistic UI: show the transfer card instantly, before IPC returns.
    updateTransferCard(
      {
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
    try {
      await window.lanbeam.transfer.send({
        filePath: fp,
        fileName: name,
        peerHost: peer.ip || peer.host || "127.0.0.1",
        peerPort: peer.port || 0,
        transport: "http",
        peerName: peer.name,
        targetDeviceId: peer.deviceId,
      });
    } catch (err) {
      console.error("Failed to send file:", name, err);
      failTransferCard(err && err.message ? err.message : "send failed");
    }
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
  return `<button class="dm-copy" data-dm-copy="${escapeHtml(text)}" title="${escapeHtml(title || "Copy")}">${DEVICE_MODAL_ICONS.copy}</button>`;
}

function showDeviceModal(deviceId) {
  const d = state.pairedDevices.find((x) => x.deviceId === deviceId);
  if (!d) return;
  const online = Date.now() - d.lastSeen < 30 * 1000;
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
  if (host) {
    if (!state.pairedDevices.length) {
      host.innerHTML = `<div class="empty-hint">No paired devices yet.</div>`;
    } else {
      host.innerHTML = state.pairedDevices
        .map((d) => deviceCardHtml(d, Date.now() - d.lastSeen < 5 * 60 * 1000))
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
  const integrityOk = h.integrityOk === true;
  const direction = h.direction === "out" ? "out" : "in";
  const peerName = h.peerName || "Unknown device";
  const html = `
      <div class="history-row" data-history-target="${escapeHtml(target)}" data-history-direction="${direction}" tabindex="0" role="button" aria-label="Open ${escapeHtml(h.fileName)}">
        <div class="h-name">
          <span class="h-name-text">${escapeHtml(h.fileName)}</span>
          <span class="h-name-sub">· ${directionLabel(direction)} · ${escapeHtml(peerName)}</span>
        </div>
        <div class="h-speed">${avg.value} ${avg.unit}</div>
        <div class="${integrityOk ? "h-integrity-ok" : "h-integrity-bad"}">${integrityOk ? "✓ Verified" : "✗ Failed"}</div>
        <div class="h-time">${completedAt}</div>
        <div class="h-actions">
          <button class="h-action-btn" data-history-action="open" title="Open file" aria-label="Open file">${_OPEN_ICON}</button>
          <button class="h-action-btn" data-history-action="folder" title="Show in folder" aria-label="Show in folder">${_FOLDER_ICON}</button>
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
function bindSettings() {
  const chunk = document.getElementById("setting-chunk");
  const chunkVal = document.getElementById("setting-chunk-val");
  const streams = document.getElementById("setting-streams");
  const streamsVal = document.getElementById("setting-streams-val");
  const warn = document.getElementById("setting-warn");
  const historyToggle = document.getElementById("setting-history");
  if (state.settings) {
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

  // Settings swatches sync
  const settingsSwatches = document.querySelectorAll(
    "#settings-swatches .swatch",
  );
  settingsSwatches.forEach((sw) => {
    sw.addEventListener("click", () =>
      applyAccent(sw.dataset.color || "#00E5FF", settingsSwatches),
    );
    if (
      state.settings?.accentColor &&
      sw.dataset.color === state.settings.accentColor
    ) {
      sw.classList.add("active");
    } else {
      sw.classList.remove("active");
    }
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
  document.documentElement.style.setProperty("--accent-color", color);
  // Recompute soft variants from the hex. Every glow/badge/status in the app
  // derives from --accent-rgb, so switching theme re-tints the WHOLE palette
  // (no leftover cyan/green glows from the old hardcoded shadows).
  const rgb = hexToRgb(color);
  if (rgb) {
    document.documentElement.style.setProperty(
      "--accent-rgb",
      `${rgb.r}, ${rgb.g}, ${rgb.b}`,
    );
    document.documentElement.style.setProperty(
      "--accent-soft",
      `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`,
    );
    document.documentElement.style.setProperty(
      "--accent-very-soft",
      `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.06)`,
    );
  }
  swatchEls.forEach((sw) =>
    sw.classList.toggle("active", sw.dataset.color === color),
  );
  window.lanbeam?.settings?.update?.({ accentColor: color });
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
const TOAST_ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/**
 * Show a transfer-complete toast.
 * @param {object} r - The TransferComplete payload (must include the full
 *                     history-entry fields: fileName, fileSize, direction,
 *                     peerName, filePath, averageThroughputMbps, integrityOk).
 */
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
      <button class="toast-close-btn" data-toast-action="close" title="Dismiss" aria-label="Dismiss">${TOAST_ICON_CLOSE}</button>
    </div>
    <div class="toast-card-actions">
      <button class="toast-action-btn toast-action-btn-primary" data-toast-action="open" title="Open file">
        ${TOAST_ICON_OPEN}
        <span>Open</span>
      </button>
      <button class="toast-action-btn" data-toast-action="folder" title="Show in folder">
        ${TOAST_ICON_FOLDER}
        <span>Folder</span>
      </button>
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
    } else if (ev.type === "inbound:failed" || ev.type === "outbound:failed") {
      failTransferCard(ev.error);
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

function updateTransferCard(p, direction = "in") {
  updateFloatCard(p, direction);
  const section = document.getElementById("transfer-section");
  if (!section) return;
  if (hideTransferTimeout) {
    clearTimeout(hideTransferTimeout);
    hideTransferTimeout = null;
  }
  const wasHidden = section.style.display === "none" || !section.style.display;
  const prevId = section.dataset.tid;
  section.style.display = "block";
  section.dataset.direction = direction;
  if (
    wasHidden ||
    (state.currentTransferId && prevId !== state.currentTransferId)
  )
    _resetCancelBtn();
  if (
    wasHidden ||
    (state.currentTransferId && prevId !== state.currentTransferId)
  ) {
    section.dataset.tid = state.currentTransferId || "";
    requestAnimationFrame(() =>
      section.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }
  if (p.fileName) {
    const nameEl = document.getElementById("transfer-name");
    if (nameEl) nameEl.textContent = p.fileName;
  }
  const metaEl = document.getElementById("transfer-meta");
  if (metaEl) {
    const peer = p.peerName || "Remote device";
    const totalSize = p.totalBytes > 0 ? formatBytes(p.totalBytes) : "—";
    // Outbound = we are sending: "→ to <device>". Inbound: "← from <device>".
    metaEl.textContent = `${totalSize} · ${direction === "out" ? "\u2192 to" : "\u2190 from"} ${peer}`;
  }
  const pct = p.totalBytes > 0 ? (p.bytesTransferred / p.totalBytes) * 100 : 0;
  const fill = document.getElementById("progress-fill");
  if (fill) fill.style.width = `${Math.min(100, pct).toFixed(1)}%`;
  const stats = document.getElementById("progress-stats");
  if (stats)
    stats.textContent = p.stalled
      ? `${Math.min(100, pct).toFixed(0)}% · ${formatBytes(p.bytesTransferred)} / ${formatBytes(p.totalBytes)} · Paused — waiting for the phone to reconnect`
      : `${Math.min(100, pct).toFixed(0)}% · ${formatBytes(p.bytesTransferred)} / ${formatBytes(p.totalBytes)} · ETA ${formatEta(p.etaMs)}`;
  if (stats && !(p.bytesTransferred > 0))
    stats.textContent = "Preparing · waiting for first data…";
  const speedVal = document.getElementById("speed-value");
  const speedUnit = document.querySelector(".speed-unit");
  const { value, unit } = formatSpeed(p.throughputMbps);
  if (speedVal) speedVal.textContent = value;
  if (speedUnit) speedUnit.textContent = unit;
  state.spark = p.sparkline?.slice(-30) ?? [];
  renderSparkline(state.spark);
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
    <div class="ft-top">
      <div class="ft-name" id="ft-name">—</div>
      <button type="button" class="ghost-btn ft-cancel" id="float-cancel">Cancel</button>
    </div>
    <div class="ft-bar"><div class="ft-fill" id="ft-fill"></div></div>
    <div class="ft-stats" id="ft-stats">Preparing…</div>`;
  el.addEventListener("click", (e) => {
    if (e.target.closest("#float-cancel")) return;
    renderView("home");
  });
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
  if (p.fileName)
    el.querySelector("#ft-name").textContent =
      (direction === "out" ? "\u2191 " : "\u2193 ") + p.fileName;
  el.querySelector("#ft-fill").style.width = `${pct.toFixed(1)}%`;
  const sp = formatSpeed(p.throughputMbps);
  el.querySelector("#ft-stats").textContent = p.stalled
    ? `${pct.toFixed(0)}% \u00b7 Paused \u2014 waiting for phone`
    : p.bytesTransferred > 0
      ? `${pct.toFixed(0)}% \u00b7 ${sp.value} ${sp.unit} \u00b7 ETA ${formatEta(p.etaMs)}`
      : "Preparing \u00b7 waiting for first data\u2026";
  _floatShow(true);
}
function endFloatCard(text, hideMs, full) {
  const el = document.getElementById("float-transfer");
  if (!el) return;
  if (text) el.querySelector("#ft-stats").textContent = text;
  if (full) el.querySelector("#ft-fill").style.width = "100%";
  const c = el.querySelector("#float-cancel");
  if (c) c.style.display = "none";
  if (_floatHideT) clearTimeout(_floatHideT);
  _floatHideT = setTimeout(() => {
    state.floatActive = false;
    el.hidden = true;
    if (c) {
      c.style.display = "";
      c.disabled = false;
      c.textContent = "Cancel";
    }
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
  _hideCancelBtn();
  endFloatCard(
    "Complete \u00b7 " +
      formatSpeed(result.averageThroughputMbps).value +
      " " +
      formatSpeed(result.averageThroughputMbps).unit +
      " avg",
    3500,
    true,
  );
  state.currentTransferId = null;
  const avg = formatSpeed(result.averageThroughputMbps);
  const stats = document.getElementById("progress-stats");
  if (stats)
    stats.textContent = `Complete · ${avg.value} ${avg.unit} avg · integrity ${result.integrityOk ? "OK" : "FAILED"}`;
  const fill = document.getElementById("progress-fill");
  if (fill) fill.style.width = `100%`;
  const metaEl = document.getElementById("transfer-meta");
  if (metaEl) {
    const dirText = result.direction === "out" ? "Sent to" : "Received from";
    metaEl.textContent = `${formatBytes(result.fileSize)} · ${dirText} ${result.peerName || "device"}`;
  }
  if (hideTransferTimeout) clearTimeout(hideTransferTimeout);
  hideTransferTimeout = setTimeout(() => {
    const section = document.getElementById("transfer-section");
    if (section) section.style.display = "none";
  }, 3500);
}

function failTransferCard(error) {
  _hideCancelBtn();
  endFloatCard(
    error === "Cancelled"
      ? "Transfer cancelled"
      : `Transfer failed \u2014 ${error || "unknown error"}`,
    5000,
    false,
  );
  state.currentTransferId = null;
  const section = document.getElementById("transfer-section");
  if (!section) return;
  const stats = document.getElementById("progress-stats");
  if (stats)
    stats.textContent =
      error === "Cancelled"
        ? "Transfer cancelled"
        : `Transfer failed — ${error || "unknown error"}`;
  if (hideTransferTimeout) clearTimeout(hideTransferTimeout);
  hideTransferTimeout = setTimeout(() => {
    section.style.display = "none";
  }, 5000);
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
    el.addEventListener("click", () => {
      const v = el.getAttribute("data-view");
      renderView(v);
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  bindWindowControls();
  bindNav();

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
    const now = Date.now();
    const onlineNow = new Set(
      (devices || [])
        .filter((d) => d && now - (d.lastSeen || 0) < 30 * 1000)
        .map((d) => d.deviceId),
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
      applyAccent(s.settings?.accentColor || "#00E5FF", []);
      applyFont(s.settings?.fontChoice || "figtree");
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

  // Re-render device cards every 20s so online/offline status updates automatically.
  setInterval(() => {
    if (state.view === "home") renderDevices();
    if (state.view === "devices") renderDevicesView();
  }, 20000);

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
  setInterval(refreshWifi, 30000);
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
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = [
    'display:none',
    'position:fixed',
    'bottom:0',
    'left:0',
    'right:0',
    'z-index:9999',
    'background:var(--accent,#00c2a8)',
    'color:#000',
    'font-size:13px',
    'font-weight:600',
    'padding:10px 18px',
    'display:none',
    'align-items:center',
    'gap:12px',
    'box-shadow:0 -2px 16px rgba(0,0,0,.4)',
  ].join(';');

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

  const msg   = document.getElementById('update-msg');
  const pWrap = document.getElementById('update-progress-wrap');
  const pBar  = document.getElementById('update-progress-bar');
  const iBtn  = document.getElementById('update-install-btn');
  const dBtn  = document.getElementById('update-dismiss-btn');

  function showBanner() { banner.style.display = 'flex'; }
  function hideBanner() { banner.style.display = 'none'; }

  dBtn?.addEventListener('click', hideBanner);
  iBtn?.addEventListener('click', () => window.lanbeam.update.install());

  // Main emits 'update:available' when a newer release is found
  window.lanbeam.update.onAvailable((info) => {
    if (msg) msg.textContent = `🚀 LANBeam ${info.version} is available — downloading update…`;
    showBanner();
  });

  // Download progress
  window.lanbeam.update.onProgress((p) => {
    if (pWrap) pWrap.style.display = 'block';
    if (pBar)  pBar.style.width = p.percent.toFixed(1) + '%';
    const mb = (p.transferred / 1048576).toFixed(1);
    const tot = (p.total / 1048576).toFixed(1);
    if (msg) msg.textContent = `⬇ Downloading update… ${mb} / ${tot} MB`;
  });

  // Update fully downloaded — show install button
  window.lanbeam.update.onDownloaded(() => {
    if (pWrap) pWrap.style.display = 'none';
    if (msg)   msg.textContent = '✅ Update downloaded — restart to install';
    if (iBtn)  iBtn.style.display = 'inline-block';
    showBanner();
  });

  // Error — silently hide (don't panic the user over a failed update check)
  window.lanbeam.update.onError(() => hideBanner());
})();

