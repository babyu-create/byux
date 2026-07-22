'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { appendTail, resolveFfmpegBinary } = require('../electron/nativeFfmpeg.cjs');
const { buildWaveformFfmpegArgs, createWaveformMetadataAccumulator } = require('../electron/nativeWaveform.cjs');
const { buildLoudnessFfmpegArgs, parseLoudnessSummary } = require('../electron/nativeLoudness.cjs');

function runStreaming(binaryPath, args, onStdout) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(binaryPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', onStdout ?? (() => {}));
    child.stderr.on('data', (chunk) => { stderr = appendTail(stderr, chunk, 512 * 1024); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error('Usage: node scripts/long-media-smoke.cjs <absolute-media-path>');
  }
  const binaryPath = resolveFfmpegBinary(false, '', path.join(__dirname, '..'));
  const started = Date.now();
  const startingRss = process.memoryUsage().rss;
  let peakRss = startingRss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  try {
    const accumulator = createWaveformMetadataAccumulator();
    const waveform = await runStreaming(
      binaryPath,
      buildWaveformFfmpegArgs(sourcePath),
      (chunk) => accumulator.push(chunk),
    );
    if (waveform.code !== 0) throw new Error(`waveform failed: ${waveform.stderr}`);
    const peaks = accumulator.finish();
    const loudnessRun = await runStreaming(binaryPath, buildLoudnessFfmpegArgs(sourcePath));
    if (loudnessRun.code !== 0) throw new Error(`loudness failed: ${loudnessRun.stderr}`);
    const loudness = parseLoudnessSummary(loudnessRun.stderr);
    if (!loudness) throw new Error('LUFS summary was not parsed');
    console.log(
      `LONG_MEDIA_SMOKE_OK peaks=${peaks.length} lufs=${loudness.integratedLufs.toFixed(1)} ` +
      `elapsedSec=${((Date.now() - started) / 1000).toFixed(1)} rssGrowthMb=${((peakRss - startingRss) / 1024 / 1024).toFixed(1)}`,
    );
  } finally {
    clearInterval(sampler);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
