// Offscreen Canvas2D clip-transform renderer for MP4 export (Phase 0).
//
// Applies the EXACT same animated clip transform the live preview shows (CSS
// transform on the footage layer — see components/Preview/Preview.tsx and
// lib/clipTransform), but headlessly against a detached canvas so the export
// pipeline can bake the transform into each rendered frame (preview/export
// parity, like OffscreenMotionBlurRenderer for motion blur).
//
// Each frame is drawn into a black frame-sized canvas using the affine matrix
// from transformToMatrix() (origin = frame center) and the sampled opacity.
// Pixels pushed outside the frame are clipped; uncovered areas stay black —
// matching the preview, where the surrounding .frame background shows through.

import { transformToMatrix, type ResolvedTransform } from './clipTransform';

/** Frame sources accepted by drawFrame — same set Canvas2D.drawImage accepts. */
export type TransformFrameSource =
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLVideoElement
  | HTMLImageElement;

/**
 * Headless renderer that bakes a per-frame clip transform into frames. Create
 * one per export at the output resolution, call drawFrame() for each decoded
 * frame with its sampled transform, then dispose().
 *
 * Not React-aware; only creates a detached canvas, so it is safe to drive from
 * the async export pipeline.
 */
export class OffscreenTransformRenderer {
  private readonly width: number;
  private readonly height: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private disposed = false;

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) {
      throw new Error(`OffscreenTransformRenderer: invalid size ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('OffscreenTransformRenderer: 2D context unavailable');
    }
    this.ctx = ctx;
  }

  /**
   * Draw one frame with the given resolved transform and return the canvas it
   * was composited into (already at output resolution, top-left origin). The
   * caller feeds it to a VideoFrame; the canvas is reused next call.
   *
   * The source frame MUST already be at the output resolution (the export
   * normalises clips to the output geometry before this pass), so the matrix
   * maps frame-pixels → frame-pixels directly.
   */
  drawFrame(source: TransformFrameSource, t: ResolvedTransform): HTMLCanvasElement {
    if (this.disposed) throw new Error('OffscreenTransformRenderer: used after dispose()');
    const { ctx } = this;
    // Black background so uncovered areas (scale<1, translate off-frame) match
    // the preview's frame background instead of leaving stale pixels.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, this.width, this.height);

    const [a, b, c, d, e, f] = transformToMatrix(t, this.width, this.height);
    ctx.setTransform(a, b, c, d, e, f);
    ctx.globalAlpha = Math.max(0, Math.min(1, t.opacity));
    ctx.drawImage(source, 0, 0, this.width, this.height);

    // Restore defaults so a partial-failure next call can't inherit state.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    return this.canvas;
  }

  dispose(): void {
    this.disposed = true;
  }
}
