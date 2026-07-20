'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  HARDWARE_VIDEO_ENCODERS,
  buildHardwareProbeArgs,
} = require('../electron/hardwareEncoding.cjs');
const { buildNativeExportPlan } = require('../electron/nativeExportPlan.cjs');
const {
  resolveFfmpegBinary,
  runCaptured,
  validateOutput,
} = require('../electron/nativeFfmpeg.cjs');

function runPlan(binaryPath, args, cwd) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(binaryPath, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-256 * 1024);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

async function main() {
  const binaryPath = resolveFfmpegBinary(false, '', path.join(__dirname, '..'));
  const width = 1280;
  const height = 720;
  const fps = 60;
  let selected = null;
  for (const encoder of HARDWARE_VIDEO_ENCODERS) {
    const result = await runCaptured(
      binaryPath,
      buildHardwareProbeArgs(encoder.id, width, height, fps),
      { timeoutMs: 12_000 },
    ).catch(() => null);
    if (result?.code === 0) {
      selected = encoder;
      break;
    }
  }
  if (!selected) {
    console.log('NATIVE_GPU_SMOKE_SKIPPED no usable hardware H.264 encoder');
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byux-gpu-smoke-'));
  try {
    const sourcePath = path.join(workDir, 'source.mp4');
    const outputPath = path.join(workDir, 'output.mp4');
    const source = await runCaptured(binaryPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=${width}x${height}:r=${fps}:d=1`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=44100:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      sourcePath,
    ]);
    if (source.code !== 0) throw new Error(`source generation failed: ${source.stderr}`);

    const request = {
      version: 1,
      encodingPreference: 'auto',
      options: {
        resolution: '720p',
        fps,
        aspectRatio: '16:9',
        quality: 'recommended',
        verticalReframe: 0,
        motionBlur: false,
      },
      tracks: [
        { id: 'video', kind: 'video', label: 'Video', locked: false, muted: false, hidden: false },
      ],
      assets: [
        {
          id: 'asset',
          name: 'source.mp4',
          kind: 'video',
          size: (await fs.stat(sourcePath)).size,
          width,
          height,
          sourceToken: 'smoke-token',
        },
      ],
      clips: [
        {
          id: 'clip',
          trackId: 'video',
          assetId: 'asset',
          start: 0,
          trimStart: 0,
          trimEnd: 1,
          speed: 1,
          volume: 1,
          effects: [],
        },
      ],
      markers: [],
      overlays: [],
    };
    const plan = buildNativeExportPlan(
      request,
      new Map([['asset', { path: sourcePath, hasAudio: true }]]),
      new Map(),
      outputPath,
      selected.id,
    );
    await fs.writeFile(
      path.join(workDir, 'filter-complex.txt'),
      plan.filterGraph,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const encoded = await runPlan(binaryPath, plan.args, workDir);
    if (encoded.code !== 0) throw new Error(`hardware plan failed: ${encoded.stderr}`);
    const validation = await validateOutput(binaryPath, outputPath, {
      width,
      height,
      duration: 1,
      maxBytes: 128 * 1024 * 1024,
    });
    console.log(
      `NATIVE_GPU_SMOKE_OK ${JSON.stringify({
        encoder: selected.id,
        label: selected.label,
        size: validation.size,
        duration: validation.duration,
      })}`,
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('NATIVE_GPU_SMOKE_FAILED', error);
  process.exitCode = 1;
});
