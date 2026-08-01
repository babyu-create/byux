import {
  getResolution,
  type ExportInput,
  type ExportOptions,
} from './exporter';
import { rasterizeOverlays } from './overlayRaster';
import {
  MAX_MOTION_TRACK_SIMPLIFICATION_ERROR_PERCENT,
  MAX_NATIVE_KEYFRAMES_PER_PROPERTY,
} from './nativeExportLimits';
import { simplifyMotionTrackKeyframes } from './motionTracker';
import { clipDuration } from './timeline';
import type { Animatable, Keyframe } from './keyframes';
import type { Clip, KillMarker, MediaAsset, SubtitleCue, SubtitleStyle, Track } from './types';

export type NativeExportOptions = Omit<ExportOptions, 'signal' | 'onProgress'>;
export type NativeEncodingPreference = 'auto' | 'software';

export interface NativeExportAsset {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  size: number;
  width?: number;
  height?: number;
  /** Present only when this asset is consumed by a visible/playable lane. */
  sourceToken?: string;
  audioStreamIndex?: number | null;
}

export interface NativeExportOverlay {
  clipId: string;
  png: Uint8Array<ArrayBuffer>;
}

export interface NativeExportRequest {
  version: 1;
  encodingPreference: NativeEncodingPreference;
  options: NativeExportOptions;
  clips: Clip[];
  tracks: Track[];
  markers: KillMarker[];
  subtitles: SubtitleCue[];
  subtitleStyle?: SubtitleStyle;
  assets: NativeExportAsset[];
  overlays: NativeExportOverlay[];
}

export interface NativeExportCompatibility {
  compatible: boolean;
  reasons: string[];
  duration: number;
}

const MAX_NATIVE_ASSETS = 2_000;
const MAX_NATIVE_OVERLAYS = 512;
const MAX_NATIVE_OVERLAY_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_OVERLAY_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_OVERLAY_DECODED_BYTES = 512 * 1024 * 1024;
interface ExportedVisualClip {
  clip: Clip;
  indexInTrack: number;
  totalInTrack: number;
}

/**
 * Native export composites every visible video/overlay lane. Keep overlay
 * rasterization in track order and use track-local {n}/{total} values, which
 * is also how the preview numbers clips on its active visual lane.
 */
function exportedVisualClips(input: ExportInput): ExportedVisualClip[] {
  const result: ExportedVisualClip[] = [];
  for (const track of input.tracks) {
    if (track.hidden || (track.kind !== 'video' && track.kind !== 'overlay')) {
      continue;
    }
    const clips = input.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((a, b) => a.start - b.start);
    clips.forEach((clip, indexInTrack) => {
      result.push({ clip, indexInTrack, totalInTrack: clips.length });
    });
  }
  return result;
}

function requiredNativeSourceAssetIds(input: ExportInput): Set<string> {
  const trackById = new Map(input.tracks.map((track) => [track.id, track]));
  const required = new Set<string>();
  for (const clip of input.clips) {
    const track = trackById.get(clip.trackId);
    if (!track || track.hidden) continue;
    if (
      track.kind === 'video' ||
      track.kind === 'overlay' ||
      (track.kind === 'audio' && !track.muted && !clip.muted)
    ) {
      required.add(clip.assetId);
    }
  }
  return required;
}

function exportSafeTrackingPair(
  x: Animatable | undefined,
  y: Animatable | undefined,
): { x: Keyframe[]; y: Keyframe[] } | null {
  if (!Array.isArray(x) || !Array.isArray(y)) return null;
  if (
    x.length <= MAX_NATIVE_KEYFRAMES_PER_PROPERTY &&
    y.length <= MAX_NATIVE_KEYFRAMES_PER_PROPERTY
  ) {
    return { x, y };
  }
  if (
    x.some((keyframe) => keyframe.easing && keyframe.easing !== 'linear') ||
    y.some((keyframe) => keyframe.easing && keyframe.easing !== 'linear')
  ) return null;
  try {
    const simplified = simplifyMotionTrackKeyframes(x, y);
    if (simplified.maximumError > MAX_MOTION_TRACK_SIMPLIFICATION_ERROR_PERCENT) {
      return null;
    }
    return { x: simplified.x, y: simplified.y };
  } catch {
    return null;
  }
}

/**
 * Upgrade dense tracking data saved by versions before export-safe trajectory
 * simplification. Only aligned, linear X/Y pairs are touched; authored easing
 * and paths that cannot meet the visual error bound remain unchanged so the
 * normal compatibility error is shown instead of silently changing motion.
 */
export function prepareClipsForNativeExport(clips: readonly Clip[]): Clip[] {
  return clips.map((clip) => {
    let changed = false;
    const transform = clip.transform;
    // Clip transform keyframes may be deliberately hand-authored and have no
    // provenance marker in older project files. Never rewrite them implicitly.
    // New tracker output is already <=64; overlay.tracking is explicit and can
    // be upgraded safely below.
    const overlays = clip.overlays?.map((overlay) => {
      if (!overlay.tracking) return overlay;
      const pair = exportSafeTrackingPair(
        overlay.tracking.x,
        overlay.tracking.y,
      );
      if (
        !pair ||
        (pair.x === overlay.tracking.x && pair.y === overlay.tracking.y)
      ) return overlay;
      changed = true;
      return { ...overlay, tracking: pair };
    });
    return changed ? { ...clip, transform, overlays } : clip;
  });
}

export function getNativeExportCompatibility(
  input: ExportInput,
  options: ExportOptions,
): NativeExportCompatibility {
  void options;
  const exportClips = prepareClipsForNativeExport(input.clips);
  const exportInput = exportClips === input.clips ? input : { ...input, clips: exportClips };
  const visualClips = exportedVisualClips(exportInput);
  const mainVideoTrack = input.tracks.find(
    (track) =>
      track.kind === 'video' &&
      !track.hidden &&
      input.clips.some((clip) => clip.trackId === track.id),
  );
  const hasBaseVideoClip = Boolean(
    mainVideoTrack &&
      exportClips.some((clip) => clip.trackId === mainVideoTrack.id),
  );
  const hasOversizedKeyframeProperty = exportClips.some((clip) => {
    const transformTooLarge = Object.values(clip.transform ?? {}).some(
      (value) => Array.isArray(value) && value.length > MAX_NATIVE_KEYFRAMES_PER_PROPERTY,
    );
    const overlayTrackingTooLarge = clip.overlays?.some((overlay) =>
      Object.values(overlay.tracking ?? {}).some(
        (value) => Array.isArray(value) && value.length > MAX_NATIVE_KEYFRAMES_PER_PROPERTY,
      ),
    ) ?? false;
    return transformTooLarge || overlayTrackingTooLarge;
  });
  const reasons = [
    ...(hasBaseVideoClip ? [] : ['表示中のメイン映像クリップがありません']),
    ...(hasOversizedKeyframeProperty
      ? [
          `1項目あたり${MAX_NATIVE_KEYFRAMES_PER_PROPERTY}個を超えるキーフレーム`,
        ]
      : []),
  ];

  const duration = visualClips.reduce(
    (end, { clip }) => Math.max(end, clip.start + clipDuration(clip)),
    0,
  );
  return {
    compatible: reasons.length === 0,
    reasons,
    duration,
  };
}

function abortError(): Error {
  const error = new Error('書き出しが中止されました');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function serializableOptions(options: ExportOptions): NativeExportOptions {
  const {
    signal: ignoredSignal,
    onProgress: ignoredProgress,
    ...requestOptions
  } = options;
  void ignoredSignal;
  void ignoredProgress;
  return {
    ...requestOptions,
    audioDucking: requestOptions.audioDucking
      ? { ...requestOptions.audioDucking }
      : undefined,
  };
}

function cloneClips(clips: readonly Clip[]): Clip[] {
  return clips.map((clip) => structuredClone(clip));
}

/**
 * A disk proxy preserves aspect ratio but may be exactly the selected output
 * size even when its original source is much larger. Treating those proxy
 * dimensions as authoritative would make both graph builders skip `scale` and
 * accidentally export the original at its source resolution.
 */
function nativeSourceDimensions(
  asset: MediaAsset,
  outputWidth: number,
  outputHeight: number,
): { width?: number; height?: number } {
  if (
    asset.previewProxy &&
    asset.width === outputWidth &&
    asset.height === outputHeight
  ) {
    return {
      width: outputWidth * 2,
      height: outputHeight * 2,
    };
  }
  return { width: asset.width, height: asset.height };
}

async function releaseTemporaryTokens(tokens: ReadonlySet<string>): Promise<void> {
  if (tokens.size === 0) return;
  const releaseMediaFile = window.fce?.releaseMediaFile;
  if (!releaseMediaFile) {
    throw new Error('一時的に登録した素材を解放できません');
  }
  const results = await Promise.allSettled(
    [...tokens].map((token) => releaseMediaFile(token)),
  );
  const failure = results.find(
    (result) => result.status === 'rejected' ||
      (result.status === 'fulfilled' && result.value !== true),
  );
  if (failure) {
    throw new Error(
      '一時的に登録した素材を解放できません',
      failure.status === 'rejected' ? { cause: failure.reason } : undefined,
    );
  }
}

export async function prepareNativeExportRequest(
  input: ExportInput,
  options: ExportOptions,
  onProgress?: ExportOptions['onProgress'],
  encodingPreference: NativeEncodingPreference = 'auto',
): Promise<{ request: NativeExportRequest; release(): Promise<void> }> {
  throwIfAborted(options.signal);
  const exportInput = {
    ...input,
    clips: prepareClipsForNativeExport(input.clips),
  };
  const compatibility = getNativeExportCompatibility(exportInput, options);
  if (!compatibility.compatible) {
    throw new Error(
      `このプロジェクトはネイティブ書き出しを利用できません: ${
        compatibility.reasons.join(' / ')
      }`,
    );
  }

  const progress = onProgress ?? options.onProgress;
  progress?.({ stage: 'ネイティブ書き出しを準備中', percent: -1 });

  const referencedAssetIds = new Set(exportInput.clips.map((clip) => clip.assetId));
  const requiredSourceAssetIds = requiredNativeSourceAssetIds(exportInput);
  if (referencedAssetIds.size > MAX_NATIVE_ASSETS) {
    throw new Error(
      `ネイティブ書き出しで扱える素材数 ${MAX_NATIVE_ASSETS} を超えています`,
    );
  }
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  for (const assetId of referencedAssetIds) {
    if (!assetsById.has(assetId)) {
      throw new Error(`元素材が見つかりません: ${assetId}`);
    }
  }

  const temporaryTokens = new Set<string>();
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    await releaseTemporaryTokens(temporaryTokens);
    released = true;
  };

  try {
    const { width, height } = getResolution(
      options.resolution,
      options.aspectRatio,
    );
    const requestAssets: NativeExportAsset[] = [];
    for (const asset of input.assets) {
      if (!referencedAssetIds.has(asset.id)) continue;
      throwIfAborted(options.signal);

      const requiresSource = requiredSourceAssetIds.has(asset.id);
      let sourceToken = requiresSource ? asset.sourceToken : undefined;
      if (requiresSource && !sourceToken) {
        const registerMediaFile = window.fce?.registerMediaFile;
        const registerMediaFileFromFile = window.fce?.registerMediaFileFromFile;
        const releaseMediaFile = window.fce?.releaseMediaFile;
        if (!releaseMediaFile) {
          throw new Error(
            `素材をネイティブ書き出し用に登録できません: ${asset.name}`,
          );
        }
        let registered:
          | { token: string; url: string; size: number }
          | undefined;
        if (asset.file && registerMediaFileFromFile) {
          const result = await registerMediaFileFromFile(asset.file, asset.kind);
          if (result.ok) registered = result.source;
        }
        if (!registered && asset.path && registerMediaFile) {
          registered =
            (await registerMediaFile({
              path: asset.path,
              name: asset.name,
              size: asset.size,
              kind: asset.kind,
            })) ?? undefined;
        }
        if (!registered?.token) {
          throw new Error(
            `素材との接続が失われました: ${asset.name}。` +
              '素材一覧から削除し、「ファイルを追加」ボタンで元ファイルを選び直してください',
          );
        }
        sourceToken = registered.token;
        temporaryTokens.add(sourceToken);
        throwIfAborted(options.signal);
      }

      const sourceDimensions = nativeSourceDimensions(asset, width, height);
      requestAssets.push({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        size: asset.size,
        width: sourceDimensions.width,
        height: sourceDimensions.height,
        ...(sourceToken ? { sourceToken } : {}),
        ...(asset.audioStreamIndex !== undefined
          ? { audioStreamIndex: asset.audioStreamIndex }
          : {}),
      });
    }

    const visualClips = exportedVisualClips(exportInput);
    const overlayClipCount = visualClips.filter(
      ({ clip }) => clip.overlays && clip.overlays.length > 0,
    ).length;
    if (overlayClipCount > MAX_NATIVE_OVERLAYS) {
      throw new Error(
        `ネイティブ書き出しで扱えるテキスト画像数 ${MAX_NATIVE_OVERLAYS} を超えています`,
      );
    }
    // FFmpeg keeps one decoded RGBA frame for each looped overlay input.
    // Compressed PNG byte limits alone do not bound this working set.
    if (
      overlayClipCount * width * height * 4 >
      MAX_NATIVE_OVERLAY_DECODED_BYTES
    ) {
      throw new Error(
        'テキスト画像が多すぎて安全に書き出せません。クリップを分割してください',
      );
    }
    const overlays: NativeExportOverlay[] = [];
    let overlayBytes = 0;
    for (const { clip, indexInTrack, totalInTrack } of visualClips) {
      throwIfAborted(options.signal);
      if (!clip.overlays || clip.overlays.length === 0) continue;
      progress?.({ stage: 'テキストを準備中', percent: -1 });
      const png = await rasterizeOverlays(
        clip.overlays,
        width,
        height,
        {
          n: String(indexInTrack + 1),
          total: String(totalInTrack),
        },
      );
      throwIfAborted(options.signal);
      if (!png) {
        throw new Error(
          `テキストを画像化できませんでした: クリップ ${clip.id}`,
        );
      }
      overlayBytes += png.byteLength;
      if (
        png.byteLength > MAX_NATIVE_OVERLAY_BYTES ||
        overlayBytes > MAX_NATIVE_OVERLAY_TOTAL_BYTES
      ) {
        throw new Error(
          'テキスト画像が大きすぎます。解像度またはテキスト数を減らしてください',
        );
      }
      const ownedPng = new Uint8Array(png.byteLength);
      ownedPng.set(png);
      overlays.push({ clipId: clip.id, png: ownedPng });
    }

    const request: NativeExportRequest = {
      version: 1,
      encodingPreference,
      options: serializableOptions(options),
      clips: cloneClips(exportInput.clips),
      tracks: input.tracks.map((track) => ({ ...track })),
      markers: (input.markers ?? []).map((marker) => ({ ...marker })),
      subtitles: (input.subtitles ?? []).map((cue) => ({ ...cue })),
      subtitleStyle: input.subtitleStyle ? { ...input.subtitleStyle } : undefined,
      assets: requestAssets,
      overlays,
    };
    progress?.({ stage: 'ネイティブ書き出しの準備完了', percent: -1 });
    return { request, release };
  } catch (error) {
    try {
      await release();
    } catch {
      // Preserve the actionable preparation error. The main process also
      // expires registrations when the renderer session closes.
    }
    throw error;
  }
}
