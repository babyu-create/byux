import { describe, it, expect } from 'vitest';
import {
  IDENTITY_TRANSFORM,
  buildShakeKeyframes,
  buildZoomPunchKeyframes,
  clipHasTransform,
  isTransformVisible,
  sampleClipTransform,
  transformToCss,
  transformToMatrix,
} from './clipTransform';
import { sample } from './keyframes';
import type { ClipTransform } from './types';

describe('sampleClipTransform', () => {
  it('returns identity for undefined transform', () => {
    expect(sampleClipTransform(undefined, 0)).toEqual(IDENTITY_TRANSFORM);
  });

  it('returns identity defaults for an empty transform object', () => {
    expect(sampleClipTransform({}, 1.5)).toEqual(IDENTITY_TRANSFORM);
  });

  it('resolves constant fields', () => {
    const t: ClipTransform = { x: 10, scale: 1.2, opacity: 0.5 };
    const r = sampleClipTransform(t, 0);
    expect(r.x).toBe(10);
    expect(r.scale).toBe(1.2);
    expect(r.opacity).toBe(0.5);
    // Unspecified fields keep their identity values.
    expect(r.y).toBe(0);
    expect(r.rotation).toBe(0);
  });

  it('samples animated (keyframed) fields at clip-local time', () => {
    const t: ClipTransform = {
      scale: [
        { t: 0, value: 1, easing: 'linear' },
        { t: 1, value: 1.2 },
      ],
    };
    expect(sampleClipTransform(t, 0).scale).toBeCloseTo(1, 5);
    expect(sampleClipTransform(t, 0.5).scale).toBeCloseTo(1.1, 5);
    expect(sampleClipTransform(t, 1).scale).toBeCloseTo(1.2, 5);
  });
});

describe('isTransformVisible', () => {
  it('identity is not visible', () => {
    expect(isTransformVisible(IDENTITY_TRANSFORM)).toBe(false);
  });
  it('any non-identity field is visible', () => {
    expect(isTransformVisible({ ...IDENTITY_TRANSFORM, x: 1 })).toBe(true);
    expect(isTransformVisible({ ...IDENTITY_TRANSFORM, scale: 1.01 })).toBe(true);
    expect(isTransformVisible({ ...IDENTITY_TRANSFORM, opacity: 0.99 })).toBe(true);
    expect(isTransformVisible({ ...IDENTITY_TRANSFORM, rotation: 0.5 })).toBe(true);
  });
});

describe('clipHasTransform', () => {
  it('false for undefined / empty / all-identity constants', () => {
    expect(clipHasTransform(undefined)).toBe(false);
    expect(clipHasTransform({})).toBe(false);
    expect(clipHasTransform({ x: 0, scale: 1, opacity: 1 })).toBe(false);
  });
  it('true for a non-identity constant', () => {
    expect(clipHasTransform({ scale: 1.15 })).toBe(true);
    expect(clipHasTransform({ x: 5 })).toBe(true);
  });
  it('true for an animated field even if it starts at identity', () => {
    expect(
      clipHasTransform({
        scale: [
          { t: 0, value: 1 },
          { t: 1, value: 1.15 },
        ],
      }),
    ).toBe(true);
  });
  it('false for an empty keyframe array (no keyframes)', () => {
    expect(clipHasTransform({ scale: [] })).toBe(false);
  });
});

describe('buildZoomPunchKeyframes', () => {
  it('scale eases 1.0 → 1.15 over the clip', () => {
    const { scale } = buildZoomPunchKeyframes(2);
    expect(scale).toBeDefined();
    expect(scale![0]).toEqual({ t: 0, value: 1, easing: 'easeOut' });
    expect(scale![scale!.length - 1].t).toBe(2);
    expect(scale![scale!.length - 1].value).toBe(1.15);
  });

  it('honours a custom target scale and clamps tiny durations', () => {
    const { scale } = buildZoomPunchKeyframes(0.01, 1.3);
    expect(scale![scale!.length - 1].t).toBe(0.2); // clamped to 0.2 min
    expect(scale![scale!.length - 1].value).toBe(1.3);
  });
});

describe('buildShakeKeyframes', () => {
  it('produces matched x/y keyframe arrays starting and ending at 0', () => {
    const { x, y } = buildShakeKeyframes(1, 4, 6);
    expect(x).toBeDefined();
    expect(y).toBeDefined();
    expect(x!.length).toBe(y!.length);
    // Starts at t=0, ends at the clip duration.
    expect(x![0].t).toBe(0);
    expect(x![x!.length - 1].t).toBeCloseTo(1, 5);
    // Settles to exactly 0 at the end (no residual offset).
    expect(x![x!.length - 1].value).toBe(0);
    expect(y![y!.length - 1].value).toBe(0);
  });

  it('amplitude decays over time (later peaks are smaller)', () => {
    const { x } = buildShakeKeyframes(1, 5, 6);
    // First non-zero peak magnitude should exceed a later one.
    const first = Math.abs(x![0].value);
    const later = Math.abs(x![Math.floor(x!.length / 2)].value);
    expect(first).toBeGreaterThanOrEqual(later);
  });

  it('keyframes are sampleable through the keyframe engine (bounded by amplitude)', () => {
    const { x } = buildShakeKeyframes(1, 3, 6);
    // Sampling anywhere in range stays within ±amplitude.
    for (let t = 0; t <= 1; t += 0.1) {
      const v = sample(x, t, 0);
      expect(Math.abs(v)).toBeLessThanOrEqual(3 + 1e-6);
    }
  });
});

describe('transformToCss', () => {
  it('emits identity transform string', () => {
    expect(transformToCss(IDENTITY_TRANSFORM)).toBe(
      'translate(0%, 0%) scale(1) rotate(0deg)',
    );
  });
  it('emits translate/scale/rotate in order', () => {
    const css = transformToCss({ x: 10, y: -5, scale: 1.2, rotation: 30, opacity: 1 });
    expect(css).toBe('translate(10%, -5%) scale(1.2) rotate(30deg)');
  });
});

describe('transformToMatrix', () => {
  const W = 1920;
  const H = 1080;

  it('identity → identity matrix', () => {
    const [a, b, c, d, e, f] = transformToMatrix(IDENTITY_TRANSFORM, W, H);
    // Use numeric comparison so signed-zero (c = -1*sin(0) = -0) still matches.
    expect(a).toBe(1);
    expect(b).toBe(0);
    expect(c).toBe(0);
    expect(d).toBe(1);
    expect(e).toBe(0);
    expect(f).toBe(0);
  });

  it('pure scale keeps the center fixed', () => {
    const m = transformToMatrix({ ...IDENTITY_TRANSFORM, scale: 2 }, W, H);
    const [a, b, c, d, e, f] = m;
    expect(a).toBeCloseTo(2, 5);
    expect(d).toBeCloseTo(2, 5);
    expect(b).toBeCloseTo(0, 5);
    expect(c).toBeCloseTo(0, 5);
    // center (cx,cy) maps to itself: a*cx + c*cy + e === cx
    const cx = W / 2;
    const cy = H / 2;
    expect(a * cx + c * cy + e).toBeCloseTo(cx, 4);
    expect(b * cx + d * cy + f).toBeCloseTo(cy, 4);
  });

  it('translate by x% / y% moves by that fraction of width/height', () => {
    const m = transformToMatrix({ ...IDENTITY_TRANSFORM, x: 25, y: 10 }, W, H);
    const [, , , , e, f] = m;
    expect(e).toBeCloseTo(0.25 * W, 4);
    expect(f).toBeCloseTo(0.1 * H, 4);
  });

  it('90deg rotation about center maps center to itself', () => {
    const m = transformToMatrix({ ...IDENTITY_TRANSFORM, rotation: 90 }, W, H);
    const [a, b, c, d, e, f] = m;
    const cx = W / 2;
    const cy = H / 2;
    expect(a * cx + c * cy + e).toBeCloseTo(cx, 3);
    expect(b * cx + d * cy + f).toBeCloseTo(cy, 3);
    // rotation linear part: cos90=0, sin90=1
    expect(a).toBeCloseTo(0, 5);
    expect(b).toBeCloseTo(1, 5);
    expect(c).toBeCloseTo(-1, 5);
    expect(d).toBeCloseTo(0, 5);
  });
});
