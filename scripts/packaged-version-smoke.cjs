'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const executable = process.argv[2];
const expectedVersion = process.argv[3];
if (!executable || !expectedVersion) {
  throw new Error('usage: node packaged-version-smoke.cjs <Byux.exe> <version>');
}

const port = 9475;
const marker = `--remote-debugging-port=${port}`;
const profile = path.join(os.tmpdir(), `byux-version-smoke-${Date.now()}`);
const child = spawn(executable, [marker, `--user-data-dir=${profile}`, '--no-first-run'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
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

function evaluate(url, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('evaluation timed out')), 15_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    })));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (message.result?.exceptionDetails) reject(new Error('renderer evaluation failed'));
      else resolve(message.result?.result?.value);
    });
    ws.addEventListener('error', reject);
  });
}

async function cleanup() {
  child.kill();
  if (process.platform === 'win32') {
    const escapedMarker = marker.replaceAll("'", "''");
    const command =
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Byux.exe' -and $_.CommandLine -like '*${escapedMarker}*' } | ` +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    const killer = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve) => killer.once('close', resolve));
  }
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch(() => {});
}

async function main() {
  try {
    const page = await findPage();
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        result = await evaluate(
          page.webSocketDebuggerUrl,
          '({ version: window.fce?.appVersion, title: document.title, ready: document.readyState })',
        );
        if (result?.version) break;
      } catch {}
      await delay(100);
    }
    if (result?.version !== expectedVersion || result?.title !== 'Byux') {
      throw new Error(`unexpected packaged result: ${JSON.stringify(result)}`);
    }
    console.log(`PACKAGED_VERSION_SMOKE_OK ${JSON.stringify(result)}`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error('PACKAGED_VERSION_SMOKE_FAILED', error);
  process.exitCode = 1;
});
