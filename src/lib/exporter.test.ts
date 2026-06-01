import { describe, it, expect } from 'vitest';
import {
  buildAtempoChain,
  getResolution,
  clipTransformAtOutputTime,
  rampFootageSeekAtOutputTime,
  type TransformSegment,
} from './exporter';
import { SLOW_TO_FAST_PRESET } from './speedRamp';
import type { Clip } from './types';

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

describe('clipTransformAtOutputTime', () => {
  // Minimal clip factory — only the fields the helper reads matter.
  const makeClip = (id: string, transform?: Clip['transform']): Clip => ({
    id,
    trackId: 'track-video',
    assetId: 'a1',
    start: 0,
    trimStart: 0,
    trimEnd: 1,
    transform,
    effects: [],
  });

  it('returns identity outside any segment / empty list', () => {
    expect(clipTransformAtOutputTime([], 1).scale).toBe(1);
  });

  it('samples the segment containing the output time, clip-local', () => {
    const segments: TransformSegment[] = [
      {
        clip: makeClip('c0', {
          scale: [
            { t: 0, value: 1, easing: 'linear' },
            { t: 2, value: 1.2 },
          ],
        }),
        start: 0,
        end: 2,
      },
      {
        clip: makeClip('c1', { x: 30 }),
        start: 2,
        end: 4,
      },
    ];
    // First segment, halfway → scale 1.1.
    expect(clipTransformAtOutputTime(segments, 1).scale).toBeCloseTo(1.1, 5);
    // Second segment: time becomes (tOut - start) = 0.5 of a constant x=30.
    const r = clipTransformAtOutputTime(segments, 2.5);
    expect(r.x).toBe(30);
    expect(r.scale).toBe(1);
  });

  it('holds the last segment past the final end (last-frame safety)', () => {
    const segments: TransformSegment[] = [
      {
        clip: makeClip('c0', { scale: [{ t: 0, value: 1 }, { t: 1, value: 2 }] }),
        start: 0,
        end: 1,
      },
    ];
    // tOut slightly past the end → held at last keyframe value.
    expect(clipTransformAtOutputTime(segments, 1.5).scale).toBeCloseTo(2, 5);
  });
});

describe('rampFootageSeekAtOutputTime', () => {
  const makeClip = (id: string, extra: Partial<Clip>): Clip => ({
    id,
    trackId: 'track-video',
    assetId: 'a1',
    start: 0,
    trimStart: 0,
    trimEnd: 1,
    effects: [],
    ...extra,
  });

  it('maps identity for non-ramped segments', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { trimStart: 0, trimEnd: 2 }), start: 0, end: 2 },
    ];
    expect(rampFootageSeekAtOutputTime(segments, 0)).toBeCloseTo(0, 5);
    expect(rampFootageSeekAtOutputTime(segments, 1)).toBeCloseTo(1, 5);
    expect(rampFootageSeekAtOutputTime(segments, 1.9)).toBeCloseTo(1.9, 5);
  });

  it('maps endpoints to the segment footage window for a ramp', () => {
    // 2s source @ speed 1 → footage segment [0,2]. The ramp re-times WHICH
    // footage frame is shown but endpoints still map to the window edges.
    const segments: TransformSegment[] = [
      {
        clip: makeClip('c0', {
          trimStart: 0,
          trimEnd: 2,
          speed: 1,
          speedRamp: SLOW_TO_FAST_PRESET,
        }),
        start: 0,
        end: 2,
      },
    ];
    expect(rampFootageSeekAtOutputTime(segments, 0)).toBeCloseTo(0, 4);
    // Near the end, the seek approaches the footage window end.
    expect(rampFootageSeekAtOutputTime(segments, 2)).toBeCloseTo(2, 2);
  });

  it('slow→fast shows an earlier footage frame at the midpoint', () => {
    const segments: TransformSegment[] = [
      {
        clip: makeClip('c0', {
          trimStart: 0,
          trimEnd: 2,
          speed: 1,
          speedRamp: SLOW_TO_FAST_PRESET,
        }),
        start: 0,
        end: 2,
      },
    ];
    // At output midpoint (t=1), a slow-start ramp has consumed less than half
    // the footage → seek time < 1.
    expect(rampFootageSeekAtOutputTime(segments, 1)).toBeLessThan(1);
  });

  it('offsets the seek into a later segment by its footage start', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { trimStart: 0, trimEnd: 2 }), start: 0, end: 2 },
      {
        clip: makeClip('c1', {
          trimStart: 0,
          trimEnd: 2,
          speed: 1,
          speedRamp: SLOW_TO_FAST_PRESET,
        }),
        start: 2,
        end: 4,
      },
    ];
    // Start of the ramped second segment maps to its footage start (=2).
    expect(rampFootageSeekAtOutputTime(segments, 2)).toBeCloseTo(2, 3);
  });
});
