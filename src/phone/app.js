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
  webTransportAvailable: false,
  maxParallelStreams: 8,
  defaultChunkSize: 4 * 1024 * 1024, // 4MB
  queue: [],  // { id, name, size, file, sent, total, status, chunks: [{idx, sent}] }
};

// Save deviceId for future sessions
localStorage.setItem('lanbeam:deviceId', state.deviceId);

function randomDeviceId() {
  return 'phone-' + Array.from({length: 16}, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
async function tryPair() {
  const urlParams = new URLSearchParams(location.search);
  const token = urlParams.get('token');
  const banner = document.getElementById('pair-banner');
  const pairStatus = document.getElementById('pair-status');
  const pairBtn = document.getElementById('pair-confirm');

  if (!token) {
    // No token — assume already paired (cookie set); verify with /api/state.
    try {
      const r = await fetch('/api/state', { headers: { 'X-Device-Id': state.deviceId }, credentials: 'include' });
      if (r.ok) {
        state.paired = true;
        banner.style.display = 'none';
        pairStatus.textContent = 'Paired';
        pairStatus.classList.add('paired');
        return;
      }
    } catch {}
    banner.style.display = 'block';
    pairStatus.textContent = 'Not paired';
    pairBtn.textContent = 'Refresh pairing';
    pairBtn.onclick = () => location.reload();
    return;
  }

  // Show pair banner; ask user to confirm
  banner.style.display = 'block';
  pairStatus.textContent = 'Confirm pairing';
  pairBtn.onclick = async () => {
    const deviceInfo = {
      deviceId: state.deviceId,
      name: navigator.userAgent.includes('iPhone') ? 'iPhone'
        : navigator.userAgent.includes('Android') ? 'Android Phone'
        : 'Phone',
      kind: 'phone',
    };
    const r = await fetch(`/api/pair?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deviceInfo),
    });
    if (r.ok) {
      state.paired = true;
      banner.style.display = 'none';
      pairStatus.textContent = 'Paired';
      pairStatus.classList.add('paired');
      toast('Paired successfully');
      // Clear token from URL so refresh doesn't try to pair again.
      history.replaceState({}, document.title, location.pathname);
    } else {
      const err = await r.json().catch(() => ({ error: 'pairing failed' }));
      toast('Pairing failed: ' + (err.error || 'unknown'));
    }
  };
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
  const input = document.getElementById('file-input');
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files?.length) enqueueFiles(Array.from(input.files));
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('dragover');
  }));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt?.files?.length) enqueueFiles(Array.from(dt.files));
  });
}

function enqueueFiles(files) {
  for (const file of files) {
    const item = {
      id: 'f-' + Math.random().toString(36).slice(2, 10),
      name: file.name,
      size: file.size,
      file,
      sent: 0,
      status: 'queued',  // queued | sending | done | error
      chunks: [],
    };
    state.queue.push(item);
  }
  renderQueue();
  pump();
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  if (!state.queue.length) {
    list.innerHTML = `<div class="empty">No files queued yet.</div>`;
    return;
  }
  list.innerHTML = state.queue.map(item => `
    <div class="file-row" data-id="${item.id}">
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="bar"><div class="fill ${item.status === 'error' ? 'error' : item.status === 'done' ? 'done' : ''}" style="width:${(item.sent / item.size * 100).toFixed(1)}%"></div></div>
      <div class="meta">
        <span>${formatBytes(item.sent)} / ${formatBytes(item.size)}</span>
        <span>${item.status.toUpperCase()}</span>
      </div>
    </div>
  `).join('');
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
    for (let i = 0; i < totalChunks; i++) {
      const offset = i * chunkSize;
      const length = Math.min(chunkSize, next.size - offset);
      const blob = next.file.slice(offset, offset + length);
      const buf = await blob.arrayBuffer();
      const hash = await sha256Hex(new Uint8Array(buf));
      chunks.push({ index: i, offset, length, hash, compressed: false });
    }
    const manifest = {
      fileId: next.id,
      fileName: next.name,
      fileSize: next.size,
      chunkSize,
      totalChunks,
      merkleRoot: chunks.length === 1 ? chunks[0].hash : chunks.map(c => c.hash).join(':'), // simplified
      chunks,
      isCompressed: 'auto',
      createdAt: Date.now(),
    };

    // POST manifest to start the transfer (receiver allocates a transfer slot)
    const startResp = await fetch('/api/transfer/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': state.deviceId },
      credentials: 'include',
      body: JSON.stringify(manifest),
    });
    if (!startResp.ok) throw new Error('start failed');
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
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Index': String(idx),
            'X-Compressed': chunk.compressed ? '1' : '0',
            'X-Device-Id': state.deviceId,
          },
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
      headers: { 'X-Device-Id': state.deviceId },
      credentials: 'include',
    });
    next.status = 'done';
    renderQueue();
    toast(`${next.name} sent`);
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
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------------------------------------------------------------------------
// Footer: WiFi info from the desktop
// ---------------------------------------------------------------------------
async function refreshFooter() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    const j = await r.json();
    const w = j.wifi;
    if (!w || !w.connected) {
      document.getElementById('wifi-info').textContent = 'Not connected to WiFi';
      return;
    }
    document.getElementById('wifi-info').textContent = `${w.generation || 'WiFi'} · ${w.band || ''} · ${w.channelWidthMHz || 0}MHz · ${w.phyRateMbps || 0} Mbps`.replace(/\s+/g, ' ').trim();
  } catch {}
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  await tryPair();
  await detectTransport();
  bindPicker();
  refreshFooter();
  setInterval(refreshFooter, 10_000);
})();
