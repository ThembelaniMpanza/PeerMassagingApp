using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace IPMessenger.Native;

/// <summary>The native implementation of packages/protocol's newline-framed LAN protocol.</summary>
public sealed partial class PeerService : IAsyncDisposable
{
    public const int ChunkSize = 48 * 1024;
    public const int MaxFileSize = 10 * 1024 * 1024;
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = false };
    private readonly string statePath;
    private readonly string directory;
    private readonly object saveLock = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly ConcurrentDictionary<string, Connection> connections = new();
    private readonly ConcurrentDictionary<string, Connection> allConnections = new();
    private readonly ConcurrentDictionary<string, byte[]> keys = new();
    private readonly ConcurrentDictionary<string, TrustedPeer> trusted = new();
    private readonly ConcurrentDictionary<string, PendingPair> outgoingPairs = new();
    private readonly ConcurrentDictionary<string, PairRequest> incomingPairs = new();
    private readonly ConcurrentDictionary<string, PeerDevice> peers = new();
    private readonly ConcurrentDictionary<string, ChatMessage> messages = new();
    private readonly ConcurrentDictionary<string, FileTransfer> transfers = new();
    private readonly SemaphoreSlim connectGate = new(1, 1);
    private readonly SemaphoreSlim flushGate = new(1, 1);
    private TcpListener? listener;
    private UdpClient? discovery;
    private Task? maintenance;
    public string DeviceId { get; }
    public string DeviceName { get; }
    public int Port { get; private set; }
    public bool Started { get; private set; }
    public event Action? Changed;
    public event Action<string>? Error;
    public event Action<PairRequest>? PairingRequested;
    public event Action<OutgoingPair?>? PairingCodeChanged;
    public event Action<ChatMessage>? MessageReceived;
    public IReadOnlyList<PeerDevice> Peers => peers.Values.OrderBy(p => p.Name).ToArray();
    public IReadOnlyList<ChatMessage> Messages => messages.Values.OrderBy(m => m.Timestamp).ToArray();
    public IReadOnlyList<FileTransfer> Transfers => transfers.Values.OrderBy(t => t.Id).ToArray();
    public IReadOnlyList<PairRequest> PairRequests => incomingPairs.Values.ToArray();

    public PeerService(string? dataDirectory = null)
    {
        directory = dataDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "IPMessenger");
        Directory.CreateDirectory(directory);
        statePath = Path.Combine(directory, "state.json");
        var state = File.Exists(statePath) ? JsonSerializer.Deserialize<DesktopState>(File.ReadAllText(statePath), Json) ?? throw new InvalidDataException("Invalid saved desktop state") : new DesktopState();
        DeviceId = state.DeviceId; DeviceName = state.DeviceName;
        foreach (var peer in state.Peers) { peer.Connected = false; peer.LastSeen = 0; peers[peer.DeviceId] = peer; }
        foreach (var peer in state.Trusted)
        {
            try { keys[peer.DeviceId] = PeerCrypto.Unprotect(peer.ProtectedKey); trusted[peer.DeviceId] = peer; }
            catch (CryptographicException) { /* A profile copied from another Windows account needs pairing again. */ }
        }
        foreach (var peer in peers.Values) peer.Trusted = keys.ContainsKey(peer.DeviceId);
        foreach (var message in state.Messages) { if (message.State is "sending" or "sent") message.State = "queued"; messages[message.Id] = message; }
        foreach (var transfer in state.Transfers) { if (transfer.Active) { transfer.State = "failed"; transfer.Error = "Interrupted; send the file again"; } transfers[transfer.Id] = transfer; }
        Save();
    }

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static string S(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw new InvalidDataException($"Missing {key}");
    private static int N(JsonElement value, string key) => value.GetProperty(key).GetInt32();
    private void Notify(bool persist = true) { if (persist) Save(); Changed?.Invoke(); }
    private void Report(Exception error) { if (!lifetime.IsCancellationRequested) Error?.Invoke(error.Message); }
    private void Save()
    {
        lock (saveLock)
        {
            var state = new DesktopState { DeviceId = DeviceId, DeviceName = DeviceName, Peers = peers.Values.ToList(), Trusted = trusted.Values.ToList(), Messages = messages.Values.ToList(), Transfers = transfers.Values.ToList() };
            File.WriteAllText(statePath + ".tmp", JsonSerializer.Serialize(state, Json));
            File.Move(statePath + ".tmp", statePath, true);
        }
    }

    public Task StartAsync(int port = 5050, bool enableDiscovery = true)
    {
        if (Started) return Task.CompletedTask;
        listener = new TcpListener(IPAddress.Any, port);
        listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port; Started = true;
        _ = AcceptLoop();
        if (enableDiscovery)
        {
            try
            {
                discovery = new UdpClient(AddressFamily.InterNetwork) { EnableBroadcast = true };
                discovery.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                discovery.Client.Bind(new IPEndPoint(IPAddress.Any, 5051));
                _ = DiscoveryLoop();
            }
            catch (SocketException error) { discovery?.Dispose(); discovery = null; Error?.Invoke($"Discovery unavailable: {error.Message}. Connect by IP instead."); }
        }
        maintenance = Maintain(); Notify(false); return Task.CompletedTask;
    }

    public async Task RefreshAsync()
    {
        if (discovery is null) return;
        var data = JsonSerializer.SerializeToUtf8Bytes(new { service = "ip-messenger", version = 1, deviceId = DeviceId, deviceName = DeviceName, platform = "windows", port = Port }, Json);
        await discovery.SendAsync(data, new IPEndPoint(IPAddress.Broadcast, 5051), lifetime.Token);
    }

    private async Task DiscoveryLoop()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var packet = await discovery!.ReceiveAsync(lifetime.Token);
                if (packet.Buffer.Length > 2048) continue;
                try
                {
                    using var doc = JsonDocument.Parse(packet.Buffer); var p = doc.RootElement;
                    if (S(p, "service") != "ip-messenger" || N(p, "version") != 1 || S(p, "deviceId") == DeviceId) continue;
                    var id = S(p, "deviceId"); var name = S(p, "deviceName"); var port = N(p, "port"); var platform = S(p, "platform");
                    if (id.Length is 0 or > 160 || name.Length is 0 or > 100 || port is < 1 or > 65535 || platform is not ("android" or "ios" or "windows" or "macos") || peers.Count >= 100 && !peers.ContainsKey(id)) continue;
                    var peer = peers.GetOrAdd(id, _ => new PeerDevice { DeviceId = id });
                    peer.Name = name; peer.Platform = platform; peer.Address = packet.RemoteEndPoint.Address.ToString(); peer.Port = port; peer.LastSeen = Now; peer.Trusted = keys.ContainsKey(id);
                    Notify(false);
                }
                catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or InvalidDataException) { }
            }
        }
        catch (Exception error) when (error is SocketException or OperationCanceledException or ObjectDisposedException) { if (!lifetime.IsCancellationRequested) Report(error); }
    }

    private async Task AcceptLoop()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var client = await listener!.AcceptTcpClientAsync(lifetime.Token);
                if (allConnections.Count >= 32) { client.Dispose(); continue; }
                StartConnection(client, "", ((IPEndPoint)client.Client.RemoteEndPoint!).Address.ToString(), 5050);
            }
        }
        catch (Exception error) when (error is SocketException or OperationCanceledException or ObjectDisposedException) { if (!lifetime.IsCancellationRequested) Report(error); }
    }

    public async Task<PeerDevice> ConnectAsync(string address, int port = 5050, string expectedId = "")
    {
        if (!IPAddress.TryParse(address, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork || port is < 1 or > 65535) throw new ArgumentException("Enter an IPv4 address and valid port");
        await connectGate.WaitAsync(lifetime.Token);
        try
        {
            var existing = connections.Values.FirstOrDefault(c => c.Ready.Task.IsCompletedSuccessfully && (expectedId.Length > 0 ? c.PeerId == expectedId : c.Address == address && c.Port == port));
            if (existing is not null) return peers[existing.PeerId];
            var client = new TcpClient();
            try { await client.ConnectAsync(ip, port, lifetime.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(5), lifetime.Token); }
            catch { client.Dispose(); throw; }
            var connection = StartConnection(client, expectedId, address, port);
            try { await connection.Ready.Task.WaitAsync(TimeSpan.FromSeconds(6), lifetime.Token); }
            catch { connection.Client.Dispose(); throw; }
            return peers[connection.PeerId];
        }
        finally { connectGate.Release(); }
    }

    private Connection StartConnection(TcpClient client, string expectedId, string address, int port)
    {
        client.NoDelay = true; client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
        var connection = new Connection(client, expectedId, address, port);
        allConnections[connection.Id] = connection;
        _ = ReadConnection(connection); return connection;
    }

    private async Task ReadConnection(Connection connection)
    {
        try
        {
            await Send(connection, "HELLO", new { deviceId = DeviceId, deviceName = DeviceName, platform = "windows", port = Port });
            var stream = connection.Client.GetStream(); var bytes = new byte[8192]; using var frame = new MemoryStream();
            while (!lifetime.IsCancellationRequested)
            {
                using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                if (!connection.Ready.Task.IsCompleted) readTimeout.CancelAfter(TimeSpan.FromSeconds(6));
                var count = await stream.ReadAsync(bytes, readTimeout.Token); if (count == 0) break;
                for (var index = 0; index < count; index++)
                {
                    if (bytes[index] == 10)
                    {
                        if (frame.Length == 0) continue;
                        var envelope = JsonSerializer.Deserialize<Envelope>(frame.ToArray(), Json) ?? throw new InvalidDataException("Invalid protocol frame");
                        frame.SetLength(0);
                        if (string.IsNullOrEmpty(envelope.SenderId) || envelope.Timestamp <= 0 || envelope.Payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Invalid protocol frame");
                        if (connection.PeerId.Length > 0 && connection.PeerId != envelope.SenderId) throw new InvalidDataException("Peer identity changed");
                        await Handle(connection, envelope);
                    }
                    else { if (frame.Length >= 2 * 1024 * 1024) throw new InvalidDataException("Protocol frame too large"); frame.WriteByte(bytes[index]); }
                }
            }
        }
        catch (Exception error) { connection.Ready.TrySetException(error); Report(error); }
        finally
        {
            connection.Ready.TrySetException(new IOException("Peer disconnected"));
            connection.Client.Dispose(); allConnections.TryRemove(connection.Id, out _);
            if (connections.TryGetValue(connection.PeerId, out var current) && ReferenceEquals(current, connection))
            {
                connections.TryRemove(connection.PeerId, out _);
                if (peers.TryGetValue(connection.PeerId, out var peer)) peer.Connected = false;
                incomingPairs.TryRemove(connection.PeerId, out _);
                foreach (var message in messages.Values.Where(m => m.ReceiverId == connection.PeerId && m.State is "sent" or "sending")) message.State = "queued";
                foreach (var transfer in transfers.Values.Where(t => t.ConnectionId == connection.Id && t.Active)) Finish(transfer, "failed", "Connection lost; send the file again");
                Notify();
            }
        }
    }

    private async Task Handle(Connection c, Envelope message)
    {
        var p = message.Payload;
        if (message.Type is "HELLO" or "DEVICE_INFO")
        {
            var id = S(p, "deviceId"); var name = S(p, "deviceName");
            if (id.Length is 0 or > 160 || name.Length is 0 or > 100 || id == DeviceId || id != message.SenderId || c.ExpectedId.Length > 0 && c.ExpectedId != id) throw new InvalidDataException("Unexpected peer identity");
            c.PeerId = id;
            var peer = peers.GetOrAdd(id, _ => new PeerDevice { DeviceId = id });
            peer.Name = name; peer.Platform = S(p, "platform"); peer.Address = c.Address; peer.Port = c.Port; peer.LastSeen = Now; peer.Trusted = keys.ContainsKey(id);
            if (message.Type == "HELLO") await Send(c, "DEVICE_INFO", new { deviceId = DeviceId, deviceName = DeviceName, platform = "windows", appVersion = "1.1.0" });
            else
            {
                if (connections.TryGetValue(id, out var old) && !ReferenceEquals(old, c)) old.Client.Dispose();
                connections[id] = c; peer.Connected = true; c.Ready.TrySetResult(); Notify(); _ = FlushQueue();
            }
            return;
        }
        if (!c.Ready.Task.IsCompletedSuccessfully) throw new InvalidDataException("Complete the HELLO handshake first");
        switch (message.Type)
        {
            case "PING": await Send(c, "PONG", new { nonce = S(p, "nonce") }); break;
            case "PONG": case "TYPING_START": case "TYPING_STOP": break;
            case "PAIR_REQUEST":
                var request = new PairRequest(c.PeerId, S(p, "requesterName"), S(p, "pairingCode"), S(p, "publicKey"), S(p, "fingerprint"), Now);
                if (S(p, "requesterId") != c.PeerId || request.Code.Length != 6 || !request.Code.All(char.IsAsciiDigit) || request.Fingerprint != PeerCrypto.Fingerprint(request.PublicKey)) throw new InvalidDataException("Invalid pairing request");
                if (!incomingPairs.IsEmpty || !outgoingPairs.IsEmpty) { await Send(c, "PAIR_REJECT", new { reason = "Another pairing is in progress" }); break; }
                incomingPairs[c.PeerId] = request; PairingRequested?.Invoke(request); Notify(false); break;
            case "PAIR_ACCEPT":
                if (!outgoingPairs.TryRemove(c.PeerId, out var pending)) break;
                using (pending.Key)
                {
                    try
                    {
                        var publicKey = S(p, "publicKey"); var fingerprint = S(p, "fingerprint");
                        if (S(p, "pairingCode") != pending.Code || S(p, "responderId") != c.PeerId || fingerprint != PeerCrypto.Fingerprint(publicKey)) throw new InvalidDataException("Pairing verification failed");
                        Trust(c.PeerId, S(p, "responderName"), fingerprint, PeerCrypto.Derive(pending.Key, publicKey));
                    }
                    finally { PairingCodeChanged?.Invoke(null); }
                }
                _ = FlushQueue(); break;
            case "PAIR_REJECT":
                if (outgoingPairs.TryRemove(c.PeerId, out var rejected)) { rejected.Key.Dispose(); PairingCodeChanged?.Invoke(null); Error?.Invoke(S(p, "reason")); }
                break;
            case "MESSAGE":
                if (S(p, "senderId") != c.PeerId || S(p, "receiverId") != DeviceId) throw new InvalidDataException("Invalid message identity");
                var text = PeerCrypto.Decrypt(Key(c.PeerId), p.GetProperty("encrypted"));
                var id = S(p, "messageId");
                if (text.Length > 100000 || id.Length > 160) throw new InvalidDataException("Message too large");
                var received = new ChatMessage { Id = id, SenderId = c.PeerId, ReceiverId = DeviceId, Sender = peers[c.PeerId].Name, Text = text, State = "delivered", Timestamp = p.GetProperty("timestamp").GetInt64() };
                if (messages.TryAdd(id, received)) { Notify(); MessageReceived?.Invoke(received); }
                await Send(c, "MESSAGE_ACK", new { messageId = id, receiverId = DeviceId, deliveredAt = Now }); break;
            case "MESSAGE_ACK": case "MESSAGE_READ":
                if (messages.TryGetValue(S(p, "messageId"), out var sent) && sent.SenderId == DeviceId && sent.ReceiverId == c.PeerId && S(p, message.Type == "MESSAGE_ACK" ? "receiverId" : "readerId") == c.PeerId)
                { if (sent.State != "read") sent.State = message.Type == "MESSAGE_READ" ? "read" : "delivered"; Notify(); }
                break;
            case "FILE_OFFER": case "FILE_ACCEPT": case "FILE_REJECT": case "FILE_CHUNK": case "FILE_COMPLETE": case "FILE_CANCEL": case "FILE_ERROR":
                await HandleFile(c, message); break;
            case "DISCONNECT": c.Client.Dispose(); break;
            default: throw new InvalidDataException("Unknown protocol event");
        }
    }

    private byte[] Key(string id) => keys.TryGetValue(id, out var key) ? key : throw new InvalidOperationException("Pair with this device first");
    private Connection Connected(string id) => connections.TryGetValue(id, out var c) && c.Ready.Task.IsCompletedSuccessfully ? c : throw new IOException("Peer is not connected");
    private async Task Send(Connection c, string type, object payload)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { type, payload, timestamp = Now, senderId = DeviceId }, Json);
        await c.WriteLock.WaitAsync(lifetime.Token);
        try { await c.Client.GetStream().WriteAsync(bytes, lifetime.Token); await c.Client.GetStream().WriteAsync(new byte[] { 10 }, lifetime.Token); }
        finally { c.WriteLock.Release(); }
    }

    private void Trust(string id, string name, string fingerprint, byte[] key)
    {
        trusted[id] = new TrustedPeer(id, name, fingerprint, PeerCrypto.Protect(key)); keys[id] = key; peers[id].Trusted = true; Notify();
    }

    public async Task RequestPairingAsync(string id)
    {
        var c = Connected(id);
        if (!outgoingPairs.IsEmpty || !incomingPairs.IsEmpty) throw new InvalidOperationException("Finish the current pairing first");
        var key = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256); var publicKey = PeerCrypto.PublicKey(key);
        var code = RandomNumberGenerator.GetInt32(1000000).ToString("D6"); var fingerprint = PeerCrypto.Fingerprint(publicKey);
        outgoingPairs[id] = new PendingPair(key, code, Now);
        PairingCodeChanged?.Invoke(new OutgoingPair(id, code, fingerprint));
        try { await Send(c, "PAIR_REQUEST", new { pairingCode = code, requesterId = DeviceId, requesterName = DeviceName, publicKey, fingerprint }); }
        catch { outgoingPairs.TryRemove(id, out _); key.Dispose(); PairingCodeChanged?.Invoke(null); throw; }
    }

    public async Task ApprovePairingAsync(string id, string code)
    {
        if (!incomingPairs.TryGetValue(id, out var request) || Now - request.ReceivedAt > 30000) throw new InvalidOperationException("Pairing request expired");
        if (code != request.Code) throw new InvalidOperationException("The code does not match the other device");
        using var key = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var publicKey = PeerCrypto.PublicKey(key); var session = PeerCrypto.Derive(key, request.PublicKey);
        keys[id] = session;
        try { await Send(Connected(id), "PAIR_ACCEPT", new { pairingCode = code, responderId = DeviceId, responderName = DeviceName, publicKey, fingerprint = PeerCrypto.Fingerprint(publicKey) }); }
        catch { keys.TryRemove(id, out _); throw; }
        incomingPairs.TryRemove(id, out _); Trust(id, request.Name, request.Fingerprint, session); await FlushQueue();
    }

    public async Task RejectPairingAsync(string id)
    {
        incomingPairs.TryRemove(id, out _); Notify(false);
        await Send(Connected(id), "PAIR_REJECT", new { reason = "Declined by user" });
    }

    public void Forget(string id)
    {
        keys.TryRemove(id, out _); trusted.TryRemove(id, out _);
        if (peers.TryGetValue(id, out var peer)) peer.Trusted = false;
        if (connections.TryGetValue(id, out var c)) c.Client.Dispose(); Notify();
    }

    public async Task SendMessageAsync(string id, string text)
    {
        _ = Key(id); text = text.Trim(); if (text.Length is 0 or > 100000) throw new ArgumentException("Enter a message of 1–100,000 characters");
        var message = new ChatMessage { SenderId = DeviceId, Sender = "You", ReceiverId = id, Text = text };
        messages[message.Id] = message; Notify(); await FlushQueue();
    }

    private async Task FlushQueue()
    {
        if (!await flushGate.WaitAsync(0)) return;
        try
        {
            foreach (var message in Messages.Where(m => m.SenderId == DeviceId && m.State == "queued"))
            {
                if (!connections.TryGetValue(message.ReceiverId, out var c) || !keys.TryGetValue(message.ReceiverId, out var key)) continue;
                message.State = "sending"; Notify();
                try
                {
                    await Send(c, "MESSAGE", new { messageId = message.Id, senderId = DeviceId, receiverId = message.ReceiverId, text = "", timestamp = message.Timestamp, encrypted = PeerCrypto.Encrypt(key, message.Text) });
                    if (message.State == "sending") message.State = "sent";
                }
                catch { message.State = "queued"; c.Client.Dispose(); }
                Notify();
            }
        }
        catch (Exception error) { Report(error); }
        finally { flushGate.Release(); }
    }

    public async Task MarkReadAsync(string peerId)
    {
        var changed = false;
        foreach (var message in Messages.Where(m => m.SenderId == peerId && m.ReceiverId == DeviceId && m.State == "delivered"))
        {
            if (!connections.TryGetValue(peerId, out var c)) return;
            message.State = "read";
            try { await Send(c, "MESSAGE_READ", new { messageId = message.Id, readerId = DeviceId, readAt = Now }); changed = true; }
            catch { message.State = "delivered"; throw; }
        }
        if (changed) Notify();
    }

    private async Task Maintain()
    {
        while (!lifetime.IsCancellationRequested)
        {
            try
            {
                await RefreshAsync();
                foreach (var pending in outgoingPairs.Where(p => Now - p.Value.CreatedAt > 30000).ToArray())
                    if (outgoingPairs.TryRemove(pending.Key, out var removed)) { removed.Key.Dispose(); PairingCodeChanged?.Invoke(null); Error?.Invoke("Pairing timed out"); }
                foreach (var request in incomingPairs.Values.Where(p => Now - p.ReceivedAt > 30000)) incomingPairs.TryRemove(request.PeerId, out _);
                foreach (var transfer in transfers.Values.Where(t => t.Active && Now - t.Updated > 60000)) Finish(transfer, "failed", "Transfer timed out; send it again");
                foreach (var peer in peers.Values.Where(p => p.Trusted && !p.Connected && p.LastSeen > Now - 16000))
                    try { await ConnectAsync(peer.Address, peer.Port, peer.DeviceId); } catch { }
                await FlushQueue(); Notify(false);
                await Task.Delay(5000, lifetime.Token);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception error) { Report(error); await Task.Delay(5000); }
        }
    }

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel(); listener?.Stop(); discovery?.Dispose();
        foreach (var c in allConnections.Values) c.Client.Dispose();
        foreach (var pending in outgoingPairs.Values) pending.Key.Dispose(); outgoingPairs.Clear();
        if (maintenance is not null) try { await maintenance; } catch (OperationCanceledException) { }
        Save(); Started = false;
    }

    private sealed record PendingPair(ECDiffieHellman Key, string Code, long CreatedAt);
    private sealed class Connection(TcpClient client, string expectedId, string address, int port)
    {
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public TcpClient Client { get; } = client;
        public string ExpectedId { get; } = expectedId;
        public string PeerId { get; set; } = "";
        public string Address { get; } = address;
        public int Port { get; } = port;
        public SemaphoreSlim WriteLock { get; } = new(1, 1);
        public TaskCompletionSource Ready { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
