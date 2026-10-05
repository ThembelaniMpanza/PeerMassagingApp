using IPMessenger.Native;
using System.Text.Json;

// Explicit test harness only. The desktop UI always requires user approval.
await using var peer = new PeerService(args[0]);
peer.Error += error => Console.WriteLine(JsonSerializer.Serialize(new { error }));
peer.PairingRequested += request => _ = peer.ApprovePairingAsync(request.PeerId, request.Code);
peer.MessageReceived += message => _ = peer.SendMessageAsync(message.SenderId, "Echo: " + message.Text);
await peer.StartAsync(0, false);
Console.WriteLine(JsonSerializer.Serialize(new { ready = true, id = peer.DeviceId, port = peer.Port }));
while (Console.ReadLine() is { } line)
{
    try
    {
        using var doc = JsonDocument.Parse(line); var command = doc.RootElement;
        switch (command.GetProperty("command").GetString())
        {
            case "snapshot": Console.WriteLine(JsonSerializer.Serialize(new { peers = peer.Peers, messages = peer.Messages, transfers = peer.Transfers }, new JsonSerializerOptions(JsonSerializerDefaults.Web))); break;
            case "accept": await peer.AcceptFileAsync(command.GetProperty("id").GetString()!); break;
            case "reject": await peer.RejectFileAsync(command.GetProperty("id").GetString()!); break;
            case "offer": await peer.OfferFileAsync(command.GetProperty("peer").GetString()!, command.GetProperty("path").GetString()!); break;
            case "stop": return;
        }
    }
    catch (Exception error) { Console.WriteLine(JsonSerializer.Serialize(new { error = error.Message })); }
}
