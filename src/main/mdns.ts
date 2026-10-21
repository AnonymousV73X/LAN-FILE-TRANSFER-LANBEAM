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
  private ownDeviceId = '';

  /**
   * Advertise the HTTP server.
   *
   * `host` is the PERMANENT hostname published as an A record (e.g.
   * 'lanbeam.local'). bonjour-service answers mDNS A queries for that name
   * with every non-internal IPv4 of this machine, so phones can keep using
   * http://<host>:<port> forever — even after DHCP hands the desktop a new
   * IP. That stable URL is what makes Remember-Me reconnects survive months:
   * bookmarks / home-screen icons never go stale again.
   */
  advertise(port: number, deviceId: string, appVersion: string, host?: string): void {
    this.ownDeviceId = deviceId;
    if (this.published) {
      this.published.stop();
      this.published = null;
    }
    const publishedHost = host || hostname();
    const svc = this.bonjour.publish({
      name: `lanbeam-${deviceId.slice(0, 8)}`,
      host: publishedHost,
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL,
      port,
      txt: {
        host: publishedHost,
        deviceId,
        appVersion,
      },
    });
    this.published = svc;
  }

  /**
   * Resolve once the published service is actually on the wire (first
   * announce round sent). bonjour emits 'up' on the Service; if it already
   * announced before this call, fires immediately. Used by the boot sequence
   * to decide between the permanent mDNS URL and the direct-IP fallback.
   */
  onPublished(cb: () => void): void {
    if (!this.published) return;
    if (this.published.published) { cb(); return; }
    this.published.once('up', cb);
  }

  browse(): void {
    if (this.browser) return;
    const browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL });
    this.browser = browser;
    browser.on('up', (service: Service) => {
      const txt = service.txt ?? {};
      const deviceId = String(txt.deviceId ?? service.name);
      if (deviceId === this.ownDeviceId) return;
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
