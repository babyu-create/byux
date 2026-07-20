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
// FFmpeg's expression parser is recursive. Although the project schema can
// retain larger authored arrays, emitting thousands of nested if() calls makes
// stock FFmpeg fail with "too many args" before the graph-size cap is reached.
// 64 has been smoke-tested against the bundled binary and is the native-export
// boundary; larger animations get an actionable error instead of a corrupt job.
const MAX_KEYFRAMES_PER_PROPERTY = 64;
const MAX_TOTAL_NATIVE_KEYFRAMES = 4_096;
const MAX_ACTIVE_NATIVE_CLIPS = 2_000;
const MAX_FILTER_CHARS = 2_000_000;
const MIN_RAMP_AUDIO_SEGMENTS = 16;
const MAX_RAMP_AUDIO_SEGMENTS = 4_096;
const MAX_TOTAL_RAMP_AUDIO_SEGMENTS = 8_192;
// Keep the piecewise atempo curve within half a 60 fps frame of the continuous
// video time-remap. Segment boundaries are exact; this controls the maximum
// source-position and same-event timeline deviation inside each segment.
const MAX_RAMP_AUDIO_ERROR_SECONDS = 1 / 120;
const MAX_DUCK_POINTS = 10_000;
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
  const sizes = {
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '1440p': { width: 2560, height: 1440 },
    '2160p': { width: 3840, height: 2160 },
  };
  const landscape = sizes[resolution];
  if (!landscape) {
    throw new NativeExportPlanError('INVALID_OPTIONS', '解像度が不正です');
  }
  if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
    throw new NativeExportPlanError('INVALID_OPTIONS', 'アスペクト比が不正です');
  }
  if (aspectRatio === '16:9') {
    return landscape;
  }
  return { width: landscape.height, height: landscape.width };
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
  if (Math.abs(speed - 1) < 1e-9) return [];
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
  if (Math.abs(remaining - 1) > 1e-9) {
    const preciseTempo =
      remaining.toFixed(9).replace(/\.?0+$/, '') || '1';
    result.push(`atempo=${preciseTempo}`);
  }
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function number(value) {
  return Number(value).toFixed(6).replace(/\.?0+$/, '') || '0';
}

function easingExpression(kind, p) {
  if (kind === 'easeIn') return `((${p})*(${p}))`;
  if (kind === 'easeOut') return `(2*(${p})-(${p})*(${p}))`;
  if (kind === 'easeInOut') {
    return `if(lt(${p}\\,0.5)\\,2*(${p})*(${p})\\,1-2*(1-(${p}))*(1-(${p})))`;
  }
  if (kind === 'hold') return '0';
  return `(${p})`;
}

function animatableExpression(value, fallback, label, timeVariable = 'T') {
  if (value === undefined) return number(fallback);
  if (typeof value === 'number') return number(finite(value, label, -100_000, 100_000));
  if (!Array.isArray(value) || value.length > MAX_KEYFRAMES_PER_PROPERTY) {
    throw new NativeExportPlanError('PROJECT_TOO_COMPLEX', `${label}のキーフレームが多すぎます`);
  }
  if (value.length === 0) return number(fallback);
  const keyframes = value.map((keyframe) => ({
    t: finite(keyframe?.t, `${label}の時刻`, 0, MAX_TIMELINE_SECONDS),
    value: finite(keyframe?.value, `${label}の値`, -100_000, 100_000),
    easing: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'].includes(keyframe?.easing)
      ? keyframe.easing
      : 'linear',
  })).sort((a, b) => a.t - b.t);
  let expression = number(keyframes.at(-1).value);
  for (let index = keyframes.length - 2; index >= 0; index -= 1) {
    const from = keyframes[index];
    const to = keyframes[index + 1];
    const span = to.t - from.t;
    const segment = span <= EPS
      ? number(to.value)
      : `(${number(from.value)}+(${number(to.value)}-${number(from.value)})*` +
        `${easingExpression(from.easing, `((${timeVariable})-${number(from.t)})/${number(span)}`)})`;
    expression = `if(lt(${timeVariable}\\,${number(to.t)})\\,${segment}\\,${expression})`;
  }
  return `if(lte(${timeVariable}\\,${number(keyframes[0].t)})\\,${number(keyframes[0].value)}\\,${expression})`;
}

function transitionExpressions(clip, duration, timeVariable = 'T') {
  let opacity = '1';
  let scale = '1';
  let x = '0';
  const active = (transition) =>
    transition && ['fade', 'slide', 'zoom'].includes(transition.type);
  const window = (transition) =>
    Math.max(0.05, Math.min(
      Number.isFinite(transition?.duration) ? transition.duration : 0.4,
      Math.max(0.05, duration / 2),
    ));
  if (active(clip.transitionIn)) {
    const d = number(window(clip.transitionIn));
    const eased = `(2*((${timeVariable})/${d})-((${timeVariable})/${d})*((${timeVariable})/${d}))`;
    const amount = `if(lt(${timeVariable}\\,${d})\\,${eased}\\,1)`;
    opacity = `(${opacity})*(${amount})`;
    if (clip.transitionIn.type === 'slide') {
      x = `(${x})+if(lt(${timeVariable}\\,${d})\\,12*(1-(${eased}))\\,0)`;
    }
    if (clip.transitionIn.type === 'zoom') {
      scale = `(${scale})*if(lt(${timeVariable}\\,${d})\\,1.18-0.18*(${eased})\\,1)`;
    }
  }
  if (active(clip.transitionOut)) {
    const d = number(window(clip.transitionOut));
    const start = number(duration - Number(d));
    const p = `((${number(duration)}-(${timeVariable}))/${d})`;
    const eased = `(2*${p}-${p}*${p})`;
    const amount = `if(gte(${timeVariable}\\,${start})\\,${eased}\\,1)`;
    opacity = `(${opacity})*(${amount})`;
    if (clip.transitionOut.type === 'slide') {
      x = `(${x})+if(gte(${timeVariable}\\,${start})\\,-12*(1-(${eased}))\\,0)`;
    }
    if (clip.transitionOut.type === 'zoom') {
      scale = `(${scale})*if(gte(${timeVariable}\\,${start})\\,1.18-0.18*(${eased})\\,1)`;
    }
  }
  return { opacity, scale, x };
}

const RAMP_EASINGS = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']);

function validateSpeedRamp(raw) {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object') {
    throw new NativeExportPlanError('INVALID_PROJECT', '速度ランプが不正です');
  }
  const from = finite(raw.from, '速度ランプ開始', 0.0001, 8);
  const to = finite(raw.to, '速度ランプ終了', 0.0001, 8);
  const easing = raw.easing ?? 'easeIn';
  if (!RAMP_EASINGS.has(easing)) {
    throw new NativeExportPlanError('INVALID_PROJECT', '速度ランプの補間方法が不正です');
  }
  if (Math.abs(from - to) <= 1e-6) return null;
  // applyEasing('hold') is zero throughout the segment. Normalizing the raw
  // constant `from` velocity therefore produces factor 1, i.e. the authored
  // base clip.speed with no remap. Treat it as the identity ramp.
  if (easing === 'hold') return null;
  return { from, to, easing };
}

function rampIntegralAt(ramp, progress) {
  const p = clamp(progress, 0, 1);
  let easingIntegral;
  if (ramp.easing === 'linear') easingIntegral = (p * p) / 2;
  else if (ramp.easing === 'easeOut') easingIntegral = p * p - (p * p * p) / 3;
  else if (ramp.easing === 'easeInOut') {
    easingIntegral = p < 0.5
      ? (2 * p * p * p) / 3
      : -p + 2 * p * p - (2 * p * p * p) / 3 + 1 / 6;
  } else easingIntegral = (p * p * p) / 3;
  return ramp.from * p + (ramp.to - ramp.from) * easingIntegral;
}

function rampSourceFractionAtProgress(ramp, progress) {
  return clamp(rampIntegralAt(ramp, progress) / rampIntegralAt(ramp, 1), 0, 1);
}

function rampProgressAtSourceFraction(ramp, sourceFraction) {
  const target = clamp(sourceFraction, 0, 1);
  let low = 0;
  let high = 1;
  for (let index = 0; index < 40; index += 1) {
    const middle = (low + high) / 2;
    if (rampSourceFractionAtProgress(ramp, middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function rampAudioSegmentCount(ramp, sourceSpan, duration) {
  let segmentCount = MIN_RAMP_AUDIO_SEGMENTS;
  const maxErrorFor = (count) => {
    let maxError = 0;
    for (let index = 0; index < count; index += 1) {
      const p0 = index / count;
      const p1 = (index + 1) / count;
      const f0 = rampSourceFractionAtProgress(ramp, p0);
      const f1 = rampSourceFractionAtProgress(ramp, p1);
      // Check multiple points because easeInOut's largest curvature is not
      // guaranteed to land exactly at a segment midpoint.
      for (const fraction of [0.25, 0.5, 0.75]) {
        const progress = p0 + (p1 - p0) * fraction;
        const exact = rampSourceFractionAtProgress(ramp, progress);
        const linear = f0 + (f1 - f0) * fraction;
        const sourceError = Math.abs(exact - linear) * sourceSpan;
        const approximateProgress =
          f1 - f0 > Number.EPSILON
            ? p0 + ((exact - f0) / (f1 - f0)) * (p1 - p0)
            : progress;
        const timelineError =
          Math.abs(approximateProgress - progress) * duration;
        maxError = Math.max(maxError, sourceError, timelineError);
      }
    }
    return maxError;
  };
  let maxError = maxErrorFor(segmentCount);
  while (
    segmentCount < MAX_RAMP_AUDIO_SEGMENTS &&
    maxError > MAX_RAMP_AUDIO_ERROR_SECONDS
  ) {
    segmentCount *= 2;
    maxError = maxErrorFor(segmentCount);
  }
  if (maxError > MAX_RAMP_AUDIO_ERROR_SECONDS) {
    throw new NativeExportPlanError(
      'PROJECT_TOO_COMPLEX',
      '速度ランプが長すぎるか変化が急すぎます。クリップを分割してください。',
    );
  }
  return segmentCount;
}

function rampIntegralExpression(ramp, p) {
  const delta = ramp.to - ramp.from;
  if (ramp.easing === 'linear') {
    return `${number(ramp.from)}*${p}+${number(delta / 2)}*${p}*${p}`;
  }
  if (ramp.easing === 'easeOut') {
    return `${number(ramp.from)}*${p}+${number(delta)}*(${p}*${p}-${p}*${p}*${p}/3)`;
  }
  if (ramp.easing === 'easeInOut') {
    const easedIntegral =
      `if(lt(${p}\\,0.5)\\,2*${p}*${p}*${p}/3\\,` +
      `-${p}+2*${p}*${p}-2*${p}*${p}*${p}/3+1/6)`;
    return `${number(ramp.from)}*${p}+${number(delta)}*(${easedIntegral})`;
  }
  return `${number(ramp.from)}*${p}+${number(delta / 3)}*${p}*${p}*${p}`;
}

function speedRampSetpts(clip, duration) {
  const ramp = validateSpeedRamp(clip.speedRamp);
  if (!ramp) return null;
  const p = 'ld(0)';
  const integral = rampIntegralExpression(ramp, p);
  const full = rampIntegralAt(ramp, 1);
  const sourceSpan = clip.trimEnd - clip.trimStart;
  const target = `(PTS*TB/${number(sourceSpan)})`;
  return `setpts=(${number(duration)}/TB)*root(((${integral})/${number(full)})-${target}\\,1)`;
}

const COLOR_PRESETS = {
  none: { brightness: 1, contrast: 1, saturation: 1, sepia: 0, hue: 0 },
  cinema: { brightness: 0.97, contrast: 1.12, saturation: 0.85, sepia: 0.08, hue: -8 },
  vivid: { brightness: 1.03, contrast: 1.18, saturation: 1.35, sepia: 0, hue: 0 },
  cool: { brightness: 1, contrast: 1.05, saturation: 1.05, sepia: 0, hue: -18 },
  warm: { brightness: 1.02, contrast: 1.05, saturation: 1.08, sepia: 0.25, hue: 8 },
  mono: { brightness: 1, contrast: 1.1, saturation: 0, sepia: 0, hue: 0 },
};

function buildColorFilters(grade) {
  if (!grade || typeof grade !== 'object') return [];
  const base = COLOR_PRESETS[grade.preset ?? 'none'] ?? COLOR_PRESETS.none;
  const exposure = clamp(Number.isFinite(grade.exposure) ? grade.exposure : 0, -100, 100);
  const contrastNudge = clamp(Number.isFinite(grade.contrast) ? grade.contrast : 0, -100, 100);
  const saturationNudge = clamp(Number.isFinite(grade.saturation) ? grade.saturation : 0, -100, 100);
  const temperature = clamp(Number.isFinite(grade.temperature) ? grade.temperature : 0, -100, 100);
  const brightness = clamp(base.brightness * (1 + exposure / 200), 0.2, 2.5);
  const contrast = clamp(base.contrast * (1 + contrastNudge / 200), 0.2, 2.5);
  const saturation = clamp(base.saturation * (1 + saturationNudge / 200), 0, 3);
  const sepia = temperature > 0
    ? clamp(base.sepia + temperature / 250, 0, 1)
    : base.sepia;
  const hue = base.hue + (temperature > 0 ? temperature / 10 : temperature / 4);
  const result = [];
  // Canvas/CSS applies brightness as a channel multiplier and contrast around
  // 0.5, in that order. FFmpeg eq.brightness is additive, so using b-1 there
  // shifts black and visibly diverges. RGB LUTs preserve black/midtone/white
  // with the same equations (within 8-bit rounding).
  if (Math.abs(brightness - 1) > EPS) {
    result.push(
      `lutrgb=r='clip(val*${number(brightness)}\\,0\\,255)':` +
      `g='clip(val*${number(brightness)}\\,0\\,255)':` +
      `b='clip(val*${number(brightness)}\\,0\\,255)'`,
    );
  }
  if (Math.abs(contrast - 1) > EPS) {
    result.push(
      `lutrgb=r='clip((val-127.5)*${number(contrast)}+127.5\\,0\\,255)':` +
      `g='clip((val-127.5)*${number(contrast)}+127.5\\,0\\,255)':` +
      `b='clip((val-127.5)*${number(contrast)}+127.5\\,0\\,255)'`,
    );
  }
  const saturationPasses =
    saturation > 2 ? [Math.sqrt(saturation), Math.sqrt(saturation)] : [saturation];
  for (const pass of saturationPasses) {
    if (Math.abs(pass - 1) <= EPS) continue;
    result.push(
      'colorchannelmixer=' +
      `rr=${number(0.213 + 0.787 * pass)}:` +
      `rg=${number(0.715 - 0.715 * pass)}:` +
      `rb=${number(0.072 - 0.072 * pass)}:` +
      `gr=${number(0.213 - 0.213 * pass)}:` +
      `gg=${number(0.715 + 0.285 * pass)}:` +
      `gb=${number(0.072 - 0.072 * pass)}:` +
      `br=${number(0.213 - 0.213 * pass)}:` +
      `bg=${number(0.715 - 0.715 * pass)}:` +
      `bb=${number(0.072 + 0.928 * pass)}`,
    );
  }
  if (sepia > EPS) {
    const s = sepia;
    result.push(
      'colorchannelmixer=' +
      `rr=${number(1 - 0.607 * s)}:rg=${number(0.769 * s)}:rb=${number(0.189 * s)}:` +
      `gr=${number(0.349 * s)}:gg=${number(1 - 0.314 * s)}:gb=${number(0.168 * s)}:` +
      `br=${number(0.272 * s)}:bg=${number(0.534 * s)}:bb=${number(1 - 0.869 * s)}`,
    );
  }
  if (Math.abs(hue) > EPS) {
    const radians = (hue * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    result.push(
      'colorchannelmixer=' +
      `rr=${number(0.213 + 0.787 * cosine - 0.213 * sine)}:` +
      `rg=${number(0.715 - 0.715 * cosine - 0.715 * sine)}:` +
      `rb=${number(0.072 - 0.072 * cosine + 0.928 * sine)}:` +
      `gr=${number(0.213 - 0.213 * cosine + 0.143 * sine)}:` +
      `gg=${number(0.715 + 0.285 * cosine + 0.14 * sine)}:` +
      `gb=${number(0.072 - 0.072 * cosine - 0.283 * sine)}:` +
      `br=${number(0.213 - 0.213 * cosine - 0.787 * sine)}:` +
      `bg=${number(0.715 - 0.715 * cosine + 0.715 * sine)}:` +
      `bb=${number(0.072 + 0.928 * cosine + 0.072 * sine)}`,
    );
  }
  return result;
}

function animatableHasChange(value, identity) {
  if (value === undefined) return false;
  if (typeof value === 'number') return Math.abs(value - identity) > EPS;
  return Array.isArray(value) && value.some(
    (keyframe) => Number.isFinite(keyframe?.value) && Math.abs(keyframe.value - identity) > EPS,
  );
}

function motionBlurSpec(clip, options) {
  if (options?.motionBlur !== true) return null;
  const effect = Array.isArray(clip.effects)
    ? clip.effects.find((candidate) => candidate?.type === 'motion-blur')
    : null;
  if (!effect) return null;
  const intensity = clamp(
    Number.isFinite(effect.intensity) ? effect.intensity : 50,
    0,
    100,
  );
  const authoredStrength =
    Math.pow(intensity / 100, 0.6) *
    1.25 *
    clamp(clip.speed ?? 1, 0.5, 2);
  const strength = Number.isFinite(options.motionBlurStrength)
    ? clamp(options.motionBlurStrength, 0, 2.5)
    : authoredStrength;
  if (strength <= EPS || intensity <= EPS) return null;
  const amount = clamp(strength / 1.25, 0, 1);
  // Keep one fixed four-frame window and fade older taps in continuously.
  // Changing the frame count at thresholds makes the visible blur jump while
  // dragging the strength slider.
  const frames = 4;
  const weights = [
    1,
    amount,
    clamp((amount - 1 / 3) * 1.5, 0, 1),
    clamp((amount - 2 / 3) * 3, 0, 1),
  ];
  const preset = ['valorant', 'cs2', 'apex', 'none'].includes(options.motionBlurHudPreset)
    ? options.motionBlurHudPreset
    : 'valorant';
  const hudStrength = preset === 'none'
    ? 0
    : clamp(
      Number.isFinite(options.motionBlurHudMaskStrength)
        ? options.motionBlurHudMaskStrength
        : 1,
      0,
      1,
    );
  return { frames, weights, preset, hudStrength };
}

function hudRegionExpression(preset) {
  if (preset === 'cs2') {
    return (
      'lte(Y\\,H*0.09)+' +
      'lte(X\\,W*0.18)*lte(Y\\,H*0.26)+' +
      'lte(X\\,W*0.28)*gte(Y\\,H*0.88)+' +
      'gte(X\\,W*0.78)*gte(Y\\,H*0.88)'
    );
  }
  if (preset === 'apex') {
    return (
      'gte(Y\\,H*0.62)+' +
      'lte(X\\,W*0.20)*lte(Y\\,H*0.28)'
    );
  }
  return (
    'gte(Y\\,H*0.58)+' +
    'lte(Y\\,H*0.10)+' +
    'lte(X\\,W*0.22)*lte(Y\\,H*0.32)'
  );
}

function buildAudioFilterParts(spec) {
  const {
    inputIndex,
    clip,
    hasAudio,
    volume,
    outputLabel,
    prefix,
  } = spec;
  const duration = clipDuration(clip);
  if (!hasAudio || volume <= EPS) {
    return [
      `anullsrc=r=44100:cl=stereo,atrim=0:${number(duration)},` +
      `asetpts=PTS-STARTPTS,volume=${number(volume)}${outputLabel}`,
    ];
  }
  const ramp = validateSpeedRamp(clip.speedRamp);
  if (!ramp) {
    const filters = [
      `atrim=${number(clip.trimStart)}:${number(clip.trimEnd)}`,
      'asetpts=PTS-STARTPTS',
      ...buildAtempoChain(clip.speed ?? 1),
      `volume=${number(volume)}`,
    ];
    return [`[${inputIndex}:a]${filters.join(',')}${outputLabel}`];
  }

  const sourceSpan = clip.trimEnd - clip.trimStart;
  const rampAudioSegments = rampAudioSegmentCount(
    ramp,
    sourceSpan,
    duration,
  );
  const splitLabels = Array.from(
    { length: rampAudioSegments },
    (_, index) => `[${prefix}as${index}]`,
  );
  const renderedLabels = Array.from(
    { length: rampAudioSegments },
    (_, index) => `[${prefix}ar${index}]`,
  );
  const parts = [`[${inputIndex}:a]asplit=${rampAudioSegments}${splitLabels.join('')}`];
  const timelineSegment = duration / rampAudioSegments;
  for (let index = 0; index < rampAudioSegments; index += 1) {
    const p0 = index / rampAudioSegments;
    const p1 = (index + 1) / rampAudioSegments;
    const sourceStart =
      clip.trimStart + rampSourceFractionAtProgress(ramp, p0) * sourceSpan;
    const sourceEnd =
      clip.trimStart + rampSourceFractionAtProgress(ramp, p1) * sourceSpan;
    const segmentSpeed = (sourceEnd - sourceStart) / timelineSegment;
    const filters = [
      `atrim=${number(sourceStart)}:${number(sourceEnd)}`,
      'asetpts=PTS-STARTPTS',
      // atempo buffers more samples than very slow/short ramp slices contain.
      // Pad its input, then trim every rendered slice to the exact timeline
      // boundary so concat preserves every adaptive A/V synchronization anchor.
      'apad=pad_dur=1',
      ...buildAtempoChain(segmentSpeed),
      `atrim=0:${number(timelineSegment)}`,
      'asetpts=PTS-STARTPTS',
    ];
    parts.push(`${splitLabels[index]}${filters.join(',')}${renderedLabels[index]}`);
  }
  parts.push(
    `${renderedLabels.join('')}concat=n=${rampAudioSegments}:v=0:a=1,` +
    `volume=${number(volume)}${outputLabel}`,
  );
  return parts;
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
    motionBlurOptions,
    flattenOnBlack,
    workPrefix,
  } = spec;
  const speed = clip.speed ?? 1;
  const duration = clipDuration(clip);
  const clipVolume = clip.muted || videoTrackMuted
    ? 0
    : finite(clip.volume ?? 1, 'クリップ音量', 0, 2);
  const videoFilters = [
    `trim=${number(clip.trimStart)}:${number(clip.trimEnd)}`,
    'setpts=PTS-STARTPTS',
  ];
  const rampSetpts = speedRampSetpts(clip, duration);
  if (rampSetpts) videoFilters.push(rampSetpts);
  else if (Math.abs(speed - 1) > 1e-3) {
    videoFilters.push(`setpts=${number(1 / speed)}*PTS`);
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
    const pan = ((clamp(reframe, -1, 1) + 1) / 2).toFixed(4);
    videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`);
    videoFilters.push(`crop=${width}:${height}:(iw-ow)*${pan}:(ih-oh)/2`);
  } else if (!sourceMatchesOutput) {
    videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
    videoFilters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  }
  videoFilters.push('setsar=1', `fps=${fps}`);

  const parts = [];
  let videoInput = `[${inputIndex}:v]`;
  const blur = motionBlurSpec(clip, motionBlurOptions);
  if (blur?.hudStrength > EPS) {
    const preLabel = `[${workPrefix}pre]`;
    const sharpLabel = `[${workPrefix}sharp]`;
    const blurInputLabel = `[${workPrefix}blurin]`;
    const blurredLabel = `[${workPrefix}blurred]`;
    const protectedLabel = `[${workPrefix}protected]`;
    parts.push(`${videoInput}${videoFilters.join(',')}${preLabel}`);
    parts.push(`${preLabel}split=2${sharpLabel}${blurInputLabel}`);
    parts.push(
      `${blurInputLabel}tmix=frames=${blur.frames}:` +
      `weights='${blur.weights.map(number).join(' ')}'${blurredLabel}`,
    );
    const mask =
      `${number(blur.hudStrength)}*gt(${hudRegionExpression(blur.preset)}\\,0)`;
    parts.push(
      `${blurredLabel}${sharpLabel}blend=all_expr='A*(1-(${mask}))+B*(${mask})'` +
      protectedLabel,
    );
    videoInput = protectedLabel;
    videoFilters.length = 0;
  } else if (blur) {
    videoFilters.push(
      `tmix=frames=${blur.frames}:weights='${blur.weights.map(number).join(' ')}'`,
    );
  }
  videoFilters.push(...buildColorFilters(clip.colorGrade));

  const effects = Array.isArray(clip.effects) ? clip.effects : [];
  const fadeIn = effects.find((effect) => effect?.type === 'fade-in');
  const fadeOut = effects.find((effect) => effect?.type === 'fade-out');
  const spatialTransform =
    animatableHasChange(clip.transform?.x, 0) ||
    animatableHasChange(clip.transform?.y, 0) ||
    animatableHasChange(clip.transform?.scale, 1) ||
    animatableHasChange(clip.transform?.rotation, 0) ||
    clip.transitionIn?.type === 'slide' ||
    clip.transitionIn?.type === 'zoom' ||
    clip.transitionOut?.type === 'slide' ||
    clip.transitionOut?.type === 'zoom';
  const opacityTransform =
    animatableHasChange(clip.transform?.opacity, 1) ||
    hasActiveTransition(clip.transitionIn) ||
    hasActiveTransition(clip.transitionOut);
  const simpleBaseFade =
    flattenOnBlack &&
    !spatialTransform &&
    !opacityTransform &&
    (fadeIn || fadeOut);

  if (simpleBaseFade) {
    if (fadeIn) {
      const d = Math.max(
        0.05,
        Math.min(duration, finite(fadeIn.duration ?? 0.4, 'フェード時間', 0, MAX_TIMELINE_SECONDS)),
      );
      videoFilters.push(`fade=t=in:st=0:d=${number(d)}`);
    }
    if (fadeOut) {
      const d = Math.max(
        0.05,
        Math.min(duration, finite(fadeOut.duration ?? 0.4, 'フェード時間', 0, MAX_TIMELINE_SECONDS)),
      );
      videoFilters.push(`fade=t=out:st=${number(Math.max(0, duration - d))}:d=${number(d)}`);
    }
  }

  const needsAlpha = spatialTransform || opacityTransform || (!flattenOnBlack && (fadeIn || fadeOut));
  if (needsAlpha) {
    videoFilters.push('format=rgba');
    if (spatialTransform) {
      const perspectiveTime = `(on/${fps})`;
      const transition = transitionExpressions(clip, duration, perspectiveTime);
      const x =
        `(${animatableExpression(clip.transform?.x, 0, 'X位置', perspectiveTime)})+` +
        `(${transition.x})`;
      const y = animatableExpression(clip.transform?.y, 0, 'Y位置', perspectiveTime);
      const scale =
        `(${animatableExpression(clip.transform?.scale, 1, '拡大率', perspectiveTime)})*` +
        `(${transition.scale})`;
      const rotation = animatableExpression(
        clip.transform?.rotation,
        0,
        '回転',
        perspectiveTime,
      );
      const angle = `((${rotation})*PI/180)`;
      const cos = `cos(${angle})`;
      const sin = `sin(${angle})`;
      const x0 =
        `W/2+(${x})*W/100-(${scale})*(${cos})*W/2+(${scale})*(${sin})*H/2`;
      const y0 =
        `H/2+(${y})*H/100-(${scale})*(${sin})*W/2-(${scale})*(${cos})*H/2`;
      const x1 = `(${x0})+(${scale})*(${cos})*W`;
      const y1 = `(${y0})+(${scale})*(${sin})*W`;
      const x2 = `(${x0})-(${scale})*(${sin})*H`;
      const y2 = `(${y0})+(${scale})*(${cos})*H`;
      const x3 = `(${x1})-(${scale})*(${sin})*H`;
      const y3 = `(${y1})+(${scale})*(${cos})*H`;
      videoFilters.push(
        `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y1}':` +
        `x2='${x2}':y2='${y2}':x3='${x3}':y3='${y3}':sense=destination:eval=frame`,
      );
    }
    if (opacityTransform || fadeIn || fadeOut) {
      const opacityTransition = transitionExpressions(clip, duration);
      let opacity =
        `(${animatableExpression(clip.transform?.opacity, 1, '不透明度')})*` +
        `(${opacityTransition.opacity})`;
      if (fadeIn) {
        const d = Math.max(
          0.05,
          Math.min(duration, finite(fadeIn.duration ?? 0.4, 'フェード時間', 0, MAX_TIMELINE_SECONDS)),
        );
        opacity += `*min(1\\,T/${number(d)})`;
      }
      if (fadeOut) {
        const d = Math.max(
          0.05,
          Math.min(duration, finite(fadeOut.duration ?? 0.4, 'フェード時間', 0, MAX_TIMELINE_SECONDS)),
        );
        opacity += `*min(1\\,(${number(duration)}-T)/${number(d)})`;
      }
      videoFilters.push(
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':` +
        `a='alpha(X,Y)*max(0\\,min(1\\,${opacity}))'`,
      );
    }
  }

  if (flattenOnBlack && needsAlpha) {
    const effectLabel = `[${workPrefix}fx]`;
    const blackLabel = `[${workPrefix}black]`;
    parts.push(`${videoInput}${videoFilters.join(',')}${effectLabel}`);
    parts.push(
      `color=c=black:s=${width}x${height}:r=${fps}:d=${number(duration)},` +
      `format=rgba,setsar=1${blackLabel}`,
    );
    parts.push(
      `${blackLabel}${effectLabel}overlay=0:0:shortest=1:format=auto,` +
      `format=yuv420p${videoLabel}`,
    );
  } else {
    if (flattenOnBlack) videoFilters.push('format=yuv420p');
    parts.push(
      `${videoInput}${videoFilters.length > 0 ? videoFilters.join(',') : 'null'}${videoLabel}`,
    );
  }

  if (audioLabel) {
    parts.push(...buildAudioFilterParts({
      inputIndex,
      clip,
      hasAudio,
      volume: clipVolume,
      outputLabel: audioLabel,
      prefix: `${workPrefix}a`,
    }));
  }
  return parts.join(';');
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
  void request;
  return [];
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
  const markersByAssetId = new Map();
  for (const marker of markers) {
    if (!marker || typeof marker.assetId !== 'string' || !Number.isFinite(marker.time)) {
      continue;
    }
    const assetMarkers = markersByAssetId.get(marker.assetId) ?? [];
    assetMarkers.push(marker.time);
    markersByAssetId.set(marker.assetId, assetMarkers);
  }
  for (const assetMarkers of markersByAssetId.values()) {
    assetMarkers.sort((a, b) => a - b);
  }
  const lowerBound = (values, target) => {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (values[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const points = [];
  for (const clip of videoClips) {
    const assetMarkers = markersByAssetId.get(clip.assetId) ?? [];
    const sourceSpan = clip.trimEnd - clip.trimStart;
    const duration = clipDuration(clip);
    const ramp = validateSpeedRamp(clip.speedRamp);
    const first = lowerBound(assetMarkers, clip.trimStart - 1e-6);
    const afterLast = lowerBound(assetMarkers, clip.trimEnd + 1e-6);
    for (let index = first; index < afterLast; index += 1) {
      const markerTime = assetMarkers[index];
      const sourceFraction = clamp((markerTime - clip.trimStart) / sourceSpan, 0, 1);
      const progress = ramp
        ? rampProgressAtSourceFraction(ramp, sourceFraction)
        : sourceFraction;
      points.push(clip.start + progress * duration);
      if (points.length > MAX_DUCK_POINTS) {
        throw new NativeExportPlanError(
          'PROJECT_TOO_COMPLEX',
          'ダッキング対象のマーカーが多すぎます。タイムラインを分割してください。',
        );
      }
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
  if (fps !== 30 && fps !== 60 && fps !== 120) {
    throw new NativeExportPlanError('INVALID_OPTIONS', 'フレームレートが不正です');
  }
  const encoding = encodingSettings(options.quality);
  const reframe = finite(options.verticalReframe ?? 0, '縦動画の位置', -1, 1);
  if (options.motionBlur !== undefined && typeof options.motionBlur !== 'boolean') {
    throw new NativeExportPlanError('INVALID_OPTIONS', 'モーションブラー設定が不正です');
  }
  if (options.motionBlurStrength !== undefined) {
    finite(options.motionBlurStrength, 'モーションブラー強度', 0, 2.5);
  }
  if (
    options.motionBlurHudPreset !== undefined &&
    !['valorant', 'cs2', 'apex', 'none'].includes(options.motionBlurHudPreset)
  ) {
    throw new NativeExportPlanError('INVALID_OPTIONS', 'HUDプリセットが不正です');
  }
  if (options.motionBlurHudMaskStrength !== undefined) {
    finite(options.motionBlurHudMaskStrength, 'HUD保護強度', 0, 1);
  }

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

  const trackById = new Map(request.tracks.map((track) => [track.id, track]));
  const clipIds = new Set();
  let overlayItemCount = 0;
  let totalRampAudioSegments = 0;
  let totalNativeKeyframes = 0;
  let activeNativeClipCount = 0;
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
    const clipTrack = trackById.get(clip.trackId);
    const clipAsset = assetById.get(clip.assetId);
    const compatible =
      clipAsset.kind === 'audio'
        ? clipTrack.kind === 'audio'
        : clipTrack.kind === 'video' || clipTrack.kind === 'overlay';
    if (!compatible) {
      throw new NativeExportPlanError(
        'INVALID_PROJECT',
        `クリップの素材とトラック種別が一致しません: ${clip.id}`,
      );
    }
    if (!clipTrack.hidden) {
      activeNativeClipCount += 1;
      if (activeNativeClipCount > MAX_ACTIVE_NATIVE_CLIPS) {
        throw new NativeExportPlanError(
          'PROJECT_TOO_COMPLEX',
          '表示中のクリップが多すぎます。プロジェクトを分割してください。',
        );
      }
    }
    finite(clip.start, 'クリップ開始位置', 0, MAX_TIMELINE_SECONDS);
    const validatedRamp = validateSpeedRamp(clip.speedRamp);
    if (validatedRamp) {
      const sourceSpan =
        finite(clip.trimEnd, 'トリム終了', 0, MAX_TIMELINE_SECONDS) -
        finite(clip.trimStart, 'トリム開始', 0, MAX_TIMELINE_SECONDS);
      if (sourceSpan <= 0) {
        throw new NativeExportPlanError('INVALID_PROJECT', 'トリム範囲が不正です');
      }
      totalRampAudioSegments += rampAudioSegmentCount(
        validatedRamp,
        sourceSpan,
        clipDuration(clip),
      );
      if (totalRampAudioSegments > MAX_TOTAL_RAMP_AUDIO_SEGMENTS) {
        throw new NativeExportPlanError(
          'PROJECT_TOO_COMPLEX',
          '速度ランプ音声の精密処理が多すぎます。プロジェクトを分割してください。',
        );
      }
    }
    if (!Array.isArray(clip.effects) || clip.effects.length > 32) {
      throw new NativeExportPlanError('INVALID_PROJECT', 'クリップ効果が不正です');
    }
    for (const effect of clip.effects) {
      if (!effect || !['fade-in', 'fade-out', 'motion-blur'].includes(effect.type)) {
        throw new NativeExportPlanError('INVALID_PROJECT', 'クリップ効果が不正です');
      }
      if (effect.duration !== undefined) {
        finite(effect.duration, 'フェード時間', 0, MAX_TIMELINE_SECONDS);
      }
      if (effect.intensity !== undefined) finite(effect.intensity, 'ブラー強度', 0, 100);
    }
    if (clip.transform !== undefined) {
      if (!clip.transform || typeof clip.transform !== 'object') {
        throw new NativeExportPlanError('INVALID_PROJECT', '変形設定が不正です');
      }
      for (const [key, fallback, label] of [
        ['x', 0, 'X位置'],
        ['y', 0, 'Y位置'],
        ['scale', 1, '拡大率'],
        ['rotation', 0, '回転'],
        ['opacity', 1, '不透明度'],
      ]) {
        const value = clip.transform[key];
        if (Array.isArray(value)) {
          if (value.length > MAX_KEYFRAMES_PER_PROPERTY) {
            throw new NativeExportPlanError(
              'PROJECT_TOO_COMPLEX',
              `${label}のキーフレームが多すぎます`,
            );
          }
          totalNativeKeyframes += value.length;
          if (totalNativeKeyframes > MAX_TOTAL_NATIVE_KEYFRAMES) {
            throw new NativeExportPlanError(
              'PROJECT_TOO_COMPLEX',
              'キーフレームが多すぎます。アニメーションを分割してください。',
            );
          }
        }
        animatableExpression(value, fallback, label);
      }
    }
    for (const transition of [clip.transitionIn, clip.transitionOut]) {
      if (transition === undefined) continue;
      if (
        !transition ||
        !['none', 'cut', 'fade', 'slide', 'zoom'].includes(transition.type)
      ) {
        throw new NativeExportPlanError('INVALID_PROJECT', 'トランジションが不正です');
      }
      finite(transition.duration, 'トランジション時間', 0, MAX_TIMELINE_SECONDS);
    }
    if (clip.colorGrade !== undefined) {
      const grade = clip.colorGrade;
      if (
        !grade ||
        typeof grade !== 'object' ||
        !['none', 'cinema', 'vivid', 'cool', 'warm', 'mono'].includes(
          grade.preset ?? 'none',
        )
      ) {
        throw new NativeExportPlanError('INVALID_PROJECT', 'カラー設定が不正です');
      }
      for (const key of ['exposure', 'contrast', 'saturation', 'temperature']) {
        if (grade[key] !== undefined) finite(grade[key], 'カラー設定', -100_000, 100_000);
      }
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

  const visibleVisualTracks = request.tracks.filter(
    (track) => !track.hidden && (track.kind === 'video' || track.kind === 'overlay'),
  );
  const mainVideoTrack = visibleVisualTracks.find(
    (track) =>
      track.kind === 'video' &&
      request.clips.some((clip) => clip.trackId === track.id),
  );
  if (!mainVideoTrack) {
    throw new NativeExportPlanError('NO_VIDEO', '書き出せる映像トラックがありません');
  }
  const videoClips = request.clips
    .filter((clip) => clip.trackId === mainVideoTrack.id)
    .sort((a, b) => a.start - b.start);
  if (videoClips.length === 0) {
    throw new NativeExportPlanError('NO_VIDEO', '映像クリップがありません');
  }
  const upperVisualClips = visibleVisualTracks
    .filter((track) => track.id !== mainVideoTrack.id)
    .flatMap((track) =>
      request.clips
        .filter((clip) => clip.trackId === track.id)
        .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id))),
    );
  const audioTrackIds = new Set(
    request.tracks.filter((track) => track.kind === 'audio').map((track) => track.id),
  );
  const audioClips = request.clips
    .filter((clip) => audioTrackIds.has(clip.trackId))
    .sort((a, b) => a.start - b.start);
  const playableAudioClips = [...audioClips, ...upperVisualClips].filter((clip) => {
    const track = trackById.get(clip.trackId);
    if (clip.muted || track?.muted || track?.hidden) return false;
    return track?.kind === 'audio' || sourceByAssetId.get(clip.assetId)?.hasAudio === true;
  });

  const timeline = buildTimeline(videoClips);
  const visualEnd = [...videoClips, ...upperVisualClips].reduce(
    (max, clip) => Math.max(max, clip.start + clipDuration(clip)),
    0,
  );
  const baseEnd = timeline.at(-1)?.end ?? 0;
  if (visualEnd > baseEnd + EPS) {
    timeline.push({ kind: 'gap', start: baseEnd, end: visualEnd });
  }
  const totalDuration = visualEnd;
  const requiredAssetIds = [];
  for (const clip of [...videoClips, ...upperVisualClips, ...playableAudioClips]) {
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
        motionBlurOptions: options,
        flattenOnBlack: true,
        workPrefix: `p${index}`,
      }),
    );
  });
  const concatInputs = videoLabels.map((label, index) => `${label}${audioLabels[index]}`).join('');
  filters.push(`${concatInputs}concat=n=${videoLabels.length}:v=1:a=1[vbase0][abase]`);

  // Tracks are composited in project array order. The first visible video is
  // the opaque base; every later visible video/overlay clip is an upper layer.
  let layeredVideoLabel = '[vbase0]';
  upperVisualClips.forEach((clip, index) => {
    const asset = assetById.get(clip.assetId);
    const source = sourceByAssetId.get(clip.assetId);
    const clipLabel = `[lv${index}]`;
    const shiftedLabel = `[lvs${index}]`;
    filters.push(
      buildClipFilters({
        inputIndex: inputIndexByAssetId.get(clip.assetId),
        clip,
        asset,
        width,
        height,
        fps,
        videoTrackMuted: trackById.get(clip.trackId)?.muted === true,
        hasAudio: source.hasAudio,
        reframe,
        videoLabel: clipLabel,
        audioLabel: null,
        motionBlurOptions: options,
        flattenOnBlack: false,
        workPrefix: `u${index}`,
      }),
    );
    filters.push(
      `${clipLabel}setpts=PTS+${number(clip.start)}/TB${shiftedLabel}`,
    );
    const output = `[vbase${index + 1}]`;
    filters.push(
      `${layeredVideoLabel}${shiftedLabel}overlay=0:0:eof_action=pass:shortest=0${output}`,
    );
    layeredVideoLabel = output;
  });

  const overlays = [];
  const visualClipsInTrackOrder = visibleVisualTracks.flatMap((track) =>
    request.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id))),
  );
  for (const clip of visualClipsInTrackOrder) {
    if (!Array.isArray(clip.overlays) || clip.overlays.length === 0) {
      continue;
    }
    const overlayPath = overlayPathByClipId.get(clip.id);
    if (!overlayPath) {
      throw new NativeExportPlanError(
        'INVALID_OVERLAY',
        `テキスト画像を確認できません: ${clip.id}`,
      );
    }
    overlays.push({
      clip,
      path: overlayPath,
      start: clip.start,
      end: clip.start + clipDuration(clip),
    });
  }
  if (overlays.length > MAX_OVERLAYS) {
    throw new NativeExportPlanError('INVALID_OVERLAY', 'テキスト画像が多すぎます');
  }

  let videoOutputLabel = layeredVideoLabel;
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
      const rawLabel = `[baraw${index}]`;
      filters.push(...buildAudioFilterParts({
        inputIndex: inputIndexByAssetId.get(clip.assetId),
        clip,
        hasAudio: true,
        volume: finite(clip.volume ?? 1, '音量', 0, 2),
        outputLabel: rawLabel,
        prefix: `ba${index}`,
      }));
      const filtersForClip = [];
      const startMs = Math.round(
        finite(clip.start, '音声開始位置', 0, MAX_TIMELINE_SECONDS) * 1000,
      );
      if (startMs > 0) filtersForClip.push(`adelay=${startMs}|${startMs}`);
      if (clip.trackId === bgmTrackId && duckExpression) {
        filtersForClip.push(`volume=${duckExpression}:eval=frame`);
      }
      const label = `[ba${index}]`;
      if (filtersForClip.length > 0) {
        filters.push(`${rawLabel}${filtersForClip.join(',')}${label}`);
        mixLabels.push(label);
      } else {
        mixLabels.push(rawLabel);
      }
    });
    filters.push(
      `[abase]${mixLabels.join('')}amix=inputs=${mixLabels.length + 1}:` +
      'duration=first:dropout_transition=0:normalize=0,' +
      'alimiter=limit=0.95:level=false[aout]',
    );
    audioOutputLabel = '[aout]';
  }

  const filterGraph = filters.join(';\n');
  if (filterGraph.length > MAX_FILTER_CHARS) {
    throw new NativeExportPlanError(
      'PROJECT_TOO_COMPLEX',
      'キーフレームまたはレイヤーが多く、書き出しグラフの上限を超えました。',
    );
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
    filterGraph,
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
