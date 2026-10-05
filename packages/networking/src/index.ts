import {
  parseProtocolMessage,
} from '@ip-messenger/protocol';
import type {
  DeviceInfoPayload,
  HelloPayload,
  PingPayload,
  PongPayload,
  ProtocolEventType,
  ProtocolMessage,
} from '@ip-messenger/protocol';

export type NetworkConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface PeerEndpoint {
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'ios' | 'windows' | 'macos';
  ipAddress: string;
  port: number;
}

export interface LocalPeerIdentity {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  port: number;
}

export interface PeerSocket {
  connect(host: string, port: number, timeoutMs: number): Promise<void>;
  write(data: string): Promise<void>;
  onData(listener: (data: string) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface PeerSocketFactory {
  create(): PeerSocket;
}

export interface PeerConnection {
  id: string;
  remoteDeviceId: string;
  remoteDeviceName: string;
  state: NetworkConnectionState;
  connectedAt?: number;
  lastSeenAt?: number;
  send<TType extends ProtocolEventType, TPayload>(message: ProtocolMessage<TType, TPayload>): Promise<void>;
  ping(): Promise<number>;
  onMessage(listener: (message: ProtocolMessage) => void): () => void;
  close(reason?: string): Promise<void>;
}

export interface ConnectionManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  connect(endpoint: PeerEndpoint): Promise<PeerConnection>;
  accept(endpoint: PeerEndpoint, socket: PeerSocket): Promise<PeerConnection>;
  disconnect(deviceId: string, reason?: string): Promise<void>;
  listConnections(): Promise<PeerConnection[]>;
  onConnectionChange(listener: (connections: PeerConnection[]) => void): () => void;
}

export interface ConnectionOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

const FRAME_SEPARATOR = '\n';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_RECONNECT_ATTEMPTS = 3;

export class LocalPeerConnectionManager implements ConnectionManager {
  private readonly listeners = new Set<(connections: PeerConnection[]) => void>();
  private readonly connections = new Map<string, PeerConnection>();
  private readonly pendingConnections = new Map<string, Promise<PeerConnection>>();

  constructor(
    private readonly identity: LocalPeerIdentity,
    private readonly socketFactory: PeerSocketFactory,
  ) {}

  async start(): Promise<void> {
    this.emit();
  }

  async stop(): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      await connection.close('manager-stopped');
    }
    this.connections.clear();
    this.emit();
  }

  async connect(endpoint: PeerEndpoint): Promise<PeerConnection> {
    const key = endpoint.deviceId || `${endpoint.ipAddress}:${endpoint.port}`;
    const existing = this.pendingConnections.get(key);
    if (existing) return existing;
    const pending = this.connectWithRetries(endpoint);
    this.pendingConnections.set(key, pending);
    try { return await pending; } finally { this.pendingConnections.delete(key); }
  }

  setDeviceName(name: string): void { this.identity.deviceName = name; }

  private async connectWithRetries(endpoint: PeerEndpoint): Promise<PeerConnection> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      try {
        return await this.connectWithSocket(endpoint, this.socketFactory.create(), true);
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RECONNECT_ATTEMPTS) await delay(250 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Unable to connect to peer');
  }

  async accept(endpoint: PeerEndpoint, socket: PeerSocket): Promise<PeerConnection> {
    return this.connectWithSocket(endpoint, socket, false);
  }

  private async connectWithSocket(endpoint: PeerEndpoint, socket: PeerSocket, shouldConnect: boolean): Promise<PeerConnection> {
    let mapKey = endpoint.deviceId || `${endpoint.ipAddress}:${endpoint.port}`;
    const existing = this.connections.get(mapKey);
    if (existing) {
      await socket.close();
      return existing;
    }

    const messageListeners = new Set<(message: ProtocolMessage) => void>();
    let inputBuffer = '';
    let closed = false;
    let remoteIdentity: DeviceInfoPayload | undefined;
    let resolveHandshake: (() => void) | undefined;
    let rejectHandshake: ((error: Error) => void) | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingPings = new Map<string, (latencyMs: number) => void>();
    const socketUnsubscribers: Array<() => void> = [];

    const connection: PeerConnection = {
      id: `${mapKey}:${Date.now()}:${Math.random()}`,
      remoteDeviceId: endpoint.deviceId,
      remoteDeviceName: endpoint.deviceName,
      state: 'connecting',
      send: async (message) => {
        if (closed) {
          throw new Error('Cannot send on a closed peer connection');
        }
        await socket.write(`${JSON.stringify(message)}${FRAME_SEPARATOR}`);
      },
      ping: async () => {
        const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const startedAt = Date.now();
        await connection.send(this.createMessage('PING', { nonce } satisfies PingPayload));
        return new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingPings.delete(nonce);
            reject(new Error('Peer PING timed out'));
          }, DEFAULT_TIMEOUT_MS);
          pendingPings.set(nonce, (latencyMs) => {
            clearTimeout(timer);
            resolve(latencyMs || Date.now() - startedAt);
          });
        });
      },
      onMessage: (listener) => {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        rejectHandshake?.(new Error('Peer connection closed'));
        if (handshakeTimer) clearTimeout(handshakeTimer);
        for (const unsubscribe of socketUnsubscribers) unsubscribe();
        for (const resolve of pendingPings.values()) resolve(-1);
        pendingPings.clear();
        await socket.close();
        connection.state = 'disconnected';
        this.connections.delete(mapKey);
        this.emit();
      },
    };

    socketUnsubscribers.push(socket.onData((data) => {
      inputBuffer += data;
      if (new TextEncoder().encode(inputBuffer).byteLength > MAX_FRAME_BYTES) {
        void connection.close('protocol-frame-too-large');
        return;
      }
      const frames = inputBuffer.split(FRAME_SEPARATOR);
      inputBuffer = frames.pop() ?? '';

      for (const frame of frames) {
        if (!frame.trim()) {
          continue;
        }

        try {
          const message = parseProtocolMessage(frame);
          if (remoteIdentity && message.senderId !== remoteIdentity.deviceId) throw new Error('Peer identity changed');
          connection.lastSeenAt = Date.now();
          this.handleControlMessage(connection, message, (identity) => {
            if (!identity || typeof identity.deviceId !== 'string' || !identity.deviceId || typeof identity.deviceName !== 'string' || identity.deviceId === this.identity.deviceId || identity.deviceId !== message.senderId) throw new Error('Invalid peer identity');
            if (endpoint.deviceId && identity.deviceId !== endpoint.deviceId) throw new Error('Unexpected peer identity');
            remoteIdentity = identity;
            connection.remoteDeviceId = identity.deviceId;
            connection.remoteDeviceName = identity.deviceName;
            resolveHandshake?.();
          });
          if (message.type === 'PONG') {
            const pong = message.payload as PongPayload;
            const resolvePing = pendingPings.get(pong.nonce);
            if (resolvePing) {
              pendingPings.delete(pong.nonce);
              resolvePing(Date.now() - message.timestamp);
            }
          }
          for (const listener of messageListeners) {
            listener(message);
          }
        } catch (error) {
          rejectHandshake?.(error instanceof Error ? error : new Error('Invalid protocol frame'));
          void connection.close('invalid-protocol-frame');
          return;
        }
      }
    }));

    socketUnsubscribers.push(socket.onClose(() => {
      if (!closed) {
        void connection.close();
      }
    }));

    socketUnsubscribers.push(socket.onError((error) => {
      connection.state = 'error';
      rejectHandshake?.(error);
      this.emit();
    }));

    this.connections.set(mapKey, connection);
    this.emit();

    const handshakePromise = new Promise<void>((resolve, reject) => {
      resolveHandshake = resolve;
      rejectHandshake = reject;
      handshakeTimer = setTimeout(() => reject(new Error('Peer HELLO handshake timed out')), DEFAULT_TIMEOUT_MS);
    });
    // A failed TCP connect can reject the handshake before it is awaited.
    void handshakePromise.catch(() => undefined);

    try {
      if (shouldConnect) await socket.connect(endpoint.ipAddress, endpoint.port, DEFAULT_TIMEOUT_MS);
      await connection.send(this.createMessage('HELLO', {
        deviceId: this.identity.deviceId,
        deviceName: this.identity.deviceName,
        platform: this.identity.platform,
        port: this.identity.port,
      } satisfies HelloPayload));

      await handshakePromise;
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
      }

      if (!remoteIdentity) {
        throw new Error('Peer did not provide DEVICE_INFO');
      }

      this.connections.delete(mapKey);
      mapKey = connection.remoteDeviceId;
      const duplicate = this.connections.get(mapKey);
      if (duplicate && duplicate !== connection) await duplicate.close();
      this.connections.set(mapKey, connection);

      connection.state = 'connected';
      connection.connectedAt = Date.now();
      connection.lastSeenAt = Date.now();
      this.emit();
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  async disconnect(deviceId: string): Promise<void> {
    const connection = this.connections.get(deviceId);
    if (connection) {
      await connection.close();
    }
  }

  async listConnections(): Promise<PeerConnection[]> {
    return [...this.connections.values()];
  }

  onConnectionChange(listener: (connections: PeerConnection[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleControlMessage(
    connection: PeerConnection,
    message: ProtocolMessage,
    onDeviceInfo: (identity: DeviceInfoPayload) => void,
  ): void {
    if (message.type === 'HELLO') {
      void connection.send(this.createMessage('DEVICE_INFO', {
        deviceId: this.identity.deviceId,
        deviceName: this.identity.deviceName,
        platform: this.identity.platform,
        appVersion: this.identity.appVersion,
      } satisfies DeviceInfoPayload));
    } else if (message.type === 'DEVICE_INFO') {
      onDeviceInfo(message.payload as DeviceInfoPayload);
    } else if (message.type === 'PING') {
      const ping = message.payload as PingPayload;
      void connection.send(this.createMessage('PONG', { nonce: ping.nonce } satisfies PongPayload));
    }
  }

  private createMessage<TType extends ProtocolEventType, TPayload>(type: TType, payload: TPayload): ProtocolMessage<TType, TPayload> {
    return {
      type,
      payload,
      timestamp: Date.now(),
      senderId: this.identity.deviceId,
    };
  }

  private emit(): void {
    const snapshot = [...this.connections.values()];
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export function createConnectionOptions(host: string, port: number, timeoutMs = DEFAULT_TIMEOUT_MS): ConnectionOptions {
  return { host, port, timeoutMs };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
