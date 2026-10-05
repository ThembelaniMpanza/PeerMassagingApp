import { MockDiscoveryService, type NearbyDevice } from '@ip-messenger/shared';

export const discoveryService = new MockDiscoveryService();

export async function loadNearbyDevices(): Promise<NearbyDevice[]> {
  return discoveryService.listDevices();
}
