import { describe, it, expect } from 'vitest';
import { buildAtempoChain, getResolution } from './exporter';

describe('buildAtempoChain', () => {
  it('returns no filters at 1x', () => {
    expect(buildAtempoChain(1)).toEqual([]);
  });

  it('uses a single stage within the 0.5–2.0 range', () => {
    expect(buildAtempoChain(2)).toHaveLength(1);
    expect(buildAtempoChain(0.5)).toHaveLength(1);
  });

  it('chains multiple stages outside the 0.5–2.0 atempo range', () => {
    // ffmpeg's atempo only accepts 0.5–2.0, so extreme speeds must chain.
    expect(buildAtempoChain(0.25).length).toBeGreaterThanOrEqual(2); // 0.5 * 0.5
    expect(buildAtempoChain(4).length).toBeGreaterThanOrEqual(2); // 2.0 * 2.0
  });

  it('emits only factors within atempo\'s valid 0.5–2.0 range', () => {
    for (const speed of [0.1, 0.25, 0.75, 1.5, 3, 8]) {
      for (const f of buildAtempoChain(speed)) {
        const factor = Number(f.split('=')[1]);
        expect(factor).toBeGreaterThanOrEqual(0.5 - 1e-6);
        expect(factor).toBeLessThanOrEqual(2.0 + 1e-6);
      }
    }
  });

  it("the product of the chain's factors equals the requested speed", () => {
    for (const speed of [0.1, 0.25, 0.75, 1.5, 3, 8]) {
      const product = buildAtempoChain(speed)
        .map((f) => Number(f.split('=')[1]))
        .reduce((a, b) => a * b, 1);
      expect(product).toBeCloseTo(speed, 3);
    }
  });
});

describe('getResolution', () => {
  it('maps 16:9 presets', () => {
    expect(getResolution('1080p', '16:9')).toEqual({ width: 1920, height: 1080 });
    expect(getResolution('720p', '16:9')).toEqual({ width: 1280, height: 720 });
  });
  it('maps 9:16 presets (portrait)', () => {
    expect(getResolution('1080p', '9:16')).toEqual({ width: 1080, height: 1920 });
    expect(getResolution('720p', '9:16')).toEqual({ width: 720, height: 1280 });
  });
});
