'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  buildHudMaskFilterChain,
  buildNativeExportPlan,
} = require('../electron/nativeExportPlan.cjs');
const {
  HARDWARE_VIDEO_ENCODERS,
  buildHardwareProbeArgs,
} = require('../electron/hardwareEncoding.cjs');
const {
  appendTail,
  probeInputDuration,
  resolveFfmpegBinary,
  runCaptured,
} = require('../electron/nativeFfmpeg.cjs');

const SYNTHETIC_SECONDS = 1;

async function checkedRun(binaryPath, args, label, timeoutMs = 120_000) {
  const result = await runCaptured(binaryPath, args, { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`${label} failed (${String(result.code)}): ${result.stderr}`);
  }
  return result;
}

function renderRequest(sourcePath, size, duration, fps, blur, quality, knownSize) {
  return {
    version: 1,
    options: {
      resolution: '720p',
      fps,
      aspectRatio: '16:9',
      quality,
      verticalReframe: 0,
      motionBlur: blur,
      motionBlurStrength: 1.25,
      motionBlurHudPreset: 'valorant',
      motionBlurHudMaskStrength: 0.85,
    },
    tracks: [
      { id: 'video', kind: 'video', label: 'Video', locked: false, muted: false, hidden: false },
    ],
    assets: [
      {
        id: 'asset',
        name: path.basename(sourcePath),
        kind: 'video',
        size,
        ...(knownSize ? { width: 1280, height: 720 } : {}),
      },
    ],
    clips: [
      {
        id: 'clip',
        trackId: 'video',
        assetId: 'asset',
        start: 0,
        trimStart: 0,
        trimEnd: duration,
        speed: 1,
        volume: 1,
        effects: blur ? [{ type: 'motion-blur', intensity: 100 }] : [],
      },
    ],
    markers: [],
    overlays: [],
    subtitles: [],
  };
}

function executePlan(binaryPath, plan, cwd) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const started = performance.now();
    const child = spawn(binaryPath, plan.args, {
      shell: false,
      windowsHide: true,
      cwd,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('native motion-blur render timed out'));
    }, 120_000);
    child.stderr.on('data', (chunk) => { stderr = appendTail(stderr, chunk); });
    child.stdio[3]?.resume();
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`native render failed (${String(code)}): ${stderr}`));
      else resolve((performance.now() - started) / 1_000);
    });
  });
}

async function render(binaryPath, root, spec) {
  const runDir = await fs.mkdtemp(path.join(root, 'render-'));
  const outputPath = path.join(runDir, 'output.mp4');
  const request = renderRequest(
    spec.sourcePath,
    spec.size,
    spec.duration,
    spec.fps,
    spec.blur,
    spec.quality,
    spec.knownSize,
  );
  const plan = buildNativeExportPlan(
    request,
    new Map([['asset', { path: spec.sourcePath, hasAudio: false }]]),
    new Map(),
    outputPath,
    spec.encoder,
  );
  await fs.writeFile(path.join(runDir, 'filter-complex.txt'), plan.filterGraph, 'utf8');
  const elapsedSec = await executePlan(binaryPath, plan, runDir);
  const actualDuration = await probeInputDuration(binaryPath, outputPath);
  if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - spec.duration) > 0.1) {
    throw new Error(`A/V duration changed: expected=${spec.duration} actual=${actualDuration}`);
  }
  return { outputPath, elapsedSec, filterGraph: plan.filterGraph };
}

async function qualityMetrics(binaryPath, referencePath, candidatePath) {
  const result = await checkedRun(
    binaryPath,
    [
      '-hide_banner', '-nostdin', '-i', referencePath, '-i', candidatePath,
      '-filter_complex',
      '[0:v]split=2[rssim][rpsnr];[1:v]split=2[cssim][cpsnr];' +
        '[rssim][cssim]ssim[ssimout];[rpsnr][cpsnr]psnr[psnrout]',
      '-map', '[ssimout]', '-map', '[psnrout]', '-an', '-f', 'null', '-',
    ],
    'quality metrics',
  );
  const ssim = /All:([\d.]+)/.exec(result.stderr);
  const psnr = /average:([\d.]+)/.exec(result.stderr);
  if (!ssim || !psnr) throw new Error('SSIM/PSNR summary missing');
  return { ssim: Number(ssim[1]), psnr: Number(psnr[1]) };
}

async function averageLuma(binaryPath, mediaPath) {
  const result = await checkedRun(
    binaryPath,
    [
      '-hide_banner', '-nostdin', '-i', mediaPath, '-vf',
      'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
      '-an', '-f', 'null', '-',
    ],
    'luma',
  );
  const values = [...result.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)]
    .map((match) => Number(match[1]));
  if (values.length === 0) throw new Error('luma samples missing');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function availableHardwareEncoder(binaryPath) {
  for (const encoder of HARDWARE_VIDEO_ENCODERS) {
    const result = await runCaptured(
      binaryPath,
      buildHardwareProbeArgs(encoder.id, 1280, 720, 60),
      { timeoutMs: 20_000 },
    ).catch(() => null);
    if (result?.code === 0) return encoder.id;
  }
  return null;
}

async function hudBlendFraction(binaryPath, strength) {
  const mask = buildHudMaskFilterChain('valorant', strength, 320, 180, 30, 0.1);
  const graph =
    'color=c=0x808080:s=320x180:r=30:d=0.1,format=yuv420p[dark];' +
    'color=c=red:s=320x180:r=30:d=0.1,format=yuv420p[sharp];' +
    `${mask}[mask];` +
    '[dark][sharp][mask]maskedmerge=planes=7,' +
    'crop=100:10:110:0,signalstats,metadata=print';
  const result = await checkedRun(
    binaryPath,
    ['-hide_banner', '-nostdin', '-filter_complex', graph, '-frames:v', '1', '-f', 'null', '-'],
    `HUD blend ${strength}`,
  );
  const values = {};
  for (const plane of ['Y', 'U', 'V']) {
    const match = new RegExp(`lavfi\\.signalstats\\.${plane}AVG=([\\d.]+)`).exec(
      result.stderr,
    );
    if (!match) throw new Error(`HUD ${plane} pixel sample missing`);
    values[plane] = Number(match[1]);
  }
  return values;
}

async function timedFilter(binaryPath, sourcePath, graph, label) {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-stream_loop', '1',
    '-i', sourcePath, '-filter_complex', graph, '-map', '[out]', '-an',
    '-f', 'null', '-',
  ];
  // Warm decoder/filter initialization before measuring the same graph.
  await checkedRun(binaryPath, args, `${label} warmup`);
  const started = performance.now();
  await checkedRun(binaryPath, args, label);
  return (performance.now() - started) / 1_000;
}

async function legacySpeedComparison(binaryPath, sourcePath) {
  const region =
    'gte(Y\\,H*0.58)+' +
    'lte(Y\\,H*0.10)+' +
    'lte(X\\,W*0.22)*lte(Y\\,H*0.32)';
  const legacyGraph =
    '[0:v]fps=60,split=2[legacysharp][legacyinput];' +
    "[legacyinput]tmix=frames=4:weights='1 1 1 1'[legacyblur];" +
    `[legacyblur][legacysharp]blend=all_expr='if(gt(${region}\\,0)\\,` +
    `A*0.15+B*0.85\\,A)'[out]`;
  const mask = buildHudMaskFilterChain('valorant', 0.85, 1280, 720, 60, 2);
  const optimizedGraph =
    '[0:v]fps=60,split=2[newsharp][newinput];' +
    "[newinput]tmix=frames=2:weights='1 1'[newblur];" +
    `${mask}[newmask];` +
    '[newblur][newsharp][newmask]maskedmerge=planes=7[out]';
  const legacySec = await timedFilter(binaryPath, sourcePath, legacyGraph, 'legacy blur');
  const optimizedSec = await timedFilter(
    binaryPath,
    sourcePath,
    optimizedGraph,
    'optimized blur',
  );
  return {
    legacySec,
    optimizedSec,
    speedup: legacySec / optimizedSec,
  };
}

async function benchmarkProfile(binaryPath, root, profile, hardwareEncoder) {
  const references = {};
  const rows = [];
  for (const blur of [false, true]) {
    references[blur ? 'on' : 'off'] = await render(binaryPath, root, {
      ...profile,
      blur,
      quality: 'high',
      encoder: 'libx264',
    });
  }
  for (const encoder of ['libx264', ...(hardwareEncoder ? [hardwareEncoder] : [])]) {
    for (const blur of [false, true]) {
      const key = blur ? 'on' : 'off';
      const candidate = await render(binaryPath, root, {
        ...profile,
        blur,
        quality: 'recommended',
        encoder,
      });
      const metrics = await qualityMetrics(
        binaryPath,
        references[key].outputPath,
        candidate.outputPath,
      );
      rows.push({ encoder, blur: key, elapsedSec: candidate.elapsedSec, ...metrics });
      if (blur) {
        if (!candidate.filterGraph.includes('maskedmerge=planes=7')) {
          throw new Error('optimized HUD maskedmerge is missing');
        }
        if (candidate.filterGraph.includes('blend=all_expr=')) {
          throw new Error('legacy per-pixel HUD expression is still present');
        }
      }
    }
  }
  const offLuma = await averageLuma(binaryPath, references.off.outputPath);
  const onLuma = await averageLuma(binaryPath, references.on.outputPath);
  const lumaDriftPercent = Math.abs(onLuma - offLuma) / Math.max(1, offLuma) * 100;
  if (profile.label.startsWith('synthetic-') && lumaDriftPercent > 2) {
    throw new Error(`motion blur changed average brightness by ${lumaDriftPercent.toFixed(2)}%`);
  }
  return { rows, lumaDriftPercent, offLuma, onLuma };
}

async function main() {
  const realPath = process.argv[2];
  if (realPath && !path.isAbsolute(realPath)) {
    throw new Error('The optional real-media path must be absolute');
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byux-motion-blur-'));
  const binaryPath = resolveFfmpegBinary(false, '', path.join(__dirname, '..'));
  try {
    const hardwareEncoder = await availableHardwareEncoder(binaryPath);
    const hudPixels = {};
    for (const strength of [0, 0.25, 0.85, 1]) {
      hudPixels[strength] = await hudBlendFraction(binaryPath, strength);
    }
    for (const strength of [0.25, 0.85]) {
      for (const plane of ['Y', 'U', 'V']) {
        const low = hudPixels[0][plane];
        const high = hudPixels[1][plane];
        const fraction = (hudPixels[strength][plane] - low) / (high - low);
        if (Math.abs(fraction - strength) > 0.04) {
          throw new Error(
            `HUD ${plane} mask is not proportional: ` +
            `${strength}=>${fraction.toFixed(3)}`,
          );
        }
      }
    }
    const profiles = [];
    let synthetic60Path = null;
    for (const fps of [30, 60, 120]) {
      const sourcePath = path.join(root, `synthetic-${fps}.mp4`);
      await checkedRun(
        binaryPath,
        [
          '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i',
          `testsrc2=size=1280x720:rate=${fps}:duration=${SYNTHETIC_SECONDS}`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt',
          'yuv420p', '-an', '-y', sourcePath,
        ],
        `synthetic ${fps}`,
      );
      profiles.push({
        label: `synthetic-${fps}`,
        sourcePath,
        size: (await fs.stat(sourcePath)).size,
        duration: SYNTHETIC_SECONDS,
        fps,
        knownSize: true,
      });
      if (fps === 60) synthetic60Path = sourcePath;
    }
    if (realPath) {
      const duration = await probeInputDuration(binaryPath, realPath);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('real-media duration missing');
      profiles.push({
        label: 'real-60',
        sourcePath: realPath,
        size: (await fs.stat(realPath)).size,
        duration: Math.min(2, duration),
        fps: 60,
        knownSize: false,
      });
    }
    const legacy = await legacySpeedComparison(binaryPath, synthetic60Path);
    console.log(
      `MOTION_BLUR_LEGACY synthetic-60 legacy=${legacy.legacySec.toFixed(2)}s ` +
      `optimized=${legacy.optimizedSec.toFixed(2)}s speedup=${legacy.speedup.toFixed(2)}x`,
    );
    for (const profile of profiles) {
      const result = await benchmarkProfile(binaryPath, root, profile, hardwareEncoder);
      if (profile.label === 'real-60' && result.offLuma <= 24) {
        throw new Error(`real-media output is black: YAVG=${result.offLuma.toFixed(2)}`);
      }
      const summary = result.rows.map((row) =>
        `${row.encoder}/${row.blur}=${row.elapsedSec.toFixed(2)}s,` +
        `SSIM:${row.ssim.toFixed(5)},PSNR:${row.psnr.toFixed(2)}`,
      ).join(' ');
      console.log(
        `MOTION_BLUR_PROFILE ${profile.label} ${summary} ` +
        `lumaDrift=${result.lumaDriftPercent.toFixed(2)}%`,
      );
    }
    console.log(
      `MOTION_BLUR_SMOKE_OK hardware=${hardwareEncoder ?? 'unavailable'} ` +
      `real=${realPath ? 'tested' : 'skipped'} ` +
      'hudYuv=proportional',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
