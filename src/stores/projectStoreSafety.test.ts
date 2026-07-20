import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHistory, useProjectStore } from './projectStore';
import { useMediaStore } from './mediaStore';
import type { MediaAsset, Track } from '../lib/types';

const TRACKS: Track[] = [
  { id: 'video', kind: 'video', label: 'Video', locked: false, muted: false, hidden: false },
  { id: 'audio', kind: 'audio', label: 'Audio', locked: false, muted: false, hidden: false },
];

const ASSET: MediaAsset = {
  id: 'asset',
  name: 'clip.mp4',
  kind: 'video',
  url: 'blob:test',
  size: 100,
  mimeType: 'video/mp4',
  duration: 10,
};

describe('project store safety invariants', () => {
  beforeEach(() => {
    clearHistory();
    useMediaStore.setState({ assets: [ASSET], selectedAssetId: ASSET.id });
    useProjectStore.setState({
      name: 'test',
      tracks: TRACKS,
      clips: [],
      markers: [],
      ioRanges: [],
      selectedClipIds: [],
      preRollSec: 3,
      postRollSec: 1,
    });
    clearHistory();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clamps auto clips at the source duration', () => {
    useProjectStore.setState({
      markers: [{ id: 'marker', assetId: ASSET.id, time: 9.8 }],
    });
    const count = useProjectStore.getState().autoClipFromMarkers(ASSET.id, {
      preRoll: 3,
      postRoll: 1,
      deleteSourceClips: false,
    });
    expect(count).toBe(1);
    const created = useProjectStore.getState().clips[0];
    expect(created.trimStart).toBeCloseTo(6.8);
    expect(created.trimEnd).toBe(10);
  });

  it('never replaces clips through auto-cut while the video track is locked', () => {
    useProjectStore.setState({
      tracks: [{ ...TRACKS[0], locked: true }],
      markers: [{ id: 'marker', assetId: ASSET.id, time: 5 }],
      ioRanges: [{ id: 'range', assetId: ASSET.id, inTime: 2, outTime: 4 }],
    });
    expect(
      useProjectStore.getState().autoClipFromMarkers(ASSET.id, {
        preRoll: 1,
        postRoll: 1,
        deleteSourceClips: true,
      }),
    ).toBe(0);
    expect(
      useProjectStore.getState().cutFromRanges(ASSET.id, {
        deleteSourceClips: true,
      }),
    ).toBe(0);
    expect(useProjectStore.getState().clips).toHaveLength(0);
  });

  it('never adds a media asset to a locked or unknown track', () => {
    useProjectStore.setState({
      tracks: [{ ...TRACKS[0], locked: true }, TRACKS[1]],
    });
    expect(
      useProjectStore
        .getState()
        .addClipFromAsset(ASSET.id, TRACKS[0].id, ASSET.duration),
    ).toBeNull();
    expect(
      useProjectStore
        .getState()
        .addClipFromAsset(ASSET.id, 'missing-track', ASSET.duration),
    ).toBeNull();
    expect(useProjectStore.getState().clips).toHaveLength(0);
  });

  it('never adds an unknown asset or a video asset to an audio track', () => {
    expect(
      useProjectStore
        .getState()
        .addClipFromAsset('missing-asset', TRACKS[0].id, ASSET.duration),
    ).toBeNull();
    expect(
      useProjectStore
        .getState()
        .addClipFromAsset(ASSET.id, TRACKS[1].id, ASSET.duration),
    ).toBeNull();
    expect(useProjectStore.getState().clips).toHaveLength(0);
  });

  it('keeps source clips when marker settings create no valid clips', () => {
    const sourceClip = {
      id: 'source',
      trackId: 'video',
      assetId: ASSET.id,
      start: 0,
      trimStart: 0,
      trimEnd: 10,
      effects: [],
    };
    useProjectStore.setState({
      clips: [sourceClip],
      markers: [{ id: 'marker', assetId: ASSET.id, time: 5 }],
    });

    expect(
      useProjectStore.getState().autoClipFromMarkers(ASSET.id, {
        preRoll: 0,
        postRoll: 0,
        deleteSourceClips: true,
      }),
    ).toBe(0);
    expect(useProjectStore.getState().clips).toEqual([sourceClip]);
  });

  it('keeps source clips and ranges when every range is too short', () => {
    const sourceClip = {
      id: 'source',
      trackId: 'video',
      assetId: ASSET.id,
      start: 0,
      trimStart: 0,
      trimEnd: 10,
      effects: [],
    };
    const shortRange = {
      id: 'range',
      assetId: ASSET.id,
      inTime: 1,
      outTime: 1.01,
    };
    useProjectStore.setState({ clips: [sourceClip], ioRanges: [shortRange] });

    expect(
      useProjectStore.getState().cutFromRanges(ASSET.id, {
        deleteSourceClips: true,
      }),
    ).toBe(0);
    expect(useProjectStore.getState().clips).toEqual([sourceClip]);
    expect(useProjectStore.getState().ioRanges).toEqual([shortRange]);
  });

  it('ripples later clips when speed changes so the track cannot overlap', () => {
    useProjectStore.setState({
      clips: [
        {
          id: 'first',
          trackId: 'video',
          assetId: ASSET.id,
          start: 0,
          trimStart: 0,
          trimEnd: 5,
          effects: [],
        },
        {
          id: 'second',
          trackId: 'video',
          assetId: ASSET.id,
          start: 5,
          trimStart: 5,
          trimEnd: 10,
          effects: [],
        },
      ],
    });
    useProjectStore.getState().setClipSpeed('first', 0.5);
    const [first, second] = useProjectStore.getState().clips;
    expect(first.speed).toBe(0.5);
    expect(second.start).toBe(10);
  });

  it('cancels a pending debounced history write when history is cleared', () => {
    vi.useFakeTimers();
    useProjectStore.setState({ name: 'old-project-edit' });
    clearHistory();
    vi.advanceTimersByTime(200);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
  });
});
