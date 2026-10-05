const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('peerNetworking', {
  setNearbyCount: (count) => ipcRenderer.invoke('desktop:set-nearby-count', count),
  notify: (payload) => ipcRenderer.invoke('desktop:notify', payload),
  getStartup: () => ipcRenderer.invoke('desktop:get-startup'),
  setStartup: (enabled) => ipcRenderer.invoke('desktop:set-startup', enabled),
  show: (conversationId) => ipcRenderer.invoke('desktop:show', conversationId),
  onOpenConversation: (listener) => {
    const handler = (_event, conversationId) => listener(conversationId);
    ipcRenderer.on('desktop:open-conversation', handler);
    return () => ipcRenderer.removeListener('desktop:open-conversation', handler);
  },
  startServer: (identity) => ipcRenderer.invoke('peer-server:start', identity),
  stopServer: () => ipcRenderer.invoke('peer-server:stop'),
  onServerConnection: (listener) => {
    const handler = (_event, socketId, endpoint) => listener(socketId, endpoint);
    ipcRenderer.on('peer-server:connection', handler);
    return () => ipcRenderer.removeListener('peer-server:connection', handler);
  },
  connect: (socketId, host, port, timeoutMs) => ipcRenderer.invoke('peer-socket:connect', { socketId, host, port, timeoutMs }),
  write: (socketId, data) => ipcRenderer.invoke('peer-socket:write', { socketId, data }),
  close: (socketId) => ipcRenderer.invoke('peer-socket:close', { socketId }),
  onData: (socketId, listener) => {
    const handler = (_event, eventSocketId, data) => {
      if (eventSocketId === socketId) listener(data);
    };
    ipcRenderer.on('peer-socket:data', handler);
    return () => ipcRenderer.removeListener('peer-socket:data', handler);
  },
  onClose: (socketId, listener) => {
    const handler = (_event, eventSocketId) => {
      if (eventSocketId === socketId) listener();
    };
    ipcRenderer.on('peer-socket:close', handler);
    return () => ipcRenderer.removeListener('peer-socket:close', handler);
  },
  onError: (socketId, listener) => {
    const handler = (_event, eventSocketId, message) => {
      if (eventSocketId === socketId) listener(new Error(message));
    };
    ipcRenderer.on('peer-socket:error', handler);
    return () => ipcRenderer.removeListener('peer-socket:error', handler);
  },
});
