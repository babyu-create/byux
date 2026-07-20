import {
  getResolution,
  type ExportInput,
  type ExportOptions,
} from './exporter';
import { clipHasTransform } from './clipTransform';
import { clipHasColorGrade } from './colorGrade';
import { rasterizeOverlays } from './overlayRaster';
import { hasSpeedRamp } from './speedRamp';
import { clipDuration } from './timeline';
import { clipHasTransition } from './transitions';
import type { Clip, KillMarker, MediaAsset, Track } from './types';

export type NativeExportOptions = Omit<ExportOptions, 'signal' | 'onProgress'>;

export interface NativeExportAsset {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  size: number;
  width?: number;
  height?: number;
  sourceToken: string;
}

export interface NativeExportOverlay {
  clipId: string;
  png: Uint8Array<ArrayBuffer>;
}

export interface NativeExportRequest {
  version: 1;
  options: NativeExportOptions;
  clips: Clip[];
  tracks: Track[];
  markers: KillMarker[];
  assets: NativeExportAsset[];
  overlays: NativeExportOverlay[];
}

export interface NativeExportCompatibility {
  compatible: boolean;
  reasons: string[];
  duration: number;
}

const REASON_SPEED_RAMP =
  '速度ランプを含むクリップはネイティブ書き出しに未対応です';
const REASON_TRANSFORM =
  'トランスフォームを含むクリップはネイティブ書き出しに未対応です';
const REASON_COLOR_GRADE =
  'カラー調整を含むクリップはネイティブ書き出しに未対応です';
const REASON_TRANSITION =
  'トランジションを含むクリップはネイティブ書き出しに未対応です';
const REASON_MOTION_BLUR =
  'モーションブラーはネイティブ書き出しに未対応です';
const REASON_UNSUPPORTED_LANES =
  'サブ映像/オーバーレイトラックは書き出し未対応です';
const MAX_NATIVE_ASSETS = 2_000;
const MAX_NATIVE_OVERLAYS = 512;
const MAX_NATIVE_OVERLAY_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_OVERLAY_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_OVERLAY_DECODED_BYTES = 512 * 1024 * 1024;

function exportedVideoClips(input: ExportInput): Clip[] {
  const videoTrack = input.tracks.find((track) => track.kind === 'video');
  if (!videoTrack || videoTrack.hidden) return [];
  return input.clips
    .filter((clip) => clip.trackId === videoTrack.id)
    .sort((a, b) => a.start - b.start);
}

export function getNativeExportCompatibility(
  input: ExportInput,
  options: ExportOptions,
): NativeExportCompatibility {
  const videoClips = exportedVideoClips(input);
  const reasons: string[] = [];

  // Main-process validation examines the complete semantic request, not only
  // the primary video lane. Mirror that here so a malformed/legacy hidden clip
  // cannot pass renderer preflight and then fail after the save dialog opens.
  if (input.clips.some((clip) => hasSpeedRamp(clip.speedRamp))) {
    reasons.push(REASON_SPEED_RAMP);
  }
  if (input.clips.some((clip) => clipHasTransform(clip.transform))) {
    reasons.push(REASON_TRANSFORM);
  }
  if (input.clips.some((clip) => clipHasColorGrade(clip.colorGrade))) {
    reasons.push(REASON_COLOR_GRADE);
  }
  if (
    input.clips.some((clip) =>
      clipHasTransition(clip.transitionIn, clip.transitionOut),
    )
  ) {
    reasons.push(REASON_TRANSITION);
  }
  if (options.motionBlur === true) {
    reasons.push(REASON_MOTION_BLUR);
  }
  const mainVideoTrack = input.tracks.find((track) => track.kind === 'video');
  const hasUnsupportedLane = input.clips.some((clip) => {
    const track = input.tracks.find((candidate) => candidate.id === clip.trackId);
    return Boolean(
      track &&
      !track.hidden &&
      (track.kind === 'overlay' ||
        (track.kind === 'video' && track.id !== mainVideoTrack?.id)),
    );
  });
  if (hasUnsupportedLane) reasons.push(REASON_UNSUPPORTED_LANES);

  const duration = videoClips.reduce(
    (end, clip) => Math.max(end, clip.start + clipDuration(clip)),
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
): Promise<{ request: NativeExportRequest; release(): Promise<void> }> {
  throwIfAborted(options.signal);
  const compatibility = getNativeExportCompatibility(input, options);
  if (!compatibility.compatible) {
    throw new Error(
      `このプロジェクトはネイティブ書き出しを利用できません: ${
        compatibility.reasons.join(' / ')
      }`,
    );
  }

  const progress = onProgress ?? options.onProgress;
  progress?.({ stage: 'ネイティブ書き出しを準備中', percent: -1 });

  const referencedAssetIds = new Set(input.clips.map((clip) => clip.assetId));
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

      let sourceToken = asset.sourceToken;
      if (!sourceToken) {
        const registerMediaFile = window.fce?.registerMediaFile;
        const releaseMediaFile = window.fce?.releaseMediaFile;
        if (!asset.path || !registerMediaFile || !releaseMediaFile) {
          throw new Error(
            `素材をネイティブ書き出し用に登録できません: ${asset.name}`,
          );
        }
        const registered = await registerMediaFile({
          path: asset.path,
          name: asset.name,
          size: asset.size,
          kind: asset.kind,
        });
        if (!registered?.token) {
          throw new Error(
            `素材をネイティブ書き出し用に登録できません: ${asset.name}`,
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
        sourceToken,
      });
    }

    const videoClips = exportedVideoClips(input);
    const overlayClipCount = videoClips.filter(
      (clip) => clip.overlays && clip.overlays.length > 0,
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
    for (let index = 0; index < videoClips.length; index++) {
      throwIfAborted(options.signal);
      const clip = videoClips[index];
      if (!clip.overlays || clip.overlays.length === 0) continue;
      progress?.({ stage: 'テキストを準備中', percent: -1 });
      const png = await rasterizeOverlays(
        clip.overlays,
        width,
        height,
        {
          n: String(index + 1),
          total: String(videoClips.length),
        },
      );
      throwIfAborted(options.signal);
      if (!png) {
        throw new Error(
          `テキストを画像化できませんでした: クリップ ${index + 1}`,
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
      options: serializableOptions(options),
      clips: cloneClips(input.clips),
      tracks: input.tracks.map((track) => ({ ...track })),
      markers: (input.markers ?? []).map((marker) => ({ ...marker })),
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
