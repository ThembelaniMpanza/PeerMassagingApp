import {
  DEVICE_PROFILE_KEY,
  type DeviceProfile,
  type StorageAdapter,
  createDefaultDeviceProfile,
} from './index';

export class DeviceProfileService {
  constructor(private readonly storage: StorageAdapter) {}

  async load(): Promise<DeviceProfile> {
    const raw = await this.storage.getItem(DEVICE_PROFILE_KEY);

    if (!raw) {
      const profile = createDefaultDeviceProfile();
      await this.storage.setItem(DEVICE_PROFILE_KEY, JSON.stringify(profile));
      return profile;
    }

    try {
      const parsed = JSON.parse(raw) as DeviceProfile;
      return {
        ...createDefaultDeviceProfile(),
        ...parsed,
      };
    } catch {
      const profile = createDefaultDeviceProfile();
      await this.storage.setItem(DEVICE_PROFILE_KEY, JSON.stringify(profile));
      return profile;
    }
  }

  async save(profile: DeviceProfile): Promise<DeviceProfile> {
    await this.storage.setItem(DEVICE_PROFILE_KEY, JSON.stringify(profile));
    return profile;
  }

  async updateDisplayName(name: string): Promise<DeviceProfile> {
    const current = await this.load();
    const updated = { ...current, displayName: name.trim() || current.displayName };
    return this.save(updated);
  }
}
