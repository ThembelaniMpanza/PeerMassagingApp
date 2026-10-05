import type { PeerSocket, PeerSocketFactory } from '@ip-messenger/networking';

declare global {
  interface Window {
    peerNetworking: {
      connect(socketId: string, host: string, port: number, timeoutMs: number): Promise<void>;
      write(socketId: string, data: string): Promise<void>;
      close(socketId: string): Promise<void>;
      onData(socketId: string, listener: (data: string) => void): () => void;
      onClose(socketId: string, listener: () => void): () => void;
      onError(socketId: string, listener: (error: Error) => void): () => void;
      startServer(identity: { deviceId: string; deviceName: string; platform: string; appVersion: string; port: number }): Promise<void>;
      stopServer(): Promise<void>;
      onServerConnection(listener: (socketId: string, endpoint: { deviceId: string; deviceName: string; platform: 'android' | 'ios' | 'windows' | 'macos'; ipAddress: string; port: number }) => void): () => void;
      setNearbyCount(count: number): Promise<void>;
      notify(payload: { title: string; body: string; conversationId?: string }): Promise<void>;
      getStartup(): Promise<{ enabled: boolean; startMinimized: boolean }>;
      setStartup(enabled: boolean): Promise<void>;
      show(conversationId?: string): Promise<void>;
      onOpenConversation(listener: (conversationId: string) => void): () => void;
    };
  }
}

class IpcPeerSocket implements PeerSocket {
  private readonly socketId: string;

  constructor(socketId = `socket-${Date.now()}-${Math.random().toString(16).slice(2)}`) {
    this.socketId = socketId;
  }

  connect(host: string, port: number, timeoutMs: number): Promise<void> {
    return window.peerNetworking.connect(this.socketId, host, port, timeoutMs);
  }

  write(data: string): Promise<void> {
    return window.peerNetworking.write(this.socketId, data);
  }

  onData(listener: (data: string) => void): () => void {
    return window.peerNetworking.onData(this.socketId, listener);
  }

  onClose(listener: () => void): () => void {
    return window.peerNetworking.onClose(this.socketId, listener);
  }

  onError(listener: (error: Error) => void): () => void {
    return window.peerNetworking.onError(this.socketId, listener);
  }

  close(): Promise<void> {
    return window.peerNetworking.close(this.socketId);
  }
}

export const ipcPeerSocketFactory: PeerSocketFactory = {
  create: () => new IpcPeerSocket(),
};

export function createAcceptedIpcSocket(socketId: string): PeerSocket {
  return new IpcPeerSocket(socketId);
}
