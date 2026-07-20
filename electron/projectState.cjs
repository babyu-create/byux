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

module.exports = { canonicalProject, shouldClearRecovery };
