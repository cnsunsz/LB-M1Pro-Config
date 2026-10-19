// LB-M1Pro 鼠标设置 —— Electron 主进程
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const ALLOWED = [
  { vendorId: 0x088d, productId: 0x052e },
  { vendorId: 0x088d, productId: 0x052f },
  { vendorId: 0x089d, productId: 0x053f },
];
const isAllowed = (d) => ALLOWED.some((a) => a.vendorId === d.vendorId && a.productId === d.productId);

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const BOUNDS_FILE = () => path.join(app.getPath('userData'), 'window-bounds.json');

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return fallback;
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('writeJson', e);
    return false;
  }
}

let win;
function createWindow() {
  const saved = readJson(BOUNDS_FILE(), null);
  const opts = {
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0b0e13',
    title: 'LB-M1Pro 鼠标设置',
    icon: path.join(__dirname, 'renderer', 'assets', 'app.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (saved && typeof saved.width === 'number' && typeof saved.height === 'number') {
    opts.width = Math.max(opts.minWidth, saved.width);
    opts.height = Math.max(opts.minHeight, saved.height);
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      opts.x = saved.x;
      opts.y = saved.y;
    }
  }
  win = new BrowserWindow(opts);
  if (saved && saved.isMaximized) win.maximize();

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const data = { isMaximized: win.isMaximized() };
    if (!data.isMaximized) Object.assign(data, win.getBounds());
    else Object.assign(data, win.getNormalBounds ? win.getNormalBounds() : win.getBounds());
    writeJson(BOUNDS_FILE(), data);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('maximize', () => { saveBounds(); win.webContents.send('win-state', 'max'); });
  win.on('unmaximize', () => { saveBounds(); win.webContents.send('win-state', 'normal'); });
  win.on('close', saveBounds);

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const dev = details.deviceList.find(isAllowed);
    callback(dev ? dev.deviceId : '');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'hid' || permission === 'media');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'hid' && isAllowed(details.device));

  ipcMain.on('win', (_e, cmd) => {
    if (!win) return;
    if (cmd === 'min') win.minimize();
    else if (cmd === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (cmd === 'close') win.close();
  });

  ipcMain.handle('settings:load', () => readJson(SETTINGS_FILE(), null));
  ipcMain.handle('settings:save', (_e, data) => writeJson(SETTINGS_FILE(), data));
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getUserData', () => app.getPath('userData'));

  createWindow();
});

app.on('window-all-closed', () => app.quit());
