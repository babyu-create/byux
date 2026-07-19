import type { MediaAsset } from './types';

export interface MediaProbeResult {
  duration: number;
  width?: number;
  height?: number;
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);

function fileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
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
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

export function guessMimeType(filename: string, kind: 'video' | 'audio'): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME[ext] ?? (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
}

export function probeVideoMetadata(file: File): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const cleanup = () => {
      video.removeAttribute('src');
      URL.revokeObjectURL(url);
    };

    video.onloadedmetadata = () => {
      const result: MediaProbeResult = {
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      cleanup();
      resolve(result);
    };

    video.onerror = () => {
      cleanup();
      reject(new Error(`Failed to read video metadata: ${file.name}`));
    };

    video.src = url;
  });
}

export function probeAudioMetadata(file: File): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    const cleanup = () => {
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
