'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  buildHdrToSdrFilter,
  probeInputVideoColorMetadata,
  resolveFfmpegBinary,
  runCaptured,
} = require('../electron/nativeFfmpeg.cjs');

async function run(binaryPath, args, label) {
  const result = await runCaptured(binaryPath, args, { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`${label} failed (${String(result.code)}): ${result.stderr}`);
  }
  return result;
}

async function createHdrFixture(binaryPath, outputPath, profile) {
  const transfer = profile === 'pq' ? 'smpte2084' : 'arib-std-b67';
  await run(
    binaryPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=1',
      '-vf',
      'format=yuv420p10le',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      `hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=${transfer}:colormatrix=bt2020nc`,
      '-color_primaries',
      'bt2020',
      '-color_trc',
      transfer,
      '-colorspace',
      'bt2020nc',
      '-an',
      '-y',
      outputPath,
    ],
    `${profile} fixture`,
  );
}

async function convertToSdr(binaryPath, inputPath, outputPath, profile) {
  await run(
    binaryPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vf',
      buildHdrToSdrFilter(profile),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
      '-an',
      '-y',
      outputPath,
    ],
    `${profile} tone-map`,
  );
  const inspection = await run(
    binaryPath,
    ['-hide_banner', '-nostdin', '-i', outputPath, '-frames:v', '1', '-f', 'null', '-'],
    `${profile} SDR validation`,
  );
  if (!/Video: h264[^\n]*yuv420p\(tv, bt709/i.test(inspection.stderr)) {
    throw new Error(`${profile} output is not tagged limited-range BT.709 SDR`);
  }
}

async function main() {
  const binaryPath = resolveFfmpegBinary(false, '', path.join(__dirname, '..'));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byux-hdr-smoke-'));
  try {
    for (const profile of ['pq', 'hlg']) {
      const inputPath = path.join(workDir, `${profile}-10bit-hevc.mp4`);
      const outputPath = path.join(workDir, `${profile}-bt709.mp4`);
      await createHdrFixture(binaryPath, inputPath, profile);
      const metadata = await probeInputVideoColorMetadata(binaryPath, inputPath);
      if (metadata.toneMap !== profile || metadata.primaries !== 'bt2020') {
        throw new Error(`${profile} metadata was not detected: ${JSON.stringify(metadata)}`);
      }
      await convertToSdr(binaryPath, inputPath, outputPath, profile);
    }
    console.log('HDR_MEDIA_SMOKE_OK profiles=pq,hlg input=hevc-main10 output=h264-bt709');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
