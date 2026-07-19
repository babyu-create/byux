// Keyframe animation core for Byux: easing functions + property sampling.
//
// This is the Phase 0 foundation that powers animated clip transforms
// (position / scale / rotation / opacity), speed-remap easing, text/effect
// animation presets and zoom-pan. It is pure logic with NO dependency on the
// React store or DOM, so it can be reused identically by the live Preview and
// the WebCodecs export renderer (preview/export parity, like motionBlurCore).

export type EasingKind = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold';

export interface Keyframe {
  /** Time in seconds, local to the clip (timeline-local, before speed remap). */
  t: number;
  value: number;
  /** Easing applied FROM this keyframe toward the next. Default 'linear'. */
  easing?: EasingKind;
}

/** A numeric clip property that is either a constant or animated by keyframes. */
export type Animatable = number | Keyframe[];

const EASING_FUNCS: Record<EasingKind, (p: number) => number> = {
  linear: (p) => p,
  easeIn: (p) => p * p,
  easeOut: (p) => 1 - (1 - p) * (1 - p),
  easeInOut: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
  // 'hold' keeps the start value until the next keyframe (step). Returns 0 so
  // callers that interpolate get the start value; sample() also special-cases it.
  hold: () => 0,
};

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Apply an easing curve to a normalized progress p in [0,1]. */
export function applyEasing(kind: EasingKind, p: number): number {
  const fn = EASING_FUNCS[kind] ?? EASING_FUNCS.linear;
  return fn(clamp01(p));
}

/** True when the property is keyframe-animated (non-empty keyframe array). */
export function isAnimated(prop: Animatable | undefined): prop is Keyframe[] {
  return Array.isArray(prop) && prop.length > 0;
}

/**
 * Sample an animatable property at clip-local time `t` (seconds).
 * - constant number  -> that number
 * - keyframes        -> interpolated with per-segment easing; clamped (held)
 *                       at the first/last keyframe outside the range
 * - undefined / empty -> fallback
 */
export function sample(prop: Animatable | undefined, t: number, fallback: number): number {
  if (prop === undefined) return fallback;
  if (typeof prop === 'number') return prop;
  if (prop.length === 0) return fallback;

  // Keyframes are stored sorted, but be defensive for hand-edited data.
  const kfs = isSorted(prop) ? prop : [...prop].sort((a, b) => a.t - b.t);

  const first = kfs[0];
  const last = kfs[kfs.length - 1];
  if (t <= first.t) return first.value;
  if (t >= last.t) return last.value;

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.value;
      const easing = a.easing ?? 'linear';
      if (easing === 'hold') return a.value;
      const p = applyEasing(easing, (t - a.t) / span);
      return a.value + (b.value - a.value) * p;
    }
  }
  return last.value; // unreachable; safety net
}

function isSorted(kfs: Keyframe[]): boolean {
  for (let i = 1; i < kfs.length; i++) {
    if (kfs[i].t < kfs[i - 1].t) return false;
  }
  return true;
}

/** Insert or replace a keyframe at time `t`, keeping the array sorted. Pure. */
export function upsertKeyframe(kfs: Keyframe[], kf: Keyframe): Keyframe[] {
  const EPS = 1e-4;
  const next = kfs.filter((k) => Math.abs(k.t - kf.t) > EPS);
  next.push(kf);
  next.sort((a, b) => a.t - b.t);
  return next;
}

/** Remove the keyframe at time `t` (within epsilon). Pure. */
export function removeKeyframeAt(kfs: Keyframe[], t: number): Keyframe[] {
  const EPS = 1e-4;
  return kfs.filter((k) => Math.abs(k.t - t) > EPS);
}
