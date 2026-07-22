// Pure helpers for timeline pixel/time conversions and clip math.
import type { Clip } from './types';
import { hasSpeedRamp, makeRampSampler } from './speedRamp';

export const BASE_PX_PER_SECOND = 40;

export function pxPerSecond(zoom: number): number {
  return BASE_PX_PER_SECOND * zoom;
}

export function timeToPx(time: number, zoom: number): number {
  return time * pxPerSecond(zoom);
}

export function pxToTime(px: number, zoom: number): number {
  return px / pxPerSecond(zoom);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Generate ruler tick configuration at the current zoom. */
export interface RulerTick {
  time: number;
  major: boolean;
  label?: string;
}

export function buildRulerTicks(
  durationSec: number,
  zoom: number,
  visibleStartSec = 0,
  visibleEndSec = Number.POSITIVE_INFINITY,
): RulerTick[] {
  const pxPs = pxPerSecond(zoom);
  let majorStep: number;
  let minorStep: number;

  if (pxPs >= 80) {
    majorStep = 1;
    minorStep = 0.25;
  } else if (pxPs >= 40) {
    majorStep = 5;
    minorStep = 1;
  } else if (pxPs >= 20) {
    majorStep = 10;
    minorStep = 1;
  } else {
    majorStep = 30;
    minorStep = 5;
  }

  const total = Math.max(durationSec, 30);
  const start = Math.max(0, Math.min(total, visibleStartSec));
  const end = Math.max(start, Math.min(total, visibleEndSec));
  const firstIndex = Math.max(0, Math.floor(start / minorStep));
  const lastIndex = Math.min(
    Math.ceil(total / minorStep),
    Math.ceil(end / minorStep),
  );
  const ticks: RulerTick[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const t = index * minorStep;
    if (t > total + 1e-6) break;
    const isMajor = Math.abs(Math.round(t / majorStep) * majorStep - t) < 1e-6;
    ticks.push({
      time: t,
      major: isMajor,
      label: isMajor ? formatRulerLabel(t) : undefined,
    });
  }
  return ticks;
}

function formatRulerLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function clipOverlapsTime(
  clip: { start: number; trimStart: number; trimEnd: number; speed?: number },
  t: number,
): boolean {
  const duration = clipDuration(clip);
  return t >= clip.start && t < clip.start + duration;
}

export function clipDuration(clip: {
  trimStart: number;
  trimEnd: number;
  speed?: number;
}): number {
  const baseDur = Math.max(0, clip.trimEnd - clip.trimStart);
  const speed = clip.speed ?? 1;
  return speed > 0 ? baseDur / speed : baseDur;
}

/** Source-time duration ignoring speed. */
export function clipSourceDuration(clip: { trimStart: number; trimEnd: number }): number {
  return Math.max(0, clip.trimEnd - clip.trimStart);
}

/** Map an editor timeline time to source-media time, including speed ramps. */
export function sourceTimeAtTimelineTime(
  clip: Pick<Clip, 'start' | 'trimStart' | 'trimEnd' | 'speed' | 'speedRamp'>,
  timelineTime: number,
): number {
  const localTime = timelineTime - clip.start;
  if (hasSpeedRamp(clip.speedRamp)) {
    return makeRampSampler(
      clip.speedRamp,
      clip.speed ?? 1,
      clip.trimStart,
      clip.trimEnd,
    ).sourceTimeAtLocalTime(localTime);
  }
  return clip.trimStart + localTime * (clip.speed ?? 1);
}

/** Inverse of sourceTimeAtTimelineTime, including speed ramps. */
export function timelineTimeAtSourceTime(
  clip: Pick<Clip, 'start' | 'trimStart' | 'trimEnd' | 'speed' | 'speedRamp'>,
  sourceTime: number,
): number {
  if (hasSpeedRamp(clip.speedRamp)) {
    const localTime = makeRampSampler(
      clip.speedRamp,
      clip.speed ?? 1,
      clip.trimStart,
      clip.trimEnd,
    ).localTimeAtSourceTime(sourceTime);
    return clip.start + localTime;
  }
  return clip.start + (sourceTime - clip.trimStart) / (clip.speed ?? 1);
}

interface OverlapClip {
  start: number;
  trimStart: number;
  trimEnd: number;
  speed?: number;
}

/** Effective duration on the timeline (accounts for speed). */
function overlapClipDuration(c: OverlapClip): number {
  const base = Math.max(0, c.trimEnd - c.trimStart);
  const speed = c.speed ?? 1;
  return speed > 0 ? base / speed : base;
}

/**
 * Resolve a desired start position so the moving clip does not overlap
 * with any other clips on the same track. Snaps to the nearest valid
 * slot (gap between clips) when overlap would occur.
 */
export function resolveClipPosition(
  others: OverlapClip[],
  desiredStart: number,
  duration: number,
  originalStart: number,
): number {
  const sorted = [...others].sort((a, b) => a.start - b.start);
  const target = Math.max(0, desiredStart);
  const epsilon = 1e-4;

  // Build list of valid placement intervals [slotStart, slotEnd]
  // where the clip's left edge can sit without causing overlap.
  const slots: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of sorted) {
    const cEnd = c.start + overlapClipDuration(c);
    const slotEnd = c.start - duration;
    if (slotEnd >= cursor - epsilon) {
      slots.push({ start: cursor, end: slotEnd });
    }
    cursor = Math.max(cursor, cEnd);
  }
  slots.push({ start: cursor, end: Number.POSITIVE_INFINITY });

  if (slots.length === 0) return Math.max(0, originalStart);

  // If target falls inside a slot, accept it as-is.
  for (const slot of slots) {
    if (target >= slot.start - epsilon && target <= slot.end + epsilon) {
      return Math.max(0, target);
    }
  }

  // Otherwise pick the slot edge nearest to target.
  let best = originalStart;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const candidate = target < slot.start ? slot.start : slot.end;
    if (!Number.isFinite(candidate)) continue;
    const dist = Math.abs(candidate - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return Math.max(0, best);
}

/** Find first clip on the same track whose start > t. */
export function nextClipOnTrack(
  clips: OverlapClip[],
  t: number,
): OverlapClip | null {
  const candidates = clips.filter((c) => c.start > t + 1e-6).sort((a, b) => a.start - b.start);
  return candidates[0] ?? null;
}

/** Find last clip on the same track whose start+duration <= t. */
export function prevClipEndOnTrack(
  clips: OverlapClip[],
  t: number,
): number {
  let maxEnd = 0;
  for (const c of clips) {
    const end = c.start + overlapClipDuration(c);
    if (end <= t + 1e-6 && end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

/** Find a free start position to insert a new clip on a track. */
export function findFreeSlot(
  others: OverlapClip[],
  duration: number,
  preferredStart = 0,
): number {
  return resolveClipPosition(others, preferredStart, duration, preferredStart);
}

export type SnapPointType = 'clip-start' | 'clip-end' | 'playhead' | 'origin' | 'beat';

export interface SnapPoint {
  time: number;
  type: SnapPointType;
}

export interface SnapResult {
  time: number;
  snappedTo: SnapPoint | null;
}

interface CollectSnapClip {
  id: string;
  trackId: string;
  start: number;
  trimStart: number;
  trimEnd: number;
  speed?: number;
}

/**
 * Collect candidate snap points across all tracks (excluding the moving clip).
 */
export function collectSnapPoints(
  clips: CollectSnapClip[],
  excludeClipId: string | null,
  playhead: number,
): SnapPoint[] {
  const points: SnapPoint[] = [
    { time: 0, type: 'origin' },
    { time: playhead, type: 'playhead' },
  ];
  for (const c of clips) {
    if (c.id === excludeClipId) continue;
    points.push({ time: c.start, type: 'clip-start' });
    points.push({ time: c.start + overlapClipDuration(c), type: 'clip-end' });
  }
  return points;
}

/**
 * Snap a desired time to the nearest snap point within thresholdPx pixels.
 * Returns the original time if nothing within threshold.
 */
export function snapTime(
  desiredTime: number,
  points: SnapPoint[],
  thresholdPx: number,
  zoom: number,
): SnapResult {
  const thresholdSec = thresholdPx / pxPerSecond(zoom);
  let best: SnapPoint | null = null;
  let bestDist = thresholdSec;
  for (const p of points) {
    const dist = Math.abs(p.time - desiredTime);
    if (dist <= bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best ? { time: best.time, snappedTo: best } : { time: desiredTime, snappedTo: null };
}

/**
 * Snap a clip's start position considering both the clip's left edge and right
 * edge as potential anchors against snap points.
 */
export function snapClipMove(
  desiredStart: number,
  duration: number,
  points: SnapPoint[],
  thresholdPx: number,
  zoom: number,
): SnapResult {
  const startResult = snapTime(desiredStart, points, thresholdPx, zoom);
  const endResult = snapTime(desiredStart + duration, points, thresholdPx, zoom);
  if (startResult.snappedTo && endResult.snappedTo) {
    const startDist = Math.abs(startResult.time - desiredStart);
    const endDist = Math.abs(endResult.time - (desiredStart + duration));
    if (startDist <= endDist) return startResult;
    return { time: endResult.time - duration, snappedTo: endResult.snappedTo };
  }
  if (startResult.snappedTo) return startResult;
  if (endResult.snappedTo) {
    return { time: endResult.time - duration, snappedTo: endResult.snappedTo };
  }
  return { time: desiredStart, snappedTo: null };
}
