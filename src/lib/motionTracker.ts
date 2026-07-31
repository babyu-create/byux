import type { Keyframe } from './keyframes';

export interface TrackingRegion {
  /** Normalised top-left/size (0..1) in the video frame. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MotionTrackOptions {
  startTime: number;
  endTime: number;
  fps: number;
  region: TrackingRegion;
  maxFrames?: number;
  searchRadius?: number;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export interface MotionTrackResult {
  x: Keyframe[];
  y: Keyframe[];
  frameCount: number;
  averageConfidence: number;
  sampledFps: number;
}

export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

function clampRegion(region: TrackingRegion): TrackingRegion {
  const width = Math.max(0.04, Math.min(0.8, region.width));
  const height = Math.max(0.04, Math.min(0.8, region.height));
  return {
    width,
    height,
    x: Math.max(0, Math.min(1 - width, region.x)),
    y: Math.max(0, Math.min(1 - height, region.y)),
  };
}

export function extractPatch(frame: GrayFrame, region: TrackingRegion): GrayFrame {
  const r = clampRegion(region);
  const x0 = Math.floor(r.x * frame.width);
  const y0 = Math.floor(r.y * frame.height);
  const width = Math.max(2, Math.floor(r.width * frame.width));
  const height = Math.max(2, Math.floor(r.height * frame.height));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = (y0 + y) * frame.width + x0;
    data.set(frame.data.subarray(sourceOffset, sourceOffset + width), y * width);
  }
  return { width, height, data };
}

/** Return a 0..1 similarity score for a template at a frame pixel position. */
export function templateDifference(
  frame: GrayFrame,
  template: GrayFrame,
  x: number,
  y: number,
): number {
  if (
    x < 0 || y < 0 ||
    x + template.width > frame.width ||
    y + template.height > frame.height
  ) return 1;
  let total = 0;
  for (let row = 0; row < template.height; row += 1) {
    const frameOffset = (y + row) * frame.width + x;
    const templateOffset = row * template.width;
    for (let col = 0; col < template.width; col += 1) {
      total += Math.abs(frame.data[frameOffset + col] - template.data[templateOffset + col]);
    }
  }
  return total / (template.width * template.height * 255);
}

export function findBestTemplateMatch(
  frame: GrayFrame,
  template: GrayFrame,
  previousX: number,
  previousY: number,
  radius = 0.16,
): { x: number; y: number; confidence: number } {
  const pixelRadius = Math.max(2, Math.round(Math.min(frame.width, frame.height) * radius));
  const step = Math.max(1, Math.round(Math.min(template.width, template.height) / 12));
  let best = { x: previousX, y: previousY, difference: 1 };
  for (let y = previousY - pixelRadius; y <= previousY + pixelRadius; y += step) {
    for (let x = previousX - pixelRadius; x <= previousX + pixelRadius; x += step) {
      const difference = templateDifference(frame, template, x, y);
      if (difference < best.difference) best = { x, y, difference };
    }
  }
  // A 3x3 local refinement makes the result stable at low resolutions without
  // multiplying the full search cost.
  for (let y = best.y - step; y <= best.y + step; y += 1) {
    for (let x = best.x - step; x <= best.x + step; x += 1) {
      const difference = templateDifference(frame, template, x, y);
      if (difference < best.difference) best = { x, y, difference };
    }
  }
  return {
    x: best.x,
    y: best.y,
    confidence: Math.max(0, Math.min(1, 1 - best.difference * 2)),
  };
}

function frameFromCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): GrayFrame {
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    const offset = i * 4;
    data[i] = Math.round(rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114);
  }
  return { width, height, data };
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('追跡フレームを読み込めませんでした')); };
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = time;
  });
}

/** Track a selected rectangle using a lightweight KLT-style template matcher. */
export async function trackVideoElement(
  video: HTMLVideoElement,
  options: MotionTrackOptions,
): Promise<MotionTrackResult> {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const start = Math.max(0, Math.min(duration, options.startTime));
  const end = Math.max(start, Math.min(duration, options.endTime));
  if (end - start < 0.05) throw new Error('追跡範囲が短すぎます');
  const maxFrames = Math.max(2, Math.min(2_000, options.maxFrames ?? 1_800));
  const requestedFps = Math.max(1, Math.min(60, options.fps));
  const sampledFps = Math.min(requestedFps, (maxFrames - 1) / (end - start));
  const interval = 1 / sampledFps;
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('追跡用の画像処理を初期化できません');

  await seek(video, start);
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const first = frameFromCanvas(context, canvas.width, canvas.height);
  const initialRegion = clampRegion(options.region);
  const template = extractPatch(first, initialRegion);
  const initialX = Math.floor(initialRegion.x * first.width);
  const initialY = Math.floor(initialRegion.y * first.height);
  let currentX = initialX;
  let currentY = initialY;
  const x: Keyframe[] = [];
  const y: Keyframe[] = [];
  let confidenceTotal = 0;
  let frameCount = 0;
  for (let time = start; time <= end + 1e-6; time += interval) {
    if (options.signal?.aborted) throw new DOMException('追跡を中止しました', 'AbortError');
    await seek(video, Math.min(end, time));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = frameFromCanvas(context, canvas.width, canvas.height);
    const match = frameCount === 0
      ? { x: currentX, y: currentY, confidence: 1 }
      : findBestTemplateMatch(frame, template, currentX, currentY, options.searchRadius ?? 0.16);
    currentX = match.x;
    currentY = match.y;
    confidenceTotal += match.confidence;
    const localTime = time - start;
    x.push({ t: localTime, value: ((currentX - initialX) / first.width) * 100, easing: 'linear' });
    y.push({ t: localTime, value: ((currentY - initialY) / first.height) * 100, easing: 'linear' });
    frameCount += 1;
    options.onProgress?.(Math.min(1, (time - start) / Math.max(0.001, end - start)));
    if (time >= end) break;
  }
  return {
    x,
    y,
    frameCount,
    averageConfidence: confidenceTotal / Math.max(1, frameCount),
    sampledFps,
  };
}
