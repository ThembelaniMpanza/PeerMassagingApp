import {
  APP_VERSION,
  DEFAULT_PORT,
  LocalPeerConnectionManager,
  MessageService,
  type DeviceProfile,
} from '@ip-messenger/shared';
import { nodeTcpSocketFactory } from './node-socket';
import { createPeerServer, type PeerServer } from './peer-server';

export function createConnectionManager(profile: DeviceProfile): LocalPeerConnectionManager {
  return new LocalPeerConnectionManager(
    {
      deviceId: profile.deviceId,
      deviceName: profile.displayName,
      platform: profile.platform,
      appVersion: APP_VERSION,
      port: DEFAULT_PORT,
    },
    nodeTcpSocketFactory,
  );
}

export function createPeerServerForProfile(profile: DeviceProfile): PeerServer {
  return createPeerServer({
    deviceId: profile.deviceId,
    deviceName: profile.displayName,
    platform: profile.platform,
    appVersion: APP_VERSION,
    port: DEFAULT_PORT,
  });
}

export function createMessagingForProfile(profile: DeviceProfile): {
  connectionManager: LocalPeerConnectionManager;
  messageService: MessageService;
} {
  const connectionManager = createConnectionManager(profile);
  return {
    connectionManager,
    messageService: new MessageService(profile.deviceId, connectionManager),
  };
}
