// MP4 export pipeline using FFmpeg.wasm.
//
// Architecture: single-pass filter_complex that processes all clips in one
// ffmpeg.exec call. This eliminates the N×individual-encode + concat pattern
// that was the primary bottleneck (each intermediate vclip_N.mp4 incurred a
// full libx264 encode + WASM-FS write, then a second read during concat).
//
// Stream-copy fast path: when all video clips satisfy the "no-transcode"
// conditions (speed=1, no fades, no motion blur, source codec=h264, resolution
// matches output, single clip) the pipeline skips libx264 entirely and uses
// `-c copy` — reducing a 50-second clip from ~60 s encode to ~2 s.
//
// Motion blur: opt-in tblend post-process pass with variable intensity (1–3
// chained tblend stages driven by the intensity slider on each clip's
// motion-blur effect).

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { Clip, MediaAsset, Track } from './types';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { exportStrengthFromIntensity, type HudPreset } from './motionBlurCore';
import { OffscreenMotionBlurRenderer } from './motionBlurExporter';
import { OffscreenTransformRenderer } from './transformExporter';
import {
  clipHasTransform,
  sampleClipTransform,
  type ResolvedTransform,
} from './clipTransform';
import {
  hasSpeedRamp,
  makeRampSampler,
} from './speedRamp';
import { rasterizeOverlays } from './overlayRaster';

export interface ExportOptions {
  resolution: '720p' | '1080p';
  fps: 30 | 60;
  aspectRatio: '16:9' | '9:16';
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
  onProgress?: (info: { stage: string; percent: number; log?: string }) => void;
}

export interface ExportInput {
  clips: Clip[];
  tracks: Track[];
  assets: MediaAsset[];
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

// Local MT core (copied from node_modules by vite.config.ts copyMtCore plugin).
// Using local files means CDN is never hit — no unpkg.com latency, no proxy
// blocks, no 10-second timeout races.
const LOCAL_MT_CORE_JS = '/lib/mt/ffmpeg-core.js';
const LOCAL_MT_CORE_WASM = '/lib/mt/ffmpeg-core.wasm';
const LOCAL_MT_CORE_WORKER = '/lib/mt/ffmpeg-core.worker.js';

// Local single-threaded fallbacks (pre-existing in public/lib/).
const LOCAL_ST_CORE_JS = '/lib/ffmpeg-core.js';
const LOCAL_ST_CORE_WASM = '/lib/ffmpeg-core.wasm';

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
  ffmpegHandle = null;
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
  loadPromise = (async (): Promise<FFmpegHandle> => {
    const ffmpeg = new FFmpeg();

    // Try local MT core first (CDN-free path).
    if (await tryLoadMtLocal(ffmpeg, onProgress)) {
      const threadCount = navigator.hardwareConcurrency ?? 4;
      const handle: FFmpegHandle = { ffmpeg, variant: 'mt', threadCount };
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
      log: '[exporter] loading local ST core from /lib/',
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
        `FFmpeg 初期化失敗 — ローカルファイル (/lib/ffmpeg-core.*) が見つかりません。\n詳細: ${localErr instanceof Error ? localErr.message : String(localErr)}`,
      );
    }
    const handle: FFmpegHandle = { ffmpeg, variant: 'st', threadCount: 1 };
    ffmpegHandle = handle;
    return handle;
  })().catch((err) => {
    // Reset so the next call can retry from scratch.
    loadPromise = null;
    throw err;
  });
  return loadPromise;
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

// ---------------------------------------------------------------------------
// Stream-copy fast path detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the entire export can skip libx264 re-encoding and use
 * `-c copy` (stream copy). This shaves encode time from ~60 s → ~2 s for a
 * typical 50-second single-clip export.
 *
 * Requirements for stream copy:
 * - Exactly one video clip (no concat needed)
 * - speed = 1.0
 * - No fade effects on the clip
 * - Motion blur is off (or clip has no motion-blur effect)
 * - Source asset codec is h264 (detected via MIME type heuristic)
 * - Source resolution equals the target output resolution
 * - Video track is not muted (would need re-encode to silence audio)
 *
 * Note: We do not attempt stream copy for multi-clip timelines because
 * true copy-mode concat requires all segments to start on keyframe boundaries
 * — a constraint we cannot guarantee without probing each file.
 */
function canStreamCopy(
  videoClips: Clip[],
  assets: MediaAsset[],
  width: number,
  height: number,
  videoTrackMuted: boolean,
  enableMotionBlur: boolean,
): boolean {
  if (videoClips.length !== 1) return false;
  if (enableMotionBlur) return false;
  if (videoTrackMuted) return false;

  const clip = videoClips[0];
  const asset = assets.find((a) => a.id === clip.assetId);
  if (!asset) return false;

  // Stretch-to-fill requires a non-uniform scale → must re-encode.
  if (clip.stretchToFill) return false;

  // An animated/positioned clip transform is baked per-frame (WebCodecs pass)
  // → can't stream-copy.
  if (clipHasTransform(clip.transform)) return false;

  // Text overlays are composited via a filter pass → can't stream-copy.
  if (clip.overlays && clip.overlays.length > 0) return false;

  const speed = clip.speed ?? 1;
  if (Math.abs(speed - 1) > 1e-3) return false;

  // A speed ramp re-times frames (WebCodecs pass) → can't stream-copy.
  if (hasSpeedRamp(clip.speedRamp)) return false;

  const hasFade = clip.effects.some(
    (e) => e.type === 'fade-in' || e.type === 'fade-out',
  );
  if (hasFade) return false;

  // Trim must cover the full asset. Otherwise `-ss`/`-to` with `-c copy`
  // snaps to keyframes and emits extra leading frames (the file starts
  // before the user's intended cut, by up to the keyframe interval —
  // typically 1-2s for game recordings). Frame-accurate trimming requires
  // re-encoding; we'd rather fall out of the fast path than ship wrong
  // output.
  const FRAME_EPS = 1 / 240; // sub-frame tolerance for fp comparisons
  if (clip.trimStart > FRAME_EPS) return false;
  if (clip.trimEnd < asset.duration - FRAME_EPS) return false;

  // Resolution must match exactly — stream copy can't scale.
  if (asset.width !== width || asset.height !== height) return false;

  // MIME-type heuristic: MP4/MOV containers commonly carry H.264.
  // We accept ONLY video/mp4 and video/quicktime as likely H.264 sources.
  // An empty/unknown MIME is NOT assumed H.264 — a .webm (VP9/AV1) dropped from
  // the OS can report an empty type, and stream-copying it into an .mp4 wrapper
  // would emit a broken file. Unknown → fall through to a safe re-encode.
  const mime = asset.file.type.toLowerCase();
  const likelyH264 = mime === 'video/mp4' || mime === 'video/quicktime';
  if (!likelyH264) return false;

  return true;
}

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
  const sourceMatchesOutput = asset.width === width && asset.height === height;
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

  const aFilters: string[] = [];
  aFilters.push(`atrim=${clip.trimStart.toFixed(4)}:${clip.trimEnd.toFixed(4)}`);
  aFilters.push('asetpts=PTS-STARTPTS');
  aFilters.push(...buildAtempoChain(speed));
  aFilters.push(`volume=${clipVolume.toFixed(3)}`);

  const vChain = `[${inputIndex}:v]${vFilters.join(',')}${vOutLabel}`;
  const aChain = `[${inputIndex}:a]${aFilters.join(',')}${aOutLabel}`;
  return `${vChain};${aChain}`;
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
  hudPreset: HudPreset;
  hudMaskStrength: number;
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
function pickBitrate(width: number, height: number, fps: number): number {
  const raw = width * height * fps * 0.1;
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

  const bitrate = pickBitrate(width, height, targetFps);
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
      if (encoderError) throw encoderError;
      // Seek to the middle of frame i so we land squarely on it, not a boundary.
      const t = (i + 0.5) / targetFps;
      if (t >= duration) break;
      await withTimeout(seekVideo(video, t), 10000, `フレーム seek #${i}`);

      let frame: VideoFrame | null = null;
      try {
        const rgba = renderer.processFrame(video);
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
  await ffmpeg.exec([
    '-threads', '1',
    '-i', MB_VIDEO,
    '-i', videoInput,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    blurredOutput,
  ]);
  try { await ffmpeg.deleteFile(MB_VIDEO); } catch { /* ignore */ }
  try { await ffmpeg.deleteFile(videoInput); } catch { /* ignore */ }
  mbLog('[mb] audio mux done; motion-blur complete');
  return blurredOutput;
}

/** Legacy tblend frame-average blur — fallback when WebGL can't be used. */
async function applyTblendMotionBlur(
  ffmpeg: FFmpeg,
  videoInput: string,
  params: Pick<MotionBlurParams, 'intensity' | 'onProgress'>,
): Promise<string> {
  params.onProgress?.({ stage: 'モーションブラー適用中 (tblend)', percent: -1 });
  const passCount = tblendPassCount(params.intensity);
  const tblendVf = buildTblendFilter(passCount);
  const blurredOutput = 'video_blurred.mp4';
  await ffmpeg.exec([
    '-threads', '1',
    '-i', videoInput,
    '-vf', tblendVf,
    '-c:v', 'libx264',
    '-preset', 'superfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y',
    blurredOutput,
  ]);
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
  if (estimatedFrames > MAX_WEBGL_BLUR_FRAMES) {
    const msg = `[exporter] motion-blur: ~${estimatedFrames} frames > ${MAX_WEBGL_BLUR_FRAMES} cap — using tblend fallback`;
    console.info(msg);
    params.onProgress?.({ stage: 'モーションブラー: 長尺のため tblend を使用', percent: -1, log: msg });
    return applyTblendMotionBlur(ffmpeg, videoInput, params);
  }
  try {
    return await applyWebglMotionBlur(ffmpeg, videoInput, params);
  } catch (err) {
    const msg = `[exporter] motion-blur: WebGL パス失敗 (${err instanceof Error ? err.message : String(err)}) — tblend へフォールバック`;
    console.error('[mb] WebGL path threw:', err);
    console.warn(msg);
    params.onProgress?.({ stage: 'モーションブラー: WebGL不可 → tblend', percent: -1, log: msg });
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
  /** Output-timeline start/end (seconds), back-to-back across clips. */
  start: number;
  end: number;
}

/**
 * Resolve the clip transform that applies at output-timeline time `tOut`.
 *
 * The export concatenates clips back-to-back, so each segment owns an output
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
  // Find the segment containing tOut (segments are sorted, contiguous).
  let seg = segments.find((s) => tOut >= s.start - 1e-6 && tOut < s.end - 1e-6);
  if (!seg && segments.length > 0) {
    // Past the final segment end (last frame) — hold the last clip.
    seg = segments[segments.length - 1];
  }
  return sampleClipTransform(seg?.clip.transform, seg ? tOut - seg.start : 0);
}

/**
 * Apply the preview-matching clip transform to `videoInput` per frame.
 *
 * Pipeline mirrors applyWebglMotionBlur: decode each frame natively from a
 * hidden <video> (Chromium H.264), bake the sampled transform into it via the
 * shared OffscreenTransformRenderer (Canvas2D, origin = frame center), feed the
 * result into a WebCodecs VideoEncoder, then stream-copy the original audio
 * back on. Throws (→ caller skips the pass) if WebCodecs is unavailable.
 */
async function applyTransformPass(
  ffmpeg: FFmpeg,
  videoInput: string,
  params: {
    width: number;
    height: number;
    targetFps: number;
    segments: TransformSegment[];
    onProgress?: ExportOptions['onProgress'];
  },
): Promise<string> {
  const { width, height, targetFps, segments, onProgress } = params;

  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('transform: WebCodecs (VideoEncoder) 利用不可');
  }

  onProgress?.({ stage: 'トランスフォーム: 動画を読み込み中', percent: -1 });
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

  const bitrate = pickBitrate(width, height, targetFps);
  const codec = await pickAvcCodec({ width, height, bitrate, framerate: targetFps });
  if (!codec) {
    loadedPromise.catch(() => {});
    URL.revokeObjectURL(url);
    throw new Error('transform: 対応する H.264 エンコーダ設定が見つかりません');
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

  const renderer = new OffscreenTransformRenderer(width, height);
  const frameDurUs = Math.round(1_000_000 / targetFps);
  const gop = Math.max(1, targetFps * 2);

  try {
    await withTimeout(loadedPromise, 15000, '動画メタデータ読み込み');
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration === 0) {
      throw new Error('transform: 動画の長さを取得できませんでした');
    }
    const total = Math.max(1, Math.round(duration * targetFps));
    mbLog(`[tf] native decode: duration=${duration.toFixed(2)}s total≈${total} frames`);

    for (let i = 0; i < total; i++) {
      if (encoderError) throw encoderError;
      const t = (i + 0.5) / targetFps;
      if (t >= duration) break;
      await withTimeout(seekVideo(video, t), 10000, `フレーム seek #${i}`);

      const resolved = clipTransformAtOutputTime(segments, t);
      let frame: VideoFrame | null = null;
      try {
        const canvas = renderer.drawFrame(video, resolved);
        frame = new VideoFrame(canvas, {
          timestamp: i * frameDurUs,
          duration: frameDurUs,
        });
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
          stage: `トランスフォーム適用中 (${i + 1}/${total})`,
          percent: Math.max(0, Math.min(0.85, ((i + 1) / total) * 0.85)),
        });
      }
    }

    onProgress?.({ stage: 'トランスフォーム: エンコード仕上げ中', percent: 0.88 });
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
  } finally {
    renderer.dispose();
    try { encoder.close(); } catch { /* already closed / errored */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }

  const videoBytes = new Uint8Array(muxer.target.buffer);
  onProgress?.({ stage: 'トランスフォーム: 音声を結合中', percent: 0.92 });
  const TF_VIDEO = 'tf_video.mp4';
  await ffmpeg.writeFile(TF_VIDEO, videoBytes);
  const out = 'video_transformed.mp4';
  await ffmpeg.exec([
    '-threads', '1',
    '-i', TF_VIDEO,
    '-i', videoInput,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    out,
  ]);
  try { await ffmpeg.deleteFile(TF_VIDEO); } catch { /* ignore */ }
  try { await ffmpeg.deleteFile(videoInput); } catch { /* ignore */ }
  return out;
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
 * which we add to the segment's footage start (= segment.start, since concat is
 * back-to-back). Non-ramped segments map identity (footage already correct).
 *
 * Returned time is in the concatenated footage's own clock (seconds).
 */
export function rampFootageSeekAtOutputTime(
  segments: TransformSegment[],
  tOut: number,
): number {
  let seg = segments.find((s) => tOut >= s.start - 1e-6 && tOut < s.end - 1e-6);
  if (!seg && segments.length > 0) {
    seg = segments[segments.length - 1];
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

/**
 * Re-time the concatenated footage to bake each clip's speed ramp.
 *
 * Pipeline mirrors applyTransformPass / applyWebglMotionBlur: decode the
 * finished footage natively from a hidden <video>, but instead of seeking to a
 * linear time per output frame we seek to {@link rampFootageSeekAtOutputTime}
 * so slow→fast ramps show the correct source frame at each moment. The decoded
 * frame is fed straight into a WebCodecs VideoEncoder; the original audio is
 * stream-copied back on (audio is NOT time-warped here — see the export
 * LIMITATION note at the call site). Throws (→ caller skips) when WebCodecs is
 * unavailable.
 */
async function applySpeedRampPass(
  ffmpeg: FFmpeg,
  videoInput: string,
  params: {
    width: number;
    height: number;
    targetFps: number;
    segments: TransformSegment[];
    onProgress?: ExportOptions['onProgress'];
  },
): Promise<string> {
  const { width, height, targetFps, segments, onProgress } = params;

  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('speed-ramp: WebCodecs (VideoEncoder) 利用不可');
  }

  onProgress?.({ stage: '速度リマップ: 動画を読み込み中', percent: -1 });
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

  const bitrate = pickBitrate(width, height, targetFps);
  const codec = await pickAvcCodec({ width, height, bitrate, framerate: targetFps });
  if (!codec) {
    loadedPromise.catch(() => {});
    URL.revokeObjectURL(url);
    throw new Error('speed-ramp: 対応する H.264 エンコーダ設定が見つかりません');
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

  const frameDurUs = Math.round(1_000_000 / targetFps);
  const gop = Math.max(1, targetFps * 2);

  try {
    await withTimeout(loadedPromise, 15000, '動画メタデータ読み込み');
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration === 0) {
      throw new Error('speed-ramp: 動画の長さを取得できませんでした');
    }
    // Output length = the timeline length of the concatenated footage (the
    // ramp preserves each clip's duration, so this is unchanged).
    const total = Math.max(1, Math.round(duration * targetFps));
    mbLog(`[sr] native decode: duration=${duration.toFixed(2)}s total≈${total} frames`);

    for (let i = 0; i < total; i++) {
      if (encoderError) throw encoderError;
      const tOut = (i + 0.5) / targetFps;
      if (tOut >= duration) break;
      // Re-timed seek: which footage frame should appear at this output time.
      const seekT = Math.max(0, Math.min(duration - 1e-3, rampFootageSeekAtOutputTime(segments, tOut)));
      await withTimeout(seekVideo(video, seekT), 10000, `フレーム seek #${i}`);

      let frame: VideoFrame | null = null;
      try {
        frame = new VideoFrame(video, {
          timestamp: i * frameDurUs,
          duration: frameDurUs,
        });
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
          stage: `速度リマップ適用中 (${i + 1}/${total})`,
          percent: Math.max(0, Math.min(0.85, ((i + 1) / total) * 0.85)),
        });
      }
    }

    onProgress?.({ stage: '速度リマップ: エンコード仕上げ中', percent: 0.88 });
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
  } finally {
    try { encoder.close(); } catch { /* already closed / errored */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }

  const videoBytes = new Uint8Array(muxer.target.buffer);
  onProgress?.({ stage: '速度リマップ: 音声を結合中', percent: 0.92 });
  const SR_VIDEO = 'sr_video.mp4';
  await ffmpeg.writeFile(SR_VIDEO, videoBytes);
  const out = 'video_speedramped.mp4';
  await ffmpeg.exec([
    '-threads', '1',
    '-i', SR_VIDEO,
    '-i', videoInput,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    out,
  ]);
  try { await ffmpeg.deleteFile(SR_VIDEO); } catch { /* ignore */ }
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
  // Commas inside between() are escaped (\,) so the filtergraph parser doesn't
  // read them as filter separators.
  const parts: string[] = [];
  let last = '[0:v]';
  specs.forEach((s, k) => {
    const next = k === specs.length - 1 ? '[ovout]' : `[ov${k}]`;
    parts.push(
      `${last}[${k + 1}:v]overlay=0:0:enable=between(t\\,${s.start.toFixed(3)}\\,${s.end.toFixed(3)})${next}`,
    );
    last = next;
  });

  await ffmpeg.exec([
    '-threads', '1',
    ...inputArgs,
    '-filter_complex', parts.join(';'),
    '-map', '[ovout]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'superfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y',
    out,
  ]);

  try { await ffmpeg.deleteFile(videoInput); } catch { /* ignore */ }
  for (const s of specs) {
    try { await ffmpeg.deleteFile(s.name); } catch { /* ignore */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

export async function exportProject(
  input: ExportInput,
  options: ExportOptions,
): Promise<Blob> {
  const { clips, tracks, assets } = input;
  const videoTrack = tracks.find((t) => t.kind === 'video');
  const trackMutedById = (trackId: string): boolean =>
    tracks.find((t) => t.id === trackId)?.muted ?? false;
  const isAudioTrackId = (trackId: string): boolean =>
    tracks.find((t) => t.id === trackId)?.kind === 'audio';

  const videoClips = clips
    .filter((c) => videoTrack && c.trackId === videoTrack.id)
    .sort((a, b) => a.start - b.start);
  // Mix ALL audio tracks (BGM + SE + …), not just the first — previously the
  // SE track's clips were silently dropped from the export.
  const audioClips = clips
    .filter((c) => isAudioTrackId(c.trackId))
    .sort((a, b) => a.start - b.start);

  if (videoClips.length === 0) {
    throw new Error('映像クリップがありません');
  }

  // Secondary video tracks (e.g. 映像サブ / PiP) are NOT yet composited into
  // the export (true multi-video-track compositing is planned). Warn instead
  // of silently dropping so the user knows those clips won't appear.
  const droppedVideoClips = clips.filter(
    (c) =>
      tracks.find((t) => t.id === c.trackId)?.kind === 'video' &&
      videoTrack &&
      c.trackId !== videoTrack.id,
  );
  if (droppedVideoClips.length > 0) {
    const msg = `[exporter] WARNING: ${droppedVideoClips.length} clip(s) on a secondary video track are not yet composited into the export.`;
    console.warn(msg);
    options.onProgress?.({
      stage: `映像サブトラックの${droppedVideoClips.length}クリップは書き出し未対応（メイン映像トラックに移動してください）`,
      percent: -1,
      log: msg,
    });
  }

  const { width, height } = getResolution(options.resolution, options.aspectRatio);
  const targetFps = options.fps;
  const enableMotionBlur = options.motionBlur === true;
  const videoTrackMuted = videoTrack?.muted ?? false;

  options.onProgress?.({ stage: 'FFmpeg を読み込み中', percent: -1 });
  const { ffmpeg, variant, threadCount } = await getFFmpeg(options.onProgress);

  const variantLabel = variant === 'mt'
    ? `MT (${threadCount} threads)`
    : 'ST (single thread)';
  options.onProgress?.({ stage: `FFmpeg 起動: ${variantLabel}`, percent: -1 });

  // Text overlays ARE exported (rasterized → composited after the blur pass);
  // see the overlay pass below. No more "preview-only" warning.

  // -------------------------------------------------------------------------
  // Stream-copy fast path check
  // -------------------------------------------------------------------------
  const useStreamCopy = canStreamCopy(
    videoClips, assets, width, height, videoTrackMuted, enableMotionBlur,
  );
  if (useStreamCopy) {
    options.onProgress?.({
      stage: '高速モード: ストリームコピー (再エンコードなし)',
      percent: -1,
      log: '[exporter] fast path: -c copy (no libx264 re-encode)',
    });
  }

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
  ffmpeg.on('log', logHandler);

  const writtenAssets = new Set<string>();
  const writtenAudioFilenames = new Map<string, string>();

  // Build deduplicated input list for video clips.
  const assetInputMap = new Map<string, { index: number; inputName: string }>();
  const ffmpegInputArgs: string[] = [];

  for (const clip of videoClips) {
    const asset = assets.find((a) => a.id === clip.assetId);
    if (!asset || assetInputMap.has(asset.id)) continue;
    const ext = safeExt(asset.file.name, 'mp4');
    const inputName = `vinput_${asset.id}.${ext}`;
    const inputIndex = ffmpegInputArgs.length / 2;
    assetInputMap.set(asset.id, { index: inputIndex, inputName });
    ffmpegInputArgs.push('-i', inputName);
  }

  let totalVideoSeconds = 0;
  for (const clip of videoClips) {
    totalVideoSeconds += (clip.trimEnd - clip.trimStart) / Math.max(0.01, clip.speed ?? 1);
  }
  progressState.totalDuration = totalVideoSeconds;

  try {
    // Write source files to WASM-FS.
    options.onProgress?.({ stage: 'ソースファイル書き込み中', percent: -1 });
    for (const [assetId, { inputName }] of assetInputMap) {
      if (writtenAssets.has(assetId)) continue;
      const asset = assets.find((a) => a.id === assetId);
      if (!asset) continue;
      await ffmpeg.writeFile(inputName, await fetchFile(asset.file));
      writtenAssets.add(assetId);
    }

    progressState.phase = 'encode';
    progressState.startEpoch = Date.now();

    let videoOutput = 'video_only.mp4';

    // -----------------------------------------------------------------------
    // Stream-copy fast path — single clip, no re-encode
    // -----------------------------------------------------------------------
    if (useStreamCopy) {
      const clip = videoClips[0];
      const entry = assetInputMap.get(clip.assetId);
      if (!entry) throw new Error('ソース素材が見つかりません');

      options.onProgress?.({ stage: 'ストリームコピー中', percent: -1 });
      await ffmpeg.exec([
        '-threads', '1',
        '-i', entry.inputName,
        '-ss', clip.trimStart.toFixed(4),
        '-to', clip.trimEnd.toFixed(4),
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y',
        videoOutput,
      ]);
      options.onProgress?.({ stage: 'ストリームコピー完了', percent: 0.9 });
    } else {
      // -----------------------------------------------------------------------
      // Full filter_complex encode path
      // -----------------------------------------------------------------------
      const clipFilterFragments: string[] = [];
      const vLabels: string[] = [];
      const aLabels: string[] = [];
      // Output-timeline placement of each INCLUDED clip (clips are concatenated
      // back-to-back), used to time-gate the text-overlay pass below.
      const includedTimeline: Array<{ clip: Clip; start: number; end: number }> = [];

      let skippedCount = 0;
      for (let i = 0; i < videoClips.length; i++) {
        const clip = videoClips[i];
        const asset = assets.find((a) => a.id === clip.assetId);
        if (!asset) {
          const msg = `[exporter] Clip ${i + 1} スキップ — 元素材なし (id=${clip.assetId})`;
          console.warn(msg);
          options.onProgress?.({ stage: 'クリップスキップ', percent: -1, log: msg });
          skippedCount++;
          continue;
        }

        const entry = assetInputMap.get(asset.id);
        if (!entry) continue;

        const vLabel = `[cv${i}]`;
        const aLabel = `[ca${i}]`;
        vLabels.push(vLabel);
        aLabels.push(aLabel);
        const durOut = (clip.trimEnd - clip.trimStart) / Math.max(0.01, clip.speed ?? 1);
        const startOut = includedTimeline.length
          ? includedTimeline[includedTimeline.length - 1].end
          : 0;
        includedTimeline.push({ clip, start: startOut, end: startOut + durOut });

        clipFilterFragments.push(
          buildClipFilters({
            inputIndex: entry.index,
            clip,
            asset,
            width,
            height,
            targetFps,
            videoTrackMuted,
            reframe: options.verticalReframe ?? 0,
            vOutLabel: vLabel,
            aOutLabel: aLabel,
          }),
        );
      }

      const n = vLabels.length;
      if (n === 0) {
        throw new Error(
          skippedCount > 0
            ? `書き出し可能な映像クリップがありません (全${skippedCount}クリップの元素材が見つかりません)`
            : '書き出し可能な映像クリップがありません',
        );
      }
      if (skippedCount > 0) {
        const msg = `[exporter] ${skippedCount} クリップをスキップ — 出力が短くなります`;
        console.warn(msg);
        options.onProgress?.({ stage: `${skippedCount}クリップをスキップ`, percent: -1, log: msg });
      }

      const concatInputs = vLabels.map((v, i) => `${v}${aLabels[i]}`).join('');
      const concatFilter = `${concatInputs}concat=n=${n}:v=1:a=1[vout][aout]`;
      clipFilterFragments.push(concatFilter);
      const filterComplex = clipFilterFragments.join(';');

      options.onProgress?.({ stage: 'エンコード中', percent: -1 });
      await ffmpeg.exec([
        '-threads', '1',
        ...ffmpegInputArgs,
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-preset', 'superfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '256k',
        '-ar', '44100',
        '-ac', '2',
        '-movflags', '+faststart',
        '-y',
        videoOutput,
      ]);

      // -----------------------------------------------------------------------
      // Post-process motion-blur pass (variable tblend intensity)
      //
      // Why a separate pass: tblend emits one fewer frame than input (no
      // predecessor for frame 0). Inside a concat filter graph that desync
      // causes a stall — the concat waits for matching frame counts that never
      // arrive. Applying tblend after concat sidesteps both problems.
      //
      // Intensity is taken from the first clip's motion-blur effect, or
      // defaults to the middle tier (2 passes) if the effect has no intensity
      // field set.
      // -----------------------------------------------------------------------
      if (enableMotionBlur) {
        progressState.startEpoch = Date.now();
        progressState.totalDuration = totalVideoSeconds;
        options.onProgress?.({ stage: 'モーションブラー適用中', percent: -1 });

        // Pick intensity + speed from the first clip that has a motion-blur
        // effect (matches the legacy single-config behaviour).
        const mbClip = videoClips.find((c) =>
          c.effects.some((e) => e.type === 'motion-blur'),
        );
        const mbEffect = mbClip?.effects.find((e) => e.type === 'motion-blur');
        const mbIntensity = mbEffect?.intensity ?? 50;
        const hudPreset = options.motionBlurHudPreset ?? 'valorant';
        const hudMaskStrength = options.motionBlurHudMaskStrength ??
          (hudPreset === 'none' ? 0 : 1);

        videoOutput = await applyMotionBlur(ffmpeg, videoOutput, {
          width,
          height,
          targetFps,
          totalVideoSeconds,
          intensity: mbIntensity,
          speed: mbClip?.speed ?? 1,
          strengthOverride: options.motionBlurStrength,
          hudPreset,
          hudMaskStrength,
          onProgress: options.onProgress,
        });
      }

      // ---------------------------------------------------------------------
      // Speed-remap (ramp) pass — bake each clip's slow→fast speed ramp by
      // re-timing which source frame appears at each output frame. Runs after
      // the blur pass (so the blurred footage is re-timed) and BEFORE the
      // transform pass (transform samples by OUTPUT time, which the ramp does
      // not change — only which source frame shows). Skipped entirely when no
      // included clip has a ramp (zero cost for the common case).
      //
      // LIMITATION (documented): this is a WebCodecs per-frame decode→encode
      // pass like the others, so for very long timelines (> MAX_WEBGL_BLUR_
      // FRAMES) or when WebCodecs is unavailable we SKIP it (export plays at the
      // constant clip speed instead) rather than ship a wrong result — the
      // preview still shows the ramp. Two further approximations vs the preview:
      //   1. The AUDIO is not time-warped to the ramp (it keeps the
      //      constant-speed atempo from the encode pass) — acceptable for FPS
      //      kill montages where the ramp is a short visual slow-mo→punch.
      //   2. Motion-blur strength in the export is scaled by the clip's AVERAGE
      //      speed, not the instantaneous ramp speed (the preview scales by the
      //      instantaneous value). The visual re-timing itself is exact.
      // ---------------------------------------------------------------------
      if (segmentsHaveRamp(includedTimeline)) {
        const rampFrames = Math.ceil(totalVideoSeconds * targetFps);
        if (rampFrames > MAX_WEBGL_BLUR_FRAMES) {
          const msg = `[exporter] speed-ramp: ~${rampFrames} frames > ${MAX_WEBGL_BLUR_FRAMES} cap — skipping ramp (constant speed for this export)`;
          console.warn(msg);
          options.onProgress?.({
            stage: '速度リマップ: 長尺のためスキップ（一定速度で書き出し）',
            percent: -1,
            log: msg,
          });
        } else {
          try {
            options.onProgress?.({ stage: '速度リマップ適用中', percent: -1 });
            videoOutput = await applySpeedRampPass(ffmpeg, videoOutput, {
              width,
              height,
              targetFps,
              segments: includedTimeline,
              onProgress: options.onProgress,
            });
          } catch (err) {
            // Never fail the whole export over the ramp pass — degrade to the
            // constant-speed footage (still matches preview minus the ramp).
            const m = `[exporter] speed-ramp pass failed (${err instanceof Error ? err.message : String(err)}) — exporting at constant speed`;
            console.warn(m);
            options.onProgress?.({ stage: '速度リマップに失敗（一定速度で継続）', percent: -1, log: m });
            try { await ffmpeg.deleteFile('sr_video.mp4'); } catch { /* ignore */ }
          }
        }
      }

      // ---------------------------------------------------------------------
      // Clip-transform pass (after blur, before text → text stays anchored to
      // the frame, untransformed, exactly like the preview overlay layers).
      // Bakes the animated position/scale/rotation/opacity per frame via
      // WebCodecs so the export matches the preview. Skipped entirely when no
      // included clip has a transform (zero cost for the common case).
      //
      // LIMITATION: this is a WebCodecs (per-frame decode→canvas→encode) pass,
      // like the motion-blur one. There is no ffmpeg-filter equivalent here, so
      // for very long timelines (> MAX_WEBGL_BLUR_FRAMES) or when WebCodecs is
      // unavailable we SKIP the transform (export the untransformed footage)
      // rather than ship a tblend-style approximation — a clip transform can't
      // be reproduced by tblend at all. The preview still shows it correctly.
      // ---------------------------------------------------------------------
      const transformSegments: TransformSegment[] = includedTimeline.filter((seg) =>
        clipHasTransform(seg.clip.transform),
      );
      if (transformSegments.length > 0) {
        const transformFrames = Math.ceil(totalVideoSeconds * targetFps);
        if (transformFrames > MAX_WEBGL_BLUR_FRAMES) {
          const msg = `[exporter] clip transform: ~${transformFrames} frames > ${MAX_WEBGL_BLUR_FRAMES} cap — skipping transform (preview-only for this export)`;
          console.warn(msg);
          options.onProgress?.({
            stage: 'トランスフォーム: 長尺のためスキップ（プレビューのみ）',
            percent: -1,
            log: msg,
          });
        } else {
          try {
            options.onProgress?.({ stage: 'トランスフォーム適用中', percent: -1 });
            videoOutput = await applyTransformPass(ffmpeg, videoOutput, {
              width,
              height,
              targetFps,
              segments: includedTimeline,
              onProgress: options.onProgress,
            });
          } catch (err) {
            // Never fail the whole export over the transform pass — degrade to
            // the untransformed footage (still matches preview minus the move).
            const m = `[exporter] transform pass failed (${err instanceof Error ? err.message : String(err)}) — exporting without clip transform`;
            console.warn(m);
            options.onProgress?.({ stage: 'トランスフォーム適用に失敗（変形なしで継続）', percent: -1, log: m });
            try { await ffmpeg.deleteFile('tf_video.mp4'); } catch { /* ignore */ }
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
        if (!seg.clip.overlays || seg.clip.overlays.length === 0) continue;
        const vi = videoClips.indexOf(seg.clip);
        const tokens = {
          n: String(vi >= 0 ? vi + 1 : 1),
          total: String(videoClips.length),
        };
        const png = await rasterizeOverlays(seg.clip.overlays, width, height, tokens);
        if (!png) continue;
        const name = `ovl_${overlaySpecs.length}.png`;
        await ffmpeg.writeFile(name, png);
        overlaySpecs.push({ name, start: seg.start, end: seg.end });
      }
      if (overlaySpecs.length > 0) {
        options.onProgress?.({ stage: 'テキスト合成中', percent: -1 });
        try {
          videoOutput = await applyOverlayPass(ffmpeg, videoOutput, overlaySpecs, totalVideoSeconds, targetFps);
        } catch (err) {
          // Never let text compositing fail the whole export — degrade to no
          // text (the prior behaviour) instead of throwing.
          const m = `[exporter] overlay pass failed (${err instanceof Error ? err.message : String(err)}) — exporting without text`;
          console.warn(m);
          options.onProgress?.({ stage: 'テキスト合成に失敗（テキスト無しで継続）', percent: -1, log: m });
          for (const s of overlaySpecs) {
            try { await ffmpeg.deleteFile(s.name); } catch { /* ignore */ }
          }
        }
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

      const audioInputArgs: string[] = [];
      const audioFilterParts: string[] = [];
      const mixLabels: string[] = [];
      let audioInputIndex = 1;

      for (let i = 0; i < playableAudioClips.length; i++) {
        const clip = playableAudioClips[i];
        const asset = assets.find((a) => a.id === clip.assetId);
        if (!asset) continue;

        const ext = safeExt(asset.file.name, 'mp3');
        const inputName = `ainput_${asset.id}.${ext}`;
        if (!writtenAudioFilenames.has(asset.id)) {
          await ffmpeg.writeFile(inputName, await fetchFile(asset.file));
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

        const label = `[ba${i}]`;
        audioFilterParts.push(`[${audioInputIndex}:a]${filters.join(',')}${label}`);
        mixLabels.push(label);
        audioInputIndex++;
      }

      const totalMixInputs = mixLabels.length + 1;
      // normalize=1: amix divides the summed signal by the input count, so the
      // master can NEVER exceed the loudest input → mathematically clip-proof,
      // with no dependency on a limiter filter (alimiter's auto-level kept
      // re-clipping). [0:a] (the gameplay/video audio) is listed FIRST so
      // duration=first tracks the VIDEO length, not the first BGM clip.
      const mixFilterComplex =
        `${audioFilterParts.join(';')};[0:a]${mixLabels.join('')}amix=inputs=${totalMixInputs}:duration=first:dropout_transition=0:normalize=1[aout]`;

      await ffmpeg.exec([
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
      ]);
      finalOutput = 'final.mp4';
    }

    options.onProgress?.({ stage: '完成', percent: 1 });
    const data = await ffmpeg.readFile(finalOutput);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    // Ensure we return an ArrayBuffer-backed Uint8Array (not SharedArrayBuffer).
    const ab = new Uint8Array(bytes.byteLength);
    ab.set(bytes);
    return new Blob([ab.buffer], { type: 'video/mp4' });

  } finally {
    ffmpeg.off('log', logHandler);
    // Clean up every WASM-FS file written by this export.
    for (const { inputName } of assetInputMap.values()) {
      try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    }
    for (const inputName of writtenAudioFilenames.values()) {
      try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    }
    try { await ffmpeg.deleteFile('video_only.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('video_blurred.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('video_speedramped.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('sr_video.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('video_transformed.mp4'); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile('tf_video.mp4'); } catch { /* ignore */ }
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
