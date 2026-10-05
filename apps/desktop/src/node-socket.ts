import { Socket } from 'node:net';
import type { PeerSocket, PeerSocketFactory } from '@ip-messenger/networking';

class NodeTcpSocket implements PeerSocket {
  private readonly socket = new Socket();
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private connected = false;

  constructor() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (data: string | Buffer) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      for (const listener of this.dataListeners) {
        listener(text);
      }
    });
    this.socket.on('close', () => {
      this.connected = false;
      for (const listener of this.closeListeners) {
        listener();
      }
    });
    this.socket.on('error', (error) => {
      for (const listener of this.errorListeners) {
        listener(error);
      }
    });
  }

  connect(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.connected = true;
        this.socket.setTimeout(0);
        resolve();
      };
      const onError = (error: Error) => {
        this.socket.removeListener('connect', onConnect);
        reject(error);
      };
      const onTimeout = () => {
        const error = new Error(`TCP connection timed out after ${timeoutMs}ms`);
        this.socket.destroy(error);
        reject(error);
      };

      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
      this.socket.setTimeout(timeoutMs, onTimeout);
      this.socket.connect(port, host);
    });
  }

  write(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('TCP socket is not connected'));
        return;
      }
      this.socket.write(data, 'utf8', (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.once('close', () => resolve());
      this.socket.end();
    });
  }
}

export const nodeTcpSocketFactory: PeerSocketFactory = {
  create: () => new NodeTcpSocket(),
};
