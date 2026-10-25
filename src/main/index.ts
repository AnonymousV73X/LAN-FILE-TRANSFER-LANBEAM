/**
 * LANBeam — Electron main process entry.
 *
 * Wires together: window, tray, mDNS advertise/browse, HTTP server, QR
 * pairing, transfer orchestrator, Rust core (via core-loader), WiFi info
 * polling, and IPC handlers used by the renderer.
 *
 * Boot sequence:
 *   1. Load persisted state (paired devices, settings, local deviceId).
 *   2. Start mDNS advertise + browse.
 *   3. Start HTTP server on a random port (or settings.httpPort).
 *   4. Issue a one-time pairing token + generate QR for the renderer.
 *   5. Open the main window; register IPC handlers.
 *   6. If --benchmark flag: run benchmark and exit.
 */
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, screen, powerSaveBlocker, powerMonitor, Notification } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as http from 'http';
import { randomBytes } from 'crypto';
import QRCode from 'qrcode';
import os from 'os';
import { StateStore } from './store';
import { MdnsService } from './mdns';
import { PairingManager } from './pairing';
import { startHttpServer } from './http-server';
import { TransferOrchestrator, OrchestratorEvent } from './transfer-orchestrator';
import { queryWifiInfo } from './wifi-info';
import { runBenchmark } from './benchmark';
import { isNativeCoreAvailable } from './core-loader';
import { initLogger, log } from './logger';

// LANBeam never needs the internet. Skip proxy auto-detect (WPAD/PAC lookups
// hang on LANs without internet) and Chromium's background network chatter.
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('disable-background-networking');

const APP_VERSION = require('../../package.json').version || '1.0.0';

// electron-updater is optional — loaded lazily after app.whenReady() so it
// never blocks startup. Identical pattern to NovaTune.
let autoUpdater: any = null;
const DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'LANBeam');

function currentDownloadDir(): string {
  const d = store?.settings?.downloadDir;
  return d && path.isAbsolute(d) ? d : DOWNLOAD_DIR;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let mdns: MdnsService | null = null;
let orchestrator: TransferOrchestrator | null = null;
let pairManager: PairingManager | null = null;
let store: StateStore | null = null;
let httpPort = 0;
let baseUrl = '';
let httpClose: (() => Promise<void>) | null = null; // HTTP server shutdown handle
// Shared secret for the built-in speed test endpoint — lets the desktop
// self-test its own transfer engine without being a paired device.
let speedtestKey = randomBytes(24).toString('base64url');
let lanBeamIpUrl = '';   // direct-IP fallback link shown under the QR

// ---------------------------------------------------------------------------
// UI scaling — supports 4K / 2K high-DPI panels.
//   - When uiScale is 'auto' we look at the primary display's logical DPI
//     and physical pixel resolution. If the OS reports scaleFactor <= 1.25
//     (i.e. user hasn't already applied OS-level scaling), we apply 200%
//     on 4K panels (>= 3840px wide) and 175% on 2K panels (>= 2560px wide)
//     so the app doesn't look tiny. Otherwise we leave it at 100%.
//   - When the user explicitly picks a value, we just apply it.
//   - Re-applies on display-metrics-changed so dragging the window between
//     monitors with different DPI keeps the UI readable.
// ---------------------------------------------------------------------------
type UiScaleChoice = 'auto' | '1.0' | '1.25' | '1.5' | '1.75' | '2.0';

function resolveUiScale(choice: UiScaleChoice | undefined, display?: Electron.Display): number {
  if (choice && choice !== 'auto') return parseFloat(choice);
  const disp = display ?? screen.getPrimaryDisplay();
  const osScale = disp?.scaleFactor ?? 1;
  const widthPx = (disp?.bounds?.width ?? 0) * osScale; // physical px
  if (osScale <= 1.25 && widthPx >= 3840) return 2.0;       // 4K panel, OS at 100%
  if (osScale <= 1.25 && widthPx >= 2560) return 1.75;      // 2K panel, OS at 100%
  if (osScale > 1.25 && widthPx >= 3840) return 1.5;        // 4K panel, OS already scaled
  return 1.0;
}

function applyUiScale(win: BrowserWindow | null, choice: UiScaleChoice | undefined): number {
  if (!win || win.isDestroyed()) return 1.0;
  const factor = resolveUiScale(choice);
  try {
    win.webContents.setZoomFactor(factor);
  } catch (err) {
    log.warn('[uiScale] Failed to apply zoom factor', factor, err);
  }
  return factor;
}

async function createWindow() {
  // App icon — window + taskbar (the packaged exe icon comes from build/).
  const windowIcon = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    title: 'LANBeam',
    width: 1040,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    backgroundColor: '#000000',
    icon: windowIcon,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: 'rgba(0, 0, 0, 0)',
            symbolColor: '#b3b3b3',
            height: 38,
          }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.removeMenu();

  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Apply UI scaling for high-DPI panels (4K / 2K). Safe no-op on 1080p.
  applyUiScale(mainWindow, store?.settings?.uiScale as UiScaleChoice | undefined);

  // Re-apply when the user moves the window between monitors with different DPI,
  // or when the OS display metrics change (resolution / scale slider).
  screen.on('display-metrics-changed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      applyUiScale(mainWindow, store?.settings?.uiScale as UiScaleChoice | undefined);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildTrayMenu(): Menu {
  const peers = store!.pairedDevices.length;
  const transfers = orchestrator ? 0 : 0; // for v1 simplicity
  return Menu.buildFromTemplate([
    { label: `LANBeam v${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: `Paired devices: ${peers}` },
    { label: `Active transfers: ${transfers}` },
    { type: 'separator' },
    { label: 'Open window', click: () => mainWindow?.show() ?? createWindow() },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

async function buildTray() {
  // 16x16 png — a simple teal lightning bolt placeholder.
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  let image = nativeImage.createEmpty();
  try { image = nativeImage.createFromPath(iconPath); } catch {}
  if (image.isEmpty()) {
    // Fallback: 1x1 transparent.
    image = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Zj7wHgAAAAASUVORK5CYII=', 'base64'));
  }
  tray = new Tray(image);
  tray.setToolTip('LANBeam');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => mainWindow?.show() ?? createWindow());
}

let currentQr: { url: string; png: string; token: string } | null = null;

async function refreshQr() {
  if (!pairManager || !store || !baseUrl) return null;
  const { url, token } = pairManager.buildQrUrl(baseUrl);
  const png = await QRCode.toDataURL(url, {
    margin: 1,
    width: 320,
    color: { dark: '#000000', light: '#FFFFFF' },
    errorCorrectionLevel: 'M',
  });
  currentQr = { url, png, token };
  mainWindow?.webContents.send('pairing:qr', currentQr);
  return currentQr;
}

function registerIpc() {
  ipcMain.handle('state:get', () => ({
    settings: store!.settings,
    pairedDevices: store!.pairedDevices,
    history: store!.history.slice(0, 100),
    localDeviceId: store!.localDeviceId,
    httpUrl: baseUrl,
    httpPort,
    ipUrl: lanBeamIpUrl,            // direct-IP fallback for the QR panel
    permanentHost: PERMANENT_HOST,
    nativeCoreAvailable: isNativeCoreAvailable(),
    appVersion: APP_VERSION,
    qr: currentQr,
  }));

  ipcMain.handle('settings:update', (_e, patch) => {
    const next = store!.updateSettings(patch);
    // Live-apply UI scale changes without requiring an app restart.
    if (Object.prototype.hasOwnProperty.call(patch, 'uiScale')) {
      applyUiScale(mainWindow, next.uiScale as UiScaleChoice | undefined);
    }
    mainWindow?.webContents.send('settings:updated', next);
    return next;
  });

  ipcMain.handle('pairing:refresh-qr', async () => {
    return await refreshQr();
  });

  ipcMain.handle('devices:remove', (_e, deviceId: string) => {
    store!.removePairedDevice(deviceId);
    mainWindow?.webContents.send('devices:updated', store!.pairedDevices);
    return true;
  });

  // One-tap roster cleanup (Devices page button): drop every device that is
  // offline, keep the live ones. Returns how many ghosts were removed.
  ipcMain.handle('devices:clear-offline', () => {
    const { removed, kept } = store!.clearOfflineDevices();
    mainWindow?.webContents.send('devices:updated', kept);
    return { removed, devices: kept };
  });

  ipcMain.handle('transfer:send', async (_e, opts: { filePath: string; fileName: string; peerHost: string; peerPort: number; transport: 'quic' | 'http'; peerName?: string; targetDeviceId?: string }) => {
    // peerName carries the human device name ("Galaxy S24") so the progress
    // card says "to Galaxy S24" instead of "from Remote device" / an IP.
    // targetDeviceId addresses the outbound entry to one specific paired
    // device (mesh) — the phone's pending list is filtered per device.
    return orchestrator!.sendOutbound(opts.filePath, opts.fileName, { host: opts.peerHost, port: opts.peerPort, transport: opts.transport }, opts.peerName || opts.peerHost, opts.targetDeviceId);
  });

  // Receive-mode 'ask': the renderer's Accept / Decline card answers a
  // held /api/transfer/start request through this IPC.
  ipcMain.handle('transfer:respond', (_e, requestId: string, accepted: boolean) => {
    return orchestrator!.respondAcceptance(requestId, accepted);
  });

  ipcMain.handle('transfer:cancel', (_e, transferId: string) => orchestrator!.cancelTransfer(transferId));

  ipcMain.handle('transfer:pick-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    return result.filePaths;
  });

  ipcMain.handle('transfer:pick-download-dir', async () => {
    // Select an existing folder or create a new one (macOS: "New Folder" button).
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose or create a folder for incoming files',
      defaultPath: currentDownloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return currentDownloadDir();
    const dir = result.filePaths[0];
    try { await fs.mkdir(dir, { recursive: true }); } catch (err) { log.error('mkdir download dir failed:', err); }
    const next = store!.updateSettings({ downloadDir: dir });
    mainWindow?.webContents.send('settings:updated', next);
    return dir;
  });

  ipcMain.handle('transfer:reset-download-dir', () => {
    const next = store!.updateSettings({ downloadDir: '' });
    mainWindow?.webContents.send('settings:updated', next);
    return DOWNLOAD_DIR;
  });

  ipcMain.handle('transfer:default-download-dir', () => DOWNLOAD_DIR);

  ipcMain.handle('wifi:query', async () => queryWifiInfo());

  ipcMain.handle('benchmark:run', async () => {
    try {
      const outDir = path.join(app.getPath('userData'), 'benchmark-results');
      const results = await runBenchmark(outDir, orchestrator!, store!, undefined);
      mainWindow?.webContents.send('benchmark:results', results);
      return results;
    } catch (err) {
      log.error('[benchmark] Run failed:', err);
      throw err;
    }
  });

  // Transfer-engine speed test: measures the app's own HTTP stack by pulling
  // 32MB of incompressible RAM bytes through the real server — once as a
  // single stream (how PC→phone sends work today), then as 6 parallel range
  // lanes (what multi-lane would buy). Loopback-only: this is the engine
  // ceiling; the over-the-air number comes from the phone's speed test card.
  ipcMain.handle('speedtest:run', async () => {
    if (!httpPort) throw new Error('local server not started');
    const TOTAL = 32 * 1024 * 1024;
    const LANES = 6;
    const base = `http://127.0.0.1:${httpPort}`;
    const pull = (range?: string) => new Promise<number>((resolve, reject) => {
      const req = http.get(`${base}/api/speedtest?bytes=${TOTAL}&key=${encodeURIComponent(speedtestKey)}`, {
        headers: range ? { Range: range } : {},
      }, (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let n = 0;
        res.on('data', (c: Buffer) => { n += c.length; });
        res.on('end', () => resolve(n));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    const mbps = (bytes: number, ms: number) => Math.round((bytes * 8) / (ms / 1000) / 1e6);
    // Phase 1 — one stream, exactly like a PC→phone send today.
    const t1 = performance.now();
    const n1 = await pull();
    const d1 = performance.now() - t1;
    if (n1 !== TOTAL) throw new Error(`engine test: got ${n1} of ${TOTAL} bytes`);
    await new Promise(r => setTimeout(r, 150));
    // Phase 2 — six lanes, each a byte-range slice of the same 32MB.
    const lane = Math.ceil(TOTAL / LANES);
    const t2 = performance.now();
    const counts = await Promise.all(Array.from({ length: LANES }, (_, i) => {
      const s = i * lane;
      const e = Math.min(TOTAL, s + lane) - 1;
      return pull(`bytes=${s}-${e}`);
    }));
    const d2 = performance.now() - t2;
    const n2 = counts.reduce((a, b) => a + b, 0);
    if (n2 !== TOTAL) throw new Error(`engine lanes test: got ${n2} of ${TOTAL} bytes`);
    return {
      single: { mbps: mbps(n1, d1), ms: Math.round(d1), bytes: n1 },
      lanes: { mbps: mbps(n2, d2), ms: Math.round(d2), bytes: n2, count: LANES },
    };
  });

  ipcMain.handle('app:minimize', () => mainWindow?.minimize());
  ipcMain.handle('app:close', () => mainWindow?.close());
  ipcMain.handle('app:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });

  // Keep the display awake while the enlarged QR lightbox is open so the
  // screen never dims or sleeps mid-scan ("max brightness on focus").
  let qrPowerSaveId: number | null = null;
  ipcMain.handle('app:power-save', (_e, on: boolean) => {
    if (on) {
      if (qrPowerSaveId === null) {
        qrPowerSaveId = powerSaveBlocker.start('prevent-display-sleep');
      }
    } else if (qrPowerSaveId !== null) {
      powerSaveBlocker.stop(qrPowerSaveId);
      qrPowerSaveId = null;
    }
    return qrPowerSaveId !== null;
  });

  ipcMain.handle('history:show-in-folder', async (_e, filePathOrName: string) => {
    try {
      let targetPath = filePathOrName;
      if (!targetPath) return false;
      // If it's not absolute, resolve inside DOWNLOAD_DIR
      if (!path.isAbsolute(targetPath)) {
        targetPath = path.join(currentDownloadDir(), targetPath);
      }
      try {
        await fs.access(targetPath);
        shell.showItemInFolder(targetPath);
        return true;
      } catch {
        // Fallback: check DOWNLOAD_DIR directly with base filename
        const baseTarget = path.join(currentDownloadDir(), path.basename(filePathOrName));
        try {
          await fs.access(baseTarget);
          shell.showItemInFolder(baseTarget);
          return true;
        } catch {
          // File not found — do NOT open the download folder.
          // The renderer will surface a friendly "file doesn't exist" toast
          // so the user knows the file was moved or deleted, instead of
          // getting a random folder window popping up in their face.
          return false;
        }
      }
    } catch (err) {
      log.error('Failed to show item in folder:', err);
      return false;
    }
  });

  ipcMain.handle('history:open-file', async (_e, filePathOrName: string) => {
    try {
      let targetPath = filePathOrName;
      if (!targetPath) return false;
      if (!path.isAbsolute(targetPath)) {
        targetPath = path.join(currentDownloadDir(), targetPath);
      }
      try {
        await fs.access(targetPath);
        await shell.openPath(targetPath);
        return true;
      } catch {
        const baseTarget = path.join(currentDownloadDir(), path.basename(filePathOrName));
        try {
          await fs.access(baseTarget);
          await shell.openPath(baseTarget);
          return true;
        } catch {
          return false;
        }
      }
    } catch (err) {
      log.error('Failed to open file:', err);
      return false;
    }
  });

  // ─── OTA Update IPC ──────────────────────────────────────────────────────
  ipcMain.handle('update:check', async () => {
    try {
      const { autoUpdater: au } = require('electron-updater');
      if (au && app.isPackaged) return await au.checkForUpdates();
    } catch (err) { console.warn('[update] check failed:', (err as any).message); }
    return null;
  });

  ipcMain.handle('update:download', async () => {
    try {
      const { autoUpdater: au } = require('electron-updater');
      if (au && app.isPackaged) await au.downloadUpdate();
    } catch (err) { console.warn('[update] download failed:', (err as any).message); }
  });

  ipcMain.handle('update:install', () => {
    try {
      const { autoUpdater: au } = require('electron-updater');
      if (!au) return;
      au.quitAndInstall(false, true);
    } catch (err) { console.warn('[update] install failed:', (err as any).message); }
  });

  // Forward orchestrator events to the renderer
  orchestrator!.on('event', (ev: OrchestratorEvent) => {
    mainWindow?.webContents.send('transfer:event', ev);

    // OS notification + sound when transfer completes and app is not focused.
    // Only fires when the window is hidden, minimised, or out of focus so we
    // don't interrupt the user who is already watching the card.
    if (ev.type === 'inbound:complete' || ev.type === 'outbound:complete') {
      const win = mainWindow;
      const appFocused = win && !win.isDestroyed() && win.isFocused();
      if (!appFocused && Notification.isSupported()) {
        const r = (ev as any).result;
        const fileName = r?.fileName || 'File';
        const direction = r?.direction === 'out' ? 'Sent' : 'Received';
        const peerName = r?.peerName || 'device';
        const notif = new Notification({
          title: 'LANBeam — Transfer Complete',
          body: direction + ': ' + fileName + ' ' + (r && r.direction === 'out' ? 'to' : 'from') + ' ' + peerName,
          icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
          silent: false,
        });
        notif.on('click', () => {
          if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        });
        notif.show();
      }
    }
  });
}

/**
 * Best LAN interface picker — ALWAYS prioritise the best available link.
 *
 * The old code returned the FIRST non-internal IPv4, which on real machines
 * is frequently a virtual adapter (WSL / Hyper-V / VMware / Docker / VPN) the
 * phone can't reach or that tunnels traffic through a slow path. Now every
 * candidate is scored and the highest wins:
 *   - virtual adapters are heavily penalised (only used as a last resort)
 *   - Ethernet and Wi-Fi names get a bonus (EN/de localized hints)
 *   - home-router subnets (192.168.x, 10.x) outrank 172.16-31.x (Docker-ish)
 */
interface LanCandidate { address: string; name: string; score: number }

function pickBestLanIp(): string {
  const ifaces = os.networkInterfaces();
  const candidates: LanCandidate[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // link-local autoconf
      let score = 0;
      const lname = name.toLowerCase();
      if (/vethernet|wsl|vmware|virtualbox|hyper-v|docker|loopback|tap|tun|vpn|tailscale|zerotier|hamachi/i.test(lname)) {
        score -= 100; // virtual / overlay adapter — almost never the phone's path
      }
      if (/wi-?fi|wlan|wireless|无线|wi_fi/.test(lname)) score += 40;
      if (/ethernet|以太网|local area|eth\d/.test(lname)) score += 60; // wired beats wireless
      if (net.address.startsWith('192.168.')) score += 20;
      else if (net.address.startsWith('10.')) score += 12;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(net.address)) score -= 25; // docker-style range
      candidates.push({ address: net.address, name, score });
    }
  }
  if (!candidates.length) return '127.0.0.1';
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].address;
}

// ---------------------------------------------------------------------------
// Network change watcher — Wi-Fi switched / DHCP renewed / cable plugged:
// re-derive the LAN URL, re-announce over mDNS and issue a fresh QR with no
// restart. (The HTTP server listens on all interfaces, so it needs no rebind.)
// ---------------------------------------------------------------------------
function netSignature(): string {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const n of ifaces[name] ?? []) {
      if (n.family === 'IPv4' && !n.internal) out.push(`${name}:${n.address}`);
    }
  }
  return out.sort().join('|');
}

function restartMdns() {
  try { mdns?.destroy(); } catch {}
  if (!store) return;
  mdns = new MdnsService();
  mdns.advertise(httpPort, store.localDeviceId, APP_VERSION, PERMANENT_HOST);
  mdns.browse();
  mdns.onPeersChanged((peers) => { mainWindow?.webContents.send('peers:updated', peers); });
}

function startNetworkWatcher() {
  let sig = netSignature();
  let settling: NodeJS.Timeout | null = null;
  const apply = async () => {
    settling = null;
    sig = netSignature();
    const ip = pickBestLanIp();
    if (ip === '127.0.0.1') {
      // No usable LAN yet (mid-switch). Don't mint a useless loopback QR —
      // the next signature change (when DHCP finishes) re-runs this.
      log.info('[net] no LAN address yet, waiting…');
      mainWindow?.webContents.send('network:changed', { ipUrl: '', httpUrl: '', noNetwork: true });
      return;
    }
    const url = `http://${ip}:${httpPort}`;
    log.info(`[net] network changed → ${url}`);
    baseUrl = url;
    lanBeamIpUrl = url;
    restartMdns();
    // Order matters: URLs first, then the fresh QR (the renderer repaints on 'pairing:qr').
    mainWindow?.webContents.send('network:changed', { ipUrl: url, httpUrl: url });
    await refreshQr();
  };
  const check = () => {
    if (netSignature() === sig || settling) return;
    // Let DHCP / adapter bring-up settle before re-deriving the address.
    settling = setTimeout(apply, 800);
  };
  setInterval(check, 1000);
  powerMonitor.on('resume', () => setTimeout(check, 1500));
  powerMonitor.on('unlock-screen', () => setTimeout(check, 500));
}

/**
 * PERMANENT connect URL.
 *
 * The desktop publishes the mDNS A record `lanbeam.local` (see MdnsService),
 * so http://lanbeam.local:<port> keeps working across DHCP IP changes — the
 * QR encodes it, and the phone's stored shortcut resolves it for months.
 * We wait briefly for the mDNS announce to confirm the responder is actually
 * up; if it isn't (firewall, port busy, broken multicast) we fall back to the
 * best LAN IP so pairing NEVER breaks — it just loses the permanence bonus.
 */
const PERMANENT_HOST = 'lanbeam.local';

function permanentUrlReady(mdns: MdnsService, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // bonjour emits 'up' on the published service once the first announce
    // round went out on the wire — empirical proof the responder works.
    mdns.onPublished(() => done(true));
    const timer = setTimeout(() => done(false), timeoutMs);
  });
}

async function boot() {
  await initLogger();
  log.info('LANBeam starting up, version:', APP_VERSION);
  await fs.mkdir(currentDownloadDir(), { recursive: true }).catch(() => fs.mkdir(DOWNLOAD_DIR, { recursive: true }));
  store = new StateStore();
  // Dedup persisted paired devices — keeps newest lastSeen per deviceId
  store.deduplicatePairedDevices();
  // Age out records unseen for 180 DAYS. Remember-Me must survive months
  // (user requirement), so the prune horizon is deliberately generous —
  // half a year of silence is a dead phone, 3 months is just a vacation.
  const pruned = store.prunePairedDevices(180 * 24 * 60 * 60 * 1000);
  if (pruned > 0) log.info(`[store] pruned ${pruned} stale paired device record(s)`);
  pairManager = new PairingManager();
  orchestrator = new TransferOrchestrator(store);
  mdns = new MdnsService();

  // Pick ports (default 54321 for permanent bookmarkable URL). Allow override via settings.
  const httpPortConfigured = store.settings.httpPort || 54321;
  const lanIp = pickBestLanIp();

  const httpHandle = await startHttpServer({
    port: httpPortConfigured,
    hostname: lanIp,
    pairManager,
    store,
    orchestrator,
    downloadDir: DOWNLOAD_DIR,
    onDevicePaired: (_device) => {
      mainWindow?.webContents.send('devices:updated', store!.pairedDevices);
    },
    // Permanent + direct links for /api/state — closures over the module
    // vars because the definitive port/URL only settle after bind + mDNS.
    links: () => ({ permanent: baseUrl || undefined, ip: lanBeamIpUrl || undefined }),
    speedtestKey,
  });
  httpPort = httpHandle.port;
  httpClose = httpHandle.close;

  // The QR / pairing URL: use the direct LAN IP by default so phones never
  // hit mDNS / .local DNS resolution issues (DNS_PROBE_POSSIBLE).
  const ipUrl = `http://${lanIp}:${httpPort}`;
  baseUrl = ipUrl;
  lanBeamIpUrl = ipUrl;
  log.info(`[boot] pairing URL: ${baseUrl}`);

  await registerIpc();

  // Instant Shell: the window goes up FIRST. QR generation (CPU-bound), the
  // mDNS announce/browse and the tray now OVERLAP the page load instead of
  // serializing ahead of it — on a cold HDD the window appears that much
  // earlier. The renderer receives the QR through the pairing:qr event
  // (subscribed before its first await), so nothing functional changes.
  await createWindow();

  // Advertise via mDNS with the PERMANENT hostname (lanbeam.local A record).
  // The QUIC port (Rust core) is advertised separately when the core is built.
  mdns.advertise(httpPort, store.localDeviceId, APP_VERSION, PERMANENT_HOST);
  mdns.browse();

  // Not awaited (same as the 15-min QR interval): the renderer repaints the
  // QR the moment the pairing:qr event lands.
  refreshQr().catch(() => {});
  await buildTray();

  startNetworkWatcher();

  // ─── Auto-Updater (NovaTune pattern) ──────────────────────────────────────
  // Lazy-load electron-updater after the window is ready so it never blocks boot.
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (_) {
    log.warn('[autoUpdater] electron-updater not installed — OTA updates disabled.');
  }

  if (autoUpdater && app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info: any) => {
      mainWindow?.webContents.send('update:available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseName: info.releaseName,
      });
    });

    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('update:not-available');
    });

    autoUpdater.on('download-progress', (progress: any) => {
      mainWindow?.webContents.send('update:download-progress', {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    });

    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('update:downloaded');
    });

    autoUpdater.on('error', (err: Error) => {
      log.error('[autoUpdater] Error:', err.message);
      mainWindow?.webContents.send('update:error', { message: err.message });
    });

    // First check: 60s after launch so the UI is fully settled.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err: Error) => {
        log.warn('[autoUpdater] Startup check failed:', err.message);
      });
    }, 60_000);

    // Periodic check: every 4 hours (identical to NovaTune).
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);

  } else if (!app.isPackaged) {
    // Dev mode: lightweight GitHub API check — shows the update banner without
    // a full electron-updater instance (no squirrel, no signing needed).
    setTimeout(async () => {
      try {
        const { net } = await import('electron');
        const res = await net.fetch(
          'https://api.github.com/repos/AnonymousV73X/LAN-FILE-TRANSFER-LANBEAM/releases/latest',
          { headers: { 'User-Agent': 'LANBeam-Update-Check' } },
        );
        if (res.ok) {
          const data: any = await res.json();
          const latest = (data.tag_name || '').replace(/^v/, '');
          if (latest && latest !== APP_VERSION) {
            mainWindow?.webContents.send('update:available', {
              version: latest,
              releaseNotes: data.body || '',
              releaseName: data.name || '',
            });
          }
        }
      } catch (_) {}
    }, 30_000);
  }

  // Periodically refresh QR (one-time-use tokens) and update tray.
  setInterval(() => refreshQr(), 15 * 60 * 1000);

  mdns.onPeersChanged((peers) => {
    mainWindow?.webContents.send('peers:updated', peers);
  });
}

// ------------------------------------------------------------------
// Benchmark mode — `electron . --benchmark`
// ------------------------------------------------------------------
async function bootBenchmark() {
  await app.whenReady();
  const storeB = new StateStore();
  const orch = new TransferOrchestrator(storeB);
  const outDir = path.join(app.getPath('userData'), 'benchmark-results');
  const results = await runBenchmark(outDir, orch, storeB);
  console.log('=== LANBeam Benchmark ===');
  for (const r of results) {
    console.log(`[${r.spec.label}] baseline=${r.baselineThroughputMbps.toFixed(1)} Mbps  optimized=${r.optimizedThroughputMbps.toFixed(1)} Mbps  uplift=${r.upliftPct.toFixed(1)}%  integrity=${r.integrityOk}`);
  }
  console.log(`WiFi: ${r_formatWifi(results[0]?.wifi)}`);
  console.log(`Report: ${path.join(outDir, 'report.json')}`);
  app.quit();
}

function r_formatWifi(w?: any): string {
  if (!w) return 'unknown';
  return `${w.generation ?? 'Unknown'} ${w.band ?? ''} ${w.channelWidthMHz ?? 0}MHz ${w.phyRateMbps ?? 0}Mbps`.trim();
}

if (process.argv.includes('--benchmark')) {
  bootBenchmark().catch(err => { console.error(err); process.exit(1); });
} else {
  app.whenReady().then(boot).catch(err => console.error('Boot failed:', err));

  app.on('window-all-closed', () => {
    // Keep running in tray on all platforms.
    if (process.platform === 'darwin') return; // mac standard: stay in menu bar
    // On Windows/Linux, hide to tray — explicit quit from tray menu.
  });

  app.on('activate', () => { if (mainWindow === null) createWindow(); });

  // ── Clean shutdown: kill every background resource so no zombie processes
  // linger in Task Manager after the app closes. This is the authoritative
  // teardown path — both "Quit" from tray and window X-button end up here.
  app.on('will-quit', (e) => {
    e.preventDefault(); // hold the quit until async cleanup finishes

    (async () => {
      try {
        // 1. Flush settings/state to disk first (fast, synchronous internally).
        store?.flush();

        // 2. Cancel any in-progress transfers so their worker loops exit.
        try { orchestrator?.cancelAll?.(); } catch {}

        // 3. Stop mDNS advertising/browsing (sends mDNS goodbye packets).
        try { mdns?.stop(); } catch {}

        // 4. Close the HTTP server — stops accepting new connections and
        //    waits for existing keep-alive connections to drain (max 2s).
        if (httpClose) {
          try {
            await Promise.race([
              httpClose(),
              new Promise<void>(r => setTimeout(r, 2000)),
            ]);
          } catch {}
          httpClose = null;
        }

        // 5. Remove tray icon so it disappears immediately.
        try { tray?.destroy(); tray = null; } catch {}

      } finally {
        // Force-exit: removes ALL remaining Node libuv handles (timers,
        // keep-alive sockets, bonjour UDP, etc.) so nothing lingers in
        // Task Manager.
        app.exit(0);
      }
    })();
  });
}
