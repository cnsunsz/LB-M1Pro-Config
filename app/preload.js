const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shell', {
  win: (cmd) => ipcRenderer.send('win', cmd),
  onWinState: (cb) => ipcRenderer.on('win-state', (_e, s) => cb(s)),
  isElectron: true,
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getUserData: () => ipcRenderer.invoke('app:getUserData'),
});
