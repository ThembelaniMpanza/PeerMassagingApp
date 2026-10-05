export type NearbyDeviceStatus = 'online' | 'offline';

export interface NearbyDevice {
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'ios' | 'windows' | 'macos';
  ipAddress?: string;
  port?: number;
  status: NearbyDeviceStatus;
  trusted: boolean;
}

export interface DiscoveryService {
  start(): Promise<void>;
  stop(): Promise<void>;
  listDevices(): Promise<NearbyDevice[]>;
  onChange(listener: (devices: NearbyDevice[]) => void): () => void;
}

export class MockDiscoveryService implements DiscoveryService {
  private readonly listeners = new Set<(devices: NearbyDevice[]) => void>();

  private devices: NearbyDevice[] = [
    {
      deviceId: 'prince-pc',
      deviceName: 'Prince-PC',
      platform: 'windows',
      ipAddress: '192.168.1.20',
      port: 5050,
      status: 'online',
      trusted: true,
    },
    {
      deviceId: 'galaxy-s26',
      deviceName: 'Galaxy S26',
      platform: 'android',
      ipAddress: '192.168.1.21',
      port: 5050,
      status: 'online',
      trusted: false,
    },
    {
      deviceId: 'thando-iphone',
      deviceName: 'Thando-iPhone',
      platform: 'ios',
      ipAddress: '192.168.1.22',
      port: 5050,
      status: 'online',
      trusted: false,
    },
  ];

  async start(): Promise<void> {
    this.emit();
  }

  async stop(): Promise<void> {
    this.devices = [];
    this.emit();
  }

  async listDevices(): Promise<NearbyDevice[]> {
    return this.devices;
  }

  onChange(listener: (devices: NearbyDevice[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener([...this.devices]);
    }
  }
}
