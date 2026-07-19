// Speed remap (time-varying speed ramp) — Phase P1.
//
// Adds an OPTIONAL, time-varying speed multiplier on TOP of a clip's constant
// Clip.speed (slow-mo → fast acceleration, etc.). Pure logic with NO React /
// DOM dependency so it is reused identically by the live Preview (driving
// video.playbackRate + the timeline→source mapping) and the WebCodecs export
// renderer — preview/export parity, like clipTransform / motionBlurCore.
//
// ---------------------------------------------------------------------------
// DURATION-PRESERVING INVARIANT (critical)
// ---------------------------------------------------------------------------
// The whole editor derives a clip's TIMELINE duration from the constant speed:
//   clipDuration = (trimEnd - trimStart) / speed        (see lib/timeline.ts)
// A speed RAMP must NOT change that duration, or every placement / trim / snap
// calculation that calls clipDuration would desync. So the ramp is modelled as
// a NORMALISED velocity profile v(p) over normalised clip progress p ∈ [0,1]
// whose MEAN over the clip is exactly 1. The instantaneous source-advance rate
// is then `speed * v(p)`, and because mean(v)=1 the total source consumed over
// the clip equals `speed * timelineDur = (trimEnd - trimStart)` — identical to
// the constant-speed clip. The ramp only redistributes WHEN within the clip the
// source is consumed (slow first, fast later), never the total.
//
// `from`/`to` are RELATIVE velocity weights (e.g. 0.3 → 2.5 = start at 30% of
// the average rate, end at 250%); the normalisation rescales them so the mean
// is 1 regardless of the raw numbers, so the UI can use intuitive presets.

import { applyEasing, type EasingKind } from './keyframes';

/**
 * Optional time-varying speed ramp layered on top of Clip.speed. When absent,
 * the clip plays at the constant Clip.speed (fully backward compatible).
 *
 * Modelled as a normalised velocity profile over clip progress p ∈ [0,1]:
 *   rawVelocity(p) = from + (to - from) * easing(p)
 * which is then rescaled so its average equals 1 (duration-preserving — see the
 * module header). `from`/`to` are positive relative weights.
 */
export interface SpeedRamp {
  /** Relative velocity weight at the clip start (p=0). Must be > 0. */
  from: number;
  /** Relative velocity weight at the clip end (p=1). Must be > 0. */
  to: number;
  /** Easing applied to the from→to interpolation. Default 'easeIn'. */
  easing?: EasingKind;
}

/** Lower bound on any instantaneous speed factor — matches setClipSpeed clamp. */
export const MIN_RAMP_VELOCITY = 0.0625;

/** True when a ramp is present and actually varies the speed (from ≠ to). */
export function hasSpeedRamp(ramp: SpeedRamp | undefined): ramp is SpeedRamp {
  if (!ramp) return false;
  return (
    Number.isFinite(ramp.from) &&
    Number.isFinite(ramp.to) &&
    ramp.from > 0 &&
    ramp.to > 0 &&
    Math.abs(ramp.from - ramp.to) > 1e-6
  );
}

/**
 * Raw (un-normalised) relative velocity at normalised progress p ∈ [0,1].
 * Eased interpolation from `from` to `to`.
 */
function rawVelocity(ramp: SpeedRamp, p: number): number {
  const e = applyEasing(ramp.easing ?? 'easeIn', p);
  return ramp.from + (ramp.to - ramp.from) * e;
}

/**
 * Mean of rawVelocity over p ∈ [0,1], computed by Simpson's-style numeric
 * integration. Used to rescale the profile so its average is 1
 * (duration-preserving). For 'linear' easing this is exactly (from+to)/2; for
 * non-linear easings the integral is closed-form-awkward, so we integrate
 * numerically once (cheap, N samples) and cache nothing — callers that sample
 * many times should pass the precomputed mean via {@link makeRampSampler}.
 */
export function rampMeanVelocity(ramp: SpeedRamp): number {
  const N = 64; // trapezoidal steps — plenty for a smooth monotone-ish curve
  let sum = 0;
  for (let i = 0; i <= N; i++) {
    const p = i / N;
    const w = i === 0 || i === N ? 0.5 : 1; // trapezoid endpoints half-weighted
    sum += rawVelocity(ramp, p) * w;
  }
  return sum / N;
}

/**
 * Instantaneous speed FACTOR (multiplier on the base Clip.speed) at clip-local
 * timeline progress p ∈ [0,1]. The mean of this over the clip is 1, so
 * `baseSpeed * speedFactorAtProgress(...)` averages to baseSpeed and preserves
 * the clip's timeline duration.
 *
 * `mean` is the precomputed {@link rampMeanVelocity}; pass it to avoid
 * re-integrating on every sample (the preview samples this every animation
 * frame). Clamped to MIN_RAMP_VELOCITY so playbackRate never hits 0.
 */
export function speedFactorAtProgress(ramp: SpeedRamp, p: number, mean: number): number {
  const clampedP = p < 0 ? 0 : p > 1 ? 1 : p;
  const factor = rawVelocity(ramp, clampedP) / (mean > 1e-6 ? mean : 1);
  return Math.max(MIN_RAMP_VELOCITY, factor);
}

/**
 * The fraction (0..1) of the clip's SOURCE span that has been consumed by
 * normalised timeline progress p. This is the normalised integral of the
 * velocity profile: ∫₀ᵖ v(u) du / ∫₀¹ v(u) du. Because the denominator is the
 * full integral, this maps p=0→0 and p=1→1 exactly, so the clip still consumes
 * its full [trimStart, trimEnd] source span (duration-preserving).
 *
 * Used to map a timeline position to the correct SOURCE time when scrubbing /
 * seeking a ramped clip, so the playhead↔source mapping stays correct.
 */
export function sourceFractionAtProgress(ramp: SpeedRamp, p: number): number {
  const clampedP = p < 0 ? 0 : p > 1 ? 1 : p;
  if (clampedP <= 0) return 0;
  if (clampedP >= 1) return 1;
  const N = 128;
  // Integrate raw velocity from 0..clampedP and 0..1, take the ratio.
  const integrate = (upper: number): number => {
    let sum = 0;
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * upper;
      const w = i === 0 || i === N ? 0.5 : 1;
      sum += rawVelocity(ramp, u) * w;
    }
    return (sum * upper) / N;
  };
  const partial = integrate(clampedP);
  const full = integrate(1);
  if (full <= 1e-9) return clampedP;
  return Math.max(0, Math.min(1, partial / full));
}

/**
 * Inverse of {@link sourceFractionAtProgress}: given a consumed source fraction
 * f ∈ [0,1], return the normalised timeline progress p that produced it. Since
 * the source fraction is monotonically increasing in p, a binary search
 * converges quickly. Used to map a PLAYING video's source time back to the
 * timeline playhead for a ramped clip (the forward map is nonlinear).
 */
export function progressAtSourceFraction(ramp: SpeedRamp, f: number): number {
  const target = f < 0 ? 0 : f > 1 ? 1 : f;
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sourceFractionAtProgress(ramp, mid) < target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * A reusable sampler bound to one clip's ramp + geometry. Precomputes the mean
 * velocity once so per-frame sampling in the preview / export is cheap.
 */
export interface RampSampler {
  /** Instantaneous speed multiplier (on base speed) at timeline-local seconds. */
  speedFactorAtLocalTime: (localSec: number) => number;
  /** Source-local seconds for a given timeline-local seconds within the clip. */
  sourceTimeAtLocalTime: (localSec: number) => number;
  /** Timeline-local seconds for a given SOURCE-local seconds (inverse map). */
  localTimeAtSourceTime: (sourceSec: number) => number;
}

/**
 * Build a {@link RampSampler} for a clip.
 *
 * @param ramp        the speed ramp (assumed valid — call hasSpeedRamp first)
 * @param baseSpeed   the constant Clip.speed (default 1)
 * @param trimStart   source-local start (seconds)
 * @param trimEnd     source-local end (seconds)
 * The clip's timeline duration is derived exactly as clipDuration does:
 *   timelineDur = (trimEnd - trimStart) / baseSpeed.
 */
export function makeRampSampler(
  ramp: SpeedRamp,
  baseSpeed: number,
  trimStart: number,
  trimEnd: number,
): RampSampler {
  const speed = baseSpeed > 0 ? baseSpeed : 1;
  const sourceSpan = Math.max(0, trimEnd - trimStart);
  const timelineDur = sourceSpan / speed;
  const mean = rampMeanVelocity(ramp);

  const progressOf = (localSec: number): number =>
    timelineDur > 1e-9 ? localSec / timelineDur : 0;

  return {
    speedFactorAtLocalTime: (localSec) =>
      speed * speedFactorAtProgress(ramp, progressOf(localSec), mean),
    sourceTimeAtLocalTime: (localSec) =>
      trimStart + sourceFractionAtProgress(ramp, progressOf(localSec)) * sourceSpan,
    localTimeAtSourceTime: (sourceSec) => {
      if (sourceSpan <= 1e-9) return 0;
      const f = (sourceSec - trimStart) / sourceSpan;
      return progressAtSourceFraction(ramp, f) * timelineDur;
    },
  };
}

/** Built-in "slow → fast acceleration" preset (スロー→急加速). */
export const SLOW_TO_FAST_PRESET: SpeedRamp = {
  from: 0.35,
  to: 2.4,
  easing: 'easeIn',
};

/** Built-in "fast → slow" preset (急→スロー), the reverse ramp. */
export const FAST_TO_SLOW_PRESET: SpeedRamp = {
  from: 2.4,
  to: 0.35,
  easing: 'easeOut',
};
