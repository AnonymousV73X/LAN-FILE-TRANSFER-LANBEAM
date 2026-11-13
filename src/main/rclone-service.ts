import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as https from 'https';
import { app } from 'electron';
import { log } from './logger';

export interface CloudProfile {
  id: string;
  name: string;
  rcloneConfig: string; // rclone.conf content with [PIKKY] and [GDRIVE] etc.
  localPath?: string;
  createdAt?: string;
}

export interface CloudRemoteItem {
  Path: string;
  Name: string;
  Size: number;
  MimeType?: string;
  ModTime?: string;
  IsDir: boolean;
}

export interface TransferStats {
  transferred: string;
  total: string;
  progressPct: number;
  speed: string;
  eta: string;
}

export interface TransferJobStatus {
  jobId: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped';
  source: string;
  destination: string;
  stats: TransferStats;
  error?: string;
  logs: string[];
}

export class RcloneService {
  private static instance: RcloneService;
  private configDir: string;
  private profilesFile: string;
  private activeJobs: Map<string, {
    process?: ChildProcess;
    bridgeProcess?: ChildProcess;
    status: TransferJobStatus;
    onProgress?: (status: TransferJobStatus) => void;
  }> = new Map();

  private constructor() {
    this.configDir = path.join(app.getPath('userData'), 'rclone');
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
    this.profilesFile = path.join(this.configDir, 'profiles.json');
    if (!fs.existsSync(this.profilesFile)) {
      fs.writeFileSync(this.profilesFile, JSON.stringify([]));
    }
  }

  public static getInstance(): RcloneService {
    if (!RcloneService.instance) {
      RcloneService.instance = new RcloneService();
    }
    return RcloneService.instance;
  }

  public getRcloneBinary(): string {
    const binName = process.platform === 'win32' ? 'rclone.exe' : 'rclone';
    const possiblePaths = [
      path.join(this.configDir, 'bin', binName),
      path.join(process.resourcesPath || '', binName),
      path.join(app.getAppPath(), 'native', binName),
      path.join(app.getAppPath(), binName),
      binName
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }
    return binName;
  }

  public async ensureInstalled(onProgress?: (msg: string) => void): Promise<string> {
    const existing = this.getRcloneBinary();
    if (existing !== 'rclone.exe' && existing !== 'rclone' && fs.existsSync(existing)) {
      return existing;
    }

    // Try system PATH first
    const pathCheck = await new Promise<boolean>((resolve) => {
      const p = spawn(existing, ['version'], { windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', code => resolve(code === 0));
    });
    if (pathCheck) return existing;

    // Download and install automatically into userData/rclone/bin
    const binDir = path.join(this.configDir, 'bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }
    const binName = process.platform === 'win32' ? 'rclone.exe' : 'rclone';
    const targetBin = path.join(binDir, binName);

    onProgress?.('Fetching rclone release for Windows...');
    const zipUrl = 'https://downloads.rclone.org/rclone-current-windows-amd64.zip';
    const zipPath = path.join(binDir, 'rclone-download.zip');

    await this.downloadFile(zipUrl, zipPath, (downloaded, total) => {
      const pct = total ? Math.floor((downloaded * 100) / total) : 0;
      onProgress?.(`Downloading rclone: ${pct}%...`);
    });

    onProgress?.('Extracting rclone engine...');
    await this.extractRcloneZip(zipPath, binDir, binName, targetBin);
    try { fs.unlinkSync(zipPath); } catch {}

    onProgress?.('Rclone engine ready.');
    return targetBin;
  }

  private downloadFile(url: string, dest: string, onProgress?: (dl: number, tot: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const get = (targetUrl: string) => {
        https.get(targetUrl, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed with HTTP ${res.statusCode}`));
            return;
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let downloaded = 0;
          const file = fs.createWriteStream(dest);

          res.on('data', chunk => {
            downloaded += chunk.length;
            onProgress?.(downloaded, total);
          });
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => resolve());
          });
        }).on('error', reject);
      };
      get(url);
    });
  }

  private extractRcloneZip(zipPath: string, binDir: string, binName: string, targetBin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use powershell Expand-Archive built into Windows to avoid extra npm dependencies
      const cmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${binDir}" -Force`;
      const proc = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true });
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            // Find extracted rclone-v*-windows-amd64 directory
            const entries = fs.readdirSync(binDir);
            const rcloneFolder = entries.find(e => e.startsWith('rclone-') && fs.statSync(path.join(binDir, e)).isDirectory());
            if (rcloneFolder) {
              const srcExe = path.join(binDir, rcloneFolder, binName);
              if (fs.existsSync(srcExe)) {
                fs.copyFileSync(srcExe, targetBin);
                // Clean up folder
                fs.rmSync(path.join(binDir, rcloneFolder), { recursive: true, force: true });
              }
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`Failed to extract rclone archive (code ${code})`));
        }
      });
    });
  }

  public listProfiles(): CloudProfile[] {
    try {
      return JSON.parse(fs.readFileSync(this.profilesFile, 'utf8'));
    } catch {
      return [];
    }
  }

  public saveProfile(profile: CloudProfile): void {
    const list = this.listProfiles();
    const idx = list.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...profile };
    } else {
      list.push(profile);
    }
    fs.writeFileSync(this.profilesFile, JSON.stringify(list, null, 2));
    this.writeConfigFile(profile);
  }

  public deleteProfile(profileId: string): void {
    const list = this.listProfiles().filter(p => p.id !== profileId);
    fs.writeFileSync(this.profilesFile, JSON.stringify(list, null, 2));
    const confPath = path.join(this.configDir, `${profileId}.conf`);
    if (fs.existsSync(confPath)) {
      fs.unlinkSync(confPath);
    }
  }

  public getProfileConfigPath(profileId: string): string {
    return path.join(this.configDir, `${profileId}.conf`);
  }

  private writeConfigFile(profile: CloudProfile): string {
    const confPath = this.getProfileConfigPath(profile.id);
    fs.writeFileSync(confPath, profile.rcloneConfig || '', 'utf8');
    return confPath;
  }

  private getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(port));
      });
    });
  }

  private formatBytes(b: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let val = b;
    for (const unit of units) {
      if (val < 1024) return `${val.toFixed(1)} ${unit}`;
      val /= 1024;
    }
    return `${val.toFixed(1)} PiB`;
  }

  private formatEta(s: number | null): string {
    if (s === null || isNaN(s)) return '—';
    const total = Math.floor(s);
    if (total < 60) return `${total}s`;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const sec = total % 60;
    return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m${sec.toString().padStart(2, '0')}s` : `${m}m${sec.toString().padStart(2, '0')}s`;
  }

  public async listRemoteFiles(profileId: string, remote: string, subPath: string = ''): Promise<CloudRemoteItem[]> {
    await this.ensureInstalled();
    const configPath = this.getProfileConfigPath(profileId);
    const target = remote === 'LOCAL' 
      ? subPath 
      : (subPath ? `${remote}:${subPath}` : `${remote}:`);

    return new Promise((resolve, reject) => {
      const rclone = this.getRcloneBinary();
      const args = [
        '--config', configPath,
        '--fast-list',
        '--no-modtime',
        '--no-mimetype',
        'lsjson', target
      ];
      const proc = spawn(rclone, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
      proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

      proc.on('close', code => {
        if (code === 0) {
          try {
            const data: CloudRemoteItem[] = JSON.parse(stdout);
            resolve(data);
          } catch (e: any) {
            reject(new Error(`Failed to parse lsjson output: ${e.message}`));
          }
        } else {
          reject(new Error(stderr || `lsjson exited with code ${code}`));
        }
      });
    });
  }

  public async startTransfer(
    profileId: string,
    sourceRemote: string,       // 'PIKKY', 'GDRIVE', or 'LOCAL'
    sourceSubPath: string,
    destRemote: string,         // 'PIKKY', 'GDRIVE', or 'LOCAL'
    destSubPath: string,
    selectedItems: string[] = [], // Relative paths or filenames
    onProgress?: (status: TransferJobStatus) => void
  ): Promise<string> {
    const profile = this.listProfiles().find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');

    const jobId = `transfer_${Date.now()}`;
    const jobStatus: TransferJobStatus = {
      jobId,
      status: 'running',
      source: `${sourceRemote}:${sourceSubPath}`,
      destination: `${destRemote}:${destSubPath}`,
      stats: { transferred: '0 B', total: '0 B', progressPct: 0, speed: '0 B/s', eta: '—' },
      logs: []
    };

    const jobRecord = { status: jobStatus, onProgress, process: undefined as ChildProcess | undefined, bridgeProcess: undefined as ChildProcess | undefined };
    this.activeJobs.set(jobId, jobRecord);

    this.runTransferProcess(profile, jobId, sourceRemote, sourceSubPath, destRemote, destSubPath, selectedItems);
    // Send immediate initial status event
    if (onProgress) {
      onProgress(jobStatus);
    }
    return jobId;
  }

  private async runTransferProcess(
    profile: CloudProfile,
    jobId: string,
    sourceRemote: string,
    sourceSubPath: string,
    destRemote: string,
    destSubPath: string,
    selectedItems: string[]
  ) {
    const record = this.activeJobs.get(jobId);
    if (!record) return;

    try {
      record.status.logs.push('[Engine] Initializing transfer runner...');
      record.onProgress?.(record.status);

      await this.ensureInstalled((m) => {
        record.status.logs.push(`[Setup] ${m}`);
        record.onProgress?.(record.status);
      });
      const rclone = this.getRcloneBinary();
      const configPath = this.getProfileConfigPath(profile.id);

      let effectiveSource = sourceRemote === 'LOCAL' ? sourceSubPath : `${sourceRemote}:${sourceSubPath}`;
      let effectiveDest = destRemote === 'LOCAL' ? destSubPath : `${destRemote}:${destSubPath}`;

      // If reading from PIKKY, spawn local WebDAV bridge to bypass server-side throttling
      if (sourceRemote === 'PIKKY') {
        const bridgePort = await this.getFreePort();
        record.status.logs.push(`[Bridge] Spawning PikPak loopback bridge on port ${bridgePort}...`);
        record.onProgress?.(record.status);
        
        const bridgeArgs = [
          '--config', configPath,
          'serve', 'webdav', 'PIKKY:',
          '--addr', `127.0.0.1:${bridgePort}`,
          '--read-only',
          '--no-modtime',
          '--log-level', 'ERROR'
        ];

        const bridgeProc = spawn(rclone, bridgeArgs, { windowsHide: true });
        record.bridgeProcess = bridgeProc;

        // Give the bridge up to 1.2s to bind
        await new Promise(r => setTimeout(r, 1200));

        // Create temporary in-memory/temp config with dynamic loopback remote
        const loopbackRemote = `PIKPAKDAV_${Date.now()}`;
        fs.appendFileSync(
          configPath,
          `\n[${loopbackRemote}]\ntype = webdav\nurl = http://127.0.0.1:${bridgePort}\nvendor = other\npacer_min_sleep = 0\n`
        );
        effectiveSource = sourceSubPath ? `${loopbackRemote}:${sourceSubPath}` : `${loopbackRemote}:`;
      }

      record.status.logs.push(`[Transfer] Connecting ${sourceRemote} -> ${destRemote}...`);
      record.onProgress?.(record.status);

      // Prepare copy command flags
      const transferArgs = [
        '--config', configPath,
        'copy', effectiveSource, effectiveDest,
        '--use-json-log',
        '--log-level', 'INFO',
        '--stats', '1s',
        '--stats-log-level', 'INFO',
        '--transfers', '1',
        '--checkers', '2',
        '--size-only',
        '--no-traverse',
        '--drive-chunk-size', '64M',
        '--drive-acknowledge-abuse',
        '--buffer-size', '32M'
      ];

      // Add file/folder selection filters if specified
      if (selectedItems && selectedItems.length > 0) {
        for (const item of selectedItems) {
          const clean = item.replace(/\\/g, '/').replace(/^\/+/, '');
          const isFile = /\.[^/]{1,10}$/.test(clean); // has extension → file
          if (isFile) {
            transferArgs.push('--include', clean);
          } else {
            // folder: include all contents + the folder itself
            transferArgs.push('--include', `${clean}/**`);
            transferArgs.push('--include', clean);
          }
        }
        transferArgs.push('--exclude', '*');
      }

      console.log('[Rclone Transfer] Executing:', rclone, transferArgs.join(' '));
      const proc = spawn(rclone, transferArgs, { windowsHide: true });
      record.process = proc;

      const handleOutput = (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.stats) {
              const total = data.stats.totalBytes || 0;
              const transferred = data.stats.bytes || 0;
              const speed = data.stats.speed || 0;
              const eta = data.stats.eta;
              const pct = total > 0 ? Math.floor((transferred * 100) / total) : 0;

              record.status.stats = {
                transferred: this.formatBytes(transferred),
                total: this.formatBytes(total),
                progressPct: pct,
                speed: `${this.formatBytes(speed)}/s`,
                eta: this.formatEta(eta)
              };

              // Show active transferring files
              const transferring = data.stats.transferring || [];
              let liveMsg = '';
              if (transferring.length > 0) {
                liveMsg = transferring.map((cur: any) => {
                  const fname = cur.name ? cur.name.split('/').pop() : cur.name || '?';
                  const pct2 = cur.size > 0 ? Math.min(100, Math.round((cur.bytes / cur.size) * 100)) : 0;
                  return `↑ ${fname} (${pct2}%)`;
                }).join('  ·  ');
              } else if (pct >= 100 && total > 0) {
                liveMsg = 'Verifying with destination...';
              } else if (total === 0) {
                liveMsg = 'Scanning files...';
              } else {
                liveMsg = `Moving to next file... (${this.formatBytes(transferred)} / ${this.formatBytes(total)})`;
              }

              if (liveMsg) {
                // Overwrite the last log entry if it's a live-status line, else push
                const last = record.status.logs[record.status.logs.length - 1] || '';
                const isLive = last.startsWith('↑ ') || last.startsWith('Scanning') || last.startsWith('Verifying') || last.startsWith('Moving') || last.startsWith('Committing');
                if (isLive) {
                  record.status.logs[record.status.logs.length - 1] = liveMsg;
                } else {
                  record.status.logs.push(liveMsg);
                }
              }

              record.onProgress?.(record.status);
            } else if (data.msg) {
              const lvl = (data.level || '').toLowerCase();
              if (lvl === 'warning' || lvl === 'error') {
                record.status.logs.push(`[${lvl}] ${data.msg}`);
                record.onProgress?.(record.status);
              }
            }
          } catch {
            // non-JSON line — ignore
          }
        }
      };

      proc.stdout.on('data', handleOutput);
      proc.stderr.on('data', handleOutput);

      proc.on('close', code => {
        this.cleanupBridge(record);
        if (record.status.status === 'completed') return; // already marked done
        if (code === 0) {
          record.status.status = 'completed';
          record.status.stats.progressPct = 100;
          record.status.logs.push('✓ All files delivered to destination');
        } else if (record.status.status !== 'stopped') {
          record.status.status = 'failed';
          record.status.error = `Process exited with error code ${code}`;
        }
        record.onProgress?.(record.status);
      });

    } catch (err: any) {
      this.cleanupBridge(record);
      record.status.status = 'failed';
      record.status.error = err.message;
      record.onProgress?.(record.status);
    }
  }

  private cleanupBridge(record: any) {
    if (record?.bridgeProcess) {
      try {
        record.bridgeProcess.kill();
      } catch {}
      record.bridgeProcess = undefined;
    }
  }

  public cancelTransfer(jobId: string): void {
    const record = this.activeJobs.get(jobId);
    if (record) {
      record.status.status = 'stopped';
      if (record.process) {
        try { record.process.kill(); } catch {}
      }
      this.cleanupBridge(record);
      record.onProgress?.(record.status);
    }
  }

  public getJobStatus(jobId: string): TransferJobStatus | undefined {
    return this.activeJobs.get(jobId)?.status;
  }
}
