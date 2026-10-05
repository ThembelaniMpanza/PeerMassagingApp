using System.IO;

namespace IPMessenger.Native;

public sealed partial class PeerService
{
    public async Task OfferFileAsync(string peerId, string path)
    {
        _ = Key(peerId); var c = Connected(peerId);
        if (new FileInfo(path).Length > MaxFileSize) throw new IOException("Files must be 10 MB or smaller");
        var bytes = await File.ReadAllBytesAsync(path, lifetime.Token);
        if (bytes.Length > MaxFileSize) throw new IOException("Files must be 10 MB or smaller");
        var t = new FileTransfer { PeerId = peerId, Name = Path.GetFileName(path), Size = bytes.Length, TotalChunks = (bytes.Length + ChunkSize - 1) / ChunkSize, Sha256 = PeerCrypto.Sha256(bytes), Source = bytes, ConnectionId = c.Id };
        transfers[t.Id] = t; Notify();
        try { await Send(c, "FILE_OFFER", new { fileId = t.Id, name = t.Name, size = t.Size, mimeType = t.MimeType, senderId = DeviceId, totalChunks = t.TotalChunks, chunkSize = ChunkSize, sha256 = t.Sha256 }); }
        catch { Finish(t, "failed", "Could not send offer"); throw; }
    }

    public async Task AcceptFileAsync(string id)
    {
        var t = transfers[id];
        if (!t.Incoming || t.State != "offered") return;
        var c = Connected(t.PeerId); if (c.Id != t.ConnectionId) throw new IOException("Connection changed; request the file again");
        t.State = "accepted"; t.Updated = Now; Notify();
        await Send(c, "FILE_ACCEPT", new { fileId = id, receiverId = DeviceId, resumeFromChunk = 0 });
    }

    public Task RejectFileAsync(string id) => StopFile(id, "FILE_REJECT", "rejected");
    public Task CancelFileAsync(string id) => StopFile(id, "FILE_CANCEL", "cancelled");
    private async Task StopFile(string id, string type, string state)
    {
        var t = transfers[id]; if (!t.Active) return;
        Finish(t, state, ""); await Send(Connected(t.PeerId), type, new { fileId = id, reason = "Stopped by user" });
    }

    private void Finish(FileTransfer t, string state, string error)
    {
        t.State = state; t.Error = error; t.Source = null; t.Chunks.Clear(); Notify();
    }

    private async Task HandleFile(Connection c, Envelope message)
    {
        var key = Key(c.PeerId); var p = message.Payload; var id = S(p, "fileId");
        if (id.Length is 0 or > 160) throw new InvalidDataException("Invalid file ID");
        if (message.Type == "FILE_OFFER")
        {
            var size = N(p, "size"); var count = N(p, "totalChunks"); var hash = S(p, "sha256"); var name = S(p, "name");
            if (S(p, "senderId") != c.PeerId || size is < 0 or > MaxFileSize || N(p, "chunkSize") != ChunkSize || count != (size + ChunkSize - 1) / ChunkSize || hash.Length != 64 || !hash.All(Uri.IsHexDigit) || name.Length is 0 or > 255) throw new InvalidDataException("Invalid file offer");
            if (transfers.ContainsKey(id) || transfers.Values.Count(t => t.Active) >= 4) { await Send(c, "FILE_REJECT", new { fileId = id, reason = "Transfer limit or duplicate offer" }); return; }
            transfers[id] = new FileTransfer { Id = id, PeerId = c.PeerId, Incoming = true, Name = name, Size = size, TotalChunks = count, Sha256 = hash, MimeType = S(p, "mimeType"), ConnectionId = c.Id };
            Notify(); return;
        }
        if (!transfers.TryGetValue(id, out var t) || t.PeerId != c.PeerId || t.ConnectionId != c.Id) throw new InvalidDataException("Unknown file transfer");
        if (!t.Active) return;
        t.Updated = Now;
        switch (message.Type)
        {
            case "FILE_ACCEPT":
                if (t.Incoming || t.State != "offered" || S(p, "receiverId") != c.PeerId || N(p, "resumeFromChunk") != 0) throw new InvalidDataException("Invalid file acceptance");
                t.State = "transferring"; Notify(); _ = SendChunks(c, t); break;
            case "FILE_CHUNK":
                if (!t.Incoming || t.State is not ("accepted" or "transferring")) throw new InvalidDataException("File not accepted");
                var index = N(p, "chunkIndex");
                if (index != t.TransferredChunks || index >= t.TotalChunks || N(p, "totalChunks") != t.TotalChunks) throw new InvalidDataException("Invalid chunk order");
                var bytes = Convert.FromBase64String(PeerCrypto.Decrypt(key, p.GetProperty("encrypted")));
                if (bytes.Length != Math.Min(ChunkSize, t.Size - index * ChunkSize) || PeerCrypto.Sha256(bytes) != S(p, "sha256")) throw new InvalidDataException("File chunk checksum mismatch");
                t.Chunks[index] = bytes; t.TransferredChunks++; t.State = "transferring"; Notify(false); break;
            case "FILE_COMPLETE":
                if (S(p, "sha256") != t.Sha256 || t.TransferredChunks != t.TotalChunks || t.State is not ("accepted" or "transferring")) throw new InvalidDataException("Incomplete file");
                if (t.Incoming)
                {
                    var data = t.Chunks.Values.SelectMany(b => b).ToArray();
                    if (data.Length != t.Size || PeerCrypto.Sha256(data) != t.Sha256) throw new InvalidDataException("File checksum mismatch");
                    var folder = Path.Combine(directory, "Received"); Directory.CreateDirectory(folder);
                    var safeName = string.Concat(Path.GetFileName(t.Name).Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch));
                    if (safeName.Length == 0) safeName = "file";
                    t.SavedPath = Path.Combine(folder, Guid.NewGuid().ToString("N") + "-" + safeName);
                    await File.WriteAllBytesAsync(t.SavedPath, data, lifetime.Token);
                    Finish(t, "completed", "");
                    await Send(c, "FILE_COMPLETE", new { fileId = id, sha256 = t.Sha256 });
                }
                else Finish(t, "completed", "");
                break;
            case "FILE_REJECT": Finish(t, "rejected", S(p, "reason")); break;
            case "FILE_CANCEL": Finish(t, "cancelled", S(p, "reason")); break;
            case "FILE_ERROR": Finish(t, "failed", S(p, "reason")); break;
            default: throw new InvalidDataException("Unsupported file event");
        }
    }

    private async Task SendChunks(Connection c, FileTransfer t)
    {
        try
        {
            var source = t.Source ?? throw new IOException("File content unavailable"); var key = Key(t.PeerId);
            for (var index = 0; index < t.TotalChunks; index++)
            {
                if (!t.Active) return;
                var bytes = source.AsSpan(index * ChunkSize, Math.Min(ChunkSize, source.Length - index * ChunkSize)).ToArray();
                await Send(c, "FILE_CHUNK", new { fileId = t.Id, chunkIndex = index, chunk = "", totalChunks = t.TotalChunks, sha256 = PeerCrypto.Sha256(bytes), encrypted = PeerCrypto.Encrypt(key, Convert.ToBase64String(bytes)) });
                t.TransferredChunks = index + 1; t.Updated = Now; Notify(false);
            }
            if (t.Active) await Send(c, "FILE_COMPLETE", new { fileId = t.Id, sha256 = t.Sha256 });
        }
        catch (Exception error) { if (t.Active) Finish(t, "failed", error.Message); }
    }
}
