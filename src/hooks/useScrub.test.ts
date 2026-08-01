import { describe, expect, it } from 'vitest';
import { timelineContentX } from './useScrub';

describe('timeline scrub coordinates', () => {
  it('uses the scrolled content rect without adding scrollLeft twice', () => {
    // A track scrolled 100,000px left reports rect.left=-99,800. A pointer at
    // viewport x=500 therefore targets content x=100,300 directly.
    expect(timelineContentX(500, -99_800)).toBe(100_300);
  });

  it('clamps coordinates before the timeline and invalid input to zero', () => {
    expect(timelineContentX(100, 200)).toBe(0);
    expect(timelineContentX(Number.NaN, 0)).toBe(0);
  });
});
