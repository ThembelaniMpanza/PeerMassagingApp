class DiscoveredDevice {
  const DiscoveredDevice({
    required this.id,
    required this.name,
    required this.ipAddress,
    required this.platform,
    this.isTrusted = false,
  });

  final String id;
  final String name;
  final String ipAddress;
  final String platform;
  final bool isTrusted;
}

class DeviceDiscovery {
  static Future<List<DiscoveredDevice>> discoverLocalDevices() async {
    await Future<void>.delayed(const Duration(milliseconds: 350));

    return const [
      DiscoveredDevice(
        id: 'device_prince_pc',
        name: 'Prince-PC',
        ipAddress: '192.168.1.10',
        platform: 'Windows',
        isTrusted: true,
      ),
      DiscoveredDevice(
        id: 'device_s26',
        name: 'Samsung S26',
        ipAddress: '192.168.1.18',
        platform: 'Android',
      ),
      DiscoveredDevice(
        id: 'device_imac',
        name: 'MacBook-Pro',
        ipAddress: '192.168.1.21',
        platform: 'macOS',
      ),
      DiscoveredDevice(
        id: 'device_thando_iphone',
        name: 'Thando-iPhone',
        ipAddress: '192.168.1.30',
        platform: 'iOS',
      ),
    ];
  }

  static Future<void> startAdvertising() async {
    await Future<void>.delayed(const Duration(milliseconds: 200));
  }
}
