import * as SecureStore from 'expo-secure-store';
import { PairingService } from '@ip-messenger/shared';
import type { DeviceProfile } from '@ip-messenger/shared';

export const secureStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export function createPairingService(profile: DeviceProfile): PairingService {
  return new PairingService(profile.deviceId, profile.displayName, secureStorage);
}
