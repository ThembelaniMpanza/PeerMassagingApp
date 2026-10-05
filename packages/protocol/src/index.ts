export type ProtocolEventType =
  | 'HELLO'
  | 'DEVICE_INFO'
  | 'PAIR_REQUEST'
  | 'PAIR_ACCEPT'
  | 'PAIR_REJECT'
  | 'MESSAGE'
  | 'MESSAGE_ACK'
  | 'MESSAGE_READ'
  | 'TYPING_START'
  | 'TYPING_STOP'
  | 'FILE_OFFER'
  | 'FILE_ACCEPT'
  | 'FILE_REJECT'
  | 'FILE_START'
  | 'FILE_CHUNK'
  | 'FILE_COMPLETE'
  | 'FILE_CANCEL'
  | 'FILE_ERROR'
  | 'PING'
  | 'PONG'
  | 'DISCONNECT';

export const PROTOCOL_EVENT_TYPES: readonly ProtocolEventType[] = [
  'HELLO', 'DEVICE_INFO', 'PAIR_REQUEST', 'PAIR_ACCEPT', 'PAIR_REJECT',
  'MESSAGE', 'MESSAGE_ACK', 'MESSAGE_READ', 'TYPING_START', 'TYPING_STOP',
  'FILE_OFFER', 'FILE_ACCEPT', 'FILE_REJECT', 'FILE_START', 'FILE_CHUNK',
  'FILE_COMPLETE', 'FILE_CANCEL', 'FILE_ERROR', 'PING', 'PONG', 'DISCONNECT',
];

export interface ProtocolMessage<TType extends ProtocolEventType = ProtocolEventType, TPayload = unknown> {
  type: TType;
  payload: TPayload;
  timestamp: number;
  senderId: string;
  receiverId?: string;
}

export function parseProtocolMessage(value: string): ProtocolMessage {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Protocol frame must be an object');
  const message = parsed as Partial<ProtocolMessage>;
  if (typeof message.type !== 'string' || !PROTOCOL_EVENT_TYPES.includes(message.type as ProtocolEventType)) throw new Error('Unknown protocol event');
  if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) throw new Error('Invalid protocol timestamp');
  if (typeof message.senderId !== 'string' || !message.senderId) throw new Error('Invalid protocol sender');
  if (!('payload' in message)) throw new Error('Protocol payload is required');
  return message as ProtocolMessage;
}

export interface HelloPayload {
  deviceId: string;
  deviceName: string;
  platform: string;
  port: number;
}

export interface DeviceInfoPayload {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
}

export interface PairRequestPayload {
  pairingCode: string;
  requesterId: string;
  requesterName: string;
  publicKey: string;
  fingerprint: string;
}

export interface PairAcceptPayload {
  pairingCode: string;
  responderId: string;
  responderName: string;
  publicKey: string;
  fingerprint: string;
}

export interface PairRejectPayload {
  reason: string;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
}

export interface PingPayload {
  nonce: string;
}

export interface PongPayload {
  nonce: string;
}

export interface DisconnectPayload {
  deviceId: string;
  reason: string;
}

export interface MessagePayload {
  messageId: string;
  senderId: string;
  receiverId: string;
  text: string;
  timestamp: number;
  encrypted?: EncryptedPayload;
}

export interface MessageAckPayload {
  messageId: string;
  receiverId: string;
  deliveredAt: number;
}

export interface MessageReadPayload {
  messageId: string;
  readerId: string;
  readAt: number;
}

export interface FileOfferPayload {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  senderId: string;
  totalChunks: number;
  chunkSize: number;
  sha256: string;
}

export interface FileAcceptPayload {
  fileId: string;
  receiverId: string;
  resumeFromChunk: number;
}

export interface FileRejectPayload {
  fileId: string;
  reason: string;
}

export interface FileChunkPayload {
  fileId: string;
  chunkIndex: number;
  chunk: string;
  totalChunks: number;
  sha256: string;
  encrypted?: EncryptedPayload;
}

export interface FileCompletePayload {
  fileId: string;
  sha256: string;
}

export interface FileCancelPayload {
  fileId: string;
  reason: string;
}

export interface FileErrorPayload {
  fileId: string;
  reason: string;
}
