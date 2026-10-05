import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Buffer } from 'buffer';
import { getRandomBytes } from 'expo-crypto';
import { AppState } from 'react-native';
import { APP_VERSION, LocalPeerConnectionManager, MessageService, FileTransferService, PairingCoordinator, setCryptoProvider,
  type DeviceProfile, type NearbyDevice, type PeerConnection, type TrustedDevice } from '@ip-messenger/shared';
import type { MessageModel, FileTransferModel } from '@ip-messenger/models';
import type { PairRequestPayload } from '@ip-messenger/protocol';
import { createPairingService } from './security';
import { deviceProfileService } from './identity';
import { createMobileCrypto } from './crypto';
import { LanDiscovery } from './discovery';
import { createMobileServer, mobileSocketFactory } from './socket';

export interface MobileState {
  ready: boolean; error: string; devices: NearbyDevice[]; connections: PeerConnection[];
  trusted: TrustedDevice[]; messages: MessageModel[]; transfers: FileTransferModel[];
  pairingCode: string; pairingFingerprint: string; incomingPair?: { connection: PeerConnection; request: PairRequestPayload };
  received: Record<string, string>;
}

export class MobileRuntime {
  state: MobileState = { ready: false, error: '', devices: [], connections: [], trusted: [], messages: [], transfers: [], pairingCode: '', pairingFingerprint: '', received: {} };
  readonly manager: LocalPeerConnectionManager;
  readonly pairing;
  readonly coordinator;
  readonly messages;
  readonly files;
  readonly discovery;
  private readonly server;
  private readonly unsubscribers: Array<() => void> = [];
  private stopped = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private activityGeneration = 0;
  private readonly endpoints = new Map<string, NearbyDevice>();
  constructor(readonly profile: DeviceProfile, private readonly onChange: (state: MobileState) => void) {
    setCryptoProvider(createMobileCrypto(getRandomBytes));
    this.manager = new LocalPeerConnectionManager({ deviceId: profile.deviceId, deviceName: profile.displayName,
      platform: profile.platform, appVersion: APP_VERSION, port: 5050 }, mobileSocketFactory);
    this.pairing = createPairingService(profile);
    this.coordinator = new PairingCoordinator(this.pairing);
    this.messages = new MessageService(profile.deviceId, this.manager, AsyncStorage, this.coordinator);
    this.files = new FileTransferService(profile.deviceId, this.manager, AsyncStorage, this.coordinator);
    this.discovery = new LanDiscovery(profile, (devices) => { this.update({ devices }); }, this.fail);
    this.server = createMobileServer(this.manager, this.fail);
  }
  private update(next: Partial<MobileState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...next }; this.onChange(this.state);
  }
  fail = (cause: unknown): void => this.update({ error: cause instanceof Error ? cause.message : String(cause) });
  clearError(): void { this.update({ error: '' }); }
  async rename(name: string): Promise<void> {
    if (!name.trim() || name.trim().length > 100) throw new Error('Use a device name between 1 and 100 characters');
    const profile = await deviceProfileService.updateDisplayName(name);
    this.profile.displayName = profile.displayName;
    this.manager.setDeviceName(profile.displayName); this.pairing.setDeviceName(profile.displayName);
    this.discovery.refresh(); this.update({});
  }
  async start(): Promise<void> {
    const appStateSubscription = AppState.addEventListener('change', () => { this.activityGeneration += 1; });
    this.unsubscribers.push(() => appStateSubscription.remove());
    this.unsubscribers.push(
      this.manager.onConnectionChange((connections) => {
        for (const connection of connections) this.coordinator.attachConnection(connection);
        this.update({ connections: [...connections] });
      }),
      this.coordinator.onPairRequest((connection, request) => {
        if (this.state.incomingPair || this.state.pairingCode) {
          void this.coordinator.rejectPairRequest(connection, 'Another pairing is in progress').catch(this.fail); return;
        }
        this.update({ incomingPair: { connection, request } });
      }),
      this.messages.onChange((messages) => this.update({ messages: messages.map((message) => ({ ...message })) })),
      this.files.onChange(({ transfers }) => this.update({ transfers: transfers.map((transfer) => ({ ...transfer })) })),
      this.files.onReceived(({ transfer, bytes }) => { void this.saveReceived(transfer, bytes).catch(this.fail); }),
    );
    await this.coordinator.start();
    await this.messages.start();
    await this.files.start();
    const received = await AsyncStorage.getItem('mobile_received_files');
    this.update({ messages: this.messages.list(), transfers: this.files.list(), trusted: await this.pairing.listTrustedDevices(), received: received ? JSON.parse(received) : {} });
    if (this.stopped) return;
    await this.manager.start();
    await this.server.start();
    if (this.stopped) { await this.server.stop(); return; }
    // A discovery failure still permits a direct TCP connection.
    await this.discovery.start().catch(this.fail);
    this.update({ ready: true });
    this.heartbeat = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      const generation = this.activityGeneration;
      for (const connection of this.state.connections) if (connection.state === 'connected') void connection.ping().catch(() => {
        if (AppState.currentState === 'active' && generation === this.activityGeneration) return connection.close();
      });
      for (const peer of this.endpoints.values()) if (this.coordinator.getSession(peer.deviceId) && !this.state.connections.some((connection) => connection.remoteDeviceId === peer.deviceId)) void this.connect(peer).catch(() => undefined);
    }, 10000);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.discovery.stop();
    this.messages.stop(); this.files.stop(); this.coordinator.stop();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await this.manager.stop(); await this.server.stop();
  }
  async connect(peer: NearbyDevice): Promise<PeerConnection> {
    if (!peer.ipAddress || !peer.port) throw new Error('Enter the peer address to reconnect');
    const connection = await this.manager.connect({ ...peer, ipAddress: peer.ipAddress, port: peer.port });
    this.endpoints.set(connection.remoteDeviceId, { ...peer, deviceId: connection.remoteDeviceId, deviceName: connection.remoteDeviceName });
    return connection;
  }
  async connectAddress(address: string): Promise<PeerConnection> {
    const [host, portText = '5050'] = address.trim().split(':');
    const port = Number(portText);
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.split('.').some((part) => Number(part) > 255) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter an IPv4 address and optional port, such as 10.0.2.2:5050');
    return this.connect({ deviceId: '', deviceName: host, platform: 'android', status: 'online', trusted: false, ipAddress: host, port });
  }
  async pair(connection: PeerConnection): Promise<void> {
    try {
      await this.coordinator.requestPairing(connection, (pairingCode, pairingFingerprint) => this.update({ pairingCode, pairingFingerprint }));
      await this.afterPairing();
    } finally { this.update({ pairingCode: '', pairingFingerprint: '' }); }
  }
  async approvePair(code: string): Promise<void> {
    const incoming = this.state.incomingPair;
    if (!incoming) return;
    if (code !== incoming.request.pairingCode) throw new Error('The code does not match. Read the code on the other device.');
    await this.coordinator.acceptPairRequest(incoming.connection, incoming.request, code);
    this.update({ incomingPair: undefined }); await this.afterPairing();
  }
  async rejectPair(): Promise<void> {
    const incoming = this.state.incomingPair; this.update({ incomingPair: undefined });
    if (incoming) await this.coordinator.rejectPairRequest(incoming.connection, 'Declined by user');
  }
  private async afterPairing(): Promise<void> { this.update({ trusted: await this.pairing.listTrustedDevices() }); await this.messages.flushQueue(); }
  async forget(id: string): Promise<void> {
    this.coordinator.clearSession(id); await this.pairing.removeTrustedDevice(id);
    await this.manager.disconnect(id); this.update({ trusted: await this.pairing.listTrustedDevices() });
  }
  async chooseFile(id: string): Promise<void> {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (picked.canceled) return;
    const file = picked.assets[0];
    const info = await FileSystem.getInfoAsync(file.uri);
    if (!info.exists || info.isDirectory || info.size > 10 * 1024 * 1024) throw new Error('Choose a file of 10 MB or smaller');
    const bytes = Buffer.from(await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 }), 'base64');
    if (!this.state.connections.some((connection) => connection.remoteDeviceId === id && connection.state === 'connected')) {
      const endpoint = this.endpoints.get(id);
      if (!endpoint) throw new Error('Reconnect to the peer, then choose the file again');
      await this.connect(endpoint);
    }
    await this.files.offerFile(id, { name: file.name, mimeType: file.mimeType ?? 'application/octet-stream', bytes });
  }
  private async saveReceived(transfer: FileTransferModel, bytes: Uint8Array): Promise<void> {
    const directory = `${FileSystem.documentDirectory}received/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const name = transfer.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'file';
    const uri = `${directory}${Date.now()}-${name}`;
    await FileSystem.writeAsStringAsync(uri, Buffer.from(bytes).toString('base64'), { encoding: FileSystem.EncodingType.Base64 });
    const received = { ...this.state.received, [transfer.id]: uri };
    this.update({ received }); await AsyncStorage.setItem('mobile_received_files', JSON.stringify(received));
  }
  async shareFile(id: string): Promise<void> {
    const uri = this.state.received[id];
    if (!uri) throw new Error('The received file is not available');
    await Sharing.shareAsync(uri);
  }
}
