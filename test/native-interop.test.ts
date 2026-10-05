import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPeer, until } from '../scripts/peer-fixture';

test('native WPF backend interoperates with mobile protocol over TCP and preserves identity/trust', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.resolve('.artifacts/native-test-'));
  const peer = await createPeer('Native integration mobile');
  let process: ReturnType<typeof spawn>;
  let events: any[] = [];
  function start() {
    events = [];
    process = spawn('dotnet', ['test/native-interop/bin/Debug/net10.0-windows/NativeInterop.dll', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    process.stdout!.on('data', data => { buffer += data; const lines = buffer.split('\n'); buffer = lines.pop()!; for (const line of lines) events.push(JSON.parse(line)); });
    process.stderr!.on('data', data => console.error(String(data)));
  }
  const command = (value: object) => process.stdin!.write(JSON.stringify(value) + '\n');
  async function snapshot() { const count = events.length; command({ command: 'snapshot' }); await until(() => events.slice(count).some(e => e.transfers)); return events.slice(count).find(e => e.transfers); }
  async function stop() { const done = new Promise(resolve => process.once('exit', resolve)); command({ command: 'stop' }); await done; }
  try {
    start(); await until(() => events.some(e => e.ready)); const native = events.find(e => e.ready);
    const endpoint = { deviceId: native.id, deviceName: 'Native', platform: 'windows' as const, ipAddress: '127.0.0.1', port: native.port };
    const unpaired = await peer.manager.connect(endpoint);
    await unpaired.send({ type: 'MESSAGE', senderId: peer.id, timestamp: Date.now(), payload: { messageId: 'plaintext', senderId: peer.id, receiverId: native.id, text: 'Must be rejected', timestamp: Date.now() } });
    await until(async () => (await peer.manager.listConnections()).length === 0);
    assert.equal((await snapshot()).messages.length, 0);
    assert.ok(events.some(e => e.error)); events = [];
    const connection = await peer.manager.connect(endpoint); await peer.coordinator.requestPairing(connection);
    const sent = await peer.messages.sendMessage(native.id, 'Native Unicode hello 🌍');
    await until(() => peer.messages.get(sent.id)?.state === 'delivered');
    await until(() => peer.messages.list().some(m => m.text === 'Echo: Native Unicode hello 🌍'));
    for (const bytes of [randomBytes(156000), Buffer.alloc(0)]) {
      const offered = await peer.files.offerFile(native.id, { name: 'roundtrip.bin', mimeType: 'application/octet-stream', bytes });
      await until(async () => (await snapshot()).transfers.some((t: any) => t.id === offered.id));
      command({ command: 'accept', id: offered.id });
      await until(() => peer.files.get(offered.id)?.state === 'completed');
      const saved = (await snapshot()).transfers.find((t: any) => t.id === offered.id);
      assert.deepEqual(await readFile(saved.savedPath), bytes);
      const source = path.join(directory, `source-${bytes.length}.bin`); await writeFile(source, bytes);
      let received: Uint8Array | undefined;
      const unsubscribe = peer.files.onReceived(file => { received = file.bytes; });
      const offOffer = peer.files.onOffer(file => { void peer.files.accept(file.id); });
      command({ command: 'offer', peer: peer.id, path: source });
      await until(() => received !== undefined); assert.deepEqual(Buffer.from(received!), bytes); unsubscribe(); offOffer();
    }
    const declined = await peer.files.offerFile(native.id, { name: 'decline.txt', mimeType: 'text/plain', bytes: new Uint8Array([1]) });
    await until(async () => (await snapshot()).transfers.some((t: any) => t.id === declined.id)); command({ command: 'reject', id: declined.id });
    await until(() => peer.files.get(declined.id)?.state === 'cancelled');
    assert.equal(events.filter(e => e.error).length, 0, JSON.stringify(events.filter(e => e.error)));
    await stop(); await until(async () => (await peer.manager.listConnections()).length === 0);
    start(); await until(() => events.some(e => e.ready)); const restarted = events.find(e => e.ready); assert.equal(restarted.id, native.id);
    await peer.manager.connect({ ...endpoint, port: restarted.port });
    const again = await peer.messages.sendMessage(native.id, 'After desktop restart'); await until(() => peer.messages.get(again.id)?.state === 'delivered');
    assert.ok((await snapshot()).peers.find((p: any) => p.deviceId === peer.id).trusted);
    const active = (await peer.manager.listConnections())[0];
    const encrypted = await peer.coordinator.getSession(native.id)!.encrypt('Tampered payload');
    const corrupt = Buffer.from(encrypted.ciphertext, 'base64'); corrupt[0] ^= 1;
    await active.send({ type: 'MESSAGE', senderId: peer.id, timestamp: Date.now(), payload: { messageId: 'tampered', senderId: peer.id, receiverId: native.id, text: '', timestamp: Date.now(), encrypted: { ...encrypted, ciphertext: corrupt.toString('base64') } } });
    await until(async () => (await peer.manager.listConnections()).length === 0);
    assert.ok(!(await snapshot()).messages.some((m: any) => m.id === 'tampered'));
    await stop();
  } finally { process?.kill(); await peer.close(); }
});
