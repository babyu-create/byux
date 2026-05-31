// Core domain types for the FPS Clip Editor.

export type TrackKind = 'video' | 'overlay' | 'audio';

export interface MediaAsset {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  url: string;
  file: File;
  duration: number;
  width?: number;
  height?: number;
  /** Source-time onsets detected by the beat-detection pass. */
  beats?: number[];
  /** Cached waveform peaks (max amplitude per bin) for rendering. */
  waveform?: { peaks: Float32Array; peaksPerSecond: number };
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
}
