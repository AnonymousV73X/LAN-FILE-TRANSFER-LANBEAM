/**
 * OS WiFi link info — surfaces the radio generation / band / channel width
 * so the UI can warn users on 2.4GHz or narrow channels where no software
 * trick can reach WiFi 5/6/7 ceilings.
 *
 * Each platform has its own CLI:
 *   - Windows: netsh wlan show interfaces
 *   - Linux:   iw dev <iface> link  (fallback: nmcli)
 *   - macOS:   airport -I  (or system_profiler SPAirPortDataType)
 *
 * Generation detection strategy (most → least reliable):
 *   1. Radio type from the OS (802.11ax → WiFi 6, 802.11ac → WiFi 5, ...)
 *   2. Bandwidth heuristic (channel width + band)
 *   3. 'Unknown' — the UI layers then omit the segment instead of printing
 *      a blank "Unknown" (that's what used to fill the phone footer with
 *      "Unknown · <ssid> ·  · 0 Mbps").
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface WifiLinkInfo {
  connected: boolean;
  ssid?: string;
  band?: '2.4GHz' | '5GHz' | '6GHz';
  channel?: number;
  channelWidthMHz?: number;
  phyRateMbps?: number;       // Theoretical link rate at the current MCS
  signalDbm?: number;
  generation?: 'WiFi 2' | 'WiFi 3' | 'WiFi 4' | 'WiFi 5' | 'WiFi 6' | 'WiFi 6E' | 'WiFi 7' | 'Unknown';
  raw?: string;               // For debugging
}

const generationFromBandwidth = (band: string, chanWidth: number, phy: number): WifiLinkInfo['generation'] => {
  if (band === '6GHz') return chanWidth >= 160 ? 'WiFi 7' : 'WiFi 6E';
  if (band === '5GHz') return chanWidth >= 160 ? 'WiFi 7' : chanWidth >= 80 ? 'WiFi 6' : 'WiFi 5';
  if (band === '2.4GHz') return chanWidth >= 40 ? 'WiFi 6' : 'WiFi 4';
  return 'Unknown';
};

/**
 * Radio type → generation. This is the authoritative mapping: netsh reports
 * exactly which PHY the link negotiated, no bandwidth guessing involved.
 * ('ax' on 6GHz is advertised as WiFi 6E by most vendors — netsh itself only
 * says 802.11ax, so we keep "WiFi 6" unless the band says 6GHz.)
 */
export const generationFromRadioType = (radio?: string): WifiLinkInfo['generation'] | undefined => {
  if (!radio) return undefined;
  const r = radio.toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (r.includes('11be') || r.includes('be')) return 'WiFi 7';
  if (r.includes('11ax') || r.includes('ax')) return 'WiFi 6';
  if (r.includes('11ac') || r.includes('ac')) return 'WiFi 5';
  if (r.includes('11n') || r === 'n') return 'WiFi 4';
  if (r.includes('11g') || r === 'g') return 'WiFi 3';
  if (r.includes('11a') || r.includes('11b')) return 'WiFi 2';
  return undefined;
};

export function bandFromChannel(channel?: number): WifiLinkInfo['band'] | undefined {
  if (channel === undefined) return undefined;
  // 2.4GHz ends at ch 14; 5GHz spans ch 32-177 (U-NII-1 through U-NII-3e);
  // everything above is the 6GHz spectrum (ch 1-233 of WiFi 6E / 6 GHz band).
  // (6GHz channels numerically overlap the low bands, so when the OS only
  // gives us a channel this is a best-effort fallback — netsh/iw normally
  // report the band explicitly, which takes precedence.)
  if (channel <= 14) return '2.4GHz';
  if (channel <= 177) return '5GHz';
  return '6GHz';
}

/**
 * Pure parser for `netsh wlan show interfaces` output — exported so tests can
 * feed real-world samples (including localized/weird formats) without spawning
 * netsh.
 */
export function parseWindowsWifiOutput(stdout: string): WifiLinkInfo {
  const get = (re: RegExp) => {
    const m = stdout.match(re);
    return m ? m[1].trim() : undefined;
  };
  const ssid = get(/SSID\s*:\s*(.+)/);
  const radioType = get(/Radio type\s*:\s*(.+)/);
  const chanRaw = get(/Channel\s*:\s*(\d+)/);
  // Real netsh prints "Receive rate (Mbps) : 866.7" — note the SPACE between
  // "rate" and "(Mbps)". The old regex `rate\(Mbps\)` silently never matched,
  // which is why the link rate was always missing from the UI.
  const rxRate = get(/Receive rate\s*\(Mbps\)\s*:\s*([\d.]+)/);
  const txRate = get(/Transmit rate\s*\(Mbps\)\s*:\s*([\d.]+)/);
  const signalRaw = get(/Signal\s*:\s*(\d+)%/);
  // Band appears as "Band : 5 GHz" (Win10/11) or legacy "Band : 5" — handle both.
  const bandGhz = get(/Band\s*:\s*([\d.]+)\s*GHz/i);
  const bandLegacy = bandGhz ? undefined : get(/Band\s*:\s*(\d+)/);

  let band: WifiLinkInfo['band'] | undefined;
  if (bandGhz) {
    const ghz = parseFloat(bandGhz);
    band = ghz >= 6 ? '6GHz' : ghz >= 4.5 ? '5GHz' : '2.4GHz';
  } else if (bandLegacy === '1') {
    band = '2.4GHz';
  } else if (bandLegacy === '2') {
    band = '5GHz';
  } else if (bandLegacy === '3') {
    band = '6GHz';
  } else {
    band = bandFromChannel(chanRaw ? parseInt(chanRaw, 10) : undefined);
  }

  const channel = chanRaw ? parseInt(chanRaw, 10) : undefined;
  const chanWidth = band === '6GHz' ? 160 : band === '5GHz' ? 80 : band === '2.4GHz' ? 20 : 20;
  const phy = rxRate ? parseFloat(rxRate) : txRate ? parseFloat(txRate) : undefined;
  // Generation: trust the reported radio type first, fall back to the
  // bandwidth heuristic, and only then give up.
  let generation = generationFromRadioType(radioType)
    ?? (band ? generationFromBandwidth(band, chanWidth, phy ?? 0) : 'Unknown');
  // WiFi 6E labelling: netsh only says 802.11ax even when the link runs on
  // the 6GHz spectrum. ax + 6GHz IS WiFi 6E (vendor-standard naming) — this
  // is the "prioritise the best available standard" case: a 6E router must
  // never be downgraded to a plain "WiFi 6" label in the UI.
  if (generation === 'WiFi 6' && band === '6GHz') generation = 'WiFi 6E';

  return {
    connected: !!ssid,
    ssid,
    band,
    channel,
    channelWidthMHz: chanWidth,
    phyRateMbps: phy,
    signalDbm: signalRaw ? Math.round((parseFloat(signalRaw) / 100) * 60 - 100) : undefined,
    generation,
    raw: stdout,
  };
}

async function queryWindows(): Promise<WifiLinkInfo> {
  try {
    const { stdout } = await execAsync('netsh wlan show interfaces', { encoding: 'utf8', timeout: 5000 });
    if (!stdout) return { connected: false, generation: 'Unknown' };
    return parseWindowsWifiOutput(stdout);
  } catch {
    return { connected: false, generation: 'Unknown' };
  }
}

async function queryLinux(): Promise<WifiLinkInfo> {
  try {
    // Try iw first.
    const { stdout: devOut } = await execAsync('iw dev', { encoding: 'utf8', timeout: 5000 });
    const ifaceMatch = devOut.match(/Interface\s+(\w+)/);
    if (!ifaceMatch) return { connected: false, generation: 'Unknown' };
    const iface = ifaceMatch[1];
    const { stdout } = await execAsync(`iw dev ${iface} link`, { encoding: 'utf8', timeout: 5000 });
    const get = (re: RegExp) => {
      const m = stdout.match(re);
      return m ? m[1].trim() : undefined;
    };
    const ssid = get(/SSID:\s+(.+)/);
    const freqRaw = get(/freq:\s+(\d+)/);
    const chanRaw = get(/channel\s+(\d+)/);
    const bwRaw = get(/width:\s+(\d+)\s*MHz/);
    const signalRaw = get(/signal:\s+(-?\d+)\s*dBm/);
    // iw prints "tx bitrate: 866.7 MBit/s" — the real negotiated PHY rate.
    const txBitrate = get(/tx bitrate:\s*([\d.]+)\s*MBit/i);
    const freq = freqRaw ? parseInt(freqRaw, 10) : undefined;
    const band = freq !== undefined ? (freq < 4000 ? '2.4GHz' : freq < 6000 ? '5GHz' : '6GHz') : undefined;
    const chanWidth = bwRaw ? parseInt(bwRaw, 10) : 20;
    return {
      connected: !!ssid,
      ssid,
      band,
      channel: chanRaw ? parseInt(chanRaw, 10) : undefined,
      channelWidthMHz: chanWidth,
      phyRateMbps: txBitrate ? parseFloat(txBitrate) : undefined,
      signalDbm: signalRaw ? parseInt(signalRaw, 10) : undefined,
      generation: band ? generationFromBandwidth(band, chanWidth, 0) : 'Unknown',
      raw: stdout,
    };
  } catch {
    return { connected: false, generation: 'Unknown' };
  }
}

async function queryMac(): Promise<WifiLinkInfo> {
  try {
    const { stdout } = await execAsync('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I', { encoding: 'utf8', timeout: 5000 });
    const get = (re: RegExp) => {
      const m = stdout.match(re);
      return m ? m[1].trim() : undefined;
    };
    const ssid = get(/\s*SSID:\s+(.+)/);
    const chanRaw = get(/channel:\s+([\d,]+)/);
    const rssiRaw = get(/agrCtlRSSI:\s+(-?\d+)/);
    const lastTxRateRaw = get(/lastTxRate:\s+(\d+)/);
    const channelStr = chanRaw ?? '';
    const channelNum = parseInt(channelStr.split(',')[0], 10) || undefined;
    const band = bandFromChannel(channelNum);
    const chanWidth = channelStr.includes('80') ? 80 : channelStr.includes('160') ? 160 : channelStr.includes('40') ? 40 : 20;
    const phy = lastTxRateRaw ? parseInt(lastTxRateRaw, 10) : undefined;
    return {
      connected: !!ssid,
      ssid,
      band,
      channel: channelNum,
      channelWidthMHz: chanWidth,
      phyRateMbps: phy,
      signalDbm: rssiRaw ? parseInt(rssiRaw, 10) : undefined,
      generation: band ? generationFromBandwidth(band, chanWidth, phy ?? 0) : 'Unknown',
      raw: stdout,
    };
  } catch {
    return { connected: false, generation: 'Unknown' };
  }
}

export async function queryWifiInfo(): Promise<WifiLinkInfo> {
  switch (process.platform) {
    case 'win32': return queryWindows();
    case 'linux': return queryLinux();
    case 'darwin': return queryMac();
    default: return { connected: false, generation: 'Unknown' };
  }
}
