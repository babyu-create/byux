import { clipDuration } from './timeline';

export interface TimelineViewportClip {
  id: string;
  trackId: string;
  start: number;
  trimStart: number;
  trimEnd: number;
  speed?: number;
}

export interface TimelineClipWindow {
  /** Inclusive index in the timeline-ordered clip array. */
  from: number;
  /** Exclusive index in the timeline-ordered clip array. */
  to: number;
}

function compareTimelineClips(
  first: TimelineViewportClip,
  second: TimelineViewportClip,
): number {
  return first.start - second.start || first.id.localeCompare(second.id);
}

/**
 * Keep a track timeline-ordered without sorting all 10,000 clips on every
 * pointer frame. Zustand edits preserve references for untouched clips, so a
 * normal one/few-clip drag can remove and binary-reinsert only those objects.
 */
export function reconcileOrderedTrackClips<T extends TimelineViewportClip>(
  allClips: readonly T[],
  trackId: string,
  previous: readonly T[],
): T[] {
  const current = allClips.filter((clip) => clip.trackId === trackId);
  if (current.length === 0) return [];
  if (previous.length !== current.length) {
    return current.sort(compareTimelineClips);
  }

  const previousById = new Map(previous.map((clip) => [clip.id, clip]));
  const changed: T[] = [];
  for (const clip of current) {
    const oldClip = previousById.get(clip.id);
    if (!oldClip) return current.sort(compareTimelineClips);
    if (oldClip !== clip) changed.push(clip);
  }
  if (changed.length === 0) return previous as T[];
  // A large batch edit is faster and simpler as one native sort. The common
  // interactive path changes one clip (or a small linked selection).
  if (changed.length > 8) return current.sort(compareTimelineClips);

  const changedIds = new Set(changed.map((clip) => clip.id));
  const ordered = previous.filter((clip) => !changedIds.has(clip.id)) as T[];
  changed.sort(compareTimelineClips);
  for (const clip of changed) {
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareTimelineClips(ordered[middle], clip) <= 0) low = middle + 1;
      else high = middle;
    }
    ordered.splice(low, 0, clip);
  }
  return ordered;
}

/** Locate clips intersecting a time viewport in O(log n + visible clips). */
export function findTimelineClipWindow(
  orderedClips: readonly TimelineViewportClip[],
  firstTime: number,
  secondTime: number,
): TimelineClipWindow {
  if (orderedClips.length === 0) return { from: 0, to: 0 };
  const start = Math.max(0, Math.min(firstTime, secondTime));
  const end = Math.max(start, Math.max(firstTime, secondTime));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { from: 0, to: 0 };

  let low = 0;
  let high = orderedClips.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (orderedClips[middle].start < start) low = middle + 1;
    else high = middle;
  }
  let from = low;
  // Tracks are non-overlapping by store invariant, so this loop normally
  // inspects at most the clip crossing the viewport's left boundary.
  while (
    from > 0 &&
    orderedClips[from - 1].start + clipDuration(orderedClips[from - 1]) >= start - 1e-6
  ) {
    from -= 1;
  }

  low = from;
  high = orderedClips.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (orderedClips[middle].start <= end + 1e-6) low = middle + 1;
    else high = middle;
  }
  return { from, to: low };
}

/**
 * Current edit commands prevent track overlap, but accepted legacy or
 * hand-edited project files may still contain it. Detect that exceptional
 * shape once per clip-array change so normal tracks keep the fast lookup.
 */
export function timelineClipsOverlap(
  orderedClips: readonly TimelineViewportClip[],
): boolean {
  let previousEnd = -Infinity;
  for (const clip of orderedClips) {
    if (clip.start < previousEnd - 1e-6) return true;
    previousEnd = Math.max(previousEnd, clip.start + clipDuration(clip));
  }
  return false;
}

/** Exact fallback for accepted legacy/hand-edited projects with overlaps. */
export function findIntersectingTimelineClipIndices(
  orderedClips: readonly TimelineViewportClip[],
  firstTime: number,
  secondTime: number,
): number[] {
  const start = Math.max(0, Math.min(firstTime, secondTime));
  const end = Math.max(start, Math.max(firstTime, secondTime));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const indices: number[] = [];
  for (let index = 0; index < orderedClips.length; index += 1) {
    const clip = orderedClips[index];
    if (clip.start > end + 1e-6) break;
    if (clip.start + clipDuration(clip) >= start - 1e-6) indices.push(index);
  }
  return indices;
}

/** Visible indices plus a small set pinned for roving-tab keyboard navigation. */
export function collectTimelineRenderIndices(
  clipCount: number,
  window: TimelineClipWindow,
  pinnedIndices: readonly number[] = [],
  pinsOnly = false,
): number[] {
  const indices = new Set<number>();
  const from = Math.max(0, Math.min(clipCount, window.from));
  const to = Math.max(from, Math.min(clipCount, window.to));
  if (!pinsOnly) {
    for (let index = from; index < to; index += 1) indices.add(index);
  }
  for (const index of pinnedIndices) {
    if (Number.isInteger(index) && index >= 0 && index < clipCount) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}
