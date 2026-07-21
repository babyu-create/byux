'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildNativeExportPlan } = require('../electron/nativeExportPlan.cjs');
const { buildAssSubtitles } = require('../electron/nativeSubtitles.cjs');
const { buildLoudnessFfmpegArgs, parseLoudnessSummary } = require('../electron/nativeLoudness.cjs');
const { buildWaveformFfmpegArgs, createWaveformMetadataAccumulator } = require('../electron/nativeWaveform.cjs');
const { encodeWaveformCache, decodeWaveformCache } = require('../electron/waveformCache.cjs');
const { probeInputMediaKind, resolveFfmpegBinary, runCaptured, validateOutput } = require('../electron/nativeFfmpeg.cjs');

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
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-512 * 1024);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

async function main() {
  const binaryPath = resolveFfmpegBinary(false, '', path.join(__dirname, '..'));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byux-feature-smoke-'));
  try {
    const sourcePath = path.join(workDir, 'source.mp4');
    const unknownPath = path.join(workDir, 'capture.recording');
    const outputPath = path.join(workDir, 'output.mp4');
    const generated = await runCaptured(binaryPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', sourcePath,
    ], { timeoutMs: 60_000 });
    if (generated.code !== 0) throw new Error(`source generation failed: ${generated.stderr}`);

    await fs.copyFile(sourcePath, unknownPath);
    const detected = await probeInputMediaKind(binaryPath, unknownPath);
    if (detected !== 'video') throw new Error(`unknown-extension probe returned ${detected}`);

    const request = {
      version: 1,
      encodingPreference: 'software',
      options: {
        resolution: '720p', fps: 30, aspectRatio: '16:9', quality: 'compact',
        verticalReframe: 0, motionBlur: false,
      },
      tracks: [
        { id: 'video', kind: 'video', label: 'Video', locked: false, muted: false, hidden: false },
      ],
      assets: [
        { id: 'asset', name: 'capture.recording', kind: 'video', size: 1, width: 640, height: 360, sourceToken: 'token' },
      ],
      clips: [{
        id: 'clip', trackId: 'video', assetId: 'asset', start: 0,
        trimStart: 0, trimEnd: 2.8, speed: 1, volume: 1, effects: [],
        audioProcessing: { highPassHz: 80, lowGainDb: -2, midGainDb: 2.5, highGainDb: 1, compressor: true },
      }],
      markers: [],
      overlays: [],
      subtitles: [
        { id: 'subtitle-1', start: 0.35, end: 2.3, text: 'Byux 字幕テスト\nFPS montage' },
      ],
      subtitleStyle: {
        fontSize: 5.2, color: '#ffffff', outlineColor: '#000000',
        background: 'rgba(0,0,0,0.58)', position: 'bottom',
      },
    };
    const plan = buildNativeExportPlan(
      request,
      new Map([['asset', { path: unknownPath, hasAudio: true }]]),
      new Map(),
      outputPath,
    );
    await fs.writeFile(path.join(workDir, 'filter-complex.txt'), plan.filterGraph, 'utf8');
    await fs.writeFile(
      path.join(workDir, 'subtitles.ass'),
      buildAssSubtitles(request.subtitles, request.subtitleStyle, plan.width, plan.height),
      'utf8',
    );
    const rendered = await runPlan(binaryPath, plan.args, workDir);
    if (rendered.code !== 0) throw new Error(`native render failed: ${rendered.stderr}`);
    await validateOutput(binaryPath, outputPath, {
      width: plan.width,
      height: plan.height,
      duration: plan.totalDuration,
      maxBytes: 128 * 1024 * 1024,
    });

    const loudnessRun = await runCaptured(binaryPath, buildLoudnessFfmpegArgs(unknownPath), {
      timeoutMs: 60_000,
    });
    const loudness = parseLoudnessSummary(loudnessRun.stderr);
    if (!loudness) throw new Error('LUFS summary was not parsed');

    const waveformRun = await runCaptured(binaryPath, buildWaveformFfmpegArgs(unknownPath), {
      timeoutMs: 60_000,
    });
    if (waveformRun.code !== 0) throw new Error(`waveform failed: ${waveformRun.stderr}`);
    const accumulator = createWaveformMetadataAccumulator();
    accumulator.push(waveformRun.stdout);
    const peaks = accumulator.finish();
    const cached = decodeWaveformCache(encodeWaveformCache(peaks, 20));
    if (!cached || cached.peaks.length !== peaks.length || peaks.length < 40) {
      throw new Error('waveform cache round-trip failed');
    }
    console.log(
      `NATIVE_FEATURE_SMOKE_OK kind=${detected} subtitles=${request.subtitles.length} ` +
      `lufs=${loudness.integratedLufs.toFixed(1)} peaks=${peaks.length}`,
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
