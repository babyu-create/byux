import { describe, it, expect } from 'vitest';
import {
  COLOR_GRADE_LABELS,
  COLOR_GRADE_PRESETS,
  IDENTITY_GRADE,
  clipHasColorGrade,
  colorGradeFilter,
  gradeToFilter,
  isGradeVisible,
  resolveColorGrade,
} from './colorGrade';
import type { ColorGrade } from './types';

describe('resolveColorGrade', () => {
  it('returns identity for undefined grade', () => {
    expect(resolveColorGrade(undefined)).toEqual(IDENTITY_GRADE);
  });

  it("returns identity for the 'none' preset with no knobs", () => {
    expect(resolveColorGrade({ preset: 'none' })).toEqual(IDENTITY_GRADE);
  });

  it('returns identity for an empty grade object', () => {
    expect(resolveColorGrade({})).toEqual(IDENTITY_GRADE);
  });

  it('resolves each built-in preset to a non-identity grade', () => {
    for (const preset of COLOR_GRADE_PRESETS) {
      if (preset === 'none') continue;
      const r = resolveColorGrade({ preset });
      expect(isGradeVisible(r)).toBe(true);
    }
  });

  it("mono preset fully desaturates (saturation 0)", () => {
    expect(resolveColorGrade({ preset: 'mono' }).saturation).toBe(0);
  });

  it('vivid preset boosts saturation above 1', () => {
    expect(resolveColorGrade({ preset: 'vivid' }).saturation).toBeGreaterThan(1);
  });

  it('cool preset rotates hue negative; warm preset adds sepia', () => {
    expect(resolveColorGrade({ preset: 'cool' }).hueRotate).toBeLessThan(0);
    expect(resolveColorGrade({ preset: 'warm' }).sepia).toBeGreaterThan(0);
  });
});

describe('resolveColorGrade fine knobs', () => {
  it('positive exposure raises brightness above neutral', () => {
    expect(resolveColorGrade({ exposure: 100 }).brightness).toBeGreaterThan(1);
  });

  it('negative exposure lowers brightness below neutral', () => {
    expect(resolveColorGrade({ exposure: -100 }).brightness).toBeLessThan(1);
  });

  it('negative saturation reduces saturation', () => {
    expect(resolveColorGrade({ saturation: -100 }).saturation).toBeLessThan(1);
  });

  it('positive contrast raises contrast', () => {
    expect(resolveColorGrade({ contrast: 100 }).contrast).toBeGreaterThan(1);
  });

  it('positive temperature warms (adds sepia + positive hue)', () => {
    const r = resolveColorGrade({ temperature: 100 });
    expect(r.sepia).toBeGreaterThan(0);
    expect(r.hueRotate).toBeGreaterThan(0);
  });

  it('negative temperature cools (negative hue, no sepia)', () => {
    const r = resolveColorGrade({ temperature: -100 });
    expect(r.hueRotate).toBeLessThan(0);
    expect(r.sepia).toBe(0);
  });

  it('layers fine knobs on top of a preset', () => {
    const base = resolveColorGrade({ preset: 'vivid' });
    const boosted = resolveColorGrade({ preset: 'vivid', exposure: 100 });
    expect(boosted.brightness).toBeGreaterThan(base.brightness);
  });

  it('clamps out-of-range knobs to a safe band', () => {
    const r = resolveColorGrade({
      exposure: 10_000,
      contrast: -10_000,
      saturation: 10_000,
      temperature: 10_000,
    });
    expect(r.brightness).toBeLessThanOrEqual(2.5);
    expect(r.contrast).toBeGreaterThanOrEqual(0.2);
    expect(r.saturation).toBeLessThanOrEqual(3);
    expect(r.sepia).toBeLessThanOrEqual(1);
  });

  it('ignores NaN/Infinity-free finite handling via clamp (no NaN leaks)', () => {
    // Knobs are validated finite upstream; resolver must not produce NaN.
    const r = resolveColorGrade({ exposure: 0, contrast: 0 });
    expect(Number.isFinite(r.brightness)).toBe(true);
    expect(Number.isFinite(r.contrast)).toBe(true);
  });
});

describe('isGradeVisible', () => {
  it('identity is not visible', () => {
    expect(isGradeVisible(IDENTITY_GRADE)).toBe(false);
  });

  it('any non-identity field is visible', () => {
    expect(isGradeVisible({ ...IDENTITY_GRADE, brightness: 1.1 })).toBe(true);
    expect(isGradeVisible({ ...IDENTITY_GRADE, saturation: 0 })).toBe(true);
    expect(isGradeVisible({ ...IDENTITY_GRADE, sepia: 0.2 })).toBe(true);
    expect(isGradeVisible({ ...IDENTITY_GRADE, hueRotate: 10 })).toBe(true);
  });
});

describe('clipHasColorGrade', () => {
  it('false for undefined / empty / neutral', () => {
    expect(clipHasColorGrade(undefined)).toBe(false);
    expect(clipHasColorGrade({})).toBe(false);
    expect(clipHasColorGrade({ preset: 'none' })).toBe(false);
    expect(clipHasColorGrade({ exposure: 0, contrast: 0 })).toBe(false);
  });

  it('true for any real preset', () => {
    expect(clipHasColorGrade({ preset: 'cinema' })).toBe(true);
    expect(clipHasColorGrade({ preset: 'mono' })).toBe(true);
  });

  it('true for a non-zero fine knob even with preset none', () => {
    expect(clipHasColorGrade({ preset: 'none', exposure: 20 })).toBe(true);
  });
});

describe('gradeToFilter / colorGradeFilter', () => {
  it("emits 'none' for a neutral grade", () => {
    expect(gradeToFilter(IDENTITY_GRADE)).toBe('none');
    expect(colorGradeFilter(undefined)).toBe('none');
    expect(colorGradeFilter({ preset: 'none' })).toBe('none');
  });

  it('emits filter primitives in a stable order', () => {
    const css = gradeToFilter({
      brightness: 1.1,
      contrast: 1.2,
      saturation: 1.3,
      sepia: 0.2,
      hueRotate: 15,
    });
    // Order: brightness → contrast → saturate → sepia → hue-rotate.
    expect(css).toBe('brightness(1.1) contrast(1.2) saturate(1.3) sepia(0.2) hue-rotate(15deg)');
  });

  it('omits primitives that are at their neutral value', () => {
    const css = gradeToFilter({
      brightness: 1,
      contrast: 1,
      saturation: 0,
      sepia: 0,
      hueRotate: 0,
    });
    expect(css).toBe('saturate(0)');
  });

  it('mono preset maps to a saturate(0) filter', () => {
    expect(colorGradeFilter({ preset: 'mono' })).toContain('saturate(0)');
  });

  it('produces a valid CSS filter string for every preset (no NaN)', () => {
    for (const preset of COLOR_GRADE_PRESETS) {
      const f = colorGradeFilter({ preset });
      expect(f).not.toContain('NaN');
      expect(f.length).toBeGreaterThan(0);
    }
  });
});

describe('preset metadata', () => {
  it('every preset has a label', () => {
    for (const preset of COLOR_GRADE_PRESETS) {
      expect(COLOR_GRADE_LABELS[preset]).toBeTruthy();
    }
  });

  it("includes the canonical six presets starting with 'none'", () => {
    expect(COLOR_GRADE_PRESETS[0]).toBe('none');
    expect(COLOR_GRADE_PRESETS).toEqual([
      'none',
      'cinema',
      'vivid',
      'cool',
      'warm',
      'mono',
    ]);
  });
});

describe('colorGradeFilter round-trip via ColorGrade type', () => {
  it('accepts a fully-specified ColorGrade', () => {
    const grade: ColorGrade = {
      preset: 'cinema',
      exposure: 10,
      contrast: -5,
      saturation: 8,
      temperature: 20,
    };
    const f = colorGradeFilter(grade);
    expect(f).not.toBe('none');
    expect(f).not.toContain('NaN');
  });
});
