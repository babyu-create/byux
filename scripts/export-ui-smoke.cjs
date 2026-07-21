'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const executableArg = process.argv[2];
const fixtureArg = process.argv[3];
const expectedVersion = process.argv[4];
if (!executableArg || !fixtureArg || !expectedVersion) {
  throw new Error('usage: node export-ui-smoke.cjs <Byux.exe> <video-file> <version>');
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
let committedOutputPath = null;
const child = spawn(
  executable,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run'],
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
  const project = {
    version: 1,
    app: 'highlight-maker',
    name: 'packaged-smoke',
    aspectRatio: '16:9',
    fps: 60,
    resolution: '1080p',
    tracks: [
      { id: 'video-main', kind: 'video', label: '映像メイン', locked: false, muted: false, hidden: false },
      { id: 'bgm', kind: 'audio', label: 'BGM', locked: false, muted: false, hidden: false },
      { id: 'se', kind: 'audio', label: 'SE', locked: false, muted: false, hidden: false },
    ],
    clips: [{
      id: 'smoke-clip',
      trackId: 'video-main',
      assetId: 'smoke-asset',
      start: 0,
      trimStart: 0,
      trimEnd: 1,
      effects: [],
    }],
    markers: [],
    ioRanges: [],
    preRollSec: 0,
    postRollSec: 0,
    assets: [{
      id: 'smoke-asset',
      name: path.basename(fixturePath),
      size: source.size,
      kind: 'video',
      duration: 1,
      path: fixturePath,
    }],
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(projectPath, JSON.stringify(project, null, 2), 'utf8');
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
      `document.querySelectorAll("[data-clip-id]").length === 1 &&
       document.body.innerText.includes(${JSON.stringify(fileName)}) &&
       !document.body.innerText.includes('読み込み中')`,
      Boolean,
      90_000,
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
      savedProject.clips?.length !== 1 ||
      savedProject.assets?.length !== 1 ||
      !path.isAbsolute(savedProject.assets[0]?.path ?? '')
    ) {
      throw new Error(`saved project was incomplete: ${JSON.stringify(savedProject)}`);
    }

    progress('new-project');
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
      `document.querySelectorAll("[data-clip-id]").length === 1 &&
       document.body.innerText.includes(${JSON.stringify(fileName)}) &&
       !document.body.innerText.includes('読み込み中')`,
      Boolean,
      90_000,
    );

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
        gpu.click();
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
        failed: document.body.innerText.includes('書き出しに失敗しました'),
        badge: document.querySelector('[title="FFmpeg コアモード"]')?.innerText ?? '',
        savedPath: document.querySelector('[aria-labelledby="export-dialog-title"] [title$=".mp4"]')?.getAttribute('title') ?? '',
        body: document.body.innerText.slice(-2000),
      }))()`,
      (value) => value?.done || value?.failed,
      120_000,
    );
    if (!completed.done || completed.failed) {
      throw new Error(`packaged export failed: ${JSON.stringify(completed)}`);
    }
    if (!completed.badge.includes('GPU') || !completed.badge.includes('NVIDIA NVENC')) {
      throw new Error(`hardware encoder was not reported: ${JSON.stringify(completed)}`);
    }
    committedOutputPath = completed.savedPath || outputPath;
    const output = await fs.stat(committedOutputPath);
    if (!output.isFile() || output.size < 12) throw new Error('packaged export was empty');
    progress('complete');
    console.log(`EXPORT_UI_SMOKE_OK ${JSON.stringify({
      ...initial,
      toggled,
      encoderBadge: completed.badge,
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
