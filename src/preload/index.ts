/**
 * LANBeam — preload bridge.
 *
 * Exposes a minimal, typed `window.lanbeam` API to the renderer via
 * contextBridge. The renderer never touches Node directly — every IPC
 * call goes through here so the security boundary stays clean.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  state: {
    get: () => ipcRenderer.invoke('state:get'),
  },
  settings: {
    update: (patch: any) => ipcRenderer.invoke('settings:update', patch),
    onUpdated: (cb: (s: any) => void) => {
      const sub = (_e: any, s: any) => cb(s);
      ipcRenderer.on('settings:updated', sub);
      return () => ipcRenderer.removeListener('settings:updated', sub);
    },
  },
  pairing: {
    refreshQr: () => ipcRenderer.invoke('pairing:refresh-qr'),
    onQr: (cb: (data: { url: string; png: string; token: string }) => void) => {
      const sub = (_e: any, data: any) => cb(data);
      ipcRenderer.on('pairing:qr', sub);
      return () => ipcRenderer.removeListener('pairing:qr', sub);
    },
  },
  devices: {
    remove: (deviceId: string) => ipcRenderer.invoke('devices:remove', deviceId),
    onUpdated: (cb: (devices: any[]) => void) => {
      const sub = (_e: any, d: any[]) => cb(d);
      ipcRenderer.on('devices:updated', sub);
      return () => ipcRenderer.removeListener('devices:updated', sub);
    },
  },
  peers: {
    onUpdated: (cb: (peers: any[]) => void) => {
      const sub = (_e: any, p: any[]) => cb(p);
      ipcRenderer.on('peers:updated', sub);
      return () => ipcRenderer.removeListener('peers:updated', sub);
    },
  },
  transfer: {
    send: (opts: { filePath: string; fileName: string; peerHost: string; peerPort: number; transport: 'quic' | 'http' }) =>
      ipcRenderer.invoke('transfer:send', opts),
    pickFiles: () => ipcRenderer.invoke('transfer:pick-files'),
    pickDownloadDir: () => ipcRenderer.invoke('transfer:pick-download-dir'),
    onEvent: (cb: (ev: any) => void) => {
      const sub = (_e: any, ev: any) => cb(ev);
      ipcRenderer.on('transfer:event', sub);
      return () => ipcRenderer.removeListener('transfer:event', sub);
    },
  },
  wifi: {
    query: () => ipcRenderer.invoke('wifi:query'),
  },
  benchmark: {
    run: () => ipcRenderer.invoke('benchmark:run'),
    onResults: (cb: (results: any[]) => void) => {
      const sub = (_e: any, r: any[]) => cb(r);
      ipcRenderer.on('benchmark:results', sub);
      return () => ipcRenderer.removeListener('benchmark:results', sub);
    },
  },
  app: {
    minimize: () => ipcRenderer.invoke('app:minimize'),
    close: () => ipcRenderer.invoke('app:close'),
    toggleMaximize: () => ipcRenderer.invoke('app:toggle-maximize'),
  },
};

try {
  contextBridge.exposeInMainWorld('lanbeam', api);
} catch (err) {
  console.error('preload bridge failed:', err);
}
