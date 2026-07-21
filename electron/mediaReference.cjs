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

module.exports = { canonicalMediaName };
