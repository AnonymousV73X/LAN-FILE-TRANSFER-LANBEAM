/**
 * LANBeam — mDNS / Zeroconf discovery.
 *
 * Advertises the local LANBeam instance on _lanbeam._tcp.local and browses
 * for other instances so the desktop↔desktop peer list works without extra
 * plumbing later.
 *
 * TXT records carry: hostname, port, deviceId, app version. The pairing token
 * is NEVER published via mDNS — it is exchanged only over a TLS-protected
 * pairing HTTP endpoint.
 */
import { Bonjour, Service, Browser } from 'bonjour-service';
import { hostname } from 'os';

export const SERVICE_TYPE = 'lanbeam';
export const SERVICE_PROTOCOL = 'tcp';

export interface DiscoveredPeer {
  deviceId: string;
  name: string;
  host: string;
  addresses: string[];
  port: number;
  appVersion?: string;
  lastSeen: number;
}

export class MdnsService {
  private bonjour = new Bonjour();
  private published: Service | null = null;
  private browser: Browser | null = null;
  private peers = new Map<string, DiscoveredPeer>();
  private listeners = new Set<(peers: DiscoveredPeer[]) => void>();

  advertise(port: number, deviceId: string, appVersion: string): void {
    if (this.published) {
      this.published.stop();
      this.published = null;
    }
    const svc = this.bonjour.publish({
      name: `lanbeam-${deviceId.slice(0, 8)}`,
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL,
      port,
      txt: {
        host: hostname(),
        deviceId,
        appVersion,
      },
    });
    this.published = svc;
  }

  browse(): void {
    if (this.browser) return;
    const browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL });
    this.browser = browser;
    browser.on('up', (service: Service) => {
      const txt = service.txt ?? {};
      const deviceId = String(txt.deviceId ?? service.name);
      const peer: DiscoveredPeer = {
        deviceId,
        name: service.name,
        host: String(txt.host ?? ''),
        addresses: service.addresses ?? [],
        port: service.port,
        appVersion: txt.appVersion ? String(txt.appVersion) : undefined,
        lastSeen: Date.now(),
      };
      this.peers.set(deviceId, peer);
      this.emit();
    });
    this.browser.on('down', (service: Service) => {
      const txt = service.txt ?? {};
      const deviceId = String(txt.deviceId ?? service.name);
      this.peers.delete(deviceId);
      this.emit();
    });
  }

  onPeersChanged(cb: (peers: DiscoveredPeer[]) => void): () => void {
    this.listeners.add(cb);
    cb([...this.peers.values()]);
    return () => { this.listeners.delete(cb); };
  }

  private emit(): void {
    const list = [...this.peers.values()];
    this.listeners.forEach(l => l(list));
  }

  stop(): void {
    this.published?.stop();
    this.browser?.stop();
    this.published = null;
    this.browser = null;
    this.peers.clear();
  }
}
