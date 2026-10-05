import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { NearbyDevice, PeerConnection } from '@ip-messenger/shared';
import { deviceProfileService } from './src/identity';
import { MobileRuntime, type MobileState } from './src/runtime';

function Button({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} onPress={onPress}
    style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{title}</Text></Pressable>;
}

export default function App() {
  const [runtime, setRuntime] = useState<MobileRuntime>();
  const [state, setState] = useState<MobileState>();
  const [startupError, setStartupError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [address, setAddress] = useState('');
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    let service: MobileRuntime | undefined;
    let startup: Promise<void>;
    setStartupError(''); setState(undefined); setRuntime(undefined);
    startup = (async () => {
      const profile = await deviceProfileService.load();
      if (!active) return;
      service = new MobileRuntime(profile, (snapshot) => { if (active) setState(snapshot); });
      setRuntime(service);
      await service.start();
    })().catch((error) => { if (active) setStartupError(error instanceof Error ? error.message : 'Unable to start'); });
    const subscription = AppState.addEventListener('change', (value) => { if (value === 'active') service?.discovery.refresh(); });
    return () => { active = false; subscription.remove(); void startup.then(() => service?.stop()); };
  }, [generation]);

  const run = (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); runtime?.clearError();
    void action().catch((error) => runtime?.fail(error)).finally(() => setBusy(false));
  };
  const connection = state?.connections.find((item) => item.remoteDeviceId === selectedId && item.state === 'connected');
  const trusted = state?.trusted.some((item) => item.deviceId === selectedId) ?? false;
  const peers = new Map<string, NearbyDevice>();
  for (const peer of state?.devices ?? []) peers.set(peer.deviceId, peer);
  for (const peer of state?.trusted ?? []) if (!peers.has(peer.deviceId)) peers.set(peer.deviceId, {
    deviceId: peer.deviceId, deviceName: peer.deviceName, platform: 'android', trusted: true, status: 'offline' });
  for (const peer of state?.connections ?? []) if (peer.remoteDeviceId) peers.set(peer.remoteDeviceId, {
    ...peers.get(peer.remoteDeviceId), deviceId: peer.remoteDeviceId, deviceName: peer.remoteDeviceName,
    platform: peers.get(peer.remoteDeviceId)?.platform ?? 'android', trusted: state?.trusted.some((item) => item.deviceId === peer.remoteDeviceId) ?? false,
    status: peer.state === 'connected' ? 'online' : 'offline' });
  const selectConnection = (next: PeerConnection) => setSelectedId(next.remoteDeviceId);
  const conversation = state?.messages.filter((message) => message.senderId === selectedId || message.receiverId === selectedId) ?? [];

  useEffect(() => {
    if (!runtime || !selectedId) return;
    for (const message of state?.messages ?? []) if (message.senderId === selectedId && message.state === 'delivered') void runtime.messages.markRead(message.id).catch(runtime.fail);
  }, [runtime, selectedId, state?.messages]);

  return <SafeAreaProvider><SafeAreaView style={styles.screen}>
    <StatusBar barStyle="dark-content" />
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>IP Messenger</Text>
        <Text style={styles.muted}>{state?.ready ? 'Local network · Online' : 'Starting local network…'}</Text>
        {runtime && <Text style={styles.muted}>{runtime.profile.displayName} · {runtime.profile.platform}</Text>}
        {runtime && <TextInput accessibilityLabel="Device name" defaultValue={runtime.profile.displayName} maxLength={100}
          style={styles.input} onEndEditing={(event) => { void runtime.rename(event.nativeEvent.text).catch(runtime.fail); }} />}
        {!state?.ready && !startupError && <ActivityIndicator />}
        {(startupError || state?.error) ? <View style={styles.error} accessibilityRole="alert">
          <Text>{startupError || state?.error}</Text>
          {startupError ? <Button title="Retry startup" onPress={() => setGeneration((value) => value + 1)} /> : <Button title="Dismiss" onPress={() => runtime?.clearError()} />}
        </View> : null}

        {state?.incomingPair && <View style={styles.card}>
          <Text style={styles.heading}>Pairing request from {state.incomingPair.request.requesterName}</Text>
          <Text>Compare the fingerprint below with the other device, then enter its six-digit code.</Text>
          <Text selectable style={styles.muted}>Fingerprint: {state.incomingPair.request.fingerprint}</Text>
          <TextInput accessibilityLabel="Pairing code" placeholder="Six-digit code" keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} style={styles.input} />
          <View style={styles.row}>
            <Button title="Approve pairing" disabled={busy || code.length !== 6} onPress={() => run(async () => { await runtime!.approvePair(code); setSelectedId(state.incomingPair!.connection.remoteDeviceId); setCode(''); })} />
            <Button title="Reject pairing" disabled={busy} onPress={() => run(() => runtime!.rejectPair())} />
          </View>
        </View>}
        {!!state?.pairingCode && <View style={styles.card}>
          <Text style={styles.heading}>Pairing code: {state.pairingCode}</Text>
          <Text selectable style={styles.muted}>Fingerprint: {state.pairingFingerprint}</Text>
          <Text>Enter this code on the other device to approve pairing. Waiting for approval…</Text>
        </View>}

        <View style={styles.card}>
          <View style={styles.row}><Text style={styles.heading}>Nearby devices</Text><Button title="Refresh" disabled={!state?.ready} onPress={() => runtime?.discovery.refresh()} /></View>
          {peers.size === 0 && <Text style={styles.muted}>No peers found yet. Open IP Messenger on another device on the same network, or connect by IP below.</Text>}
          {[...peers.values()].map((peer) => <Pressable accessibilityRole="button" accessibilityLabel={`Select ${peer.deviceName}`} key={peer.deviceId} style={[styles.peer, selectedId === peer.deviceId && styles.selected]} onPress={() => setSelectedId(peer.deviceId)}>
            <Text style={styles.heading}>{peer.deviceName}</Text>
            <Text style={styles.muted}>{peer.status} · {state?.trusted.some((item) => item.deviceId === peer.deviceId) ? 'Paired' : 'Not paired'}{peer.ipAddress ? ` · ${peer.ipAddress}:${peer.port}` : ''}</Text>
            {peer.ipAddress && !state?.connections.some((item) => item.remoteDeviceId === peer.deviceId && item.state === 'connected') && <Button title={`Connect to ${peer.deviceName}`} disabled={busy} onPress={() => run(async () => selectConnection(await runtime!.connect(peer)))} />}
          </Pressable>)}
          <Text style={styles.label}>Connect by IP</Text>
          <TextInput accessibilityLabel="Peer address" placeholder="192.168.1.20:5050" autoCapitalize="none" autoCorrect={false} value={address} onChangeText={setAddress} style={styles.input} />
          <Button title="Connect" disabled={busy || !state?.ready || !address.trim()} onPress={() => run(async () => selectConnection(await runtime!.connectAddress(address)))} />
        </View>

        {!!selectedId && <View style={styles.card}>
          <Text style={styles.heading}>{peers.get(selectedId)?.deviceName ?? 'Conversation'}</Text>
          <Text style={styles.muted}>{connection ? 'Connected' : 'Disconnected'} · {trusted ? 'Paired' : 'Pair before sending messages or files'}</Text>
          {!trusted && <Button title="Pair device" disabled={busy || !connection} onPress={() => run(() => runtime!.pair(connection!))} />}
          {trusted && <Button title="Forget device" disabled={busy} onPress={() => run(() => runtime!.forget(selectedId))} />}
          {conversation.length === 0 && <Text style={styles.muted}>No messages yet.</Text>}
          {conversation.map((message) => <View key={message.id} style={[styles.message, message.senderId === runtime?.profile.deviceId && styles.outgoing]}>
            <Text selectable>{message.text}</Text><Text style={styles.caption}>{message.senderId === runtime?.profile.deviceId ? 'You' : peers.get(selectedId)?.deviceName} · {message.state}</Text>
          </View>)}
          <TextInput accessibilityLabel="Message" placeholder={trusted ? 'Write a message…' : 'Pair to start chatting'} editable={trusted} multiline value={draft} onChangeText={setDraft} style={styles.input} />
          <View style={styles.row}>
            <Button title={connection ? 'Send message' : 'Queue message'} disabled={busy || !trusted || !draft.trim()} onPress={() => run(async () => { await runtime!.messages.sendMessage(selectedId, draft); setDraft(''); })} />
            <Button title="Send file" disabled={busy || !trusted || !connection} onPress={() => run(() => runtime!.chooseFile(selectedId))} />
          </View>
          <Text style={styles.caption}>Files up to 10 MB. Keep both apps open during transfers.</Text>
        </View>}

        {!!state?.transfers.length && <View style={styles.card}>
          <Text style={styles.heading}>File transfers</Text>
          {state.transfers.map((transfer) => <View key={transfer.id} style={styles.peer}>
            <Text style={styles.heading}>{transfer.name}</Text>
            <Text>{Math.ceil(transfer.size / 1024)} KB · {transfer.state} · {transfer.totalChunks ? Math.round(100 * transfer.transferredChunks / transfer.totalChunks) : transfer.state === 'completed' ? 100 : 0}%</Text>
            {!!transfer.error && <Text style={styles.muted}>{transfer.error}</Text>}
            {transfer.receiverId === runtime?.profile.deviceId && transfer.state === 'offered' && <View style={styles.row}>
              <Button title={`Accept ${transfer.name}`} disabled={busy} onPress={() => run(() => runtime!.files.accept(transfer.id))} />
              <Button title={`Reject ${transfer.name}`} disabled={busy} onPress={() => run(() => runtime!.files.reject(transfer.id))} />
            </View>}
            {['offered', 'accepted', 'transferring'].includes(transfer.state) && <Button title={`Cancel ${transfer.name}`} onPress={() => { void runtime!.files.cancel(transfer.id).catch(runtime!.fail); }} />}
            {!!state.received[transfer.id] && <Button title={`Save or share ${transfer.name}`} onPress={() => run(() => runtime!.shareFile(transfer.id))} />}
          </View>)}
        </View>}
        {busy && <ActivityIndicator />}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f3f6fb' }, content: { padding: 20, gap: 12 },
  title: { fontSize: 30, fontWeight: '700', color: '#173b35' }, heading: { fontSize: 17, fontWeight: '600', color: '#173b35' },
  muted: { color: '#566475', fontSize: 13 }, caption: { color: '#566475', fontSize: 11, marginTop: 6 }, label: { fontWeight: '600', marginTop: 12 },
  card: { backgroundColor: 'white', padding: 16, borderRadius: 16, gap: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  input: { borderWidth: 1, borderColor: '#b9c5ce', borderRadius: 10, padding: 12, backgroundColor: '#fff', color: '#172d29' },
  button: { backgroundColor: '#1c6557', borderRadius: 9, paddingVertical: 11, paddingHorizontal: 14, alignSelf: 'flex-start' },
  buttonText: { color: 'white', fontWeight: '600' }, disabled: { opacity: 0.4 }, peer: { borderWidth: 1, borderColor: '#dde3e8', padding: 12, borderRadius: 10, gap: 8 },
  selected: { borderColor: '#1c6557', backgroundColor: '#eef7f2' }, message: { backgroundColor: '#eef1f5', borderRadius: 10, padding: 12 },
  outgoing: { backgroundColor: '#ddf2e8' }, error: { backgroundColor: '#ffe8e5', padding: 14, borderRadius: 10, gap: 8 },
});
