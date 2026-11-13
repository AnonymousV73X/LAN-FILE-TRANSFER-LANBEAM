import { sanitizeWindowsFilename } from './ftp-client';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SimpleFtpClient, FtpConfig } from './ftp-client';

const execAsync = promisify(exec);

export interface FileItem {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  mtime: number;
  mimeType?: string;
  phoneFileId?: string;
}

export interface StorageDevice {
  id: string;
  name: string;
  kind: 'pc' | 'phone';
  rootPath?: string;
  totalSpace?: number;
  freeSpace?: number;
}

export interface PhoneVirtualEntry {
  id: string;
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

export interface SearchOptions {
  scope: 'folder' | 'drive';
  targetPath: string;
  query: string;
  deviceId?: string;
}

class ExplorerService {
  private ftpConfigs: Map<string, FtpConfig & { name: string }> = new Map();
  private phoneVirtualDrives: Map<string, {
    deviceName: string;
    entries: Map<string, PhoneVirtualEntry>;
  }> = new Map();

  // Fast In-Memory Folder Cache to accelerate directory navigation & local folder searches
  private dirCache: Map<string, { items: FileItem[]; cachedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 15000;

  async getDevices(): Promise<StorageDevice[]> {
    const devices: StorageDevice[] = [];

    if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync('wmic logicaldisk get name,volumename,size,freespace');
        const lines = stdout.trim().split('\n').slice(1);
        for (const line of lines) {
          const match = line.match(/([A-Z]:)/i);
          if (match) {
            const letter = match[1].toUpperCase();
            const driveLetter = letter + '\\';
            devices.push({
              id: 'pc-' + letter.replace(':', ''),
              name: `Local Disk (${letter})`,
              kind: 'pc',
              rootPath: driveLetter,
            });
          }
        }
      } catch {
        devices.push({
          id: 'pc-c',
          name: 'Local Disk (C:)',
          kind: 'pc',
          rootPath: 'C:\\',
        });
      }
    } else {
      devices.push({
        id: 'pc-root',
        name: 'Root Filesystem',
        kind: 'pc',
        rootPath: '/',
      });
    }

    for (const [deviceId, drive] of this.phoneVirtualDrives.entries()) {
      devices.push({
        id: `phone-${deviceId}`,
        name: drive.deviceName,
        kind: 'phone',
        rootPath: `phone://${deviceId}`,
      });
    }

    return devices;
  }

  async listPcDirectory(targetPath?: string, forceRefresh = false): Promise<{ currentPath: string; items: FileItem[] }> {
    const dirPath = targetPath || os.homedir();
    const now = Date.now();

    if (!forceRefresh) {
      const cached = this.dirCache.get(dirPath);
      if (cached && (now - cached.cachedAt) < this.CACHE_TTL_MS) {
        return { currentPath: dirPath, items: cached.items };
      }
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const items: FileItem[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('$') || entry.name === 'System Volume Information') continue;
        const fullPath = path.join(dirPath, entry.name);
        let size = 0;
        let mtime = 0;
        try {
          const stat = await fs.stat(fullPath);
          size = stat.size;
          mtime = stat.mtimeMs;
        } catch {
          // Unreadable / system locked file
        }

        items.push({
          name: entry.name,
          path: fullPath,
          size,
          isDirectory: entry.isDirectory(),
          mtime,
        });
      }

      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
      });

      this.dirCache.set(dirPath, { items, cachedAt: now });
      return { currentPath: dirPath, items };
    } catch (err: any) {
      throw new Error(`Cannot open directory "${dirPath}": ${err.message}`);
    }
  }

  // Fast Two-Mode Search: 'folder' (in current folder) or 'drive' (deep search up to 250 matches)
  async searchFiles(opts: SearchOptions): Promise<FileItem[]> {
    const q = (opts.query || '').trim().toLowerCase();
    if (!q) return [];

    // Phone virtual search
    if (opts.deviceId && opts.deviceId.startsWith('phone-')) {
      const pId = opts.deviceId.replace('phone-', '');
      const drive = this.phoneVirtualDrives.get(pId);
      if (!drive) return [];

      const matches: FileItem[] = [];
      const prefix = opts.scope === 'folder'
        ? opts.targetPath.replace(/^phone:\/\/[^/]+\/?/, '').replace(/\/+$/, '')
        : '';
      const prefixWithSlash = prefix ? prefix + '/' : '';

      for (const [relPath, entry] of drive.entries.entries()) {
        if (opts.scope === 'folder' && prefix) {
          if (!relPath.startsWith(prefixWithSlash)) continue;
          const rest = relPath.slice(prefixWithSlash.length);
          if (rest.includes('/')) continue; // only immediate level in current folder
        }
        if (entry.name.toLowerCase().includes(q)) {
          matches.push({
            name: entry.name,
            path: `phone://${pId}/${entry.relativePath}`,
            size: entry.size,
            isDirectory: entry.isDirectory,
            mtime: entry.mtime,
            phoneFileId: entry.id,
          });
        }
        if (matches.length >= 250) break;
      }
      return matches;
    }

    // PC Search
    if (opts.scope === 'folder') {
      const { items } = await this.listPcDirectory(opts.targetPath);
      return items.filter(item => item.name.toLowerCase().includes(q));
    }

    // Full Drive / Deep Subtree Search
    let searchRoot = opts.targetPath;
    if (opts.scope === 'drive') {
      const driveMatch = opts.targetPath.match(/^([A-Z]:\\?)/i);
      searchRoot = driveMatch ? driveMatch[1].slice(0, 2) + '\\' : opts.targetPath;
    }

    const results: FileItem[] = [];
    const MAX_RESULTS = 250;
    const MAX_DEPTH = 6;

    async function walk(currentDir: string, depth: number) {
      if (results.length >= MAX_RESULTS || depth > MAX_DEPTH) return;
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) return;
          if (entry.name.startsWith('$') || entry.name === 'System Volume Information' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

          const fullPath = path.join(currentDir, entry.name);
          const nameLower = entry.name.toLowerCase();

          if (nameLower.includes(q)) {
            let size = 0, mtime = 0;
            try {
              const st = await fs.stat(fullPath);
              size = st.size;
              mtime = st.mtimeMs;
            } catch {}
            results.push({
              name: entry.name,
              path: fullPath,
              size,
              isDirectory: entry.isDirectory(),
              mtime,
            });
          }

          if (entry.isDirectory()) {
            await walk(fullPath, depth + 1);
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    await walk(searchRoot, 0);
    return results;
  }

  registerPhoneTree(deviceId: string, deviceName: string, items: PhoneVirtualEntry[]): void {
    const entryMap = new Map<string, PhoneVirtualEntry>();
    for (const item of items) {
      entryMap.set(item.relativePath, item);
    }
    this.phoneVirtualDrives.set(deviceId, { deviceName, entries: entryMap });
  }

  unregisterPhoneTree(deviceId: string): void {
    this.phoneVirtualDrives.delete(deviceId);
  }

  registerFtpDevice(id: string, name: string, config: FtpConfig): void {
    this.ftpConfigs.set(id, { ...config, name });
  }

  unregisterFtpDevice(id: string): void {
    this.ftpConfigs.delete(id);
  }

  async listFtpDirectory(deviceId: string, remotePath: string = '/'): Promise<{ currentPath: string; items: FileItem[] }> {
    const cfg = this.ftpConfigs.get(deviceId);
    if (!cfg) {
      throw new Error(`FTP device ${deviceId} not found or disconnected`);
    }

    const client = new SimpleFtpClient(cfg);
    const normalizedPath = remotePath.replace(/^ftp:\/\/[^/]+/, '') || '/';
    const entries = await client.list(normalizedPath);

    const items: FileItem[] = entries.map(e => {
      const cleanDir = normalizedPath.endsWith('/') ? normalizedPath : normalizedPath + '/';
      const fullPath = `ftp://${deviceId}${cleanDir === '/' ? '/' : cleanDir}${e.name}`;
      return {
        name: e.name,
        path: fullPath,
        size: e.size,
        isDirectory: e.isDirectory,
        mtime: e.mtime,
      };
    });

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });

    return {
      currentPath: `ftp://${deviceId}${normalizedPath.startsWith('/') ? normalizedPath : '/' + normalizedPath}`,
      items,
    };
  }

  async downloadFtpItem(
    deviceId: string,
    remotePath: string,
    localDestDir: string,
    onProgress?: (bytes: number) => void
  ): Promise<{ skippedFiles: Array<{ name: string; reason: string }> }> {
    const cfg = this.ftpConfigs.get(deviceId);
    if (!cfg) throw new Error(`FTP device ${deviceId} not found`);
    const client = new SimpleFtpClient(cfg);

    const normalizedRemote = remotePath.replace(/^ftp:\/\/[^/]+/, '') || '/';
    const remoteBaseName = path.posix.basename(normalizedRemote) || 'download';
    const localTarget = path.join(localDestDir, process.platform === 'win32' ? sanitizeWindowsFilename(remoteBaseName) : remoteBaseName);

    console.log('[FTP Download] remotePath:', remotePath, 'normalized:', normalizedRemote, 'target:', localTarget);
    let isDir = false;
    try {
      // 1. Try direct listing of the remote path — if it succeeds, it's a directory!
      await client.list(normalizedRemote);
      isDir = true;
    } catch (_) {
      // 2. Otherwise check parent listing
      try {
        const parentDir = path.posix.dirname(normalizedRemote);
        const siblings = await client.list(parentDir === '.' ? '/' : parentDir);
        const normalizeClean = (s: string) => s.replace(/[\uFFFD\u00A0\s_+\-\[\]().#]/g, '').toLowerCase();
        const targetClean = normalizeClean(remoteBaseName);
        const targetEntry = siblings.find(s => {
          if (s.name === remoteBaseName) return true;
          return targetClean.length > 3 && normalizeClean(s.name) === targetClean;
        });
        if (targetEntry && targetEntry.isDirectory) isDir = true;
      } catch (e) {
        console.warn('[FTP Download] directory check failed, assuming file:', e);
      }
    }

    const skippedFiles: Array<{ name: string; reason: string }> = [];

    if (isDir) {
      // Pre-calculate total folder bytes so progress reflects true folder size
      let folderTotalBytes = 0;
      const scanFolderBytes = async (dir: string) => {
        try {
          const items = await client.list(dir);
          for (const it of items) {
            if (it.isDirectory) {
              await scanFolderBytes(dir.endsWith('/') ? dir + it.name : dir + '/' + it.name);
            } else if (it.size > 0) {
              folderTotalBytes += it.size;
            }
          }
        } catch (_) {}
      };
      await scanFolderBytes(normalizedRemote);
      if (folderTotalBytes > 0 && (onProgress as any)?.setTotalBytes) {
        (onProgress as any).setTotalBytes(folderTotalBytes);
      }
      const walkDownload = async (remDir: string, locDir: string) => {
        await fs.mkdir(locDir, { recursive: true });
        const list = await client.list(remDir);
        for (const item of list) {
          const itemRem = remDir.endsWith('/') ? remDir + item.name : remDir + '/' + item.name;
          const cleanItemName = process.platform === 'win32' ? sanitizeWindowsFilename(item.name) : item.name;
          const itemLoc = path.join(locDir, cleanItemName);
          if (item.isDirectory) {
            await walkDownload(itemRem, itemLoc);
          } else {
            try {
              await client.downloadFile(itemRem, itemLoc, onProgress);
            } catch (err: any) {
              const errMsg = err?.message || String(err);
              let reason = errMsg;
              if (item.name.includes('?') || errMsg.includes('550')) {
                reason = "Phone's FTP server rejects files with special/trademark characters (?) in their name.";
              }
              skippedFiles.push({ name: item.name, reason });
              console.warn(`[FTP Download] Skipped file "${item.name}":`, reason);
            }
          }
        }
      };
      await walkDownload(normalizedRemote, localTarget);
    } else {
      await client.downloadFile(normalizedRemote, localTarget, onProgress);
    }

    return { skippedFiles };
  }

  async uploadToFtp(
    deviceId: string,
    localSourcePath: string,
    remoteDestDir: string,
    onProgress?: (bytes: number) => void
  ): Promise<void> {
    const cfg = this.ftpConfigs.get(deviceId);
    if (!cfg) throw new Error(`FTP device ${deviceId} not found`);
    const client = new SimpleFtpClient(cfg);

    const normalizedRemoteDir = remoteDestDir.replace(/^ftp:\/\/[^/]+/, '') || '/';
    const stat = await fs.stat(localSourcePath);
    const baseName = path.basename(localSourcePath);

    if (stat.isDirectory()) {
      const walkUpload = async (locDir: string, remDir: string) => {
        const files = await fs.readdir(locDir, { withFileTypes: true });
        for (const f of files) {
          const locChild = path.join(locDir, f.name);
          const remChild = remDir.endsWith('/') ? remDir + f.name : remDir + '/' + f.name;
          if (f.isDirectory()) {
            await walkUpload(locChild, remChild);
          } else {
            await client.uploadFile(locChild, remChild, onProgress);
          }
        }
      };
      const destFolder = normalizedRemoteDir.endsWith('/') ? normalizedRemoteDir + baseName : normalizedRemoteDir + '/' + baseName;
      await walkUpload(localSourcePath, destFolder);
    } else {
      const destFile = normalizedRemoteDir.endsWith('/') ? normalizedRemoteDir + baseName : normalizedRemoteDir + '/' + baseName;
      await client.uploadFile(localSourcePath, destFile, onProgress);
    }
  }

  listPhoneDirectory(deviceId: string, subPath: string = ''): { currentPath: string; items: FileItem[] } {
    const drive = this.phoneVirtualDrives.get(deviceId);
    if (!drive) {
      return { currentPath: subPath, items: [] };
    }

    const cleanSub = subPath.replace(/^\/+|\/+$/g, '');
    const prefix = cleanSub ? cleanSub + '/' : '';
    const items: FileItem[] = [];
    const directChildren = new Set<string>();

    for (const [relPath, entry] of drive.entries.entries()) {
      if (!relPath.startsWith(prefix) && prefix !== '') continue;
      const remainder = relPath.slice(prefix.length);
      if (!remainder) continue;
      const parts = remainder.split('/');
      const childName = parts[0];

      if (directChildren.has(childName)) continue;
      directChildren.add(childName);

      const isDir = parts.length > 1 || entry.isDirectory;
      items.push({
        name: childName,
        path: `phone://${deviceId}/${cleanSub ? cleanSub + '/' : ''}${childName}`,
        size: isDir ? 0 : entry.size,
        isDirectory: isDir,
        mtime: entry.mtime,
        phoneFileId: isDir ? undefined : entry.id,
      });
    }

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });

    return { currentPath: `phone://${deviceId}/${cleanSub}`, items };
  }
}

export const explorerService = new ExplorerService();
