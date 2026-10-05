import type {
  EncryptedPayload,
  PairAcceptPayload,
  PairRejectPayload,
  PairRequestPayload,
  ProtocolMessage,
} from '@ip-messenger/protocol';
import type { StorageAdapter } from './index';
import type { PeerConnection } from '@ip-messenger/networking';
import { cryptoProvider } from './crypto-provider';

const TRUSTED_DEVICE_STORE_KEY = 'ip_messenger_trusted_devices';
const PAIRING_CODE_LENGTH = 6;

export interface TrustedDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  publicKey: string;
  pairedAt: number;
  sessionKey?: string;
}

interface PendingPairing {
  pairingCode: string;
  keyPair: { privateKey: unknown; publicKey: string };
  publicKey: string;
  fingerprint: string;
}

export interface PairingAcceptance {
  response: PairAcceptPayload;
  session: CryptoSession;
}

export type PairRequestListener = (connection: PeerConnection, request: PairRequestPayload) => void;

export interface SecureSessionProvider {
  getSession(deviceId: string): CryptoSession | undefined;
}

export class PairingService {
  private pendingPairing: PendingPairing | undefined;

  constructor(
    readonly localDeviceId: string,
    private localDeviceName: string,
    private readonly storage: StorageAdapter,
  ) {}

  setDeviceName(name: string): void { this.localDeviceName = name; }

  async createPairRequest(): Promise<PairRequestPayload> {
    const pending = await createPendingPairing();
    this.pendingPairing = pending;
    return {
      pairingCode: pending.pairingCode,
      requesterId: this.localDeviceId,
      requesterName: this.localDeviceName,
      publicKey: pending.publicKey,
      fingerprint: pending.fingerprint,
    };
  }

  async acceptPairRequest(request: PairRequestPayload, expectedCode: string): Promise<PairingAcceptance> {
    if (request.pairingCode !== expectedCode) {
      throw new Error('Pairing code does not match');
    }

    const pending = await createPendingPairing();
    const sessionKey = await deriveSessionKey(pending.keyPair.privateKey, request.publicKey);
    await this.saveTrustedDevice({
      deviceId: request.requesterId,
      deviceName: request.requesterName,
      fingerprint: request.fingerprint,
      publicKey: request.publicKey,
      pairedAt: Date.now(),
      sessionKey: await sessionKeyToBase64(sessionKey),
    });

    this.pendingPairing = undefined;
    return {
      response: {
        pairingCode: request.pairingCode,
        responderId: this.localDeviceId,
        responderName: this.localDeviceName,
        publicKey: pending.publicKey,
        fingerprint: pending.fingerprint,
      },
      session: new CryptoSession(sessionKey),
    };
  }

  async completePairing(response: PairAcceptPayload): Promise<CryptoSession> {
    if (!this.pendingPairing || this.pendingPairing.pairingCode !== response.pairingCode) {
      throw new Error('No matching pairing request is pending');
    }

    const sessionKey = await deriveSessionKey(this.pendingPairing.keyPair.privateKey, response.publicKey);
    await this.saveTrustedDevice({
      deviceId: response.responderId,
      deviceName: response.responderName,
      fingerprint: response.fingerprint,
      publicKey: response.publicKey,
      pairedAt: Date.now(),
      sessionKey: await sessionKeyToBase64(sessionKey),
    });
    this.pendingPairing = undefined;
    return new CryptoSession(sessionKey);
  }

  async listTrustedDevices(): Promise<TrustedDevice[]> {
    const raw = await this.storage.getItem(TRUSTED_DEVICE_STORE_KEY);
    if (!raw) {
      return [];
    }
    try {
      const devices = JSON.parse(raw) as TrustedDevice[];
      return Array.isArray(devices) ? devices : [];
    } catch {
      await this.storage.removeItem(TRUSTED_DEVICE_STORE_KEY);
      return [];
    }
  }

  async removeTrustedDevice(deviceId: string): Promise<void> {
    const devices = await this.listTrustedDevices();
    await this.storage.setItem(
      TRUSTED_DEVICE_STORE_KEY,
      JSON.stringify(devices.filter((device) => device.deviceId !== deviceId)),
    );
  }

  async isTrustedDevice(deviceId: string, fingerprint: string): Promise<boolean> {
    const device = (await this.listTrustedDevices()).find((candidate) => candidate.deviceId === deviceId);
    return device?.fingerprint === fingerprint;
  }

  async restoreSession(deviceId: string): Promise<CryptoSession | undefined> {
    const device = (await this.listTrustedDevices()).find((candidate) => candidate.deviceId === deviceId);
    return device?.sessionKey ? CryptoSession.fromBase64(device.sessionKey) : undefined;
  }

  private async saveTrustedDevice(device: TrustedDevice): Promise<void> {
    const devices = await this.listTrustedDevices();
    const next = devices.filter((candidate) => candidate.deviceId !== device.deviceId);
    next.push(device);
    await this.storage.setItem(TRUSTED_DEVICE_STORE_KEY, JSON.stringify(next));
  }
}

export class PairingCoordinator implements SecureSessionProvider {
  private readonly sessions = new Map<string, CryptoSession>();
  private readonly attachedConnections = new WeakSet<PeerConnection>();
  private readonly requestListeners = new Set<PairRequestListener>();
  private readonly pendingRequests = new Map<string, {
    resolve: (session: CryptoSession) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly pairingService: PairingService) {}

  async start(): Promise<void> {
    const devices = await this.pairingService.listTrustedDevices();
    for (const device of devices) {
      const session = await this.pairingService.restoreSession(device.deviceId);
      if (session) {
        this.sessions.set(device.deviceId, session);
      }
    }
  }

  attachConnection(connection: PeerConnection): void {
    if (this.attachedConnections.has(connection)) {
      return;
    }
    this.attachedConnections.add(connection);
    connection.onMessage((message) => {
      void this.handleMessage(connection, message).catch(async (error) => {
        await this.rejectPairRequest(connection, error instanceof Error ? error.message : 'Invalid pairing').catch(() => undefined);
        await connection.close('invalid-pairing');
      });
    });
  }

  onPairRequest(listener: PairRequestListener): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  async requestPairing(connection: PeerConnection, onPairingCode?: (code: string, fingerprint: string) => void): Promise<CryptoSession> {
    if (this.pendingRequests.size) throw new Error('Finish the current pairing request first');
    this.attachConnection(connection);
    const request = await this.pairingService.createPairRequest();
    onPairingCode?.(request.pairingCode, request.fingerprint);
    const session = new Promise<CryptoSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(connection.id);
        reject(new Error('Pairing request timed out'));
      }, 30000);
      this.pendingRequests.set(connection.id, { resolve, reject, timer });
    });
    try {
      await connection.send(this.createMessage('PAIR_REQUEST', request));
    } catch (error) {
      const pending = this.pendingRequests.get(connection.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(connection.id);
        pending.reject(error instanceof Error ? error : new Error('Unable to send pairing request'));
      }
    }
    return session;
  }

  async acceptPairRequest(connection: PeerConnection, request: PairRequestPayload, expectedCode: string): Promise<void> {
    this.attachConnection(connection);
    try {
      const acceptance = await this.pairingService.acceptPairRequest(request, expectedCode);
      this.sessions.set(connection.remoteDeviceId, acceptance.session);
      await connection.send(this.createMessage('PAIR_ACCEPT', acceptance.response));
    } catch (error) {
      await this.rejectPairRequest(connection, error instanceof Error ? error.message : 'Pairing rejected');
      throw error;
    }
  }

  async rejectPairRequest(connection: PeerConnection, reason: string): Promise<void> {
    await connection.send(this.createMessage('PAIR_REJECT', { reason } satisfies PairRejectPayload));
  }

  getSession(deviceId: string): CryptoSession | undefined {
    return this.sessions.get(deviceId);
  }

  clearSession(deviceId: string): void {
    this.sessions.delete(deviceId);
  }

  stop(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer); pending.reject(new Error('Pairing stopped'));
    }
    this.pendingRequests.clear(); this.sessions.clear(); this.requestListeners.clear();
  }

  private async handleMessage(connection: PeerConnection, message: ProtocolMessage): Promise<void> {
    if (message.type === 'PAIR_REQUEST') {
      const request = message.payload as PairRequestPayload;
      if (request.requesterId !== connection.remoteDeviceId || !/^\d{6}$/.test(request.pairingCode)) throw new Error('Invalid pairing identity');
      if (request.fingerprint !== await createFingerprint(request.publicKey)) throw new Error('Invalid pairing fingerprint');
      for (const listener of this.requestListeners) {
        listener(connection, request);
      }
    } else if (message.type === 'PAIR_ACCEPT') {
      const pending = this.pendingRequests.get(connection.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingRequests.delete(connection.id);
      try {
        const response = message.payload as PairAcceptPayload;
        if (response.responderId !== connection.remoteDeviceId || response.fingerprint !== await createFingerprint(response.publicKey)) throw new Error('Invalid pairing identity');
        const session = await this.pairingService.completePairing(response);
        this.sessions.set(connection.remoteDeviceId, session);
        pending.resolve(session);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error('Pairing failed'));
      }
    } else if (message.type === 'PAIR_REJECT') {
      const pending = this.pendingRequests.get(connection.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingRequests.delete(connection.id);
      pending.reject(new Error((message.payload as PairRejectPayload).reason));
    }
  }

  private createMessage<TType extends 'PAIR_REQUEST' | 'PAIR_ACCEPT' | 'PAIR_REJECT', TPayload>(type: TType, payload: TPayload): ProtocolMessage<TType, TPayload> {
    return {
      type,
      payload,
      timestamp: Date.now(),
      senderId: this.pairingService.localDeviceId,
    };
  }
}

export class CryptoSession {
  constructor(private readonly key: Uint8Array) {}

  static async fromBase64(value: string): Promise<CryptoSession> {
    const key = base64ToBytes(value);
    if (key.length !== 32) throw new Error('Invalid session key');
    return new CryptoSession(key);
  }

  async exportBase64(): Promise<string> {
    return bytesToBase64(this.key);
  }

  async encrypt(plaintext: string): Promise<EncryptedPayload> {
    const iv = cryptoProvider.randomBytes(12);
    const ciphertext = await cryptoProvider.encrypt(this.key, iv, new TextEncoder().encode(plaintext));
    return {
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      iv: bytesToBase64(iv),
    };
  }

  async decrypt(payload: EncryptedPayload): Promise<string> {
    const plaintext = await cryptoProvider.decrypt(this.key, base64ToBytes(payload.iv), base64ToBytes(payload.ciphertext));
    return new TextDecoder().decode(plaintext);
  }
}

async function createPendingPairing(): Promise<PendingPairing> {
  const keyPair = await cryptoProvider.generateKeyPair();
  const publicKey = keyPair.publicKey;
  return {
    pairingCode: createPairingCode(),
    keyPair,
    publicKey,
    fingerprint: await createFingerprint(publicKey),
  };
}

async function deriveSessionKey(privateKey: unknown, publicKey: string): Promise<Uint8Array> {
  return cryptoProvider.deriveKey(privateKey, publicKey);
}

async function sessionKeyToBase64(key: Uint8Array): Promise<string> {
  return bytesToBase64(key);
}

async function createFingerprint(value: string): Promise<string> {
  const digest = await cryptoProvider.digest(new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

function createPairingCode(): string {
  const values = new Uint32Array(cryptoProvider.randomBytes(4).buffer);
  const max = 10 ** PAIRING_CODE_LENGTH;
  return (values[0] % max).toString().padStart(PAIRING_CODE_LENGTH, '0');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
