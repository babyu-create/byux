const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

const isDev = !app.isPackaged;
const VITE_DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

let mainWindow = null;

// --- Auto-update wiring ---
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

autoUpdater.on('checking-for-update', () => {
  send('updater', { status: 'checking' });
});
autoUpdater.on('update-available', (info) => {
  send('updater', { status: 'available', version: info.version });
});
autoUpdater.on('update-not-available', () => {
  send('updater', { status: 'up-to-date' });
});
autoUpdater.on('error', (err) => {
  send('updater', { status: 'error', message: err?.message ?? String(err) });
});
autoUpdater.on('download-progress', (progress) => {
  send('updater', {
    status: 'downloading',
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total,
  });
});
autoUpdater.on('update-downloaded', (info) => {
  send('updater', { status: 'downloaded', version: info.version });
});

ipcMain.handle('updater:install-and-restart', () => {
  autoUpdater.quitAndInstall();
});
ipcMain.handle('updater:check', async () => {
  if (isDev) return { skipped: true, reason: 'dev mode' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, info: result?.updateInfo };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 720,
    title: 'FPS Clip Editor',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Kick off update check shortly after window appears.
    if (!isDev) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => {});
      }, 3000);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Avoid noisy dialog on update errors during dev or no-network cases.
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[main] uncaught', err);
  if (!isDev) {
    dialog.showErrorBox('予期しないエラー', err?.message ?? String(err));
  }
});
