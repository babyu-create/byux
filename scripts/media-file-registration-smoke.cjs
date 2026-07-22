'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const executableArg = process.argv[2];
const fixtureArg = process.argv[3];
const fullImport = process.argv.includes('--full-import');
if (!executableArg || !fixtureArg) {
  throw new Error(
    'usage: node media-file-registration-smoke.cjs <Byux.exe> <media-file> [--full-import]',
  );
}

const executable = path.resolve(executableArg);
const fixturePath = path.resolve(fixtureArg);
const port = 20_000 + (process.pid % 20_000);
const profile = path.join(os.tmpdir(), `byux-media-registration-${Date.now()}`);
const child = spawn(
  executable,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run'],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
);
let childError = null;
let childStderr = '';
child.on('error', (error) => { childError = error; });
child.stderr.on('data', (chunk) => {
  childStderr = `${childStderr}${chunk.toString('utf8')}`.slice(-8_000);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function connect(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl);
    let nextId = 0;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolve({
        command(method, params = {}) {
          return new Promise((commandResolve, commandReject) => {
            const id = ++nextId;
            const timeout = setTimeout(() => {
              pending.delete(id);
              commandReject(new Error(`${method} timed out`));
            }, 30_000);
            pending.set(id, { resolve: commandResolve, reject: commandReject, timeout });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { ws.close(); },
      });
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error || message.result?.exceptionDetails) {
        request.reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      } else {
        request.resolve(message.result);
      }
    });
    ws.addEventListener('error', reject);
  });
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
}

async function main() {
  const stat = await fs.stat(fixturePath);
  if (!stat.isFile()) throw new Error('media fixture is not a regular file');
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    let rendererReady = false;
    for (let attempt = 0; attempt < 200 && !rendererReady; attempt += 1) {
      try {
        const readyResult = await cdp.command('Runtime.evaluate', {
          expression: 'document.readyState === "complete" && Boolean(window.fce?.registerMediaFileFromFile)',
          returnByValue: true,
        });
        rendererReady = readyResult.result?.value === true;
      } catch {}
      if (!rendererReady) await delay(100);
    }
    if (!rendererReady) throw new Error('packaged renderer did not become ready');
    const createdInput = await cdp.command('Runtime.evaluate', {
      expression: `(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'byux-registration-smoke-input';
        document.body.appendChild(input);
        return input;
      })()`,
      returnByValue: false,
    });
    const inputObjectId = createdInput.result?.objectId;
    if (!inputObjectId) throw new Error('diagnostic media input was not created');
    await cdp.command('DOM.enable');
    const documentResult = await cdp.command('DOM.getDocument', { depth: -1 });
    const inputNode = await cdp.command('DOM.querySelector', {
      nodeId: documentResult.root.nodeId,
      selector: '#byux-registration-smoke-input',
    });
    if (!inputNode.nodeId) throw new Error('media input DOM node was not found');
    await cdp.command('DOM.setFileInputFiles', {
      files: [fixturePath],
      nodeId: inputNode.nodeId,
    });
    const evaluated = await cdp.command('Runtime.callFunctionOn', {
      objectId: inputObjectId,
      functionDeclaration: `async function () {
        const file = this.files?.[0];
        if (!file) return { ok: false, error: 'file input is empty' };
        const registration = await window.fce.registerMediaFileFromFile(file);
        if (registration.ok) await window.fce.releaseMediaFile(registration.source.token);
        return {
          ok: registration.ok,
          code: registration.code,
          appVersion: window.fce.appVersion,
          browserSize: file.size,
          browserName: file.name,
          registeredSize: registration.ok ? registration.source.size : null,
          registeredName: registration.ok ? registration.source.name : null,
        };
      }`,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = evaluated.result?.value;
    const report = { diskSize: stat.size, ...result };
    if (!result?.ok) process.exitCode = 1;
    if (result?.ok && fullImport) {
      const refreshedDocument = await cdp.command('DOM.getDocument', { depth: -1 });
      const mediaInput = await cdp.command('DOM.querySelector', {
        nodeId: refreshedDocument.root.nodeId,
        selector: 'input[aria-label="動画または音声ファイルを選択"]',
      });
      if (!mediaInput.nodeId) throw new Error('application media input was not found');
      await cdp.command('DOM.setFileInputFiles', {
        files: [fixturePath],
        nodeId: mediaInput.nodeId,
      });
      const expectedLabel = `${path.basename(fixturePath)}をタイムラインに追加`;
      let importState = null;
      for (let attempt = 0; attempt < 3_600; attempt += 1) {
        const stateResult = await cdp.command('Runtime.evaluate', {
          expression: `(() => ({
            added: Boolean(document.querySelector(${JSON.stringify(`[aria-label="${expectedLabel}"]`)})),
            busy: document.body.innerText.includes('読み込み中') ||
              document.body.innerText.includes('互換プレビューへ変換中'),
            body: document.body.innerText.slice(0, 2_000),
          }))()`,
          returnByValue: true,
        });
        importState = stateResult.result?.value ?? null;
        if (importState?.added || (importState && !importState.busy && attempt > 20)) break;
        await delay(100);
      }
      report.fullImport = {
        ok: importState?.added === true,
        busy: importState?.busy ?? null,
        body: importState?.added ? undefined : importState?.body,
      };
      if (!report.fullImport.ok) process.exitCode = 1;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    cdp.close();
  } finally {
    await cleanup();
  }
}

void main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await cleanup();
});
