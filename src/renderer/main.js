/* ==========================================================================
   LANBeam desktop renderer logic.
   - Single-page view swap (Home / Devices / History / Settings) into #content.
   - Theme swatch picker updates --accent-color live across the whole app.
   - Wire-up, device list, transfer events, sparkline, benchmark.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

const state = {
  view: 'home',
  qr: null,
  pairedDevices: [],
  peers: [],
  history: [],
  settings: null,
  wifi: null,
  spark: [],
  currentTransfer: null,
};

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------
function renderView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  });
  const content = $('#content');
  if (!content) return;
  content.innerHTML = '';
  const tpl = document.getElementById(`view-${view}`);
  if (!tpl) return;
  content.appendChild(tpl.content.cloneNode(true));
  // Bind view-specific handlers
  if (view === 'home') bindHome();
  if (view === 'devices') bindDevices();
  if (view === 'history') renderHistory();
  if (view === 'settings') bindSettings();
}

// ---------------------------------------------------------------------------
// Home view
// ---------------------------------------------------------------------------
function bindHome() {
  // Drop zone handlers
  const dz = $('#dropzone');
  const input = $('#dropzone-input');
  if (dz && input) {
    dz.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files?.length) onFilesPicked(Array.from(input.files));
    });
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
    }));
    dz.addEventListener('drop', (e) => {
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
  const img = document.getElementById('qr-image');
  if (img && state.qr) img.src = state.qr.png;
  const urlInput = document.getElementById('qr-url-text');
  if (urlInput && state.qr) urlInput.value = state.qr.url;
  const copyBtn = document.getElementById('qr-copy-btn');
  if (copyBtn && state.qr) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(state.qr.url);
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = prev; }, 1500);
    };
  }
}

function applyFont(choice) {
  const fontMap = {
    figtree: 'var(--font-figtree)',
    outfit: 'var(--font-outfit)',
    system: 'var(--font-system)',
  };
  const fontVal = fontMap[choice] || fontMap.figtree;
  document.documentElement.style.setProperty('--font-sans', fontVal);
  if (state.settings) {
    state.settings.fontChoice = choice;
    window.lanbeam?.settings?.update?.({ fontChoice: choice });
  }
}

function renderDevices() {
  const host = document.getElementById('device-cards');
  if (!host) return;
  if (!state.pairedDevices.length) {
    host.innerHTML = `<div class="empty-hint">No paired devices yet. Scan the QR above with your phone.</div>`;
  } else {
    host.innerHTML = state.pairedDevices.map(d => deviceCardHtml(d, true)).join('');
  }
  const count = state.pairedDevices.filter(d => Date.now() - d.lastSeen < 5 * 60 * 1000).length;
  const counter = document.getElementById('device-count');
  if (counter) counter.textContent = `${count} device${count === 1 ? '' : 's'} online`;
}

function deviceCardHtml(d, online) {
  const tech = d.tech || ['WiFi', '6E'];
  const techStr = tech.join(' · ');
  const kindIcon = d.kind === 'phone' ? phoneIcon : d.kind === 'desktop' ? desktopIcon : phoneIcon;
  return `
    <div class="device-card" data-device-id="${d.deviceId}">
      <div class="device-icon">${kindIcon}</div>
      <div class="device-info">
        <div class="device-name">${escapeHtml(d.name)}</div>
        <div class="device-status ${online ? '' : 'offline'}">
          <span class="status-dot ${online ? 'status-dot-online' : ''}"></span>
          ${online ? 'Connected' : 'Last seen ' + timeAgo(d.lastSeen)}
        </div>
        <div class="device-tech">${wifiIcon} ${escapeHtml(techStr)}</div>
      </div>
      <div class="device-chevron">${chevronIcon}</div>
    </div>
  `;
}

function onFilesPicked(files) {
  // For v1, prompt user to pick a paired peer (or auto-pick first online device).
  const onlinePeers = state.pairedDevices;
  if (!onlinePeers.length) {
    alert('No paired devices. Scan the QR with your phone first.');
    return;
  }
  // Send the first file to the first peer — UI scaffolding for proper multi-peer picker later.
  const file = files[0];
  const peer = onlinePeers[0];
  const fp = file.path || file.name;
  window.lanbeam.transfer.send({
    filePath: fp,
    fileName: file.name,
    peerHost: peer.host || '127.0.0.1',
    peerPort: peer.port || 80,
    transport: 'http',
  });
}

// ---------------------------------------------------------------------------
// Devices view
// ---------------------------------------------------------------------------
function bindDevices() {
  renderDevicesView();
}
function renderDevicesView() {
  const host = document.getElementById('device-cards-page');
  const peerHost = document.getElementById('peer-cards-page');
  if (host) {
    if (!state.pairedDevices.length) {
      host.innerHTML = `<div class="empty-hint">No paired devices yet.</div>`;
    } else {
      host.innerHTML = state.pairedDevices.map(d => deviceCardHtml(d, Date.now() - d.lastSeen < 5 * 60 * 1000)).join('');
    }
  }
  if (peerHost) {
    if (!state.peers.length) {
      peerHost.innerHTML = `<div class="empty-hint">No other LANBeam instances discovered.</div>`;
    } else {
      peerHost.innerHTML = state.peers.map(p => `
        <div class="device-card" data-peer-id="${escapeHtml(p.deviceId)}">
          <div class="device-icon">${desktopIcon}</div>
          <div class="device-info">
            <div class="device-name">${escapeHtml(p.name)}</div>
            <div class="device-status"><span class="status-dot status-dot-online"></span>Discovered</div>
            <div class="device-tech">${wifiIcon} ${escapeHtml(p.host || 'unknown host')} : ${p.port}</div>
          </div>
          <div class="device-chevron">${chevronIcon}</div>
        </div>
      `).join('');
    }
  }
}

// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------
function renderHistory() {
  const host = document.getElementById('history-list');
  if (!host) return;
  if (!state.history.length) {
    host.innerHTML = `<div class="empty-hint">No transfers yet.</div>`;
    return;
  }
  host.innerHTML = state.history.map(h => `
    <div class="history-row">
      <div class="h-name">${escapeHtml(h.fileName)} <span style="color: var(--text-dim)">· ${directionLabel(h.direction)} · ${escapeHtml(h.peerName)}</span></div>
      <div class="h-speed">${h.averageThroughputMbps.toFixed(1)} Mbps</div>
      <div class="${h.integrityOk ? 'h-integrity-ok' : 'h-integrity-bad'}">${h.integrityOk ? '✓ Verified' : '✗ Failed'}</div>
      <div class="h-time">${new Date(h.completedAt).toLocaleString()}</div>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------
function bindSettings() {
  const chunk = document.getElementById('setting-chunk');
  const chunkVal = document.getElementById('setting-chunk-val');
  const streams = document.getElementById('setting-streams');
  const streamsVal = document.getElementById('setting-streams-val');
  const compression = document.getElementById('setting-compression');
  const fontSelect = document.getElementById('setting-font');
  const warn = document.getElementById('setting-warn');
  if (state.settings) {
    if (chunk) chunk.value = String(state.settings.chunkSizeMB);
    if (chunkVal) chunkVal.textContent = String(state.settings.chunkSizeMB);
    if (streams) streams.value = String(state.settings.maxParallelStreams);
    if (streamsVal) streamsVal.textContent = String(state.settings.maxParallelStreams);
    if (compression) compression.value = state.settings.compressionMode;
    if (fontSelect) fontSelect.value = state.settings.fontChoice || 'figtree';
    if (warn) warn.checked = !state.settings.warnOnSlowWifi;
  }
  chunk?.addEventListener('input', () => {
    if (chunkVal) chunkVal.textContent = chunk.value;
    window.lanbeam.settings.update({ chunkSizeMB: parseInt(chunk.value, 10) });
  });
  streams?.addEventListener('input', () => {
    if (streamsVal) streamsVal.textContent = streams.value;
    window.lanbeam.settings.update({ maxParallelStreams: parseInt(streams.value, 10) });
  });
  compression?.addEventListener('change', () => {
    window.lanbeam.settings.update({ compressionMode: compression.value });
  });
  fontSelect?.addEventListener('change', () => {
    applyFont(fontSelect.value);
  });
  warn?.addEventListener('change', () => {
    window.lanbeam.settings.update({ warnOnSlowWifi: warn.checked });
  });

  // Settings swatches sync
  const settingsSwatches = document.querySelectorAll('#settings-swatches .swatch');
  settingsSwatches.forEach(sw => {
    sw.addEventListener('click', () => applyAccent(sw.dataset.color || '#00E5FF', settingsSwatches));
    if (state.settings?.accentColor && sw.dataset.color === state.settings.accentColor) {
      sw.classList.add('active');
    } else {
      sw.classList.remove('active');
    }
  });

  // Benchmark
  const benchRun = document.getElementById('bench-run');
  const benchResults = document.getElementById('bench-results');
  if (benchRun && benchResults) {
    benchRun.addEventListener('click', async () => {
      benchRun.disabled = true;
      benchRun.textContent = 'Running…';
      try {
        const results = await window.lanbeam.benchmark.run();
        renderBenchResults(results);
      } catch (err) {
        benchResults.innerHTML = `<div class="bench-row">Error: ${escapeHtml(err.message)}</div>`;
      } finally {
        benchRun.disabled = false;
        benchRun.textContent = 'Run benchmark';
      }
    });
  }
}

function renderBenchResults(results) {
  const host = document.getElementById('bench-results');
  if (!host) return;
  host.innerHTML = results.map(r => `
    <div class="bench-row">
      <strong>${r.spec.label}</strong> — baseline ${r.baselineThroughputMbps.toFixed(1)} Mbps · optimized ${r.optimizedThroughputMbps.toFixed(1)} Mbps · uplift ${r.upliftPct.toFixed(1)}% · integrity ${r.integrityOk ? 'OK' : 'FAIL'} · CPU ${r.cpuUsagePct.toFixed(0)}%
    </div>
  `).join('');
}



function applyAccent(color, swatchEls) {
  document.documentElement.style.setProperty('--accent-color', color);
  // Recompute soft variants from the hex
  const rgb = hexToRgb(color);
  if (rgb) {
    document.documentElement.style.setProperty('--accent-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
    document.documentElement.style.setProperty('--accent-very-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.06)`);
  }
  swatchEls.forEach(sw => sw.classList.toggle('active', sw.dataset.color === color));
  window.lanbeam?.settings?.update?.({ accentColor: color });
}

function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// ---------------------------------------------------------------------------
// Sparkline rendering (SVG polyline + soft area fill)
// ---------------------------------------------------------------------------
function renderSparkline(values) {
  const svg = document.getElementById('sparkline');
  if (!svg) return;
  if (!values || !values.length) { svg.innerHTML = ''; return; }
  const w = 100, h = 30, pad = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = (w - pad * 2) / Math.max(1, values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (h - pad * 2) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const rgb = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#00E5FF');
  const stroke = rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : '#00E5FF';
  const fillId = 'spark-grad';
  svg.innerHTML = `
    <defs>
      <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${pad},${h - pad} ${points.join(' ')} ${w - pad},${h - pad}" fill="url(#${fillId})"/>
    <polyline points="${points.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  `;
}

// ---------------------------------------------------------------------------
// Transfer event handling
// ---------------------------------------------------------------------------
function bindTransferEvents() {
  window.lanbeam.transfer.onEvent((ev) => {
    if (ev.type === 'inbound:progress' || ev.type === 'outbound:progress') {
      updateTransferCard(ev.progress);
    } else if (ev.type === 'inbound:complete' || ev.type === 'outbound:complete') {
      finalizeTransferCard(ev.result);
      state.history = [ev.result, ...state.history];
    } else if (ev.type === 'inbound:accept-request') {
      // Show a toast/notice; v1 auto-accepts paired devices.
      console.log('[lanbeam] inbound transfer requested:', ev);
    }
  });
}

function updateTransferCard(p) {
  const section = document.getElementById('transfer-section');
  if (!section) return;
  section.style.display = 'block';
  const pct = p.totalBytes > 0 ? (p.bytesTransferred / p.totalBytes) * 100 : 0;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = `${pct.toFixed(1)}%`;
  const stats = document.getElementById('progress-stats');
  if (stats) stats.textContent = `${pct.toFixed(0)}% · ${formatBytes(p.bytesTransferred)} / ${formatBytes(p.totalBytes)} · ETA ${formatEta(p.etaMs)}`;
  const speedVal = document.getElementById('speed-value');
  const speedUnit = document.querySelector('.speed-unit');
  const { value, unit } = formatSpeed(p.throughputMbps);
  if (speedVal) speedVal.textContent = value;
  if (speedUnit) speedUnit.textContent = unit;
  state.spark = p.sparkline?.slice(-30) ?? [];
  renderSparkline(state.spark);
  state.currentTransfer = p;
}

function finalizeTransferCard(result) {
  const stats = document.getElementById('progress-stats');
  if (stats) stats.textContent = `Complete · ${result.averageThroughputMbps.toFixed(1)} Mbps avg · integrity ${result.integrityOk ? 'OK' : 'FAILED'}`;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = `100%`;
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
  if (mbps >= 1000) return { value: (mbps / 1000).toFixed(2), unit: 'Gbps' };
  if (mbps >= 1) return { value: mbps.toFixed(1), unit: 'Mbps' };
  return { value: (mbps * 1000).toFixed(0), unit: 'Kbps' };
}
function formatEta(ms) {
  if (!isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function directionLabel(d) { return d === 'in' ? '↓ Received' : '↑ Sent'; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------
const phoneIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>`;
const desktopIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
const wifiIcon = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg>`;
const chevronIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------
function bindWindowControls() {
  const closeBtn = document.getElementById('win-close');
  const minBtn = document.getElementById('win-min');
  const maxBtn = document.getElementById('win-max');

  closeBtn?.addEventListener('click', () => window.lanbeam.app.close());
  minBtn?.addEventListener('click', () => window.lanbeam.app.minimize());
  maxBtn?.addEventListener('click', () => window.lanbeam.app.toggleMaximize());
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------
function bindNav() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const v = el.getAttribute('data-view');
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
  renderView('home');

  // QR pairing subscriptions
  window.lanbeam.pairing.onQr((data) => {
    state.qr = data;
    if (state.view === 'home') renderQr();
  });

  // Paired devices updates
  window.lanbeam.devices.onUpdated((devices) => {
    state.pairedDevices = devices;
    if (state.view === 'home') renderDevices();
    if (state.view === 'devices') renderDevicesView();
  });

  // Peers (mDNS)
  window.lanbeam.peers.onUpdated((peers) => {
    state.peers = peers;
    if (state.view === 'devices') renderDevicesView();
  });

  // Transfer events
  bindTransferEvents();

  // Settings updates
  window.lanbeam.settings.onUpdated((s) => {
    state.settings = s;
  });

  // Load initial state
  try {
    const s = await window.lanbeam.state.get();
    if (s) {
      state.settings = s.settings;
      state.pairedDevices = s.pairedDevices || [];
      state.history = s.history || [];
      if (s.qr) {
        state.qr = s.qr;
      }
      applyAccent(s.settings?.accentColor || '#00E5FF', []);
      applyFont(s.settings?.fontChoice || 'figtree');

      if (state.view === 'home') {
        renderQr();
        renderDevices();
      }
    }
  } catch (err) {
    console.error('Failed to get initial state:', err);
  }

  // Refresh QR if not already present
  if (!state.qr) {
    try {
      const qrData = await window.lanbeam.pairing.refreshQr();
      if (qrData && typeof qrData === 'object') {
        state.qr = qrData;
        if (state.view === 'home') renderQr();
      }
    } catch (err) {
      console.error('Failed to refresh QR:', err);
    }
  }
}

boot().catch(err => console.error('renderer boot failed:', err));
