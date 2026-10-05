import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import {
  APP_VERSION,
  BrowserStorageAdapter,
  DEFAULT_PORT,
  FileTransferService,
  LocalPeerConnectionManager,
  MessageService,
  PairingCoordinator,
  PairingService,
  type DeviceProfile,
  type NearbyDevice,
  type PeerConnection,
  type TrustedDevice,
} from '@ip-messenger/shared';
import type { FileTransferModel, MessageModel } from '@ip-messenger/models';
import type { PairRequestPayload } from '@ip-messenger/protocol';
import { deviceProfileService } from './identity';
import { discoveryService, loadNearbyDevices } from './discovery';
import { createAcceptedIpcSocket, ipcPeerSocketFactory } from './ipc-socket';

const styles = {
  app: { minHeight: '100vh', background: '#f4f1eb', color: '#1f2925', fontFamily: 'Georgia, serif' },
  shell: { display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', minHeight: '100vh' },
  sidebar: { padding: 28, background: '#173b35', color: '#f4f1eb' },
  content: { display: 'flex', flexDirection: 'column' as const, minWidth: 0 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '28px 38px', borderBottom: '1px solid #d9d4c9' },
  conversation: { display: 'flex', flex: 1, flexDirection: 'column' as const, padding: '28px 38px', minHeight: 0 },
  composer: { display: 'flex', gap: 10, marginTop: 'auto', paddingTop: 24 },
};

function Home() {
  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const [devices, setDevices] = useState<NearbyDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Record<string, MessageModel[]>>({});
  const [pairingCode, setPairingCode] = useState('');
  const [pairingNotice, setPairingNotice] = useState('');
  const [approvalCode, setApprovalCode] = useState('');
  const [incomingPairRequest, setIncomingPairRequest] = useState<PairRequestPayload | null>(null);
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([]);
  const [transfers, setTransfers] = useState<FileTransferModel[]>([]);
  const [incomingFileOffers, setIncomingFileOffers] = useState<FileTransferModel[]>([]);
  const connectionManagerRef = useRef<LocalPeerConnectionManager | null>(null);
  const messageServiceRef = useRef<MessageService | null>(null);
  const fileTransferServiceRef = useRef<FileTransferService | null>(null);
  const pairingCoordinatorRef = useRef<PairingCoordinator | null>(null);
  const pairingServiceRef = useRef<PairingService | null>(null);
  const pendingPairConnectionRef = useRef<PeerConnection | null>(null);

  useEffect(() => {
    let mounted = true;
    let unsubscribeMessages = () => {};
    let unsubscribeConnections = () => {};
    let unsubscribePairRequests = () => {};
    let unsubscribeTransfers = () => {};
    let unsubscribeFileOffers = () => {};
    let unsubscribeServer = () => {};
    let unsubscribeOpenConversation = () => {};

    void (async () => {
      const nextProfile = await deviceProfileService.load();
      if (!mounted) {
        return;
      }
      setProfile(nextProfile);
      const connectionManager = new LocalPeerConnectionManager(
        {
          deviceId: nextProfile.deviceId,
          deviceName: nextProfile.displayName,
          platform: nextProfile.platform,
          appVersion: APP_VERSION,
          port: DEFAULT_PORT,
        },
        ipcPeerSocketFactory,
      );
      const storage = new BrowserStorageAdapter();
      const pairingService = new PairingService(nextProfile.deviceId, nextProfile.displayName, storage);
      const coordinator = new PairingCoordinator(pairingService);
      pairingCoordinatorRef.current = coordinator;
      pairingServiceRef.current = pairingService;
      unsubscribePairRequests = coordinator.onPairRequest((connection, request) => {
        pendingPairConnectionRef.current = connection;
        setIncomingPairRequest(request);
        setApprovalCode('');
        setPairingNotice(`Pairing request from ${request.requesterName}`);
      });
      unsubscribeConnections = connectionManager.onConnectionChange((connections) => {
        for (const connection of connections) {
          coordinator.attachConnection(connection);
        }
      });
      unsubscribeServer = window.peerNetworking.onServerConnection((socketId, endpoint) => {
        void connectionManager.accept(endpoint, createAcceptedIpcSocket(socketId)).catch(() => undefined);
      });
      const messageService = new MessageService(nextProfile.deviceId, connectionManager, storage, coordinator);
      const fileTransferService = new FileTransferService(nextProfile.deviceId, connectionManager, storage, coordinator);
      connectionManagerRef.current = connectionManager;
      messageServiceRef.current = messageService;
      fileTransferServiceRef.current = fileTransferService;
      unsubscribeMessages = messageService.onChange((nextMessages) => {
        const grouped = nextMessages.reduce<Record<string, MessageModel[]>>((result, message) => {
          const peerId = message.senderId === nextProfile.deviceId ? message.receiverId : message.senderId;
          result[peerId] = [...(result[peerId] ?? []), message];
          return result;
        }, {});
        setMessages(grouped);
        const newest = nextMessages[nextMessages.length - 1];
        if (newest && newest.receiverId === nextProfile.deviceId && newest.state === 'delivered') {
          void window.peerNetworking.notify({ title: 'IP Messenger', body: `${newest.senderId}: ${newest.text}`, conversationId: newest.senderId });
        }
      });
      unsubscribeOpenConversation = window.peerNetworking.onOpenConversation((conversationId) => {
        setOpenConversationId(conversationId);
        setSelectedDeviceId(conversationId);
      });
      await connectionManager.start();
      await window.peerNetworking.startServer({
        deviceId: nextProfile.deviceId,
        deviceName: nextProfile.displayName,
        platform: nextProfile.platform,
        appVersion: APP_VERSION,
        port: DEFAULT_PORT,
      });
      await coordinator.start();
      await messageService.start();
      unsubscribeTransfers = fileTransferService.onChange((change) => setTransfers(change.transfers));
      unsubscribeFileOffers = fileTransferService.onOffer((transfer) => setIncomingFileOffers((current) => [...current, transfer]));
      await fileTransferService.start();
      fileTransferService.onReceived(({ transfer, bytes }) => {
        const blob = new Blob([bytes as unknown as ArrayBuffer], { type: transfer.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = transfer.name;
        anchor.click();
        URL.revokeObjectURL(url);
      });
      setTransfers(fileTransferService.list());
      setTrustedDevices(await pairingService.listTrustedDevices());
      const nextDevices = await loadNearbyDevices();
      setDevices(nextDevices);
      setSelectedDeviceId(nextDevices[0]?.deviceId ?? null);
      await discoveryService.start();
      await window.peerNetworking.setNearbyCount(nextDevices.length);
    })();

    const unsubscribeDiscovery = discoveryService.onChange((next) => {
      setDevices(next);
      setSelectedDeviceId((current) => current ?? next[0]?.deviceId ?? null);
    });

    return () => {
      mounted = false;
      unsubscribeConnections();
      unsubscribePairRequests();
      unsubscribeServer();
      unsubscribeOpenConversation();
      void window.peerNetworking.stopServer();
      unsubscribeDiscovery();
      unsubscribeMessages();
      unsubscribeTransfers();
      unsubscribeFileOffers();
      messageServiceRef.current?.stop();
      fileTransferServiceRef.current?.stop();
      void connectionManagerRef.current?.stop();
    };
  }, []);

  const selectedDevice = devices.find((device) => device.deviceId === selectedDeviceId);
  const conversation = useMemo(
    () => (selectedDeviceId ? messages[selectedDeviceId] ?? [] : []),
    [messages, selectedDeviceId],
  );

  useEffect(() => {
    const messageService = messageServiceRef.current;
    if (!messageService || !profile) {
      return;
    }
    for (const message of conversation) {
      if (message.receiverId === profile.deviceId && message.state === 'delivered') {
        void messageService.markRead(message.id);
      }
    }
  }, [conversation, profile]);

  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    const messageService = messageServiceRef.current;
    const connectionManager = connectionManagerRef.current;
    if (!text || !selectedDevice || !profile || !messageService || !connectionManager) {
      return;
    }

    try {
      await connectionManager.connect({
        deviceId: selectedDevice.deviceId,
        deviceName: selectedDevice.deviceName,
        platform: selectedDevice.platform,
        ipAddress: selectedDevice.ipAddress ?? '127.0.0.1',
        port: selectedDevice.port ?? DEFAULT_PORT,
      });
    } catch {
      // MessageService retains the message in its offline queue when the peer is unavailable.
    }
    await messageService.sendMessage(selectedDevice.deviceId, text);
    setDraft('');
  }

  async function requestPairing(): Promise<void> {
    const coordinator = pairingCoordinatorRef.current;
    const connectionManager = connectionManagerRef.current;
    if (!coordinator || !connectionManager || !selectedDevice) {
      return;
    }
    try {
      const connection = await connectionManager.connect({
        deviceId: selectedDevice.deviceId,
        deviceName: selectedDevice.deviceName,
        platform: selectedDevice.platform,
        ipAddress: selectedDevice.ipAddress ?? '127.0.0.1',
        port: selectedDevice.port ?? DEFAULT_PORT,
      });
      setPairingNotice('Verify this code on the other device.');
      await coordinator.requestPairing(connection, setPairingCode);
      setPairingNotice('Pairing complete.');
      setPairingCode('');
      setTrustedDevices(await pairingServiceRef.current?.listTrustedDevices() ?? []);
    } catch (error) {
      setPairingNotice(error instanceof Error ? error.message : 'Pairing failed');
    }
  }

  async function acceptPairing(): Promise<void> {
    const coordinator = pairingCoordinatorRef.current;
    const connection = pendingPairConnectionRef.current;
    if (!coordinator || !connection || !incomingPairRequest || !approvalCode.trim()) {
      return;
    }
    try {
      await coordinator.acceptPairRequest(connection, incomingPairRequest, approvalCode.trim());
      setIncomingPairRequest(null);
      setApprovalCode('');
      setPairingNotice('Peer trusted and encrypted session ready.');
      setTrustedDevices(await pairingServiceRef.current?.listTrustedDevices() ?? []);
    } catch (error) {
      setPairingNotice(error instanceof Error ? error.message : 'Pairing failed');
    }
  }

  async function rejectPairing(): Promise<void> {
    const coordinator = pairingCoordinatorRef.current;
    const connection = pendingPairConnectionRef.current;
    if (coordinator && connection) {
      await coordinator.rejectPairRequest(connection, 'Pairing request rejected');
    }
    setIncomingPairRequest(null);
    setPairingNotice('Pairing request rejected.');
  }

  async function chooseFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    const service = fileTransferServiceRef.current;
    if (!file || !service || !selectedDevice) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await service.offerFile(selectedDevice.deviceId, { name: file.name, mimeType: file.type || 'application/octet-stream', bytes });
    event.target.value = '';
  }

  async function resumeFile(event: React.ChangeEvent<HTMLInputElement>, fileId: string): Promise<void> {
    const file = event.target.files?.[0];
    const service = fileTransferServiceRef.current;
    if (!file || !service) return;
    await service.resume(fileId, { name: file.name, mimeType: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) });
    event.target.value = '';
  }

  async function acceptFileOffer(fileId: string): Promise<void> {
    await fileTransferServiceRef.current?.accept(fileId);
    setIncomingFileOffers((current) => current.filter((offer) => offer.id !== fileId));
  }

  async function rejectFileOffer(fileId: string): Promise<void> {
    await fileTransferServiceRef.current?.reject(fileId);
    setIncomingFileOffers((current) => current.filter((offer) => offer.id !== fileId));
  }

  return (
    <main style={styles.app}>
      <div style={styles.shell}>
        <aside style={styles.sidebar}>
          <p style={{ margin: 0, letterSpacing: 2, textTransform: 'uppercase', fontSize: 12 }}>IP Messenger</p>
          <h1 style={{ fontSize: 32, lineHeight: 1.05, fontWeight: 400, margin: '48px 0 12px' }}>Nearby peers</h1>
          <p style={{ color: '#b7cec2', lineHeight: 1.5, marginBottom: 34 }}>Private conversations over your local network.</p>
          {devices.map((device) => (
            <button
              key={device.deviceId}
              type="button"
              onClick={() => setSelectedDeviceId(device.deviceId)}
              style={{ display: 'block', width: '100%', padding: '14px 0', textAlign: 'left', color: '#f4f1eb', background: device.deviceId === selectedDeviceId ? '#285a4f' : 'transparent', border: 0, borderBottom: '1px solid #376258', cursor: 'pointer' }}
            >
              <strong style={{ display: 'block', fontSize: 15 }}>{device.deviceName}</strong>
              <small style={{ color: '#b7cec2' }}>{device.status} · {device.platform}</small>
            </button>
          ))}
          <h2 style={{ margin: '36px 0 12px', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 400 }}>Trusted devices</h2>
          {trustedDevices.length === 0 ? (
            <small style={{ color: '#b7cec2' }}>No trusted devices yet.</small>
          ) : (
            trustedDevices.map((device) => (
              <div key={device.deviceId} style={{ padding: '10px 0', borderBottom: '1px solid #376258' }}>
                <strong style={{ display: 'block', fontSize: 14 }}>{device.deviceName}</strong>
                <small style={{ color: '#b7cec2', wordBreak: 'break-word' }}>{device.fingerprint}</small>
              </div>
            ))
          )}
        </aside>

        <section style={styles.content}>
          <header style={styles.header}>
            <div>
              <p style={{ margin: 0, color: '#63736b', fontSize: 13 }}>CONVERSATION</p>
              <h2 style={{ margin: '5px 0 0', fontSize: 28, fontWeight: 400 }}>{selectedDevice?.deviceName ?? 'Select a nearby peer'}</h2>
            </div>
            <span style={{ color: '#63736b', fontSize: 13 }}>{selectedDevice?.status ?? 'offline'}</span>
          </header>

          <section style={{ padding: '18px 38px', borderBottom: '1px solid #d9d4c9', background: '#fffdf8' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => void requestPairing()} disabled={!selectedDevice} style={{ padding: '9px 14px', border: 0, borderRadius: 6, background: '#173b35', color: '#fffdf8', cursor: 'pointer' }}>Request pairing</button>
              {pairingCode && <strong style={{ letterSpacing: 3 }}>Code: {pairingCode}</strong>}
              {pairingNotice && <span style={{ color: '#63736b', fontSize: 13 }}>{pairingNotice}</span>}
            </div>
            {incomingPairRequest && (
              <div style={{ marginTop: 14, padding: 14, border: '1px solid #d9d4c9', borderRadius: 6 }}>
                <strong>{incomingPairRequest.requesterName} wants to pair</strong>
                <p style={{ margin: '8px 0', color: '#63736b', fontSize: 13, wordBreak: 'break-word' }}>Fingerprint: {incomingPairRequest.fingerprint}</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input value={approvalCode} onChange={(event) => setApprovalCode(event.target.value)} placeholder="Enter the displayed code" style={{ padding: 9, border: '1px solid #c8c1b5', borderRadius: 6 }} />
                  <button type="button" onClick={() => void acceptPairing()} disabled={!approvalCode.trim()} style={{ padding: '9px 14px', border: 0, borderRadius: 6, background: '#c86b42', color: '#fffdf8' }}>Approve</button>
                  <button type="button" onClick={() => void rejectPairing()} style={{ padding: '9px 14px', border: '1px solid #c8c1b5', borderRadius: 6, background: 'transparent' }}>Reject</button>
                </div>
              </div>
            )}
          </section>

          <section style={{ padding: '14px 38px', borderBottom: '1px solid #d9d4c9' }}>
            <label style={{ display: 'inline-block', padding: '9px 14px', borderRadius: 6, background: '#63736b', color: '#fffdf8', cursor: selectedDevice ? 'pointer' : 'not-allowed', opacity: selectedDevice ? 1 : 0.5 }}>
              Share file
              <input type="file" disabled={!selectedDevice} onChange={(event) => void chooseFile(event)} style={{ display: 'none' }} />
            </label>
            {transfers.filter((transfer) => selectedDevice && (transfer.senderId === selectedDevice.deviceId || transfer.receiverId === selectedDevice.deviceId)).map((transfer) => (
              <div key={transfer.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 13 }}>
                <span style={{ minWidth: 150 }}>{transfer.name}</span>
                <progress value={transfer.transferredChunks} max={transfer.totalChunks} />
                <span>{transfer.state}</span>
                {(transfer.state === 'offered' || transfer.state === 'transferring') && <button type="button" onClick={() => void fileTransferServiceRef.current?.cancel(transfer.id)}>Cancel</button>}
                {transfer.error?.includes('original file') && <label style={{ cursor: 'pointer' }}>Resume<input type="file" onChange={(event) => void resumeFile(event, transfer.id)} style={{ display: 'none' }} /></label>}
              </div>
            ))}
            {incomingFileOffers.filter((offer) => !selectedDevice || offer.senderId === selectedDevice.deviceId).map((offer) => (
              <div key={offer.id} style={{ marginTop: 12, padding: 12, border: '1px solid #d9d4c9', borderRadius: 6 }}>
                <strong>{offer.name}</strong>
                <span style={{ marginLeft: 10, color: '#63736b', fontSize: 13 }}>{offer.size} bytes wants to send</span>
                <button type="button" onClick={() => void acceptFileOffer(offer.id)} style={{ marginLeft: 12 }}>Accept</button>
                <button type="button" onClick={() => void rejectFileOffer(offer.id)} style={{ marginLeft: 6 }}>Reject</button>
              </div>
            ))}
          </section>

          <section style={styles.conversation}>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {conversation.length === 0 ? (
                <p style={{ color: '#63736b', maxWidth: 420 }}>No messages yet. Start a local conversation when your peer is connected.</p>
              ) : (
                conversation.map((message) => (
                  <article key={message.id} style={{ maxWidth: 560, marginBottom: 18, marginLeft: message.senderId === profile?.deviceId ? 'auto' : 0 }}>
                    <div style={{ padding: '14px 16px', background: message.senderId === profile?.deviceId ? '#d9e8df' : '#fffdf8', border: '1px solid #d9d4c9', borderRadius: 6 }}>{message.text}</div>
                    <small style={{ display: 'block', marginTop: 5, color: '#63736b', textAlign: message.senderId === profile?.deviceId ? 'right' : 'left' }}>{message.state}</small>
                  </article>
                ))
              )}
            </div>

            <form style={styles.composer} onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={selectedDevice ? 'Write a message...' : 'Choose a peer first'}
                disabled={!selectedDevice}
                style={{ flex: 1, minWidth: 0, padding: '14px 16px', border: '1px solid #c8c1b5', borderRadius: 6, background: '#fffdf8', font: 'inherit' }}
              />
              <button type="submit" disabled={!selectedDevice || !draft.trim()} style={{ padding: '0 22px', border: 0, borderRadius: 6, background: '#c86b42', color: '#fffdf8', font: 'inherit', cursor: 'pointer' }}>Send</button>
            </form>
          </section>
        </section>
      </div>
    </main>
  );
}

function Settings() {
  return (
    <main style={{ padding: 32, fontFamily: 'Georgia, serif' }}>
      <h2>Settings</h2>
      <p>Version {APP_VERSION} · TCP port {DEFAULT_PORT}</p>
      <Link to="/">Back to conversations</Link>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
