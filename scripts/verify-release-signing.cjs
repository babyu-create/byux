#!/usr/bin/env node

/**
 * Release signing gate.
 *
 * QA packages intentionally remain buildable without a certificate.  Anything
 * published, however, must pass this gate before and after electron-builder.
 * The script never prints secret values; it only reports which requirement is
 * missing.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [, , phase = 'preflight', target = 'win'] = process.argv;
const supportedTargets = new Set(['win', 'mac', 'all']);

if (!['preflight', 'artifacts'].includes(phase) || !supportedTargets.has(target)) {
  console.error('Usage: node scripts/verify-release-signing.cjs <preflight|artifacts> <win|mac|all>');
  process.exit(2);
}

const present = (name) => typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
const oneOf = (...names) => names.some(present);

function requireEnv(names, label) {
  if (!oneOf(...names)) {
    throw new Error(`${label} が未設定です (${names.join(' または ')})`);
  }
}

function verifyWindowsPreflight() {
  requireEnv(['CSC_LINK', 'WIN_CSC_LINK'], 'Windows コード署名証明書 (CSC_LINK)');
  requireEnv(['CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD'], 'Windows 証明書パスワード (CSC_KEY_PASSWORD)');
}

function verifyMacPreflight() {
  requireEnv(['CSC_LINK', 'CSC_NAME'], 'macOS コード署名証明書/ID (CSC_LINK または CSC_NAME)');
  const hasAppleId = present('APPLE_ID') && present('APPLE_APP_SPECIFIC_PASSWORD') && present('APPLE_TEAM_ID');
  const hasApiKey = present('APPLE_API_KEY') && present('APPLE_API_KEY_ID') && present('APPLE_API_ISSUER');
  if (!hasAppleId && !hasApiKey) {
    throw new Error('macOS notarization 情報が未設定です (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID または API キー一式)');
  }
}

function verifyPreflight() {
  if (target === 'win' || target === 'all') verifyWindowsPreflight();
  if (target === 'mac' || target === 'all') verifyMacPreflight();
  console.log(`RELEASE_SIGNING_PREFLIGHT_OK target=${target}`);
}

function verifyWindowsArtifacts() {
  if (process.platform !== 'win32') {
    console.log('RELEASE_SIGNING_ARTIFACTS_SKIPPED target=win reason=not-windows');
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const releaseDir = path.join(process.cwd(), 'release');
  const candidates = [
    path.join(releaseDir, `Byux-Setup-${packageJson.version}.exe`),
    path.join(releaseDir, `Byux-Portable-${packageJson.version}.exe`),
    path.join(releaseDir, 'win-unpacked', 'Byux.exe'),
  ].filter((file) => fs.existsSync(file));

  if (candidates.length === 0) {
    throw new Error('署名確認対象の Windows artifact が release/ にありません');
  }

  const unsigned = [];
  for (const file of candidates) {
    const escaped = file.replace(/'/g, "''");
    let status = '';
    try {
      status = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      throw new Error(`Authenticode の確認に失敗しました: ${path.basename(file)} (${error.message})`);
    }
    if (status !== 'Valid') unsigned.push(`${path.relative(process.cwd(), file)}=${status || 'Unknown'}`);
  }
  if (unsigned.length > 0) {
    throw new Error(`Windows artifact が有効な署名を持ちません: ${unsigned.join(', ')}`);
  }
  console.log(`RELEASE_SIGNING_ARTIFACTS_OK target=win files=${candidates.length}`);
}

function verifyMacArtifacts() {
  if (process.platform !== 'darwin') {
    console.log('RELEASE_SIGNING_ARTIFACTS_SKIPPED target=mac reason=not-macos');
    return;
  }
  const releaseDir = path.join(process.cwd(), 'release');
  const apps = fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(releaseDir, entry.name));
  if (apps.length === 0) throw new Error('署名確認対象の macOS .app が release/ にありません');
  for (const app of apps) {
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`macOS artifact の署名確認に失敗しました: ${path.basename(app)} (${error.message})`);
    }
  }
  console.log(`RELEASE_SIGNING_ARTIFACTS_OK target=mac files=${apps.length}`);
}

try {
  if (phase === 'preflight') {
    verifyPreflight();
  } else {
    if (target === 'win' || target === 'all') verifyWindowsArtifacts();
    if (target === 'mac' || target === 'all') verifyMacArtifacts();
  }
} catch (error) {
  console.error(`RELEASE_SIGNING_FAILED: ${error.message}`);
  console.error('QA確認だけの場合は npm run package:win を使用し、公開前に証明書と秘密情報をCI secretへ登録してください。');
  process.exit(1);
}
