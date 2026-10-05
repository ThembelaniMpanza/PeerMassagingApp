import 'package:flutter/material.dart';
import 'package:peer_messaging_app/discovery/device_discovery.dart';

class NearbyDevicesList extends StatelessWidget {
  const NearbyDevicesList({
    required this.devices,
    required this.selectedId,
    required this.onSelect,
    super.key,
  });

  final List<DiscoveredDevice> devices;
  final String? selectedId;
  final ValueChanged<DiscoveredDevice> onSelect;

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      itemCount: devices.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final device = devices[index];
        final selected = device.id == selectedId;

        return ListTile(
          leading: CircleAvatar(
            backgroundColor: selected ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.surfaceContainerHighest,
            child: Text(
              device.name.substring(0, 1).toUpperCase(),
              style: TextStyle(
                color: selected ? Theme.of(context).colorScheme.onPrimary : Theme.of(context).colorScheme.onSurface,
              ),
            ),
          ),
          title: Text(device.name),
          subtitle: Text('${device.platform} • ${device.ipAddress}'),
          trailing: device.isTrusted
              ? const Icon(Icons.verified_user_rounded, size: 18)
              : const Icon(Icons.person_add_alt_1_rounded, size: 18),
          selected: selected,
          onTap: () => onSelect(device),
        );
      },
    );
  }
}
