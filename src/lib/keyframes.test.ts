import { describe, it, expect } from 'vitest';
import {
  applyEasing,
  isAnimated,
  sample,
  upsertKeyframe,
  removeKeyframeAt,
  type Keyframe,
} from './keyframes';

describe('applyEasing', () => {
  it('linear is identity, clamped to [0,1]', () => {
    expect(applyEasing('linear', 0)).toBe(0);
    expect(applyEasing('linear', 0.5)).toBe(0.5);
    expect(applyEasing('linear', 1)).toBe(1);
    expect(applyEasing('linear', -1)).toBe(0);
    expect(applyEasing('linear', 2)).toBe(1);
  });

  it('easeIn/easeOut are slow-start / slow-end and hit endpoints', () => {
    expect(applyEasing('easeIn', 0)).toBe(0);
    expect(applyEasing('easeIn', 1)).toBe(1);
    expect(applyEasing('easeIn', 0.5)).toBeCloseTo(0.25, 5); // p*p
    expect(applyEasing('easeOut', 0.5)).toBeCloseTo(0.75, 5);
  });

  it('easeInOut is symmetric around 0.5', () => {
    expect(applyEasing('easeInOut', 0.5)).toBeCloseTo(0.5, 5);
    expect(applyEasing('easeInOut', 0)).toBe(0);
    expect(applyEasing('easeInOut', 1)).toBe(1);
  });
});

describe('isAnimated', () => {
  it('only non-empty keyframe arrays are animated', () => {
    expect(isAnimated(undefined)).toBe(false);
    expect(isAnimated(5)).toBe(false);
    expect(isAnimated([])).toBe(false);
    expect(isAnimated([{ t: 0, value: 1 }])).toBe(true);
  });
});

describe('sample', () => {
  it('returns fallback for undefined/empty', () => {
    expect(sample(undefined, 1, 42)).toBe(42);
    expect(sample([], 1, 42)).toBe(42);
  });

  it('returns the constant for a scalar property', () => {
    expect(sample(2.5, 99, 0)).toBe(2.5);
  });

  it('clamps (holds) before first and after last keyframe', () => {
    const kfs: Keyframe[] = [
      { t: 1, value: 10 },
      { t: 3, value: 30 },
    ];
    expect(sample(kfs, 0, 0)).toBe(10);
    expect(sample(kfs, 5, 0)).toBe(30);
  });

  it('linearly interpolates between two keyframes', () => {
    const kfs: Keyframe[] = [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2, value: 100, easing: 'linear' },
    ];
    expect(sample(kfs, 1, 0)).toBeCloseTo(50, 5);
    expect(sample(kfs, 0.5, 0)).toBeCloseTo(25, 5);
  });

  it('applies per-segment easing (easeIn)', () => {
    const kfs: Keyframe[] = [
      { t: 0, value: 0, easing: 'easeIn' },
      { t: 1, value: 100 },
    ];
    // easeIn at p=0.5 -> 0.25 -> value 25
    expect(sample(kfs, 0.5, 0)).toBeCloseTo(25, 5);
  });

  it('hold easing steps (keeps start value until next keyframe)', () => {
    const kfs: Keyframe[] = [
      { t: 0, value: 10, easing: 'hold' },
      { t: 2, value: 20 },
    ];
    expect(sample(kfs, 1.9, 0)).toBe(10);
    expect(sample(kfs, 2, 0)).toBe(20);
  });

  it('handles unsorted keyframes defensively', () => {
    const kfs: Keyframe[] = [
      { t: 2, value: 20 },
      { t: 0, value: 0 },
    ];
    expect(sample(kfs, 1, 0)).toBeCloseTo(10, 5);
  });

  it('handles 3+ keyframes across segments', () => {
    const kfs: Keyframe[] = [
      { t: 0, value: 0 },
      { t: 1, value: 100 },
      { t: 2, value: 0 },
    ];
    expect(sample(kfs, 0.5, 0)).toBeCloseTo(50, 5);
    expect(sample(kfs, 1.5, 0)).toBeCloseTo(50, 5);
  });
});

describe('upsertKeyframe / removeKeyframeAt', () => {
  it('inserts keeping sorted order', () => {
    let kfs: Keyframe[] = [];
    kfs = upsertKeyframe(kfs, { t: 2, value: 20 });
    kfs = upsertKeyframe(kfs, { t: 0, value: 0 });
    kfs = upsertKeyframe(kfs, { t: 1, value: 10 });
    expect(kfs.map((k) => k.t)).toEqual([0, 1, 2]);
  });

  it('replaces an existing keyframe at the same time', () => {
    let kfs: Keyframe[] = [{ t: 1, value: 10 }];
    kfs = upsertKeyframe(kfs, { t: 1, value: 99 });
    expect(kfs).toHaveLength(1);
    expect(kfs[0].value).toBe(99);
  });

  it('removes a keyframe at a time', () => {
    const kfs: Keyframe[] = [
      { t: 0, value: 0 },
      { t: 1, value: 10 },
    ];
    expect(removeKeyframeAt(kfs, 1)).toHaveLength(1);
    expect(removeKeyframeAt(kfs, 5)).toHaveLength(2);
  });
});
