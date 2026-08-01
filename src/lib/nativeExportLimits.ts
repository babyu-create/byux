/**
 * FFmpeg filter expressions are recursive. Keep renderer-side generated
 * animation data within the boundary enforced again by nativeExportPlan.cjs.
 */
export const MAX_NATIVE_KEYFRAMES_PER_PROPERTY = 64;

/** Maximum frame-relative 2D path deviation accepted without user approval. */
export const MAX_MOTION_TRACK_SIMPLIFICATION_ERROR_PERCENT = 0.15;
