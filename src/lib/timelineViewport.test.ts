import { describe, expect, it } from 'vitest';
import type { Clip } from './types';
import {
  collectTimelineRenderIndices,
  findIntersectingTimelineClipIndices,
  findTimelineClipWindow,
  reconcileOrderedTrackClips,
  timelineClipsOverlap,
} from './timelineViewport';

function makeClips(count: number): Clip[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `clip-${index}`,
    trackId: 'video',
    assetId: 'asset',
    start: index,
    trimStart: 0,
    trimEnd: 1,
    effects: [],
  }));
}

describe('timeline viewport virtualization', () => {
  it('reduces a 10,000-clip track to the viewport plus keyboard pins', () => {
    const clips = makeClips(10_000);
    const window = findTimelineClipWindow(clips, 4_995.5, 5_015.5);
    const indices = collectTimelineRenderIndices(clips.length, window, [0, 9_999]);

    expect(window).toEqual({ from: 4_995, to: 5_016 });
    expect(indices).toHaveLength(23);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(9_999);
  });

  it('keeps a default-zoom 1920px viewport near 100 nodes while pinning keyboard neighbours', () => {
    const clips = makeClips(10_000);
    // 40 px/s at zoom=1: 1920px viewport + 960px overscan on each side = 96s.
    const window = findTimelineClipWindow(clips, 4_900, 4_996);
    const indices = collectTimelineRenderIndices(clips.length, window, [
      8_999,
      9_000,
      9_001,
    ]);

    expect(indices.length).toBeLessThanOrEqual(101);
    expect(indices).toEqual(expect.arrayContaining([8_999, 9_000, 9_001]));
  });

  it('keeps a clip that begins before the viewport but remains visible', () => {
    const clips = makeClips(2);
    clips[0] = { ...clips[0], trimEnd: 10 };
    clips[1] = { ...clips[1], start: 20 };
    expect(findTimelineClipWindow(clips, 5, 6)).toEqual({ from: 0, to: 1 });
  });

  it('keeps long overlapping clips from accepted legacy projects visible', () => {
    const clips = makeClips(3);
    clips[0] = { ...clips[0], trimEnd: 100 };
    clips[1] = { ...clips[1], start: 1, trimEnd: 2 };
    clips[2] = { ...clips[2], start: 60, trimEnd: 61 };

    expect(timelineClipsOverlap(clips)).toBe(true);
    const visible = findIntersectingTimelineClipIndices(clips, 50, 51);
    expect(visible).toEqual([0]);
    expect(
      collectTimelineRenderIndices(clips.length, { from: 2, to: 2 }, visible, true),
    ).toEqual([0]);
  });

  it('retains the fast non-overlap path for normal projects', () => {
    expect(timelineClipsOverlap(makeClips(10_000))).toBe(false);
  });

  it('incrementally reorders one changed clip in a 10,000-clip track', () => {
    const previous = makeClips(10_000);
    const moved = { ...previous[5_000], start: 5_002.5 };
    const current = previous.map((clip, index) => (index === 5_000 ? moved : clip));
    const started = performance.now();
    const ordered = reconcileOrderedTrackClips(current, 'video', previous);
    const elapsedMs = performance.now() - started;

    expect(ordered).toHaveLength(10_000);
    expect(ordered.indexOf(moved)).toBe(5_002);
    expect(ordered[0]).toBe(previous[0]);
    // Deliberately generous: catches accidental quadratic work without making
    // normal shared/CI machines flaky.
    expect(elapsedMs).toBeLessThan(250);
  });

  it('returns the previous array when only another track changed', () => {
    const previous = makeClips(3);
    const all = [
      ...previous,
      {
        ...previous[0],
        id: 'audio-change',
        trackId: 'audio',
        start: 2,
      },
    ];
    expect(reconcileOrderedTrackClips(all, 'video', previous)).toBe(previous);
  });
});
