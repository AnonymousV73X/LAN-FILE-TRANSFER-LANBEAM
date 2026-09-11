/**
 * LANBeam — pairing / token management.
 *
 * Pairing model:
 *  - Desktop generates a one-time-use pairing token (32 bytes random, base64url).
 *  - Token is encoded into a QR URL: http://<hostname>.local:<port>/pair?token=<token>
 *  - Phone scans the QR, browser POSTs the token back to /api/pair with its device info.
 *  - The server validates the token (must exist + not yet used + within expiry window),
 *    registers the paired device (incl. fingerprint), and invalidates the token.
 *  - All subsequent transfers from that device use HTTP/TLS + a persistent
 *    session cookie that the desktop verifies against the paired device record.
 *
 * Security:
 *  - Tokens expire after 5 minutes or first successful use — whichever comes first.
 *  - No file transfer proceeds without an explicit accept on the receiving side
 *    from a paired device. Unpaired device requests are rejected with 401.
 */
import { randomBytes, createHash } from 'crypto';
import { EventEmitter } from 'events';
import type { PairedDevice } from './store';

const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;

export interface PendingToken {
  token: string;
  createdAt: number;
  consumed: boolean;
}

export interface PairingRequest {
  deviceId: string;
  name: string;
  kind: 'phone' | 'desktop' | 'unknown';
  publicKey?: string; // stretch: future ECDH handshake
}

export class PairingManager extends EventEmitter {
  private pending = new Map<string, PendingToken>();

  issueToken(): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.pending.set(token, { token, createdAt: Date.now(), consumed: false });
    // Auto-expire sweep
    setTimeout(() => this.pending.delete(token), TOKEN_TTL_MS + 60_000);
    return token;
  }

  buildQrUrl(baseUrl: string): { url: string; token: string } {
    const token = this.issueToken();
    const url = `${baseUrl}/pair?token=${token}`;
    return { url, token };
  }

  /**
   * Validate the presented token and consume it.
   * Returns true if valid+unused+within TTL, false otherwise.
   * On success, the caller is expected to persist the paired device record.
   */
  consumeToken(token: string): boolean {
    const entry = this.pending.get(token);
    if (!entry) return false;
    if (entry.consumed) return false;
    if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
      this.pending.delete(token);
      return false;
    }
    entry.consumed = true;
    this.pending.delete(token);
    return true;
  }

  /** Compute a deterministic fingerprint for a paired device (sha256 of pubkey or deviceId). */
  fingerprintFor(req: PairingRequest): string {
    const seed = req.publicKey ?? req.deviceId;
    return createHash('sha256').update(seed).digest('hex');
  }

  /** Build a PairedDevice record from a request. Caller is responsible for persisting. */
  toPairedDevice(req: PairingRequest): PairedDevice {
    return {
      deviceId: req.deviceId,
      name: req.name,
      kind: req.kind,
      fingerprint: this.fingerprintFor(req),
      pairedAt: Date.now(),
      lastSeen: Date.now(),
    };
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
