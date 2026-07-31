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

export interface TrackingPositionDecision {
  x: number;
  y: number;
  confidence: number;
  accepted: boolean;
}

export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface TemplateMatchOptions {
  /** Candidate scale factors used when the regular local search loses lock. */
  scales?: readonly number[];
  /** Candidate clockwise angles in degrees used for recovery searches. */
  angles?: readonly number[];
  /** Compare contrast-normalised pixels so exposure changes do not break lock. */
  normalised?: boolean;
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

function patchDifference(
  frame: GrayFrame,
  template: GrayFrame,
  x: number,
  y: number,
  normalised: boolean,
): number {
  if (
    x < 0 || y < 0 ||
    x + template.width > frame.width ||
    y + template.height > frame.height
  ) return 1;
  const count = template.width * template.height;
  let frameMean = 0;
  let templateMean = 0;
  for (let row = 0; row < template.height; row += 1) {
    const frameOffset = (y + row) * frame.width + x;
    const templateOffset = row * template.width;
    for (let col = 0; col < template.width; col += 1) {
      frameMean += frame.data[frameOffset + col];
      templateMean += template.data[templateOffset + col];
    }
  }
  frameMean /= count;
  templateMean /= count;
  let difference = 0;
  let frameVariance = 0;
  let templateVariance = 0;
  for (let row = 0; row < template.height; row += 1) {
    const frameOffset = (y + row) * frame.width + x;
    const templateOffset = row * template.width;
    for (let col = 0; col < template.width; col += 1) {
      const frameValue = frame.data[frameOffset + col] - frameMean;
      const templateValue = template.data[templateOffset + col] - templateMean;
      difference += Math.abs(frameValue - templateValue);
      frameVariance += frameValue * frameValue;
      templateVariance += templateValue * templateValue;
    }
  }
  if (!normalised) return difference / (count * 255);
  // Flat regions have no trackable signal. Treat them as a miss rather than
  // allowing a random low-contrast patch to move the object across the frame.
  if (frameVariance < 16 || templateVariance < 16) return 1;
  const correlation = Math.max(
    -1,
    Math.min(1, 1 - difference / Math.max(1, 2 * Math.sqrt(frameVariance * templateVariance))),
  );
  return 0.5 - correlation * 0.5;
}

export function transformTemplate(template: GrayFrame, scale: number, angleDegrees: number): GrayFrame {
  const width = Math.max(2, Math.round(template.width * scale));
  const height = Math.max(2, Math.round(template.height * scale));
  const angle = angleDegrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const data = new Uint8Array(width * height);
  const sourceCx = (template.width - 1) / 2;
  const sourceCy = (template.height - 1) / 2;
  const targetCx = (width - 1) / 2;
  const targetCy = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const scaledX = (x - targetCx) / scale;
      const scaledY = (y - targetCy) / scale;
      const sourceX = Math.round(scaledX * cos + scaledY * sin + sourceCx);
      const sourceY = Math.round(-scaledX * sin + scaledY * cos + sourceCy);
      data[y * width + x] = sourceX >= 0 && sourceX < template.width && sourceY >= 0 && sourceY < template.height
        ? template.data[sourceY * template.width + sourceX]
        : 0;
    }
  }
  return { width, height, data };
}

/** Reject weak/implausibly distant matches during occlusion. */
export function decideTrackingPosition(
  previousX: number,
  previousY: number,
  predictedX: number,
  predictedY: number,
  match: { x: number; y: number; confidence: number },
  frame: Pick<GrayFrame, 'width' | 'height'>,
  radius = 0.16,
): TrackingPositionDecision {
  const maxDisplacement = Math.max(
    4,
    Math.min(frame.width, frame.height) * Math.max(0.08, radius),
  );
  const displacement = Math.hypot(match.x - predictedX, match.y - predictedY);
  const accepted = Number.isFinite(match.confidence) && match.confidence >= 0.48 &&
    displacement <= maxDisplacement * 1.35;
  if (accepted) {
    return { x: match.x, y: match.y, confidence: match.confidence, accepted: true };
  }
  return {
    x: Math.max(0, Math.min(frame.width - 2, previousX)),
    y: Math.max(0, Math.min(frame.height - 2, previousY)),
    confidence: Math.max(0, Math.min(1, match.confidence)),
    accepted: false,
  };
}

function blendTemplate(target: GrayFrame, patch: GrayFrame, amount: number): GrayFrame {
  if (target.width !== patch.width || target.height !== patch.height) return target;
  const data = new Uint8Array(target.data.length);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.round(target.data[i] * (1 - amount) + patch.data[i] * amount);
  }
  return { ...target, data };
}

export function findBestTemplateMatch(
  frame: GrayFrame,
  template: GrayFrame,
  previousX: number,
  previousY: number,
  radius = 0.16,
  options: TemplateMatchOptions = {},
): { x: number; y: number; confidence: number } {
  const pixelRadius = Math.max(2, Math.round(Math.min(frame.width, frame.height) * radius));
  const step = Math.max(1, Math.round(Math.min(template.width, template.height) / 12));
  const scales = options.scales?.length ? options.scales : [1];
  const angles = options.angles?.length ? options.angles : [0];
  let best = { x: previousX, y: previousY, difference: 1, offsetX: 0, offsetY: 0, template };
  for (const scale of scales) {
    if (!Number.isFinite(scale) || scale < 0.5 || scale > 1.8) continue;
    for (const angle of angles) {
      if (!Number.isFinite(angle) || Math.abs(angle) > 30) continue;
      const candidate = scale === 1 && angle === 0
        ? template
        : transformTemplate(template, scale, angle);
      const offsetX = Math.round((candidate.width - template.width) / 2);
      const offsetY = Math.round((candidate.height - template.height) / 2);
      for (let y = previousY - pixelRadius - offsetY; y <= previousY + pixelRadius - offsetY; y += step) {
        for (let x = previousX - pixelRadius - offsetX; x <= previousX + pixelRadius - offsetX; x += step) {
          const difference = patchDifference(frame, candidate, x, y, options.normalised === true);
          if (difference < best.difference) best = { x, y, difference, offsetX, offsetY, template: candidate };
        }
      }
    }
  }
  // A 3x3 local refinement makes the result stable at low resolutions without
  // multiplying the full search cost.
  for (let y = best.y - step; y <= best.y + step; y += 1) {
    for (let x = best.x - step; x <= best.x + step; x += 1) {
      const difference = patchDifference(frame, best.template, x, y, options.normalised === true);
      if (difference < best.difference) best = { ...best, x, y, difference };
    }
  }
  return {
    x: best.x + (best.offsetX ?? 0),
    y: best.y + (best.offsetY ?? 0),
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
  let template = extractPatch(first, initialRegion);
  const initialX = Math.floor(initialRegion.x * first.width);
  const initialY = Math.floor(initialRegion.y * first.height);
  let currentX = initialX;
  let currentY = initialY;
  const x: Keyframe[] = [];
  const y: Keyframe[] = [];
  let confidenceTotal = 0;
  let previousConfidence = 1;
  let velocityX = 0;
  let velocityY = 0;
  let frameCount = 0;
  for (let time = start; time <= end + 1e-6; time += interval) {
    if (options.signal?.aborted) throw new DOMException('追跡を中止しました', 'AbortError');
    await seek(video, Math.min(end, time));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = frameFromCanvas(context, canvas.width, canvas.height);
    const predictedX = currentX + velocityX;
    const predictedY = currentY + velocityY;
    const searchRadius = previousConfidence < 0.55
      ? Math.max(0.24, options.searchRadius ?? 0.16)
      : options.searchRadius ?? 0.16;
    const match = frameCount === 0
      ? { x: currentX, y: currentY, confidence: 1 }
      : findBestTemplateMatch(
        frame,
        template,
        Math.round(predictedX),
        Math.round(predictedY),
        searchRadius,
        previousConfidence < 0.55
          ? {
              scales: [0.82, 0.92, 1, 1.08, 1.2],
              angles: [-12, -6, 0, 6, 12],
              normalised: true,
            }
          : undefined,
      );
    const decision = frameCount === 0
      ? { x: match.x, y: match.y, confidence: 1, accepted: true }
      : decideTrackingPosition(
        currentX,
        currentY,
        predictedX,
        predictedY,
        match,
        first,
        searchRadius,
      );
    const matchConfidence = decision.confidence;
    if (decision.accepted) {
      velocityX = velocityX * 0.65 + (decision.x - currentX) * 0.35;
      velocityY = velocityY * 0.65 + (decision.y - currentY) * 0.35;
      currentX = decision.x;
      currentY = decision.y;
    } else {
      // Keep a conservative prediction during occlusion. This prevents a
      // random background match from poisoning the adaptive template while
      // still allowing the wider recovery search to reacquire the target.
      currentX = Math.max(0, Math.min(first.width - template.width, Math.round(predictedX)));
      currentY = Math.max(0, Math.min(first.height - template.height, Math.round(predictedY)));
      velocityX *= 0.82;
      velocityY *= 0.82;
    }
    previousConfidence = matchConfidence;
    if (matchConfidence >= 0.7) {
      const observed = extractPatch(frame, {
        x: currentX / first.width,
        y: currentY / first.height,
        width: template.width / first.width,
        height: template.height / first.height,
      });
      template = blendTemplate(template, observed, 0.12);
    }
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
