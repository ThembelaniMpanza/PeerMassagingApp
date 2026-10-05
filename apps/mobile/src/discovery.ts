import dgram from 'react-native-udp';
import { Buffer } from 'buffer';
import type { DeviceProfile, NearbyDevice } from '@ip-messenger/shared';

const PORT = 5051;
type UdpSocket = ReturnType<typeof dgram.createSocket> & {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'message', listener: (data: Buffer, remote: { address: string }) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  removeListener(event: 'error', listener: (error: Error) => void): void;
};
export class LanDiscovery {
  private socket?: UdpSocket;
  private timer?: ReturnType<typeof setInterval>;
  private readonly peers = new Map<string, NearbyDevice & { seenAt: number }>();
  constructor(private readonly profile: DeviceProfile, private readonly onChange: (devices: NearbyDevice[]) => void, private readonly onError: (error: Error) => void) {}
  async start(): Promise<void> {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reusePort: true }) as UdpSocket;
    this.socket = socket;
    socket.on('error', this.onError);
    socket.on('message', (data, remote) => {
      try {
        if (data.length > 2048) return;
        const value = JSON.parse(data.toString());
        if (value.service !== 'ip-messenger' || value.version !== 1 || typeof value.deviceId !== 'string' || !value.deviceId || value.deviceId === this.profile.deviceId || typeof value.deviceName !== 'string' || value.deviceName.length > 100 || !['android', 'ios', 'windows', 'macos'].includes(value.platform) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return;
        if (this.peers.size >= 100 && !this.peers.has(value.deviceId)) return;
        this.peers.set(value.deviceId, { deviceId: value.deviceId, deviceName: value.deviceName, platform: value.platform,
          ipAddress: remote.address, port: value.port, status: 'online', trusted: false, seenAt: Date.now() });
        this.publish();
      } catch { /* Ignore unrelated LAN datagrams. */ }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(PORT, '0.0.0.0', () => { socket.removeListener('error', reject); socket.setBroadcast(true); resolve(); });
    });
    this.announce();
    this.timer = setInterval(() => { this.announce(); this.publish(); }, 5000);
  }
  refresh(): void { this.announce(); this.publish(); }
  private announce(): void {
    const data = Buffer.from(JSON.stringify({ service: 'ip-messenger', version: 1, deviceId: this.profile.deviceId,
      deviceName: this.profile.displayName, platform: this.profile.platform, port: 5050 }));
    this.socket?.send(data, 0, data.length, PORT, '255.255.255.255', (error) => { if (error) this.onError(error); });
  }
  private publish(): void {
    for (const [id, peer] of this.peers) if (Date.now() - peer.seenAt > 16000) this.peers.delete(id);
    this.onChange([...this.peers.values()]);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.socket?.close(); this.socket = undefined; }
}
