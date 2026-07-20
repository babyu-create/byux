const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  session,
  protocol,
  net,
  Menu,
} = require('electron');
const path = require('node:path');
const http = require('node:http');
const fsStream = require('node:fs');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const { shouldClearRecovery } = require('./projectState.cjs');
const {
  NativeExportPlanError,
  buildNativeExportPlan,
  parseProgressText,
} = require('./nativeExportPlan.cjs');
const {
  appendTail,
  minimalEnvironment,
  probeInputHasAudio,
  resolveFfmpegBinary,
  terminateProcess,
  validateOutput,
  verifyFfmpegBinary,
} = require('./nativeFfmpeg.cjs');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'fce-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const isDev = !app.isPackaged;
const VITE_DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const DIST_DIR = path.join(__dirname, '..', 'dist');
let prodEntryUrl = '';
let appServer = null;

let mainWindow = null;
let isDirty = false;
let closePromptOpen = false;
let allowQuitAfterDiscard = false;
let pendingCloseSaveRequest = null;
let activeProjectSaves = 0;
let autosaveCleanupRequired = false;
let autosaveWritesBlocked = false;

// Autosave, recent-project metadata, and export destinations are intentionally
// single-writer resources. A second process could race atomic renames or show
// two conflicting recovery prompts, so redirect subsequent launches to the
// existing window.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function isTrustedRendererUrl(url) {
  try {
    const parsed = new URL(url);
    if (isDev) return parsed.origin === new URL(VITE_DEV_URL).origin;
    const withoutHash = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    const expected = new URL(prodEntryUrl);
    const expectedWithoutHash = `${expected.origin}${expected.pathname}${expected.search}`;
    return parsed.protocol === 'http:' && withoutHash === expectedWithoutHash;
  } catch {
    return false;
  }
}

function isTrustedIpcEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const frame = event.senderFrame;
  return (
    event.sender === mainWindow.webContents &&
    frame === mainWindow.webContents.mainFrame &&
    isTrustedRendererUrl(frame.url)
  );
}

ipcMain.on('app:dirty', (event, dirty) => {
  if (!isTrustedIpcEvent(event)) return;
  isDirty = Boolean(dirty);
});

ipcMain.on('app:save-before-close-result', (event, payload) => {
  if (
    !isTrustedIpcEvent(event) ||
    !pendingCloseSaveRequest ||
    payload?.id !== pendingCloseSaveRequest.id
  ) {
    return;
  }
  const request = pendingCloseSaveRequest;
  pendingCloseSaveRequest = null;
  clearTimeout(request.timeout);
  request.resolve(payload.success === true && !isDirty);
});

function cancelPendingCloseSaveRequest() {
  if (!pendingCloseSaveRequest) return;
  const request = pendingCloseSaveRequest;
  pendingCloseSaveRequest = null;
  clearTimeout(request.timeout);
  request.resolve(false);
}

function requestRendererSaveBeforeClose() {
  if (
    pendingCloseSaveRequest ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      if (pendingCloseSaveRequest?.id !== id) return;
      pendingCloseSaveRequest.timedOut = true;
      resolve(false);
      void showCloseCleanupError(new Error('保存処理が時間内に完了しませんでした。'));
    }, 2 * 60 * 1000);
    timeout.unref?.();
    pendingCloseSaveRequest = { id, timeout, resolve };
    mainWindow.webContents.send('app:save-before-close', { id });
  });
}

ipcMain.on('app:get-version-sync', (event) => {
  if (!isTrustedIpcEvent(event)) {
    event.returnValue = '';
    return;
  }
  event.returnValue = app.getVersion();
});

// --- Native project files / recovery ---------------------------------------
// Project JSON is small metadata only (media bytes are never embedded). Keep
// all path authority in the main process: the renderer may provide contents
// and a suggested filename, but cannot choose an arbitrary write target.
const MAX_PROJECT_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_RECENT_PROJECTS = 10;
let currentProjectPath = null;
let pendingProjectPath = null;
let pendingProjectSessionId = null;
let pendingRecovery = null;
let documentSessionId = crypto.randomUUID();

function projectTextIsValid(text) {
  return (
    typeof text === 'string' &&
    Buffer.byteLength(text, 'utf8') > 0 &&
    Buffer.byteLength(text, 'utf8') <= MAX_PROJECT_TEXT_BYTES
  );
}

function safeProjectStem(value) {
  const stem = String(value || 'project')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120);
  return stem || 'project';
}

function ensureProjectExtension(filePath) {
  return filePath.toLowerCase().endsWith('.json') ? filePath : `${filePath}.fce.json`;
}

function autosavePath() {
  return path.join(app.getPath('userData'), 'recovery', 'project-autosave.json');
}

function recentProjectsPath() {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

const atomicWriteQueues = new Map();

async function withPathQueue(targetPath, operation) {
  const key = path.resolve(targetPath);
  const previous = atomicWriteQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation);
  const queued = run.catch(() => {});
  atomicWriteQueues.set(key, queued);
  try {
    return await run;
  } finally {
    if (atomicWriteQueues.get(key) === queued) atomicWriteQueues.delete(key);
  }
}

async function atomicWriteText(targetPath, text) {
  return withPathQueue(targetPath, async () => {
    const directory = path.dirname(targetPath);
    await fs.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let handle = null;
    try {
      handle = await fs.open(temporaryPath, 'wx');
      await handle.writeFile(text, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  });
}

async function readProjectText(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROJECT_TEXT_BYTES) {
    throw new Error('プロジェクトファイルのサイズが不正です');
  }
  return fs.readFile(filePath, 'utf8');
}

async function loadRecentProjects() {
  try {
    const raw = JSON.parse(await fs.readFile(recentProjectsPath(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    const entries = raw
      .filter(
        (entry) =>
          entry &&
          typeof entry.path === 'string' &&
          path.isAbsolute(entry.path) &&
          typeof entry.lastOpenedAt === 'string',
      )
      .slice(0, MAX_RECENT_PROJECTS);
    const checked = await Promise.all(
      entries.map(async (entry) => ({
        path: entry.path,
        name: path.basename(entry.path).replace(/\.fce\.json$/i, '').replace(/\.json$/i, ''),
        lastOpenedAt: entry.lastOpenedAt,
        available: await fs
          .stat(entry.path)
          .then((stat) => stat.isFile())
          .catch(() => false),
      })),
    );
    return checked;
  } catch {
    return [];
  }
}

async function saveRecentProjects(entries) {
  await atomicWriteText(
    recentProjectsPath(),
    JSON.stringify(
      entries.slice(0, MAX_RECENT_PROJECTS).map(({ path: filePath, lastOpenedAt }) => ({
        path: filePath,
        lastOpenedAt,
      })),
      null,
      2,
    ),
  );
}

async function rememberRecentProject(filePath) {
  const entries = await loadRecentProjects();
  const normalized = path.resolve(filePath);
  const next = [
    {
      path: normalized,
      name: path.basename(normalized).replace(/\.fce\.json$/i, '').replace(/\.json$/i, ''),
      lastOpenedAt: new Date().toISOString(),
      available: true,
    },
    ...entries.filter((entry) => path.resolve(entry.path) !== normalized),
  ];
  await saveRecentProjects(next);
}

async function clearAutosave() {
  const targetPath = autosavePath();
  await withPathQueue(targetPath, () => fs.rm(targetPath, { force: true }));
  autosaveCleanupRequired = false;
}

ipcMain.handle('project:open-dialog', async (event) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  const requestSessionId = documentSessionId;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Byuxプロジェクトを開く',
    properties: ['openFile'],
    filters: [
      { name: 'Byuxプロジェクト', extensions: ['json', 'fce'] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true };
  const filePath = result.filePaths[0];
  try {
    const text = await readProjectText(filePath);
    if (requestSessionId !== documentSessionId) {
      return { ok: false, stale: true, error: 'プロジェクトが切り替わりました' };
    }
    authorizeProjectMediaRefs(text);
    pendingProjectPath = filePath;
    pendingProjectSessionId = requestSessionId;
    return { ok: true, canceled: false, path: filePath, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('project:save', async (event, payload) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  if (!payload || !projectTextIsValid(payload.text)) {
    return { ok: false, error: 'プロジェクトデータが不正です' };
  }
  activeProjectSaves += 1;
  try {
    const requestSessionId = documentSessionId;

    let targetPath = currentProjectPath;
    if (!targetPath || payload.saveAs === true) {
      const suggestedName = `${safeProjectStem(payload.suggestedName)}.fce.json`;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Byuxプロジェクトを保存',
        defaultPath: currentProjectPath ?? path.join(app.getPath('documents'), suggestedName),
        filters: [{ name: 'Byuxプロジェクト', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      targetPath = ensureProjectExtension(result.filePath);
    }

    try {
      if (requestSessionId !== documentSessionId) {
        return { ok: false, stale: true, error: 'プロジェクトが切り替わりました' };
      }
      await atomicWriteText(targetPath, payload.text);
      if (requestSessionId !== documentSessionId) {
        return { ok: false, stale: true, error: 'プロジェクトが切り替わりました' };
      }
      currentProjectPath = targetPath;
      let warning;
      try {
        await rememberRecentProject(targetPath);
      } catch {
        warning = '保存しましたが、最近使ったプロジェクトの更新に失敗しました';
      }
      return {
        ok: true,
        canceled: false,
        path: targetPath,
        sessionId: requestSessionId,
        warning,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    activeProjectSaves = Math.max(0, activeProjectSaves - 1);
  }
});

ipcMain.handle('project:confirm-open', async (event, openedPath) => {
  if (
    !isTrustedIpcEvent(event) ||
    typeof openedPath !== 'string' ||
    !pendingProjectPath ||
    pendingProjectSessionId !== documentSessionId ||
    path.resolve(openedPath) !== path.resolve(pendingProjectPath)
  ) {
    return false;
  }
  try {
    await clearAutosave();
  } catch {
    return false;
  }
  currentProjectPath = pendingProjectPath;
  pendingProjectPath = null;
  pendingProjectSessionId = null;
  documentSessionId = crypto.randomUUID();
  isDirty = false;
  await rememberRecentProject(currentProjectPath).catch(() => {});
  return true;
});

ipcMain.handle('project:autosave', async (event, payload) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  if (autosaveWritesBlocked) {
    return { ok: false, stale: true, error: 'アプリの終了処理中です' };
  }
  if (!payload || !projectTextIsValid(payload.text)) {
    return { ok: false, error: '自動保存データが不正です' };
  }
  const requestSessionId = documentSessionId;
  const generation = crypto.randomUUID();
  try {
    const wrapper = JSON.stringify({
      version: 1,
      generation,
      savedAt: new Date().toISOString(),
      projectPath: currentProjectPath,
      text: payload.text,
    });
    if (requestSessionId !== documentSessionId) {
      return { ok: false, stale: true, error: 'プロジェクトが切り替わりました' };
    }
    await atomicWriteText(autosavePath(), wrapper);
    if (requestSessionId !== documentSessionId) {
      return { ok: false, stale: true, error: 'プロジェクトが切り替わりました' };
    }
    return { ok: true, generation, sessionId: requestSessionId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('project:check-recovery', async (event) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  let recovery;
  try {
    const stat = await fs.stat(autosavePath());
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROJECT_TEXT_BYTES * 2) {
      await clearAutosave();
      return { ok: true, recovered: false };
    }
    recovery = JSON.parse(await fs.readFile(autosavePath(), 'utf8'));
    if (
      recovery?.version !== 1 ||
      !projectTextIsValid(recovery.text) ||
      typeof recovery.savedAt !== 'string'
    ) {
      await clearAutosave();
      return { ok: true, recovered: false };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, recovered: false };
    return { ok: false, error: '自動保存データを安全に確認できませんでした' };
  }

  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['復元する', '破棄する'],
    defaultId: 0,
    cancelId: 1,
    title: '編集中のプロジェクトがあります',
    message: '前回終了時の自動保存データが見つかりました。',
    detail: `${new Date(recovery.savedAt).toLocaleString('ja-JP')} の状態を復元しますか？`,
  });
  if (choice.response !== 0) {
    pendingRecovery = null;
    try {
      await clearAutosave();
      return { ok: true, recovered: false };
    } catch {
      return { ok: false, error: '自動保存データを破棄できませんでした' };
    }
  }
  const recoveryId = crypto.randomUUID();
  const recoveredProjectPath =
    typeof recovery.projectPath === 'string' && path.isAbsolute(recovery.projectPath)
      ? recovery.projectPath
      : null;
  // Keep the recovery file until the renderer has parsed and applied it.
  // A malformed document or renderer crash must not destroy the only copy.
  pendingRecovery = { id: recoveryId, projectPath: recoveredProjectPath };
  authorizeProjectMediaRefs(recovery.text);
  return {
    ok: true,
    recovered: true,
    text: recovery.text,
    path: recoveredProjectPath,
    recoveryId,
    generation: typeof recovery.generation === 'string' ? recovery.generation : null,
  };
});

ipcMain.handle('project:new-session', async (event, payload) => {
  if (!isTrustedIpcEvent(event)) return false;
  // Invalidate every in-flight save/autosave before clearing recovery, while
  // retaining the current path and dirty authority until cleanup succeeds.
  // Otherwise a failed cleanup could leave the renderer showing the old dirty
  // project while the main process incorrectly considered it safe to close.
  pendingProjectPath = null;
  pendingProjectSessionId = null;
  pendingRecovery = null;
  documentSessionId = crypto.randomUUID();
  try {
    await clearAutosave();
    currentProjectPath = null;
    isDirty = false;
    return true;
  } catch {
    if (payload?.detachOnFailure === true) {
      // The renderer has already applied a different document. Never retain
      // authority to overwrite the old project's path, even though recovery
      // cleanup failed; keep close protection active instead.
      currentProjectPath = null;
      isDirty = true;
    }
    return false;
  }
});

ipcMain.handle('project:commit-save', async (event, payload) => {
  if (
    !isTrustedIpcEvent(event) ||
    !payload ||
    !projectTextIsValid(payload.savedText) ||
    typeof payload.sessionId !== 'string' ||
    payload.sessionId !== documentSessionId
  ) {
    return false;
  }
  const autosaveGeneration =
    typeof payload.autosaveGeneration === 'string' ? payload.autosaveGeneration : null;
  try {
    const targetPath = autosavePath();
    let cleared = false;
    await withPathQueue(targetPath, async () => {
      const recovery = JSON.parse(await fs.readFile(targetPath, 'utf8'));
      if (shouldClearRecovery(recovery, payload.savedText, autosaveGeneration)) {
        // Direct rm while holding this path's queue. Calling clearAutosave()
        // here would enqueue behind this transaction and deadlock.
        await fs.rm(targetPath, { force: true });
        cleared = true;
      }
    });
    if (!cleared) autosaveCleanupRequired = true;
    return cleared;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    autosaveCleanupRequired = true;
    return false;
  }
});

ipcMain.handle('project:confirm-recovery', async (event, recoveryId) => {
  if (
    !isTrustedIpcEvent(event) ||
    typeof recoveryId !== 'string' ||
    !pendingRecovery ||
    pendingRecovery.id !== recoveryId
  ) {
    return false;
  }
  currentProjectPath = pendingRecovery.projectPath;
  pendingRecovery = null;
  documentSessionId = crypto.randomUUID();
  isDirty = true;
  // Keep the recovered generation until an explicit successful save. If the
  // renderer crashes immediately after restoration, this remains the only
  // durable copy and must be offered again on the next launch.
  return true;
});

ipcMain.handle('project:list-recent', async (event) => {
  if (!isTrustedIpcEvent(event)) return [];
  return loadRecentProjects();
});

ipcMain.handle('project:open-recent', async (event, requestedPath) => {
  if (!isTrustedIpcEvent(event) || typeof requestedPath !== 'string') {
    return { ok: false, error: 'untrusted sender' };
  }
  const requestSessionId = documentSessionId;
  const entries = await loadRecentProjects();
  const entry = entries.find(
    (candidate) => path.resolve(candidate.path) === path.resolve(requestedPath),
  );
  if (!entry || !entry.available) {
    return { ok: false, error: 'プロジェクトファイルが見つかりません' };
  }
  try {
    const text = await readProjectText(entry.path);
    if (requestSessionId !== documentSessionId) {
      return { ok: false, stale: true, error: 'プロジェクトが切り替わりました' };
    }
    authorizeProjectMediaRefs(text);
    pendingProjectPath = entry.path;
    pendingProjectSessionId = requestSessionId;
    return { ok: true, canceled: false, path: entry.path, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('project:remove-recent', async (event, requestedPath) => {
  if (!isTrustedIpcEvent(event) || typeof requestedPath !== 'string') return false;
  const entries = await loadRecentProjects();
  const filtered = entries.filter(
    (entry) => path.resolve(entry.path) !== path.resolve(requestedPath),
  );
  await saveRecentProjects(filtered);
  return true;
});

// --- Native export destinations --------------------------------------------
// Rendered MP4 data can be hundreds of MB. The renderer streams bounded chunks
// to an opaque main-process token instead of cloning one giant ArrayBuffer over
// IPC. The only writable path is the one the user selected in showSaveDialog.
const MAX_EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_FILE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_NATIVE_OVERLAY_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_OVERLAY_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_OVERLAY_DIMENSION = 8_192;
const MAX_NATIVE_OVERLAY_DECODED_BYTES = 512 * 1024 * 1024;
const pendingExports = new Map();
const pendingProxyJobs = new Map();
let lastExportPath = null;
let ffmpegCapabilityPromise = null;
let exportJournalOperation = Promise.resolve();

function exportJournalPath() {
  return path.join(app.getPath('userData'), 'pending-exports.json');
}

function nativeWorkRoot() {
  return path.join(app.getPath('temp'), 'byux-native-export');
}

function exportJournalSnapshot() {
  return [...pendingExports.entries()].map(([token, entry]) => ({
    token,
    path: entry.path,
    temporaryPath: entry.temporaryPath,
    workDir: entry.workDir ?? null,
    createdAt: entry.createdAt,
  }));
}

async function writeExportJournalSnapshot(snapshot) {
  const target = exportJournalPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(snapshot), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function persistExportJournal() {
  const snapshot = exportJournalSnapshot();
  exportJournalOperation = exportJournalOperation.catch(() => {}).then(async () => {
    await writeExportJournalSnapshot(snapshot);
  });
  return exportJournalOperation;
}

function isJournalTemporaryPath(record) {
  if (
    !record ||
    typeof record.token !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(record.token) ||
    typeof record.path !== 'string' ||
    typeof record.temporaryPath !== 'string'
  ) {
    return false;
  }
  const expectedName = `.${path.basename(record.path)}.${record.token}.part`;
  return (
    path.dirname(record.path) === path.dirname(record.temporaryPath) &&
    path.basename(record.temporaryPath) === expectedName
  );
}

async function cleanupOrphanedExports() {
  let records;
  try {
    records = JSON.parse(await fs.readFile(exportJournalPath(), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') records = [];
    else return;
  }
  if (!Array.isArray(records)) return;
  const root = path.resolve(nativeWorkRoot());
  const remaining = [];
  for (const record of records) {
    if (!isJournalTemporaryPath(record)) {
      remaining.push(record);
      continue;
    }
    let cleanupFailed = false;
    try {
      await fs.rm(record.temporaryPath, { force: true });
    } catch {
      cleanupFailed = true;
    }
    if (typeof record.workDir === 'string') {
      const resolvedWork = path.resolve(record.workDir);
      if (path.dirname(resolvedWork) === root && path.basename(resolvedWork) === record.token) {
        try {
          await fs.rm(resolvedWork, { recursive: true, force: true });
        } catch {
          cleanupFailed = true;
        }
      } else {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) remaining.push(record);
  }
  // A crashed FFmpeg can still own its output briefly. Preserve failed records
  // so a later launch retries instead of permanently losing cleanup authority.
  await writeExportJournalSnapshot(remaining);
  // The directory is private to Byux and contains only UUID-named render
  // scratch folders. This also covers a crash between mkdir and journal flush.
  let scratchEntries = [];
  try {
    scratchEntries = await fs.readdir(nativeWorkRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    scratchEntries
      .filter(
        (entry) =>
          entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name),
      )
      .map((entry) =>
        fs.rm(path.join(nativeWorkRoot(), entry.name), {
          recursive: true,
          force: true,
        }).catch(() => {}),
      ),
  );
}

function ffmpegBinaryPath() {
  return resolveFfmpegBinary(app.isPackaged, process.resourcesPath, path.join(__dirname, '..'));
}

function ensureNativeFfmpeg() {
  if (!ffmpegCapabilityPromise) {
    ffmpegCapabilityPromise = verifyFfmpegBinary(ffmpegBinaryPath()).catch((error) => {
      ffmpegCapabilityPromise = null;
      throw error;
    });
  }
  return ffmpegCapabilityPromise;
}

function sendNativeExportEvent(token, payload) {
  const entry = pendingExports.get(token);
  if (!entry || !mainWindow || mainWindow.isDestroyed()) return;
  entry.eventSequence = (entry.eventSequence ?? 0) + 1;
  mainWindow.webContents.send('export:native-event', {
    token,
    sequence: entry.eventSequence,
    ...payload,
  });
}

function safeExportFilename(value) {
  const stem = String(value || 'byux-export.mp4')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120);
  const name = stem || 'byux-export.mp4';
  return name.toLowerCase().endsWith('.mp4') ? name : `${name}.mp4`;
}

async function cleanupExportFiles(entry, removePartial = true) {
  let cleanupError = null;
  try {
    await entry.handle?.close();
  } catch (error) {
    cleanupError = error;
  }
  entry.handle = null;
  if (removePartial && !entry.committed) {
    try {
      await fs.rm(entry.temporaryPath, { force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (entry.workDir) {
    try {
      await fs.rm(entry.workDir, { recursive: true, force: true });
      entry.workDir = null;
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) throw cleanupError;
}

async function abandonExport(token, removePartial = true) {
  const entry = pendingExports.get(token);
  if (!entry) return false;
  if (entry.cleanupPromise) return entry.cleanupPromise;
  entry.cancelled = true;
  const cleanupPromise = (async () => {
    if (entry.backend === 'native-ffmpeg') {
      entry.state = 'cancelling';
      sendNativeExportEvent(token, {
        phase: 'cancelling',
        stage: '書き出しを安全に中止しています',
        overallProgress: entry.progress ?? 0,
      });
      // Signal before awaiting the operation. Do not swallow a failure to
      // confirm process exit: deleting its open output would orphan the child.
      await terminateProcess(entry.child);
      entry.child = null;
    }
    // Keep the entry in pendingExports until its queued disk operation and
    // cleanup have really completed. A second close request must not be able
    // to terminate the process while a large partial file is still open.
    await entry.operation.catch(() => {});
    await cleanupExportFiles(entry, removePartial);
    releaseExportSourceLeases(entry);
    if (pendingExports.get(token) === entry) pendingExports.delete(token);
    await persistExportJournal();
    return {
      ok: true,
      abandoned: !entry.committed,
      committed: entry.committed,
      path: entry.committed ? entry.path : undefined,
    };
  })();
  entry.cleanupPromise = cleanupPromise;
  try {
    return await cleanupPromise;
  } catch (error) {
    // Keep the cancelled entry visible to close protection and allow an
    // explicit retry if antivirus or another process temporarily held it.
    if (entry.cleanupPromise === cleanupPromise) entry.cleanupPromise = null;
    throw error;
  }
}

function queueExportOperation(entry, operation) {
  const run = entry.operation.then(operation);
  entry.operation = run.catch(() => {});
  return run;
}

function assertActiveExport(token, entry) {
  if (entry.cancelled || pendingExports.get(token) !== entry) {
    throw new Error('書き出しが中止されました');
  }
}

async function failExportEntry(token, entry) {
  entry.cancelled = true;
  await cleanupExportFiles(entry);
  if (pendingExports.get(token) === entry) pendingExports.delete(token);
  await persistExportJournal();
}

function resetDocumentSession() {
  currentProjectPath = null;
  pendingProjectPath = null;
  pendingProjectSessionId = null;
  pendingRecovery = null;
  documentSessionId = crypto.randomUUID();
  isDirty = false;
}

function abandonAllExports() {
  return Promise.all([
    ...[...pendingExports.keys()].map((token) => abandonExport(token)),
    ...[...pendingProxyJobs.keys()].map((token) => abandonProxyJob(token)),
  ]);
}

async function confirmDiscardBeforeClose() {
  if (activeProjectSaves > 0) return false;
  if (pendingCloseSaveRequest) {
    if (!pendingCloseSaveRequest.timedOut) return false;
    // The main-process file write has settled, so a second explicit close may
    // safely re-enter the normal save/discard prompt. Any late renderer reply
    // is ignored, but can no longer overwrite a project file.
    cancelPendingCloseSaveRequest();
  }
  const hasExport = pendingExports.size > 0 || pendingProxyJobs.size > 0;
  const hasChanges = isDirty;
  if (!hasExport && !hasChanges && !autosaveCleanupRequired) return true;
  if (!hasExport && !hasChanges && autosaveCleanupRequired) {
    autosaveWritesBlocked = true;
    try {
      await clearAutosave();
      return true;
    } catch (error) {
      autosaveWritesBlocked = false;
      throw error;
    }
  }
  const buttons = hasChanges
    ? [
        hasExport ? '保存して書き出しを中止・終了' : '保存して終了',
        hasExport ? '書き出しと変更を破棄して終了' : '保存せずに終了',
        'キャンセル',
      ]
    : ['書き出しを中止して終了', 'キャンセル'];
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons,
    defaultId: hasChanges ? 2 : 1,
    cancelId: hasChanges ? 2 : 1,
    title:
      hasExport && hasChanges
        ? '書き出し中で、未保存の変更があります'
        : hasExport
          ? '動画を書き出しています'
          : '未保存の変更があります',
    message: hasChanges
      ? '変更を保存してから終了できます。'
      : '書き出しを中止してアプリを終了しますか？',
    detail: hasExport
      ? '作成途中のファイルは削除されます。'
      : '先に「保存」(Ctrl+S) を実行すると変更を残せます。',
  });
  if (choice.response === (hasChanges ? 2 : 1)) return false;
  if (hasChanges && choice.response === 0) {
    const saved = await requestRendererSaveBeforeClose();
    if (!saved || isDirty) return false;
  }
  if (hasChanges) autosaveCleanupRequired = true;
  autosaveWritesBlocked = true;
  try {
    await Promise.all([
      hasExport ? abandonAllExports() : Promise.resolve(),
      hasChanges ? clearAutosave() : Promise.resolve(),
    ]);
    isDirty = false;
    return true;
  } catch (error) {
    autosaveWritesBlocked = false;
    throw error;
  }
}

async function showCloseCleanupError(error) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    buttons: ['OK'],
    title: '終了の準備に失敗しました',
    message: '安全のため、アプリを終了しませんでした。',
    detail:
      error instanceof Error
        ? `${error.message}\nもう一度終了するか、プロジェクトを別名で保存してください。`
        : 'もう一度終了するか、プロジェクトを別名で保存してください。',
  });
}

function releaseRegisteredMediaLease(token) {
  const source = registeredMedia.get(token);
  if (!source) return;
  source.leases = Math.max(0, (source.leases ?? 0) - 1);
  if (source.leases === 0 && source.releaseRequested) {
    registeredMedia.delete(token);
  }
}

function releaseExportSourceLeases(entry) {
  for (const token of entry.sourceLeases ?? []) {
    releaseRegisteredMediaLease(token);
  }
  entry.sourceLeases = [];
}

function isDangerousWindowsDevicePath(value) {
  if (process.platform !== 'win32') return false;
  const normalized = String(value).replaceAll('/', '\\').toLowerCase();
  return (
    normalized.startsWith('\\\\.\\') ||
    normalized.startsWith('\\\\?\\globalroot\\') ||
    normalized.startsWith('\\device\\') ||
    normalized.startsWith('\\\\?\\pipe\\')
  );
}

async function leaseNativeSources(request, binaryPath, entry) {
  if (
    !Array.isArray(request?.assets) ||
    request.assets.length > 2_000 ||
    !Array.isArray(request?.clips) ||
    request.clips.length > 10_000 ||
    !Array.isArray(request?.tracks) ||
    request.tracks.length > 100
  ) {
    throw new NativeExportPlanError('INVALID_PROJECT', '素材一覧が不正です');
  }
  const trackById = new Map(
    Array.isArray(request?.tracks)
      ? request.tracks.map((track) => [track?.id, track])
      : [],
  );
  const requiredAssetIds = new Set();
  for (const clip of request.clips) {
    if (typeof clip?.assetId !== 'string' || clip.assetId.length > 200) {
      throw new NativeExportPlanError('INVALID_PROJECT', 'クリップの素材IDが不正です');
    }
    const track = trackById.get(clip.trackId);
    const isVisibleVisual =
      track?.hidden !== true &&
      (track?.kind === 'video' || track?.kind === 'overlay');
    if (
      isVisibleVisual ||
      (track?.kind === 'audio' &&
        track.hidden !== true &&
        track.muted !== true &&
        clip.muted !== true)
    ) {
      requiredAssetIds.add(clip.assetId);
    }
  }
  const sources = new Map();
  const audioProbeByToken = new Map();
  try {
    for (const asset of request.assets) {
      if (!requiredAssetIds.has(asset?.id)) continue;
      if (entry.cancelled) {
        throw new NativeExportPlanError('CANCELLED', '書き出しを中止しました');
      }
      if (
        typeof asset?.id !== 'string' ||
        typeof asset?.sourceToken !== 'string' ||
        sources.has(asset.id)
      ) {
        throw new NativeExportPlanError('INVALID_PROJECT', '素材トークンが不正です');
      }
      const source = registeredMedia.get(asset.sourceToken);
      if (
        !source ||
        source.kind !== asset.kind ||
        source.size !== asset.size ||
        isDangerousWindowsDevicePath(source.path)
      ) {
        throw new NativeExportPlanError(
          'MISSING_MEDIA',
          `元素材を確認できません: ${String(asset.name || asset.id)}`,
        );
      }
      const [realPath, stat] = await Promise.all([
        fs.realpath(source.path),
        fs.stat(source.path),
      ]);
      if (
        !stat.isFile() ||
        realPath !== source.path ||
        stat.size !== source.size ||
        (source.dev !== undefined && stat.dev !== source.dev) ||
        (source.ino !== undefined && source.ino !== 0 && stat.ino !== source.ino) ||
        (source.mtimeMs !== undefined && Math.abs(stat.mtimeMs - source.mtimeMs) > 1)
      ) {
        throw new NativeExportPlanError(
          'SOURCE_CHANGED',
          `元素材が読み込み後に変更されました: ${String(asset.name || asset.id)}`,
        );
      }
      source.leases = (source.leases ?? 0) + 1;
      entry.sourceLeases.push(asset.sourceToken);
      let audioProbe = audioProbeByToken.get(asset.sourceToken);
      if (!audioProbe) {
        audioProbe = probeInputHasAudio(binaryPath, source.path);
        audioProbeByToken.set(asset.sourceToken, audioProbe);
      }
      const hasAudio = await audioProbe;
      if (entry.cancelled) {
        throw new NativeExportPlanError('CANCELLED', '書き出しを中止しました');
      }
      sources.set(asset.id, {
        path: source.path,
        hasAudio,
      });
    }
    return sources;
  } catch (error) {
    releaseExportSourceLeases(entry);
    throw error;
  }
}

async function writeNativeOverlayFiles(request, entry) {
  const overlays = request?.overlays;
  if (!Array.isArray(overlays) || overlays.length > 512) {
    throw new NativeExportPlanError('INVALID_OVERLAY', 'テキスト画像が不正です');
  }
  const result = new Map();
  let totalBytes = 0;
  let totalDecodedBytes = 0;
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 0; index < overlays.length; index++) {
    if (entry.cancelled) {
      throw new NativeExportPlanError('CANCELLED', '書き出しを中止しました');
    }
    const overlay = overlays[index];
    if (
      typeof overlay?.clipId !== 'string' ||
      result.has(overlay.clipId) ||
      !ArrayBuffer.isView(overlay.png)
    ) {
      throw new NativeExportPlanError('INVALID_OVERLAY', 'テキスト画像が不正です');
    }
    const bytes = Buffer.from(
      overlay.png.buffer,
      overlay.png.byteOffset,
      overlay.png.byteLength,
    );
    totalBytes += bytes.byteLength;
    const width = bytes.byteLength >= 24 ? bytes.readUInt32BE(16) : 0;
    const height = bytes.byteLength >= 24 ? bytes.readUInt32BE(20) : 0;
    const hasIhdr =
      bytes.byteLength >= 24 && bytes.subarray(12, 16).toString('ascii') === 'IHDR';
    totalDecodedBytes += width * height * 4;
    if (
      bytes.byteLength < pngHeader.length ||
      bytes.byteLength > MAX_NATIVE_OVERLAY_BYTES ||
      totalBytes > MAX_NATIVE_OVERLAY_TOTAL_BYTES ||
      !bytes.subarray(0, pngHeader.length).equals(pngHeader) ||
      !hasIhdr ||
      width < 1 ||
      height < 1 ||
      width > MAX_NATIVE_OVERLAY_DIMENSION ||
      height > MAX_NATIVE_OVERLAY_DIMENSION ||
      totalDecodedBytes > MAX_NATIVE_OVERLAY_DECODED_BYTES
    ) {
      throw new NativeExportPlanError('INVALID_OVERLAY', 'テキスト画像が大きすぎるか破損しています');
    }
    const filename = `overlay-${index}.png`;
    await fs.writeFile(path.join(entry.workDir, filename), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    result.set(overlay.clipId, path.join(entry.workDir, filename));
  }
  return result;
}

function redactNativeError(error, entry) {
  if (error instanceof NativeExportPlanError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const diagnostic = `${entry.stderrTail ?? ''}\n${
    error instanceof Error ? error.message : String(error)
  }`;
  if (/No space left on device|not enough space|ENOSPC/i.test(diagnostic)) {
    return {
      code: 'ENOSPC',
      message: '保存先の空き容量が不足したため、書き出しを中止しました',
    };
  }
  if (entry.cancelled) {
    return { code: 'CANCELLED', message: '書き出しを中止しました' };
  }
  if (/Permission denied|EACCES|EPERM/i.test(diagnostic)) {
    return {
      code: 'PERMISSION',
      message: '保存先へ書き込めません。保存先またはアクセス権を確認してください',
    };
  }
  let message = error instanceof Error ? error.message : 'ネイティブ書き出しに失敗しました';
  for (const source of registeredMedia.values()) {
    message = message.replaceAll(source.path, '[素材]');
  }
  message = message
    .replaceAll(entry.path, '[出力先]')
    .replaceAll(entry.temporaryPath, '[一時ファイル]')
    .slice(0, 800);
  return { code: 'NATIVE_FFMPEG_FAILED', message };
}

function waitForNativeChild(entry, child, totalDuration) {
  return new Promise((resolve, reject) => {
    let progressBuffer = '';
    let progressBlock = '';
    let closed = false;
    let lastDiskCheck = 0;
    const finish = (error, result) => {
      if (closed) return;
      closed = true;
      if (error) reject(error);
      else resolve(result);
    };
    child.stderr.on('data', (chunk) => {
      entry.stderrTail = appendTail(entry.stderrTail ?? '', chunk);
    });
    const progressStream = child.stdio[3];
    progressStream?.on('data', (chunk) => {
      progressBuffer += chunk.toString('utf8');
      if (progressBuffer.length > 1024 * 1024) {
        entry.runtimeError = new Error('FFmpegの進捗データが不正です');
        entry.cancelled = true;
        void terminateProcess(child).catch((error) => {
          entry.runtimeError = error;
        });
        return;
      }
      let newline;
      while ((newline = progressBuffer.indexOf('\n')) >= 0) {
        const line = progressBuffer.slice(0, newline).replace(/\r$/, '');
        progressBuffer = progressBuffer.slice(newline + 1);
        progressBlock += `${line}\n`;
        if (!line.startsWith('progress=')) continue;
        const parsed = parseProgressText(progressBlock, totalDuration, entry.progress ?? 0);
        progressBlock = '';
        entry.progress = parsed.overallProgress;
        if (
          Number.isSafeInteger(parsed.totalBytes) &&
          parsed.totalBytes > entry.maxBytes &&
          !entry.cancelled
        ) {
          entry.runtimeError = new Error('書き出しファイルが安全な上限を超えました');
          entry.cancelled = true;
          void terminateProcess(child).catch((error) => {
            entry.runtimeError = error;
          });
        }
        sendNativeExportEvent(entry.token, {
          phase: 'encoding',
          stage: parsed.speed
            ? `エンコード中（${parsed.speed.toFixed(2)}x）`
            : 'エンコード中',
          overallProgress: parsed.overallProgress,
          processedSeconds: parsed.processedSeconds,
          totalSeconds: totalDuration,
          speed: parsed.speed,
          etaSec: parsed.etaSec,
          fps: parsed.fps,
          totalBytes: parsed.totalBytes,
        });

        const now = Date.now();
        if (now - lastDiskCheck >= 5_000) {
          lastDiskCheck = now;
          void fs.statfs(path.dirname(entry.path)).then((stats) => {
            const freeBytes = Number(stats.bavail) * Number(stats.bsize);
            if (
              freeBytes < 64 * 1024 * 1024 &&
              !entry.cancelled &&
              entry.state === 'encoding' &&
              pendingExports.get(entry.token) === entry
            ) {
              entry.runtimeError = new Error('ENOSPC: 保存先の空き容量が不足しています');
              entry.cancelled = true;
              void terminateProcess(child).catch((error) => {
                entry.runtimeError = error;
              });
            }
          }).catch(() => {
            // FFmpeg's own write error remains the authoritative signal if a
            // removable/network destination disappears.
          });
        }
      }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => finish(null, { code, signal }));
  });
}

async function runNativeExport(token, entry, request) {
  let cleanupError = null;
  try {
    entry.backend = 'native-ffmpeg';
    entry.state = 'preflight';
    entry.token = token;
    sendNativeExportEvent(token, {
      phase: 'preflight',
      stage: '素材と書き出し設定を確認しています',
      overallProgress: 0,
    });
    await ensureNativeFfmpeg();
    if (entry.cancelled) throw new Error('書き出しが中止されました');

    const binaryPath = ffmpegBinaryPath();
    const sourceByAssetId = await leaseNativeSources(request, binaryPath, entry);
    if (entry.cancelled) throw new Error('書き出しが中止されました');

    await fs.mkdir(nativeWorkRoot(), { recursive: true, mode: 0o700 });
    entry.workDir = path.join(nativeWorkRoot(), token);
    await fs.mkdir(entry.workDir, { recursive: false, mode: 0o700 });
    await persistExportJournal();
    if (entry.cancelled) throw new Error('書き出しが中止されました');
    const overlayPathByClipId = await writeNativeOverlayFiles(request, entry);
    const plan = buildNativeExportPlan(
      request,
      sourceByAssetId,
      overlayPathByClipId,
      entry.temporaryPath,
    );
    await fs.writeFile(path.join(entry.workDir, 'filter-complex.txt'), plan.filterGraph, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (entry.cancelled) throw new Error('書き出しが中止されました');

    entry.state = 'encoding';
    entry.started = true;
    sendNativeExportEvent(token, {
      phase: 'preparing',
      stage: 'ネイティブFFmpegを起動しています',
      overallProgress: 0,
      totalSeconds: plan.totalDuration,
    });
    const child = spawn(binaryPath, plan.args, {
      shell: false,
      windowsHide: true,
      detached: false,
      cwd: entry.workDir,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      env: minimalEnvironment(),
    });
    entry.child = child;
    const result = await waitForNativeChild(entry, child, plan.totalDuration);
    entry.child = null;
    if (entry.runtimeError) throw entry.runtimeError;
    if (entry.cancelled) throw new Error('書き出しが中止されました');
    if (result.code !== 0) {
      throw new Error(`FFmpegが終了コード ${String(result.code)} で停止しました`);
    }

    entry.state = 'finalizing';
    entry.progress = 0.99;
    sendNativeExportEvent(token, {
      phase: 'finalizing',
      stage: '完成動画を検証しています',
      overallProgress: 0.99,
      totalSeconds: plan.totalDuration,
    });
    const validation = await validateOutput(binaryPath, entry.temporaryPath, {
      width: plan.width,
      height: plan.height,
      duration: plan.totalDuration,
      maxBytes: entry.maxBytes,
    });
    if (entry.cancelled) throw new Error('書き出しが中止されました');

    const outputHandle = await fs.open(entry.temporaryPath, 'r');
    try {
      await outputHandle.sync();
    } finally {
      await outputHandle.close();
    }
    if (entry.cancelled) throw new Error('書き出しが中止されました');
    entry.state = 'committing';
    await fs.rename(entry.temporaryPath, entry.path);
    entry.committed = true;
    entry.state = 'committed';
    lastExportPath = entry.path;
    await cleanupExportFiles(entry, false);
    releaseExportSourceLeases(entry);
    sendNativeExportEvent(token, {
      phase: 'done',
      stage: '書き出しが完了しました',
      overallProgress: 1,
      processedSeconds: plan.totalDuration,
      totalSeconds: plan.totalDuration,
      totalBytes: validation.size,
    });
    pendingExports.delete(token);
    await persistExportJournal();
    return {
      ok: true,
      complete: true,
      path: entry.path,
      size: validation.size,
      duration: validation.duration,
    };
  } catch (error) {
    try {
      await terminateProcess(entry.child);
      entry.child = null;
    } catch (terminationError) {
      cleanupError = terminationError;
    }
    if (!cleanupError && entry.committed) {
      // The output is already atomically committed. Preserve the entry and its
      // journal until an explicit cleanup retry removes the scratch directory.
      cleanupError = error;
      releaseExportSourceLeases(entry);
    } else if (!cleanupError) {
      try {
        await cleanupExportFiles(entry);
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
      releaseExportSourceLeases(entry);
    }
    const failure = redactNativeError(error, entry);
    sendNativeExportEvent(token, {
      phase: cleanupError ? 'cleanup-error' : entry.cancelled ? 'cancelled' : 'failed',
      stage: cleanupError ? '一時ファイルを削除できませんでした' : failure.message,
      overallProgress: entry.progress ?? 0,
      error: failure,
    });
    if (!cleanupError) {
      if (pendingExports.get(token) === entry) pendingExports.delete(token);
      await persistExportJournal();
    } else {
      entry.state = 'cleanup-error';
    }
    return {
      ok: false,
      canceled: entry.cancelled && !entry.runtimeError,
      cleanupPending: Boolean(cleanupError),
      error: cleanupError
        ? '作成途中のファイルを削除できませんでした'
        : failure.message,
      code: cleanupError ? 'CLEANUP_FAILED' : failure.code,
      details: failure.details,
    };
  }
}

ipcMain.handle('export:native-capabilities', async (event) => {
  if (!isTrustedIpcEvent(event)) return { available: false, error: 'untrusted sender' };
  try {
    await ensureNativeFfmpeg();
    return { available: true, backend: 'native-ffmpeg' };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('export:start-native', async (event, token, request) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  const entry = typeof token === 'string' ? pendingExports.get(token) : null;
  if (!entry || entry.backend !== null || entry.state !== 'reserved') {
    return { ok: false, error: '書き出しジョブが不正です' };
  }
  if (
    [...pendingExports.values()].some(
      (candidate) => candidate !== entry && candidate.backend === 'native-ffmpeg',
    )
  ) {
    return { ok: false, error: '別の動画を書き出しています' };
  }
  const operation = runNativeExport(token, entry, request);
  entry.operation = operation.then(() => undefined, () => undefined);
  return operation;
});

ipcMain.handle('export:choose-output', async (event, payload) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  const filename = safeExportFilename(payload?.suggestedName);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '動画の保存先',
    defaultPath: path.join(app.getPath('videos'), filename),
    filters: [{ name: 'MP4動画', extensions: ['mp4'] }],
  });
  if (result.canceled || !result.filePath) return { ok: true, canceled: true };
  const selectedTargetPath = result.filePath.toLowerCase().endsWith('.mp4')
    ? result.filePath
    : `${result.filePath}.mp4`;
  let reservedToken = null;
  try {
    // Freeze the dialog-selected directory to its canonical location. A
    // symlink/junction must not be repointed between selection and spawn.
    const targetDirectory = await fs.realpath(path.dirname(selectedTargetPath));
    const targetPath = path.join(targetDirectory, path.basename(selectedTargetPath));
    const stats = await fs.statfs(targetDirectory);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const estimatedBytes =
      Number.isSafeInteger(payload?.estimatedBytes) && payload.estimatedBytes > 0
        ? payload.estimatedBytes
        : 0;
    if (estimatedBytes > 0 && freeBytes < estimatedBytes + 256 * 1024 * 1024) {
      return {
        ok: false,
        error: '保存先の空き容量が不足しています。別のドライブを選択してください。',
        freeBytes,
      };
    }
    const token = crypto.randomUUID();
    reservedToken = token;
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${token}.part`,
    );
    pendingExports.set(token, {
      path: targetPath,
      temporaryPath,
      createdAt: new Date().toISOString(),
      handle: null,
      written: 0,
      started: false,
      headerBytes: Buffer.alloc(0),
      expectedBytes: null,
      cancelled: false,
      committed: false,
      backend: null,
      state: 'reserved',
      child: null,
      workDir: null,
      progress: 0,
      sourceLeases: [],
      eventSequence: 0,
      operation: Promise.resolve(),
      cleanupPromise: null,
      maxBytes: Math.min(
        MAX_EXPORT_FILE_BYTES,
        Math.max(512 * 1024 * 1024, estimatedBytes > 0 ? estimatedBytes * 4 : 0),
      ),
    });
    await persistExportJournal();
    return {
      ok: true,
      canceled: false,
      token,
      path: targetPath,
      freeBytes,
    };
  } catch (error) {
    if (reservedToken) {
      const entry = pendingExports.get(reservedToken);
      if (entry) {
        pendingExports.delete(reservedToken);
        await cleanupExportFiles(entry).catch(() => {});
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('export:set-size', async (event, token, totalBytes) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  const entry = typeof token === 'string' ? pendingExports.get(token) : null;
  if (!entry) return { ok: false, error: '書き出しファイルのサイズが不正です' };
  return queueExportOperation(entry, async () => {
    try {
      assertActiveExport(token, entry);
      if (
        (entry.backend !== null && entry.backend !== 'renderer-stream') ||
        entry.started ||
        entry.expectedBytes !== null ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes < 12 ||
        totalBytes > MAX_EXPORT_FILE_BYTES
      ) {
        throw new Error('書き出しファイルのサイズが不正です');
      }
      entry.backend = 'renderer-stream';
      entry.state = 'writing';
      const stats = await fs.statfs(path.dirname(entry.path));
      assertActiveExport(token, entry);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const safetyMargin = 256 * 1024 * 1024;
      if (freeBytes < totalBytes + safetyMargin) {
        throw new Error('保存先の空き容量が不足しています。別のドライブを選択してください。');
      }
      entry.expectedBytes = totalBytes;
      entry.maxBytes = totalBytes;
      return { ok: true, freeBytes };
    } catch (error) {
      await failExportEntry(token, entry);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
});

ipcMain.handle('export:write-chunk', async (event, token, offset, chunk, final) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  const entry = typeof token === 'string' ? pendingExports.get(token) : null;
  if (!entry) return { ok: false, error: '書き出しチャンクが不正です' };
  const byteLength = chunk?.byteLength;
  return queueExportOperation(entry, async () => {
    try {
      assertActiveExport(token, entry);
      if (
        entry.backend !== 'renderer-stream' ||
        entry.expectedBytes === null ||
        !Number.isSafeInteger(offset) ||
        offset !== entry.written ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0 ||
        byteLength > MAX_EXPORT_CHUNK_BYTES ||
        offset + byteLength > entry.maxBytes ||
        (byteLength === 0 && final !== true)
      ) {
        throw new Error('書き出しチャンクが不正です');
      }
      if (!entry.handle) {
        const openedHandle = await fs.open(entry.temporaryPath, 'wx');
        if (entry.cancelled || pendingExports.get(token) !== entry) {
          await openedHandle.close().catch(() => {});
          await fs.rm(entry.temporaryPath, { force: true }).catch(() => {});
          throw new Error('書き出しが中止されました');
        }
        entry.handle = openedHandle;
        entry.started = true;
      }
      if (byteLength > 0) {
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, byteLength);
        if (entry.headerBytes.length < 12) {
          entry.headerBytes = Buffer.concat([
            entry.headerBytes,
            buffer.subarray(0, 12 - entry.headerBytes.length),
          ]);
        }
        const { bytesWritten } = await entry.handle.write(buffer, 0, byteLength, offset);
        assertActiveExport(token, entry);
        if (bytesWritten !== byteLength) {
          throw new Error('ファイルへの書き込みが途中で停止しました');
        }
        entry.written += bytesWritten;
      }
      if (final === true) {
        if (
          entry.written !== entry.expectedBytes ||
          entry.written < 12 ||
          entry.headerBytes.length < 12 ||
          entry.headerBytes.toString('ascii', 4, 8) !== 'ftyp'
        ) {
          throw new Error('書き出されたファイルが有効なMP4ではありません');
        }
        await entry.handle.sync();
        assertActiveExport(token, entry);
        await entry.handle.close();
        entry.handle = null;
        assertActiveExport(token, entry);
        // Keep an existing export intact until every byte of the new one has
        // landed and been fsynced. rename replaces it only at successful commit.
        await fs.rename(entry.temporaryPath, entry.path);
        entry.committed = true;
        entry.state = 'committed';
        pendingExports.delete(token);
        await persistExportJournal();
        lastExportPath = entry.path;
        return { ok: true, complete: true, path: entry.path, bytesWritten: entry.written };
      }
      return { ok: true, complete: false, bytesWritten: entry.written };
    } catch (error) {
      await failExportEntry(token, entry);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
});

ipcMain.handle('export:abandon', async (event, token) => {
  if (!isTrustedIpcEvent(event) || typeof token !== 'string') return false;
  return abandonExport(token);
});

ipcMain.handle('export:open-file', async (event) => {
  if (!isTrustedIpcEvent(event) || !lastExportPath) return false;
  return (await shell.openPath(lastExportPath)) === '';
});

ipcMain.handle('export:show-in-folder', (event) => {
  if (!isTrustedIpcEvent(event) || !lastExportPath) return false;
  shell.showItemInFolder(lastExportPath);
  return true;
});

// Saved projects keep the original media path so they can be re-linked without
// loading the whole recording into renderer memory. The renderer receives only
// an opaque token + streaming custom-protocol URL. Full bytes are read in
// bounded chunks only when an explicit operation (export/beat detection) needs
// them.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const registeredMedia = new Map();
const authorizedMediaRefs = new Map();
const MAX_MEDIA_CHUNK_BYTES = 8 * 1024 * 1024;

function mediaApprovalKey(filePath, name, size) {
  const normalized = path.resolve(filePath);
  const platformPath = process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
  return `${platformPath}\u0000${name}\u0000${size}`;
}

function authorizeMediaRef(ref) {
  if (
    !ref ||
    typeof ref.path !== 'string' ||
    !path.isAbsolute(ref.path) ||
    typeof ref.name !== 'string' ||
    ref.name.length === 0 ||
    ref.name.length > 1_024 ||
    typeof ref.size !== 'number' ||
    !Number.isSafeInteger(ref.size) ||
    ref.size < 0 ||
    path.basename(ref.path).toLowerCase() !== ref.name.toLowerCase()
  ) {
    return false;
  }
  const ext = path.extname(ref.path).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext) && !AUDIO_EXTENSIONS.has(ext)) return false;
  for (const [key, approval] of authorizedMediaRefs) {
    if (approval.sessionId !== documentSessionId) authorizedMediaRefs.delete(key);
  }
  const key = mediaApprovalKey(ref.path, ref.name, ref.size);
  if (!authorizedMediaRefs.has(key) && authorizedMediaRefs.size >= 4_096) return false;
  authorizedMediaRefs.set(key, {
    sessionId: documentSessionId,
  });
  return true;
}

function authorizeProjectMediaRefs(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.assets) || parsed.assets.length > 2_000) return;
    for (const asset of parsed.assets) {
      authorizeMediaRef(asset);
    }
  } catch {
    // Renderer validation remains authoritative for project structure.
  }
}

ipcMain.on('media:authorize-file-sync', (event, ref) => {
  event.returnValue = false;
  if (!isTrustedIpcEvent(event) || !authorizeMediaRef(ref)) return;
  try {
    const stat = fsStream.statSync(ref.path);
    if (!stat.isFile() || stat.size !== ref.size) {
      authorizedMediaRefs.delete(mediaApprovalKey(ref.path, ref.name, ref.size));
      return;
    }
    event.returnValue = true;
  } catch {
    authorizedMediaRefs.delete(mediaApprovalKey(ref.path, ref.name, ref.size));
  }
});

function mediaExtensionMatchesKind(filePath, kind) {
  const ext = path.extname(filePath).toLowerCase();
  return kind === 'video' ? VIDEO_EXTENSIONS.has(ext) : AUDIO_EXTENSIONS.has(ext);
}

ipcMain.handle('media:register-file', async (event, ref) => {
  if (!isTrustedIpcEvent(event)) return null;
  if (
    typeof ref !== 'object' ||
    ref === null ||
    typeof ref.path !== 'string' ||
    typeof ref.name !== 'string' ||
    typeof ref.size !== 'number' ||
    !Number.isSafeInteger(ref.size) ||
    ref.size < 0 ||
    (ref.kind !== 'video' && ref.kind !== 'audio') ||
    !mediaExtensionMatchesKind(ref.path, ref.kind) ||
    path.basename(ref.path).toLowerCase() !== ref.name.toLowerCase()
  ) {
    return null;
  }
  const approvalKey = mediaApprovalKey(ref.path, ref.name, ref.size);
  const approval = authorizedMediaRefs.get(approvalKey);
  if (
    !approval ||
    approval.sessionId !== documentSessionId
  ) {
    authorizedMediaRefs.delete(approvalKey);
    return null;
  }
  try {
    if (isDangerousWindowsDevicePath(ref.path)) return null;
    const realPath = await fs.realpath(ref.path);
    if (isDangerousWindowsDevicePath(realPath)) return null;
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || stat.size !== ref.size) return null;
    const token = crypto.randomUUID();
    registeredMedia.set(token, {
      path: realPath,
      size: stat.size,
      kind: ref.kind,
      name: ref.name,
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      leases: 0,
      releaseRequested: false,
    });
    return {
      token,
      url: `fce-media://asset/${token}`,
      size: stat.size,
    };
  } catch {
    return null;
  }
});

ipcMain.handle('media:read-chunk', async (event, token, offset, length) => {
  if (!isTrustedIpcEvent(event)) return null;
  const source = typeof token === 'string' ? registeredMedia.get(token) : null;
  if (
    !source ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    length > MAX_MEDIA_CHUNK_BYTES ||
    offset >= source.size
  ) {
    return null;
  }

  const bytesToRead = Math.min(length, source.size - offset);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let handle;
  try {
    handle = await fs.open(source.path, 'r');
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
});

ipcMain.handle('media:release-file', (event, token) => {
  if (!isTrustedIpcEvent(event) || typeof token !== 'string') return false;
  const source = registeredMedia.get(token);
  if (!source) return false;
  if ((source.leases ?? 0) > 0) {
    source.releaseRequested = true;
    return true;
  }
  return registeredMedia.delete(token);
});

function proxyCacheRoot() {
  return path.join(app.getPath('userData'), 'preview-proxies-v1');
}

const MAX_PROXY_CACHE_BYTES = 20 * 1024 * 1024 * 1024;

async function pruneProxyCache() {
  const root = path.resolve(proxyCacheRoot());
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const activePaths = new Set(
    [...registeredMedia.values()]
      .map((source) => path.resolve(source.path))
      .filter((sourcePath) => path.dirname(sourcePath) === root),
  );
  const cached = (
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && /^[0-9a-f]{64}\.mp4$/i.test(entry.name),
        )
        .map(async (entry) => {
          const filePath = path.join(root, entry.name);
          try {
            const stat = await fs.lstat(filePath);
            if (!stat.isFile() || stat.isSymbolicLink()) return null;
            return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        }),
    )
  ).filter(Boolean);
  let totalBytes = cached.reduce((total, entry) => total + entry.size, 0);
  cached.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of cached) {
    if (totalBytes <= MAX_PROXY_CACHE_BYTES) break;
    if (activePaths.has(path.resolve(entry.filePath))) continue;
    try {
      await fs.rm(entry.filePath, { force: true });
      totalBytes -= entry.size;
    } catch {
      // A cache file held by antivirus or another process can be retried on
      // the next startup/import. It must never prevent the project from opening.
    }
  }
}

async function cleanupOrphanedProxies() {
  const root = proxyCacheRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^[0-9a-f]{64}\.[0-9a-f-]{36}\.part$/i.test(entry.name),
      )
      .map((entry) => fs.rm(path.join(root, entry.name), { force: true }).catch(() => {})),
  );
  await pruneProxyCache();
}

async function registerProxyFile(proxyPath) {
  const [realPath, stat] = await Promise.all([
    fs.realpath(proxyPath),
    fs.lstat(proxyPath),
  ]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 12) {
    throw new Error('プレビュー用動画が破損しています');
  }
  const handle = await fs.open(realPath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 12 || header.toString('ascii', 4, 8) !== 'ftyp') {
      throw new Error('プレビュー用動画が有効なMP4ではありません');
    }
  } finally {
    await handle.close();
  }
  const token = crypto.randomUUID();
  registeredMedia.set(token, {
    path: realPath,
    size: stat.size,
    kind: 'video',
    name: path.basename(realPath),
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    leases: 0,
    releaseRequested: false,
  });
  return {
    token,
    url: `fce-media://asset/${token}`,
    size: stat.size,
  };
}

function waitForProxyChild(job) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    job.child.stderr.on('data', (chunk) => {
      job.stderrTail = appendTail(job.stderrTail, chunk);
    });
    job.child.once('error', (error) => finish(error));
    job.child.once('close', (code, signal) => finish(null, { code, signal }));
  });
}

async function abandonProxyJob(token) {
  const job = pendingProxyJobs.get(token);
  if (!job) return false;
  if (job.cleanupPromise) return job.cleanupPromise;
  job.cancelled = true;
  const cleanupPromise = (async () => {
    await terminateProcess(job.child);
    job.child = null;
    await job.operation.catch(() => {});
    await fs.rm(job.temporaryPath, { force: true });
    if (!job.sourceLeaseReleased) {
      job.sourceLeaseReleased = true;
      releaseRegisteredMediaLease(job.sourceToken);
    }
    if (pendingProxyJobs.get(token) === job) pendingProxyJobs.delete(token);
    return true;
  })();
  job.cleanupPromise = cleanupPromise;
  try {
    return await cleanupPromise;
  } catch (error) {
    if (job.cleanupPromise === cleanupPromise) job.cleanupPromise = null;
    throw error;
  }
}

ipcMain.handle('media:create-preview-proxy', async (event, sourceToken) => {
  if (!isTrustedIpcEvent(event) || typeof sourceToken !== 'string') {
    return { ok: false, error: 'untrusted sender' };
  }
  const source = registeredMedia.get(sourceToken);
  if (!source || source.kind !== 'video') {
    return { ok: false, error: '元素材を確認できません' };
  }
  let job = null;
  try {
    await ensureNativeFfmpeg();
    const [realPath, stat] = await Promise.all([
      fs.realpath(source.path),
      fs.stat(source.path),
    ]);
    if (
      !stat.isFile() ||
      realPath !== source.path ||
      stat.size !== source.size ||
      (source.dev !== undefined && stat.dev !== source.dev) ||
      (source.ino !== undefined && source.ino !== 0 && stat.ino !== source.ino) ||
      Math.abs(stat.mtimeMs - source.mtimeMs) > 1 ||
      isDangerousWindowsDevicePath(realPath)
    ) {
      throw new Error('元素材が読み込み後に変更されました');
    }
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${realPath}\0${stat.size}\0${stat.mtimeMs}\0proxy-v1-1280-crf27`)
      .digest('hex');
    const root = proxyCacheRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const proxyPath = path.join(root, `${fingerprint}.mp4`);
    try {
      await fs.utimes(proxyPath, new Date(), new Date()).catch(() => {});
      const registered = await registerProxyFile(proxyPath);
      await pruneProxyCache();
      return { ok: true, ...registered, cached: true };
    } catch {
      await fs.rm(proxyPath, { force: true }).catch(() => {});
    }

    const token = crypto.randomUUID();
    const temporaryPath = path.join(root, `${fingerprint}.${token}.part`);
    source.leases = (source.leases ?? 0) + 1;
    job = {
      token,
      sourceToken,
      child: null,
      operation: Promise.resolve(),
      cleanupPromise: null,
      cancelled: false,
      sourceLeaseReleased: false,
      temporaryPath,
      stderrTail: '',
    };
    pendingProxyJobs.set(token, job);
    const binaryPath = ffmpegBinaryPath();
    const child = spawn(
      binaryPath,
      [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-loglevel',
        'warning',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        source.path,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        "scale='min(1280,iw)':-2",
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '27',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-n',
        '-f',
        'mp4',
        temporaryPath,
      ],
      {
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: minimalEnvironment(),
      },
    );
    job.child = child;
    const operation = waitForProxyChild(job);
    job.operation = operation.then(() => undefined, () => undefined);
    const result = await operation;
    job.child = null;
    if (job.cancelled) throw new Error('プレビュー変換を中止しました');
    if (result.code !== 0) {
      throw new Error(`プレビュー変換に失敗しました (FFmpeg: ${String(result.code)})`);
    }
    const handle = await fs.open(temporaryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, proxyPath);
    const registered = await registerProxyFile(proxyPath);
    pendingProxyJobs.delete(token);
    if (!job.sourceLeaseReleased) {
      job.sourceLeaseReleased = true;
      releaseRegisteredMediaLease(sourceToken);
    }
    await pruneProxyCache();
    return { ok: true, ...registered, cached: false };
  } catch (error) {
    let cleanupError = null;
    if (job) {
      try {
        await abandonProxyJob(job.token);
      } catch (failure) {
        cleanupError = failure;
      }
    }
    let message = error instanceof Error ? error.message : String(error);
    if (cleanupError) {
      message = 'プレビュー変換プロセスまたは一時ファイルを安全に片付けられませんでした';
    }
    message = message.replaceAll(source.path, '[素材]').slice(0, 500);
    return { ok: false, error: message };
  }
});

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

ipcMain.handle('updater:install-and-restart', (event) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  autoUpdater.quitAndInstall();
  return { ok: true };
});
// Download is gated behind an explicit user action in the renderer
// (UpdateBanner) — never triggered automatically — because unsigned artifacts
// offer no publisher verification.
ipcMain.handle('updater:download', async (event) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  if (isDev) return { skipped: true, reason: 'dev mode' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});
ipcMain.handle('updater:check', async (event) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
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
  "media-src 'self' blob: fce-media:",
  "connect-src 'self' blob: data: fce-media:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const STATIC_MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function writeStaticError(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Content-Security-Policy': PROD_CSP,
  });
  response.end(message);
}

async function serveAppAsset(request, response, token, expectedHost) {
  if (request.headers.host !== expectedHost) {
    writeStaticError(response, 400, 'Invalid host');
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeStaticError(response, 405, 'Method not allowed');
    return;
  }

  let relativePath;
  try {
    const parsed = new URL(request.url, `http://${expectedHost}`);
    const prefix = `/${token}/`;
    if (!parsed.pathname.startsWith(prefix)) {
      writeStaticError(response, 404, 'Not found');
      return;
    }
    const decodedPath = decodeURIComponent(parsed.pathname.slice(prefix.length));
    if (decodedPath.includes('\\') || decodedPath.includes('\0')) {
      writeStaticError(response, 400, 'Invalid path');
      return;
    }
    relativePath = decodedPath || 'index.html';
  } catch {
    writeStaticError(response, 400, 'Invalid URL');
    return;
  }

  const targetPath = path.resolve(DIST_DIR, relativePath);
  const distPrefix = `${path.resolve(DIST_DIR)}${path.sep}`;
  if (!targetPath.startsWith(distPrefix)) {
    writeStaticError(response, 404, 'Not found');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch {
    writeStaticError(response, 404, 'Not found');
    return;
  }
  if (!stat.isFile()) {
    writeStaticError(response, 404, 'Not found');
    return;
  }

  let statusCode = 200;
  let start = 0;
  let end = Math.max(0, stat.size - 1);
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (match[1] === '' && match[2] === '')) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      response.end();
      return;
    }
    if (match[1] === '') {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        response.end();
        return;
      }
      start = Math.max(0, stat.size - suffixLength);
    } else {
      start = Number(match[1]);
      if (match[2] !== '') end = Number(match[2]);
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= stat.size ||
      end < start
    ) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      response.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    statusCode = 206;
  }

  const headers = {
    'Content-Type':
      STATIC_MIME_TYPES.get(path.extname(targetPath).toLowerCase()) ??
      'application/octet-stream',
    'Content-Length': String(stat.size === 0 ? 0 : end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': PROD_CSP,
    ...(statusCode === 206
      ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` }
      : null),
  };
  response.writeHead(statusCode, headers);
  if (request.method === 'HEAD' || stat.size === 0) {
    response.end();
    return;
  }
  const stream = fsStream.createReadStream(targetPath, { start, end });
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

async function startAppServer() {
  const token = crypto.randomBytes(24).toString('hex');
  appServer = http.createServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    appServer.once('error', onError);
    appServer.listen(0, '127.0.0.1', () => {
      appServer.off('error', onError);
      resolve();
    });
  });
  const address = appServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine local app server address');
  }
  const host = `127.0.0.1:${address.port}`;
  appServer.on('request', (request, response) => {
    void serveAppAsset(request, response, token, host);
  });
  prodEntryUrl = `http://${host}/${token}/index.html`;
}

// Inject COOP/COEP headers on every response so SharedArrayBuffer is
// available — required by the multi-threaded ffmpeg.wasm build that
// powers our export pipeline. Without these headers Chromium refuses
// to instantiate SAB and the export falls back to single-thread (~3x
// slower). In production we also attach the CSP above.
let crossOriginIsolationEnabled = false;

function enableCrossOriginIsolation() {
  if (crossOriginIsolationEnabled) return;
  crossOriginIsolationEnabled = true;
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

async function createWindow() {
  enableCrossOriginIsolation();
  autosaveWritesBlocked = false;
  // A BrowserWindow is a fresh renderer document. Never let it inherit the
  // previous renderer's save-path authority (macOS close→activate included).
  resetDocumentSession();
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 980,
    minHeight: 640,
    title: 'Byux',
    // Explicit so the title bar / taskbar icon is correct in both `electron .`
    // dev runs and packaged builds, instead of relying on the exe resource.
    // `build/` is only used by electron-builder itself and is NOT bundled
    // into the packaged app (see `files` in package.json) — `dist/icon.png`
    // (copied from public/ by Vite) is what actually ships, so packaged
    // builds must read from there instead.
    icon: path.join(__dirname, '..', isDev ? 'build/icon.png' : 'dist/icon.png'),
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
    if (url.startsWith('https://')) {
      void shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // Block the main window from navigating away from the exact application
  // entry point. Every top-level navigation receives this window's preload
  // and therefore its IPC API, so sharing the origin alone is not sufficient.
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) event.preventDefault();
  });

  // Reload/crash creates a new renderer document with empty in-memory state.
  // Revoke the old document's implicit save target before it can Ctrl+S over
  // the project that was open before the reload.
  mainWindow.webContents.on(
    'did-start-navigation',
    (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      cancelPendingCloseSaveRequest();
      resetDocumentSession();
      void abandonAllExports().catch((error) => {
        console.error('[main] export cleanup after navigation failed', error);
      });
    },
  );
  mainWindow.webContents.on('render-process-gone', () => {
    cancelPendingCloseSaveRequest();
    resetDocumentSession();
    void abandonAllExports().catch((error) => {
      console.error('[main] export cleanup after renderer crash failed', error);
    });
  });
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      if (key === 'f5' || ((input.control || input.meta) && key === 'r')) {
        event.preventDefault();
      }
    });
  }

  if (isDev) {
    await mainWindow.loadURL(VITE_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadURL(prodEntryUrl);
  }

  // Warn before discarding unsaved edits. `isDirty` is pushed from the
  // renderer (see preload.cjs `setDirty` / App.tsx) whenever the zundo
  // undo-history depth diverges from the last save/load point.
  mainWindow.on('close', (event) => {
    if (
      pendingExports.size === 0 &&
      pendingProxyJobs.size === 0 &&
      !isDirty &&
      activeProjectSaves === 0 &&
      !pendingCloseSaveRequest &&
      !autosaveCleanupRequired
    ) {
      return;
    }
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    void confirmDiscardBeforeClose()
      .then((confirmed) => {
        closePromptOpen = false;
        if (!confirmed) return;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      })
      .catch((error) => {
        closePromptOpen = false;
        void showCloseCleanupError(error);
      });
  });

  mainWindow.on('closed', () => {
    cancelPendingCloseSaveRequest();
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (
    (pendingExports.size > 0 ||
      pendingProxyJobs.size > 0 ||
      isDirty ||
      activeProjectSaves > 0 ||
      pendingCloseSaveRequest ||
      autosaveCleanupRequired) &&
    !allowQuitAfterDiscard
  ) {
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    void confirmDiscardBeforeClose()
      .then((confirmed) => {
        closePromptOpen = false;
        if (!confirmed) return;
        allowQuitAfterDiscard = true;
        app.quit();
      })
      .catch((error) => {
        closePromptOpen = false;
        void showCloseCleanupError(error);
      });
    return;
  }
  appServer?.close();
  appServer = null;
});

app.whenReady().then(async () => {
  await cleanupOrphanedExports();
  await cleanupOrphanedProxies();
  if (!isDev) await startAppServer();
  if (!isDev) Menu.setApplicationMenu(null);
  // This editor does not need camera, microphone, geolocation, notifications,
  // USB, etc. Electron otherwise approves some permission requests by default.
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  protocol.handle('fce-media', async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const parsed = new URL(request.url);
    const token = parsed.host === 'asset' ? parsed.pathname.slice(1) : '';
    const source = registeredMedia.get(token);
    if (!source) return new Response('Not found', { status: 404 });
    try {
      const sourceResponse = await net.fetch(pathToFileURL(source.path).href, {
        method: request.method,
        headers: request.headers,
      });
      const headers = new Headers(sourceResponse.headers);
      // file:// and fce-media:// have different origins. Explicit CORS/CORP
      // headers keep recovered videos usable by <video crossorigin> and by
      // the motion-blur canvas under COEP=require-corp.
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(sourceResponse.body, {
        status: sourceResponse.status,
        statusText: sourceResponse.statusText,
        headers,
      });
    } catch {
      return new Response('Unable to read media', { status: 500 });
    }
  });
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((error) => {
        console.error('[main] failed to recreate window', error);
        dialog.showErrorBox('Byuxを起動できません', 'アプリ画面の再作成に失敗しました。');
      });
    }
  });
}).catch((error) => {
  console.error('[main] startup failed', error);
  dialog.showErrorBox(
    'Byuxを起動できません',
    '必要なファイルを読み込めませんでした。再インストールしてもう一度お試しください。',
  );
  app.quit();
});

let fatalExceptionHandled = false;
process.on('exit', () => {
  // Best-effort synchronous signal for fatal/forced main-process exits. Durable
  // cleanup is still guaranteed by the exact-path journal on the next launch.
  for (const entry of pendingExports.values()) {
    try { entry.child?.kill('SIGKILL'); } catch { /* process already gone */ }
  }
  for (const job of pendingProxyJobs.values()) {
    try { job.child?.kill('SIGKILL'); } catch { /* process already gone */ }
  }
});
process.on('uncaughtException', (err) => {
  if (fatalExceptionHandled) {
    app.exit(1);
    return;
  }
  fatalExceptionHandled = true;
  console.error('[main] uncaught', err);
  if (!isDev) {
    // Generic user-facing text — don't surface internal paths / stack details
    // in the dialog (they go to the console log instead).
    dialog.showErrorBox(
      '予期しないエラー',
      'アプリケーションで予期しないエラーが発生しました。お手数ですが再起動してください。',
    );
  }
  // Continuing after an uncaught exception risks writing with corrupted
  // in-memory authority/state. Recovery data already on disk is kept intact.
  app.exit(1);
});
