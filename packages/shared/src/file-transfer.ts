import type { FileTransferModel, FileTransferState } from '@ip-messenger/models';
import type {
  FileAcceptPayload,
  FileCancelPayload,
  FileChunkPayload,
  FileCompletePayload,
  FileErrorPayload,
  FileOfferPayload,
  FileRejectPayload,
  ProtocolMessage,
} from '@ip-messenger/protocol';
import type { ConnectionManager, PeerConnection } from '@ip-messenger/networking';
import type { StorageAdapter } from './index';
import type { SecureSessionProvider } from './security';
import { cryptoProvider } from './crypto-provider';

const FILE_TRANSFER_STORE_KEY = 'ip_messenger_file_transfers';
const DEFAULT_CHUNK_SIZE = 48 * 1024;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export interface FileTransferSource {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface FileTransferChange {
  transfers: FileTransferModel[];
  transfer: FileTransferModel;
}

export interface ReceivedFile {
  transfer: FileTransferModel;
  bytes: Uint8Array;
}

export type FileOfferListener = (transfer: FileTransferModel) => void;

export class FileTransferService {
  private readonly transfers = new Map<string, FileTransferModel>();
  private readonly outgoing = new Map<string, { source: FileTransferSource; connection: PeerConnection }>();
  private readonly incoming = new Map<string, { chunks: Map<number, string>; connection: PeerConnection }>();
  private readonly listeners = new Set<(change: FileTransferChange) => void>();
  private attachedConnections = new WeakSet<PeerConnection>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly receivedListeners = new Set<(file: ReceivedFile) => void>();
  private readonly offerListeners = new Set<FileOfferListener>();
  private unsubscribeConnectionChanges: (() => void) | undefined;

  constructor(
    private readonly localDeviceId: string,
    private readonly connectionManager: ConnectionManager,
    private readonly storage?: StorageAdapter,
    private readonly secureSessions?: SecureSessionProvider,
  ) {}

  async start(): Promise<void> {
    await this.loadTransfers();
    const connections = await this.connectionManager.listConnections();
    for (const connection of connections) this.attachConnection(connection);
    this.unsubscribeConnectionChanges = this.connectionManager.onConnectionChange((next) => {
      for (const connection of next) this.attachConnection(connection);
    });
  }

  stop(): void {
    this.unsubscribeConnectionChanges?.();
    this.unsubscribeConnectionChanges = undefined;
    this.attachedConnections = new WeakSet();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.incoming.clear();
    this.outgoing.clear();
  }

  async offerFile(receiverId: string, source: FileTransferSource): Promise<FileTransferModel> {
    if (source.bytes.length > MAX_FILE_SIZE) throw new Error('Files must be 10 MB or smaller');
    if (this.secureSessions && !this.secureSessions.getSession(receiverId)) throw new Error('Pair with this device first');
    const connection = (await this.connectionManager.listConnections())
      .find((candidate) => candidate.remoteDeviceId === receiverId && candidate.state === 'connected');
    if (!connection) throw new Error('Peer is not connected');

    const chunkSize = DEFAULT_CHUNK_SIZE;
    const totalChunks = Math.ceil(source.bytes.length / chunkSize);
    const transfer: FileTransferModel = {
      id: createId(), senderId: this.localDeviceId, receiverId, name: source.name,
      mimeType: source.mimeType, size: source.bytes.length, totalChunks, transferredChunks: 0,
      sha256: await sha256(source.bytes), state: 'offered',
    };
    this.transfers.set(transfer.id, transfer);
    this.outgoing.set(transfer.id, { source, connection });
    this.emit(transfer);
    try { await connection.send(this.message('FILE_OFFER', {
      fileId: transfer.id, name: source.name, size: source.bytes.length, mimeType: source.mimeType,
      senderId: this.localDeviceId, totalChunks, chunkSize, sha256: transfer.sha256,
    } satisfies FileOfferPayload)); }
    catch (error) { this.update(transfer, 'failed', 'Unable to send file offer'); throw error; }
    return transfer;
  }

  async resume(fileId: string, source: FileTransferSource): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.senderId !== this.localDeviceId) throw new Error('Outgoing transfer was not found');
    if (source.name !== transfer.name || source.bytes.length !== transfer.size || await sha256(source.bytes) !== transfer.sha256) {
      throw new Error('Selected file does not match the original transfer');
    }
    const connection = (await this.connectionManager.listConnections())
      .find((candidate) => candidate.remoteDeviceId === transfer.receiverId && candidate.state === 'connected');
    if (!connection) throw new Error('Peer is not connected');
    this.outgoing.set(fileId, { source, connection });
    transfer.error = undefined;
    transfer.state = 'offered';
    this.emit(transfer);
    await connection.send(this.message('FILE_OFFER', {
      fileId, name: transfer.name, size: transfer.size, mimeType: transfer.mimeType,
      senderId: this.localDeviceId, totalChunks: transfer.totalChunks, chunkSize: DEFAULT_CHUNK_SIZE, sha256: transfer.sha256,
    } satisfies FileOfferPayload));
  }

  list(): FileTransferModel[] { return [...this.transfers.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  get(fileId: string): FileTransferModel | undefined { return this.transfers.get(fileId); }
  onChange(listener: (change: FileTransferChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onReceived(listener: (file: ReceivedFile) => void): () => void { this.receivedListeners.add(listener); return () => this.receivedListeners.delete(listener); }
  onOffer(listener: FileOfferListener): () => void { this.offerListeners.add(listener); return () => this.offerListeners.delete(listener); }

  async accept(fileId: string, resumeFromChunk = 0): Promise<void> {
    const transfer = this.transfers.get(fileId);
    const incoming = this.incoming.get(fileId);
    if (!transfer || !incoming || transfer.state !== 'offered') return;
    this.update(transfer, 'accepted');
    await incoming.connection.send(this.message('FILE_ACCEPT', {
      fileId, receiverId: this.localDeviceId, resumeFromChunk,
    } satisfies FileAcceptPayload));
  }

  async reject(fileId: string, reason = 'rejected-by-user'): Promise<void> {
    const transfer = this.transfers.get(fileId);
    const incoming = this.incoming.get(fileId);
    if (!transfer || !incoming) return;
    await incoming.connection.send(this.message('FILE_REJECT', { fileId, reason } satisfies FileRejectPayload));
    this.update(transfer, 'cancelled', reason);
  }

  async cancel(fileId: string, reason = 'cancelled-by-user'): Promise<void> {
    const transfer = this.transfers.get(fileId);
    const outgoing = this.outgoing.get(fileId) ?? this.incoming.get(fileId);
    if (!transfer || !outgoing) return;
    this.update(transfer, 'cancelled', reason);
    await outgoing.connection.send(this.message('FILE_CANCEL', { fileId, reason } satisfies FileCancelPayload));
  }

  private attachConnection(connection: PeerConnection): void {
    if (this.attachedConnections.has(connection)) return;
    this.attachedConnections.add(connection);
    let queue = Promise.resolve();
    connection.onMessage((message) => {
      if (!message.type.startsWith('FILE_')) return;
      queue = queue.then(() => this.handle(connection, message)).catch(async (error) => {
        const id = (message.payload as Partial<FileOfferPayload>)?.fileId;
        const transfer = id ? this.transfers.get(id) : undefined;
        if (transfer && (transfer.senderId === connection.remoteDeviceId || transfer.receiverId === connection.remoteDeviceId)) this.update(transfer, 'failed', error instanceof Error ? error.message : 'Invalid file transfer');
        await connection.close('invalid-file-transfer');
      });
    });
  }

  private async handle(connection: PeerConnection, message: ProtocolMessage): Promise<void> {
    if (this.secureSessions && !this.secureSessions.getSession(connection.remoteDeviceId)) throw new Error('Pair with this device first');
    if (message.type !== 'FILE_OFFER') {
      const id = (message.payload as Partial<FileOfferPayload>)?.fileId;
      const transfer = id ? this.transfers.get(id) : undefined;
      if (!transfer || (transfer.senderId !== connection.remoteDeviceId && transfer.receiverId !== connection.remoteDeviceId)) return;
    }
    if (message.type === 'FILE_OFFER') await this.receiveOffer(connection, message.payload as FileOfferPayload);
    else if (message.type === 'FILE_ACCEPT') void this.sendChunks(message.payload as FileAcceptPayload);
    else if (message.type === 'FILE_REJECT') this.update(this.transfers.get((message.payload as FileRejectPayload).fileId), 'cancelled', (message.payload as FileRejectPayload).reason);
    else if (message.type === 'FILE_CHUNK') await this.receiveChunk(message.payload as FileChunkPayload);
    else if (message.type === 'FILE_COMPLETE') await this.receiveComplete(message.payload as FileCompletePayload);
    else if (message.type === 'FILE_CANCEL') this.update(this.transfers.get((message.payload as FileCancelPayload).fileId), 'cancelled');
    else if (message.type === 'FILE_ERROR') this.update(this.transfers.get((message.payload as FileErrorPayload).fileId), 'failed', (message.payload as FileErrorPayload).reason);
  }

  private async receiveOffer(connection: PeerConnection, payload: FileOfferPayload): Promise<void> {
    if (!payload || typeof payload.fileId !== 'string' || payload.fileId.length > 160 || payload.senderId !== connection.remoteDeviceId || typeof payload.name !== 'string' || payload.name.length > 255 || !Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > MAX_FILE_SIZE || payload.chunkSize !== DEFAULT_CHUNK_SIZE || payload.totalChunks !== Math.ceil(payload.size / DEFAULT_CHUNK_SIZE) || !/^[a-f0-9]{64}$/.test(payload.sha256)) throw new Error('Invalid file offer (maximum 10 MB)');
    if (this.incoming.size >= 4 && !this.incoming.has(payload.fileId)) throw new Error('Too many pending file offers');
    const existing = this.transfers.get(payload.fileId);
    if (existing && (existing.senderId !== payload.senderId || existing.sha256 !== payload.sha256 || !['failed', 'cancelled'].includes(existing.state))) throw new Error('Conflicting file offer');
    const transfer: FileTransferModel = {
      id: payload.fileId, senderId: payload.senderId, receiverId: this.localDeviceId,
      name: payload.name, mimeType: payload.mimeType, size: payload.size, totalChunks: payload.totalChunks,
      transferredChunks: 0, sha256: payload.sha256, state: 'offered',
    };
    this.transfers.set(transfer.id, transfer);
    this.incoming.set(transfer.id, { chunks: new Map(), connection });
    this.emit(transfer);
    for (const listener of this.offerListeners) listener(transfer);
  }

  private async sendChunks(payload: FileAcceptPayload): Promise<void> {
    const transfer = this.transfers.get(payload.fileId);
    const outgoing = this.outgoing.get(payload.fileId);
    if (!transfer || !outgoing) return;
    try {
      if (transfer.state !== 'offered' || !Number.isInteger(payload.resumeFromChunk) || payload.resumeFromChunk !== 0 || payload.receiverId !== transfer.receiverId) throw new Error('Invalid file acceptance');
      this.update(transfer, 'transferring');
      const chunkSize = DEFAULT_CHUNK_SIZE;
      for (let index = payload.resumeFromChunk; index < transfer.totalChunks; index += 1) {
        if (this.transfers.get(transfer.id)?.state !== 'transferring') return;
        const bytes = outgoing.source.bytes.slice(index * chunkSize, (index + 1) * chunkSize);
        const session = this.secureSessions?.getSession(transfer.receiverId);
        if (this.secureSessions && !session) throw new Error('Peer has not completed pairing');
        await outgoing.connection.send(this.message('FILE_CHUNK', {
          fileId: transfer.id, chunkIndex: index, chunk: session ? '' : bytesToBase64(bytes), totalChunks: transfer.totalChunks,
          sha256: await sha256(bytes),
          encrypted: session ? await session.encrypt(bytesToBase64(bytes)) : undefined,
        } satisfies FileChunkPayload));
        transfer.transferredChunks = index + 1;
        this.emit(transfer);
      }
      await outgoing.connection.send(this.message('FILE_COMPLETE', { fileId: transfer.id, sha256: transfer.sha256 } satisfies FileCompletePayload));
      // Completion is confirmed by the receiver after checking the full checksum.
    } catch (error) {
      this.update(transfer, 'failed', error instanceof Error ? error.message : 'Transfer failed');
    }
  }

  private async receiveChunk(payload: FileChunkPayload): Promise<void> {
    const incoming = this.incoming.get(payload.fileId);
    const transfer = this.transfers.get(payload.fileId);
    if (!incoming || !transfer) return;
    if (!['accepted', 'transferring'].includes(transfer.state) || !Number.isInteger(payload.chunkIndex) || payload.chunkIndex < 0 || payload.chunkIndex >= transfer.totalChunks || payload.totalChunks !== transfer.totalChunks) throw new Error('Unexpected file chunk');
    const session = this.secureSessions?.getSession(transfer.senderId);
    if (this.secureSessions && !session) {
      this.update(transfer, 'failed', 'Peer has not completed pairing');
      return;
    }
    const bytes = session
      ? base64ToBytes(await session.decrypt(payload.encrypted ?? { ciphertext: '', iv: '' }))
      : base64ToBytes(payload.chunk);
    const expectedSize = Math.min(DEFAULT_CHUNK_SIZE, transfer.size - payload.chunkIndex * DEFAULT_CHUNK_SIZE);
    if (bytes.length !== expectedSize) throw new Error('Invalid chunk size');
    if (await sha256(bytes) !== payload.sha256) {
      await incoming.connection.send(this.message('FILE_ERROR', { fileId: payload.fileId, reason: 'Chunk checksum mismatch' } satisfies FileErrorPayload));
      this.update(transfer, 'failed', 'Chunk checksum mismatch');
      return;
    }
    incoming.chunks.set(payload.chunkIndex, bytesToBase64(bytes));
    transfer.transferredChunks = incoming.chunks.size;
    this.update(transfer, 'transferring');
  }

  private async receiveComplete(payload: FileCompletePayload): Promise<void> {
    const incoming = this.incoming.get(payload.fileId);
    const transfer = this.transfers.get(payload.fileId);
    if (transfer && this.outgoing.has(payload.fileId)) {
      if (transfer.state === 'transferring' && payload.sha256 === transfer.sha256 && transfer.transferredChunks === transfer.totalChunks) this.update(transfer, 'completed');
      return;
    }
    if (!incoming || !transfer) return;
    if (!['accepted', 'transferring'].includes(transfer.state) || incoming.chunks.size !== transfer.totalChunks) throw new Error('Incomplete file');
    const bytes = concatChunks(incoming.chunks, transfer.totalChunks);
    if (bytes.length !== transfer.size || payload.sha256 !== transfer.sha256 || await sha256(bytes) !== transfer.sha256) {
      this.update(transfer, 'failed', 'File checksum mismatch');
      await incoming.connection.send(this.message('FILE_ERROR', { fileId: payload.fileId, reason: 'File checksum mismatch' } satisfies FileErrorPayload));
      return;
    }
    this.update(transfer, 'completed');
    for (const listener of this.receivedListeners) listener({ transfer, bytes });
    await incoming.connection.send(this.message('FILE_COMPLETE', payload));
  }

  private update(transfer: FileTransferModel | undefined, state: FileTransferState, error?: string): void {
    if (!transfer) return;
    transfer.state = state;
    transfer.error = error;
    this.emit(transfer);
  }

  private message<TType extends 'FILE_OFFER' | 'FILE_ACCEPT' | 'FILE_REJECT' | 'FILE_CHUNK' | 'FILE_COMPLETE' | 'FILE_CANCEL' | 'FILE_ERROR', TPayload>(type: TType, payload: TPayload): ProtocolMessage<TType, TPayload> {
    return { type, payload, timestamp: Date.now(), senderId: this.localDeviceId };
  }

  private emit(transfer: FileTransferModel): void {
    const previous = this.timers.get(transfer.id);
    if (previous) clearTimeout(previous);
    this.timers.delete(transfer.id);
    if (['completed', 'cancelled', 'failed'].includes(transfer.state)) {
      this.incoming.delete(transfer.id);
      this.outgoing.delete(transfer.id);
    } else {
      this.timers.set(transfer.id, setTimeout(() => this.update(transfer, 'failed', 'Transfer timed out; send the file again'), 60000));
    }
    void this.persist();
    const change = { transfer, transfers: this.list() };
    for (const listener of this.listeners) listener(change);
  }

  private async loadTransfers(): Promise<void> {
    const raw = await this.storage?.getItem(FILE_TRANSFER_STORE_KEY);
    if (!raw) return;
    try {
      for (const transfer of JSON.parse(raw) as FileTransferModel[]) {
        if (!['completed', 'cancelled', 'failed'].includes(transfer.state)) { transfer.state = 'failed'; transfer.error = 'Interrupted; send the file again'; }
        this.transfers.set(transfer.id, transfer);
      }
    }
    catch { await this.storage?.removeItem(FILE_TRANSFER_STORE_KEY); }
  }

  private async persist(): Promise<void> {
    await this.storage?.setItem(FILE_TRANSFER_STORE_KEY, JSON.stringify(this.list()));
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await cryptoProvider.digest(bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function createId(): string { return globalThis.crypto?.randomUUID?.() ?? `file-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function bytesToBase64(bytes: Uint8Array): string { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function base64ToBytes(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function concatChunks(chunks: Map<number, string>, total: number): Uint8Array { const values = Array.from({ length: total }, (_, index) => base64ToBytes(chunks.get(index) ?? '')); const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0)); let offset = 0; for (const value of values) { result.set(value, offset); offset += value.length; } return result; }
