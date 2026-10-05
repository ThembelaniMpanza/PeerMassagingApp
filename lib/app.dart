import 'dart:io';

import 'package:flutter/material.dart';
import 'package:peer_messaging_app/discovery/device_discovery.dart';
import 'package:peer_messaging_app/messaging/message_model.dart';
import 'package:peer_messaging_app/messaging/message_service.dart';
import 'package:peer_messaging_app/screens/chat_page.dart';
import 'package:peer_messaging_app/screens/nearby_devices.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class PeerMessagingApp extends StatelessWidget {
  const PeerMessagingApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Peer Message',
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: Colors.teal,
      ),
      home: const HomePage(),
    );
  }
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
      databaseFactory = databaseFactoryFfi;
    }
    return const PeerMessagingApp();
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  bool _isLoading = true;
  List<DiscoveredDevice> _devices = [];
  DiscoveredDevice? _selectedDevice;
  final TextEditingController _textController = TextEditingController();
  final List<MessageModel> _messages = [];

  @override
  void initState() {
    super.initState();
    _refreshDevices();
  }

  Future<void> _refreshDevices() async {
    final devices = await DeviceDiscovery.discoverLocalDevices();
    if (!mounted) return;
    setState(() {
      _devices = devices;
      _selectedDevice ??= devices.isNotEmpty ? devices.first : null;
      _isLoading = false;
    });
    if (_selectedDevice != null) {
      final saved = await MessageService.loadForContact(_selectedDevice!.id);
      if (!mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(saved);
      });
    }
  }

  Future<void> _sendMessage() async {
    final text = _textController.text.trim();
    final currentDevice = _selectedDevice;
    if (text.isEmpty || currentDevice == null) {
      return;
    }

    final message = MessageModel(
      id: 'local_${DateTime.now().millisecondsSinceEpoch}',
      senderId: 'local-device',
      senderName: 'You',
      text: text,
      timestamp: DateTime.now().toUtc().toIso8601String(),
      type: MessageType.text,
    );

    await MessageService.save(message);
    if (!mounted) return;
    setState(() {
      _messages.add(message);
      _textController.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Peer Message'),
        actions: [
          IconButton(
            onPressed: _refreshDevices,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : Row(
              children: [
                SizedBox(
                  width: 340,
                  child: Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'People Nearby',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                        ),
                      ),
                      Expanded(
                        child: NearbyDevicesList(
                          devices: _devices,
                          selectedId: _selectedDevice?.id,
                          onSelect: (device) async {
                            setState(() {
                              _selectedDevice = device;
                            });
                            final saved = await MessageService.loadForContact(device.id);
                            if (!mounted) return;
                            setState(() {
                              _messages
                                ..clear()
                                ..addAll(saved);
                            });
                          },
                        ),
                      ),
                    ],
                  ),
                ),
                const VerticalDivider(width: 1),
                Expanded(
                  child: ChatPage(
                    device: _selectedDevice,
                    messages: _messages,
                    controller: _textController,
                    onSend: _sendMessage,
                  ),
                ),
              ],
            ),
    );
  }
}
