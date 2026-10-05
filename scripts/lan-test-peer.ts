// Explicit test peer: approves pairing requests and echoes messages for emulator smoke tests.
import dgram from 'node:dgram';
import { createPeer } from './peer-fixture';

async function main() {
  const peer = await createPeer('Development test peer', 5052);
  const discovery = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discovery.on('error', (error) => console.error(error.message));
  discovery.bind(5051, () => discovery.setBroadcast(true));
  const presence = Buffer.from(JSON.stringify({ service: 'ip-messenger', version: 1, deviceId: peer.id, deviceName: peer.id, platform: 'windows', port: peer.port }));
  const announce = () => {
    discovery.send(presence, 5051, '255.255.255.255');
    if (process.env.EMULATOR_DISCOVERY_PORT) discovery.send(presence, Number(process.env.EMULATOR_DISCOVERY_PORT), '127.0.0.1');
  };
  discovery.on('message', (bytes, remote) => {
    try { if (JSON.parse(bytes.toString()).deviceId !== peer.id) discovery.send(presence, remote.port, remote.address); } catch {}
  });
  const timer = setInterval(announce, 5000);
  peer.coordinator.onPairRequest((connection, request) => {
    console.log(`Test pairing: ${request.requesterName}; code ${request.pairingCode}`);
    void peer.coordinator.acceptPairRequest(connection, request, request.pairingCode).then(() => console.log('PAIRED')).catch(console.error);
  });
  const handled = new Set<string>();
  peer.messages.onChange((messages) => {
    for (const message of messages) if (message.receiverId === peer.id && !handled.has(message.id)) {
      handled.add(message.id);
      console.log(`RECEIVED MESSAGE: ${message.text}`);
      void (async () => {
        await peer.messages.markRead(message.id);
        await peer.messages.sendMessage(message.senderId, `Echo: ${message.text}`);
        await peer.files.offerFile(message.senderId, { name: 'hello-from-desktop.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Verified encrypted file from the desktop test peer.\n') });
      })().catch(console.error);
    }
  });
  peer.files.onOffer((transfer) => { console.log(`RECEIVING FILE: ${transfer.name}`); void peer.files.accept(transfer.id).catch(console.error); });
  peer.files.onReceived(({ transfer, bytes }) => console.log(`FILE VERIFIED: ${transfer.name}, ${bytes.length} bytes, SHA-256 ${transfer.sha256}`));
  console.log('Test peer on TCP 5052 / UDP 5051. Android emulator: connect to 10.0.2.2:5052.');
  process.on('SIGINT', () => { clearInterval(timer); discovery.close(); void peer.close().then(() => process.exit(0)); });
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
