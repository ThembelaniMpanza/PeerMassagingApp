import TcpSocket from 'react-native-tcp-socket';
import { NativeModules } from 'react-native';
import type Socket from 'react-native-tcp-socket/lib/types/Socket';
import type { PeerSocket, PeerSocketFactory, ConnectionManager } from '@ip-messenger/networking';

export class MobileSocket implements PeerSocket {
  private readonly socket: Socket;
  private readonly decoder = new TextDecoder();
  constructor(socket?: Socket) { this.socket = socket ?? new TcpSocket.Socket(); }
  connect(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error('Connection timed out')); }, timeoutMs);
      const error = (cause: Error) => { clearTimeout(timer); reject(cause); };
      this.socket.once('error', error);
      this.socket.connect({ host, port, connectTimeout: timeoutMs }, () => {
        clearTimeout(timer); this.socket.removeListener('error', error); this.socket.setKeepAlive(true); resolve();
      });
    });
  }
  write(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) { reject(new Error('Connection closed')); return; }
      this.socket.write(data, 'utf8', (error?: Error | null) => error ? reject(error) : resolve());
    });
  }
  onData(listener: (data: string) => void): () => void {
    const handler = (data: string | Uint8Array) => listener(typeof data === 'string' ? data : this.decoder.decode(data, { stream: true }));
    this.socket.on('data', handler); return () => this.socket.removeListener('data', handler);
  }
  onClose(listener: () => void): () => void { this.socket.on('close', listener); return () => this.socket.removeListener('close', listener); }
  onError(listener: (error: Error) => void): () => void { this.socket.on('error', listener); return () => this.socket.removeListener('error', listener); }
  async close(): Promise<void> { this.socket.destroy(); }
}
export const mobileSocketFactory: PeerSocketFactory = { create: () => new MobileSocket() };
export function createMobileServer(manager: ConnectionManager, onError: (error: Error) => void) {
  if (!NativeModules.TcpSockets) throw new Error('Open the installed IP Messenger development build. Expo Go does not include the TCP/UDP networking modules.');
  const server = TcpSocket.createServer((socket) => {
    void manager.accept({ deviceId: '', deviceName: 'Connecting device', platform: 'android',
      ipAddress: socket.remoteAddress ?? '', port: socket.remotePort ?? 5050 }, new MobileSocket(socket)).catch(onError);
  });
  server.on('error', onError);
  return {
    start: () => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '0.0.0.0', port: 5050, reuseAddress: true }, () => { server.removeListener('error', reject); resolve(); });
    }),
    stop: () => new Promise<void>((resolve) => { if (!server.listening) resolve(); else server.close(() => resolve()); }),
  };
}
