const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Standalone Gradle builds resolve the entry relative to this app. Keep the
// workspace packages visible even when EXPO_NO_METRO_WORKSPACE_ROOT is enabled.
config.watchFolders = [...new Set([...config.watchFolders, path.resolve(__dirname, '../..')])];

module.exports = config;
