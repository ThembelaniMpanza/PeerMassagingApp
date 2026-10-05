import { createServer, type Socket } from 'node:net';
import type {
  DeviceInfoPayload,
  HelloPayload,
  MessageAckPayload,
  MessagePayload,
  PingPayload,
  ProtocolMessage,
  PongPayload,
} from '@ip-messenger/protocol';
import type { LocalPeerIdentity } from '@ip-messenger/networking';

const FRAME_SEPARATOR = '\n';

export interface PeerServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createPeerServer(identity: LocalPeerIdentity): PeerServer {
  const server = createServer((socket) => handleSocket(socket, identity));

  return {
    start: () => new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(identity.port, '0.0.0.0');
    }),
    stop: () => new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    }),
  };
}

function handleSocket(socket: Socket, identity: LocalPeerIdentity): void {
  let inputBuffer = '';
  socket.setEncoding('utf8');

  socket.on('data', (data: string | Buffer) => {
    inputBuffer += typeof data === 'string' ? data : data.toString('utf8');
    const frames = inputBuffer.split(FRAME_SEPARATOR);
    inputBuffer = frames.pop() ?? '';

    for (const frame of frames) {
      if (!frame.trim()) {
        continue;
      }

      let message: ProtocolMessage;
      try {
        message = JSON.parse(frame) as ProtocolMessage;
      } catch {
        socket.destroy(new Error('Invalid protocol frame'));
        return;
      }

      if (message.type === 'HELLO') {
        const hello = message.payload as HelloPayload;
        send(socket, {
          type: 'DEVICE_INFO',
          payload: {
            deviceId: identity.deviceId,
            deviceName: identity.deviceName,
            platform: identity.platform,
            appVersion: identity.appVersion,
          } satisfies DeviceInfoPayload,
          timestamp: Date.now(),
          senderId: identity.deviceId,
          receiverId: hello.deviceId,
        });
      } else if (message.type === 'PING') {
        const ping = message.payload as PingPayload;
        send(socket, {
          type: 'PONG',
          payload: { nonce: ping.nonce } satisfies PongPayload,
          timestamp: Date.now(),
          senderId: identity.deviceId,
          receiverId: message.senderId,
        });
      } else if (message.type === 'MESSAGE') {
        const payload = message.payload as MessagePayload;
        send(socket, {
          type: 'MESSAGE_ACK',
          payload: {
            messageId: payload.messageId,
            receiverId: identity.deviceId,
            deliveredAt: Date.now(),
          } satisfies MessageAckPayload,
          timestamp: Date.now(),
          senderId: identity.deviceId,
          receiverId: message.senderId,
        });
      } else if (message.type === 'DISCONNECT') {
        socket.end();
      }
    }
  });
}

function send(socket: Socket, message: ProtocolMessage): void {
  socket.write(`${JSON.stringify(message)}${FRAME_SEPARATOR}`, 'utf8');
}
