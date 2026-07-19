const { contextBridge, ipcRenderer, webUtils } = require('electron');

const updaterListeners = new Set();

ipcRenderer.on('updater', (_event, payload) => {
  for (const cb of updaterListeners) cb(payload);
});

// Read via sync IPC rather than `require('../package.json')` — the sandboxed
// preload context (webPreferences.sandbox: true) only polyfills `require`
// for 'electron' and Node built-ins; a relative file require throws and
// silently aborts this ENTIRE script, taking every `window.fce` API down
// with it (this broke appVersion, setDirty, getPathForFile, readMediaFile,
// AND the updater in v1.0.4/1.0.5 packaged builds — dev mode masked it).
const appVersion = ipcRenderer.sendSync('app:get-version-sync');

contextBridge.exposeInMainWorld('fce', {
  appName: 'Byux',
  appVersion,
  isElectron: true,
  setDirty(dirty) {
    ipcRenderer.send('app:dirty', Boolean(dirty));
  },
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  registerMediaFile(ref) {
    return ipcRenderer.invoke('media:register-file', ref);
  },
  readMediaFileChunk(token, offset, length) {
    return ipcRenderer.invoke('media:read-chunk', token, offset, length);
  },
  releaseMediaFile(token) {
    return ipcRenderer.invoke('media:release-file', token);
  },
  project: {
    openDialog() {
      return ipcRenderer.invoke('project:open-dialog');
    },
    save(payload) {
      return ipcRenderer.invoke('project:save', payload);
    },
    confirmOpen(path) {
      return ipcRenderer.invoke('project:confirm-open', path);
    },
    autosave(text) {
      return ipcRenderer.invoke('project:autosave', { text });
    },
    checkRecovery() {
      return ipcRenderer.invoke('project:check-recovery');
    },
    listRecent() {
      return ipcRenderer.invoke('project:list-recent');
    },
    openRecent(path) {
      return ipcRenderer.invoke('project:open-recent', path);
    },
    removeRecent(path) {
      return ipcRenderer.invoke('project:remove-recent', path);
    },
  },
  export: {
    chooseOutput(payload) {
      return ipcRenderer.invoke('export:choose-output', payload);
    },
    writeChunk(token, offset, chunk, final) {
      return ipcRenderer.invoke('export:write-chunk', token, offset, chunk, final);
    },
    abandon(token) {
      return ipcRenderer.invoke('export:abandon', token);
    },
    openFile() {
      return ipcRenderer.invoke('export:open-file');
    },
    showInFolder() {
      return ipcRenderer.invoke('export:show-in-folder');
    },
  },
  updater: {
    onEvent(cb) {
      updaterListeners.add(cb);
      return () => updaterListeners.delete(cb);
    },
    check() {
      return ipcRenderer.invoke('updater:check');
    },
    download() {
      return ipcRenderer.invoke('updater:download');
    },
    installAndRestart() {
      return ipcRenderer.invoke('updater:install-and-restart');
    },
  },
});
