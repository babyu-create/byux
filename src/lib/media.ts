import type { MediaAsset } from './types';

export interface MediaProbeResult {
  duration: number;
  width?: number;
  height?: number;
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/');
}

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/');
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

  try {
    if (isVideoFile(file)) {
      const meta = await probeVideoMetadata(file);
      return {
        id,
        name: file.name,
        kind: 'video',
        url,
        file,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
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
        duration: meta.duration,
      };
    }

    URL.revokeObjectURL(url);
    return null;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
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
