// Color grade / LUT-style one-click presets (pure logic).
//
// Byux keeps pro features SIMPLE: instead of a full color wheel / 3D-LUT NLE,
// a clip carries a small ColorGrade — a named preset plus a few fine knobs —
// which maps to a SINGLE CSS/Canvas2D `filter` string. The same string drives
// the live Preview (CSS `filter:` on the footage layer) AND the WebCodecs
// export (Canvas2D `ctx.filter` in OffscreenTransformRenderer), so the graded
// look in the preview is exactly what the exported MP4 shows (preview/export
// parity, like clipTransform / motionBlurCore).
//
// No dependency on the React store or the DOM — this is pure mapping logic so
// it can be unit-tested and reused identically by both render paths.

import type { ColorGrade, ColorGradePreset } from './types';

/** Concrete (resolved) grade — every knob resolved to a number, preset baked in. */
export interface ResolvedGrade {
  /** Exposure / brightness multiplier (1 = unchanged). */
  brightness: number;
  /** Contrast multiplier (1 = unchanged). */
  contrast: number;
  /** Saturation multiplier (1 = unchanged, 0 = grayscale). */
  saturation: number;
  /** Sepia amount 0..1 (warm tint base). */
  sepia: number;
  /** Hue rotation in degrees (cool/warm shift on top of sepia). */
  hueRotate: number;
}

/** Neutral grade — leaves the frame untouched (no filter emitted). */
export const IDENTITY_GRADE: ResolvedGrade = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  sepia: 0,
  hueRotate: 0,
};

const EPS = 1e-3;

/**
 * Built-in one-click presets. Each maps a familiar montage look to the same
 * five primitives the fine knobs use, so a preset is just a starting point the
 * user can then nudge. Values are intentionally tasteful/subtle — FPS kill
 * montages want punch without wrecking readability of the HUD.
 *   cinema — slightly crushed, desaturated, cool teal-ish (filmic)
 *   vivid  — punchy contrast + saturation (highlight reel)
 *   cool   — blue/cyan shift (night-ops feel)
 *   warm   — amber/golden shift (sunset / nostalgic)
 *   mono   — black & white
 */
const PRESETS: Record<Exclude<ColorGradePreset, 'none'>, ResolvedGrade> = {
  cinema: { brightness: 0.97, contrast: 1.12, saturation: 0.85, sepia: 0.08, hueRotate: -8 },
  vivid: { brightness: 1.03, contrast: 1.18, saturation: 1.35, sepia: 0, hueRotate: 0 },
  cool: { brightness: 1.0, contrast: 1.05, saturation: 1.05, sepia: 0, hueRotate: -18 },
  warm: { brightness: 1.02, contrast: 1.05, saturation: 1.08, sepia: 0.25, hueRotate: 8 },
  mono: { brightness: 1.0, contrast: 1.1, saturation: 0, sepia: 0, hueRotate: 0 },
};

/** Ordered list of presets for building UI button rows. */
export const COLOR_GRADE_PRESETS: ColorGradePreset[] = [
  'none',
  'cinema',
  'vivid',
  'cool',
  'warm',
  'mono',
];

/** Human-facing (Japanese) label for each preset. */
export const COLOR_GRADE_LABELS: Record<ColorGradePreset, string> = {
  none: 'なし',
  cinema: 'シネマ',
  vivid: 'ビビッド',
  cool: 'クール',
  warm: 'ウォーム',
  mono: 'モノクロ',
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Resolve a ColorGrade into concrete filter primitives. The preset (if any)
 * provides the base; the optional fine knobs are layered ON TOP of it as
 * deltas around the neutral point so "preset + nudge" composes intuitively:
 *   - exposure / contrast / saturation are multiplicative offsets (0 = no nudge)
 *   - temperature (-100..100) shifts warm(+)/cool(-) via sepia + hue-rotate
 * Each output knob is clamped to a safe, non-destructive range.
 */
export function resolveColorGrade(grade: ColorGrade | undefined): ResolvedGrade {
  if (!grade) return { ...IDENTITY_GRADE };

  const presetName = grade.preset ?? 'none';
  const base: ResolvedGrade =
    presetName === 'none' ? { ...IDENTITY_GRADE } : { ...PRESETS[presetName] };

  // Fine knobs are authored in [-100, 100] as "percent nudge" around neutral.
  const exposure = clamp(grade.exposure ?? 0, -100, 100);
  const contrast = clamp(grade.contrast ?? 0, -100, 100);
  const saturation = clamp(grade.saturation ?? 0, -100, 100);
  const temperature = clamp(grade.temperature ?? 0, -100, 100);

  // Map each ±100 nudge to a ±50% multiplier change, layered on the preset.
  const brightness = clamp(base.brightness * (1 + exposure / 200), 0.2, 2.5);
  const contrastOut = clamp(base.contrast * (1 + contrast / 200), 0.2, 2.5);
  const saturationOut = clamp(base.saturation * (1 + saturation / 200), 0, 3);

  // Temperature: positive = warmer (more sepia + slight + hue), negative =
  // cooler (negative hue-rotate, no sepia). Layered on the preset's own tint.
  let sepia = base.sepia;
  let hueRotate = base.hueRotate;
  if (temperature > 0) {
    sepia = clamp(base.sepia + (temperature / 100) * 0.4, 0, 1);
    hueRotate = base.hueRotate + (temperature / 100) * 10;
  } else if (temperature < 0) {
    hueRotate = base.hueRotate + (temperature / 100) * 25; // negative → cooler
  }

  return {
    brightness,
    contrast: contrastOut,
    saturation: saturationOut,
    sepia: clamp(sepia, 0, 1),
    hueRotate,
  };
}

/** True when a resolved grade visibly changes the frame (non-identity). */
export function isGradeVisible(r: ResolvedGrade): boolean {
  return (
    Math.abs(r.brightness - 1) > EPS ||
    Math.abs(r.contrast - 1) > EPS ||
    Math.abs(r.saturation - 1) > EPS ||
    Math.abs(r.sepia) > EPS ||
    Math.abs(r.hueRotate) > EPS
  );
}

/**
 * True when a clip's grade could ever change the frame — a preset other than
 * 'none', or any non-zero fine knob. Used to decide whether the export needs
 * the per-frame color-grade pass (it shares the transform pass) and whether
 * the stream-copy fast path is allowed.
 */
export function clipHasColorGrade(grade: ColorGrade | undefined): boolean {
  if (!grade) return false;
  return isGradeVisible(resolveColorGrade(grade));
}

/**
 * Build the CSS / Canvas2D `filter` string for a resolved grade. Order:
 * brightness → contrast → saturate → sepia → hue-rotate. The SAME string is
 * applied as a CSS `filter` in the preview and as `ctx.filter` in the export,
 * which is what guarantees parity. Returns 'none' for a neutral grade so
 * callers can skip applying a filter entirely.
 */
export function gradeToFilter(r: ResolvedGrade): string {
  if (!isGradeVisible(r)) return 'none';
  const parts: string[] = [];
  if (Math.abs(r.brightness - 1) > EPS) parts.push(`brightness(${round(r.brightness)})`);
  if (Math.abs(r.contrast - 1) > EPS) parts.push(`contrast(${round(r.contrast)})`);
  if (Math.abs(r.saturation - 1) > EPS) parts.push(`saturate(${round(r.saturation)})`);
  if (Math.abs(r.sepia) > EPS) parts.push(`sepia(${round(r.sepia)})`);
  if (Math.abs(r.hueRotate) > EPS) parts.push(`hue-rotate(${round(r.hueRotate)}deg)`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/** Round to 4 decimals and strip trailing zeros for clean filter strings. */
function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Convenience: map a clip's grade straight to a filter string (preview/export). */
export function colorGradeFilter(grade: ColorGrade | undefined): string {
  return gradeToFilter(resolveColorGrade(grade));
}
