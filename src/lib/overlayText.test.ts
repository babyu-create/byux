import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INTRO_DURATION,
  DEFAULT_STROKE_WIDTH,
  SETTLED_POSE,
  buildOverlayFilterParts,
  buildTextShadow,
  introForClipOverlays,
  introPoseToCss,
  overlayDecoration,
  overlayIntroDuration,
  overlayStrokeWidth,
  sampleOverlayIntro,
} from './overlayText';
import type { OverlayText } from './types';

function baseOverlay(over: Partial<OverlayText> = {}): OverlayText {
  return {
    id: 'o1',
    text: 'KILL',
    fontSize: 8,
    color: '#ffffff',
    position: 'bottom-center',
    ...over,
  };
}

describe('overlayDecoration / overlayStrokeWidth / overlayIntroDuration', () => {
  it('decoration defaults to none', () => {
    expect(overlayDecoration(baseOverlay())).toBe('none');
    expect(overlayDecoration(baseOverlay({ decoration: 'glow' }))).toBe('glow');
  });

  it('stroke width defaults + clamps', () => {
    expect(overlayStrokeWidth(baseOverlay())).toBe(DEFAULT_STROKE_WIDTH);
    expect(overlayStrokeWidth(baseOverlay({ strokeWidth: 0.15 }))).toBe(0.15);
    expect(overlayStrokeWidth(baseOverlay({ strokeWidth: -1 }))).toBe(0);
    expect(overlayStrokeWidth(baseOverlay({ strokeWidth: 99 }))).toBe(0.3);
    expect(overlayStrokeWidth(baseOverlay({ strokeWidth: NaN }))).toBe(DEFAULT_STROKE_WIDTH);
  });

  it('intro duration defaults + clamps', () => {
    expect(overlayIntroDuration(baseOverlay())).toBe(DEFAULT_INTRO_DURATION);
    expect(overlayIntroDuration(baseOverlay({ introDuration: 1.2 }))).toBe(1.2);
    expect(overlayIntroDuration(baseOverlay({ introDuration: 0 }))).toBe(0.05);
    expect(overlayIntroDuration(baseOverlay({ introDuration: 999 }))).toBe(5);
  });
});

describe('buildTextShadow', () => {
  it('returns none when no outline and no decoration', () => {
    expect(buildTextShadow(baseOverlay(), 100)).toBe('none');
  });

  it('emits 8 outline offsets scaled by stroke width', () => {
    const s = buildTextShadow(baseOverlay({ outline: true, strokeWidth: 0.1 }), 100);
    // 8 directional layers, joined by ', '
    expect(s.split(', ').length).toBe(8);
    // stroke px = 0.1 * 100 = 10
    expect(s).toContain('10.00px 0.00px 0 #000000');
  });

  it('adds two glow layers in the decoration color', () => {
    const s = buildTextShadow(
      baseOverlay({ decoration: 'glow', decorationColor: '#00ffcc' }),
      100,
    );
    expect(s.split(', ').length).toBe(2);
    expect(s).toContain('#00ffcc');
  });

  it('adds a single drop-shadow layer for shadow', () => {
    const s = buildTextShadow(baseOverlay({ decoration: 'shadow' }), 100);
    expect(s.split(', ').length).toBe(1);
    expect(s).toContain('rgba(0,0,0,0.65)');
  });

  it('combines outline + glow layers', () => {
    const s = buildTextShadow(
      baseOverlay({ outline: true, decoration: 'glow' }),
      100,
    );
    expect(s.split(', ').length).toBe(10); // 8 outline + 2 glow
  });
});

describe('sampleOverlayIntro', () => {
  it('returns settled pose when no intro', () => {
    expect(sampleOverlayIntro(baseOverlay(), 0)).toEqual(SETTLED_POSE);
    expect(sampleOverlayIntro(baseOverlay({ intro: 'none' }), 0)).toEqual(SETTLED_POSE);
  });

  it('fade goes from opacity 0 → 1 over the window', () => {
    const o = baseOverlay({ intro: 'fade', introDuration: 0.4 });
    expect(sampleOverlayIntro(o, 0).opacity).toBe(0);
    expect(sampleOverlayIntro(o, 0.4).opacity).toBeCloseTo(1, 5);
    expect(sampleOverlayIntro(o, 10).opacity).toBe(1); // held after window
    const mid = sampleOverlayIntro(o, 0.2).opacity;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('slide-up starts offset down (dy>0) and settles to 0', () => {
    const o = baseOverlay({ intro: 'slide-up', introDuration: 0.4 });
    expect(sampleOverlayIntro(o, 0).dy).toBeGreaterThan(0);
    expect(sampleOverlayIntro(o, 0.4).dy).toBeCloseTo(0, 5);
    expect(sampleOverlayIntro(o, 0).dx).toBe(0);
  });

  it('slide-left starts offset right (dx>0) and settles to 0', () => {
    const o = baseOverlay({ intro: 'slide-left', introDuration: 0.4 });
    expect(sampleOverlayIntro(o, 0).dx).toBeGreaterThan(0);
    expect(sampleOverlayIntro(o, 0.4).dx).toBeCloseTo(0, 5);
  });

  it('scale-in starts below 1 and grows to 1', () => {
    const o = baseOverlay({ intro: 'scale-in', introDuration: 0.4 });
    expect(sampleOverlayIntro(o, 0).scale).toBeLessThan(1);
    expect(sampleOverlayIntro(o, 0.4).scale).toBeCloseTo(1, 5);
  });
});

describe('introPoseToCss', () => {
  it('emits translate + scale in px', () => {
    const css = introPoseToCss({ opacity: 1, dx: 0.5, dy: -0.2, scale: 0.8 }, 100);
    expect(css).toBe('translate(50.00px, -20.00px) scale(0.8000)');
  });
});

describe('introForClipOverlays', () => {
  it('null when no overlay has an intro', () => {
    expect(introForClipOverlays([baseOverlay(), baseOverlay()], 1080)).toBeNull();
  });

  it('null when overlays disagree on the intro kind', () => {
    const a = baseOverlay({ intro: 'fade' });
    const b = baseOverlay({ id: 'o2', intro: 'slide-up' });
    expect(introForClipOverlays([a, b], 1080)).toBeNull();
  });

  it('resolves a shared fade intro (no slide distance)', () => {
    const a = baseOverlay({ intro: 'fade', introDuration: 0.5 });
    const r = introForClipOverlays([a], 1080);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe('fade');
    expect(r?.duration).toBe(0.5);
    expect(r?.distancePx).toBe(0);
  });

  it('slide intro yields a positive pixel distance from font size', () => {
    const a = baseOverlay({ intro: 'slide-up', fontSize: 10 });
    const r = introForClipOverlays([a], 1080);
    expect(r?.kind).toBe('slide-up');
    // 10% of 1080 = 108px font; distance = 0.6 * 108 ≈ 65
    expect(r?.distancePx).toBeGreaterThan(0);
  });

  it('uses the longest duration among agreeing overlays', () => {
    const a = baseOverlay({ intro: 'fade', introDuration: 0.3 });
    const b = baseOverlay({ id: 'o2', intro: 'fade', introDuration: 0.8 });
    expect(introForClipOverlays([a, b], 1080)?.duration).toBe(0.8);
  });
});

describe('buildOverlayFilterParts', () => {
  it('static composite when intro is null', () => {
    const parts = buildOverlayFilterParts('[0:v]', '[1:v]', '[ovout]', 0, 1.5, 3.0, null);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe('[0:v][1:v]overlay=0:0:enable=between(t\\,1.500\\,3.000)[ovout]');
  });

  it('fade intro adds an alpha-fade stage + composite at 0:0', () => {
    const intro = { kind: 'fade' as const, duration: 0.4, distancePx: 0 };
    const parts = buildOverlayFilterParts('[0:v]', '[1:v]', '[ovout]', 0, 1.0, 4.0, intro);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('fade=t=in:st=1.000:d=0.400:alpha=1[ovf0]');
    expect(parts[1]).toBe('[0:v][ovf0]overlay=0:0:enable=between(t\\,1.000\\,4.000)[ovout]');
  });

  it('slide-up intro animates the y offset with a decaying ramp', () => {
    const intro = { kind: 'slide-up' as const, duration: 0.4, distancePx: 60 };
    const parts = buildOverlayFilterParts('[ov0]', '[2:v]', '[ovout]', 1, 1.0, 4.0, intro);
    expect(parts).toHaveLength(2);
    // Unique per-index label (index 1).
    expect(parts[0]).toContain('[ovf1]');
    // y expression uses the distance and the ramp; x stays 0.
    expect(parts[1]).toContain('overlay=0:60*max(0\\,1-(t-1.000)/0.400)');
  });

  it('slide-left intro animates the x offset', () => {
    const intro = { kind: 'slide-left' as const, duration: 0.5, distancePx: 80 };
    const parts = buildOverlayFilterParts('[0:v]', '[1:v]', '[ovout]', 0, 0.0, 2.0, intro);
    expect(parts[1]).toContain('overlay=80*max(0\\,1-(t-0.000)/0.500):0:');
  });

  it('scale-in degrades to a fade (no position offset)', () => {
    const intro = { kind: 'scale-in' as const, duration: 0.4, distancePx: 0 };
    const parts = buildOverlayFilterParts('[0:v]', '[1:v]', '[ovout]', 0, 0.0, 2.0, intro);
    expect(parts[1]).toContain('overlay=0:0:');
  });
});
