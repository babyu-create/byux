import type { Clip } from './types';
import { clipDuration } from './timeline';

const EPSILON = 1e-6;
let clipboard: Clip[] = [];

function cloneClips(clips: Clip[]): Clip[] {
  return structuredClone(clips);
}

export function writeClipClipboard(clips: Clip[]): number {
  clipboard = cloneClips(
    [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)),
  );
  return clipboard.length;
}

export function readClipClipboard(): Clip[] {
  return cloneClips(clipboard);
}

export function clearClipClipboard(): void {
  clipboard = [];
}

/**
 * Place a copied multi-track group at or after a requested time while keeping
 * every internal offset intact and avoiding existing clips on each track.
 */
export function placeClipCopies(
  sourceClips: Clip[],
  existingClips: Clip[],
  requestedStart: number,
): Clip[] {
  if (sourceClips.length === 0) return [];
  const origin = Math.min(...sourceClips.map((clip) => clip.start));
  const templates = cloneClips(sourceClips).map((clip) => ({
    clip,
    relativeStart: clip.start - origin,
    duration: clipDuration(clip),
  }));
  let base = Number.isFinite(requestedStart) ? Math.max(0, requestedStart) : 0;
  const maxPasses = existingClips.length + templates.length + 1;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let requiredBase = base;
    for (const template of templates) {
      const start = base + template.relativeStart;
      const end = start + template.duration;
      for (const existing of existingClips) {
        if (existing.trackId !== template.clip.trackId) continue;
        const existingEnd = existing.start + clipDuration(existing);
        const overlaps =
          start < existingEnd - EPSILON && end > existing.start + EPSILON;
        if (overlaps) {
          requiredBase = Math.max(
            requiredBase,
            existingEnd - template.relativeStart,
          );
        }
      }
    }
    if (requiredBase <= base + EPSILON) break;
    base = requiredBase;
  }

  return templates.map(({ clip, relativeStart }) => ({
    ...clip,
    start: base + relativeStart,
  }));
}
