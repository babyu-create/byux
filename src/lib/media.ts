import type { MediaAsset } from './types';

export interface MediaProbeResult {
  duration: number;
  width?: number;
  height?: number;
}

export const SUPPORTED_VIDEO_EXTENSIONS = [
  'mp4',
  'm4v',
  'mov',
  'qt',
  'mkv',
  'webm',
  'avi',
  'wmv',
  'asf',
  'flv',
  'f4v',
  'ts',
  'mts',
  'm2ts',
  'm2t',
  'mpg',
  'mpeg',
  'mpe',
  'vob',
  'ogv',
  '3gp',
  '3g2',
  'mxf',
] as const;

export const SUPPORTED_AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'wave',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'aac',
  'flac',
  'wma',
  'aiff',
  'aif',
  'ac3',
  'eac3',
  'amr',
] as const;

const VIDEO_EXTENSIONS = new Set<string>(SUPPORTED_VIDEO_EXTENSIONS);
const AUDIO_EXTENSIONS = new Set<string>(SUPPORTED_AUDIO_EXTENSIONS);
const MEDIA_METADATA_TIMEOUT_MS = 20_000;
const PROXY_FIRST_VIDEO_EXTENSIONS = new Set([
  'mkv',
  'avi',
  'wmv',
  'asf',
  'flv',
  'f4v',
  'ts',
  'mts',
  'm2ts',
  'm2t',
  'mpg',
  'mpeg',
  'mpe',
  'vob',
  'ogv',
  'mxf',
]);
const PROXY_FIRST_AUDIO_EXTENSIONS = new Set([
  'wma',
  'aiff',
  'aif',
  'ac3',
  'eac3',
  'amr',
]);

function fileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

export function needsVideoPreviewProxy(filename: string): boolean {
  return PROXY_FIRST_VIDEO_EXTENSIONS.has(fileExtension(filename));
}

export function needsAudioPreviewProxy(filename: string): boolean {
  return PROXY_FIRST_AUDIO_EXTENSIONS.has(fileExtension(filename));
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(fileExtension(file.name));
}

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.has(fileExtension(file.name));
}

// Extension → MIME lookup for files re-hydrated from a raw disk read (see
// `readMediaFile` in App.tsx), where there's no browser-assigned `file.type`
// to rely on. `isVideoFile`/`isAudioFile` key off this, so a wrong/missing
// guess would make a valid media file look "unsupported".
const EXTENSION_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  flv: 'video/x-flv',
  f4v: 'video/mp4',
  ts: 'video/mp2t',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  m2t: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  mpe: 'video/mpeg',
  vob: 'video/mpeg',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mxf: 'application/mxf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  ac3: 'audio/ac3',
  eac3: 'audio/eac3',
  amr: 'audio/amr',
};

export function guessMimeType(filename: string, kind: 'video' | 'audio'): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME[ext] ?? (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
}

/**
 * Reading container metadata is not enough to prove Chromium can display the
 * video. Some damaged capture files report duration and dimensions correctly,
 * then fail on the first H.264 packet and leave the editor preview black.
 * Seek to a real sample frame and require decoded frame data before accepting
 * the source. Callers can then fall back to the FFmpeg compatibility proxy.
 */
function probePlayableVideoSource(
  url: string,
  errorMessage: string,
): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let result: MediaProbeResult | null = null;
    let sampleTime = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(errorMessage));
    };
    const acceptDecodedFrame = () => {
      if (
        settled ||
        !result ||
        video.seeking ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        Math.abs(video.currentTime - sampleTime) > 0.5
      ) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    video.preload = 'auto';
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.onloadedmetadata = () => {
      result = {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      if (
        !Number.isFinite(result.duration) ||
        result.duration <= 0 ||
        !result.width ||
        !result.height
      ) {
        fail();
        return;
      }
      sampleTime = result.duration > 2 ? 1 : result.duration / 2;
      try {
        video.currentTime = sampleTime;
        queueMicrotask(acceptDecodedFrame);
      } catch {
        fail();
      }
    };
    video.onloadeddata = acceptDecodedFrame;
    video.onseeked = acceptDecodedFrame;
    video.onerror = fail;
    const timeoutId = setTimeout(fail, MEDIA_METADATA_TIMEOUT_MS);
    video.src = url;
  });
}

export function probeVideoMetadata(file: File): Promise<MediaProbeResult> {
  const url = URL.createObjectURL(file);
  return probePlayableVideoSource(url, `Failed to decode video: ${file.name}`)
    .finally(() => URL.revokeObjectURL(url));
}

export function probeAudioMetadata(file: File): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    const cleanup = () => {
      clearTimeout(timeoutId);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
    };

    audio.onloadedmetadata = () => {
      const result: MediaProbeResult = {
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      };
      cleanup();
      resolve(result);
    };

    audio.onerror = () => {
      cleanup();
      reject(new Error(`Failed to read audio metadata: ${file.name}`));
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out reading audio metadata: ${file.name}`));
    }, MEDIA_METADATA_TIMEOUT_MS);
    audio.src = url;
  });
}

export async function fileToMediaAsset(file: File): Promise<MediaAsset | null> {
  const id = crypto.randomUUID();
  const url = URL.createObjectURL(file);
  // Electron only; empty/undefined on the web build or for a synthetic Blob.
  const path = window.fce?.getPathForFile?.(file) || undefined;

  try {
    if (isVideoFile(file)) {
      const meta = await probeVideoMetadata(file);
      return {
        id,
        name: file.name,
        kind: 'video',
        url,
        file,
        size: file.size,
        mimeType: file.type || guessMimeType(file.name, 'video'),
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        path,
      };
    }

    if (isAudioFile(file)) {
      const meta = await probeAudioMetadata(file);
      return {
        id,
        name: file.name,
        kind: 'audio',
        url,
        file,
        size: file.size,
        mimeType: file.type || guessMimeType(file.name, 'audio'),
        duration: meta.duration,
        path,
      };
    }

    URL.revokeObjectURL(url);
    return null;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

const MEDIA_READ_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Read source bytes only when an operation truly needs them. Re-linked media
 * stays streaming/file-backed during normal editing, avoiding a multi-GB IPC
 * copy merely to open a project.
 */
export async function readMediaAssetBytes(asset: MediaAsset): Promise<Uint8Array<ArrayBuffer>> {
  if (asset.file) {
    return new Uint8Array(await asset.file.arrayBuffer());
  }

  const readChunk = window.fce?.readMediaFileChunk;
  if (!asset.sourceToken || !readChunk) {
    throw new Error(`素材を読み込めません: ${asset.name}`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
    throw new Error(`素材サイズが不正です: ${asset.name}`);
  }

  let output: Uint8Array<ArrayBuffer>;
  try {
    output = new Uint8Array(asset.size);
  } catch {
    throw new Error(
      `素材が大きすぎてメモリに読み込めません: ${asset.name} (${formatFileSize(asset.size)})`,
    );
  }

  for (let offset = 0; offset < asset.size; offset += MEDIA_READ_CHUNK_BYTES) {
    const requested = Math.min(MEDIA_READ_CHUNK_BYTES, asset.size - offset);
    const chunk = await readChunk(asset.sourceToken, offset, requested);
    if (!chunk || chunk.byteLength !== requested) {
      throw new Error(`素材の読み込みが途中で失敗しました: ${asset.name}`);
    }
    output.set(chunk, offset);
  }
  return output;
}

/** Materialize a re-linked asset as a File for browser APIs such as Web Audio. */
export async function mediaAssetToFile(asset: MediaAsset): Promise<File> {
  if (asset.file) return asset.file;
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`素材を読み込めません: ${asset.name}`);
  const blob = await response.blob();
  if (blob.size !== asset.size) {
    throw new Error(`素材の読み込みが途中で失敗しました: ${asset.name}`);
  }
  // Keep the browser-managed Blob backing rather than allocating a second
  // multi-GB Uint8Array in the renderer.
  return new File([blob], asset.name, { type: asset.mimeType });
}

/** Probe a main-process streamed preview URL without materialising the proxy as
 * a renderer File/Blob. Used by the native long-form compatibility pipeline. */
export function probeVideoUrlMetadata(url: string): Promise<MediaProbeResult> {
  return probePlayableVideoSource(url, 'プレビュー用動画をデコードできませんでした');
}

/** Probe a main-process streamed audio URL without copying the whole source
 * into renderer memory. */
export function probeAudioUrlMetadata(url: string): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    const cleanup = () => {
      clearTimeout(timeoutId);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      cleanup();
      if (duration <= 0) {
        reject(new Error('プレビュー用音声の情報を読み取れませんでした'));
        return;
      }
      resolve({ duration });
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('プレビュー用音声を読み込めませんでした'));
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('プレビュー用音声の読み込みがタイムアウトしました'));
    }, MEDIA_METADATA_TIMEOUT_MS);
    audio.src = url;
  });
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatTimecode(seconds: number, fps = 60): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00.00';
  }
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const frames = Math.floor((seconds - Math.floor(seconds)) * fps);
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(frames).padStart(2, '0')}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
