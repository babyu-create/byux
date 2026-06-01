// Clip transform sampling + CSS/canvas mapping (Phase 0 keyframe engine).
//
// Pure logic shared by the live Preview (CSS transform on the footage layer)
// and the WebCodecs export renderer (Canvas2D draw), so what the user frames in
// the preview is exactly what the exported MP4 shows (preview/export parity,
// like motionBlurCore / OffscreenMotionBlurRenderer).
//
// Coordinate conventions (match ClipTransform in types.ts):
//   x, y      — translate as a PERCENT of the frame width / height
//   scale     — uniform multiplier (1 = 100%)
//   rotation  — degrees
//   opacity   — 0..1
// transform-origin is the frame CENTER for both preview and export.

import type { ClipTransform } from './types';
import type { Keyframe } from './keyframes';
import { isAnimated, sample } from './keyframes';

/** Concrete (sampled) transform — every field resolved to a number. */
export interface ResolvedTransform {
  /** Translate X, percent of frame width. */
  x: number;
  /** Translate Y, percent of frame height. */
  y: number;
  /** Uniform scale multiplier. */
  scale: number;
  /** Rotation in degrees. */
  rotation: number;
  /** Opacity 0..1. */
  opacity: number;
}

/** Identity transform — nothing moves, full opacity. */
export const IDENTITY_TRANSFORM: ResolvedTransform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
};

const EPS = 1e-4;

/**
 * Sample a clip transform at clip-local time `t` (seconds). Each field is
 * resolved through lib/keyframes.sample so constants and keyframe arrays behave
 * identically. Missing fields fall back to the identity value.
 */
export function sampleClipTransform(
  transform: ClipTransform | undefined,
  t: number,
): ResolvedTransform {
  if (!transform) return { ...IDENTITY_TRANSFORM };
  return {
    x: sample(transform.x, t, IDENTITY_TRANSFORM.x),
    y: sample(transform.y, t, IDENTITY_TRANSFORM.y),
    scale: sample(transform.scale, t, IDENTITY_TRANSFORM.scale),
    rotation: sample(transform.rotation, t, IDENTITY_TRANSFORM.rotation),
    opacity: sample(transform.opacity, t, IDENTITY_TRANSFORM.opacity),
  };
}

/** True when a resolved transform visibly changes the frame (non-identity). */
export function isTransformVisible(r: ResolvedTransform): boolean {
  return (
    Math.abs(r.x) > EPS ||
    Math.abs(r.y) > EPS ||
    Math.abs(r.scale - 1) > EPS ||
    Math.abs(r.rotation) > EPS ||
    Math.abs(r.opacity - 1) > EPS
  );
}

/**
 * True when a CLIP'S transform could ever move/scale/rotate/fade the footage —
 * i.e. it has at least one field that is animated OR a non-identity constant.
 * Used to decide whether the export needs the per-frame transform pass.
 */
export function clipHasTransform(transform: ClipTransform | undefined): boolean {
  if (!transform) return false;
  const fields: Array<[keyof ClipTransform, number]> = [
    ['x', IDENTITY_TRANSFORM.x],
    ['y', IDENTITY_TRANSFORM.y],
    ['scale', IDENTITY_TRANSFORM.scale],
    ['rotation', IDENTITY_TRANSFORM.rotation],
    ['opacity', IDENTITY_TRANSFORM.opacity],
  ];
  for (const [key, identity] of fields) {
    const prop = transform[key];
    if (prop === undefined) continue;
    if (isAnimated(prop)) return true;
    if (typeof prop === 'number' && Math.abs(prop - identity) > EPS) return true;
  }
  return false;
}

/**
 * Build the CSS `transform` string for a resolved transform. Translation is
 * emitted in percent (relative to the element's own box, matching the % units),
 * then scale, then rotate — the same order the export's matrix uses so the two
 * paths compose identically. transform-origin must be `center` on the element.
 */
export function transformToCss(r: ResolvedTransform): string {
  // translate(%) is relative to the element box; since the footage layer fills
  // the frame, element-% equals frame-%. Order: translate → scale → rotate.
  return (
    `translate(${r.x}%, ${r.y}%) ` +
    `scale(${r.scale}) ` +
    `rotate(${r.rotation}deg)`
  );
}

// --- One-click transform-keyframe presets (Phase P3) -----------------------
// Pure authoring helpers that build keyframe arrays from a clip duration, so
// the preset buttons stay declarative and unit-testable. The resulting
// keyframes flow through the SAME sampleClipTransform path as hand-authored
// ones, so the preview and export render them identically.

/** Result of a transform preset: the keyframe arrays to merge into a transform. */
export interface TransformPresetKeyframes {
  x?: Keyframe[];
  y?: Keyframe[];
  scale?: Keyframe[];
}

/**
 * Build a "ズームパンチ" preset: scale eases from 1.0 → `to` over the clip.
 * Defaults match the existing one-click zoom-punch (1.0 → 1.15, easeOut).
 */
export function buildZoomPunchKeyframes(
  durationSec: number,
  to = 1.15,
): TransformPresetKeyframes {
  const dur = Math.max(0.2, durationSec);
  return {
    scale: [
      { t: 0, value: 1, easing: 'easeOut' },
      { t: dur, value: to },
    ],
  };
}

/**
 * Build a "シェイク" (camera shake) preset: x/y oscillate around 0 with a
 * decaying amplitude, as % of frame width/height. `amplitude` is the starting
 * peak offset (%), `shakes` the number of back-and-forth cycles. The shake is
 * front-loaded (decays to 0 by the end) so it reads as an impact, not a
 * constant wobble. Pure → testable; flows through sampleClipTransform.
 */
export function buildShakeKeyframes(
  durationSec: number,
  amplitude = 3,
  shakes = 6,
): TransformPresetKeyframes {
  const dur = Math.max(0.2, durationSec);
  const cycles = Math.max(1, Math.round(shakes));
  // One keyframe per half-cycle for x and y, alternating sign, amplitude
  // decaying linearly to 0. y uses a quarter-phase offset so motion isn't
  // purely diagonal. End at 0,0 so the clip settles.
  const xKfs: Keyframe[] = [];
  const yKfs: Keyframe[] = [];
  const steps = cycles * 2; // half-cycles
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dur;
    const decay = 1 - i / steps; // 1 → 0
    const amp = amplitude * decay;
    const xVal = i === steps ? 0 : (i % 2 === 0 ? amp : -amp);
    // y is phase-shifted: use sign based on floor((i+1)/2) parity.
    const ySign = Math.floor((i + 1) / 2) % 2 === 0 ? 1 : -1;
    const yVal = i === steps ? 0 : ySign * amp * 0.7;
    xKfs.push({ t, value: xVal, easing: 'easeInOut' });
    yKfs.push({ t, value: yVal, easing: 'easeInOut' });
  }
  return { x: xKfs, y: yKfs };
}

/** A 2D affine matrix [a, b, c, d, e, f] (CSS matrix() / Canvas setTransform). */
export type AffineMatrix = [number, number, number, number, number, number];

/**
 * Compute the Canvas2D affine matrix that reproduces {@link transformToCss} for
 * a frame of size `width`×`height`, with the transform origin at the frame
 * CENTER. Used by the export renderer so a frame drawn with this matrix matches
 * the CSS-transformed preview pixel-for-pixel.
 *
 * Derivation (origin = center):
 *   M = T(cx, cy) · T(x%·w, y%·h) · S(scale) · R(rot) · T(-cx, -cy)
 * Translation in % is converted to pixels here (x% of width, y% of height).
 */
export function transformToMatrix(
  r: ResolvedTransform,
  width: number,
  height: number,
): AffineMatrix {
  const cx = width / 2;
  const cy = height / 2;
  const tx = (r.x / 100) * width;
  const ty = (r.y / 100) * height;
  const rad = (r.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const s = r.scale;

  // Linear part L = S · R  → [a c; b d]. `+ 0` normalizes -0 → 0 so identity
  // and axis-aligned transforms produce clean zeros for consumers/tests.
  const a = s * cos + 0;
  const b = s * sin + 0;
  const c = -s * sin + 0;
  const d = s * cos + 0;

  // Full translation: move origin to center, translate by (tx,ty), apply L
  // around the center. e = cx + tx - (a·cx + c·cy); f = cy + ty - (b·cx + d·cy).
  const e = cx + tx - (a * cx + c * cy);
  const f = cy + ty - (b * cx + d * cy);

  return [a, b, c, d, e, f];
}
