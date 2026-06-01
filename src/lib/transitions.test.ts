import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  NEUTRAL_MODULATION,
  TRANSITION_TYPES,
  clipHasTransition,
  transitionIsActive,
  transitionModulationAt,
  type ClipTransition,
} from './transitions';

const fade = (duration: number): ClipTransition => ({ type: 'fade', duration });
const slide = (duration: number): ClipTransition => ({ type: 'slide', duration });
const zoom = (duration: number): ClipTransition => ({ type: 'zoom', duration });

describe('transitionIsActive', () => {
  it('is false for undefined / none / cut', () => {
    expect(transitionIsActive(undefined)).toBe(false);
    expect(transitionIsActive({ type: 'none', duration: 0.4 })).toBe(false);
    expect(transitionIsActive({ type: 'cut', duration: 0.4 })).toBe(false);
  });
  it('is true for animating presets', () => {
    expect(transitionIsActive(fade(0.4))).toBe(true);
    expect(transitionIsActive(slide(0.4))).toBe(true);
    expect(transitionIsActive(zoom(0.4))).toBe(true);
  });
});

describe('clipHasTransition', () => {
  it('is false when neither boundary animates', () => {
    expect(clipHasTransition(undefined, undefined)).toBe(false);
    expect(clipHasTransition({ type: 'cut', duration: 0.4 }, undefined)).toBe(false);
  });
  it('is true when either boundary animates', () => {
    expect(clipHasTransition(fade(0.4), undefined)).toBe(true);
    expect(clipHasTransition(undefined, slide(0.4))).toBe(true);
  });
});

describe('transitionModulationAt — neutral cases', () => {
  it('returns neutral with no transitions', () => {
    expect(transitionModulationAt(undefined, undefined, 1, 5)).toEqual(NEUTRAL_MODULATION);
  });
  it('returns neutral for zero/negative clip duration', () => {
    expect(transitionModulationAt(fade(0.4), undefined, 0, 0)).toEqual(NEUTRAL_MODULATION);
  });
  it('returns neutral in the clip body (outside both windows)', () => {
    const m = transitionModulationAt(fade(0.4), fade(0.4), 2.5, 5);
    expect(m).toEqual(NEUTRAL_MODULATION);
  });
});

describe('fade in — opacity timing', () => {
  const dur = 5;
  const inT = fade(0.4);

  it('opacity is ~0 at the very start', () => {
    const m = transitionModulationAt(inT, undefined, 0, dur);
    expect(m.opacity).toBeCloseTo(0, 4);
  });

  it('opacity is 1 once past the window', () => {
    const m = transitionModulationAt(inT, undefined, 0.4, dur);
    expect(m.opacity).toBeCloseTo(1, 4);
  });

  it('opacity is between 0 and 1 mid-window and monotonically rising', () => {
    const early = transitionModulationAt(inT, undefined, 0.1, dur).opacity;
    const mid = transitionModulationAt(inT, undefined, 0.2, dur).opacity;
    const late = transitionModulationAt(inT, undefined, 0.3, dur).opacity;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(mid);
    expect(mid).toBeLessThan(late);
    expect(late).toBeLessThan(1);
  });

  it('fade does not touch scale / translate', () => {
    const m = transitionModulationAt(inT, undefined, 0.1, dur);
    expect(m.scale).toBe(1);
    expect(m.dx).toBe(0);
    expect(m.dy).toBe(0);
  });
});

describe('fade out — opacity timing', () => {
  const dur = 5;
  const outT = fade(0.4);

  it('opacity is 1 at the window start (outStart = dur - d)', () => {
    const m = transitionModulationAt(undefined, outT, dur - 0.4, dur);
    expect(m.opacity).toBeCloseTo(1, 4);
  });

  it('opacity falls toward 0 at the clip end', () => {
    const nearEnd = transitionModulationAt(undefined, outT, dur - 0.02, dur).opacity;
    expect(nearEnd).toBeGreaterThanOrEqual(0);
    expect(nearEnd).toBeLessThan(0.5);
  });

  it('opacity decreases across the out window', () => {
    const a = transitionModulationAt(undefined, outT, dur - 0.3, dur).opacity;
    const b = transitionModulationAt(undefined, outT, dur - 0.2, dur).opacity;
    const c = transitionModulationAt(undefined, outT, dur - 0.1, dur).opacity;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
});

describe('slide / zoom presets', () => {
  it('slide in starts offset and eases to 0, fading in', () => {
    const start = transitionModulationAt(slide(0.4), undefined, 0, 5);
    expect(Math.abs(start.dx)).toBeGreaterThan(0);
    expect(start.opacity).toBeCloseTo(0, 4);
    const end = transitionModulationAt(slide(0.4), undefined, 0.4, 5);
    expect(end.dx).toBeCloseTo(0, 4);
    expect(end.opacity).toBeCloseTo(1, 4);
  });

  it('zoom in starts scaled up (>1) and eases to 1', () => {
    const start = transitionModulationAt(zoom(0.4), undefined, 0, 5);
    expect(start.scale).toBeGreaterThan(1);
    const end = transitionModulationAt(zoom(0.4), undefined, 0.4, 5);
    expect(end.scale).toBeCloseTo(1, 4);
  });

  it('zoom out punches up (>1) toward the end', () => {
    const start = transitionModulationAt(undefined, zoom(0.4), 5 - 0.4, 5);
    expect(start.scale).toBeCloseTo(1, 4);
    const nearEnd = transitionModulationAt(undefined, zoom(0.4), 5 - 0.02, 5);
    expect(nearEnd.scale).toBeGreaterThan(1);
  });
});

describe('window clamping', () => {
  it('clamps each window to half the clip so in + out never overlap', () => {
    // clip duration 0.4 → half = 0.2 each; requesting 1s windows would overlap
    // without clamping. At the exact midpoint both are clamped to touch, not
    // overlap, so opacity stays a valid product in [0,1].
    const dur = 0.4;
    const m = transitionModulationAt(fade(1), fade(1), 0.2, dur);
    expect(m.opacity).toBeGreaterThanOrEqual(0);
    expect(m.opacity).toBeLessThanOrEqual(1);
  });

  it('treats a non-finite duration as the default window', () => {
    const m = transitionModulationAt(fade(NaN), undefined, DEFAULT_TRANSITION_DURATION, 5);
    // At t == default window end, fade-in should be complete (opacity 1).
    expect(m.opacity).toBeCloseTo(1, 4);
  });

  it('never produces a window shorter than the minimum', () => {
    // Tiny requested duration is floored to MIN; sampling just inside it still
    // yields a partial (not full) opacity.
    const m = transitionModulationAt(fade(0.001), undefined, MIN_TRANSITION_DURATION / 2, 5);
    expect(m.opacity).toBeGreaterThan(0);
    expect(m.opacity).toBeLessThan(1);
  });
});

describe('opacity stays clamped to [0,1] when both ends overlap-multiply', () => {
  it('product of two fades never exceeds 1 or drops below 0', () => {
    for (const t of [0, 0.05, 0.1, 0.15, 0.2]) {
      const m = transitionModulationAt(fade(0.2), fade(0.2), t, 0.4);
      expect(m.opacity).toBeGreaterThanOrEqual(0);
      expect(m.opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe('TRANSITION_TYPES list', () => {
  it('exposes the pickable presets (cut + 3 animating)', () => {
    expect(TRANSITION_TYPES).toEqual(['cut', 'fade', 'slide', 'zoom']);
  });
});
