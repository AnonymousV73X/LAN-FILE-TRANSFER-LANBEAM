import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

export interface FtpEntry {
  name: string;
  rawName?: Buffer;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

export interface FtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
}

export class SimpleFtpClient {
  private config: FtpConfig;

  constructor(config: FtpConfig) {
    this.config = {
      user: 'anonymous',
      password: 'anonymous@lanbeam.local',
      ...config,
      port: config.port || 21,
    };
  }

  private connectControl(): Promise<{
    socket: net.Socket;
    sendCmd: (cmd: string | Buffer) => Promise<{ code: number; text: string }>;
    readReply: () => Promise<{ code: number; text: string }>;
    close: () => void;
  }> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(60000);

      let buffer = '';
      const responseQueue: { code: number; text: string }[] = [];
      const waiters: { resolve: (res: { code: number; text: string }) => void; reject: (err: Error) => void }[] = [];

      const onData = (chunk: Buffer) => {
        socket.setTimeout(60000); // reset timeout on receiving any data
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\r\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const match = line.match(/^(\d{3})\s+(.*)$/);
          if (match) {
            const res = { code: parseInt(match[1], 10), text: match[2] };
            if (waiters.length > 0) {
              const waiter = waiters.shift()!;
              waiter.resolve(res);
            } else {
              responseQueue.push(res);
            }
          }
        }
      };

      socket.on('data', onData);
      socket.on('timeout', () => {
        socket.destroy();
        const err = new Error('FTP control socket timeout');
        while (waiters.length > 0) waiters.shift()!.reject(err);
        reject(err);
      });
      socket.on('error', (err: any) => {
        let msg = err.message;
        if (err.code === 'ECONNREFUSED') {
          msg = `Connection refused at ${this.config.host}:${this.config.port}. Check if FTP server is running on the phone and the port matches.`;
        } else if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
          msg = `Host unreachable at ${this.config.host}. Make sure PC and phone are on the same Wi-Fi.`;
        }
        const customErr = new Error(msg);
        while (waiters.length > 0) waiters.shift()!.reject(customErr);
        reject(customErr);
      });

      const readReply = (): Promise<{ code: number; text: string }> => {
        if (responseQueue.length > 0) {
          return Promise.resolve(responseQueue.shift()!);
        }
        return new Promise((res, rej) => {
          waiters.push({ resolve: res, reject: rej });
        });
      };

      const sendCmd = (cmd: string | Buffer): Promise<{ code: number; text: string }> => {
        socket.setTimeout(60000);
        const toWrite = typeof cmd === 'string' ? cmd + '\r\n' : Buffer.concat([cmd, Buffer.from('\r\n')]);
        socket.write(toWrite);
        return readReply();
      };

      const close = () => {
        try {
          socket.write('QUIT\r\n');
        } catch (_) {}
        socket.destroy();
      };

      waiters.push({
        resolve: () => resolve({ socket, sendCmd, readReply, close }),
        reject,
      });

      socket.connect(this.config.port, this.config.host);
    });
  }

  private async openDataConnection(sendCmd: (cmd: string) => Promise<{ code: number; text: string }>): Promise<{
    dataHost: string;
    dataPort: number;
  }> {
    const pasvRes = await sendCmd('PASV');
    if (pasvRes.code !== 227) {
      throw new Error(`PASV failed with code ${pasvRes.code}: ${pasvRes.text}`);
    }
    const match = pasvRes.text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!match) {
      throw new Error(`Could not parse PASV response: ${pasvRes.text}`);
    }
    // Most mobile FTP servers report their own internal or 0.0.0.0 address in PASV.
    // Standard FTP client best practice: connect data socket to the same host as control socket.
    const reportedHost = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
    const dataHost = (reportedHost === '0.0.0.0' || reportedHost === '127.0.0.1') ? this.config.host : (this.config.host || reportedHost);
    const dataPort = (parseInt(match[5], 10) << 8) + parseInt(match[6], 10);
    return { dataHost, dataPort };
  }

  private async authenticate(sendCmd: (cmd: string) => Promise<{ code: number; text: string }>) {
    const userRes = await sendCmd(`USER ${this.config.user || 'anonymous'}`);
    if (userRes.code === 331) {
      const passRes = await sendCmd(`PASS ${this.config.password || ''}`);
      if (passRes.code === 530) {
        throw new Error('Authentication failed (Incorrect username or password)');
      } else if (passRes.code >= 400) {
        throw new Error(`Password rejected (${passRes.code}: ${passRes.text})`);
      }
    } else if (userRes.code === 530) {
      throw new Error('Login incorrect / User denied by FTP server');
    } else if (userRes.code >= 400 && userRes.code !== 230) {
      throw new Error(`User rejected (${userRes.code}: ${userRes.text})`);
    }

    await sendCmd('TYPE I');
    try {
      await sendCmd('OPTS UTF8 ON');
    } catch (_) {}
  }

  async list(remotePath: string = '/'): Promise<FtpEntry[]> {
    const { sendCmd, readReply, close } = await this.connectControl();

    try {
      await this.authenticate(sendCmd);

      const target = remotePath || '/';
      if (target !== '/') {
        await sendCmd(`CWD ${target}`);
      }

      const { dataHost, dataPort } = await this.openDataConnection(sendCmd);

      const dataPromise = new Promise<Buffer>((resolveData, rejectData) => {
        const dataSocket = new net.Socket();
        const chunks: Buffer[] = [];
        dataSocket.setTimeout(12000);

        dataSocket.on('data', (d) => chunks.push(d));
        dataSocket.on('end', () => resolveData(Buffer.concat(chunks)));
        dataSocket.on('timeout', () => {
          dataSocket.destroy();
          rejectData(new Error('FTP data socket timeout'));
        });
        dataSocket.on('error', rejectData);

        dataSocket.connect(dataPort, dataHost);
      });

      await sendCmd('LIST -a');
      const dataBuffer = await dataPromise;
      // Wait for server's "226 Data transmission OK" response
      try {
        await readReply();
      } catch (_) {}
      return this.parseListing(dataBuffer);
    } finally {
      close();
    }
  }

  async downloadFile(
    remoteFilePath: string,
    localDestPath: string,
    onProgress?: (bytesTransferred: number) => void
  ): Promise<void> {
    const { socket: ctrlSocket, sendCmd, readReply, close } = await this.connectControl();

    try {
      await this.authenticate(sendCmd);

      const remoteDir = path.posix.dirname(remoteFilePath);
      const remoteName = path.posix.basename(remoteFilePath);
      if (remoteDir && remoteDir !== '.' && remoteDir !== '/') {
        await sendCmd(`CWD ${remoteDir}`);
      }

      // Check listing in remoteDir to get exact raw bytes for non-UTF8 / custom-encoded filenames
      let exactRetrCmd: Buffer = Buffer.concat([Buffer.from('RETR '), Buffer.from(remoteName, 'utf8')]);
      try {
        const { dataHost: lHost, dataPort: lPort } = await this.openDataConnection(sendCmd);
        const listBufPromise = new Promise<Buffer>((res, rej) => {
          const s = new net.Socket();
          const parts: Buffer[] = [];
          s.on('data', d => parts.push(d));
          s.on('end', () => res(Buffer.concat(parts)));
          s.on('error', rej);
          s.connect(lPort, lHost);
        });
        await sendCmd('LIST');
        const listBuffer = await listBufPromise;
        try {
          await readReply();
        } catch (_) {}
        const entries = this.parseListing(listBuffer);
        const normalizeForMatch = (s: string) => s.replace(/[\uFFFD\u00A0\s_+\-\[\]().]/g, '').toLowerCase();
        const targetClean = normalizeForMatch(remoteName);
        const match = entries.find(e => {
          if (e.name === remoteName) return true;
          if (e.rawName?.toString('binary') === Buffer.from(remoteName, 'binary').toString('binary')) return true;
          return targetClean.length > 5 && normalizeForMatch(e.name) === targetClean;
        });
        if (match && match.rawName) {
          exactRetrCmd = Buffer.concat([Buffer.from('RETR '), match.rawName]);
        }
      } catch (listErr) {
        console.warn('[FTP] list fallback failed, using standard name:', listErr);
      }

      const { dataHost, dataPort } = await this.openDataConnection(sendCmd);

      await fs.promises.mkdir(path.dirname(localDestPath), { recursive: true });
      const outStream = fs.createWriteStream(localDestPath, { highWaterMark: 1024 * 1024 });

      const dataPromise = new Promise<void>((resolveData, rejectData) => {
        const dataSocket = new net.Socket();
        dataSocket.setNoDelay(true);
        let finished = false;

        const done = (err?: Error) => {
          if (finished) return;
          finished = true;
          outStream.end();
          if (err) {
            dataSocket.destroy();
            rejectData(err);
          } else {
            resolveData();
          }
        };

        dataSocket.on('connect', () => {
          dataSocket.setTimeout(0);
        });

        dataSocket.on('data', (chunk) => {
          const canWrite = outStream.write(chunk);
          onProgress?.(chunk.length);
          if (!canWrite) {
            dataSocket.pause();
            outStream.once('drain', () => {
              dataSocket.resume();
            });
          }
        });

        dataSocket.on('end', () => done());
        dataSocket.on('close', () => done());
        dataSocket.on('error', (err) => done(err));

        dataSocket.connect(dataPort, dataHost);
      });

      // Send RETR and handle intermediate 150/125 followed by 226/250 transfer complete
      const retrStart = await sendCmd(exactRetrCmd);
      if (retrStart.code >= 400) {
        throw new Error(`FTP RETR rejected: ${retrStart.code} ${retrStart.text}`);
      }
      // Disable control socket timeout while bulk transfer is in flight
      ctrlSocket.setTimeout(0);
      const retrDonePromise = (retrStart.code === 226 || retrStart.code === 250)
        ? Promise.resolve(retrStart)
        : readReply().then((res) => {
            if (res.code >= 400) throw new Error(`FTP RETR error: ${res.code} ${res.text}`);
            return res;
          });

      await Promise.all([dataPromise, retrDonePromise]);
    } finally {
      close();
    }
  }

  async uploadFile(
    localFilePath: string,
    remoteDestPath: string,
    onProgress?: (bytesTransferred: number) => void
  ): Promise<void> {
    const { socket: ctrlSocket, sendCmd, readReply, close } = await this.connectControl();

    try {
      await this.authenticate(sendCmd);

      const remoteDir = path.posix.dirname(remoteDestPath);
      const remoteName = path.posix.basename(remoteDestPath);
      if (remoteDir && remoteDir !== '.' && remoteDir !== '/') {
        await this.ensureRemoteDir(sendCmd, remoteDir);
        await sendCmd(`CWD ${remoteDir}`);
      }

      const { dataHost, dataPort } = await this.openDataConnection(sendCmd);

      const inStream = fs.createReadStream(localFilePath, { highWaterMark: 1024 * 1024 });

      const dataPromise = new Promise<void>((resolveData, rejectData) => {
        const dataSocket = new net.Socket();
        dataSocket.setNoDelay(true);
        dataSocket.setTimeout(30000);

        dataSocket.on('connect', () => {
          dataSocket.setTimeout(0); // clear timeout once connected — data flow keeps the socket alive
          inStream.on('data', (chunk: Buffer | string) => {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            const canWrite = dataSocket.write(buf);
            onProgress?.(buf.length);

            if (!canWrite) {
              inStream.pause();
              dataSocket.once('drain', () => {
                inStream.resume();
              });
            }
          });

          inStream.on('end', () => {
            dataSocket.end();
          });

          inStream.on('error', (err) => {
            dataSocket.destroy();
            rejectData(err);
          });
        });

        dataSocket.on('close', () => resolveData());
        dataSocket.on('end', () => resolveData());
        dataSocket.on('timeout', () => {
          dataSocket.destroy();
          inStream.destroy();
          rejectData(new Error('FTP upload socket timeout'));
        });
        dataSocket.on('error', rejectData);

        dataSocket.connect(dataPort, dataHost);
      });

      const storStart = await sendCmd(`STOR ${remoteName}`);
      if (storStart.code >= 400) {
        throw new Error(`FTP STOR rejected: ${storStart.code} ${storStart.text}`);
      }
      ctrlSocket.setTimeout(0);
      const storDonePromise = (storStart.code === 226 || storStart.code === 250)
        ? Promise.resolve(storStart)
        : readReply().then((res) => {
            if (res.code >= 400) throw new Error(`FTP STOR error: ${res.code} ${res.text}`);
            return res;
          });

      await Promise.all([dataPromise, storDonePromise]);
    } finally {
      close();
    }
  }

  private async ensureRemoteDir(sendCmd: (cmd: string) => Promise<{ code: number; text: string }>, remotePath: string) {
    const parts = remotePath.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      try {
        await sendCmd(`MKD ${cur}`);
      } catch (_) {}
    }
  }

  private decodeFilename(rawName: Buffer): string {
    // Try UTF-8 first (strict without replacement characters)
    try {
      const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
      return utf8Decoder.decode(rawName);
    } catch (_) {}

    // Next try GB18030 / GBK (standard encoding for Chinese Android FTP servers like SwiFTP)
    try {
      const gbkDecoder = new TextDecoder('gb18030', { fatal: true });
      return gbkDecoder.decode(rawName);
    } catch (_) {}

    // Fallback to UTF-8 with replacement or binary
    return rawName.toString('utf8');
  }

  private parseListing(rawInput: Buffer | string): FtpEntry[] {
    const rawBuf = typeof rawInput === 'string' ? Buffer.from(rawInput, 'utf8') : rawInput;
    const binaryStr = rawBuf.toString('binary');
    const lines = binaryStr.split(/\r?\n/);
    const results: FtpEntry[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('total ')) continue;

      const unixMatch = trimmed.match(/^([drwxls\-]{10})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3}\s+\d+\s+[\d:]+)\s+(.+)$/);
      if (unixMatch) {
        const isDir = unixMatch[1].startsWith('d') || unixMatch[1].startsWith('l');
        const size = parseInt(unixMatch[2], 10) || 0;
        const rawNameBinary = unixMatch[4].trim();
        if (rawNameBinary === '.' || rawNameBinary === '..') continue;
        const rawName = Buffer.from(rawNameBinary, 'binary');
        const name = this.decodeFilename(rawName);
        results.push({ name, rawName, isDirectory: isDir, size, mtime: Date.now() });
        continue;
      }

      const dosMatch = trimmed.match(/^(\d{2}[-/]\d{2}[-/]\d{2,4}\s+\d{2}:\d{2}(?:[AP]M)?)\s+(<DIR>|\d+)\s+(.+)$/i);
      if (dosMatch) {
        const isDir = dosMatch[2].toUpperCase() === '<DIR>';
        const size = isDir ? 0 : parseInt(dosMatch[2], 10) || 0;
        const rawNameBinary = dosMatch[3].trim();
        if (rawNameBinary === '.' || rawNameBinary === '..') continue;
        const rawName = Buffer.from(rawNameBinary, 'binary');
        const name = this.decodeFilename(rawName);
        results.push({ name, rawName, isDirectory: isDir, size, mtime: Date.now() });
        continue;
      }

      const parts = trimmed.split(/\s+/);
      if (parts.length >= 4) {
        const rawNameBinary = parts.slice(3).join(' ');
        if (rawNameBinary === '.' || rawNameBinary === '..') continue;
        const rawName = Buffer.from(rawNameBinary, 'binary');
        const name = this.decodeFilename(rawName);
        results.push({ name, rawName, isDirectory: trimmed.toLowerCase().includes('dir'), size: 0, mtime: Date.now() });
      }
    }

    return results;
  }
}
