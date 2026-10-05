export type MessageState = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface MessageModel {
  id: string;
  senderId: string;
  receiverId: string;
  text: string;
  timestamp: number;
  state: MessageState;
}

export interface MessageStore {
  list(receiverId?: string): MessageModel[];
  get(messageId: string): MessageModel | undefined;
}

export interface DeviceModel {
  id: string;
  name: string;
  platform: string;
  ipAddress?: string;
  port?: number;
  trusted: boolean;
}

export interface ConversationModel {
  id: string;
  deviceId: string;
  displayName: string;
  lastMessage?: string;
  lastTimestamp?: number;
  unreadCount: number;
  online: boolean;
}

export type FileTransferState = 'offered' | 'accepted' | 'transferring' | 'completed' | 'cancelled' | 'failed';

export interface FileTransferModel {
  id: string;
  senderId: string;
  receiverId: string;
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  transferredChunks: number;
  sha256: string;
  state: FileTransferState;
  error?: string;
}
