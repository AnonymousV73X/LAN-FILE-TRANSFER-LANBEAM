/**
 * OS WiFi link info — surfaces the radio generation / band / channel width
 * so the UI can warn users on 2.4GHz or narrow channels where no software
 * trick can reach WiFi 5/6/7 ceilings.
 *
 * Each platform has its own CLI:
 *   - Windows: netsh wlan show interfaces
 *   - Linux:   iw dev <iface> link  (fallback: nmcli)
 *   - macOS:   airport -I  (or system_profiler SPAirPortDataType)
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
  generation?: 'WiFi 4' | 'WiFi 5' | 'WiFi 6' | 'WiFi 6E' | 'WiFi 7' | 'Unknown';
  raw?: string;               // For debugging
}

const generationFromBandwidth = (band: string, chanWidth: number, phy: number): WifiLinkInfo['generation'] => {
  if (band === '6GHz') return chanWidth >= 160 ? 'WiFi 7' : 'WiFi 6E';
  if (band === '5GHz') return chanWidth >= 160 ? 'WiFi 7' : chanWidth >= 80 ? 'WiFi 6' : 'WiFi 5';
  if (band === '2.4GHz') return chanWidth >= 40 ? 'WiFi 6' : 'WiFi 4';
  return 'Unknown';
};

async function queryWindows(): Promise<WifiLinkInfo> {
  try {
    const { stdout } = await execAsync('netsh wlan show interfaces', { encoding: 'utf8' });
    const get = (re: RegExp) => {
      const m = stdout.match(re);
      return m ? m[1].trim() : undefined;
    };
    const ssid = get(/SSID\s+:\s+(.+)/);
    const bandRaw = get(/Band\s+:\s+(\d+)/);
    const chanRaw = get(/Channel\s+:\s+(\d+)/);
    const rxRate = get(/Receive rate\(Mbps\)\s+:\s+([\d.]+)/);
    const txRate = get(/Transmit rate\(Mbps\)\s+:\s+([\d.]+)/);
    const signalRaw = get(/Signal\s+:\s+(\d+)%/);

    const band = bandRaw === '1' ? '2.4GHz' : bandRaw === '2' ? '5GHz' : bandRaw === '3' ? '6GHz' : undefined;
    const chanWidth = band === '6GHz' ? 160 : band === '5GHz' ? 80 : 20;
    const phy = rxRate ? parseFloat(rxRate) : txRate ? parseFloat(txRate) : undefined;
    return {
      connected: !!ssid,
      ssid,
      band,
      channel: chanRaw ? parseInt(chanRaw, 10) : undefined,
      channelWidthMHz: chanWidth,
      phyRateMbps: phy,
      signalDbm: signalRaw ? Math.round((parseFloat(signalRaw) / 100) * 60 - 100) : undefined,
      generation: band ? generationFromBandwidth(band, chanWidth, phy ?? 0) : 'Unknown',
      raw: stdout,
    };
  } catch {
    return { connected: false, generation: 'Unknown' };
  }
}

async function queryLinux(): Promise<WifiLinkInfo> {
  try {
    // Try iw first.
    const { stdout: devOut } = await execAsync('iw dev', { encoding: 'utf8' });
    const ifaceMatch = devOut.match(/Interface\s+(\w+)/);
    if (!ifaceMatch) return { connected: false, generation: 'Unknown' };
    const iface = ifaceMatch[1];
    const { stdout } = await execAsync(`iw dev ${iface} link`, { encoding: 'utf8' });
    const get = (re: RegExp) => {
      const m = stdout.match(re);
      return m ? m[1].trim() : undefined;
    };
    const ssid = get(/SSID:\s+(.+)/);
    const freqRaw = get(/freq:\s+(\d+)/);
    const chanRaw = get(/channel\s+(\d+)/);
    const bwRaw = get(/width:\s+(\d+)\s*MHz/);
    const signalRaw = get(/signal:\s+(-?\d+)\s*dBm/);
    const freq = freqRaw ? parseInt(freqRaw, 10) : undefined;
    const band = freq !== undefined ? (freq < 4000 ? '2.4GHz' : freq < 6000 ? '5GHz' : '6GHz') : undefined;
    const chanWidth = bwRaw ? parseInt(bwRaw, 10) : 20;
    return {
      connected: !!ssid,
      ssid,
      band,
      channel: chanRaw ? parseInt(chanRaw, 10) : undefined,
      channelWidthMHz: chanWidth,
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
    const { stdout } = await execAsync('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I', { encoding: 'utf8' });
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
    const band = channelNum !== undefined
      ? (channelNum <= 14 ? '2.4GHz' : channelNum <= 173 ? '5GHz' : '6GHz')
      : undefined;
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
