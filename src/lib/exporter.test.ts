import { describe, it, expect } from 'vitest';
import {
  buildAtempoChain,
  getResolution,
  clipTransformAtOutputTime,
  colorGradeFilterAtOutputTime,
  transformFrameNeedsCanvas,
  motionBlurStrengthAtOutputTime,
  rampFootageSeekAtOutputTime,
  exportVideoDuckSegments,
  type TransformSegment,
} from './exporter';
import { exportStrengthFromIntensity } from './motionBlurCore';
import { SLOW_TO_FAST_PRESET } from './speedRamp';
import { buildDuckPoints } from './audioDucking';
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

  it('composes a boundary transition (fade-in) onto the sampled opacity', () => {
    // Segment 0..5s with a 0.4s fade-in. At output time 0 (segment start) the
    // export must bake near-zero opacity, matching the preview.
    const clip = { ...makeClip('c0'), transitionIn: { type: 'fade' as const, duration: 0.4 } };
    const segments: TransformSegment[] = [{ clip, start: 0, end: 5 }];
    expect(clipTransformAtOutputTime(segments, 0).opacity).toBeCloseTo(0, 4);
    // Past the window → fully opaque.
    expect(clipTransformAtOutputTime(segments, 0.4).opacity).toBeCloseTo(1, 4);
    // Clip body → opacity unchanged.
    expect(clipTransformAtOutputTime(segments, 2.5).opacity).toBeCloseTo(1, 4);
  });

  it('composes a transition with an existing transform (multiply / add)', () => {
    // A zoom-in transition multiplies scale on top of a constant scale=2 clip.
    const clip = {
      ...makeClip('c0', { scale: 2 }),
      transitionIn: { type: 'zoom' as const, duration: 0.4 },
    };
    const segments: TransformSegment[] = [{ clip, start: 0, end: 5 }];
    // At t=0 the zoom punch (>1) multiplies the clip's scale 2 → >2.
    expect(clipTransformAtOutputTime(segments, 0).scale).toBeGreaterThan(2);
    // Once the window ends the zoom factor is 1 → scale back to the clip's 2.
    expect(clipTransformAtOutputTime(segments, 0.4).scale).toBeCloseTo(2, 4);
  });
});

describe('colorGradeFilterAtOutputTime', () => {
  const makeClip = (id: string, colorGrade?: Clip['colorGrade']): Clip => ({
    id,
    trackId: 'track-video',
    assetId: 'a1',
    start: 0,
    trimStart: 0,
    trimEnd: 1,
    colorGrade,
    effects: [],
  });

  it("returns 'none' for an empty list / ungraded clip", () => {
    expect(colorGradeFilterAtOutputTime([], 1)).toBe('none');
    const segments: TransformSegment[] = [
      { clip: makeClip('c0'), start: 0, end: 2 },
    ];
    expect(colorGradeFilterAtOutputTime(segments, 1)).toBe('none');
  });

  it('maps the grade of the segment containing the output time', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { preset: 'mono' }), start: 0, end: 2 },
      { clip: makeClip('c1', { preset: 'vivid' }), start: 2, end: 4 },
    ];
    expect(colorGradeFilterAtOutputTime(segments, 1)).toContain('saturate(0)');
    expect(colorGradeFilterAtOutputTime(segments, 3)).toContain('saturate');
    // Different segments → different filter strings.
    expect(colorGradeFilterAtOutputTime(segments, 1)).not.toBe(
      colorGradeFilterAtOutputTime(segments, 3),
    );
  });

  it('holds the last segment past the final end (last-frame safety)', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { preset: 'mono' }), start: 0, end: 1 },
    ];
    expect(colorGradeFilterAtOutputTime(segments, 1.5)).toContain('saturate(0)');
  });
});

describe('transformFrameNeedsCanvas', () => {
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

  it('is false for an empty list (identity pass-through)', () => {
    expect(transformFrameNeedsCanvas([], 1)).toBe(false);
  });

  it('is false for a plain segment with no transform / grade', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { trimEnd: 2 }), start: 0, end: 2 },
    ];
    expect(transformFrameNeedsCanvas(segments, 0)).toBe(false);
    expect(transformFrameNeedsCanvas(segments, 1)).toBe(false);
  });

  it('is true while a visible transform applies', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { transform: { scale: 1.2 } }), start: 0, end: 2 },
    ];
    expect(transformFrameNeedsCanvas(segments, 0.5)).toBe(true);
  });

  it('is true when a color grade applies (even with identity transform)', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { colorGrade: { preset: 'mono' } }), start: 0, end: 2 },
    ];
    expect(transformFrameNeedsCanvas(segments, 0.5)).toBe(true);
  });

  it('routes only the transformed segment of a mixed timeline through the canvas', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { trimEnd: 2 }), start: 0, end: 2 },
      { clip: makeClip('c1', { transform: { scale: 1.3 } }), start: 2, end: 4 },
    ];
    // Plain first segment → pass-through; transformed second segment → canvas.
    expect(transformFrameNeedsCanvas(segments, 1)).toBe(false);
    expect(transformFrameNeedsCanvas(segments, 3)).toBe(true);
  });

  it('is true inside an animating transition window, false in the clip body', () => {
    const segments: TransformSegment[] = [
      {
        clip: makeClip('c0', {
          trimEnd: 5,
          transitionIn: { type: 'fade', duration: 0.4 },
        }),
        start: 0,
        end: 5,
      },
    ];
    // Inside the fade-in window opacity < 1 → needs the canvas.
    expect(transformFrameNeedsCanvas(segments, 0)).toBe(true);
    // Clip body, past the transition → identity pass-through.
    expect(transformFrameNeedsCanvas(segments, 2.5)).toBe(false);
  });
});

describe('motionBlurStrengthAtOutputTime', () => {
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

  it('is 0 for an empty list', () => {
    expect(motionBlurStrengthAtOutputTime([], 1)).toBe(0);
  });

  it('is 0 for a clip with no motion-blur effect (stays sharp like the preview)', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { trimEnd: 2 }), start: 0, end: 2 },
    ];
    expect(motionBlurStrengthAtOutputTime(segments, 1)).toBe(0);
  });

  it("uses the owning clip's intensity*speed when it has the effect", () => {
    const segments: TransformSegment[] = [
      {
        clip: makeClip('c0', {
          trimEnd: 2,
          speed: 1.5,
          effects: [{ type: 'motion-blur', intensity: 80 }],
        }),
        start: 0,
        end: 2,
      },
    ];
    expect(motionBlurStrengthAtOutputTime(segments, 1)).toBeCloseTo(
      exportStrengthFromIntensity(80, 1.5),
      6,
    );
  });

  it('gates per segment: blurred clip gets strength, unblurred neighbour stays 0', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { trimEnd: 2 }), start: 0, end: 2 },
      {
        clip: makeClip('c1', {
          trimEnd: 2,
          effects: [{ type: 'motion-blur', intensity: 50 }],
        }),
        start: 2,
        end: 4,
      },
    ];
    // First (no effect) → sharp; second (effect) → derived strength.
    expect(motionBlurStrengthAtOutputTime(segments, 1)).toBe(0);
    expect(motionBlurStrengthAtOutputTime(segments, 3)).toBeCloseTo(
      exportStrengthFromIntensity(50, 1),
      6,
    );
  });

  it('applies the global strength override only to clips that have the effect', () => {
    const segments: TransformSegment[] = [
      { clip: makeClip('c0', { trimEnd: 2 }), start: 0, end: 2 },
      {
        clip: makeClip('c1', {
          trimEnd: 2,
          effects: [{ type: 'motion-blur', intensity: 50 }],
        }),
        start: 2,
        end: 4,
      },
    ];
    expect(motionBlurStrengthAtOutputTime(segments, 1, 7.5)).toBe(0);
    expect(motionBlurStrengthAtOutputTime(segments, 3, 7.5)).toBe(7.5);
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

describe('exportVideoDuckSegments', () => {
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

  it('places clips back-to-back on the output timeline', () => {
    const segs = exportVideoDuckSegments([
      makeClip('c0', { trimStart: 0, trimEnd: 4, speed: 1 }),
      makeClip('c1', { trimStart: 0, trimEnd: 2, speed: 1 }),
    ]);
    expect(segs[0].start).toBe(0);
    // Second clip starts after the first clip's 4s output duration.
    expect(segs[1].start).toBeCloseTo(4, 5);
  });

  it('accounts for clip speed in the output duration (concat placement)', () => {
    const segs = exportVideoDuckSegments([
      makeClip('c0', { trimStart: 0, trimEnd: 4, speed: 2 }), // 2s output
      makeClip('c1', { trimStart: 0, trimEnd: 2, speed: 1 }),
    ]);
    expect(segs[1].start).toBeCloseTo(2, 5);
  });

  it('feeds buildDuckPoints so a kill maps to its concat output time', () => {
    const segs = exportVideoDuckSegments([
      makeClip('c0', { assetId: 'a1', trimStart: 0, trimEnd: 4, speed: 1 }),
      makeClip('c1', { assetId: 'a1', trimStart: 2, trimEnd: 6, speed: 1 }),
    ]);
    // A source kill at t=3 falls in c0 (output 3) and c1 (output 4 + (3-2) = 5).
    const points = buildDuckPoints([{ assetId: 'a1', time: 3 }], segs);
    expect(points).toEqual([3, 5]);
  });
});
