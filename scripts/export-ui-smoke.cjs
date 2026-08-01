'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');

const positionalArgs = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const [executableArg, fixtureArg, expectedVersion] = positionalArgs;
const motionBlurSmoke = process.argv.includes('--motion-blur');
const comparePreview = process.argv.includes('--compare-preview');
const parityScenario = process.argv
  .find((argument) => argument.startsWith('--parity-scenario='))
  ?.slice('--parity-scenario='.length) ?? 'transform-grade';
// At p=0.5 the linear 0.5→1.5 speed profile maps exactly to source 0.75 s
// (with the two-second trim). Both are exact 60 fps frame boundaries, which
// avoids measuring Chromium-vs-FFmpeg nearest-frame rounding instead of the
// authored effects.
const parityTime = 0.5;
const projectClipCount = parityScenario === 'vertical-layer' ? 2 : 1;
if (!executableArg || !fixtureArg || !expectedVersion || !ffmpegPath) {
  throw new Error(
    'usage: node export-ui-smoke.cjs <Byux.exe> <video-file> <version> [--motion-blur] [--compare-preview]',
  );
}
// Node's Windows spawn does not consistently resolve a relative executable
// containing path separators. Resolve both inputs once so the smoke test works
// identically from npm, PowerShell, and CI instead of timing out with no page.
const executable = path.resolve(executableArg);
const fixturePath = path.resolve(fixtureArg);

// Pick a high per-run port so a previously interrupted smoke test cannot make a
// fresh run attach to the wrong renderer. The profile is already unique per run.
const port = 20_000 + (process.pid % 20_000);
const profile = path.join(os.tmpdir(), `byux-export-ui-${Date.now()}`);
const outputPath = path.join(os.tmpdir(), `byux-export-ui-${Date.now()}.mp4`);
const projectPath = path.join(os.tmpdir(), `byux-export-ui-${Date.now()}.fce.json`);
const parityDir = path.join(os.tmpdir(), `byux-preview-export-parity-${Date.now()}`);
const previewFramePath = path.join(parityDir, 'preview.png');
const exportedFramePath = path.join(parityDir, 'exported.png');
let committedOutputPath = null;
let paritySucceeded = !comparePreview;
const child = spawn(
  executable,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
);
let childError = null;
let childStderr = '';
child.on('error', (error) => {
  childError = error;
});
child.stderr.on('data', (chunk) => {
  childStderr = `${childStderr}${chunk.toString('utf8')}`.slice(-8_000);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const progress = (step) => console.error(`EXPORT_UI_SMOKE_STEP ${step}`);

function run(command, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      process.kill('SIGKILL');
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    process.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    process.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    process.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

async function findPage() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (childError) throw childError;
    if (child.exitCode !== null) {
      throw new Error(
        `packaged process exited before renderer start (${child.exitCode}): ${childStderr}`,
      );
    }
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find(
        (target) => target.type === 'page' && target.webSocketDebuggerUrl,
      );
      if (page) return page;
    } catch {}
    await delay(100);
  }
  throw new Error('packaged renderer did not start');
}

function command(webSocketUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl);
    const id = 1;
    const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timeout);
      ws.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      } else {
        resolve(message.result);
      }
    });
    ws.addEventListener('error', reject);
  });
}

async function evaluate(page, expression) {
  const result = await command(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value;
}

async function sendFileToOpenDialog(selectedPath) {
  const escapedPath = path.resolve(selectedPath).replaceAll("'", "''");
  const script = [
    'Add-Type -AssemblyName UIAutomationClient',
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ByuxDialogNative { [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam); [DllImport(\"user32.dll\")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam); }'",
    '$root=[System.Windows.Automation.AutomationElement]::RootElement',
    `$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,${child.pid})`,
    '$window=$null',
    'for($attempt=0;$attempt -lt 100 -and $null -eq $window;$attempt++){ $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition); foreach($candidate in $windows){ if($candidate.Current.ClassName -eq \'#32770\'){ $window=$candidate; break } }; if($null -eq $window){ Start-Sleep -Milliseconds 50 } }',
    "if ($null -eq $window) { throw 'Open dialog did not appear' }",
    '$edits=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)',
    '$edit=$null',
    "foreach($candidate in $edits){ if($candidate.Current.ClassName -eq 'Edit' -and ($candidate.Current.AutomationId -eq '1148' -or $candidate.Current.AutomationId -eq '1001')){ $edit=$candidate; break } }",
    "if ($null -eq $edit) { foreach($candidate in $edits){ if($candidate.Current.ClassName -eq 'Edit'){ $edit=$candidate } } }",
    "if ($null -eq $edit) { throw 'Filename field not found' }",
    `[ByuxDialogNative]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle,0x000C,[IntPtr]::Zero,'${escapedPath}') | Out-Null`,
    "$openCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1')",
    '$buttons=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$openCondition)',
    '$open=$null',
    "foreach($candidate in $buttons){ if($candidate.Current.ClassName -eq 'Button'){ $open=$candidate; break } }",
    "if ($null -eq $open) { throw 'Open button not found' }",
    '[ByuxDialogNative]::SendMessage([IntPtr]$open.Current.NativeWindowHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const helper = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    helper.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    helper.once('error', reject);
    helper.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`file dialog automation failed (${code}): ${stderr}`));
    });
  });
}

async function poll(page, expression, predicate, timeoutMs = 60_000) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeoutMs) {
    try {
      value = await evaluate(page, expression);
      if (predicate(value)) return value;
    } catch {}
    await delay(150);
  }
  throw new Error(`timed out waiting for UI: ${JSON.stringify(value)}`);
}

async function writeProjectFixture() {
  const source = await fs.stat(fixturePath);
  const verticalLayer = parityScenario === 'vertical-layer';
  const textTransition = parityScenario === 'text-transition';
  const speedKeyframes = parityScenario === 'speed-keyframes';
  const baseClip = {
    id: 'smoke-clip',
    trackId: 'video-main',
    assetId: 'smoke-asset',
    start: 0,
    trimStart: 0,
    trimEnd: speedKeyframes ? 2 : 1,
    effects: motionBlurSmoke
      ? [{ type: 'motion-blur', intensity: 65 }]
      : [],
    ...(comparePreview && parityScenario === 'transform-grade' ? {
      transform: { x: 2, y: -1.5, scale: 1.04, rotation: 1.5, opacity: 0.96 },
      colorGrade: { preset: 'none', exposure: 3, contrast: 4, saturation: 5 },
    } : {}),
    ...(textTransition ? {
      transitionIn: { type: 'fade', duration: 0.8 },
      overlays: [{
        id: 'parity-overlay',
        text: 'BYUX',
        fontSize: 9,
        color: '#ffffff',
        position: 'top-center',
        weight: 700,
        outline: true,
        outlineColor: '#000000',
      }],
    } : {}),
    ...(speedKeyframes ? {
      speed: 2,
      speedRamp: { from: 0.5, to: 1.5, easing: 'linear' },
      transform: {
        x: [{ t: 0, value: -8 }, { t: 0.5, value: 5 }, { t: 1, value: 10 }],
        y: [{ t: 0, value: 3 }, { t: 0.5, value: -4 }, { t: 1, value: 2 }],
        scale: [{ t: 0, value: 1 }, { t: 1, value: 1.08 }],
      },
    } : {}),
  };
  const project = {
    version: 1,
    app: 'highlight-maker',
    name: 'packaged-smoke',
    aspectRatio: verticalLayer ? '9:16' : '16:9',
    fps: 60,
    resolution: '1080p',
    tracks: [
      { id: 'video-main', kind: 'video', label: '映像メイン', locked: false, muted: false, hidden: false },
      ...(verticalLayer
        ? [{ id: 'video-upper', kind: 'video', label: '映像サブ', locked: false, muted: false, hidden: false }]
        : []),
      { id: 'bgm', kind: 'audio', label: 'BGM', locked: false, muted: false, hidden: false },
      { id: 'se', kind: 'audio', label: 'SE', locked: false, muted: false, hidden: false },
    ],
    clips: [
      baseClip,
      ...(verticalLayer ? [{
        id: 'upper-clip',
        trackId: 'video-upper',
        assetId: 'smoke-asset',
        start: 0,
        trimStart: 0,
        trimEnd: 1,
        effects: [],
        transform: { x: 15, y: -8, scale: 0.48, rotation: -2, opacity: 0.72 },
      }] : []),
    ],
    markers: [],
    ioRanges: [],
    subtitles: textTransition
      ? [{ id: 'parity-subtitle', start: 0.2, end: 0.9, text: 'Preview = Export' }]
      : [],
    subtitleStyle: {
      fontSize: 5,
      color: '#ffffff',
      outlineColor: '#000000',
      background: 'rgba(0,0,0,0.55)',
      position: 'bottom',
    },
    preRollSec: 0,
    postRollSec: 0,
    verticalReframe: verticalLayer ? 0.25 : 0,
    assets: [{
      id: 'smoke-asset',
      name: path.basename(fixturePath),
      size: source.size,
      kind: 'video',
      // The parity fixture is three seconds long. Keep project metadata at
      // that real duration so the speed-ramp scenario's two-second source
      // trim exercises timeline mapping instead of being rejected as an
      // out-of-bounds clip during project load.
      duration: comparePreview ? 3 : 1,
      path: fixturePath,
    }],
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(projectPath, JSON.stringify(project, null, 2), 'utf8');
}

async function capturePreviewFrame(page, timeSeconds = 0.5) {
  await fs.mkdir(parityDir, { recursive: true });
  const frame = await evaluate(
    page,
    `(async () => {
      const frame = document.querySelector('[data-preview-frame]');
      const video = frame?.querySelector('video');
      if (!frame || !video) return null;
      frame.querySelectorAll('[data-preview-only-ui]').forEach((node) => {
        node.style.visibility = 'hidden';
      });
      if (video.readyState < 2) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('preview metadata timed out')), 30000);
          video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
          video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('preview failed')); }, { once: true });
        });
      }
      const scrubber = document.querySelector('[aria-label="シークバー"]');
      if (scrubber) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(scrubber, String(${Number(timeSeconds)}));
        scrubber.dispatchEvent(new Event('input', { bubbles: true }));
        scrubber.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      const seekTo = (target) => new Promise((resolve, reject) => {
        if (Math.abs(video.currentTime - target) < 1e-4 && !video.seeking) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => reject(new Error('preview seek timed out')), 30000);
        video.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once: true });
        video.currentTime = target;
      });
      if (video.seeking) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('preview state seek timed out')), 30000);
          video.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once: true });
        });
      }
      const expectedMediaTime = video.currentTime;
      await seekTo(Math.max(0, expectedMediaTime - 0.05));
      // Register only after the prior seek has completed, then cause one known
      // presentation by seeking back to the exact source time selected by the
      // editor's timeline mapping.
      const presented = typeof video.requestVideoFrameCallback === 'function'
        ? new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('preview frame presentation timed out')), 30000);
            const waitForTargetFrame = () => video.requestVideoFrameCallback((_now, metadata) => {
              // A callback already queued for the deliberately older frame
              // must never satisfy the capture. Keep waiting until Chromium
              // presents the exact 60 fps fixture frame selected by React.
              if (Math.abs(metadata.mediaTime - expectedMediaTime) <= 1 / 120 + 1e-4) {
                clearTimeout(timeout);
                resolve(metadata.mediaTime);
              } else {
                waitForTargetFrame();
              }
            });
            waitForTargetFrame();
          })
        : Promise.resolve(expectedMediaTime);
      await seekTo(expectedMediaTime);
      const presentedTime = await presented;
      if (Math.abs(presentedTime - expectedMediaTime) > 1 / 120 + 1e-4) {
        throw new Error('preview presented the wrong frame: ' + presentedTime);
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = frame.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(2, Math.round(rect.width)),
        height: Math.max(2, Math.round(rect.height)),
        readyState: video.readyState,
        mediaTime: presentedTime,
      };
    })()`,
  );
  if (!frame || frame.readyState < 2) {
    throw new Error(`preview frame was not ready: ${JSON.stringify(frame)}`);
  }
  const screenshot = await command(page.webSocketDebuggerUrl, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: frame.x, y: frame.y, width: frame.width, height: frame.height, scale: 1 },
  });
  await fs.writeFile(previewFramePath, Buffer.from(screenshot.data, 'base64'));
  return frame;
}

async function comparePreviewAndExport(output, frame, timeSeconds = 0.5) {
  // A browser seek and FFmpeg's CFR resampler may choose opposite neighbours
  // when a speed-remapped source time falls between decoded frames. Compare a
  // strictly bounded ±1 output-frame window and retain the closest presented
  // frame; anything larger remains a real timeline-parity failure.
  const offsets = parityScenario === 'speed-keyframes'
    ? [-1 / 60, 0, 1 / 60]
    : [0];
  const candidates = [];
  for (const [index, offset] of offsets.entries()) {
    const candidatePath = `${exportedFramePath}.${index}.png`;
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(Math.max(0, timeSeconds + offset)), '-i', output,
      '-frames:v', '1',
      '-vf', `scale=${frame.width}:${frame.height}:flags=lanczos,format=rgb24`,
      candidatePath,
    ]);
    const ssimResult = await run(ffmpegPath, [
      '-hide_banner', '-i', previewFramePath, '-i', candidatePath,
      '-lavfi', '[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim',
      '-f', 'null', '-',
    ]);
    const psnrResult = await run(ffmpegPath, [
      '-hide_banner', '-i', previewFramePath, '-i', candidatePath,
      '-lavfi', '[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]psnr',
      '-f', 'null', '-',
    ]);
    candidates.push({
      path: candidatePath,
      offset,
      ssim: Number(/All:([0-9.]+)/.exec(ssimResult.stderr)?.[1]),
      psnr: Number(/average:([0-9.]+)/.exec(psnrResult.stderr)?.[1]),
      diagnostics: `${ssimResult.stderr.slice(-1000)} ${psnrResult.stderr.slice(-1000)}`,
    });
  }
  candidates.sort((a, b) => b.ssim - a.ssim);
  const best = candidates[0];
  const { ssim, psnr } = best;
  if (!Number.isFinite(ssim) || !Number.isFinite(psnr)) {
    throw new Error(`parity metrics were unavailable: ${best.diagnostics}`);
  }
  await fs.copyFile(best.path, exportedFramePath);
  await Promise.all(candidates.map((candidate) => fs.rm(candidate.path, { force: true })));
  if (Math.abs(best.offset) > 1e-9) {
    console.warn(
      `PREVIEW_EXPORT_PARITY_FRAME_OFFSET scenario=${parityScenario} ` +
      `offset=${best.offset.toFixed(6)}s (bounded decoder cadence tolerance)`,
    );
  }
  // Browser video decoding, CSS filters, and FFmpeg filters use different
  // rounding and colour pipelines. These thresholds catch missing effects,
  // black frames, crop/rotation drift, and major colour regressions without
  // treating normal codec noise as a release failure.
  const thresholds = {
    'transform-grade': { ssim: 0.96, psnr: 27.5 },
    'text-transition': { ssim: 0.9, psnr: 20 },
    'vertical-layer': { ssim: 0.94, psnr: 25 },
    'speed-keyframes': { ssim: 0.92, psnr: 23 },
  }[parityScenario] ?? { ssim: 0.96, psnr: 27.5 };
  if (ssim < thresholds.ssim || psnr < thresholds.psnr) {
    const preservedOutput = path.join(parityDir, 'exported.mp4');
    await fs.copyFile(output, preservedOutput);
    throw new Error(
      `preview/export mismatch (SSIM ${ssim.toFixed(6)}, PSNR ${psnr.toFixed(2)} dB, ` +
      `preview media ${frame.mediaTime.toFixed(6)} s); artifacts: ${parityDir}`,
    );
  }
  paritySucceeded = true;
  return {
    scenario: parityScenario,
    ssim,
    psnr,
    frameOffset: best.offset,
    width: frame.width,
    height: frame.height,
  };
}

async function waitForProjectName(expectedName, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const project = JSON.parse(await fs.readFile(projectPath, 'utf8'));
      if (project.name === expectedName) return project;
    } catch {}
    await delay(100);
  }
  throw new Error(`timed out waiting for saved project name: ${expectedName}`);
}

async function cleanup() {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve) => killer.once('close', resolve));
  } else {
    child.kill('SIGKILL');
  }
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch(() => {});
  await fs.rm(outputPath, { force: true }).catch(() => {});
  await fs.rm(projectPath, { force: true }).catch(() => {});
  if (committedOutputPath && committedOutputPath !== outputPath) {
    await fs.rm(committedOutputPath, { force: true }).catch(() => {});
  }
  if (paritySucceeded) {
    await fs.rm(parityDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch(() => {});
  } else if (comparePreview) {
    console.error(`PREVIEW_EXPORT_PARITY_ARTIFACTS ${parityDir}`);
  }
}

async function main() {
  try {
    await writeProjectFixture();
    progress('renderer');
    const page = await findPage();
    await poll(
      page,
      'document.readyState === "complete" && Boolean(document.querySelector(\'input[aria-label="動画または音声ファイルを選択"]\'))',
      Boolean,
    );
    await evaluate(
      page,
      `document.querySelector('[aria-label="動画または音声ファイルを追加"]').click()`,
    );
    progress('import');
    await sendFileToOpenDialog(fixturePath);
    const fileName = path.basename(fixturePath);
    await poll(
      page,
      `document.body.innerText.includes(${JSON.stringify(fileName)}) && !document.body.innerText.includes('読み込み中')`,
      Boolean,
      90_000,
    );
    const added = await evaluate(
      page,
      `(() => {
        const button = document.querySelector(${JSON.stringify(`[aria-label="${fileName}をタイムラインに追加"]`)});
        button?.click();
        return {
          ok: Boolean(button),
          labels: [...document.querySelectorAll('[aria-label]')]
            .map((node) => node.getAttribute('aria-label'))
            .filter(Boolean),
          body: document.body.innerText.slice(0, 3000),
        };
      })()`,
    );
    if (!added?.ok) {
      throw new Error(`timeline add button was not found: ${JSON.stringify(added)}`);
    }
    await poll(
      page,
      'document.querySelectorAll("[data-clip-id]").length',
      (value) => value === 1,
    );

    progress('discard-import');
    const newStarted = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('[aria-label="新しいプロジェクト"]');
        button?.click();
        return Boolean(button && !button.disabled);
      })()`,
    );
    if (!newStarted) throw new Error('new project button was disabled');
    const discarded = await poll(
      page,
      `(() => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.innerText.trim() === '保存せず続行');
        button?.click();
        return Boolean(button);
      })()`,
      Boolean,
    );
    if (!discarded) throw new Error('unsaved project could not be discarded');
    await poll(
      page,
      'document.querySelectorAll("[data-clip-id]").length',
      (value) => value === 0,
    );

    progress('open-project');
    const openStarted = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('[aria-label="プロジェクトを開く"]');
        button?.click();
        return Boolean(button && !button.disabled);
      })()`,
    );
    if (!openStarted) throw new Error('project open button was disabled');
    await sendFileToOpenDialog(projectPath);
    await poll(
      page,
      `document.querySelectorAll("[data-clip-id]").length === ${projectClipCount} &&
       document.body.innerText.includes(${JSON.stringify(fileName)}) &&
       !document.body.innerText.includes('読み込み中')`,
      Boolean,
      90_000,
    );
    await poll(
      page,
      `document.querySelectorAll('[data-media-asset-id]').length === 1`,
      Boolean,
      10_000,
    );

    progress('save');
    const saveStarted = await evaluate(
      page,
      `(() => {
        const input = document.querySelector('input[placeholder="プロジェクト名"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'packaged-roundtrip');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return Boolean(input);
      })()`,
    );
    if (!saveStarted) throw new Error('project name could not be edited');
    await poll(
      page,
      `document.title.startsWith('●')`,
      Boolean,
    );
    await poll(
      page,
      `(() => {
        const button = document.querySelector('[aria-label="保存"]');
        return Boolean(button && !button.disabled);
      })()`,
      Boolean,
    );
    const saveClicked = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('[aria-label="保存"]');
        button?.click();
        return Boolean(button && !button.disabled);
      })()`,
    );
    if (!saveClicked) throw new Error('project save button was disabled');
    const savedProject = await waitForProjectName('packaged-roundtrip');
    await poll(page, `!document.title.startsWith('●')`, Boolean, 30_000);
    if (
      savedProject.clips?.length !== projectClipCount ||
      savedProject.assets?.length !== 1 ||
      !path.isAbsolute(savedProject.assets[0]?.path ?? '')
    ) {
      throw new Error(`saved project was incomplete: ${JSON.stringify(savedProject)}`);
    }
    progress(
      `saved-ids clip=${savedProject.clips[0].assetId} asset=${savedProject.assets[0].id}`,
    );

    progress('new-project');
    await poll(
      page,
      `(() => {
        const button = document.querySelector('[aria-label="新しいプロジェクト"]');
        return Boolean(button && !button.disabled);
      })()`,
      Boolean,
      30_000,
    );
    const resetStarted = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('[aria-label="新しいプロジェクト"]');
        button?.click();
        return Boolean(button && !button.disabled);
      })()`,
    );
    if (!resetStarted) throw new Error('new project button was disabled after save');
    await poll(
      page,
      'document.querySelectorAll("[data-clip-id]").length',
      (value) => value === 0,
    );

    progress('reopen');
    const reopenStarted = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('[aria-label="プロジェクトを開く"]');
        button?.click();
        return Boolean(button && !button.disabled);
      })()`,
    );
    if (!reopenStarted) throw new Error('project reopen button was disabled');
    await sendFileToOpenDialog(projectPath);
    await poll(
      page,
      `document.querySelectorAll("[data-clip-id]").length === ${projectClipCount} &&
       document.body.innerText.includes(${JSON.stringify(fileName)}) &&
       !document.body.innerText.includes('読み込み中')`,
      Boolean,
      90_000,
    );
    await poll(
      page,
      `document.querySelectorAll('[data-media-asset-id]').length === 1`,
      Boolean,
      10_000,
    );
    const reopenedIds = await evaluate(
      page,
      `(() => ({
        clipAssetIds: [...document.querySelectorAll('[data-clip-asset-id]')]
          .map((node) => node.getAttribute('data-clip-asset-id')),
        mediaAssetIds: [...document.querySelectorAll('[data-media-asset-id]')]
          .map((node) => node.getAttribute('data-media-asset-id')),
      }))()`,
    );
    progress(`reopened-ids ${JSON.stringify(reopenedIds)}`);

    let previewFrame = null;
    if (comparePreview) {
      progress('capture-preview');
      previewFrame = await capturePreviewFrame(page, parityTime);
    }

    progress('export-dialog');
    const opened = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('[aria-label="動画を書き出す"]');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`,
    );
    if (!opened) throw new Error('export button was disabled');
    const initial = await poll(
      page,
      `(() => {
        const buttons = [...document.querySelectorAll('button')];
        const gpu = buttons.find((button) => button.innerText.includes('GPU自動'));
        const cpu = buttons.find((button) => button.innerText.includes('CPUのみ'));
        const modal = document.querySelector('[aria-labelledby="export-dialog-title"]');
        return gpu && cpu && modal ? {
          version: window.fce?.appVersion,
          gpuPressed: gpu.getAttribute('aria-pressed'),
          cpuPressed: cpu.getAttribute('aria-pressed'),
          modalWidth: modal.getBoundingClientRect().width,
          modalHeight: modal.getBoundingClientRect().height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        } : null;
      })()`,
      Boolean,
    );
    if (initial.version !== expectedVersion) {
      throw new Error(`unexpected version: ${JSON.stringify(initial)}`);
    }
    if (initial.gpuPressed !== 'true' || initial.cpuPressed !== 'false') {
      throw new Error(`GPU auto was not the default: ${JSON.stringify(initial)}`);
    }
    if (initial.modalWidth > initial.viewportWidth || initial.modalHeight > initial.viewportHeight) {
      throw new Error(`export dialog overflowed the viewport: ${JSON.stringify(initial)}`);
    }
    if (motionBlurSmoke) {
      const blurToggled = await evaluate(
        page,
        `(() => {
          const buttons = [...document.querySelectorAll('button')];
          const on = buttons.find((button) => button.innerText.trim() === 'ON（低速）');
          on?.click();
          return new Promise((resolve) => requestAnimationFrame(() => resolve({
            found: Boolean(on),
            pressed: on?.getAttribute('aria-pressed') ?? null,
          })));
        })()`,
      );
      if (!blurToggled?.found || blurToggled.pressed !== 'true') {
        throw new Error(`motion blur did not toggle: ${JSON.stringify(blurToggled)}`);
      }
    }
    const filenameSet = await evaluate(
      page,
      `(() => {
        const input = document.querySelector('#export-filename');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(path.basename(outputPath))});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input.value;
      })()`,
    );
    if (filenameSet !== path.basename(outputPath)) {
      throw new Error(`export filename was not set: ${filenameSet}`);
    }
    const toggled = await evaluate(
      page,
      `(() => {
        const buttons = [...document.querySelectorAll('button')];
        const gpu = buttons.find((button) => button.innerText.includes('GPU自動'));
        const cpu = buttons.find((button) => button.innerText.includes('CPUのみ'));
        cpu.click();
        return new Promise((resolve) => requestAnimationFrame(() => resolve({
          gpuPressed: gpu.getAttribute('aria-pressed'),
          cpuPressed: cpu.getAttribute('aria-pressed'),
        })));
      })()`,
    );
    if (toggled.gpuPressed !== 'false' || toggled.cpuPressed !== 'true') {
      throw new Error(`CPU preference did not toggle: ${JSON.stringify(toggled)}`);
    }
    const started = await evaluate(
      page,
      `(() => {
        const buttons = [...document.querySelectorAll('button')];
        const gpu = buttons.find((button) => button.innerText.includes('GPU自動'));
        const cpu = buttons.find((button) => button.innerText.includes('CPUのみ'));
        ${comparePreview ? 'cpu' : 'gpu'}.click();
        return new Promise((resolve) => requestAnimationFrame(() => {
          const start = [...document.querySelectorAll('button')]
            .find((button) => button.innerText.trim() === '書き出し開始');
          start?.click();
          resolve(Boolean(start && !start.disabled));
        }));
      })()`,
    );
    if (!started) throw new Error('export start button was disabled');
    progress('export');
    await sendFileToOpenDialog(outputPath);
    const completed = await poll(
      page,
      `(() => ({
        done: document.body.innerText.includes('書き出し完了'),
        failed:
          document.body.innerText.includes('書き出しに失敗しました') ||
          document.body.innerText.includes('元のメディアファイルを確認できません') ||
          Boolean(document.querySelector('summary')),
        badge: document.querySelector('[title="FFmpeg コアモード"]')?.innerText ?? '',
        savedPath: document.querySelector('[aria-labelledby="export-dialog-title"] [title$=".mp4"]')?.getAttribute('title') ?? '',
        body: document.body.innerText.slice(-2000),
      }))()`,
      (value) => value?.done || value?.failed,
      120_000,
    );
    if (!completed.done || completed.failed) {
      const failureDetails = await evaluate(
        page,
        `(() => {
          const details = [...document.querySelectorAll('summary')]
            .find((summary) => summary.innerText.includes('詳細を表示'));
          details?.click();
          return document.body.innerText.slice(-4000);
        })()`,
      );
      throw new Error(
        `packaged export failed: ${JSON.stringify({ ...completed, failureDetails })}`,
      );
    }
    if (comparePreview) {
      if (!completed.badge.includes('CPU')) {
        throw new Error(`software encoder was not reported: ${JSON.stringify(completed)}`);
      }
    } else if (!completed.badge.includes('GPU') || !completed.badge.includes('NVIDIA NVENC')) {
      throw new Error(`hardware encoder was not reported: ${JSON.stringify(completed)}`);
    }
    committedOutputPath = completed.savedPath || outputPath;
    const output = await fs.stat(committedOutputPath);
    if (!output.isFile() || output.size < 12) throw new Error('packaged export was empty');
    const parity = comparePreview
      ? await comparePreviewAndExport(committedOutputPath, previewFrame, parityTime)
      : null;
    progress('complete');
    console.log(`EXPORT_UI_SMOKE_OK ${JSON.stringify({
      ...initial,
      toggled,
      encoderBadge: completed.badge,
      motionBlur: motionBlurSmoke,
      parity,
      outputBytes: output.size,
    })}`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error('EXPORT_UI_SMOKE_FAILED', error);
  process.exitCode = 1;
});
