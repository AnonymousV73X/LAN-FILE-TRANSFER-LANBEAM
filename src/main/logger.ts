/**
 * LANBeam - debug logger.
 * Writes to <userData>/lanbeam-debug.log, truncated (flushed) on each start.
 * Import `log` anywhere and call log.info/warn/error/debug.
 */
import { promises as fs, createWriteStream, WriteStream } from 'fs';
import * as path from 'path';
import { app } from 'electron';

let stream: WriteStream | null = null;
let logPath = '';

export async function initLogger(): Promise<void> {
  logPath = path.join(app.getPath('userData'), 'lanbeam-debug.log');
  // Truncate (flush) on every start so stale logs don't accumulate.
  await fs.writeFile(logPath, '=== LANBeam debug log started at ' + new Date().toISOString() + ' ===\n');
  stream = createWriteStream(logPath, { flags: 'a' });
  write('INFO ', 'Logger initialized. Log path:', logPath);
}

export function getLogPath(): string { return logPath; }

function write(level: string, ...args: unknown[]) {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' +
    args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') + '\n';
  process.stdout.write(line);
  stream?.write(line);
}

export const log = {
  info:  (...a: unknown[]) => write('INFO ', ...a),
  warn:  (...a: unknown[]) => write('WARN ', ...a),
  error: (...a: unknown[]) => write('ERROR', ...a),
  debug: (...a: unknown[]) => write('DEBUG', ...a),
};