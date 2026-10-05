export type PlatformName = 'android' | 'ios' | 'windows' | 'macos';

export interface DeviceProfile {
  deviceId: string;
  displayName: string;
  platform: PlatformName;
  appVersion: string;
  createdAt: string;
}

export interface AppSettings {
  deviceName: string;
  allowIncomingConnections: boolean;
  allowFileTransfers: boolean;
  notificationEnabled: boolean;
}

export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const APP_VERSION = '0.1.0';
export const DEFAULT_PORT = 5050;
export const DEVICE_PROFILE_KEY = 'ip_messenger_device_profile';

export function normalizePlatform(value: string | undefined): PlatformName {
  const proc = value?.toLowerCase() ?? '';

  if (proc.includes('android')) return 'android';
  if (proc.includes('iphone') || proc.includes('ipad') || proc.includes('ios')) return 'ios';
  if (proc.includes('win')) return 'windows';
  return 'macos';
}

export function createDefaultDeviceProfile(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return {
    deviceId: randomId,
    displayName: 'My Device',
    platform: normalizePlatform(
      typeof navigator !== 'undefined'
        ? navigator.userAgent
        : typeof globalThis !== 'undefined' && 'process' in globalThis
          ? String((globalThis as { process?: { platform?: string } }).process?.platform)
          : undefined,
    ),
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export { BrowserStorageAdapter, MemoryStorageAdapter } from './storage-adapters';
export { DeviceProfileService } from './device-profile';
export * from './discovery';
export { MessageService } from './messaging';
export { FileTransferService } from './file-transfer';
export type { FileTransferChange, FileTransferSource } from './file-transfer';
export { CryptoSession, PairingCoordinator, PairingService } from './security';
export { setCryptoProvider } from './crypto-provider';
export type { CryptoProvider } from './crypto-provider';
export type { PairingAcceptance, PairRequestListener, SecureSessionProvider, TrustedDevice } from './security';
export * from '@ip-messenger/networking';
