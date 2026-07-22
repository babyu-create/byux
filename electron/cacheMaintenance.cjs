'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function stablePattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

/**
 * Remove only regular cache files whose basename matches the owned format.
 * Paths in `protectedPaths` stay available to the active editor session.
 */
async function clearOwnedCacheFiles(root, pattern, protectedPaths = []) {
  const absoluteRoot = path.resolve(root);
  const protectedSet = new Set(protectedPaths.map((entry) => path.resolve(entry)));
  const ownedName = stablePattern(pattern);
  let entries;
  try {
    entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { files: 0, bytes: 0, protectedFiles: 0 };
    throw error;
  }

  let files = 0;
  let bytes = 0;
  let protectedFiles = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !ownedName.test(entry.name)) continue;
    const candidate = path.resolve(absoluteRoot, entry.name);
    if (path.dirname(candidate) !== absoluteRoot) continue;
    if (protectedSet.has(candidate)) {
      protectedFiles += 1;
      continue;
    }
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await fs.rm(candidate, { force: true });
      files += 1;
      bytes += stat.size;
    } catch (error) {
      // A concurrently pruned file is already in the desired state. Files
      // temporarily held by antivirus remain visible and can be retried.
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { files, bytes, protectedFiles };
}

module.exports = { clearOwnedCacheFiles };
