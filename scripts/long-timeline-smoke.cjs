'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  probeInputDuration,
  resolveFfmpegBinary,
  runCaptured,
} = require('../electron/nativeFfmpeg.cjs');

function runNode(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`long timeline smoke timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-2 * 1024 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2 * 1024 * 1024);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  const executableArg = process.argv[2];
  const hoursArg = Number(process.argv[3] ?? 5);
  if (!executableArg) {
    throw new Error('usage: node long-timeline-smoke.cjs <Byux.exe> [hours: 1-5]');
  }
  if (!Number.isFinite(hoursArg) || hoursArg < 1 || hoursArg > 5) {
    throw new Error('hours must be between 1 and 5');
  }
  const executable = path.resolve(executableArg);
  const durationSeconds = Math.round(hoursArg * 3600);
  const binaryPath = resolveFfmpegBinary(false, '', path.join(__dirname, '..'));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byux-long-timeline-'));
  const fixturePath = path.join(workDir, `long-${hoursArg}h.mp4`);
  try {
    const generated = await runCaptured(binaryPath, [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=320x180:rate=1:duration=${durationSeconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=8000:duration=${durationSeconds}`,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '10',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '32k',
      '-ac',
      '1',
      '-movflags',
      '+faststart',
      fixturePath,
    ], { timeoutMs: 10 * 60_000 });
    if (generated.code !== 0) {
      throw new Error(`long fixture generation failed: ${generated.stderr}`);
    }
    const duration = await probeInputDuration(binaryPath, fixturePath);
    if (!duration || Math.abs(duration - durationSeconds) > 1) {
      throw new Error(`long fixture duration mismatch: ${String(duration)}`);
    }
    const smoke = await runNode([
      path.join(__dirname, 'media-file-registration-smoke.cjs'),
      executable,
      fixturePath,
      '--preview-playback',
    ], 10 * 60_000);
    if (smoke.code !== 0) {
      throw new Error(`packaged long timeline smoke failed:\n${smoke.stdout}\n${smoke.stderr}`);
    }
    process.stdout.write(smoke.stdout);
    process.stdout.write(
      `LONG_TIMELINE_SMOKE_OK hours=${hoursArg} duration=${duration.toFixed(2)}\n`,
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
