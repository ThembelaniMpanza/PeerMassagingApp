using System.Text.Json;
using System.Text.Json.Serialization;

namespace IPMessenger.Native;

public sealed class PeerDevice
{
    public string DeviceId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Platform { get; set; } = "";
    public string Address { get; set; } = "";
    public int Port { get; set; } = 5050;
    public bool Connected { get; set; }
    public bool Trusted { get; set; }
    public long LastSeen { get; set; }
    [JsonIgnore] public string Detail => $"{(Connected ? "Connected" : LastSeen > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 16000 ? "Nearby" : "Offline")} · {(Trusted ? "Paired" : "Not paired")} · {Address}:{Port}";
}

public sealed class ChatMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string SenderId { get; set; } = "";
    public string ReceiverId { get; set; } = "";
    public string Sender { get; set; } = "";
    public string Text { get; set; } = "";
    public string State { get; set; } = "queued";
    public long Timestamp { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

public sealed class FileTransfer
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string PeerId { get; set; } = "";
    public string Name { get; set; } = "";
    public string MimeType { get; set; } = "application/octet-stream";
    public int Size { get; set; }
    public int TotalChunks { get; set; }
    public int TransferredChunks { get; set; }
    public string Sha256 { get; set; } = "";
    public string State { get; set; } = "offered";
    public string Error { get; set; } = "";
    public string SavedPath { get; set; } = "";
    public bool Incoming { get; set; }
    [JsonIgnore] public string Detail => $"{(Incoming ? "Receiving" : "Sending")} · {State} · {Size / 1024.0:0.#} KB · {(TotalChunks == 0 ? State == "completed" ? 100 : 0 : TransferredChunks * 100 / TotalChunks)}% {Error}";
    [JsonIgnore] internal byte[]? Source { get; set; }
    [JsonIgnore] internal SortedDictionary<int, byte[]> Chunks { get; } = new();
    [JsonIgnore] internal long Updated { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    [JsonIgnore] internal string ConnectionId { get; set; } = "";
    [JsonIgnore] public bool Active => State is "offered" or "accepted" or "transferring";
    [JsonIgnore] public bool CanAccept => Incoming && State == "offered";
    [JsonIgnore] public bool CanShow => Incoming && State == "completed" && SavedPath.Length > 0;
}

public sealed record PairRequest(string PeerId, string Name, string Code, string PublicKey, string Fingerprint, long ReceivedAt);
public sealed record TrustedPeer(string DeviceId, string Name, string Fingerprint, string ProtectedKey);
public sealed record OutgoingPair(string PeerId, string Code, string Fingerprint);
public sealed record Envelope(string Type, JsonElement Payload, long Timestamp, string SenderId);

public sealed class DesktopState
{
    public string DeviceId { get; set; } = Guid.NewGuid().ToString("N");
    public string DeviceName { get; set; } = Environment.MachineName;
    public List<TrustedPeer> Trusted { get; set; } = new();
    public List<PeerDevice> Peers { get; set; } = new();
    public List<ChatMessage> Messages { get; set; } = new();
    public List<FileTransfer> Transfers { get; set; } = new();
}
