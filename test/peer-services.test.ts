import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createPeer, until } from '../scripts/peer-fixture';
import { createMobileCrypto } from '../apps/mobile/src/crypto';
import { cryptoProvider } from '../packages/shared/src/crypto-provider';

test('mobile P-256 and AES-GCM interoperate with desktop WebCrypto; tampering is rejected', async () => {
  const mobile = createMobileCrypto(randomBytes);
  const desktop = cryptoProvider;
  const a = await mobile.generateKeyPair(); const b = await desktop.generateKeyPair();
  const aKey = await mobile.deriveKey(a.privateKey, b.publicKey);
  const bKey = await desktop.deriveKey(b.privateKey, a.publicKey);
  assert.deepEqual([...aKey], [...bKey]);
  const iv = randomBytes(12); const bytes = new TextEncoder().encode('Hello 🌍');
  const encrypted = await mobile.encrypt(aKey, iv, bytes);
  assert.deepEqual(await desktop.decrypt(bKey, iv, encrypted), bytes);
  assert.deepEqual(await mobile.decrypt(aKey, iv, await desktop.encrypt(bKey, iv, bytes)), bytes);
  encrypted[0] ^= 1;
  await assert.rejects(() => desktop.decrypt(bKey, iv, encrypted));
});

test('real TCP: pairing, encrypted Unicode chat, queued reconnect, and verified multichunk files', { timeout: 20000 }, async () => {
  const a = await createPeer('alice'); const b = await createPeer('bob');
  try {
    b.coordinator.onPairRequest((connection, request) => { void b.coordinator.acceptPairRequest(connection, request, request.pairingCode); });
    const connection = await a.manager.connect(b.endpoint);
    await a.coordinator.requestPairing(connection);
    assert.equal((await a.pairing.listTrustedDevices())[0].deviceId, 'bob');
    const sent = await a.messages.sendMessage('bob', 'Hello 🌍, encrypted chat');
    await until(() => a.messages.get(sent.id)?.state === 'delivered');
    assert.equal(b.messages.get(sent.id)?.text, sent.text);
    await b.messages.markRead(sent.id);
    await until(() => a.messages.get(sent.id)?.state === 'read');
    const rawMessage = a.wire.map((line) => JSON.parse(line)).find((frame) => frame.type === 'MESSAGE');
    assert.equal(rawMessage.payload.text, ''); assert.ok(rawMessage.payload.encrypted.ciphertext);
    await connection.close();
    await until(async () => (await b.manager.listConnections()).length === 0);
    const queued = await a.messages.sendMessage('bob', 'Queued while disconnected');
    assert.equal(queued.state, 'queued');
    await a.manager.connect(b.endpoint);
    await until(() => a.messages.get(queued.id)?.state === 'delivered');
    assert.equal(b.messages.get(queued.id)?.text, queued.text);
    const source = randomBytes(120000); let received: Uint8Array | undefined;
    b.files.onOffer((transfer) => { void b.files.accept(transfer.id); });
    b.files.onReceived((file) => { received = file.bytes; });
    const transfer = await a.files.offerFile('bob', { name: 'binary.dat', mimeType: 'application/octet-stream', bytes: source });
    await until(() => a.files.get(transfer.id)?.state === 'completed');
    assert.deepEqual(Buffer.from(received!), source);
    for (const frame of a.wire.map((line) => JSON.parse(line)).filter((frame) => frame.type === 'FILE_CHUNK')) {
      assert.equal(frame.payload.chunk, ''); assert.ok(frame.payload.encrypted.ciphertext);
    }
    const empty = await a.files.offerFile('bob', { name: 'empty.txt', mimeType: 'text/plain', bytes: new Uint8Array() });
    await until(() => a.files.get(empty.id)?.state === 'completed');
    assert.equal(received!.length, 0);
  } finally { await a.close(); await b.close(); }
});

test('unpaired file offers and plaintext chat are rejected', { timeout: 10000 }, async () => {
  const a = await createPeer('unpaired-a'); const b = await createPeer('unpaired-b');
  try {
    const connection = await a.manager.connect(b.endpoint);
    await assert.rejects(() => a.files.offerFile(b.id, { name: 'a', mimeType: 'text/plain', bytes: new Uint8Array([1]) }), /Pair/);
    await connection.send({ type: 'MESSAGE', senderId: a.id, timestamp: Date.now(), payload: { messageId: 'plaintext', senderId: a.id, receiverId: b.id, text: 'unsafe', timestamp: Date.now() } });
    await until(async () => (await b.manager.listConnections()).length === 0);
    assert.equal(b.messages.list().length, 0);
  } finally { await a.close(); await b.close(); }
});

test('declining pairing creates no trust, and declining a file sends no chunks', { timeout: 10000 }, async () => {
  const a = await createPeer('decline-a'); const b = await createPeer('decline-b');
  try {
    const reject = b.coordinator.onPairRequest((connection) => { void b.coordinator.rejectPairRequest(connection, 'Declined'); });
    const connection = await a.manager.connect(b.endpoint);
    await assert.rejects(() => a.coordinator.requestPairing(connection), /Declined/);
    assert.equal((await a.pairing.listTrustedDevices()).length, 0);
    assert.equal((await b.pairing.listTrustedDevices()).length, 0);
    reject();
    b.coordinator.onPairRequest((remote, request) => { void b.coordinator.acceptPairRequest(remote, request, request.pairingCode); });
    await a.coordinator.requestPairing(connection);
    b.files.onOffer((transfer) => { void b.files.reject(transfer.id); });
    const transfer = await a.files.offerFile(b.id, { name: 'declined.txt', mimeType: 'text/plain', bytes: new Uint8Array([1, 2, 3]) });
    await until(() => a.files.get(transfer.id)?.state === 'cancelled');
    assert.equal(a.wire.map((line) => JSON.parse(line)).filter((frame) => frame.type === 'FILE_CHUNK').length, 0);
  } finally { await a.close(); await b.close(); }
});
