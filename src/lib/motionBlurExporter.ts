// Offscreen WebGL motion-blur renderer for MP4 export (Phase 2).
//
// Runs the EXACT same directional-motion-blur shader the live preview uses
// (see motionBlurCore.ts), but headlessly against a detached canvas so the
// export pipeline can blur each decoded frame and re-encode it. This replaces
// the old ffmpeg `tblend=average` pass, whose simple frame-averaging produced a
// ghosting look that did NOT match what the user saw in the preview.
//
// State (motion EMA, velocity carry, SAD history, ping-pong textures) is held
// on the instance and advanced one frame per processFrame() call, so feeding
// frames in playback order reproduces the preview's temporal behaviour
// (flick→hold tail, aim-hold sharpness) frame-for-frame.

import {
  type GlSetup,
  type HudPreset,
  type SadHistoryState,
  HUD_PRESET_INDEX,
  MIN_PIXEL_SHIFT,
  SAMPLE_W,
  SAMPLE_H,
  VELOCITY_DECAY,
  destroySetup,
  estimateGlobalMotion,
  makeSadHistory,
  motionToUniforms,
  renderFrame,
  setupGl,
} from './motionBlurCore';

/**
 * Frame sources accepted by processFrame. Restricted to the types valid for
 * BOTH `CanvasRenderingContext2D.drawImage` (motion sampling) and
 * `WebGLRenderingContext.texImage2D` (GPU upload) — notably excludes
 * SVGImageElement, which drawImage allows but texImage2D rejects.
 */
export type BlurFrameSource =
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLVideoElement
  | HTMLImageElement;

/** Per-export blur configuration — constant across all frames of one export. */
export interface OffscreenBlurConfig {
  /** Peak blur strength multiplier (same units as the preview slider). */
  strength: number;
  /** HUD preset for the positional protect mask. */
  hudPreset: HudPreset;
  /** HUD mask attenuation, 0..1. */
  hudMaskStrength: number;
}

// Matches the preview RAF loop's EMA so smoothed motion ramps identically.
const EMA = 0.4;

/**
 * Headless renderer that applies the shared motion-blur shader to a sequence of
 * frames. Create one per export at the output resolution, call processFrame()
 * for each frame in order, then dispose().
 *
 * Not React-aware and never touches the DOM beyond creating a detached canvas,
 * so it is safe to drive from the export worker / async pipeline.
 */
export class OffscreenMotionBlurRenderer {
  private readonly width: number;
  private readonly height: number;
  private readonly aspect: number;
  private readonly config: OffscreenBlurConfig;

  private readonly canvas: HTMLCanvasElement;
  private setup: GlSetup;

  // CPU motion-estimation surface (downsampled).
  private readonly sampleCanvas: HTMLCanvasElement;
  private readonly sampleCtx: CanvasRenderingContext2D;
  private readonly prevFrame: Uint8ClampedArray;
  private prevValid = false;

  // Smoothed / carried motion state — identical bookkeeping to the preview.
  private smoothDx = 0;
  private smoothDy = 0;
  private carryDx = 0;
  private carryDy = 0;
  private readonly sadHistory: SadHistoryState;
  private hasPrevFrame = false;

  // Readback + Y-flip scratch buffers (allocated once, reused per frame).
  // `readBuf` holds the bottom-up framebuffer from gl.readPixels; `flipBuf`
  // holds the top-left-origin RGBA that VideoFrame expects. Both are reused —
  // VideoFrame copies the buffer on construction, so flipBuf is safe to reuse
  // on the next frame once the VideoFrame is built.
  private readonly readBuf: Uint8Array;
  private readonly flipBuf: Uint8Array;

  private disposed = false;

  constructor(width: number, height: number, config: OffscreenBlurConfig) {
    if (width <= 0 || height <= 0) {
      throw new Error(`OffscreenMotionBlurRenderer: invalid size ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.aspect = width / Math.max(1, height);
    this.config = config;

    // Detached canvas at full output resolution — export favours quality over
    // the preview's half-res perf shortcut.
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const setup = setupGl(this.canvas);
    if (!setup) {
      throw new Error('OffscreenMotionBlurRenderer: WebGL setup failed (no context / shader compile error)');
    }
    this.setup = setup;

    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = SAMPLE_W;
    this.sampleCanvas.height = SAMPLE_H;
    const sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!sampleCtx) {
      destroySetup(setup);
      throw new Error('OffscreenMotionBlurRenderer: 2D context for motion sampling unavailable');
    }
    this.sampleCtx = sampleCtx;
    this.prevFrame = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H * 4);
    this.sadHistory = makeSadHistory();

    this.readBuf = new Uint8Array(width * height * 4);
    this.flipBuf = new Uint8Array(width * height * 4);
  }

  /**
   * Blur a single frame and return its RGBA pixels (upright, top-left origin,
   * length width*height*4). The frame source must be at the renderer's output
   * resolution. Frames MUST be supplied in playback order — the motion
   * estimator depends on the previous frame.
   *
   * Returns an internal buffer reused across calls; feed it to
   * `new VideoFrame(buf, { format: 'RGBA', ... })` immediately (the VideoFrame
   * constructor copies the data, so the buffer is safe to overwrite next call).
   */
  processFrame(source: BlurFrameSource): Uint8Array {
    if (this.disposed) throw new Error('OffscreenMotionBlurRenderer: used after dispose()');
    const { gl } = this.setup;

    // === Motion estimation (CPU) — every export frame is "advancing". ===
    let dxPx = 0;
    let dyPx = 0;
    this.sampleCtx.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = this.sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    if (this.prevValid) {
      const est = estimateGlobalMotion(data, this.prevFrame, this.sadHistory);
      const mag = Math.hypot(est.dx, est.dy);
      if (!est.isStill && mag >= MIN_PIXEL_SHIFT) {
        dxPx = est.dx;
        dyPx = est.dy;
      }
    }
    this.prevFrame.set(data);
    this.prevValid = true;

    // Velocity decay + EMA — identical to the preview RAF loop.
    const measuredDx = dxPx + this.carryDx * VELOCITY_DECAY;
    const measuredDy = dyPx + this.carryDy * VELOCITY_DECAY;
    if (Math.hypot(dxPx, dyPx) > 0) {
      this.carryDx = dxPx;
      this.carryDy = dyPx;
    } else {
      this.carryDx *= VELOCITY_DECAY;
      this.carryDy *= VELOCITY_DECAY;
    }
    this.smoothDx = this.smoothDx * (1 - EMA) + measuredDx * EMA;
    this.smoothDy = this.smoothDy * (1 - EMA) + measuredDy * EMA;

    const { motionUVX, motionUVY, magnitudeUV, sampleCount } = motionToUniforms(
      this.smoothDx, this.smoothDy, this.config.strength,
    );

    // === GPU render ===
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.setup.curTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    const hudMask = Math.max(0, Math.min(1, this.config.hudMaskStrength));
    renderFrame(this.setup, this.width, this.height, {
      motionUVX,
      motionUVY,
      magnitudeUV,
      sampleCount,
      hudMask,
      hudPresetIndex: HUD_PRESET_INDEX[this.config.hudPreset],
      aspect: this.aspect,
      hasPrevFrame: this.hasPrevFrame,
    });

    // Read the rendered framebuffer back. readPixels origin is bottom-left, so
    // row 0 is the bottom of the image — flip into the top-left-origin RGBA
    // buffer that VideoFrame expects. (We keep readPixels rather than building
    // VideoFrame straight from the GL canvas because the context uses
    // preserveDrawingBuffer:false; readPixels right after the draw is the
    // guaranteed-valid readback path.)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuf);
    this.flipVertical(this.readBuf, this.flipBuf);

    // Ping-pong: this frame becomes next frame's "previous".
    const swap = this.setup.curTexture;
    this.setup.curTexture = this.setup.prevTexture;
    this.setup.prevTexture = swap;
    this.hasPrevFrame = true;

    return this.flipBuf;
  }

  /** Copy `src` (bottom-up RGBA) into `dst` (top-down RGBA) flipping rows. */
  private flipVertical(src: Uint8Array, dst: Uint8Array): void {
    const rowBytes = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      const srcStart = (this.height - 1 - y) * rowBytes;
      dst.set(src.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    destroySetup(this.setup);
  }
}
