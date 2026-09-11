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
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
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

const APP_VERSION = '1.0.0';
const DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'LANBeam');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let mdns: MdnsService | null = null;
let orchestrator: TransferOrchestrator | null = null;
let pairManager: PairingManager | null = null;
let store: StateStore | null = null;
let httpPort = 0;
let baseUrl = '';

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'LANBeam',
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#000000',
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
    nativeCoreAvailable: isNativeCoreAvailable(),
    appVersion: APP_VERSION,
    qr: currentQr,
  }));

  ipcMain.handle('settings:update', (_e, patch) => {
    const next = store!.updateSettings(patch);
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

  ipcMain.handle('transfer:send', async (_e, opts: { filePath: string; fileName: string; peerHost: string; peerPort: number; transport: 'quic' | 'http' }) => {
    return orchestrator!.sendOutbound(opts.filePath, opts.fileName, { host: opts.peerHost, port: opts.peerPort, transport: opts.transport }, opts.peerHost);
  });

  ipcMain.handle('transfer:pick-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
    });
    return result.filePaths;
  });

  ipcMain.handle('transfer:pick-download-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths[0]) {
      // persist as user-chosen download dir (future enhancement)
    }
    return result.filePaths[0] ?? DOWNLOAD_DIR;
  });

  ipcMain.handle('wifi:query', async () => queryWifiInfo());

  ipcMain.handle('benchmark:run', async () => {
    const outDir = path.join(app.getPath('userData'), 'benchmark-results');
    const results = await runBenchmark(outDir, orchestrator!, store!, undefined);
    mainWindow?.webContents.send('benchmark:results', results);
    return results;
  });

  ipcMain.handle('app:minimize', () => mainWindow?.minimize());
  ipcMain.handle('app:close', () => mainWindow?.close());
  ipcMain.handle('app:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });

  // Forward orchestrator events to the renderer
  orchestrator!.on('event', (ev: OrchestratorEvent) => {
    mainWindow?.webContents.send('transfer:event', ev);
  });
}

function getPrimaryLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

async function boot() {
  await initLogger();
  log.info('LANBeam starting up, version:', APP_VERSION);
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  store = new StateStore();
  pairManager = new PairingManager();
  orchestrator = new TransferOrchestrator(store);
  mdns = new MdnsService();

  // Pick ports (0 = OS-assigned random). Allow override via settings.
  const httpPortConfigured = store.settings.httpPort || 0;
  const lanIp = getPrimaryLanIp();

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
  });
  httpPort = httpHandle.port;
  baseUrl = httpHandle.url;

  // Advertise via mDNS — advertise the HTTP port for the phone path.
  // The QUIC port (Rust core) is advertised separately when the core is built.
  mdns.advertise(httpPort, store.localDeviceId, APP_VERSION);
  mdns.browse();

  await registerIpc();
  await refreshQr();
  await createWindow();
  await buildTray();

  // Periodically refresh QR (one-time-use tokens) and update tray.
  setInterval(() => refreshQr(), 4 * 60 * 1000);

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
  app.on('before-quit', () => { mdns?.stop(); tray?.destroy(); });
}
