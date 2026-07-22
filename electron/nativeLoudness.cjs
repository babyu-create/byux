'use strict';

const MAX_LOUDNESS_LOG_BYTES = 512 * 1024;

function buildLoudnessFfmpegArgs(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error('A source path is required');
  }
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'info',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    sourcePath,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-af',
    'ebur128=peak=true:framelog=quiet',
    '-f',
    'null',
    '-',
  ];
}

function finiteMatch(text, pattern) {
  const matches = [...String(text).matchAll(pattern)];
  const value = Number(matches.at(-1)?.[1]);
  return Number.isFinite(value) ? value : null;
}

function parseLoudnessSummary(stderr) {
  const text = String(stderr);
  const summaryIndex = text.lastIndexOf('Summary:');
  const summary = summaryIndex >= 0 ? text.slice(summaryIndex) : text;
  const integratedLufs = finiteMatch(summary, /\bI:\s*(-?\d+(?:\.\d+)?)\s+LUFS\b/g);
  const loudnessRange = finiteMatch(summary, /\bLRA:\s*(\d+(?:\.\d+)?)\s+LU\b/g);
  const truePeakDbfs = finiteMatch(summary, /\bPeak:\s*(-?\d+(?:\.\d+)?)\s+dBFS\b/g);
  if (integratedLufs === null || truePeakDbfs === null) return null;
  return {
    integratedLufs,
    loudnessRange: loudnessRange ?? 0,
    truePeakDbfs,
  };
}

module.exports = {
  MAX_LOUDNESS_LOG_BYTES,
  buildLoudnessFfmpegArgs,
  parseLoudnessSummary,
};
