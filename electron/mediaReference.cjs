'use strict';

const path = require('node:path');

/**
 * Some Windows drag sources expose File.name as the full local path instead of
 * a basename. The path obtained through Electron's webUtils remains the
 * authority; derive the display name from that path instead of trusting the
 * renderer-provided label.
 */
function canonicalMediaName(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const pathApi = path.win32.isAbsolute(filePath) ? path.win32 : path;
  if (!pathApi.isAbsolute(filePath)) return null;
  const name = pathApi.basename(pathApi.normalize(filePath));
  if (!name || name === '.' || name.length > 1_024) return null;
  return name;
}

/**
 * Revoke media registrations owned by a renderer document. Active native jobs
 * keep their leased source until they settle; idle registrations can be
 * removed immediately. This prevents renderer reloads/crashes from leaking
 * opaque registrations or pinning preview-proxy files forever.
 */
function revokeMediaRegistrations(registry) {
  let removed = 0;
  let deferred = 0;
  for (const [token, source] of registry) {
    if ((source?.leases ?? 0) > 0) {
      source.releaseRequested = true;
      deferred += 1;
    } else {
      registry.delete(token);
      removed += 1;
    }
  }
  return { removed, deferred };
}

module.exports = { canonicalMediaName, revokeMediaRegistrations };
