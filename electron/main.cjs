const { app, BrowserWindow, shell, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

const isDev = !app.isPackaged;
const VITE_DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

let mainWindow = null;

// --- Auto-update wiring ---
// Windows/macOS artifacts are NOT code-signed yet, so electron-updater has no
// cryptographic trust anchor on the downloaded installer beyond TLS to GitHub.
// If the release channel were ever compromised, an auto-download + auto-install
// would silently push attacker-controlled code to every client. Until the
// builds are signed (Authenticode / notarization), require explicit user intent
// before any update is fetched or staged: autoDownload stays off and the
// renderer must call updater:download to begin the transfer.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

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
// Download is gated behind an explicit user action in the renderer
// (UpdateBanner) — never triggered automatically — because unsigned artifacts
// offer no publisher verification.
ipcMain.handle('updater:download', async () => {
  if (isDev) return { skipped: true, reason: 'dev mode' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
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

// Production Content-Security-Policy. Locks the renderer down so an injected
// string (overlay text, project file, etc.) can't execute as script.
//   - 'wasm-unsafe-eval' (NOT 'unsafe-eval') is required to instantiate
//     ffmpeg.wasm / WebCodecs WASM; it permits WASM compilation only, not JS eval.
//   - worker-src blob: covers the ffmpeg-core.worker.js spawned from a blob URL.
//   - blob:/data: on img/media/connect cover object-URL video + canvas frames
//     and the locally-fetched ffmpeg core files.
//   - Google Fonts origins are whitelisted because index.html pulls them.
// NOTE: only applied in production. Vite's dev server needs inline/eval + a
// websocket for HMR, and Electron's missing-CSP warning is auto-suppressed in
// packaged builds anyway. After changing this, smoke-test a packaged build
// (npm run package:win) — a too-strict CSP shows as a blank window.
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

// Inject COOP/COEP headers on every response so SharedArrayBuffer is
// available — required by the multi-threaded ffmpeg.wasm build that
// powers our export pipeline. Without these headers Chromium refuses
// to instantiate SAB and the export falls back to single-thread (~3x
// slower). In production we also attach the CSP above.
function enableCrossOriginIsolation() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = {
      ...details.responseHeaders,
      'Cross-Origin-Opener-Policy': ['same-origin'],
      'Cross-Origin-Embedder-Policy': ['require-corp'],
    };
    if (!isDev) {
      responseHeaders['Content-Security-Policy'] = [PROD_CSP];
    }
    callback({ responseHeaders });
  });
}

function createWindow() {
  enableCrossOriginIsolation();
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 720,
    title: 'Byux',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true is safe here — preload.cjs only uses contextBridge +
      // ipcRenderer, both available in the sandbox. Keeps an XSS in the
      // renderer from reaching Node even if isolation is ever breached.
      sandbox: true,
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

  // Never open a second renderer window. http(s) links go to the OS browser;
  // everything else (javascript:, file:, custom schemes) is denied outright.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block the main window from navigating away from its own origin (defense in
  // depth against an injected location change loading a local/remote page).
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    let allowed = false;
    try {
      const parsed = new URL(navigationUrl);
      allowed = isDev
        ? parsed.origin === new URL(VITE_DEV_URL).origin
        : parsed.protocol === 'file:';
    } catch {
      allowed = false;
    }
    if (!allowed) event.preventDefault();
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
    // Generic user-facing text — don't surface internal paths / stack details
    // in the dialog (they go to the console log instead).
    dialog.showErrorBox(
      '予期しないエラー',
      'アプリケーションで予期しないエラーが発生しました。お手数ですが再起動してください。',
    );
  }
});
