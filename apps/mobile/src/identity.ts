import { Platform } from 'react-native';
import { DeviceProfileService, type DeviceProfile } from '@ip-messenger/shared';
import { secureStorage } from './security';

class MobileDeviceProfileService extends DeviceProfileService {
  override async load(): Promise<DeviceProfile> {
    const profile = await super.load();
    const platform = Platform.OS === 'ios' ? 'ios' : 'android';
    return profile.platform === platform
      ? profile
      : this.save({ ...profile, platform });
  }
}

export const deviceProfileService = new MobileDeviceProfileService(secureStorage);
