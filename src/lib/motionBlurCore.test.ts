import { describe, it, expect } from 'vitest';
import {
  STRENGTH_PEAK,
  SAMPLES_MIN,
  SAMPLES_MAX,
  HUD_PRESET_INDEX,
  shapeStrength,
  exportStrengthFromIntensity,
  motionToUniforms,
} from './motionBlurCore';

describe('shapeStrength', () => {
  it('maps 0 → 0 and 1 → peak', () => {
    expect(shapeStrength(0)).toBe(0);
    expect(shapeStrength(1)).toBeCloseTo(STRENGTH_PEAK, 6);
  });

  it('clamps out-of-range input to [0,1]', () => {
    expect(shapeStrength(-0.5)).toBe(0);
    expect(shapeStrength(2)).toBeCloseTo(STRENGTH_PEAK, 6);
  });

  it('is monotonically increasing across the range', () => {
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.1) {
      const v = shapeStrength(x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('exportStrengthFromIntensity', () => {
  it('matches the preview formula shapeStrength(i/100) * clamp(speed,0.5,2)', () => {
    expect(exportStrengthFromIntensity(0, 1)).toBe(0);
    expect(exportStrengthFromIntensity(100, 1)).toBeCloseTo(shapeStrength(1), 6);
    // speed is clamped to [0.5, 2]
    expect(exportStrengthFromIntensity(100, 4)).toBeCloseTo(shapeStrength(1) * 2, 6);
    expect(exportStrengthFromIntensity(100, 0.1)).toBeCloseTo(shapeStrength(1) * 0.5, 6);
    expect(exportStrengthFromIntensity(100, 1.5)).toBeCloseTo(shapeStrength(1) * 1.5, 6);
  });

  it('clamps intensity to [0,100]', () => {
    expect(exportStrengthFromIntensity(-10, 1)).toBe(0);
    expect(exportStrengthFromIntensity(999, 1)).toBeCloseTo(shapeStrength(1), 6);
  });
});

describe('motionToUniforms', () => {
  it('returns zero magnitude and minimum samples for no motion', () => {
    const u = motionToUniforms(0, 0, 1);
    expect(u.magnitudeUV).toBe(0);
    expect(u.sampleCount).toBe(SAMPLES_MIN);
  });

  it('scales motion by strength and caps sample count at the max', () => {
    const slow = motionToUniforms(1, 0, 0.1);
    const fast = motionToUniforms(40, 20, 1.25);
    expect(fast.magnitudeUV).toBeGreaterThan(slow.magnitudeUV);
    expect(fast.sampleCount).toBeLessThanOrEqual(SAMPLES_MAX);
    expect(fast.sampleCount).toBeGreaterThanOrEqual(SAMPLES_MIN);
    // strength 0 → no motion regardless of input
    expect(motionToUniforms(40, 20, 0).magnitudeUV).toBe(0);
  });
});

describe('HUD_PRESET_INDEX', () => {
  it('maps each preset to a distinct shader index', () => {
    expect(HUD_PRESET_INDEX.valorant).toBe(0);
    expect(HUD_PRESET_INDEX.cs2).toBe(1);
    expect(HUD_PRESET_INDEX.apex).toBe(2);
    expect(HUD_PRESET_INDEX.none).toBe(3);
  });
});
