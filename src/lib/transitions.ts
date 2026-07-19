// Kill-to-kill clip transition presets (Phase P4) — pure logic.
//
// Byux keeps pro features SIMPLE: instead of a full cross-clip NLE compositor,
// a clip carries optional `transitionIn` / `transitionOut` presets that animate
// the clip near its OWN start / end (opacity + light transform) over a short
// boundary window. Modelling a transition as a per-clip in/out modulation means
// NO cross-clip compositing is required — the modulation flows through the SAME
// path the keyframed clip transform already uses (sampleClipTransform → CSS in
// the preview, Canvas2D matrix in the WebCodecs export), so the boundary look
// in the preview is exactly what the exported MP4 shows (preview/export parity,
// like clipTransform / colorGrade / motionBlurCore).
//
// Reuses lib/keyframes.applyEasing for the easing curve, so a transition's
// progress is shaped identically to keyframe segments. No dependency on the
// React store or the DOM — pure mapping logic, unit-testable, shared by both
// render paths.

import { applyEasing } from './keyframes';

/**
 * Transition preset kinds.
 *   none  — no transition (absent / explicit off).
 *   cut   — hard cut (no animation); modelled so the picker can show "cut" as
 *           the explicit default without emitting any modulation.
 *   fade  — opacity 0→1 (in) / 1→0 (out). The robust, always-correct preset.
 *   slide — translate from / to an edge while fading.
 *   zoom  — scale from / to a punch while fading.
 */
export type TransitionType = 'none' | 'cut' | 'fade' | 'slide' | 'zoom';

/**
 * A clip-boundary transition. `duration` is the boundary window in seconds.
 * Both fields optional on a Clip so older projects stay valid (backward
 * compatible — see types.ts / project.ts schema).
 */
export interface ClipTransition {
  type: TransitionType;
  /** Boundary window in seconds. Clamped on use to [MIN, clip duration). */
  duration: number;
}

/**
 * Multiplicative / additive modulation a transition contributes at a moment.
 * Composes with the clip's sampled transform: opacity multiplies, scale
 * multiplies, x/y are ADDED (percent of frame), matching ResolvedTransform's
 * units in lib/clipTransform.
 */
export interface TransitionModulation {
  /** Opacity factor 0..1 (1 = no change). */
  opacity: number;
  /** Scale factor (1 = no change), multiplies the clip's scale. */
  scale: number;
  /** Added translate X, percent of frame width (0 = no change). */
  dx: number;
  /** Added translate Y, percent of frame height (0 = no change). */
  dy: number;
}

/** Neutral modulation — contributes nothing (used outside any window). */
export const NEUTRAL_MODULATION: TransitionModulation = {
  opacity: 1,
  scale: 1,
  dx: 0,
  dy: 0,
};

/** Minimum transition window so a 0/NaN duration can't divide-by-zero. */
export const MIN_TRANSITION_DURATION = 0.05;
/** Default transition window applied when a preset is first picked. */
export const DEFAULT_TRANSITION_DURATION = 0.4;

/** Slide travel distance as a percent of the frame (start offset for 'in'). */
const SLIDE_OFFSET_PCT = 12;
/** Zoom punch start scale for an 'in' transition (eases up to 1.0). */
const ZOOM_IN_FROM = 1.18;
/** Zoom punch end scale for an 'out' transition (eases up from 1.0). */
const ZOOM_OUT_TO = 1.18;

/** Ordered list of pickable presets for the UI (cut = explicit "no FX"). */
export const TRANSITION_TYPES: TransitionType[] = ['cut', 'fade', 'slide', 'zoom'];

/** Human-facing (Japanese) label for each transition type. */
export const TRANSITION_LABELS: Record<TransitionType, string> = {
  none: 'なし',
  cut: 'カット',
  fade: 'フェード',
  slide: 'スライド',
  zoom: 'ズーム',
};

/** True when a transition actually animates (not absent / 'none' / 'cut'). */
export function transitionIsActive(t: ClipTransition | undefined): boolean {
  return !!t && t.type !== 'none' && t.type !== 'cut';
}

/** True when EITHER boundary of a clip carries an animating transition. */
export function clipHasTransition(
  transitionIn: ClipTransition | undefined,
  transitionOut: ClipTransition | undefined,
): boolean {
  return transitionIsActive(transitionIn) || transitionIsActive(transitionOut);
}

/** Clamp a transition window to [MIN, half the clip] so in+out can't overlap. */
function clampWindow(duration: number, clipDuration: number): number {
  const safeDur = Number.isFinite(duration) ? duration : DEFAULT_TRANSITION_DURATION;
  const maxWindow = Math.max(MIN_TRANSITION_DURATION, clipDuration / 2);
  return Math.max(MIN_TRANSITION_DURATION, Math.min(safeDur, maxWindow));
}

/**
 * Build the modulation for a single boundary at progress `p` in [0,1], where
 * p=0 is fully "off-frame / invisible" and p=1 is fully "on-frame / visible"
 * (i.e. progress always runs invisible→visible regardless of in/out; the caller
 * inverts the elapsed mapping for the OUT side). `edge` is ±1 used to flip the
 * slide direction so in slides FROM an edge and out slides TO the opposite.
 */
function modulationAtProgress(
  type: TransitionType,
  p: number,
  edge: 1 | -1,
): TransitionModulation {
  const eased = applyEasing('easeOut', p);
  switch (type) {
    case 'fade':
      return { opacity: eased, scale: 1, dx: 0, dy: 0 };
    case 'slide': {
      // Slide horizontally: starts SLIDE_OFFSET_PCT off the edge, eases to 0,
      // fading in together so the entry reads clean (no hard pop at the edge).
      const dx = edge * SLIDE_OFFSET_PCT * (1 - eased);
      return { opacity: eased, scale: 1, dx, dy: 0 };
    }
    case 'zoom': {
      // Zoom punch: scale eases from ZOOM_IN_FROM → 1.0 (in) while fading in.
      const scale = ZOOM_IN_FROM + (1 - ZOOM_IN_FROM) * eased;
      return { opacity: eased, scale, dx: 0, dy: 0 };
    }
    case 'none':
    case 'cut':
    default:
      return { ...NEUTRAL_MODULATION };
  }
}

/**
 * Resolve the combined transition modulation at clip-local time `t` (seconds),
 * given the clip's total timeline duration. The IN transition animates over
 * [0, d_in); the OUT transition animates over [dur - d_out, dur). Outside both
 * windows (the clip body) the modulation is neutral. When both windows would
 * touch (very short clip) each is clamped to half the clip so they never
 * overlap; if both happen to be active at the same instant their factors
 * multiply (graceful, never > the neutral identity).
 *
 * For zoom OUT we ease scale 1.0 → ZOOM_OUT_TO so the clip punches up as it
 * fades, mirroring the IN punch-down — handled by overriding the OUT progress
 * mapping below.
 */
export function transitionModulationAt(
  transitionIn: ClipTransition | undefined,
  transitionOut: ClipTransition | undefined,
  t: number,
  clipDuration: number,
): TransitionModulation {
  if (clipDuration <= 0) return { ...NEUTRAL_MODULATION };

  let opacity = 1;
  let scale = 1;
  let dx = 0;
  let dy = 0;

  // --- IN window: [0, dIn) ---
  if (transitionIsActive(transitionIn) && transitionIn) {
    const dIn = clampWindow(transitionIn.duration, clipDuration);
    if (t < dIn) {
      const p = Math.max(0, Math.min(1, t / dIn));
      const m = modulationAtProgress(transitionIn.type, p, 1);
      opacity *= m.opacity;
      scale *= m.scale;
      dx += m.dx;
      dy += m.dy;
    }
  }

  // --- OUT window: [dur - dOut, dur) ---
  if (transitionIsActive(transitionOut) && transitionOut) {
    const dOut = clampWindow(transitionOut.duration, clipDuration);
    const outStart = clipDuration - dOut;
    if (t >= outStart) {
      // Progress invisible→visible is reversed for the OUT side: at outStart the
      // clip is fully visible (p=1), at the end it is gone (p=0).
      const p = Math.max(0, Math.min(1, (clipDuration - t) / dOut));
      // Slide OUT to the opposite edge (-1); zoom OUT punches UP instead of
      // down, so flip the scale contribution for zoom by inverting around 1.
      if (transitionOut.type === 'zoom') {
        const eased = applyEasing('easeOut', p);
        opacity *= eased;
        scale *= ZOOM_OUT_TO + (1 - ZOOM_OUT_TO) * eased;
      } else {
        const m = modulationAtProgress(transitionOut.type, p, -1);
        opacity *= m.opacity;
        scale *= m.scale;
        dx += m.dx;
        dy += m.dy;
      }
    }
  }

  return {
    opacity: Math.max(0, Math.min(1, opacity)),
    scale,
    dx,
    dy,
  };
}
