import 'dart:io';

class PeerServer {
  PeerServer({required this.port});

  final int port;
  ServerSocket? _server;

  Future<void> start({required void Function(String payload) onMessage}) async {
    _server = await ServerSocket.bind(InternetAddress.anyIPv4, port);
    _server!.listen((socket) {
      socket.listen((bytes) {
        final payload = String.fromCharCodes(bytes);
        onMessage(payload);
      });
    });
  }

  Future<void> stop() async {
    await _server?.close();
    _server = null;
  }
}
