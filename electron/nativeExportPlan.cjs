'use strict';

// Pure, main-process-owned native FFmpeg render-plan builder.
//
// The renderer sends a semantic project snapshot (clips/tracks/options and
// opaque source tokens). Absolute paths and FFmpeg arguments are resolved and
// generated in the main process, so renderer input can never smuggle a second
// output, a network protocol, or a `movie=` file read into FFmpeg.

const MAX_CLIPS = 10_000;
const MAX_TRACKS = 100;
const MAX_ASSETS = 2_000;
const MAX_OVERLAYS = 512;
const MAX_OVERLAY_ITEMS = 5_000;
const MAX_MARKERS = 10_000;
const MAX_TIMELINE_SECONDS = 7 * 24 * 60 * 60;
const EPS = 1e-4;

class NativeExportPlanError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'NativeExportPlanError';
    this.code = code;
    this.details = details;
  }
}

function finite(value, label, min, max) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new NativeExportPlanError('INVALID_PROJECT', `${label}が不正です`);
  }
  return value;
}

function safeId(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new NativeExportPlanError('INVALID_PROJECT', `${label}が不正です`);
  }
  return value;
}

function getResolution(resolution, aspectRatio) {
  if (resolution !== '720p' && resolution !== '1080p') {
    throw new NativeExportPlanError('INVALID_OPTIONS', '解像度が不正です');
  }
  if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
    throw new NativeExportPlanError('INVALID_OPTIONS', 'アスペクト比が不正です');
  }
  if (aspectRatio === '16:9') {
    return resolution === '1080p'
      ? { width: 1920, height: 1080 }
      : { width: 1280, height: 720 };
  }
  return resolution === '1080p'
    ? { width: 1080, height: 1920 }
    : { width: 720, height: 1280 };
}

function encodingSettings(quality) {
  if (quality === 'high') return { preset: 'veryfast', crf: 16, audioBitrate: '256k' };
  if (quality === 'compact') return { preset: 'superfast', crf: 27, audioBitrate: '256k' };
  if (quality !== undefined && quality !== 'recommended') {
    throw new NativeExportPlanError('INVALID_OPTIONS', '画質設定が不正です');
  }
  return { preset: 'superfast', crf: 20, audioBitrate: '256k' };
}

function clipDuration(clip) {
  const speed = finite(clip.speed ?? 1, '再生速度', 0.0625, 4);
  const trimStart = finite(clip.trimStart, 'トリム開始', 0, MAX_TIMELINE_SECONDS);
  const trimEnd = finite(clip.trimEnd, 'トリム終了', 0, MAX_TIMELINE_SECONDS);
  if (trimEnd <= trimStart + EPS) {
    throw new NativeExportPlanError(
      'INVALID_PROJECT',
      `クリップの長さが不正です: ${String(clip.id || '')}`,
    );
  }
  return (trimEnd - trimStart) / speed;
}

function buildTimeline(clips) {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const result = [];
  let cursor = 0;
  for (const clip of sorted) {
    const start = finite(clip.start, 'クリップ開始位置', 0, MAX_TIMELINE_SECONDS);
    const duration = clipDuration(clip);
    if (start < cursor - EPS) {
      throw new NativeExportPlanError(
        'OVERLAPPING_VIDEO',
        `映像クリップが重なっています: ${String(clip.id || '')}`,
      );
    }
    if (start > cursor + EPS) result.push({ kind: 'gap', start: cursor, end: start });
    const end = start + duration;
    if (end > MAX_TIMELINE_SECONDS) {
      throw new NativeExportPlanError('INVALID_PROJECT', 'タイムラインが長すぎます');
    }
    result.push({ kind: 'clip', start, end, clip });
    cursor = end;
  }
  return result;
}

function buildAtempoChain(speed) {
  if (Math.abs(speed - 1) < 1e-3) return [];
  const result = [];
  let remaining = speed;
  while (remaining < 0.5) {
    result.push('atempo=0.5');
    remaining /= 0.5;
  }
  while (remaining > 2) {
    result.push('atempo=2.0');
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 1e-3) {
    result.push(`atempo=${remaining.toFixed(4)}`);
  }
  return result;
}

function buildClipFilters(spec) {
  const {
    inputIndex,
    clip,
    asset,
    width,
    height,
    fps,
    videoTrackMuted,
    hasAudio,
    reframe,
    videoLabel,
    audioLabel,
  } = spec;
  const speed = clip.speed ?? 1;
  const duration = clipDuration(clip);
  const clipVolume = clip.muted || videoTrackMuted
    ? 0
    : finite(clip.volume ?? 1, 'クリップ音量', 0, 2);
  const videoFilters = [
    `trim=${clip.trimStart.toFixed(4)}:${clip.trimEnd.toFixed(4)}`,
    'setpts=PTS-STARTPTS',
  ];
  if (Math.abs(speed - 1) > 1e-3) {
    videoFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  }

  const sourceMatchesOutput = asset.width === width && asset.height === height;
  const sourceWidth = Number(asset.width) || 0;
  const sourceHeight = Number(asset.height) || 0;
  const sourceWiderThanOutput =
    sourceWidth > 0 &&
    sourceHeight > 0 &&
    sourceWidth / sourceHeight > width / height + 1e-3;
  if (clip.stretchToFill === true) {
    videoFilters.push(`scale=${width}:${height}`);
  } else if (height > width && sourceWiderThanOutput) {
    const pan = ((Math.max(-1, Math.min(1, reframe)) + 1) / 2).toFixed(4);
    videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`);
    videoFilters.push(`crop=${width}:${height}:(iw-ow)*${pan}:(ih-oh)/2`);
  } else if (!sourceMatchesOutput) {
    videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
    videoFilters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  }
  videoFilters.push('setsar=1', `fps=${fps}`);

  const effects = Array.isArray(clip.effects) ? clip.effects : [];
  const fadeIn = effects.find((effect) => effect?.type === 'fade-in');
  if (fadeIn) {
    const fadeDuration = Math.max(
      0.05,
      Math.min(duration, finite(fadeIn.duration ?? 0.4, 'フェード時間', 0, MAX_TIMELINE_SECONDS)),
    );
    videoFilters.push(`fade=t=in:st=0:d=${fadeDuration.toFixed(3)}`);
  }
  const fadeOut = effects.find((effect) => effect?.type === 'fade-out');
  if (fadeOut) {
    const fadeDuration = Math.max(
      0.05,
      Math.min(duration, finite(fadeOut.duration ?? 0.4, 'フェード時間', 0, MAX_TIMELINE_SECONDS)),
    );
    videoFilters.push(
      `fade=t=out:st=${Math.max(0, duration - fadeDuration).toFixed(3)}:` +
      `d=${fadeDuration.toFixed(3)}`,
    );
  }

  const videoChain = `[${inputIndex}:v]${videoFilters.join(',')}${videoLabel}`;
  if (!hasAudio) {
    return (
      `${videoChain};` +
      `anullsrc=r=44100:cl=stereo,atrim=0:${duration.toFixed(4)},` +
      `asetpts=PTS-STARTPTS,volume=${clipVolume.toFixed(3)}${audioLabel}`
    );
  }
  const audioFilters = [
    `atrim=${clip.trimStart.toFixed(4)}:${clip.trimEnd.toFixed(4)}`,
    'asetpts=PTS-STARTPTS',
    ...buildAtempoChain(speed),
    `volume=${clipVolume.toFixed(3)}`,
  ];
  return `${videoChain};[${inputIndex}:a]${audioFilters.join(',')}${audioLabel}`;
}

function hasUnsupportedTransform(transform) {
  if (!transform || typeof transform !== 'object') return false;
  const identity = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  for (const [key, base] of Object.entries(identity)) {
    const value = transform[key];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value - base) > EPS) {
      return true;
    }
  }
  return false;
}

function hasUnsupportedColorGrade(grade) {
  if (!grade || typeof grade !== 'object') return false;
  if (grade.preset && grade.preset !== 'none') return true;
  return ['exposure', 'contrast', 'saturation', 'temperature'].some(
    (key) => typeof grade[key] === 'number' && Math.abs(grade[key]) > EPS,
  );
}

function hasActiveTransition(value) {
  return Boolean(value && value.type !== 'none' && value.type !== 'cut');
}

function collectUnsupportedFeatures(request) {
  const reasons = new Set();
  if (request?.options?.motionBlur === true) reasons.add('HUD対応モーションブラー');
  const clips = Array.isArray(request?.clips) ? request.clips : [];
  for (const clip of clips) {
    const ramp = clip?.speedRamp;
    if (
      ramp &&
      Number.isFinite(ramp.from) &&
      Number.isFinite(ramp.to) &&
      Math.abs(ramp.from - ramp.to) > 1e-6
    ) {
      reasons.add('速度ランプ');
    }
    if (hasUnsupportedTransform(clip?.transform)) reasons.add('キーフレーム/変形');
    if (hasUnsupportedColorGrade(clip?.colorGrade)) reasons.add('カラー調整');
    if (
      hasActiveTransition(clip?.transitionIn) ||
      hasActiveTransition(clip?.transitionOut)
    ) {
      reasons.add('クリップトランジション');
    }
  }
  return [...reasons];
}

function resolveDucking(raw) {
  const duck = raw && typeof raw === 'object' ? raw : {};
  const amountDb = Number.isFinite(duck.amountDb)
    ? Math.max(0, Math.min(40, duck.amountDb))
    : 12;
  const attack = Number.isFinite(duck.attack)
    ? Math.max(0.02, Math.min(3, duck.attack))
    : 0.2;
  const release = Number.isFinite(duck.release)
    ? Math.max(0.02, Math.min(3, duck.release))
    : 0.6;
  return {
    enabled: duck.enabled === true && amountDb > 1e-3,
    attack,
    release,
    floorGain: Math.pow(10, -amountDb / 20),
  };
}

function buildDuckExpression(markers, videoClips, rawDucking) {
  const duck = resolveDucking(rawDucking);
  if (!duck.enabled || !Array.isArray(markers) || markers.length === 0) return null;
  const points = [];
  for (const clip of videoClips) {
    const speed = clip.speed ?? 1;
    for (const marker of markers) {
      if (
        marker?.assetId !== clip.assetId ||
        !Number.isFinite(marker.time) ||
        marker.time < clip.trimStart - 1e-6 ||
        marker.time > clip.trimEnd + 1e-6
      ) {
        continue;
      }
      points.push(clip.start + (marker.time - clip.trimStart) / speed);
    }
  }
  points.sort((a, b) => a - b);
  const merged = [];
  const minGap = duck.attack + duck.release;
  for (const point of points) {
    if (merged.length === 0 || point - merged[merged.length - 1] >= minGap) {
      merged.push(point);
    }
  }
  if (merged.length === 0) return null;
  const floor = duck.floorGain.toFixed(5);
  const attack = duck.attack.toFixed(5);
  const release = duck.release.toFixed(5);
  return merged.map((point) => {
    const center = point.toFixed(5);
    const ramp =
      `if(lt(t\\,${center})\\,((${center}-t)/${attack})\\,` +
      `((t-${center})/${release}))`;
    const inside = `between(t\\,${center}-${attack}\\,${center}+${release})`;
    const clamped = `min(1\\,max(0\\,${ramp}))`;
    return `(if(${inside}\\,(${floor}+(1-${floor})*${clamped})\\,1))`;
  }).join('*');
}

function introForOverlays(overlays, frameHeight) {
  if (!Array.isArray(overlays)) return null;
  const animated = overlays.filter(
    (overlay) => overlay?.intro && overlay.intro !== 'none',
  );
  if (animated.length === 0) return null;
  const kind = animated[0].intro;
  if (
    !['fade', 'slide-up', 'slide-left', 'scale-in'].includes(kind) ||
    !animated.every((overlay) => overlay.intro === kind)
  ) {
    return null;
  }
  const duration = animated.reduce((max, overlay) => {
    const raw = Number.isFinite(overlay.introDuration) ? overlay.introDuration : 0.4;
    return Math.max(max, Math.max(0.05, Math.min(5, raw)));
  }, 0);
  const maxFont = animated.reduce((max, overlay) => {
    const fontSize = Number.isFinite(overlay.fontSize) ? overlay.fontSize : 0;
    return Math.max(max, (fontSize / 100) * frameHeight);
  }, 0);
  return {
    kind,
    duration,
    distancePx:
      kind === 'slide-up' || kind === 'slide-left'
        ? Math.round(0.6 * maxFont)
        : 0,
  };
}

function buildOverlayParts(base, input, output, index, start, end, intro) {
  const startText = start.toFixed(3);
  const endText = end.toFixed(3);
  const enable = `enable=between(t\\,${startText}\\,${endText})`;
  if (!intro) return [`${base}${input}overlay=0:0:${enable}${output}`];
  const faded = `[ovf${index}]`;
  const fade =
    `${input}format=rgba,` +
    `fade=t=in:st=${startText}:d=${intro.duration.toFixed(3)}:alpha=1${faded}`;
  let x = '0';
  let y = '0';
  if (intro.distancePx > 0) {
    const ramp = `max(0\\,1-(t-${startText})/${intro.duration.toFixed(3)})`;
    if (intro.kind === 'slide-up') y = `${intro.distancePx}*${ramp}`;
    if (intro.kind === 'slide-left') x = `${intro.distancePx}*${ramp}`;
  }
  return [fade, `${base}${faded}overlay=${x}:${y}:${enable}${output}`];
}

function buildNativeExportPlan(request, sourceByAssetId, overlayPathByClipId, outputPath) {
  if (!request || request.version !== 1) {
    throw new NativeExportPlanError('INVALID_VERSION', '書き出しデータの形式が不正です');
  }
  if (!Array.isArray(request.clips) || request.clips.length > MAX_CLIPS) {
    throw new NativeExportPlanError('INVALID_PROJECT', 'クリップ数が不正です');
  }
  if (!Array.isArray(request.tracks) || request.tracks.length > MAX_TRACKS) {
    throw new NativeExportPlanError('INVALID_PROJECT', 'トラック数が不正です');
  }
  if (!Array.isArray(request.assets) || request.assets.length > MAX_ASSETS) {
    throw new NativeExportPlanError('INVALID_PROJECT', '素材数が不正です');
  }
  if (
    request.markers !== undefined &&
    (!Array.isArray(request.markers) || request.markers.length > MAX_MARKERS)
  ) {
    throw new NativeExportPlanError('INVALID_PROJECT', 'マーカー数が不正です');
  }
  if (
    !(sourceByAssetId instanceof Map) ||
    !(overlayPathByClipId instanceof Map) ||
    typeof outputPath !== 'string' ||
    outputPath.length === 0
  ) {
    throw new NativeExportPlanError('INVALID_REQUEST', '書き出し権限が不正です');
  }

  const unsupported = collectUnsupportedFeatures(request);
  if (unsupported.length > 0) {
    throw new NativeExportPlanError(
      'UNSUPPORTED_FEATURES',
      `長尺書き出しで未対応の機能があります: ${unsupported.join('、')}`,
      unsupported,
    );
  }

  const options = request.options ?? {};
  const { width, height } = getResolution(options.resolution, options.aspectRatio);
  const fps = options.fps;
  if (fps !== 30 && fps !== 60) {
    throw new NativeExportPlanError('INVALID_OPTIONS', 'フレームレートが不正です');
  }
  const encoding = encodingSettings(options.quality);
  const reframe = finite(options.verticalReframe ?? 0, '縦動画の位置', -1, 1);

  const trackIds = new Set();
  for (const track of request.tracks) {
    safeId(track?.id, 'トラックID');
    if (trackIds.has(track.id)) {
      throw new NativeExportPlanError('INVALID_PROJECT', 'トラックIDが重複しています');
    }
    if (!['video', 'audio', 'overlay'].includes(track.kind)) {
      throw new NativeExportPlanError('INVALID_PROJECT', 'トラック種別が不正です');
    }
    trackIds.add(track.id);
  }
  const assetById = new Map();
  for (const asset of request.assets) {
    safeId(asset?.id, '素材ID');
    if (assetById.has(asset.id)) {
      throw new NativeExportPlanError('INVALID_PROJECT', '素材IDが重複しています');
    }
    if (asset.kind !== 'video' && asset.kind !== 'audio') {
      throw new NativeExportPlanError('INVALID_PROJECT', '素材種別が不正です');
    }
    if (asset.width !== undefined) finite(asset.width, '素材の幅', 1, 32_768);
    if (asset.height !== undefined) finite(asset.height, '素材の高さ', 1, 32_768);
    assetById.set(asset.id, asset);
  }

  const clipIds = new Set();
  let overlayItemCount = 0;
  for (const clip of request.clips) {
    safeId(clip?.id, 'クリップID');
    safeId(clip?.trackId, 'クリップのトラックID');
    safeId(clip?.assetId, 'クリップの素材ID');
    if (clipIds.has(clip.id)) {
      throw new NativeExportPlanError('INVALID_PROJECT', 'クリップIDが重複しています');
    }
    if (!trackIds.has(clip.trackId) || !assetById.has(clip.assetId)) {
      throw new NativeExportPlanError(
        'MISSING_MEDIA',
        `クリップの素材またはトラックが見つかりません: ${clip.id}`,
      );
    }
    if (clip.overlays !== undefined && !Array.isArray(clip.overlays)) {
      throw new NativeExportPlanError('INVALID_OVERLAY', 'テキスト設定が不正です');
    }
    overlayItemCount += Array.isArray(clip.overlays) ? clip.overlays.length : 0;
    if (overlayItemCount > MAX_OVERLAY_ITEMS) {
      throw new NativeExportPlanError('INVALID_OVERLAY', 'テキスト設定が多すぎます');
    }
    clipDuration(clip);
    clipIds.add(clip.id);
  }

  const mainVideoTrack = request.tracks.find((track) => track.kind === 'video');
  if (!mainVideoTrack || mainVideoTrack.hidden) {
    throw new NativeExportPlanError('NO_VIDEO', '書き出せる映像トラックがありません');
  }
  const videoClips = request.clips
    .filter((clip) => clip.trackId === mainVideoTrack.id)
    .sort((a, b) => a.start - b.start);
  if (videoClips.length === 0) {
    throw new NativeExportPlanError('NO_VIDEO', '映像クリップがありません');
  }
  const unsupportedLaneClips = request.clips.filter((clip) => {
    const track = request.tracks.find((candidate) => candidate.id === clip.trackId);
    return (
      track &&
      !track.hidden &&
      (track.kind === 'overlay' ||
        (track.kind === 'video' && track.id !== mainVideoTrack.id))
    );
  });
  if (unsupportedLaneClips.length > 0) {
    throw new NativeExportPlanError(
      'UNSUPPORTED_LANES',
      'サブ映像/オーバーレイトラックは書き出し未対応です',
    );
  }
  const audioTrackIds = new Set(
    request.tracks.filter((track) => track.kind === 'audio').map((track) => track.id),
  );
  const audioClips = request.clips
    .filter((clip) => audioTrackIds.has(clip.trackId))
    .sort((a, b) => a.start - b.start);
  const playableAudioClips = audioClips.filter((clip) => {
    const track = request.tracks.find((candidate) => candidate.id === clip.trackId);
    return !clip.muted && !track?.muted && !track?.hidden;
  });

  const timeline = buildTimeline(videoClips);
  const totalDuration = timeline.at(-1)?.end ?? 0;
  const requiredAssetIds = [];
  for (const clip of [...videoClips, ...playableAudioClips]) {
    if (!requiredAssetIds.includes(clip.assetId)) requiredAssetIds.push(clip.assetId);
  }
  const inputIndexByAssetId = new Map();
  const inputArgs = [];
  requiredAssetIds.forEach((assetId, index) => {
    const source = sourceByAssetId.get(assetId);
    if (
      !source ||
      typeof source.path !== 'string' ||
      typeof source.hasAudio !== 'boolean'
    ) {
      throw new NativeExportPlanError(
        'MISSING_MEDIA',
        `元素材を確認できません: ${assetById.get(assetId)?.name ?? assetId}`,
      );
    }
    inputIndexByAssetId.set(assetId, index);
    inputArgs.push('-i', source.path);
  });

  const filters = [];
  const videoLabels = [];
  const audioLabels = [];
  timeline.forEach((item, index) => {
    const duration = item.end - item.start;
    const videoLabel = item.kind === 'gap' ? `[gv${index}]` : `[cv${index}]`;
    const audioLabel = item.kind === 'gap' ? `[ga${index}]` : `[ca${index}]`;
    videoLabels.push(videoLabel);
    audioLabels.push(audioLabel);
    if (item.kind === 'gap') {
      filters.push(
        `color=c=black:s=${width}x${height}:r=${fps}:d=${duration.toFixed(4)},` +
        `format=yuv420p,setsar=1,setpts=PTS-STARTPTS${videoLabel}`,
      );
      filters.push(
        `anullsrc=r=44100:cl=stereo,atrim=0:${duration.toFixed(4)},` +
        `asetpts=PTS-STARTPTS${audioLabel}`,
      );
      return;
    }
    const asset = assetById.get(item.clip.assetId);
    const source = sourceByAssetId.get(item.clip.assetId);
    filters.push(
      buildClipFilters({
        inputIndex: inputIndexByAssetId.get(item.clip.assetId),
        clip: item.clip,
        asset,
        width,
        height,
        fps,
        videoTrackMuted: mainVideoTrack.muted === true,
        hasAudio: source.hasAudio,
        reframe,
        videoLabel,
        audioLabel,
      }),
    );
  });
  const concatInputs = videoLabels.map((label, index) => `${label}${audioLabels[index]}`).join('');
  filters.push(`${concatInputs}concat=n=${videoLabels.length}:v=1:a=1[vbase][abase]`);

  const overlays = [];
  for (const item of timeline) {
    if (item.kind !== 'clip' || !Array.isArray(item.clip.overlays) || item.clip.overlays.length === 0) {
      continue;
    }
    const overlayPath = overlayPathByClipId.get(item.clip.id);
    if (!overlayPath) {
      throw new NativeExportPlanError(
        'INVALID_OVERLAY',
        `テキスト画像を確認できません: ${item.clip.id}`,
      );
    }
    overlays.push({
      clip: item.clip,
      path: overlayPath,
      start: item.start,
      end: item.end,
    });
  }
  if (overlays.length > MAX_OVERLAYS) {
    throw new NativeExportPlanError('INVALID_OVERLAY', 'テキスト画像が多すぎます');
  }

  let videoOutputLabel = '[vbase]';
  if (overlays.length > 0) {
    const imageDuration = (Math.max(0.1, totalDuration) + 1).toFixed(3);
    overlays.forEach((overlay, index) => {
      const inputIndex = requiredAssetIds.length + index;
      inputArgs.push(
        '-framerate',
        String(fps),
        '-loop',
        '1',
        '-t',
        imageDuration,
        '-i',
        overlay.path,
      );
      const output = index === overlays.length - 1 ? '[vout]' : `[ov${index}]`;
      filters.push(
        ...buildOverlayParts(
          videoOutputLabel,
          `[${inputIndex}:v]`,
          output,
          index,
          overlay.start,
          overlay.end,
          introForOverlays(overlay.clip.overlays, height),
        ),
      );
      videoOutputLabel = output;
    });
  }

  let audioOutputLabel = '[abase]';
  if (playableAudioClips.length > 0) {
    const bgmTrackId = request.tracks.find((track) => track.kind === 'audio')?.id ?? null;
    const duckExpression = buildDuckExpression(
      Array.isArray(request.markers) ? request.markers : [],
      videoClips,
      options.audioDucking,
    );
    const mixLabels = [];
    playableAudioClips.forEach((clip, index) => {
      const source = sourceByAssetId.get(clip.assetId);
      if (!source?.hasAudio) {
        throw new NativeExportPlanError(
          'MISSING_AUDIO',
          `音声ストリームが見つかりません: ${assetById.get(clip.assetId)?.name ?? clip.assetId}`,
        );
      }
      const filtersForClip = [
        `atrim=${clip.trimStart.toFixed(4)}:${clip.trimEnd.toFixed(4)}`,
        'asetpts=PTS-STARTPTS',
        ...buildAtempoChain(clip.speed ?? 1),
        `volume=${finite(clip.volume ?? 1, '音量', 0, 2).toFixed(3)}`,
      ];
      const startMs = Math.round(
        finite(clip.start, '音声開始位置', 0, MAX_TIMELINE_SECONDS) * 1000,
      );
      if (startMs > 0) filtersForClip.push(`adelay=${startMs}|${startMs}`);
      if (clip.trackId === bgmTrackId && duckExpression) {
        filtersForClip.push(`volume=${duckExpression}:eval=frame`);
      }
      const label = `[ba${index}]`;
      filters.push(
        `[${inputIndexByAssetId.get(clip.assetId)}:a]${filtersForClip.join(',')}${label}`,
      );
      mixLabels.push(label);
    });
    filters.push(
      `[abase]${mixLabels.join('')}amix=inputs=${mixLabels.length + 1}:` +
      'duration=first:dropout_transition=0:normalize=0,' +
      'alimiter=limit=0.95:level=false[aout]',
    );
    audioOutputLabel = '[aout]';
  }

  const args = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'warning',
    '-stats_period',
    '0.25',
    '-progress',
    'pipe:3',
    '-protocol_whitelist',
    'file,pipe',
    ...inputArgs,
    '-filter_complex_script',
    'filter-complex.txt',
    '-map',
    videoOutputLabel,
    '-map',
    audioOutputLabel,
    '-c:v',
    'libx264',
    '-preset',
    encoding.preset,
    '-crf',
    String(encoding.crf),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    encoding.audioBitrate,
    '-ar',
    '44100',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-max_muxing_queue_size',
    '4096',
    '-n',
    '-f',
    'mp4',
    outputPath,
  ];
  const argumentChars = args.reduce((sum, value) => sum + value.length + 1, 0);
  if (process.platform === 'win32' && argumentChars > 28_000) {
    throw new NativeExportPlanError(
      'PROJECT_TOO_COMPLEX',
      '素材数が多くWindowsの書き出し上限を超えました。プロジェクトを分割してください。',
    );
  }
  return {
    args,
    filterGraph: filters.join(';\n'),
    totalDuration,
    width,
    height,
    fps,
  };
}

function parseProgressText(text, totalDuration, previousProgress = 0) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const outTimeUs = Number(values.out_time_us);
  const processedSeconds = Number.isFinite(outTimeUs) ? Math.max(0, outTimeUs / 1_000_000) : 0;
  const raw = totalDuration > 0 ? processedSeconds / totalDuration : 0;
  // Reserve the last 1% for validation, fsync and atomic commit.
  const overallProgress = Math.max(
    previousProgress,
    Math.min(0.99, Math.max(0, raw) * 0.99),
  );
  const speedText = typeof values.speed === 'string' ? values.speed.replace(/x$/, '') : '';
  const speed = Number(speedText);
  const etaSec =
    Number.isFinite(speed) && speed > 0 && processedSeconds > 0
      ? Math.max(0, (totalDuration - processedSeconds) / speed)
      : null;
  return {
    processedSeconds,
    overallProgress,
    speed: Number.isFinite(speed) ? speed : null,
    fps: Number.isFinite(Number(values.fps)) ? Number(values.fps) : null,
    totalBytes: Number.isFinite(Number(values.total_size)) ? Number(values.total_size) : null,
    etaSec,
    ended: values.progress === 'end',
  };
}

module.exports = {
  MAX_OVERLAYS,
  NativeExportPlanError,
  buildAtempoChain,
  buildNativeExportPlan,
  buildTimeline,
  collectUnsupportedFeatures,
  parseProgressText,
};
