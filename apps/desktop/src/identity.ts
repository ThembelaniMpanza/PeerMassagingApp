import { BrowserStorageAdapter, DeviceProfileService } from '@ip-messenger/shared';

export const deviceProfileService = new DeviceProfileService(new BrowserStorageAdapter());
