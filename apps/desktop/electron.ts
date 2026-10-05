const { app, BrowserWindow, BrowserWindow: ElectronBrowserWindow, Menu, Notification: ElectronNotification, Tray, ipcMain, nativeImage } = require('electron');
const { Socket: NodeSocket, createServer } = require('node:net');
const path = require('node:path');

type Socket = import('node:net').Socket;
type RendererSender = { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void };
type IpcEvent = { sender: RendererSender };
type DesktopIdentity = { deviceId: string; deviceName: string; platform: string; appVersion: string; port: number };

interface ConnectPayload { socketId: string; host: string; port: number; timeoutMs: number }
interface WritePayload { socketId: string; data: string }
interface ClosePayload { socketId: string }
interface NotificationPayload { title: string; body: string; conversationId?: string }

let mainWindow: InstanceType<typeof ElectronBrowserWindow> | undefined;
let tray: InstanceType<typeof Tray> | undefined;
let peerServer: ReturnType<typeof createServer> | undefined;
let peerServerIdentity: DesktopIdentity | undefined;
let isQuitting = false;
let nearbyDeviceCount = 0;
let startWithWindows = false;
let muteNotifications = false;
const sockets = new Map<string, { socket: Socket; sender: RendererSender }>();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event: unknown, commandLine: string[]) => {
    const conversationId = commandLine.find((argument) => argument.startsWith('--conversation='))?.split('=')[1];
    showMainWindow(conversationId);
  });

  app.whenReady().then(() => {
    startWithWindows = app.getLoginItemSettings().openAtLogin;
    createWindow();
    createTray();
    if (app.getLoginItemSettings().wasOpenedAtLogin || app.getLoginItemSettings().wasOpenedAsHidden) {
      mainWindow?.hide();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    for (const entry of sockets.values()) entry.socket.destroy();
    peerServer?.close();
  });

  app.on('activate', () => showMainWindow());
  app.on('window-all-closed', () => { /* Tray mode intentionally keeps the process alive. */ });
}

function showMainWindow(conversationId?: string): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (conversationId) mainWindow.webContents.send('desktop:open-conversation', conversationId);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    show: !app.getLoginItemSettings().wasOpenedAtLogin,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  });

  mainWindow.on('close', (event: { preventDefault(): void }) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  if (process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="%23173b35"/><path d="M8 10h16v12H8z" fill="%23f4f1eb"/></svg>');
  tray = new Tray(icon);
  tray.setToolTip('IP Messenger');
  tray.on('double-click', () => showMainWindow());
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open IP Messenger', click: () => showMainWindow() },
    { label: 'Status: Online', enabled: false },
    { label: `Nearby Devices: ${nearbyDeviceCount}`, enabled: false },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: startWithWindows, click: (item: { checked: boolean }) => setStartup(item.checked) },
    { label: 'Mute Notifications', type: 'checkbox', checked: muteNotifications, click: (item: { checked: boolean }) => { muteNotifications = item.checked; } },
    { label: 'Settings', click: () => showMainWindow('settings') },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function setStartup(enabled: boolean): void {
  startWithWindows = enabled;
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, path: process.execPath });
  refreshTrayMenu();
}

function sendToRenderer(sender: RendererSender, channel: string, socketId: string, ...args: unknown[]): void {
  if (!sender.isDestroyed()) sender.send(channel, socketId, ...args);
}

ipcMain.handle('desktop:set-nearby-count', (_event: IpcEvent, count: number) => {
  nearbyDeviceCount = Math.max(0, Math.floor(count));
  refreshTrayMenu();
});

ipcMain.handle('desktop:notify', (_event: IpcEvent, payload: NotificationPayload) => {
  if (muteNotifications || !ElectronNotification.isSupported()) return;
  const notification = new ElectronNotification({ title: payload.title, body: payload.body, silent: muteNotifications });
  notification.on('click', () => showMainWindow(payload.conversationId));
  notification.show();
});

ipcMain.handle('desktop:get-startup', () => ({ enabled: startWithWindows, startMinimized: startWithWindows }));
ipcMain.handle('desktop:set-startup', (_event: IpcEvent, enabled: boolean) => setStartup(Boolean(enabled)));
ipcMain.handle('desktop:show', (_event: IpcEvent, conversationId?: string) => showMainWindow(conversationId));

ipcMain.handle('peer-server:start', async (event: IpcEvent, identity: DesktopIdentity) => {
  peerServerIdentity = identity;
  if (peerServer?.listening) return;
  peerServer = createServer((socket: Socket) => {
    const socketId = `incoming-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sockets.set(socketId, { socket, sender: event.sender });
    socket.setEncoding('utf8');
    let buffer = '';
    let announced = false;
    socket.on('data', (data: string | Buffer) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      buffer += text;
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (!frame.trim()) continue;
        try {
          const message = JSON.parse(frame) as { type?: string; payload?: { deviceId?: string; deviceName?: string; platform?: string; port?: number } };
          if (!announced && message.type === 'HELLO' && message.payload?.deviceId && peerServerIdentity) {
            announced = true;
            sendToRenderer(event.sender, 'peer-server:connection', socketId, {
              deviceId: message.payload.deviceId, deviceName: message.payload.deviceName ?? message.payload.deviceId,
              platform: message.payload.platform ?? 'windows', ipAddress: socket.remoteAddress?.replace(/^::ffff:/, '') ?? '127.0.0.1', port: message.payload.port ?? 5050,
            });
            socket.write(`${JSON.stringify({ type: 'DEVICE_INFO', payload: { deviceId: peerServerIdentity.deviceId, deviceName: peerServerIdentity.deviceName, platform: peerServerIdentity.platform, appVersion: peerServerIdentity.appVersion }, timestamp: Date.now(), senderId: peerServerIdentity.deviceId, receiverId: message.payload.deviceId })}\n`);
          }
        } catch { socket.destroy(); return; }
      }
      sendToRenderer(event.sender, 'peer-socket:data', socketId, text);
    });
    socket.on('close', () => { sockets.delete(socketId); sendToRenderer(event.sender, 'peer-socket:close', socketId); });
    socket.on('error', (error: Error) => sendToRenderer(event.sender, 'peer-socket:error', socketId, error.message));
  });
  await new Promise<void>((resolve, reject) => { peerServer!.once('error', reject); peerServer!.listen(identity.port, '0.0.0.0', resolve); });
});

ipcMain.handle('peer-server:stop', async () => {
  if (!peerServer?.listening) return;
  await new Promise<void>((resolve) => peerServer!.close(() => resolve()));
  peerServer = undefined;
  peerServerIdentity = undefined;
});

ipcMain.handle('peer-socket:connect', (event: IpcEvent, { socketId, host, port, timeoutMs }: ConnectPayload): Promise<void> => {
  const socket = new NodeSocket();
  socket.setEncoding('utf8');
  sockets.set(socketId, { socket, sender: event.sender });
  socket.on('data', (data: string | Buffer) => sendToRenderer(event.sender, 'peer-socket:data', socketId, String(data)));
  socket.on('close', () => { sockets.delete(socketId); sendToRenderer(event.sender, 'peer-socket:close', socketId); });
  socket.on('error', (error: Error) => sendToRenderer(event.sender, 'peer-socket:error', socketId, error.message));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`TCP connection timed out after ${timeoutMs}ms`)); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
    socket.connect(port, host);
  });
});

ipcMain.handle('peer-socket:write', (_event: IpcEvent, { socketId, data }: WritePayload): Promise<void> => {
  const entry = sockets.get(socketId);
  if (!entry || entry.socket.destroyed) throw new Error('Peer socket is not connected');
  return new Promise<void>((resolve, reject) => { entry.socket.write(data, 'utf8', (error?: Error | null) => error ? reject(error) : resolve()); });
});

ipcMain.handle('peer-socket:close', (_event: IpcEvent, { socketId }: ClosePayload): Promise<void> => {
  const entry = sockets.get(socketId);
  if (!entry) return Promise.resolve();
  return new Promise<void>((resolve) => { entry.socket.once('close', resolve); entry.socket.end(); });
});
