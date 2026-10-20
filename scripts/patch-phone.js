const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, '..', 'src', 'phone', 'app.js');
let src = fs.readFileSync(appJsPath, 'utf8');

// Fix 1: refreshFooter — add auth headers and fix "not connected to wifi" logic
const oldFooter = `async function refreshFooter() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    const j = await r.json();
    const w = j.wifi;
    if (!w || !w.connected) {
      document.getElementById('wifi-info').textContent = 'Not connected to WiFi';
      return;
    }
    document.getElementById('wifi-info').textContent = \`\${w.generation || 'WiFi'} \xb7 \${w.band || ''} \xb7 \${w.channelWidthMHz || 0}MHz \xb7 \${w.phyRateMbps || 0} Mbps\`.replace(/\\\\s+/g, ' ').trim();
  } catch {}
}`;

const newFooter = `async function refreshFooter() {
  try {
    const r = await fetch('/api/state', {
      headers: { 'X-Device-Id': state.deviceId },
      credentials: 'include',
    });
    if (!r.ok) return; // not paired or server not reachable
    const j = await r.json();
    const el = document.getElementById('wifi-info');
    if (!el) return;
    const w = j.wifi;
    // Desktop may be on Ethernet — we're still connected via LAN.
    // Only show network details if we have WiFi info.
    if (!w || !w.ssid) {
      el.textContent = 'Connected via LAN';
      return;
    }
    el.textContent = (\`\${w.generation || 'WiFi'} \xb7 \${w.ssid} \xb7 \${w.band || ''} \xb7 \${w.phyRateMbps || 0} Mbps\`).replace(/  +/g, ' ').trim();
  } catch {}
}`;

if (src.includes('async function refreshFooter()')) {
  // Replace from the function start to the closing }
  src = src.replace(/async function refreshFooter\(\) \{[\s\S]*?\n\}/m, newFooter);
  fs.writeFileSync(appJsPath, src, 'utf8');
  console.log('refreshFooter patched OK');
} else {
  console.error('refreshFooter not found!');
  process.exit(1);
}
