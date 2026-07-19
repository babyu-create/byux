// Decorative text + intro-animation helpers for overlays (Phase P3).
//
// Pure logic with NO React/DOM dependency, so the live Preview (OverlayLayer),
// the export raster (overlayRaster) and the export overlay pass (exporter) all
// derive the SAME look from the SAME source — preview/export parity, like
// clipTransform / colorGrade / motionBlurCore.
//
// Two concerns:
//   1. Decoration  — how a text overlay's outline / glow / shadow / gradient is
//      drawn. Static (does not change over time), so it bakes cleanly into the
//      export PNG and matches the preview's CSS exactly.
//   2. Intro       — an optional appear animation (fade / slide / scale) over a
//      short window from the overlay's clip-local start. Sampled per-frame in
//      the preview; reproduced in the export via ffmpeg fade + overlay offset.

import type { OverlayText, OverlayDecoration } from './types';
import { applyEasing } from './keyframes';

/** Default outline stroke width as a fraction of the font size. */
export const DEFAULT_STROKE_WIDTH = 0.08;
/** Default intro duration in seconds. */
export const DEFAULT_INTRO_DURATION = 0.4;
/** Slide intro travel distance, as a fraction of font size. */
const SLIDE_DISTANCE = 0.6;
/** Scale-in starting scale (grows to 1). */
const SCALE_FROM = 0.7;

/** Resolve the decoration kind (treat undefined as 'none'). */
export function overlayDecoration(o: Pick<OverlayText, 'decoration'>): OverlayDecoration {
  return o.decoration ?? 'none';
}

/** Resolve the outline stroke width fraction (defaulted + clamped to a sane range). */
export function overlayStrokeWidth(o: Pick<OverlayText, 'strokeWidth'>): number {
  const w = o.strokeWidth;
  if (typeof w !== 'number' || !Number.isFinite(w)) return DEFAULT_STROKE_WIDTH;
  return Math.max(0, Math.min(0.3, w));
}

/**
 * Build the CSS `text-shadow` string for an overlay, combining the outline
 * (4-way + diagonal offsets sized by strokeWidth) and the decoration glow /
 * drop-shadow. `fontPx` is the resolved font size in pixels so the offsets
 * scale with the text. Returns 'none' when there is nothing to draw.
 */
export function buildTextShadow(o: OverlayText, fontPx: number): string {
  const layers: string[] = [];
  const outlineColor = o.outlineColor ?? '#000000';

  if (o.outline) {
    // Stroke width scales with font size; a few px minimum so small text still
    // reads. Emit 8 directional offsets so the outline is even (CSS has no real
    // text stroke that works cross-browser for fills).
    const sw = Math.max(1, overlayStrokeWidth(o) * fontPx);
    const offs: Array<[number, number]> = [
      [-sw, 0], [sw, 0], [0, -sw], [0, sw],
      [-sw, -sw], [sw, -sw], [-sw, sw], [sw, sw],
    ];
    for (const [dx, dy] of offs) {
      layers.push(`${dx.toFixed(2)}px ${dy.toFixed(2)}px 0 ${outlineColor}`);
    }
  }

  const deco = overlayDecoration(o);
  if (deco === 'glow') {
    // Soft glow in the (top) text color — blur radius scales with font size.
    const glow = o.decorationColor ?? o.color;
    const r1 = (fontPx * 0.18).toFixed(2);
    const r2 = (fontPx * 0.4).toFixed(2);
    layers.push(`0 0 ${r1}px ${glow}`);
    layers.push(`0 0 ${r2}px ${glow}`);
  } else if (deco === 'shadow') {
    // Hard-ish drop shadow, offset down-right.
    const off = (fontPx * 0.06).toFixed(2);
    const blur = (fontPx * 0.12).toFixed(2);
    layers.push(`${off}px ${off}px ${blur}px rgba(0,0,0,0.65)`);
  }

  return layers.length > 0 ? layers.join(', ') : 'none';
}

/** A sampled intro pose: opacity + offset (% of font size) + scale multiplier. */
export interface OverlayIntroPose {
  /** 0..1 opacity multiplier. */
  opacity: number;
  /** Horizontal offset as a fraction of font size (+ = right). */
  dx: number;
  /** Vertical offset as a fraction of font size (+ = down). */
  dy: number;
  /** Uniform scale multiplier (1 = settled). */
  scale: number;
}

/** Settled (fully-shown) pose — the end state of every intro. */
export const SETTLED_POSE: OverlayIntroPose = { opacity: 1, dx: 0, dy: 0, scale: 1 };

/** Resolve the intro duration (defaulted + clamped to a sane positive range). */
export function overlayIntroDuration(o: Pick<OverlayText, 'introDuration'>): number {
  const d = o.introDuration;
  if (typeof d !== 'number' || !Number.isFinite(d)) return DEFAULT_INTRO_DURATION;
  return Math.max(0.05, Math.min(5, d));
}

/** True when the overlay has an intro animation that actually moves/fades. */
export function overlayHasIntro(o: Pick<OverlayText, 'intro'>): boolean {
  return o.intro !== undefined && o.intro !== 'none';
}

/**
 * Sample an overlay's intro pose at clip-local time `localT` (seconds, measured
 * from the clip's start — the overlay window begins at t=0). Before the window
 * the start pose is held; after it the settled pose is returned. easeOut gives
 * a snappy entrance. Pure — used by the preview AND mirrored by the export.
 */
export function sampleOverlayIntro(o: OverlayText, localT: number): OverlayIntroPose {
  if (!overlayHasIntro(o)) return SETTLED_POSE;
  const dur = overlayIntroDuration(o);
  // Progress 0..1 across the intro window, eased.
  const raw = localT <= 0 ? 0 : localT >= dur ? 1 : localT / dur;
  const p = applyEasing('easeOut', raw);
  // Interpolate from the start pose (p=0) to settled (p=1).
  const lerp = (from: number, to: number): number => from + (to - from) * p;
  switch (o.intro) {
    case 'fade':
      return { opacity: lerp(0, 1), dx: 0, dy: 0, scale: 1 };
    case 'slide-up':
      return { opacity: lerp(0, 1), dx: 0, dy: lerp(SLIDE_DISTANCE, 0), scale: 1 };
    case 'slide-left':
      return { opacity: lerp(0, 1), dx: lerp(SLIDE_DISTANCE, 0), dy: 0, scale: 1 };
    case 'scale-in':
      return { opacity: lerp(0, 1), dx: 0, dy: 0, scale: lerp(SCALE_FROM, 1) };
    default:
      return SETTLED_POSE;
  }
}

/**
 * Build the CSS `transform` string for an intro pose, given the resolved font
 * size in pixels (offsets are in font-size fractions → px). Used by the preview
 * OverlayLayer. transform-origin should be set by the caller (per position).
 */
export function introPoseToCss(pose: OverlayIntroPose, fontPx: number): string {
  const tx = (pose.dx * fontPx).toFixed(2);
  const ty = (pose.dy * fontPx).toFixed(2);
  return `translate(${tx}px, ${ty}px) scale(${pose.scale.toFixed(4)})`;
}

// --- Export (ffmpeg) intro -------------------------------------------------
// The export composites a clip's overlays as ONE static PNG over the clip's
// output window (see exporter.applyOverlayPass). To reproduce the intro there,
// we animate that PNG with ffmpeg: an alpha fade-in for the appearance, plus a
// time-varying overlay x/y offset for the slide kinds. scale-in degrades to a
// fade (the overlay filter can't cheaply scale a looped image per-frame).
//
// `introForClipOverlays` collapses a clip's overlays to a single intro spec:
// the export PNG is shared, so we only animate when ALL overlays agree on the
// intro (else we leave it static — the safe, no-surprise default).

/** A resolved intro for a whole clip's overlay PNG (export side). */
export interface ClipOverlayIntro {
  kind: 'fade' | 'slide-up' | 'slide-left' | 'scale-in';
  /** Duration in seconds (already defaulted + clamped). */
  duration: number;
  /** Travel distance in PIXELS for slide kinds (0 for fade/scale). */
  distancePx: number;
}

/**
 * Resolve the single intro to apply to a clip's shared overlay PNG, or null if
 * none / the overlays disagree (→ export leaves the PNG static). `frameHeight`
 * converts the slide distance (font-size fraction) into pixels using each
 * overlay's font size; we use the max font size among animated overlays.
 */
export function introForClipOverlays(
  overlays: OverlayText[],
  frameHeight: number,
): ClipOverlayIntro | null {
  const withIntro = overlays.filter(overlayHasIntro);
  if (withIntro.length === 0) return null;
  // All overlays must share the SAME intro kind to animate the shared PNG.
  const kind = withIntro[0].intro;
  if (kind === undefined || kind === 'none') return null;
  if (!withIntro.every((o) => o.intro === kind)) return null;
  // Use the longest intro duration so nothing pops in early.
  const duration = withIntro.reduce(
    (m, o) => Math.max(m, overlayIntroDuration(o)),
    0,
  );
  // Largest font px among animated overlays drives the slide travel.
  const maxFontPx = withIntro.reduce(
    (m, o) => Math.max(m, (o.fontSize / 100) * frameHeight),
    0,
  );
  const distancePx =
    kind === 'slide-up' || kind === 'slide-left'
      ? Math.round(SLIDE_DISTANCE * maxFontPx)
      : 0;
  return { kind, duration, distancePx };
}

/**
 * Build the ffmpeg filter-graph fragment(s) for one overlay PNG, chained onto
 * `baseLabel` (e.g. `[0:v]` or a previous stage's `[ovN]`) and the PNG input
 * `inLabel` (e.g. `[1:v]`), producing `outLabel` (e.g. `[ov0]`/`[ovout]`).
 * `index` namespaces any intermediate labels so multiple overlays compose in
 * one filtergraph without label collisions. `start`/`end` are the overlay's
 * output window (seconds). When `intro` is null the overlay is composited
 * statically (legacy behaviour). Returns one or more `;`-joinable chain parts.
 * All commas inside expressions are escaped (\,) for the filtergraph parser.
 *
 * Pure string builder so it can be unit-tested without ffmpeg.
 */
export function buildOverlayFilterParts(
  baseLabel: string,
  inLabel: string,
  outLabel: string,
  index: number,
  start: number,
  end: number,
  intro: ClipOverlayIntro | null,
): string[] {
  const s = start.toFixed(3);
  const e = end.toFixed(3);
  const enable = `enable=between(t\\,${s}\\,${e})`;

  if (!intro) {
    return [`${baseLabel}${inLabel}overlay=0:0:${enable}${outLabel}`];
  }

  // Per-index label for the faded PNG so chained overlays don't collide.
  const fadedLabel = `[ovf${index}]`;
  // Alpha fade-in over [start, start+duration] on the PNG before compositing.
  const fade =
    `${inLabel}format=rgba\\,` +
    `fade=t=in:st=${s}:d=${intro.duration.toFixed(3)}:alpha=1${fadedLabel}`;

  // Position offset eases linearly to 0 over the intro window (overlay x/y has
  // no easing fn — the alpha fade carries the polish). ramp = max(0, 1 - p).
  let xExpr = '0';
  let yExpr = '0';
  if (intro.distancePx > 0) {
    const d = intro.distancePx;
    const dur = intro.duration.toFixed(3);
    const ramp = `max(0\\,1-(t-${s})/${dur})`;
    if (intro.kind === 'slide-up') {
      yExpr = `${d}*${ramp}`; // start below, rise up
    } else if (intro.kind === 'slide-left') {
      xExpr = `${d}*${ramp}`; // start right, slide left
    }
  }
  const composite = `${baseLabel}${fadedLabel}overlay=${xExpr}:${yExpr}:${enable}${outLabel}`;
  return [fade, composite];
}
