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
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const { shouldClearRecovery } = require('./projectState.cjs');

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
const pendingExports = new Map();
let lastExportPath = null;

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
  if (cleanupError) throw cleanupError;
}

async function abandonExport(token, removePartial = true) {
  const entry = pendingExports.get(token);
  if (!entry) return false;
  if (entry.cleanupPromise) return entry.cleanupPromise;
  entry.cancelled = true;
  const cleanupPromise = (async () => {
    // Keep the entry in pendingExports until its queued disk operation and
    // cleanup have really completed. A second close request must not be able
    // to terminate the process while a large partial file is still open.
    await entry.operation.catch(() => {});
    await cleanupExportFiles(entry, removePartial);
    if (pendingExports.get(token) === entry) pendingExports.delete(token);
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
    entry.cleanupPromise = null;
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
  return Promise.all(
    [...pendingExports.keys()].map((token) => abandonExport(token)),
  );
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
  const hasExport = pendingExports.size > 0;
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

ipcMain.handle('export:choose-output', async (event, payload) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: 'untrusted sender' };
  const filename = safeExportFilename(payload?.suggestedName);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '動画の保存先',
    defaultPath: path.join(app.getPath('videos'), filename),
    filters: [{ name: 'MP4動画', extensions: ['mp4'] }],
  });
  if (result.canceled || !result.filePath) return { ok: true, canceled: true };
  const targetPath = result.filePath.toLowerCase().endsWith('.mp4')
    ? result.filePath
    : `${result.filePath}.mp4`;
  try {
    const stats = await fs.statfs(path.dirname(targetPath));
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
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${token}.part`,
    );
    pendingExports.set(token, {
      path: targetPath,
      temporaryPath,
      handle: null,
      written: 0,
      started: false,
      headerBytes: Buffer.alloc(0),
      expectedBytes: null,
      cancelled: false,
      committed: false,
      operation: Promise.resolve(),
      cleanupPromise: null,
      maxBytes: Math.min(
        MAX_EXPORT_FILE_BYTES,
        Math.max(512 * 1024 * 1024, estimatedBytes > 0 ? estimatedBytes * 4 : 0),
      ),
    });
    return {
      ok: true,
      canceled: false,
      token,
      path: targetPath,
      freeBytes,
    };
  } catch (error) {
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
        entry.started ||
        entry.expectedBytes !== null ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes < 12 ||
        totalBytes > MAX_EXPORT_FILE_BYTES
      ) {
        throw new Error('書き出しファイルのサイズが不正です');
      }
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
        pendingExports.delete(token);
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
const MAX_MEDIA_CHUNK_BYTES = 8 * 1024 * 1024;

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
  try {
    const stat = await fs.stat(ref.path);
    if (!stat.isFile() || stat.size !== ref.size) return null;
    const token = crypto.randomUUID();
    registeredMedia.set(token, { path: ref.path, size: stat.size });
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
  return registeredMedia.delete(token);
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
