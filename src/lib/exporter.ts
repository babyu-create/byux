// MP4 export pipeline using FFmpeg.wasm.
// Strategy: render each video clip individually with trim/speed/fades/scale/fps,
// concat them with the concat demuxer, then mix in BGM clips on a final pass.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { Clip, MediaAsset, Track } from './types';

export interface ExportOptions {
  resolution: '720p' | '1080p';
  fps: 30 | 60;
  aspectRatio: '16:9' | '9:16';
  onProgress?: (info: { stage: string; percent: number; log?: string }) => void;
}

export interface ExportInput {
  clips: Clip[];
  tracks: Track[];
  assets: MediaAsset[];
}

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

// Local fallbacks if CDN is unreachable. Vite bundles the worker chunk
// internally, so we don't need to override classWorkerURL in the happy path.
const LOCAL_CORE_JS = '/lib/ffmpeg-core.js';
const LOCAL_CORE_WASM = '/lib/ffmpeg-core.wasm';

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    try {
      // Default load — uses CDN core and Vite-bundled worker.
      await ffmpeg.load();
    } catch (err) {
      // Fallback: blob URLs from local files (offline support).
      try {
        const coreBlob = await toBlobURL(LOCAL_CORE_JS, 'text/javascript');
        const wasmBlob = await toBlobURL(LOCAL_CORE_WASM, 'application/wasm');
        await ffmpeg.load({ coreURL: coreBlob, wasmURL: wasmBlob });
      } catch (fallbackErr) {
        throw new Error(
          `FFmpeg 初期化失敗: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)} (default: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();
  return loadPromise;
}

function getResolution(
  resolution: '720p' | '1080p',
  aspect: '16:9' | '9:16',
): { width: number; height: number } {
  if (aspect === '16:9') {
    return resolution === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  }
  return resolution === '1080p' ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
}

/** Build an atempo filter chain that supports any speed by chaining 0.5x or 2.0x stages. */
function buildAtempoChain(speed: number): string[] {
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

function escapeFFmpeg(value: string): string {
  return value.replace(/'/g, "\\'");
}

export async function exportProject(
  input: ExportInput,
  options: ExportOptions,
): Promise<Blob> {
  const { clips, tracks, assets } = input;
  const videoTrack = tracks.find((t) => t.kind === 'video');
  const audioTrack = tracks.find((t) => t.kind === 'audio');

  const videoClips = clips
    .filter((c) => videoTrack && c.trackId === videoTrack.id)
    .sort((a, b) => a.start - b.start);
  const audioClips = clips
    .filter((c) => audioTrack && c.trackId === audioTrack.id)
    .sort((a, b) => a.start - b.start);

  if (videoClips.length === 0) {
    throw new Error('映像クリップがありません');
  }

  const { width, height } = getResolution(options.resolution, options.aspectRatio);
  const targetFps = options.fps;

  options.onProgress?.({ stage: 'FFmpeg を読み込み中', percent: 0 });
  const ffmpeg = await getFFmpeg();

  const logHandler = ({ message }: { message: string }) => {
    options.onProgress?.({ stage: 'FFmpeg', percent: 0, log: message });
  };
  ffmpeg.on('log', logHandler);

  // Track which input files are already written so we don't duplicate work
  // for assets used by multiple clips.
  const writtenAssets = new Set<string>();
  const tempVideoNames: string[] = [];

  try {
    // 1. Render each video clip with effects/speed/fades.
    for (let i = 0; i < videoClips.length; i++) {
      const clip = videoClips[i];
      const asset = assets.find((a) => a.id === clip.assetId);
      if (!asset) continue;

      const ext = asset.file.name.split('.').pop() ?? 'mp4';
      const inputName = `vinput_${asset.id}.${ext}`;
      const outputName = `vclip_${i}.mp4`;

      options.onProgress?.({
        stage: `映像処理 ${i + 1}/${videoClips.length}`,
        percent: (i / videoClips.length) * 0.7,
      });

      if (!writtenAssets.has(asset.id)) {
        await ffmpeg.writeFile(inputName, await fetchFile(asset.file));
        writtenAssets.add(asset.id);
      }

      const speed = clip.speed ?? 1;
      const fadeIn = clip.effects.find((e) => e.type === 'fade-in');
      const fadeOut = clip.effects.find((e) => e.type === 'fade-out');
      const motionBlur = clip.effects.find((e) => e.type === 'motion-blur');
      const trackMuted = videoTrack?.muted ?? false;
      const clipMuted = clip.muted ?? false;
      const clipVolume = clipMuted || trackMuted ? 0 : (clip.volume ?? 1);
      const sourceTrimStart = clip.trimStart;
      const sourceTrimEnd = clip.trimEnd;
      const timelineDur = (sourceTrimEnd - sourceTrimStart) / speed;

      const videoFilters: string[] = [];
      if (Math.abs(speed - 1) > 1e-3) {
        videoFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
      }
      videoFilters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      );
      videoFilters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
      videoFilters.push('setsar=1');
      videoFilters.push(`fps=${targetFps}`);
      if (motionBlur) {
        // Map intensity 5–100 → tmix frame count 2–8. tmix defaults to equal
        // weights when omitted, which gives a balanced temporal blur.
        const intensity = Math.max(5, Math.min(100, motionBlur.intensity ?? 40));
        const frames = Math.max(2, Math.min(8, Math.round(2 + (intensity / 100) * 6)));
        videoFilters.push(`tmix=frames=${frames}`);
      }
      if (fadeIn) {
        const d = Math.max(0.05, fadeIn.duration ?? 0.4);
        videoFilters.push(`fade=t=in:st=0:d=${d.toFixed(3)}`);
      }
      if (fadeOut) {
        const d = Math.max(0.05, fadeOut.duration ?? 0.4);
        const start = Math.max(0, timelineDur - d);
        videoFilters.push(`fade=t=out:st=${start.toFixed(3)}:d=${d.toFixed(3)}`);
      }

      const audioFilters: string[] = [];
      audioFilters.push(...buildAtempoChain(speed));
      audioFilters.push(`volume=${clipVolume.toFixed(3)}`);

      const filterComplex =
        `[0:v]${videoFilters.join(',')}[v];[0:a]${audioFilters.join(',')}[a]`;

      await ffmpeg.exec([
        '-ss',
        sourceTrimStart.toFixed(4),
        '-to',
        sourceTrimEnd.toFixed(4),
        '-i',
        inputName,
        '-filter_complex',
        filterComplex,
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-y',
        outputName,
      ]);
      tempVideoNames.push(outputName);
    }

    // 2. Concatenate the rendered video clips.
    options.onProgress?.({ stage: '結合中', percent: 0.78 });
    let videoOutput = 'video_only.mp4';
    if (tempVideoNames.length === 1) {
      videoOutput = tempVideoNames[0];
    } else {
      const listContent = tempVideoNames.map((f) => `file '${escapeFFmpeg(f)}'`).join('\n');
      await ffmpeg.writeFile('concat.txt', new TextEncoder().encode(listContent));
      await ffmpeg.exec([
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'concat.txt',
        '-c',
        'copy',
        '-y',
        videoOutput,
      ]);
    }

    // 3. Mix BGM (if present and audio track not muted).
    let finalOutput = videoOutput;
    if (audioClips.length > 0 && !audioTrack?.muted) {
      options.onProgress?.({ stage: 'BGM 合成中', percent: 0.9 });

      const audioInputs: string[] = [];
      const filterParts: string[] = [];
      let inputIndex = 1; // 0 is the video file
      for (let i = 0; i < audioClips.length; i++) {
        const clip = audioClips[i];
        const asset = assets.find((a) => a.id === clip.assetId);
        if (!asset) continue;
        const ext = asset.file.name.split('.').pop() ?? 'mp3';
        const inputName = `ainput_${asset.id}.${ext}`;
        if (!writtenAssets.has(asset.id)) {
          await ffmpeg.writeFile(inputName, await fetchFile(asset.file));
          writtenAssets.add(asset.id);
        }
        audioInputs.push('-i', inputName);

        const speed = clip.speed ?? 1;
        const trackMutedA = audioTrack?.muted ?? false;
        const clipMutedA = clip.muted ?? false;
        const vol = clipMutedA || trackMutedA ? 0 : (clip.volume ?? 1);
        const startMs = Math.round(clip.start * 1000);

        const filters: string[] = [];
        filters.push(`atrim=${clip.trimStart.toFixed(4)}:${clip.trimEnd.toFixed(4)}`);
        filters.push('asetpts=PTS-STARTPTS');
        filters.push(...buildAtempoChain(speed));
        filters.push(`volume=${vol.toFixed(3)}`);
        if (startMs > 0) filters.push(`adelay=${startMs}|${startMs}`);

        filterParts.push(`[${inputIndex}:a]${filters.join(',')}[a${i}]`);
        inputIndex++;
      }

      const mixLabels = audioClips.map((_, i) => `[a${i}]`).join('');
      const totalInputs = audioClips.length + 1;
      const filterComplex = `${filterParts.join(';')};${mixLabels}[0:a]amix=inputs=${totalInputs}:duration=first:dropout_transition=0:normalize=0[aout]`;

      await ffmpeg.exec([
        '-i',
        videoOutput,
        ...audioInputs,
        '-filter_complex',
        filterComplex,
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-y',
        'final.mp4',
      ]);
      finalOutput = 'final.mp4';
    }

    options.onProgress?.({ stage: '完成', percent: 1 });
    const data = await ffmpeg.readFile(finalOutput);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    // Ensure we return an ArrayBuffer-backed view (not SharedArrayBuffer).
    const ab = new Uint8Array(bytes.byteLength);
    ab.set(bytes);
    return new Blob([ab.buffer], { type: 'video/mp4' });
  } finally {
    ffmpeg.off('log', logHandler);
    // Cleanup temp files
    for (const name of tempVideoNames) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }
    }
    try {
      await ffmpeg.deleteFile('concat.txt');
    } catch {
      /* ignore */
    }
  }
}
