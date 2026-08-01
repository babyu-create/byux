'use strict';

function canonicalProject(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    delete parsed.createdAt;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/**
 * Autosave stores the project JSON as a JSON string inside an envelope. In the
 * worst case every byte can be escaped, plus a small amount of metadata.
 */
function maxAutosaveEnvelopeBytes(maxProjectTextBytes) {
  return maxProjectTextBytes * 2 + 64 * 1024;
}

function projectWriteError(error, fallback = 'プロジェクトを保存できませんでした') {
  switch (error?.code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return '保存先の空き容量が不足しています。空き容量を確保してから再試行してください';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return '保存先に書き込めません。別のフォルダーを選択するか、アクセス権を確認してください';
    case 'ENAMETOOLONG':
      return '保存先のパスまたはファイル名が長すぎます。短い名前で再試行してください';
    default:
      return fallback;
  }
}

/**
 * Clear the recovery captured at save start, or an equivalent autosave that
 * finished while the explicit save was in flight. A newer, different
 * generation must remain available after a crash.
 */
function shouldClearRecovery(recovery, savedText, autosaveGeneration) {
  if (!recovery || recovery.version !== 1 || typeof recovery.text !== 'string') {
    return false;
  }
  if (
    typeof autosaveGeneration === 'string' &&
    recovery.generation === autosaveGeneration
  ) {
    return true;
  }
  const recoveryProject = canonicalProject(recovery.text);
  const savedProject = canonicalProject(savedText);
  return recoveryProject !== null && recoveryProject === savedProject;
}

module.exports = {
  canonicalProject,
  maxAutosaveEnvelopeBytes,
  projectWriteError,
  shouldClearRecovery,
};
