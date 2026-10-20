const fs = require('fs');
const path = require('path');

// Patch renderer/main.js — renderDevices: hide stale devices (>24h), fix online threshold
const rendererPath = path.join(__dirname, '..', 'src', 'renderer', 'main.js');
let src = fs.readFileSync(rendererPath, 'utf8');

const newFn = `function renderDevices() {
  const host = document.getElementById('device-cards');
  if (!host) return;
  const ONLINE_MS = 30 * 1000;   // 30s = online (phone heartbeats every 15s)
  const RECENT_MS = 24 * 60 * 60 * 1000; // 24h = show at all; older = hidden
  const now = Date.now();
  const recentDevices = state.pairedDevices.filter(d => now - d.lastSeen < RECENT_MS);
  if (!recentDevices.length) {
    host.innerHTML = \`<div class="empty-hint">No paired devices yet. Scan the QR above with your phone.</div>\`;
  } else {
    host.innerHTML = recentDevices.map(d => deviceCardHtml(d, now - d.lastSeen < ONLINE_MS)).join('');
  }
  const count = recentDevices.filter(d => now - d.lastSeen < ONLINE_MS).length;
  const counter = document.getElementById('device-count');
  if (counter) counter.textContent = \`\${count} device\${count === 1 ? '' : 's'} online\`;
}`;

src = src.replace(/function renderDevices\(\) \{[\s\S]*?\n\}/, newFn);
fs.writeFileSync(rendererPath, src, 'utf8');
console.log('renderDevices patched OK');
