import { describe, it, expect } from 'vitest';
import {
  FAST_TO_SLOW_PRESET,
  SLOW_TO_FAST_PRESET,
  hasSpeedRamp,
  makeRampSampler,
  rampMeanVelocity,
  sourceFractionAtProgress,
  speedFactorAtProgress,
  MIN_RAMP_VELOCITY,
  type SpeedRamp,
} from './speedRamp';

describe('hasSpeedRamp', () => {
  it('false for undefined / equal endpoints / non-positive', () => {
    expect(hasSpeedRamp(undefined)).toBe(false);
    expect(hasSpeedRamp({ from: 1, to: 1 })).toBe(false);
    expect(hasSpeedRamp({ from: 0, to: 2 })).toBe(false);
    expect(hasSpeedRamp({ from: 1, to: -1 })).toBe(false);
    expect(hasSpeedRamp({ from: NaN, to: 2 })).toBe(false);
  });

  it('true for a real ramp', () => {
    expect(hasSpeedRamp(SLOW_TO_FAST_PRESET)).toBe(true);
    expect(hasSpeedRamp({ from: 0.5, to: 2 })).toBe(true);
  });
});

describe('rampMeanVelocity', () => {
  it('linear ramp mean equals (from+to)/2', () => {
    const ramp: SpeedRamp = { from: 0.5, to: 2.5, easing: 'linear' };
    expect(rampMeanVelocity(ramp)).toBeCloseTo(1.5, 3);
  });

  it('mean is always positive for valid ramps', () => {
    expect(rampMeanVelocity(SLOW_TO_FAST_PRESET)).toBeGreaterThan(0);
    expect(rampMeanVelocity(FAST_TO_SLOW_PRESET)).toBeGreaterThan(0);
  });
});

describe('speedFactorAtProgress — duration-preserving mean = 1', () => {
  it('normalised factor averages to 1 across the clip (linear)', () => {
    const ramp: SpeedRamp = { from: 0.4, to: 2.0, easing: 'linear' };
    const mean = rampMeanVelocity(ramp);
    // Average the normalised factor over many samples — must be ~1.
    const N = 200;
    let sum = 0;
    for (let i = 0; i <= N; i++) {
      sum += speedFactorAtProgress(ramp, i / N, mean);
    }
    expect(sum / (N + 1)).toBeCloseTo(1, 2);
  });

  it('normalised factor averages to 1 for the eased preset', () => {
    const mean = rampMeanVelocity(SLOW_TO_FAST_PRESET);
    const N = 400;
    let sum = 0;
    for (let i = 0; i <= N; i++) {
      sum += speedFactorAtProgress(SLOW_TO_FAST_PRESET, i / N, mean);
    }
    // Trapezoid normalisation vs midpoint average leaves a small bias; loose tol.
    expect(sum / (N + 1)).toBeCloseTo(1, 1);
  });

  it('starts slow and ends fast for a slow→fast ramp', () => {
    const mean = rampMeanVelocity(SLOW_TO_FAST_PRESET);
    const start = speedFactorAtProgress(SLOW_TO_FAST_PRESET, 0, mean);
    const end = speedFactorAtProgress(SLOW_TO_FAST_PRESET, 1, mean);
    expect(start).toBeLessThan(1);
    expect(end).toBeGreaterThan(1);
    expect(end).toBeGreaterThan(start);
  });

  it('clamps the factor to MIN_RAMP_VELOCITY', () => {
    const ramp: SpeedRamp = { from: 0.0001, to: 5, easing: 'linear' };
    const mean = rampMeanVelocity(ramp);
    expect(speedFactorAtProgress(ramp, 0, mean)).toBeGreaterThanOrEqual(MIN_RAMP_VELOCITY);
  });

  it('clamps progress outside [0,1]', () => {
    const mean = rampMeanVelocity(SLOW_TO_FAST_PRESET);
    expect(speedFactorAtProgress(SLOW_TO_FAST_PRESET, -1, mean)).toBe(
      speedFactorAtProgress(SLOW_TO_FAST_PRESET, 0, mean),
    );
    expect(speedFactorAtProgress(SLOW_TO_FAST_PRESET, 2, mean)).toBe(
      speedFactorAtProgress(SLOW_TO_FAST_PRESET, 1, mean),
    );
  });
});

describe('sourceFractionAtProgress', () => {
  it('maps endpoints exactly (0→0, 1→1)', () => {
    expect(sourceFractionAtProgress(SLOW_TO_FAST_PRESET, 0)).toBe(0);
    expect(sourceFractionAtProgress(SLOW_TO_FAST_PRESET, 1)).toBe(1);
  });

  it('is monotonically increasing', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const f = sourceFractionAtProgress(SLOW_TO_FAST_PRESET, i / 20);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('slow→fast ramp consumes < half the source at the timeline midpoint', () => {
    // Starting slow means less source is consumed by the time we reach 50%
    // of the timeline.
    const f = sourceFractionAtProgress(SLOW_TO_FAST_PRESET, 0.5);
    expect(f).toBeLessThan(0.5);
  });

  it('clamps progress outside [0,1]', () => {
    expect(sourceFractionAtProgress(SLOW_TO_FAST_PRESET, -0.5)).toBe(0);
    expect(sourceFractionAtProgress(SLOW_TO_FAST_PRESET, 1.5)).toBe(1);
  });
});

describe('makeRampSampler — preview/export parity helper', () => {
  it('source time spans the full [trimStart, trimEnd] across the timeline', () => {
    const ramp = SLOW_TO_FAST_PRESET;
    const baseSpeed = 1;
    const trimStart = 2;
    const trimEnd = 6; // 4s source, timelineDur = 4s at speed 1
    const s = makeRampSampler(ramp, baseSpeed, trimStart, trimEnd);
    expect(s.sourceTimeAtLocalTime(0)).toBeCloseTo(trimStart, 4);
    expect(s.sourceTimeAtLocalTime(4)).toBeCloseTo(trimEnd, 4);
    // Midpoint of timeline → still inside the source span, and (slow→fast)
    // below the source midpoint.
    const mid = s.sourceTimeAtLocalTime(2);
    expect(mid).toBeGreaterThan(trimStart);
    expect(mid).toBeLessThan((trimStart + trimEnd) / 2);
  });

  it('instantaneous speed factor scales with base speed', () => {
    const ramp: SpeedRamp = { from: 0.5, to: 1.5, easing: 'linear' };
    const trimStart = 0;
    const trimEnd = 4; // timelineDur = 4 / 2 = 2s at speed 2
    const s1 = makeRampSampler(ramp, 1, trimStart, trimEnd);
    const s2 = makeRampSampler(ramp, 2, trimStart, trimEnd);
    // At the same NORMALISED progress, the speed factor should be 2x.
    const f1 = s1.speedFactorAtLocalTime(4); // p = 1 at speed 1 (timelineDur 4)
    const f2 = s2.speedFactorAtLocalTime(2); // p = 1 at speed 2 (timelineDur 2)
    expect(f2 / f1).toBeCloseTo(2, 3);
  });

  it('average source rate equals base speed (duration preserved)', () => {
    // Over the whole timeline, total source consumed / timelineDur === baseSpeed.
    const ramp = SLOW_TO_FAST_PRESET;
    const baseSpeed = 1.5;
    const trimStart = 1;
    const trimEnd = 10; // 9s source, timelineDur = 6s
    const s = makeRampSampler(ramp, baseSpeed, trimStart, trimEnd);
    const timelineDur = (trimEnd - trimStart) / baseSpeed;
    const totalSource =
      s.sourceTimeAtLocalTime(timelineDur) - s.sourceTimeAtLocalTime(0);
    expect(totalSource / timelineDur).toBeCloseTo(baseSpeed, 4);
  });
});
