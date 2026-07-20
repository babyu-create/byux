'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');

const MAX_CAPTURE_BYTES = 256 * 1024;

function resolveFfmpegBinary(isPackaged, resourcesPath, appRoot) {
  if (isPackaged) {
    return path.join(
      resourcesPath,
      'ffmpeg',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    );
  }
  const packageRoot = path.join(appRoot, 'node_modules', 'ffmpeg-static');
  return path.join(packageRoot, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

function minimalEnvironment() {
  const keys = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME'];
  const env = { LANG: 'C', LC_ALL: 'C' };
  for (const key of keys) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

function appendTail(current, chunk, maxBytes = MAX_CAPTURE_BYTES) {
  const next = Buffer.from(current + chunk.toString('utf8'), 'utf8');
  if (next.byteLength <= maxBytes) return next.toString('utf8');
  return next.subarray(next.byteLength - maxBytes).toString('utf8');
}

function runCaptured(binaryPath, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout = null;
    let timeoutError = null;
    const child = spawn(binaryPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: minimalEnvironment(),
    });
    if (typeof options.onSpawn === 'function') options.onSpawn(child);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      finish(timeoutError, { code, signal, stdout, stderr });
    });
    timeout = setTimeout(() => {
      timeoutError = new Error('FFmpegの応答がタイムアウトしました');
      void terminateProcess(child, 500).then(
        () => finish(timeoutError),
        (terminationError) => finish(
          new Error(
            `FFmpegの応答がタイムアウトし、停止も確認できませんでした: ${
              terminationError instanceof Error
                ? terminationError.message
                : String(terminationError)
            }`,
          ),
        ),
      );
    }, timeoutMs);
  });
}

async function verifyFfmpegBinary(binaryPath) {
  const stat = await fs.lstat(binaryPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1_000_000) {
    throw new Error('ネイティブFFmpegが見つかりません');
  }
  const result = await runCaptured(binaryPath, ['-hide_banner', '-version'], {
    timeoutMs: 10_000,
  });
  if (
    result.code !== 0 ||
    !`${result.stdout}\n${result.stderr}`.toLowerCase().includes('ffmpeg version')
  ) {
    throw new Error('ネイティブFFmpegを起動できません');
  }
  return true;
}

async function probeInputHasAudio(binaryPath, sourcePath) {
  const result = await runCaptured(
    binaryPath,
    [
      '-hide_banner',
      '-nostdin',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      sourcePath,
      '-map',
      '0:a:0?',
      '-t',
      '0.001',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 30_000 },
  );
  return /Stream #\d+:\d+(?:\([^)]*\))?: Audio:/i.test(result.stderr);
}

function parseDuration(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function validateOutput(binaryPath, outputPath, expected) {
  const stat = await fs.lstat(outputPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 12 ||
    (Number.isSafeInteger(expected.maxBytes) && stat.size > expected.maxBytes)
  ) {
    throw new Error('書き出された動画ファイルが空か、大きすぎます');
  }
  const handle = await fs.open(outputPath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 12 || header.toString('ascii', 4, 8) !== 'ftyp') {
      throw new Error('書き出されたファイルが有効なMP4ではありません');
    }
  } finally {
    await handle.close();
  }

  const result = await runCaptured(
    binaryPath,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'info',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      outputPath,
      '-map',
      '0:v:0',
      '-t',
      '0.05',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0 || !/Stream #\d+:\d+.*Video:/i.test(result.stderr)) {
    throw new Error('完成動画の映像ストリームを検証できませんでした');
  }
  const dimensions = new RegExp(`\\b${expected.width}x${expected.height}\\b`);
  if (!dimensions.test(result.stderr)) {
    throw new Error('完成動画の解像度が設定と一致しません');
  }
  const duration = parseDuration(result.stderr);
  const tolerance = Math.max(1.5, expected.duration * 0.02);
  if (
    duration === null ||
    Math.abs(duration - expected.duration) > tolerance
  ) {
    throw new Error('完成動画の長さがタイムラインと一致しません');
  }
  return { size: stat.size, duration };
}

function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    child.once('exit', onExit);
    child.once('error', onError);
    timeout = setTimeout(() => finish(false), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

function runTaskkill(pid) {
  return new Promise((resolve, reject) => {
    const command = path.join(
      process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
      'System32',
      'taskkill.exe',
    );
    const child = spawn(command, ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: minimalEnvironment(),
    });
    let settled = false;
    let timeout;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    child.once('error', finish);
    child.once('close', () => finish());
    timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The command may have exited between the timeout and this signal.
      }
      finish(new Error('taskkillがタイムアウトしました'));
    }, 10_000);
  });
}

async function terminateProcess(child, graceMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;

  if (process.platform === 'win32') {
    await runTaskkill(child.pid).catch(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Process may have exited between checks.
      }
    });
    if (!(await waitForProcessExit(child, 5_000))) {
      throw new Error('FFmpegプロセスの停止を確認できませんでした');
    }
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Process may have exited between checks.
  }
  if (await waitForProcessExit(child, graceMs)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Process may have exited between checks.
  }
  if (!(await waitForProcessExit(child, 5_000))) {
    throw new Error('FFmpegプロセスの停止を確認できませんでした');
  }
}

module.exports = {
  MAX_CAPTURE_BYTES,
  appendTail,
  minimalEnvironment,
  probeInputHasAudio,
  resolveFfmpegBinary,
  runCaptured,
  terminateProcess,
  validateOutput,
  verifyFfmpegBinary,
};
