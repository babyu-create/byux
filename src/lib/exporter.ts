// MP4 export pipeline using FFmpeg.wasm.
//
// Architecture: single-pass filter_complex that processes all clips in one
// ffmpeg.exec call. This eliminates the N×individual-encode + concat pattern
// that was the primary bottleneck (each intermediate vclip_N.mp4 incurred a
// full libx264 encode + WASM-FS write, then a second read during concat).
//
// Every source is normalized through libx264 so the requested geometry, FPS,
// trim points, mute/volume settings, and output codec are authoritative.
//
// Motion blur: opt-in tblend post-process pass with variable intensity (1–3
// chained tblend stages driven by the intensity slider on each clip's
// motion-blur effect).

import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import type { Clip, KillMarker, MediaAsset, Track } from './types';
import {
  buildDuckPoints,
  buildDuckVolumeExpr,
  hasDucking,
  resolveDucking,
  type AudioDucking,
  type DuckSegment,
} from './audioDucking';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { exportStrengthFromIntensity, type HudPreset } from './motionBlurCore';
import { OffscreenMotionBlurRenderer } from './motionBlurExporter';
import { OffscreenTransformRenderer } from './transformExporter';
import {
  clipHasTransform,
  isTransformVisible,
  sampleClipTransform,
  type ResolvedTransform,
} from './clipTransform';
import { clipHasColorGrade, colorGradeFilter } from './colorGrade';
import { clipHasTransition, transitionModulationAt } from './transitions';
import {
  hasSpeedRamp,
  makeRampSampler,
} from './speedRamp';
import { rasterizeOverlays } from './overlayRaster';
import {
  buildOverlayFilterParts,
  introForClipOverlays,
  type ClipOverlayIntro,
} from './overlayText';

export type ExportQualityPreset = 'recommended' | 'high' | 'compact';

interface VideoEncodingSettings {
  preset: 'veryfast' | 'superfast';
  crf: number;
  bitrateMultiplier: number;
}

function getVideoEncodingSettings(
  quality: ExportQualityPreset | undefined,
): VideoEncodingSettings {
  if (quality === 'high') {
    return { preset: 'veryfast', crf: 16, bitrateMultiplier: 1.45 };
  }
  if (quality === 'compact') {
    return { preset: 'superfast', crf: 27, bitrateMultiplier: 0.62 };
  }
  return { preset: 'superfast', crf: 20, bitrateMultiplier: 1 };
}

export interface ExportOptions {
  resolution: '720p' | '1080p';
  fps: 30 | 60;
  aspectRatio: '16:9' | '9:16';
  /** Human-facing quality/speed preset. Defaults to the balanced preset. */
  quality?: ExportQualityPreset;
  /**
   * Include motion-blur in export. Default off. When enabled the export
   * applies the SAME WebGL directional motion-blur the preview uses (per-frame
   * GL pass), so the output matches what the user saw. If WebGL is unavailable
   * or the clip is too long to process frame-by-frame, it falls back to the
   * legacy `tblend` frame-average pass.
   */
  motionBlur?: boolean;
  /**
   * Blur strength (preview-equivalent units). When omitted, derived from the
   * first motion-blur clip's stored intensity and speed via
   * {@link exportStrengthFromIntensity} so it matches the preview.
   */
  motionBlurStrength?: number;
  /** HUD positional-protect preset for the export blur. Defaults to 'valorant'. */
  motionBlurHudPreset?: HudPreset;
  /** HUD mask attenuation 0..1. Defaults to 1 (0 when preset is 'none'). */
  motionBlurHudMaskStrength?: number;
  /**
   * Horizontal reframe (-1..1, 0=center) used only for a vertical (9:16)
   * output: the landscape source is scaled to cover and cropped, and this
   * pans which horizontal slice is kept. Ignored for landscape output.
   */
  verticalReframe?: number;
  /**
   * Optional project-level BGM auto-ducking (Phase P5). When enabled, the BGM
   * track's clips are dipped around each kill marker in the audio mix pass via
   * a `volume=...:eval=frame` expression — matching the preview's best-effort
   * ducking. Absent / disabled = full-level BGM (no ducking).
   */
  audioDucking?: AudioDucking;
  /** Cancels long-running FFmpeg/WebCodecs work and leaves no successful output. */
  signal?: AbortSignal;
  onProgress?: (info: { stage: string; percent: number; log?: string }) => void;
}

export interface ExportInput {
  clips: Clip[];
  tracks: Track[];
  assets: MediaAsset[];
  /**
   * Source-time kill markers (Phase P5). Used to compute BGM duck points when
   * {@link ExportOptions.audioDucking} is enabled. Optional — absent = no
   * ducking even if the setting is on (nothing to duck around).
   */
  markers?: KillMarker[];
}

// ---------------------------------------------------------------------------
// FFmpeg singleton — variant stored alongside the instance to avoid a
// separate mutable global that could race when concurrent exports are started.
// ---------------------------------------------------------------------------

interface FFmpegHandle {
  ffmpeg: FFmpeg;
  variant: 'mt' | 'st';
  /** Navigator hardware concurrency at load time (for UI display). */
  threadCount: number;
}

let ffmpegHandle: FFmpegHandle | null = null;
let loadPromise: Promise<FFmpegHandle> | null = null;
let loadingFFmpeg: FFmpeg | null = null;
let ffmpegGeneration = 0;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('書き出しが中止されました');
  error.name = 'AbortError';
  throw error;
}

// Local MT core (copied from node_modules by vite.config.ts copyMtCore plugin).
// Using local files means CDN is never hit — no unpkg.com latency, no proxy
// blocks, no 10-second timeout races.
// Root-absolute paths break under Electron's file:// production load (they'd
// resolve against the filesystem root, not the app's dist folder) — prefix
// with BASE_URL ('./' per vite.config.ts) the same way the app icon was
// fixed earlier, so this works under both http:// (dev) and file:// (packaged).
const LOCAL_MT_CORE_JS = `${import.meta.env.BASE_URL}lib/mt/ffmpeg-core.js`;
const LOCAL_MT_CORE_WASM = `${import.meta.env.BASE_URL}lib/mt/ffmpeg-core.wasm`;
const LOCAL_MT_CORE_WORKER = `${import.meta.env.BASE_URL}lib/mt/ffmpeg-core.worker.js`;

// Local single-threaded fallbacks (pre-existing in public/lib/).
const LOCAL_ST_CORE_JS = `${import.meta.env.BASE_URL}lib/ffmpeg-core.js`;
const LOCAL_ST_CORE_WASM = `${import.meta.env.BASE_URL}lib/ffmpeg-core.wasm`;

/** Public read-only — UI can show "MT (4 threads)" vs "ST (single)". */
export function getActiveCoreVariant(): 'mt' | 'st' {
  return ffmpegHandle?.variant ?? 'st';
}

/** Returns the thread count used by the active MT core (1 when ST). */
export function getActiveCoreThreadCount(): number {
  return ffmpegHandle?.threadCount ?? 1;
}

/**
 * Drop the cached FFmpeg singleton so the next exportProject call starts
 * fresh. Call after an exec failure that may have corrupted the WASM
 * instance (OOM inside the core, filter-graph deadlock, etc.) — without
 * this, getFFmpeg keeps returning the dead handle and subsequent exports
 * silently fail.
 */
export function resetFFmpeg(): void {
  ffmpegGeneration += 1;
  try {
    ffmpegHandle?.ffmpeg.terminate();
  } catch {
    // The worker may already be gone after an OOM or explicit cancellation.
  }
  try {
    loadingFFmpeg?.terminate();
  } catch {
    // Same as above.
  }
  ffmpegHandle = null;
  loadingFFmpeg = null;
  loadPromise = null;
}

function canUseSab(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof globalThis.crossOriginIsolated !== 'undefined' &&
    globalThis.crossOriginIsolated === true
  );
}

const LOAD_TIMEOUT_MS = 15000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} がタイムアウトしました (${ms}ms)`));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function tryLoadMtLocal(
  ffmpeg: FFmpeg,
  onProgress?: ExportOptions['onProgress'],
): Promise<boolean> {
  if (!canUseSab()) {
    const msg = '[exporter] SharedArrayBuffer 利用不可 — MT をスキップ (COOP/COEP 未設定の可能性)';
    console.info(msg);
    onProgress?.({ stage: 'MT 不可 → ST へ', percent: -1, log: msg });
    return false;
  }
  onProgress?.({
    stage: 'MT コア読み込み中 (local)',
    percent: -1,
    log: '[exporter] loading MT core from /lib/mt/ (no CDN)',
  });
  try {
    const [coreURL, wasmURL, workerURL] = await withTimeout(
      Promise.all([
        toBlobURL(LOCAL_MT_CORE_JS, 'text/javascript'),
        toBlobURL(LOCAL_MT_CORE_WASM, 'application/wasm'),
        toBlobURL(LOCAL_MT_CORE_WORKER, 'text/javascript'),
      ]),
      LOAD_TIMEOUT_MS,
      'MT core blob URL',
    );
    await withTimeout(
      ffmpeg.load({ coreURL, wasmURL, workerURL }),
      LOAD_TIMEOUT_MS,
      'MT core init',
    );
    return true;
  } catch (e) {
    console.warn('[exporter] MT local load failed:', e);
    const msg = `[exporter] MT コア読み込み失敗 (${e instanceof Error ? e.message : String(e)}) — ST へフォールバック`;
    onProgress?.({ stage: 'MT 失敗 → ST', percent: -1, log: msg });
    return false;
  }
}

async function getFFmpeg(onProgress?: ExportOptions['onProgress']): Promise<FFmpegHandle> {
  if (ffmpegHandle) return ffmpegHandle;
  if (loadPromise) return loadPromise;
  const generation = ffmpegGeneration;
  loadPromise = (async (): Promise<FFmpegHandle> => {
    const ffmpeg = new FFmpeg();
    loadingFFmpeg = ffmpeg;

    // Try local MT core first (CDN-free path).
    if (await tryLoadMtLocal(ffmpeg, onProgress)) {
      if (generation !== ffmpegGeneration) {
        ffmpeg.terminate();
        throw new Error('書き出しが中止されました');
      }
      const threadCount = navigator.hardwareConcurrency ?? 4;
      const handle: FFmpegHandle = { ffmpeg, variant: 'mt', threadCount };
      loadingFFmpeg = null;
      ffmpegHandle = handle;
      onProgress?.({
        stage: `MT コア起動 (${threadCount} スレッド)`,
        percent: -1,
        log: `[exporter] MT ready — hardwareConcurrency=${threadCount}`,
      });
      return handle;
    }

    // ST fallback — local files only.
    onProgress?.({
      stage: 'ST コア読み込み中 (local)',
      percent: -1,
      log: '[exporter] loading bundled ST core',
    });
    try {
      const [coreBlob, wasmBlob] = await withTimeout(
        Promise.all([
          toBlobURL(LOCAL_ST_CORE_JS, 'text/javascript'),
          toBlobURL(LOCAL_ST_CORE_WASM, 'application/wasm'),
        ]),
        LOAD_TIMEOUT_MS,
        'ST core blob URL',
      );
      await withTimeout(
        ffmpeg.load({ coreURL: coreBlob, wasmURL: wasmBlob }),
        LOAD_TIMEOUT_MS,
        'ST core init',
      );
    } catch (localErr) {
      const msg = `[exporter] ローカル ST コア読み込み失敗: ${localErr instanceof Error ? localErr.message : String(localErr)}`;
      onProgress?.({ stage: 'ST (local) 失敗', percent: -1, log: msg });
      throw new Error(
        `FFmpeg 初期化失敗 — 同梱の動画処理コアを読み込めませんでした。\n詳細: ${localErr instanceof Error ? localErr.message : String(localErr)}`,
        { cause: localErr },
      );
    }
    if (generation !== ffmpegGeneration) {
      ffmpeg.terminate();
      throw new Error('書き出しが中止されました');
    }
    const handle: FFmpegHandle = { ffmpeg, variant: 'st', threadCount: 1 };
    loadingFFmpeg = null;
    ffmpegHandle = handle;
    return handle;
  })().catch((err) => {
    // Reset so the next call can retry from scratch.
    loadingFFmpeg = null;
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

async function execChecked(
  ffmpeg: FFmpeg,
  args: string[],
  operation: string,
): Promise<void> {
  const status = await ffmpeg.exec(args);
  if (status !== 0) {
    throw new Error(`${operation}に失敗しました (FFmpeg終了コード: ${status})`);
  }
}

export function getResolution(
  resolution: '720p' | '1080p',
  aspect: '16:9' | '9:16',
): { width: number; height: number } {
  if (aspect === '16:9') {
    return resolution === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  }
  return resolution === '1080p' ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
}

/** Build an atempo filter chain that supports any speed by chaining 0.5x or 2.0x stages. */
export function buildAtempoChain(speed: number): string[] {
  if (Math.abs(speed - 1) < 1e-3) return [];
  const result: string[] = [];
  let s = speed;
  while (s < 0.5) {
    result.push('atempo=0.5');
    s /= 0.5;
  }
  while (s > 2) {
    result.push('atempo=2.0');
    s /= 2;
  }
  if (Math.abs(s - 1) > 1e-3) {
    result.push(`atempo=${s.toFixed(4)}`);
  }
  return result;
}

// Derive a SAFE virtual-filesystem extension from a user-supplied filename.
// The raw extension flows into ffmpeg `-i` names and filter-graph strings, so
// we strip everything but alphanumerics (a crafted name like `mp4];drawtext=...`
// could otherwise perturb the graph) and cap the length.
function safeExt(fileName: string, fallback: string): string {
  const raw = fileName.split('.').pop() ?? fallback;
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return cleaned || fallback;
}

const MAX_AUTOMATIC_PROXY_BYTES = 768 * 1024 * 1024;

/**
 * Convert a video Chromium cannot preview (common with AVI/MKV codecs) to a
 * lightweight H.264/AAC proxy. The caller keeps the original File for final
 * export; this result is only used by <video> during editing.
 */
export async function createPreviewProxy(
  file: File,
  onProgress?: (stage: string) => void,
): Promise<File> {
  if (file.size > MAX_AUTOMATIC_PROXY_BYTES) {
    throw new Error(
      `${file.name} はプレビュー非対応の形式で、互換変換には大きすぎます ` +
      `(${Math.round(file.size / (1024 * 1024))} MB)。H.264/AAC のMP4へ変換してから追加してください。`,
    );
  }

  onProgress?.('互換コーデックを準備中…');
  const { ffmpeg } = await getFFmpeg((info) => onProgress?.(info.stage));
  const token = crypto.randomUUID().replaceAll('-', '');
  const inputName = `proxy_in_${token}.${safeExt(file.name, 'bin')}`;
  const outputName = `proxy_out_${token}.mp4`;
  try {
    onProgress?.(`${file.name} をプレビュー用に変換中…`);
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    const status = await ffmpeg.exec([
      '-threads', '1',
      '-i', inputName,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', "scale='min(1280,iw)':-2",
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '27',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-movflags', '+faststart',
      '-y',
      outputName,
    ]);
    if (status !== 0) throw new Error(`FFmpeg終了コード: ${status}`);
    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array
      ? new Uint8Array(data)
      : new TextEncoder().encode(String(data));
    return new File([bytes], `${file.name}.preview.mp4`, { type: 'video/mp4' });
  } catch (error) {
    throw new Error(
      `${file.name} の互換変換に失敗しました。H.264/AAC のMP4へ変換してから追加してください。` +
      ` (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }
  }
}

// The old stream-copy fast path inferred H.264 from the container MIME and did
// not know the source FPS/audio codec. It could therefore ignore a requested
// 60fps conversion, clip mute/volume, or copy HEVC/ProRes into the result.
// Correct output is more important than that optimisation; every export now
// uses the normalized encode path until real stream metadata is probed.

// ---------------------------------------------------------------------------
// Clip-level filter builder
// ---------------------------------------------------------------------------

interface ClipFilterSpec {
  inputIndex: number;
  clip: Clip;
  asset: MediaAsset;
  width: number;
  height: number;
  targetFps: number;
  videoTrackMuted: boolean;
  /** False when the container has no audio stream; a stereo silence track is generated. */
  hasAudio: boolean;
  /** Horizontal reframe -1..1 for vertical (portrait) crop-to-fill. */
  reframe: number;
  vOutLabel: string;
  aOutLabel: string;
}

/**
 * Produces the filter_complex fragment that processes a single clip's video
 * and audio streams and maps them to the given output labels.
 *
 * Video graph: trim → setpts → [speed?] → [scale+pad?] → setsar → fps → [fade?]
 * Audio graph: atrim → asetpts → [atempo?] → volume
 */
function buildClipFilters(spec: ClipFilterSpec): string {
  const { inputIndex, clip, asset, width, height, targetFps } = spec;
  const { videoTrackMuted, reframe, vOutLabel, aOutLabel } = spec;

  const speed = clip.speed ?? 1;
  const clipMuted = clip.muted ?? false;
  const clipVolume = clipMuted || videoTrackMuted ? 0 : (clip.volume ?? 1);
  const timelineDur = (clip.trimEnd - clip.trimStart) / speed;

  const vFilters: string[] = [];
  vFilters.push(`trim=${clip.trimStart.toFixed(4)}:${clip.trimEnd.toFixed(4)}`);
  vFilters.push('setpts=PTS-STARTPTS');

  if (Math.abs(speed - 1) > 1e-3) {
    vFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  }

  // Skip identity scale — even a no-op scale touches every pixel in WASM.
  // Compatibility proxies are deliberately smaller than the original. Their
  // dimensions describe only the editor preview, while FFmpeg receives the
  // original source for export, so never use an exact proxy-size match to skip
  // the output scale/crop step.
  const sourceMatchesOutput =
    !asset.previewProxy && asset.width === width && asset.height === height;
  const outIsPortrait = height > width;
  const srcW = asset.width ?? 0;
  const srcH = asset.height ?? 0;
  const srcWiderThanOut =
    srcW > 0 && srcH > 0 && srcW / srcH > width / height + 1e-3;
  if (clip.stretchToFill) {
    // Stretch-to-fill: scale to the exact output dimensions IGNORING aspect
    // ratio (non-uniform). Reproduces VALORANT "stretched" play — a 4:3
    // recording (e.g. 1440x1080) becomes a full 16:9 frame, wider, no bars.
    vFilters.push(`scale=${width}:${height}`);
  } else if (outIsPortrait && srcWiderThanOut) {
    // Vertical (9:16) fill: scale the landscape source to COVER the portrait
    // frame, then crop horizontally. `reframe` (-1..1) pans the kept slice so
    // the crosshair/action stays in view (t: -1→left edge, 0→center, 1→right).
    const t = ((Math.max(-1, Math.min(1, reframe)) + 1) / 2).toFixed(4);
    vFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`);
    vFilters.push(`crop=${width}:${height}:(iw-ow)*${t}:(ih-oh)/2`);
  } else if (!sourceMatchesOutput) {
    vFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
    vFilters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  }
  vFilters.push('setsar=1');
  vFilters.push(`fps=${targetFps}`);

  // Fades.
  const fadeIn = clip.effects.find((e) => e.type === 'fade-in');
  if (fadeIn) {
    const d = Math.max(0.05, fadeIn.duration ?? 0.4);
    vFilters.push(`fade=t=in:st=0:d=${d.toFixed(3)}`);
  }
  const fadeOut = clip.effects.find((e) => e.type === 'fade-out');
  if (fadeOut) {
    const d = Math.max(0.05, fadeOut.duration ?? 0.4);
    const fadeStart = Math.max(0, timelineDur - d);
    vFilters.push(`fade=t=out:st=${fadeStart.toFixed(3)}:d=${d.toFixed(3)}`);
  }

  const vChain = `[${inputIndex}:v]${vFilters.join(',')}${vOutLabel}`;
  let aChain: string;
  if (spec.hasAudio) {
    const aFilters: string[] = [];
    aFilters.push(`atrim=${clip.trimStart.toFixed(4)}:${clip.trimEnd.toFixed(4)}`);
    aFilters.push('asetpts=PTS-STARTPTS');
    aFilters.push(...buildAtempoChain(speed));
    aFilters.push(`volume=${clipVolume.toFixed(3)}`);
    aChain = `[${inputIndex}:a]${aFilters.join(',')}${aOutLabel}`;
  } else {
    // concat=v=1:a=1 requires one audio pad per clip. Supplying finite silence
    // keeps screen recordings without a microphone/audio stream exportable and
    // also gives the later BGM mixer a stable base audio stream.
    aChain =
      `anullsrc=r=44100:cl=stereo,atrim=0:${timelineDur.toFixed(4)},` +
      `asetpts=PTS-STARTPTS,volume=${clipVolume.toFixed(3)}${aOutLabel}`;
  }
  return `${vChain};${aChain}`;
}

/**
 * Read only FFmpeg's container headers to determine whether an input has an
 * audio stream. Chromium metadata APIs do not expose this reliably, especially
 * for AVI/MKV, while the export core must know before building filter labels.
 */
async function probeInputHasAudio(ffmpeg: FFmpeg, inputName: string): Promise<boolean> {
  const messages: string[] = [];
  const handler = ({ message }: { message: string }) => messages.push(message);
  ffmpeg.on('log', handler);
  try {
    await ffmpeg.exec([
      '-hide_banner',
      '-i', inputName,
      '-map', '0:a:0?',
      '-t', '0.001',
      '-f', 'null',
      '-',
    ]);
  } catch {
    // FFmpeg may report a non-zero status when an optional map finds no stream.
    // The input header printed before that status is still authoritative.
  } finally {
    ffmpeg.off('log', handler);
  }
  return messages.some((message) => message.includes('Stream #') && message.includes('Audio:'));
}

// ---------------------------------------------------------------------------
// tblend intensity → pass count
// ---------------------------------------------------------------------------

/**
 * Maps a motion-blur intensity (0–100) to the number of chained tblend passes.
 *
 *   0–33  → 1 pass  (subtle, ~3-frame average)
 *  34–66  → 2 passes (medium)
 *  67–100 → 3 passes (heavy)
 *
 * Each additional pass roughly doubles the temporal blur window.
 * Three passes begins to ghost on very fast pans — kept as an opt-in maximum.
 */
function tblendPassCount(intensity: number): number {
  if (intensity >= 67) return 3;
  if (intensity >= 34) return 2;
  return 1;
}

/** Build the tblend vf string for a given pass count. */
function buildTblendFilter(passCount: number): string {
  return Array.from({ length: passCount }, () => 'tblend=all_mode=average').join(',');
}

// ---------------------------------------------------------------------------
// Motion-blur application (WebGL primary, tblend fallback)
// ---------------------------------------------------------------------------

/**
 * Above this many frames we skip the per-frame WebGL pass (which materialises
 * a PNG per frame in the WASM filesystem) and fall back to tblend. The tool's
 * primary use case — short FPS kill clips — sits comfortably under this; the
 * cap protects against OOM on long timelines.
 *   1200 frames ≈ 20s @ 60fps ≈ 40s @ 30fps.
 */
const MAX_WEBGL_BLUR_FRAMES = 1200;

// Dev-only motion-blur tracing. Compiled out of production builds (Vite
// statically replaces import.meta.env.DEV), so these never run for end users.
const MB_DEBUG = import.meta.env?.DEV ?? false;
function mbLog(...args: unknown[]): void {
  if (MB_DEBUG) console.info(...args);
}

interface MotionBlurParams {
  width: number;
  height: number;
  targetFps: number;
  totalVideoSeconds: number;
  /** Stored 0..100 intensity of the first motion-blur clip. */
  intensity: number;
  /** Playback speed of that clip (for strength scaling). */
  speed: number;
  /** Explicit strength override (preview value); when undefined it's derived. */
  strengthOverride?: number;
  /**
   * Output-timeline segments at their authored absolute positions. When supplied, the
   * WebGL pass gates the blur PER SEGMENT — each output frame uses its owning
   * clip's own intensity*speed (0 → sharp for clips with no motion-blur
   * effect), matching the preview. When omitted, the blur is applied globally
   * at `strengthOverride`/derived strength (legacy whole-video behaviour, used
   * by the tblend fallback which cannot vary strength per frame).
   */
  segments?: TransformSegment[];
  hudPreset: HudPreset;
  hudMaskStrength: number;
  encoding: VideoEncodingSettings;
  signal?: AbortSignal;
  onProgress?: ExportOptions['onProgress'];
}

// Candidate H.264 codec strings, most-capable first. We probe each with
// VideoEncoder.isConfigSupported and use the first the platform accepts so a
// 1080p60 export gets a high-enough level (avc1.640034 = High@5.2) while older
// GPUs can still fall back to a baseline profile.
const AVC_CODEC_CANDIDATES = [
  'avc1.640034', // High @ L5.2
  'avc1.64002A', // High @ L4.2 (1080p60)
  'avc1.640028', // High @ L4.0 (1080p30)
  'avc1.4D4028', // Main @ L4.0
  'avc1.42E01E', // Baseline @ L3.0
];

/** Choose a target H.264 bitrate from the output geometry (bits/pixel·frame). */
function pickBitrate(
  width: number,
  height: number,
  fps: number,
  multiplier = 1,
): number {
  const raw = width * height * fps * 0.1 * multiplier;
  return Math.round(Math.max(4_000_000, Math.min(24_000_000, raw)));
}

/** Return the first AVC codec string the platform's VideoEncoder supports. */
async function pickAvcCodec(base: { width: number; height: number; bitrate: number; framerate: number }): Promise<string | null> {
  for (const codec of AVC_CODEC_CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec, ...base });
      if (support.supported) return codec;
    } catch {
      // Unsupported descriptor — try the next candidate.
    }
  }
  return null;
}

/** Resolve when `video` fires `event` once; reject on media error. */
function videoOnce(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error(`video "${event}" failed`)); };
    const cleanup = () => {
      video.removeEventListener(event, onOk);
      video.removeEventListener('error', onErr);
    };
    video.addEventListener(event, onOk, { once: true });
    video.addEventListener('error', onErr, { once: true });
  });
}

/** Seek `video` to time `t` (seconds) and resolve once the frame is ready. */
function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('video seek failed')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onErr, { once: true });
    try {
      video.currentTime = t;
    } catch (e) {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Apply the preview-matching WebGL directional motion blur to `videoInput`.
 *
 * Pipeline:
 *   1. The finished (trimmed/scaled/concatenated) video is decoded NATIVELY by
 *      a hidden <video> element — Chromium's hardware H.264 decoder. We seek to
 *      each frame's mid-time and read it. (ffmpeg.wasm's image2 PNG extraction
 *      hung indefinitely in MEMFS — never resolving — so it was removed.)
 *   2. Each decoded frame runs through the shared shader
 *      (OffscreenMotionBlurRenderer) and is fed straight into a WebCodecs
 *      VideoEncoder; mp4-muxer assembles the encoded chunks in memory.
 *   3. ffmpeg stream-copies the original audio onto the blurred video.
 *
 * Throws (→ caller falls back to tblend) if WebCodecs is unavailable, no AVC
 * config is supported, the video can't be read, or a seek times out.
 */
async function applyWebglMotionBlur(
  ffmpeg: FFmpeg,
  videoInput: string,
  params: MotionBlurParams,
): Promise<string> {
  const { width, height, targetFps, hudPreset, hudMaskStrength, onProgress } = params;
  const strength = params.strengthOverride ??
    exportStrengthFromIntensity(params.intensity, params.speed);

  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('motion-blur: WebCodecs (VideoEncoder) 利用不可');
  }

  // Load the normalized video into a hidden <video> for native decode.
  onProgress?.({ stage: 'モーションブラー: 動画を読み込み中', percent: -1 });
  mbLog('[mb] reading normalized video for native decode');
  const data = await ffmpeg.readFile(videoInput);
  const u8 = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  // Blob rejects SharedArrayBuffer-backed views (the MT core hands those back),
  // so copy to a plain ArrayBuffer ONLY in that case. The common single-thread
  // path passes through copy-free — avoiding the old unconditional ~50-100 MB
  // transient allocation per export.
  const blobPart: BlobPart = u8.buffer instanceof ArrayBuffer
    ? (u8 as Uint8Array<ArrayBuffer>)
    : new Uint8Array(u8);
  const url = URL.createObjectURL(new Blob([blobPart], { type: 'video/mp4' }));
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  // Register the 'loadeddata' listener IMMEDIATELY (synchronously, before any
  // await) — otherwise the event can fire during the pickAvcCodec await gap on
  // a fast machine and we'd miss it, hit the 15s timeout, and silently fall
  // back to tblend. videoOnce attaches its listener synchronously here.
  const loadedPromise = videoOnce(video, 'loadeddata');

  const bitrate = pickBitrate(width, height, targetFps, params.encoding.bitrateMultiplier);
  const codec = await pickAvcCodec({ width, height, bitrate, framerate: targetFps });
  mbLog(`[mb] codec=${codec} bitrate=${bitrate} ${width}x${height}@${targetFps}`);
  if (!codec) {
    // Swallow the dangling loadeddata promise so revoking the URL (which may
    // fire a media 'error') doesn't surface as an unhandled rejection.
    loadedPromise.catch(() => {});
    URL.revokeObjectURL(url);
    throw new Error('motion-blur: 対応する H.264 エンコーダ設定が見つかりません');
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: targetFps },
    // in-memory faststart so the moov atom is at the front (web/QuickTime seek).
    fastStart: 'in-memory',
  });
  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure({ codec, width, height, bitrate, framerate: targetFps });
  mbLog('[mb] encoder configured; loading video metadata');

  const renderer = new OffscreenMotionBlurRenderer(width, height, {
    strength,
    hudPreset,
    hudMaskStrength,
  });

  const frameDurUs = Math.round(1_000_000 / targetFps);
  const gop = Math.max(1, targetFps * 2); // keyframe every ~2s

  try {
    // +faststart on the source encode keeps moov up front so this resolves
    // quickly. Time-bounded so a bad file can't hang the export forever.
    // (Listener was attached above, right after video.src, to avoid a race.)
    await withTimeout(loadedPromise, 15000, '動画メタデータ読み込み');
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration === 0) {
      throw new Error('motion-blur: 動画の長さを取得できませんでした');
    }
    const total = Math.max(1, Math.round(duration * targetFps));
    mbLog(`[mb] native decode: duration=${duration.toFixed(2)}s total≈${total} frames`);

    for (let i = 0; i < total; i++) {
      throwIfAborted(params.signal);
      if (encoderError) throw encoderError;
      // Seek to the middle of frame i so we land squarely on it, not a boundary.
      const t = (i + 0.5) / targetFps;
      if (t >= duration) break;
      await withTimeout(seekVideo(video, t), 10000, `フレーム seek #${i}`);

      let frame: VideoFrame | null = null;
      try {
        // Per-segment gating: when segments are supplied, the strength for THIS
        // output frame is its owning clip's own intensity*speed (0 → sharp for
        // clips with no motion-blur effect), matching the preview. The frame
        // mid-time `t` is the output-timeline position. When no segments are
        // supplied, fall back to the renderer's constant config strength.
        const frameStrength = params.segments
          ? motionBlurStrengthAtOutputTime(params.segments, t, params.strengthOverride)
          : undefined;
        const rgba = renderer.processFrame(video, frameStrength);
        frame = new VideoFrame(rgba, {
          format: 'RGBA',
          codedWidth: width,
          codedHeight: height,
          timestamp: i * frameDurUs,
          duration: frameDurUs,
        });
        encoder.encode(frame, { keyFrame: i % gop === 0 });
      } finally {
        if (frame) frame.close();
      }

      // Backpressure — don't let the encode queue grow unbounded (memory).
      while (encoder.encodeQueueSize > 16) {
        await new Promise<void>((r) => setTimeout(r, 4));
        if (encoderError) throw encoderError;
      }

      if (i % 30 === 0) {
        mbLog(`[mb] frame ${i + 1}/${total} queue=${encoder.encodeQueueSize}`);
      }
      if (i % 5 === 0 || i === total - 1) {
        onProgress?.({
          stage: `モーションブラー適用中 (${i + 1}/${total})`,
          percent: Math.max(0, Math.min(0.85, (i + 1) / total * 0.85)),
        });
      }
    }

    mbLog('[mb] loop done; flushing encoder');
    onProgress?.({ stage: 'モーションブラー: エンコード仕上げ中', percent: 0.88 });
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
    mbLog('[mb] encoder flushed + muxer finalized');
  } finally {
    renderer.dispose();
    try { encoder.close(); } catch { /* already closed / errored */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }

  const videoBytes = new Uint8Array(muxer.target.buffer);
  mbLog(`[mb] muxed video bytes=${videoBytes.length}; muxing audio`);

  // Stream-copy the original audio onto the blurred video — no transcode, fast
  // and lossless. `1:a:0?` makes the audio optional (silent sources export OK).
  onProgress?.({ stage: 'モーションブラー: 音声を結合中', percent: 0.92 });
  const MB_VIDEO = 'mb_video.mp4';
  await ffmpeg.writeFile(MB_VIDEO, videoBytes);
  const blurredOutput = 'video_blurred.mp4';
  await execChecked(ffmpeg, [
    '-threads', '1',
    '-i', MB_VIDEO,
    '-i', videoInput,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    blurredOutput,
  ], 'モーションブラー映像と音声の結合');
  try { await ffmpeg.deleteFile(MB_VIDEO); } catch { /* ignore */ }
  try { await ffmpeg.deleteFile(videoInput); } catch { /* ignore */ }
  mbLog('[mb] audio mux done; motion-blur complete');
  return blurredOutput;
}

/** Legacy tblend frame-average blur — fallback when WebGL can't be used. */
async function applyTblendMotionBlur(
  ffmpeg: FFmpeg,
  videoInput: string,
  params: Pick<MotionBlurParams, 'intensity' | 'encoding' | 'onProgress'>,
): Promise<string> {
  params.onProgress?.({ stage: 'モーションブラー適用中 (tblend)', percent: -1 });
  const passCount = tblendPassCount(params.intensity);
  const tblendVf = buildTblendFilter(passCount);
  const blurredOutput = 'video_blurred.mp4';
  await execChecked(ffmpeg, [
    '-threads', '1',
    '-i', videoInput,
    '-vf', tblendVf,
    '-c:v', 'libx264',
    '-preset', params.encoding.preset,
    '-crf', String(params.encoding.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y',
    blurredOutput,
  ], 'モーションブラーの適用');
  try { await ffmpeg.deleteFile(videoInput); } catch { /* ignore */ }
  return blurredOutput;
}

/**
 * Dispatch motion-blur application: prefer the WebGL preview-matching pass,
 * fall back to tblend when the clip is too long or WebGL is unavailable.
 * Returns the resulting video filename.
 */
async function applyMotionBlur(
  ffmpeg: FFmpeg,
  videoInput: string,
  params: MotionBlurParams,
): Promise<string> {
  const estimatedFrames = Math.ceil(params.totalVideoSeconds * params.targetFps);
  mbLog(`[mb] applyMotionBlur: ~${estimatedFrames} frames (cap ${MAX_WEBGL_BLUR_FRAMES})`);
  // The tblend fallback applies one strength to the ENTIRE video — it cannot
  // gate per output-timeline segment like the WebGL path. Surface that so the
  // user knows multi-clip timelines won't get per-clip blur in this path.
  const blurStrengths = params.segments?.map((segment) =>
    motionBlurStrengthAtOutputTime(
      [segment],
      (segment.start + segment.end) / 2,
      params.strengthOverride,
    ),
  ) ?? [];
  const blurGateLimited = new Set(
    blurStrengths.map((value) => value.toFixed(6)),
  ).size > 1;
  if (estimatedFrames > MAX_WEBGL_BLUR_FRAMES) {
    const msg = `[exporter] motion-blur: ~${estimatedFrames} frames > ${MAX_WEBGL_BLUR_FRAMES} cap — using tblend fallback`;
    console.info(msg);
    params.onProgress?.({ stage: 'モーションブラー: 長尺のため tblend を使用', percent: -1, log: msg });
    if (blurGateLimited) {
      throw new Error(
        'クリップごとに異なるモーションブラーを設定した長尺動画は、現在の書き出し上限を超えています。',
      );
    }
    return applyTblendMotionBlur(ffmpeg, videoInput, params);
  }
  try {
    return await applyWebglMotionBlur(ffmpeg, videoInput, params);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const msg = `[exporter] motion-blur: WebGL パス失敗 (${err instanceof Error ? err.message : String(err)}) — tblend へフォールバック`;
    console.error('[mb] WebGL path threw:', err);
    console.warn(msg);
    params.onProgress?.({ stage: 'モーションブラー: WebGL不可 → tblend', percent: -1, log: msg });
    if (blurGateLimited) {
      throw new Error(
        'クリップごとのモーションブラーを正確に適用できませんでした。',
        { cause: err },
      );
    }
    // Drop any intermediate the failed WebGL pass left behind.
    try { await ffmpeg.deleteFile('mb_video.mp4'); } catch { /* ignore */ }
    return applyTblendMotionBlur(ffmpeg, videoInput, params);
  }
}

// ---------------------------------------------------------------------------
// Clip-transform pass (WebCodecs) — preview/export parity for Clip.transform
// ---------------------------------------------------------------------------

/** One concatenated clip's output-timeline window, for transform sampling. */
export interface TransformSegment {
  clip: Clip;
  /** Authored absolute output-timeline start/end (seconds). */
  start: number;
  end: number;
}

/**
 * Resolve the clip transform that applies at output-timeline time `tOut`.
 *
 * Each segment owns its authored absolute output
 * window [start, end). Within a segment, clip-local time advances at the clip's
 * playback speed (a 2× clip covers 2 s of source per 1 s of output) — the
 * transform keyframes are authored in clip-local timeline seconds (playhead -
 * clip.start in the preview), which equals the offset within the segment. So we
 * sample at (tOut - segment.start), matching the preview exactly.
 */
export function clipTransformAtOutputTime(
  segments: TransformSegment[],
  tOut: number,
): ResolvedTransform {
  // Find the segment containing tOut (segments are sorted but may have gaps).
  let seg = segments.find((s) => tOut >= s.start - 1e-6 && tOut < s.end - 1e-6);
  const last = segments[segments.length - 1];
  if (!seg && last && tOut >= last.end - 1e-6) {
    // Past the final segment end (last frame) — hold the last clip.
    seg = last;
  }
  const localT = seg ? tOut - seg.start : 0;
  const r = sampleClipTransform(seg?.clip.transform, localT);
  if (!seg) return r;
  // Compose the kill-to-kill transition modulation (Phase P4) onto the sampled
  // transform, exactly as the preview does (Preview.tsx footageTransform):
  // opacity & scale multiply, translate adds. The segment's [start,end) window
  // equals the clip's timeline duration, so the boundary windows line up with
  // the preview's clip-local time.
  if (!clipHasTransition(seg.clip.transitionIn, seg.clip.transitionOut)) return r;
  const segDur = seg.end - seg.start;
  const mod = transitionModulationAt(
    seg.clip.transitionIn,
    seg.clip.transitionOut,
    localT,
    segDur,
  );
  return {
    x: r.x + mod.dx,
    y: r.y + mod.dy,
    scale: r.scale * mod.scale,
    rotation: r.rotation,
    opacity: Math.max(0, Math.min(1, r.opacity * mod.opacity)),
  };
}

/**
 * Resolve the CSS/Canvas2D color-grade filter string that applies at
 * output-timeline time `tOut`. The grade is per-clip and NOT keyframed, so this
 * just finds the owning segment and maps its clip's grade to a filter string
 * (lib/colorGrade), exactly mirroring the preview (CSS `filter` on the footage
 * layer). Returns 'none' outside any segment or for an ungraded clip.
 */
export function colorGradeFilterAtOutputTime(
  segments: TransformSegment[],
  tOut: number,
): string {
  let seg = segments.find((s) => tOut >= s.start - 1e-6 && tOut < s.end - 1e-6);
  const last = segments[segments.length - 1];
  if (!seg && last && tOut >= last.end - 1e-6) {
    seg = last;
  }
  return colorGradeFilter(seg?.clip.colorGrade);
}

/**
 * True when the transform pass MUST route the frame at output time `tOut`
 * through the Canvas2D renderer (because the resolved transform visibly moves /
 * scales / rotates / fades the frame OR a color grade applies). Returns false
 * when the frame is a pixel-identical pass-through — an identity transform with
 * no grade over the black background draws exactly the source frame at output
 * resolution — so the caller can feed the decoded `<video>` straight into the
 * VideoFrame and SKIP the redundant fillRect + setTransform + drawImage copy.
 *
 * Pure (composes {@link clipTransformAtOutputTime} + {@link isTransformVisible}
 * + {@link colorGradeFilterAtOutputTime}) so it stays unit-testable and the two
 * decisions can never drift apart. Only a perf shortcut — the rendered output
 * is identical either way.
 */
export function transformFrameNeedsCanvas(
  segments: TransformSegment[],
  tOut: number,
): boolean {
  if (isTransformVisible(clipTransformAtOutputTime(segments, tOut))) return true;
  return colorGradeFilterAtOutputTime(segments, tOut) !== 'none';
}

/**
 * Resolve the motion-blur shader strength that applies at output-timeline time
 * `tOut`, gated PER SEGMENT exactly like the preview.
 *
 * At clip times, each output frame belongs to
 * one clip's [start, end) window. The preview only blurs the clip whose
 * `effects` array contains a 'motion-blur' effect, scaling that clip's authored
 * intensity by its own playback speed (Preview.tsx). This mirrors that: clips
 * WITHOUT a motion-blur effect resolve to strength 0 (the shader early-outs →
 * the frame is emitted sharp), and clips WITH one resolve to
 * `exportStrengthFromIntensity(intensity, speed)` using that clip's own values.
 *
 * As documented elsewhere in this file, the export scales by the clip's
 * (average) playback speed rather than the instantaneous ramp speed — the
 * preview uses the instantaneous value, but the per-clip gating is exact.
 *
 * `strengthOverride` (the preview's global strength slider) is applied ONLY to
 * clips that actually have a motion-blur effect — clips without one stay at 0
 * (sharp) regardless of the override.
 */
export function motionBlurStrengthAtOutputTime(
  segments: TransformSegment[],
  tOut: number,
  strengthOverride?: number,
): number {
  let seg = segments.find((s) => tOut >= s.start - 1e-6 && tOut < s.end - 1e-6);
  const last = segments[segments.length - 1];
  if (!seg && last && tOut >= last.end - 1e-6) {
    seg = last;
  }
  if (!seg) return 0;
  const mbEffect = seg.clip.effects.find((e) => e.type === 'motion-blur');
  if (!mbEffect) return 0;
  if (strengthOverride !== undefined) return strengthOverride;
  return exportStrengthFromIntensity(mbEffect.intensity ?? 50, seg.clip.speed ?? 1);
}

// ---------------------------------------------------------------------------
// Speed-remap (ramp) pass — preview/export parity for Clip.speedRamp
// ---------------------------------------------------------------------------

/**
 * Map an OUTPUT-timeline time `tOut` to the position to SEEK within the already
 * concatenated, CONSTANT-speed footage (`video_only.mp4`), so a clip's speed
 * ramp is reproduced by re-timing which source frame is shown.
 *
 * The concat footage plays each clip at its constant `speed`, so within a
 * segment the footage at output-local time `tLocal` shows source time
 * `trimStart + tLocal * speed` (linear). The ramp instead WANTS source time
 * `sampler.sourceTimeAtLocalTime(tLocal)`. Inverting the linear constant-speed
 * map gives the footage-local time that shows that desired source:
 *   footageLocal = (rampSource - trimStart) / speed
 * which we add to the segment's footage start (= segment.start because black
 * gap segments are included in the concat). Non-ramped segments map identity.
 *
 * Returned time is in the concatenated footage's own clock (seconds).
 */
export function rampFootageSeekAtOutputTime(
  segments: TransformSegment[],
  tOut: number,
): number {
  let seg = segments.find((s) => tOut >= s.start - 1e-6 && tOut < s.end - 1e-6);
  const last = segments[segments.length - 1];
  if (!seg && last && tOut >= last.end - 1e-6) {
    seg = last;
  }
  if (!seg) return tOut;
  const tLocal = tOut - seg.start;
  const clip = seg.clip;
  if (!hasSpeedRamp(clip.speedRamp)) {
    // Identity — footage already shows the right frame at this output time.
    return seg.start + tLocal;
  }
  const speed = clip.speed ?? 1;
  const sampler = makeRampSampler(
    clip.speedRamp,
    speed,
    clip.trimStart,
    clip.trimEnd,
  );
  const rampSource = sampler.sourceTimeAtLocalTime(tLocal);
  const footageLocal = speed > 0 ? (rampSource - clip.trimStart) / speed : tLocal;
  return seg.start + Math.max(0, footageLocal);
}

/** True when any included segment carries a real speed ramp. */
function segmentsHaveRamp(segments: TransformSegment[]): boolean {
  return segments.some((s) => hasSpeedRamp(s.clip.speedRamp));
}

// ---------------------------------------------------------------------------
// Fused effects pass (WebCodecs) — motion-blur + speed-ramp + transform/grade
// in ONE decode→render→encode loop
// ---------------------------------------------------------------------------

interface FusedEffectsParams {
  width: number;
  height: number;
  targetFps: number;
  segments: TransformSegment[];
  /** Apply per-segment WebGL motion blur (gated like the preview). */
  applyBlur: boolean;
  /** Re-time the seek per output frame to bake each clip's speed ramp. */
  applyRamp: boolean;
  /** Bake the animated transform + color grade per frame. */
  applyTransform: boolean;
  /** Global motion-blur strength override (preview slider); per-clip gated. */
  motionBlurStrengthOverride?: number;
  hudPreset: HudPreset;
  hudMaskStrength: number;
  encoding: VideoEncodingSettings;
  signal?: AbortSignal;
  onProgress?: ExportOptions['onProgress'];
}

/**
 * Apply motion-blur, speed-ramp re-timing, and transform/color-grade to
 * `videoInput` in a SINGLE decode→render→encode loop.
 *
 * Previously each effect ran as its own self-contained pass (decode the whole
 * video from WASM-FS → native <video> per-frame seek → WebCodecs re-encode →
 * write back), so a clip using all three decoded-and-re-encoded the entire
 * footage three times — compounding seek/encode time, peak memory (three
 * ArrayBufferTargets), and stacking three lossy H.264 generations. Fusing them
 * collapses that to one decode of each frame, one in-memory render chain
 * (blur → transform/grade), and one H.264 generation — cutting effect-export
 * time and peak memory by ~3x and removing the inter-pass quality loss.
 *
 * The per-output-time sampler functions used here
 * ({@link rampFootageSeekAtOutputTime}, {@link motionBlurStrengthAtOutputTime},
 * {@link clipTransformAtOutputTime}, {@link colorGradeFilterAtOutputTime},
 * {@link transformFrameNeedsCanvas}) are pure, so this composition reproduces
 * the exact result of running the three passes back-to-back.
 *
 * Throws (→ caller falls back to the individual passes) if WebCodecs is
 * unavailable, no AVC config is supported, the video can't be read, or a seek
 * times out.
 */
async function applyFusedEffectsPass(
  ffmpeg: FFmpeg,
  videoInput: string,
  params: FusedEffectsParams,
): Promise<string> {
  const { width, height, targetFps, segments, onProgress } = params;
  const { applyBlur, applyRamp, applyTransform } = params;

  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('effects: WebCodecs (VideoEncoder) 利用不可');
  }

  onProgress?.({ stage: 'エフェクト: 動画を読み込み中', percent: -1 });
  const data = await ffmpeg.readFile(videoInput);
  const u8 = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  const blobPart: BlobPart = u8.buffer instanceof ArrayBuffer
    ? (u8 as Uint8Array<ArrayBuffer>)
    : new Uint8Array(u8);
  const url = URL.createObjectURL(new Blob([blobPart], { type: 'video/mp4' }));
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  const loadedPromise = videoOnce(video, 'loadeddata');

  const bitrate = pickBitrate(width, height, targetFps, params.encoding.bitrateMultiplier);
  const codec = await pickAvcCodec({ width, height, bitrate, framerate: targetFps });
  if (!codec) {
    loadedPromise.catch(() => {});
    URL.revokeObjectURL(url);
    throw new Error('effects: 対応する H.264 エンコーダ設定が見つかりません');
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: targetFps },
    fastStart: 'in-memory',
  });
  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure({ codec, width, height, bitrate, framerate: targetFps });

  const blurRenderer = applyBlur
    ? new OffscreenMotionBlurRenderer(width, height, {
        strength: params.motionBlurStrengthOverride ?? 0,
        hudPreset: params.hudPreset,
        hudMaskStrength: params.hudMaskStrength,
      })
    : null;
  const transformRenderer = applyTransform ? new OffscreenTransformRenderer(width, height) : null;
  // Intermediate canvas used ONLY to bridge the blur renderer's RGBA buffer
  // into a CanvasImageSource the transform renderer (or the VideoFrame) can
  // consume. Allocated once and reused per frame.
  let bridgeCanvas: HTMLCanvasElement | null = null;
  let bridgeCtx: CanvasRenderingContext2D | null = null;
  if (applyBlur && applyTransform) {
    bridgeCanvas = document.createElement('canvas');
    bridgeCanvas.width = width;
    bridgeCanvas.height = height;
    const c = bridgeCanvas.getContext('2d');
    if (!c) {
      blurRenderer?.dispose();
      transformRenderer?.dispose();
      loadedPromise.catch(() => {});
      try { encoder.close(); } catch { /* ignore */ }
      URL.revokeObjectURL(url);
      throw new Error('effects: 2D context for blur→transform bridge unavailable');
    }
    bridgeCtx = c;
  }

  const frameDurUs = Math.round(1_000_000 / targetFps);
  const gop = Math.max(1, targetFps * 2);

  try {
    await withTimeout(loadedPromise, 15000, '動画メタデータ読み込み');
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration === 0) {
      throw new Error('effects: 動画の長さを取得できませんでした');
    }
    const total = Math.max(1, Math.round(duration * targetFps));
    mbLog(`[fx] native decode: duration=${duration.toFixed(2)}s total≈${total} frames (blur=${applyBlur} ramp=${applyRamp} transform=${applyTransform})`);

    for (let i = 0; i < total; i++) {
      throwIfAborted(params.signal);
      if (encoderError) throw encoderError;
      const tOut = (i + 0.5) / targetFps;
      if (tOut >= duration) break;
      // Speed ramp re-times WHICH source frame appears at this output time;
      // when no ramp applies this is the linear output time (identity seek).
      const seekT = applyRamp
        ? Math.max(0, Math.min(duration - 1e-3, rampFootageSeekAtOutputTime(segments, tOut)))
        : tOut;
      await withTimeout(seekVideo(video, seekT), 10000, `フレーム seek #${i}`);

      let frame: VideoFrame | null = null;
      try {
        // 1) Motion blur — produces RGBA gated per segment (sharp where no
        //    motion-blur effect). When blur is the only effect, feed the RGBA
        //    straight to a VideoFrame.
        let blurredRgba: Uint8Array | null = null;
        if (blurRenderer) {
          const frameStrength = motionBlurStrengthAtOutputTime(
            segments, tOut, params.motionBlurStrengthOverride,
          );
          blurredRgba = blurRenderer.processFrame(video, frameStrength);
        }

        // 2) Transform + color grade — drawn on top of the (optionally) blurred
        //    frame. Identity transform + no grade is a pass-through (skip the
        //    redundant Canvas2D copy), matching the standalone transform pass.
        const needCanvas = applyTransform && transformFrameNeedsCanvas(segments, tOut);
        if (needCanvas && transformRenderer) {
          let source: CanvasImageSource;
          if (blurredRgba && bridgeCtx && bridgeCanvas) {
            // Copy the blur renderer's reused RGBA buffer into a fresh
            // ImageData (the buffer is overwritten on the next processFrame).
            bridgeCtx.putImageData(
              new ImageData(new Uint8ClampedArray(blurredRgba), width, height),
              0, 0,
            );
            source = bridgeCanvas;
          } else {
            source = video;
          }
          const canvas = transformRenderer.drawFrame(
            source,
            clipTransformAtOutputTime(segments, tOut),
            colorGradeFilterAtOutputTime(segments, tOut),
          );
          frame = new VideoFrame(canvas, { timestamp: i * frameDurUs, duration: frameDurUs });
        } else if (blurredRgba) {
          // Blur (and/or ramp) only — emit the blurred RGBA directly.
          frame = new VideoFrame(blurredRgba, {
            format: 'RGBA',
            codedWidth: width,
            codedHeight: height,
            timestamp: i * frameDurUs,
            duration: frameDurUs,
          });
        } else {
          // Ramp only (or identity transform frame) — emit the decoded frame.
          frame = new VideoFrame(video, { timestamp: i * frameDurUs, duration: frameDurUs });
        }
        encoder.encode(frame, { keyFrame: i % gop === 0 });
      } finally {
        if (frame) frame.close();
      }

      while (encoder.encodeQueueSize > 16) {
        await new Promise<void>((r) => setTimeout(r, 4));
        if (encoderError) throw encoderError;
      }

      if (i % 5 === 0 || i === total - 1) {
        onProgress?.({
          stage: `エフェクト適用中 (${i + 1}/${total})`,
          percent: Math.max(0, Math.min(0.85, ((i + 1) / total) * 0.85)),
        });
      }
    }

    onProgress?.({ stage: 'エフェクト: エンコード仕上げ中', percent: 0.88 });
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
  } finally {
    blurRenderer?.dispose();
    transformRenderer?.dispose();
    try { encoder.close(); } catch { /* already closed / errored */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }

  const videoBytes = new Uint8Array(muxer.target.buffer);
  onProgress?.({ stage: 'エフェクト: 音声を結合中', percent: 0.92 });
  const FX_VIDEO = 'fx_video.mp4';
  await ffmpeg.writeFile(FX_VIDEO, videoBytes);
  const out = 'video_effects.mp4';
  await execChecked(ffmpeg, [
    '-threads', '1',
    '-i', FX_VIDEO,
    '-i', videoInput,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    out,
  ], 'エフェクト映像と音声の結合');
  try { await ffmpeg.deleteFile(FX_VIDEO); } catch { /* ignore */ }
  try { await ffmpeg.deleteFile(videoInput); } catch { /* ignore */ }
  return out;
}

// ---------------------------------------------------------------------------
// Text-overlay pass
// ---------------------------------------------------------------------------

interface OverlaySpec {
  /** WASM-FS filename of the full-frame RGBA overlay PNG. */
  name: string;
  /** Output-timeline window (seconds) the overlay is visible. */
  start: number;
  end: number;
  /**
   * Optional intro animation (Phase P3) for this clip's overlay PNG — animates
   * the appearance (alpha fade + slide offset) so the export matches the
   * preview's intro. Null = static composite (legacy behaviour).
   */
  intro: ClipOverlayIntro | null;
}

/**
 * Composite pre-rasterized overlay PNGs onto `videoInput`, each gated to its
 * clip's output time window. Runs AFTER the motion-blur pass so text stays
 * sharp. Each PNG is a full-frame transparent image (text already positioned),
 * fed as a looped input and overlaid at 0:0 with an `enable` expression.
 * Returns the new output filename.
 */
async function applyOverlayPass(
  ffmpeg: FFmpeg,
  videoInput: string,
  specs: OverlaySpec[],
  totalDuration: number,
  targetFps: number,
  encoding: VideoEncodingSettings,
): Promise<string> {
  const out = 'video_overlaid.mp4';
  // Each overlay PNG is looped but BOUNDED with -t so it's a FINITE input.
  // An unbounded `-loop 1` image is an infinite stream that makes the overlay
  // graph hang at frame 0 in ffmpeg.wasm (same failure mode as image2). -t
  // (slightly longer than the video) + matching -framerate keeps it finite.
  const imgDur = (Math.max(0.1, totalDuration) + 1).toFixed(3);
  const inputArgs: string[] = ['-i', videoInput];
  for (const s of specs) {
    inputArgs.push('-framerate', String(targetFps), '-loop', '1', '-t', imgDur, '-i', s.name);
  }

  // Chain: [0:v][1:v]overlay…[ov0]; [ov0][2:v]overlay…[ov1]; … → [ovout].
  // Each overlay is composited statically OR with an intro (alpha fade + slide
  // offset). The fragment builder namespaces any intermediate labels by index
  // so multiple overlays compose without collisions. Commas inside expressions
  // are escaped (\,) so the filtergraph parser doesn't split on them.
  const parts: string[] = [];
  let last = '[0:v]';
  specs.forEach((s, k) => {
    const next = k === specs.length - 1 ? '[ovout]' : `[ov${k}]`;
    const fragParts = buildOverlayFilterParts(
      last,
      `[${k + 1}:v]`,
      next,
      k,
      s.start,
      s.end,
      s.intro,
    );
    parts.push(...fragParts);
    last = next;
  });

  await execChecked(ffmpeg, [
    '-threads', '1',
    ...inputArgs,
    '-filter_complex', parts.join(';'),
    '-map', '[ovout]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', encoding.preset,
    '-crf', String(encoding.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y',
    out,
  ], 'テキストオーバーレイの合成');

  try { await ffmpeg.deleteFile(videoInput); } catch { /* ignore */ }
  for (const s of specs) {
    try { await ffmpeg.deleteFile(s.name); } catch { /* ignore */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BGM auto-ducking helpers (Phase P5) — preview/export parity for AudioDucking
// ---------------------------------------------------------------------------

export type ExportTimelineItem =
  | { kind: 'gap'; start: number; end: number }
  | { kind: 'clip'; start: number; end: number; clip: Clip };

/**
 * Build the visible main-video timeline without collapsing empty space.
 * Overlap is rejected because the current exporter has no layer-compositing
 * rule for two simultaneous clips on the same lane.
 */
export function buildExportTimeline(
  clips: readonly Clip[],
): ExportTimelineItem[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const result: ExportTimelineItem[] = [];
  const EPS = 1e-4;
  let cursor = 0;

  for (const clip of sorted) {
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const duration = (clip.trimEnd - clip.trimStart) / speed;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`クリップの長さが不正です: ${clip.id}`);
    }
    if (clip.start < cursor - EPS) {
      throw new Error(
        `映像クリップが重なっています。重なりを解消してから書き出してください: ${clip.id}`,
      );
    }
    if (clip.start > cursor + EPS) {
      result.push({ kind: 'gap', start: cursor, end: clip.start });
    }
    const end = clip.start + duration;
    result.push({ kind: 'clip', start: clip.start, end, clip });
    cursor = end;
  }
  return result;
}

/**
 * Build OUTPUT-timeline video segments at their authored absolute starts.
 *
 * Returns {@link DuckSegment}s carrying each clip's asset / source trim / speed
 * and its output start, ready for {@link buildDuckPoints}.
 */
export function exportVideoDuckSegments(videoClips: readonly Clip[]): DuckSegment[] {
  return buildExportTimeline(videoClips)
    .filter((item): item is Extract<ExportTimelineItem, { kind: 'clip' }> =>
      item.kind === 'clip')
    .map(({ clip, start }) => ({
      assetId: clip.assetId,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      speed: clip.speed && clip.speed > 0 ? clip.speed : 1,
      speedRamp: clip.speedRamp,
      start,
    }));
}

export function buildAudioMixFilter(mixLabels: readonly string[]): string {
  const inputs = `[0:a]${mixLabels.join('')}`;
  return (
    `${inputs}amix=inputs=${mixLabels.length + 1}:duration=first:` +
    'dropout_transition=0:normalize=0,' +
    'alimiter=limit=0.95:level=false[aout]'
  );
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

export async function exportProject(
  input: ExportInput,
  options: ExportOptions,
): Promise<Blob> {
  throwIfAborted(options.signal);
  const { clips, tracks, assets } = input;
  const markers = input.markers ?? [];
  const videoTrack = tracks.find(
    (track) =>
      track.kind === 'video' &&
      !track.hidden &&
      clips.some((clip) => clip.trackId === track.id),
  );
  const trackMutedById = (trackId: string): boolean =>
    tracks.find((t) => t.id === trackId)?.muted ?? false;
  const isPlayableAudioTrackId = (trackId: string): boolean => {
    const track = tracks.find((candidate) => candidate.id === trackId);
    return track?.kind === 'audio' && !track.hidden;
  };
  // The FIRST audio track is the BGM lane (subsequent audio tracks are SE etc.)
  // — only BGM is auto-ducked around kills, mirroring the preview.
  const bgmTrackId = tracks.find((t) => t.kind === 'audio')?.id ?? null;

  const videoClips = clips
    .filter((c) => videoTrack && !videoTrack.hidden && c.trackId === videoTrack.id)
    .sort((a, b) => a.start - b.start);
  // Mix ALL audio tracks (BGM + SE + …), not just the first — previously the
  // SE track's clips were silently dropped from the export.
  const audioClips = clips
    .filter((c) => isPlayableAudioTrackId(c.trackId))
    .sort((a, b) => a.start - b.start);

  if (videoClips.length === 0) {
    throw new Error('映像クリップがありません');
  }

  const timelinePlan = buildExportTimeline(videoClips);

  const requiredClips = [
    ...videoClips,
    ...audioClips.filter(
      (clip) => !(clip.muted ?? false) && !trackMutedById(clip.trackId),
    ),
  ];
  const missingAssetIds = [...new Set(
    requiredClips
      .filter((clip) => !assets.some((asset) => asset.id === clip.assetId))
      .map((clip) => clip.assetId),
  )];
  if (missingAssetIds.length > 0) {
    throw new Error(
      `元素材が見つからないクリップがあります。再リンクしてから書き出してください: ` +
      missingAssetIds.join(', '),
    );
  }

  // Legacy projects may contain secondary video/overlay lanes from builds
  // that exposed them before compositing existed. Loading remains supported,
  // but exporting them incompletely is never treated as success.
  const droppedVideoClips = clips.filter(
    (c) => {
      const track = tracks.find((t) => t.id === c.trackId);
      if (!track || track.hidden) return false;
      const kind = track.kind;
      return kind === 'overlay' || (kind === 'video' && videoTrack && c.trackId !== videoTrack.id);
    },
  );
  if (droppedVideoClips.length > 0) {
    throw new Error(
      `サブ映像/オーバーレイの${droppedVideoClips.length}クリップは書き出し未対応です。` +
      'メイン映像トラックに移動するか、トラックを非表示にしてください。',
    );
  }

  const { width, height } = getResolution(options.resolution, options.aspectRatio);
  const targetFps = options.fps;
  const encoding = getVideoEncodingSettings(options.quality);
  const enableMotionBlur = options.motionBlur === true;
  const videoTrackMuted = videoTrack?.muted ?? false;

  options.onProgress?.({ stage: 'FFmpeg を読み込み中', percent: -1 });
  const { ffmpeg, variant, threadCount } = await getFFmpeg(options.onProgress);
  throwIfAborted(options.signal);

  const variantLabel = variant === 'mt'
    ? `MT (${threadCount} threads)`
    : 'ST (single thread)';
  options.onProgress?.({ stage: `FFmpeg 起動: ${variantLabel}`, percent: -1 });

  // Text overlays ARE exported (rasterized → composited after the blur pass);
  // see the overlay pass below. No more "preview-only" warning.

  // Progress tracking from FFmpeg log stream.
  const progressState = {
    phase: 'idle' as 'idle' | 'encode' | 'mix',
    totalDuration: 0,
    startEpoch: 0,
  };

  const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/;
  const SPEED_RE = /speed=\s*(\d+(?:\.\d+)?)x/;

  const logHandler = ({ message }: { message: string }) => {
    if (progressState.phase === 'encode' || progressState.phase === 'mix') {
      const tm = TIME_RE.exec(message);
      if (tm) {
        const sec =
          parseInt(tm[1], 10) * 3600 + parseInt(tm[2], 10) * 60 + parseFloat(tm[3]);
        const pct = Math.max(
          0,
          Math.min(1, sec / Math.max(0.001, progressState.totalDuration)),
        );
        const basePercent = progressState.phase === 'mix' ? 0.9 : 0;
        const spanPercent = progressState.phase === 'mix' ? 0.1 : 0.9;
        const spdMatch = SPEED_RE.exec(message);
        const speedNote = spdMatch ? `  ${spdMatch[1]}x` : '';

        // ETA calculation: elapsed / progress → remaining
        const elapsed = (Date.now() - progressState.startEpoch) / 1000;
        const progressFraction = basePercent + pct * spanPercent;
        let etaNote = '';
        if (progressFraction > 0.02 && elapsed > 1) {
          const totalEstimated = elapsed / progressFraction;
          const remaining = Math.max(0, totalEstimated - elapsed);
          etaNote = ` — 残り約 ${remaining.toFixed(0)}s`;
        }

        const stageLabel =
          progressState.phase === 'mix'
            ? `BGM 合成中${speedNote}${etaNote}`
            : `エンコード中${speedNote}${etaNote}`;
        options.onProgress?.({
          stage: stageLabel,
          percent: progressFraction,
          log: message,
        });
        return;
      }
    }
    options.onProgress?.({ stage: 'FFmpeg', percent: -1, log: message });
  };
  const writtenAudioFilenames = new Map<string, string>();
  const assetHasAudio = new Map<string, boolean>();
  const sourceMountPoint = `/byux_sources_${crypto.randomUUID().replaceAll('-', '')}`;
  const mountedInputsByAssetId = new Map<string, string>();
  const sourceBlobs: Array<{ name: string; data: Blob }> = [];

  for (const assetId of new Set(requiredClips.map((clip) => clip.assetId))) {
    const asset = assets.find((candidate) => candidate.id === assetId);
    if (!asset) continue;
    const fileName = `source_${mountedInputsByAssetId.size}.${safeExt(asset.name, 'bin')}`;
    mountedInputsByAssetId.set(asset.id, `${sourceMountPoint}/${fileName}`);
    if (asset.file) {
      sourceBlobs.push({ name: fileName, data: asset.file });
      continue;
    }
    throwIfAborted(options.signal);
    const response = await fetch(asset.url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`素材を読み込めません: ${asset.name}`);
    }
    const blob = await response.blob();
    throwIfAborted(options.signal);
    if (blob.size !== asset.size) {
      throw new Error(`素材の読み込みが途中で失敗しました: ${asset.name}`);
    }
    sourceBlobs.push({ name: fileName, data: blob });
  }

  // Build deduplicated input list for video clips.
  const assetInputMap = new Map<string, { index: number; inputName: string }>();
  const ffmpegInputArgs: string[] = [];

  for (const clip of videoClips) {
    const asset = assets.find((a) => a.id === clip.assetId);
    if (!asset || assetInputMap.has(asset.id)) continue;
    const inputName = mountedInputsByAssetId.get(asset.id);
    if (!inputName) continue;
    const inputIndex = ffmpegInputArgs.length / 2;
    assetInputMap.set(asset.id, { index: inputIndex, inputName });
    ffmpegInputArgs.push('-i', inputName);
  }

  const totalVideoSeconds = timelinePlan.at(-1)?.end ?? 0;
  progressState.totalDuration = totalVideoSeconds;

  ffmpeg.on('log', logHandler);
  try {
    // WORKERFS lets FFmpeg read Blob/File sources without duplicating every
    // multi-GB recording into a renderer Uint8Array and again into MEMFS.
    options.onProgress?.({ stage: 'ソースファイルを接続中', percent: -1 });
    await ffmpeg.createDir(sourceMountPoint, { signal: options.signal });
    await ffmpeg.mount(FFFSType.WORKERFS, { blobs: sourceBlobs }, sourceMountPoint);
    throwIfAborted(options.signal);

    options.onProgress?.({ stage: '音声ストリームを確認中', percent: -1 });
    for (const [assetId, { inputName }] of assetInputMap) {
      throwIfAborted(options.signal);
      assetHasAudio.set(assetId, await probeInputHasAudio(ffmpeg, inputName));
    }
    progressState.phase = 'encode';
    progressState.startEpoch = Date.now();

    let videoOutput = 'video_only.mp4';

      // Always use the normalized encode path. A stream-copy decision based on
      // MIME/container metadata cannot prove codec, frame-rate, dimensions, or
      // audio compatibility with the requested export settings.
      const clipFilterFragments: string[] = [];
      const vLabels: string[] = [];
      const aLabels: string[] = [];
      const includedTimeline: Array<{ clip: Clip; start: number; end: number }> = [];

      for (let i = 0; i < timelinePlan.length; i++) {
        throwIfAborted(options.signal);
        const item = timelinePlan[i];
        const duration = item.end - item.start;
        const vLabel = item.kind === 'gap' ? `[gv${i}]` : `[cv${i}]`;
        const aLabel = item.kind === 'gap' ? `[ga${i}]` : `[ca${i}]`;
        vLabels.push(vLabel);
        aLabels.push(aLabel);

        if (item.kind === 'gap') {
          // Preserve authored empty space as black video plus finite silence.
          clipFilterFragments.push(
            `color=c=black:s=${width}x${height}:r=${targetFps}:d=${duration.toFixed(4)},` +
            `format=yuv420p,setsar=1,setpts=PTS-STARTPTS${vLabel};` +
            `anullsrc=r=44100:cl=stereo,atrim=0:${duration.toFixed(4)},` +
            `asetpts=PTS-STARTPTS${aLabel}`,
          );
          continue;
        }

        const clip = item.clip;
        const asset = assets.find((a) => a.id === clip.assetId);
        if (!asset) {
          throw new Error(`元素材が見つかりません。再リンクしてください: ${clip.assetId}`);
        }

        const entry = assetInputMap.get(asset.id);
        if (!entry) {
          throw new Error(`元素材をFFmpegへ読み込めませんでした: ${asset.name}`);
        }

        includedTimeline.push({ clip, start: item.start, end: item.end });

        clipFilterFragments.push(
          buildClipFilters({
            inputIndex: entry.index,
            clip,
            asset,
            width,
            height,
            targetFps,
            videoTrackMuted,
            hasAudio: assetHasAudio.get(asset.id) !== false,
            reframe: options.verticalReframe ?? 0,
            vOutLabel: vLabel,
            aOutLabel: aLabel,
          }),
        );
      }

      const n = vLabels.length;
      if (n === 0) {
        throw new Error('書き出し可能な映像クリップがありません');
      }

      const concatInputs = vLabels.map((v, i) => `${v}${aLabels[i]}`).join('');
      const concatFilter = `${concatInputs}concat=n=${n}:v=1:a=1[vout][aout]`;
      clipFilterFragments.push(concatFilter);
      const filterComplex = clipFilterFragments.join(';');

      options.onProgress?.({ stage: 'エンコード中', percent: -1 });
      await execChecked(ffmpeg, [
        '-threads', '1',
        ...ffmpegInputArgs,
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-preset', encoding.preset,
        '-crf', String(encoding.crf),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '256k',
        '-ar', '44100',
        '-ac', '2',
        '-movflags', '+faststart',
        '-y',
        videoOutput,
      ], '映像のエンコード');

      // -----------------------------------------------------------------------
      // Post-concat effects (motion-blur + speed-ramp + transform/color-grade)
      //
      // FUSED into ONE decode→render→encode loop (applyFusedEffectsPass):
      // previously each effect ran its own self-contained WebCodecs pass, so a
      // clip using all three decoded-and-re-encoded the ENTIRE footage three
      // times (3× seeks, 3 ArrayBufferTargets, 3 stacked H.264 generations).
      // Fusing collapses that to one decode of each frame, one in-memory render
      // chain (blur → transform/grade — order preserved from the old passes),
      // and one H.264 generation. The per-output-time sampler functions are pure
      // so the composed result equals running the passes back-to-back.
      //
      // Why post-concat (not inside the filter graph): tblend emits one fewer
      // frame than input (no predecessor for frame 0). Inside a concat filter
      // graph that desync stalls the concat. Applying after concat sidesteps it.
      //
      // Per-segment gating: `includedTimeline` is passed so each output frame is
      // blurred with its OWNING clip's intensity*speed (clips without a
      // motion-blur effect pass through sharp), transformed/graded by its own
      // clip, and ramp-re-timed per its own speed ramp — exactly like the
      // preview.
      //
      // LIMITATIONS (unchanged): all effects are WebCodecs per-frame passes, so
      // for very long timelines (> MAX_WEBGL_BLUR_FRAMES) or when WebCodecs is
      // unavailable we degrade — motion-blur falls back to the whole-video
      // tblend filter; speed-ramp and transform/grade are SKIPPED (export at
      // constant speed / untransformed) rather than shipping a wrong result. The
      // ramp audio is not time-warped, and blur strength scales by the clip's
      // AVERAGE (not instantaneous) speed; the visual re-timing itself is exact.
      // -----------------------------------------------------------------------
      const hasRamp = segmentsHaveRamp(includedTimeline);
      const transformSegments: TransformSegment[] = includedTimeline.filter(
        (seg) =>
          clipHasTransform(seg.clip.transform) ||
          clipHasColorGrade(seg.clip.colorGrade) ||
          clipHasTransition(seg.clip.transitionIn, seg.clip.transitionOut),
      );
      const hasTransform = transformSegments.length > 0;
      const effectFrames = Math.ceil(totalVideoSeconds * targetFps);
      const overFrameCap = effectFrames > MAX_WEBGL_BLUR_FRAMES;
      const hudPreset = options.motionBlurHudPreset ?? 'valorant';
      const hudMaskStrength = options.motionBlurHudMaskStrength ??
        (hudPreset === 'none' ? 0 : 1);

      if (enableMotionBlur || hasRamp || hasTransform) {
        if (overFrameCap && (hasRamp || hasTransform)) {
          throw new Error(
            `この動画は約${effectFrames}フレームあり、速度リマップ/トランスフォーム/` +
            `カラー/トランジションを正確に書き出せる上限 ${MAX_WEBGL_BLUR_FRAMES} を超えています。` +
            '動画を短く分割して再試行してください。',
          );
        }
        progressState.startEpoch = Date.now();
        progressState.totalDuration = totalVideoSeconds;

        // WebCodecs-fusable effects: blur (only when under the frame cap — over
        // it falls back to the whole-video tblend filter), ramp, and transform.
        const fuseBlur = enableMotionBlur && !overFrameCap;
        const canFuse = (fuseBlur || hasRamp || hasTransform) && !overFrameCap;

        if (canFuse) {
          try {
            options.onProgress?.({ stage: 'エフェクト適用中', percent: -1 });
            videoOutput = await applyFusedEffectsPass(ffmpeg, videoOutput, {
              width,
              height,
              targetFps,
              segments: includedTimeline,
              applyBlur: fuseBlur,
              applyRamp: hasRamp,
              applyTransform: hasTransform,
              motionBlurStrengthOverride: options.motionBlurStrength,
              hudPreset,
              hudMaskStrength,
              encoding,
              signal: options.signal,
              onProgress: options.onProgress,
            });
          } catch (err) {
            try { await ffmpeg.deleteFile('fx_video.mp4'); } catch { /* ignore */ }
            throw new Error(
              `エフェクトを正確に適用できなかったため、書き出しを中止しました: ${
                err instanceof Error ? err.message : String(err)
              }`,
              { cause: err },
            );
          }
        } else {
          // The only remaining non-fused case is a long timeline whose sole
          // post-process is motion blur. applyMotionBlur either uses the exact
          // WebGL path or an explicitly constrained whole-video fallback.
          if (enableMotionBlur) {
            options.onProgress?.({ stage: 'モーションブラー適用中', percent: -1 });
            const mbClip = videoClips.find((c) =>
              c.effects.some((e) => e.type === 'motion-blur'),
            );
            const mbEffect = mbClip?.effects.find((e) => e.type === 'motion-blur');
            videoOutput = await applyMotionBlur(ffmpeg, videoOutput, {
              width,
              height,
              targetFps,
              totalVideoSeconds,
              intensity: mbEffect?.intensity ?? 50,
              speed: mbClip?.speed ?? 1,
              strengthOverride: options.motionBlurStrength,
              segments: includedTimeline,
              hudPreset,
              hudMaskStrength,
              encoding,
              signal: options.signal,
              onProgress: options.onProgress,
            });
          }
        }
      }

      // ---------------------------------------------------------------------
      // Text-overlay pass (after blur → text stays sharp). Rasterize each
      // clip's overlays in the browser (exact preview fonts) and composite
      // them onto their output time window.
      // ---------------------------------------------------------------------
      const overlaySpecs: OverlaySpec[] = [];
      for (const seg of includedTimeline) {
        throwIfAborted(options.signal);
        if (!seg.clip.overlays || seg.clip.overlays.length === 0) continue;
        const vi = videoClips.indexOf(seg.clip);
        const tokens = {
          n: String(vi >= 0 ? vi + 1 : 1),
          total: String(videoClips.length),
        };
        const png = await rasterizeOverlays(seg.clip.overlays, width, height, tokens);
        if (!png) {
          throw new Error(
            `テキストを画像化できませんでした。クリップ ${vi >= 0 ? vi + 1 : seg.clip.id} の` +
            'フォントまたは描画環境を確認してください。',
          );
        }
        const name = `ovl_${overlaySpecs.length}.png`;
        await ffmpeg.writeFile(name, png);
        // Intro animation for this clip's shared overlay PNG (matches preview).
        const intro = introForClipOverlays(seg.clip.overlays, height);
        overlaySpecs.push({ name, start: seg.start, end: seg.end, intro });
      }
      if (overlaySpecs.length > 0) {
        options.onProgress?.({ stage: 'テキスト合成中', percent: -1 });
        try {
          videoOutput = await applyOverlayPass(
            ffmpeg,
            videoOutput,
            overlaySpecs,
            totalVideoSeconds,
            targetFps,
            encoding,
          );
        } catch (err) {
          for (const s of overlaySpecs) {
            try { await ffmpeg.deleteFile(s.name); } catch { /* ignore */ }
          }
          throw new Error(
            `テキストを正確に合成できなかったため、書き出しを中止しました: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          );
        }
      }

    // -----------------------------------------------------------------------
    // BGM mix pass — audio-only re-encode on top of the finished video.
    // Video stream is stream-copied (no re-encode).
    // -----------------------------------------------------------------------
    let finalOutput = videoOutput;
    // Playable = has a loaded asset and is not muted (by the clip or its track).
    // Spans ALL audio tracks (BGM + SE), each positioned by its own start.
    const playableAudioClips = audioClips.filter(
      (c) =>
        assets.some((a) => a.id === c.assetId) &&
        !(c.muted ?? false) &&
        !trackMutedById(c.trackId),
    );
    if (playableAudioClips.length > 0) {
      progressState.phase = 'mix';
      progressState.totalDuration = totalVideoSeconds;
      progressState.startEpoch = Date.now();
      options.onProgress?.({ stage: 'BGM 合成中', percent: -1 });

      // BGM auto-ducking (Phase P5): project the kill markers onto the OUTPUT
      // timeline (the authored absolute video segments) and build a `volume`
      // expression that dips the BGM around each kill. Computed once and applied
      // ONLY to the first audio (BGM) track's clips — SE / other audio tracks
      // play at full level. Resolved fields are clamped (lib/audioDucking).
      const resolvedDuck = resolveDucking(options.audioDucking);
      let duckVolumeExpr: string | null = null;
      if (hasDucking(options.audioDucking) && markers.length > 0) {
        const duckSegments = exportVideoDuckSegments(videoClips);
        const duckPoints = buildDuckPoints(markers, duckSegments);
        duckVolumeExpr = buildDuckVolumeExpr(duckPoints, resolvedDuck);
        if (duckVolumeExpr) {
          options.onProgress?.({
            stage: `BGMダッキング: ${duckPoints.length}箇所のキルでBGMを下げます`,
            percent: -1,
            log: `[exporter] BGM ducking: ${duckPoints.length} duck point(s), -${resolvedDuck.amountDb}dB`,
          });
        }
      }

      const audioInputArgs: string[] = [];
      const audioFilterParts: string[] = [];
      const mixLabels: string[] = [];
      let audioInputIndex = 1;

      for (let i = 0; i < playableAudioClips.length; i++) {
        throwIfAborted(options.signal);
        const clip = playableAudioClips[i];
        const asset = assets.find((a) => a.id === clip.assetId);
        if (!asset) continue;

        const inputName = mountedInputsByAssetId.get(asset.id);
        if (!inputName) {
          throw new Error(`元素材をFFmpegへ読み込めませんでした: ${asset.name}`);
        }
        if (!writtenAudioFilenames.has(asset.id)) {
          writtenAudioFilenames.set(asset.id, inputName);
        }
        audioInputArgs.push('-i', inputName);

        const speed = clip.speed ?? 1;
        // Already filtered to non-muted, so volume is just the clip's level.
        const vol = clip.volume ?? 1;
        const startMs = Math.round(clip.start * 1000);

        const filters: string[] = [
          `atrim=${clip.trimStart.toFixed(4)}:${clip.trimEnd.toFixed(4)}`,
          'asetpts=PTS-STARTPTS',
          ...buildAtempoChain(speed),
          `volume=${vol.toFixed(3)}`,
        ];
        if (startMs > 0) filters.push(`adelay=${startMs}|${startMs}`);

        // BGM auto-ducking: applied AFTER adelay so the per-frame expression's
        // `t` is on the OUTPUT timeline (= where the duck points were computed).
        // Only the BGM track is ducked; SE / other audio tracks are untouched.
        const isBgmClip = bgmTrackId !== null && clip.trackId === bgmTrackId;
        if (isBgmClip && duckVolumeExpr) {
          filters.push(`volume=${duckVolumeExpr}:eval=frame`);
        }

        const label = `[ba${i}]`;
        audioFilterParts.push(`[${audioInputIndex}:a]${filters.join(',')}${label}`);
        mixLabels.push(label);
        audioInputIndex++;
      }

      const mixFilterComplex =
        `${audioFilterParts.join(';')};${buildAudioMixFilter(mixLabels)}`;

      await execChecked(ffmpeg, [
        '-threads', '1',
        '-i', videoOutput,
        ...audioInputArgs,
        '-filter_complex', mixFilterComplex,
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '256k',
        '-ar', '44100',
        '-ac', '2',
        '-movflags', '+faststart',
        '-y',
        'final.mp4',
      ], 'BGM/効果音の合成');
      finalOutput = 'final.mp4';
    }

    options.onProgress?.({ stage: '完成', percent: 1 });
    throwIfAborted(options.signal);
    const data = await ffmpeg.readFile(finalOutput, 'binary', {
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    // readFile already returns a transferred ArrayBuffer-backed view. Passing
    // it straight to Blob avoids one additional full-size renderer copy.
    if (bytes.buffer instanceof ArrayBuffer) {
      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'video/mp4' });
    }
    const fallback = new Uint8Array(bytes.byteLength);
    fallback.set(bytes);
    return new Blob([fallback], { type: 'video/mp4' });

  } finally {
    ffmpeg.off('log', logHandler);
    try { await ffmpeg.unmount(sourceMountPoint); } catch { /* reset/early failure */ }
    try { await ffmpeg.deleteDir(sourceMountPoint); } catch { /* reset/early failure */ }
    // Clean up every MEMFS file written by this export.
    try { await ffmpeg.deleteFile('video_only.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('video_blurred.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('video_speedramped.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('sr_video.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('video_transformed.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('tf_video.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('video_effects.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('fx_video.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('video_overlaid.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('final.mp4'); } catch { /* ignore */ }
    // Purge any leftover overlay PNGs.
    try {
      const left = await ffmpeg.listDir('/');
      for (const e of left) {
        if (!e.isDir && e.name.startsWith('ovl_') && e.name.endsWith('.png')) {
          try { await ffmpeg.deleteFile(e.name); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}
