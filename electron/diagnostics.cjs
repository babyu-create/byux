'use strict';

function sanitizeDiagnosticText(value) {
  return String(value ?? '')
    .replace(/fce-media:\/\/asset\/[A-Za-z0-9_-]+/g, 'fce-media://asset/[token]')
    .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '[path]')
    .replace(/\/(?:Users|home|tmp|var\/folders)\/[^\s\r\n]+/g, '[path]')
    .slice(0, 2_000);
}

function boundedProjectSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['tracks', 'clips', 'assets', 'subtitles']) {
    const number = Number(value[key]);
    if (Number.isSafeInteger(number) && number >= 0 && number <= 100_000) result[key] = number;
  }
  const duration = Number(value.durationSeconds);
  if (Number.isFinite(duration) && duration >= 0 && duration <= 7 * 24 * 60 * 60) {
    result.durationSeconds = Math.round(duration * 1000) / 1000;
  }
  return result;
}

function boundedCrashSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['at', 'type', 'message', 'appVersion', 'platform', 'arch']) {
    if (typeof value[key] === 'string') result[key] = sanitizeDiagnosticText(value[key]).slice(0, 500);
  }
  return result;
}

module.exports = { sanitizeDiagnosticText, boundedProjectSummary, boundedCrashSummary };
