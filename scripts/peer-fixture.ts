import net from 'node:net';
import { LocalPeerConnectionManager, type PeerSocket } from '../packages/networking/src/index';
import { MemoryStorageAdapter, PairingService, PairingCoordinator, MessageService, FileTransferService } from '../packages/shared/src/index';

export class TestSocket implements PeerSocket {
  constructor(readonly socket = new net.Socket(), private readonly capture?: (data: string) => void) { socket.setEncoding('utf8'); }
  connect(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error('Connect timed out')); }, timeoutMs);
      this.socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      this.socket.connect(port, host, () => { clearTimeout(timer); resolve(); });
    });
  }
  write(data: string): Promise<void> { this.capture?.(data); return new Promise((resolve, reject) => this.socket.write(data, (error) => error ? reject(error) : resolve())); }
  onData(listener: (data: string) => void): () => void { this.socket.on('data', listener); return () => this.socket.off('data', listener); }
  onClose(listener: () => void): () => void { this.socket.on('close', listener); return () => this.socket.off('close', listener); }
  onError(listener: (error: Error) => void): () => void { this.socket.on('error', listener); return () => this.socket.off('error', listener); }
  async close(): Promise<void> { this.socket.destroy(); }
}

export async function createPeer(id: string, port = 0) {
  const wire: string[] = [];
  const errors: Error[] = [];
  const storage = new MemoryStorageAdapter();
  const manager = new LocalPeerConnectionManager({ deviceId: id, deviceName: id, platform: 'windows', appVersion: '1.0.0', port },
    { create: () => new TestSocket(undefined, (data) => wire.push(data)) });
  const pairing = new PairingService(id, id, storage);
  const coordinator = new PairingCoordinator(pairing);
  manager.onConnectionChange((connections) => { for (const connection of connections) coordinator.attachConnection(connection); });
  const messages = new MessageService(id, manager, storage, coordinator);
  const files = new FileTransferService(id, manager, storage, coordinator);
  await coordinator.start(); await messages.start(); await files.start(); await manager.start();
  const server = net.createServer((socket) => {
    if (process.env.PEER_TRACE) {
      let frames = '';
      socket.on('data', (data) => {
        frames += data.toString();
        const lines = frames.split('\n'); frames = lines.pop() ?? '';
        for (const line of lines) { try { console.log('Received protocol event:', JSON.parse(line).type); } catch {} }
      });
      socket.on('close', () => console.log('Test peer socket closed'));
    }
    void manager.accept({ deviceId: '', deviceName: 'Connecting', platform: 'android', ipAddress: socket.remoteAddress ?? '', port: socket.remotePort ?? 0 },
      new TestSocket(socket, (data) => wire.push(data))).catch((error) => errors.push(error));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  const actualPort = (server.address() as net.AddressInfo).port;
  return { id, port: actualPort, wire, errors, manager, coordinator, pairing, messages, files, storage,
    endpoint: { deviceId: id, deviceName: id, platform: 'windows' as const, ipAddress: '127.0.0.1', port: actualPort },
    async close() { files.stop(); messages.stop(); await manager.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

export async function until(predicate: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
