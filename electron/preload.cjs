const { contextBridge, ipcRenderer } = require('electron');

const updaterListeners = new Set();

ipcRenderer.on('updater', (_event, payload) => {
  for (const cb of updaterListeners) cb(payload);
});

contextBridge.exposeInMainWorld('fce', {
  appName: 'Byux',
  isElectron: true,
  updater: {
    onEvent(cb) {
      updaterListeners.add(cb);
      return () => updaterListeners.delete(cb);
    },
    check() {
      return ipcRenderer.invoke('updater:check');
    },
    installAndRestart() {
      return ipcRenderer.invoke('updater:install-and-restart');
    },
  },
});
