import { describe, it, expect } from 'vitest';
import {
  clamp,
  clipDuration,
  clipSourceDuration,
  timeToPx,
  pxToTime,
  resolveClipPosition,
  findFreeSlot,
} from './timeline';

describe('clipDuration (speed-aware timeline length)', () => {
  it('equals source length at 1x', () => {
    expect(clipDuration({ trimStart: 0, trimEnd: 10 })).toBe(10);
  });
  it('halves at 2x and doubles at 0.5x', () => {
    expect(clipDuration({ trimStart: 0, trimEnd: 10, speed: 2 })).toBe(5);
    expect(clipDuration({ trimStart: 0, trimEnd: 10, speed: 0.5 })).toBe(20);
  });
  it('falls back to base length for non-positive speed', () => {
    expect(clipDuration({ trimStart: 2, trimEnd: 12, speed: 0 })).toBe(10);
  });
  it('never goes negative for inverted trim', () => {
    expect(clipDuration({ trimStart: 8, trimEnd: 3 })).toBe(0);
  });
});

describe('clipSourceDuration', () => {
  it('ignores speed', () => {
    expect(clipSourceDuration({ trimStart: 1, trimEnd: 6 })).toBe(5);
    expect(clipSourceDuration({ trimStart: 6, trimEnd: 1 })).toBe(0);
  });
});

describe('clamp', () => {
  it('bounds value within [min,max]', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('timeToPx / pxToTime roundtrip', () => {
  it('round-trips at a given zoom', () => {
    for (const zoom of [0.25, 1, 4]) {
      const t = 12.5;
      expect(pxToTime(timeToPx(t, zoom), zoom)).toBeCloseTo(t, 6);
    }
  });
});

describe('resolveClipPosition (overlap avoidance)', () => {
  it('keeps a non-overlapping desired start as-is', () => {
    const others = [{ start: 0, trimStart: 0, trimEnd: 2 }]; // occupies [0,2]
    expect(resolveClipPosition(others, 5, 2, 0)).toBe(5);
  });
  it('pushes a colliding clip to a free slot edge', () => {
    const others = [{ start: 0, trimStart: 0, trimEnd: 4 }]; // occupies [0,4]
    // desired start 1 (would overlap) → nearest valid edge is 4 (after) or 0-dur(before<0)
    const resolved = resolveClipPosition(others, 1, 2, 1);
    expect(resolved).toBeGreaterThanOrEqual(0);
    // must not start inside the occupied [0,4] region such that it overlaps
    expect(resolved === 0 || resolved >= 4 - 1e-3).toBe(true);
  });
});

describe('findFreeSlot', () => {
  it('returns preferred start when the track is empty', () => {
    expect(findFreeSlot([], 3, 7)).toBe(7);
  });
  it('finds space after an occupying clip', () => {
    const others = [{ start: 0, trimStart: 0, trimEnd: 5 }]; // [0,5]
    const slot = findFreeSlot(others, 3, 0);
    expect(slot === 0 || slot >= 5 - 1e-3).toBe(true);
  });
});
