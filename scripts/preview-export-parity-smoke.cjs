'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');

const executableArg = process.argv[2];
const expectedVersion = process.argv[3];
if (!executableArg || !expectedVersion || !ffmpegPath) {
  throw new Error(
    'usage: node preview-export-parity-smoke.cjs <Byux.exe> <version>',
  );
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.slice(-8_000)}`));
    });
  });
}

async function main() {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byux-parity-fixture-'));
  const fixture = path.join(workDir, 'parity-source.mp4');
  try {
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', fixture,
    ], 60_000);
    const scenarios = [
      'transform-grade',
      'text-transition',
      'vertical-layer',
      'speed-keyframes',
    ];
    for (const scenario of scenarios) {
      const result = await run(process.execPath, [
        path.join(__dirname, 'export-ui-smoke.cjs'),
        path.resolve(executableArg),
        fixture,
        expectedVersion,
        '--compare-preview',
        `--parity-scenario=${scenario}`,
      ], 300_000);
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    console.log(`PREVIEW_EXPORT_PARITY_OK scenarios=${scenarios.join(',')}`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error('PREVIEW_EXPORT_PARITY_FAILED', error);
  process.exitCode = 1;
});
