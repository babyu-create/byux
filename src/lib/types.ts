// Core domain types for Byux.

import type { Animatable } from './keyframes';
import type { SpeedRamp } from './speedRamp';
import type { ClipTransition } from './transitions';
import type { AudioDucking } from './audioDucking';

export type TrackKind = 'video' | 'overlay' | 'audio';

/**
 * Animatable clip transform (Phase 0 keyframe engine). Each field is either a
 * constant or a sorted Keyframe[] (see lib/keyframes). Applied identically by
 * the live Preview and the WebCodecs export renderer. All fields optional so
 * older projects without a transform stay valid (backward compatible).
 */
export interface ClipTransform {
  /** Translate X as % of frame width (+ = right, 0 = centered). */
  x?: Animatable;
  /** Translate Y as % of frame height (+ = down, 0 = centered). */
  y?: Animatable;
  /** Uniform scale multiplier (1 = 100%). Drives zoom/punch effects. */
  scale?: Animatable;
  /** Rotation in degrees. */
  rotation?: Animatable;
  /** Opacity 0..1 (1 = opaque). */
  opacity?: Animatable;
}

/** One-click color-grade preset names. 'none' = neutral (no grade). */
export type ColorGradePreset = 'none' | 'cinema' | 'vivid' | 'cool' | 'warm' | 'mono';

/**
 * Lightweight per-clip color grade (Phase P2). A named one-click preset plus a
 * few optional fine knobs, mapped by lib/colorGrade to a SINGLE CSS/Canvas2D
 * `filter` string applied identically by the live Preview (CSS `filter:`) and
 * the WebCodecs export (Canvas2D `ctx.filter`), so the look matches. Fine knobs
 * are authored in [-100, 100] as a nudge around neutral (0 = no change). All
 * fields optional so older projects without a grade stay valid (backward
 * compatible).
 */
export interface ColorGrade {
  /** Named preset (defaults to 'none'). */
  preset?: ColorGradePreset;
  /** Exposure / brightness nudge, -100..100 (0 = unchanged). */
  exposure?: number;
  /** Contrast nudge, -100..100 (0 = unchanged). */
  contrast?: number;
  /** Saturation nudge, -100..100 (0 = unchanged, -100 = grayscale-ish). */
  saturation?: number;
  /** Temperature shift, -100 (cool) .. 100 (warm), 0 = neutral. */
  temperature?: number;
}

export interface MediaAsset {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  url: string;
  /** Native File while the current session imported it directly. Re-linked
   * assets stream from Electron by sourceToken and intentionally omit this. */
  file?: File;
  /** Stable source size; unlike file.size this also exists after auto-relink. */
  size: number;
  /** Stable MIME type; unlike file.type this also exists after auto-relink. */
  mimeType: string;
  duration: number;
  width?: number;
  height?: number;
  /** Source-time onsets detected by the beat-detection pass. */
  beats?: number[];
  /** Cached waveform peaks (max amplitude per bin) for rendering. */
  waveform?: { peaks: Float32Array; peaksPerSecond: number };
  /** Absolute disk path (Electron only) — lets a reloaded project re-read the
   *  source file automatically instead of asking the user to re-add it. */
  path?: string;
  /** Opaque main-process registration used for chunked reads and streaming. */
  sourceToken?: string;
  /** Preview uses a lightweight H.264 proxy while export keeps the original file. */
  previewProxy?: boolean;
}

export type ClipEffectType = 'fade-in' | 'fade-out' | 'motion-blur';

export interface ClipEffect {
  type: ClipEffectType;
  /** Fade duration in seconds (fade-in / fade-out). */
  duration?: number;
  /**
   * Motion blur intensity (0–100). Shaped by shapeStrength() into the WebGL
   * directional-blur shader's strength multiplier — identically for the live
   * preview (MotionBlurCanvas) and the export renderer (motionBlurExporter via
   * WebCodecs). Higher = longer motion trails. (Legacy CSS-blur / ffmpeg tmix
   * behaviour no longer applies; tblend is only a fallback path.)
   */
  intensity?: number;
}

export type OverlayPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/** Decorative text style (Phase P3). 'none' = flat fill, no extra decoration. */
export type OverlayDecoration = 'none' | 'glow' | 'shadow' | 'gradient';

/**
 * Optional intro animation kind for a text overlay (Phase P3). Sampled by
 * lib/overlayText over the overlay's intro window from clip-local t=0, applied
 * identically by the live Preview (CSS transform/opacity) and the WebCodecs
 * export (ffmpeg fade + overlay position). 'none' = appears instantly.
 */
export type OverlayIntroKind = 'none' | 'fade' | 'slide-up' | 'slide-left' | 'scale-in';

export interface OverlayText {
  id: string;
  text: string;
  /** Font size in % of preview frame height. e.g. 8 = 8% (large title). */
  fontSize: number;
  color: string;
  position: OverlayPosition;
  weight?: number;
  italic?: boolean;
  outline?: boolean;
  outlineColor?: string;
  fontFamily?: string;
  /** Background color (transparent if undefined). */
  background?: string;
  /**
   * Decorative text treatment (Phase P3): soft 'glow', drop 'shadow', or a
   * vertical 'gradient' fill. Drawn identically by the preview (CSS) and the
   * export raster (Canvas2D). Absent / 'none' = flat fill (backward compatible).
   */
  decoration?: OverlayDecoration;
  /** Secondary color for 'gradient' decoration (bottom stop). Top stop = `color`. */
  decorationColor?: string;
  /**
   * Outline / stroke width as a fraction of font size (e.g. 0.08 = 8%). Only
   * applies when `outline` is on. Absent = default 0.08 (matches legacy look).
   */
  strokeWidth?: number;
  /** Optional intro animation kind (Phase P3). Absent / 'none' = no intro. */
  intro?: OverlayIntroKind;
  /** Intro animation duration in seconds (defaults to 0.4). Clamped on use. */
  introDuration?: number;
}

export interface Clip {
  id: string;
  trackId: string;
  assetId: string;
  start: number;
  trimStart: number;
  trimEnd: number;
  /** Playback speed multiplier (default 1.0). 0.5 = half speed, 2.0 = double. */
  speed?: number;
  /**
   * Optional time-varying speed ramp layered ON TOP of `speed` (e.g. slow-mo →
   * fast acceleration). Modelled as a normalised velocity profile whose mean is
   * 1, so it redistributes WHEN source is consumed without changing the clip's
   * timeline duration (clipDuration still derives from the constant `speed`).
   * Absent = constant `speed` (fully backward compatible). See lib/speedRamp.
   */
  speedRamp?: SpeedRamp;
  /** Clip-level volume multiplier (default 1.0). 0 = mute, 2.0 = +6dB boost. */
  volume?: number;
  /** Whether the clip is individually muted regardless of volume. */
  muted?: boolean;
  /**
   * Stretch the source to FILL the output frame, ignoring aspect ratio
   * (non-uniform scale). For VALORANT "stretched" gameplay recorded at a 4:3
   * resolution (e.g. 1440x1080), this reproduces the wide in-game look by
   * stretching to 16:9 instead of pillar-boxing. Off = preserve aspect (pad).
   */
  stretchToFill?: boolean;
  /** Animatable transform (position / scale / rotation / opacity). */
  transform?: ClipTransform;
  /** One-click color grade / LUT-style preset + fine knobs (see lib/colorGrade). */
  colorGrade?: ColorGrade;
  /**
   * Optional kill-to-kill transition preset applied at the clip's OWN start
   * boundary (fade / slide / zoom in over a short window). Modelled per-clip
   * (no cross-clip compositing) — see lib/transitions. Absent = hard cut.
   */
  transitionIn?: ClipTransition;
  /** Optional transition preset applied at the clip's OWN end boundary. */
  transitionOut?: ClipTransition;
  effects: ClipEffect[];
  overlays?: OverlayText[];
}

export interface Track {
  id: string;
  kind: TrackKind;
  label: string;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
}

export interface KillMarker {
  id: string;
  assetId: string;
  time: number;
  label?: string;
}

export interface IORange {
  id: string;
  assetId: string;
  inTime: number;
  outTime: number;
  label?: string;
}

export interface PendingIn {
  assetId: string;
  time: number;
}

export interface ProjectState {
  name: string;
  aspectRatio: '16:9' | '9:16';
  fps: 30 | 60;
  resolution: '720p' | '1080p';
  tracks: Track[];
  clips: Clip[];
  markers: KillMarker[];
  duration: number;
  /**
   * Optional project-level BGM auto-ducking (Phase P5). When enabled, music on
   * the BGM track is automatically dipped around each kill marker (the game's
   * SE / kill moments). Absent = no ducking (backward compatible). See
   * lib/audioDucking.
   */
  audioDucking?: AudioDucking;
}
