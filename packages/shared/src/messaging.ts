import type { MessageModel, MessageState } from '@ip-messenger/models';
import type {
  MessageAckPayload,
  MessagePayload,
  MessageReadPayload,
  ProtocolMessage,
} from '@ip-messenger/protocol';
import type {
  ConnectionManager,
  PeerConnection,
} from '@ip-messenger/networking';
import type { StorageAdapter } from './index';
import type { SecureSessionProvider } from './security';

const MESSAGE_STORE_KEY = 'ip_messenger_messages';

export type MessageChangeListener = (messages: MessageModel[]) => void;

export class MessageService {
  private readonly messages = new Map<string, MessageModel>();
  private readonly listeners = new Set<MessageChangeListener>();
  private attachedConnections = new WeakSet<PeerConnection>();
  private unsubscribeConnectionChanges: (() => void) | undefined;

  constructor(
    private readonly localDeviceId: string,
    private readonly connectionManager: ConnectionManager,
    private readonly storage?: StorageAdapter,
    private readonly secureSessions?: SecureSessionProvider,
  ) {}

  async start(): Promise<void> {
    await this.loadPersistedMessages();
    this.unsubscribeConnectionChanges = this.connectionManager.onConnectionChange((connections) => {
      for (const connection of connections) {
        this.attachConnection(connection);
      }
      void this.flushQueue(connections);
    });
    const connections = await this.connectionManager.listConnections();
    for (const connection of connections) {
      this.attachConnection(connection);
    }
    await this.flushQueue(connections);
  }

  stop(): void {
    this.unsubscribeConnectionChanges?.();
    this.unsubscribeConnectionChanges = undefined;
    this.attachedConnections = new WeakSet();
  }

  async sendMessage(receiverId: string, text: string): Promise<MessageModel> {
    const message: MessageModel = {
      id: createMessageId(),
      senderId: this.localDeviceId,
      receiverId,
      text: text.trim(),
      timestamp: Date.now(),
      state: 'queued',
    };

    if (!message.text) {
      throw new Error('Cannot send an empty message');
    }

    this.messages.set(message.id, message);
    this.emit();
    await this.tryDeliver(message);
    return message;
  }

  list(receiverId?: string): MessageModel[] {
    return [...this.messages.values()]
      .filter((message) => !receiverId || message.receiverId === receiverId || message.senderId === receiverId)
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  get(messageId: string): MessageModel | undefined {
    return this.messages.get(messageId);
  }

  onChange(listener: MessageChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async markRead(messageId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message || message.receiverId !== this.localDeviceId || message.state === 'read') {
      return;
    }

    this.updateState(message, 'read');
    const connection = (await this.connectionManager.listConnections())
      .find((candidate) => candidate.remoteDeviceId === message.senderId && candidate.state === 'connected');
    if (connection) {
      await connection.send(this.createMessage('MESSAGE_READ', {
        messageId,
        readerId: this.localDeviceId,
        readAt: Date.now(),
      } satisfies MessageReadPayload));
    }
  }

  private attachConnection(connection: PeerConnection): void {
    if (this.attachedConnections.has(connection)) {
      return;
    }
    this.attachedConnections.add(connection);
    connection.onMessage((message) => {
      void this.handleMessage(connection, message).catch(() => connection.close('invalid-message'));
    });
  }

  private async handleMessage(connection: PeerConnection, message: ProtocolMessage): Promise<void> {
    if (message.type === 'MESSAGE') {
      await this.receiveMessage(connection, message.payload as MessagePayload);
    } else if (message.type === 'MESSAGE_ACK') {
      const payload = message.payload as MessageAckPayload;
      if (this.messages.get(payload.messageId)?.receiverId === connection.remoteDeviceId && payload.receiverId === connection.remoteDeviceId) this.acknowledgeMessage(payload);
    } else if (message.type === 'MESSAGE_READ') {
      const payload = message.payload as MessageReadPayload;
      if (this.messages.get(payload.messageId)?.receiverId === connection.remoteDeviceId && payload.readerId === connection.remoteDeviceId) this.acknowledgeRead(payload);
    }
  }

  private async receiveMessage(connection: PeerConnection, payload: MessagePayload): Promise<void> {
    if (payload.senderId !== connection.remoteDeviceId || payload.receiverId !== this.localDeviceId || typeof payload.messageId !== 'string') throw new Error('Invalid message identity');
    if (this.secureSessions && !payload.encrypted) throw new Error('Unencrypted message rejected');
    const existing = this.messages.get(payload.messageId);
    if (!existing) {
      const text = payload.encrypted
        ? await this.decryptMessage(connection.remoteDeviceId, payload.encrypted)
        : payload.text;
      this.messages.set(payload.messageId, {
        id: payload.messageId,
        senderId: payload.senderId,
        receiverId: this.localDeviceId,
        text,
        timestamp: payload.timestamp,
        state: 'delivered',
      });
      this.emit();
    }

    await connection.send(this.createMessage('MESSAGE_ACK', {
      messageId: payload.messageId,
      receiverId: this.localDeviceId,
      deliveredAt: Date.now(),
    } satisfies MessageAckPayload));
  }

  private acknowledgeMessage(payload: MessageAckPayload): void {
    const message = this.messages.get(payload.messageId);
    if (!message || message.senderId !== this.localDeviceId) {
      return;
    }
    if (message.state !== 'read') this.updateState(message, 'delivered');
  }

  private acknowledgeRead(payload: MessageReadPayload): void {
    const message = this.messages.get(payload.messageId);
    if (message && message.senderId === this.localDeviceId) {
      this.updateState(message, 'read');
    }
  }

  async flushQueue(connections?: PeerConnection[]): Promise<void> {
    connections ??= await this.connectionManager.listConnections();
    const connected = new Map(
      connections
        .filter((connection) => connection.state === 'connected')
        .map((connection) => [connection.remoteDeviceId, connection]),
    );

    for (const message of this.messages.values()) {
      if (message.state === 'queued') {
        const connection = connected.get(message.receiverId);
        if (connection) {
          await this.tryDeliver(message, connection);
        }
      }
    }
  }

  private async tryDeliver(message: MessageModel, preferredConnection?: PeerConnection): Promise<void> {
    const connection = preferredConnection ?? (await this.connectionManager.listConnections())
      .find((candidate) => candidate.remoteDeviceId === message.receiverId && candidate.state === 'connected');

    if (!connection) {
      return;
    }

    this.updateState(message, 'sending');
    try {
      const payload = await this.createMessagePayload(message);
      await connection.send(this.createMessage('MESSAGE', {
        ...payload,
      } satisfies MessagePayload));
      if (message.state === 'sending') this.updateState(message, 'sent');
    } catch {
      this.updateState(message, 'queued');
    }
  }

  private updateState(message: MessageModel, state: MessageState): void {
    if (message.state === state) {
      return;
    }
    message.state = state;
    this.emit();
  }

  private async createMessagePayload(message: MessageModel): Promise<MessagePayload> {
    const session = this.secureSessions?.getSession(message.receiverId);
    if (this.secureSessions && !session) {
      throw new Error('Peer has not completed pairing');
    }
    return {
      messageId: message.id,
      senderId: message.senderId,
      receiverId: message.receiverId,
      text: session ? '' : message.text,
      timestamp: message.timestamp,
      encrypted: session ? await session.encrypt(message.text) : undefined,
    };
  }

  private async decryptMessage(deviceId: string, payload: NonNullable<MessagePayload['encrypted']>): Promise<string> {
    const session = this.secureSessions?.getSession(deviceId);
    if (!session) {
      throw new Error('Received an encrypted message without a paired session');
    }
    return session.decrypt(payload);
  }

  private createMessage<TType extends 'MESSAGE' | 'MESSAGE_ACK' | 'MESSAGE_READ', TPayload>(type: TType, payload: TPayload): ProtocolMessage<TType, TPayload> {
    return {
      type,
      payload,
      timestamp: Date.now(),
      senderId: this.localDeviceId,
    };
  }

  private emit(): void {
    const snapshot = this.list();
    void this.persistMessages(snapshot);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private async loadPersistedMessages(): Promise<void> {
    if (!this.storage) {
      return;
    }
    const raw = await this.storage.getItem(MESSAGE_STORE_KEY);
    if (!raw) {
      return;
    }
    try {
      const persisted = JSON.parse(raw) as MessageModel[];
      for (const message of persisted) {
        if (message?.id && message.senderId && message.receiverId && message.text) {
          this.messages.set(message.id, message);
        }
      }
    } catch {
      await this.storage.removeItem(MESSAGE_STORE_KEY);
    }
  }

  private async persistMessages(messages: MessageModel[]): Promise<void> {
    if (this.storage) {
      await this.storage.setItem(MESSAGE_STORE_KEY, JSON.stringify(messages));
    }
  }
}

function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
