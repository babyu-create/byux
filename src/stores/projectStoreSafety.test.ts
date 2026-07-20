import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHistory, useProjectStore } from './projectStore';
import { useMediaStore } from './mediaStore';
import type { MediaAsset, Track } from '../lib/types';
import { clearClipClipboard } from '../lib/clipClipboard';

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
    clearClipClipboard();
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

  it('adds, renames and reorders tracks without changing existing clips', () => {
    const id = useProjectStore.getState().addTrack('overlay');
    expect(id).toBeTruthy();
    expect(useProjectStore.getState().tracks.map((track) => track.kind)).toEqual([
      'video',
      'overlay',
      'audio',
    ]);
    expect(useProjectStore.getState().renameTrack(id!, '  キル演出  ')).toBe(true);
    expect(useProjectStore.getState().tracks.find((track) => track.id === id)?.label).toBe(
      'キル演出',
    );
    expect(useProjectStore.getState().moveTrack(id!, -1)).toBe(true);
    expect(useProjectStore.getState().tracks[0].id).toBe(id);
  });

  it('removes clips with a deleted track but preserves the final video track', () => {
    useProjectStore.setState({
      clips: [{
        id: 'audio-clip',
        trackId: 'audio',
        assetId: ASSET.id,
        start: 0,
        trimStart: 0,
        trimEnd: 1,
        effects: [],
      }],
      selectedClipIds: ['audio-clip'],
    });
    expect(useProjectStore.getState().removeTrack('video')).toBe(false);
    expect(useProjectStore.getState().removeTrack('audio')).toBe(true);
    expect(useProjectStore.getState().clips).toHaveLength(0);
    expect(useProjectStore.getState().selectedClipIds).toHaveLength(0);
  });

  it('duplicates a track with fresh track, clip and overlay identities', () => {
    useProjectStore.setState({
      clips: [{
        id: 'source-clip',
        trackId: 'video',
        assetId: ASSET.id,
        start: 0,
        trimStart: 0,
        trimEnd: 1,
        effects: [{ type: 'fade-in', duration: 0.2 }],
        overlays: [{
          id: 'source-overlay',
          text: 'ACE',
          fontSize: 8,
          color: '#fff',
          position: 'center',
        }],
      }],
    });
    const duplicatedTrackId = useProjectStore.getState().duplicateTrack('video');
    expect(duplicatedTrackId).toBeTruthy();
    const duplicated = useProjectStore
      .getState()
      .clips.find((clip) => clip.trackId === duplicatedTrackId);
    expect(duplicated?.id).not.toBe('source-clip');
    expect(duplicated?.overlays?.[0].id).not.toBe('source-overlay');
    expect(useProjectStore.getState().selectedClipIds).toEqual([duplicated?.id]);
  });

  it('copies and pastes a clip at the first collision-free position', () => {
    useProjectStore.setState({
      playhead: 1,
      clips: [{
        id: 'source-clip',
        trackId: 'video',
        assetId: ASSET.id,
        start: 0,
        trimStart: 0,
        trimEnd: 2,
        effects: [],
        overlays: [{
          id: 'source-overlay',
          text: 'ACE',
          fontSize: 8,
          color: '#fff',
          position: 'center',
        }],
      }],
      selectedClipIds: ['source-clip'],
    });

    expect(useProjectStore.getState().copySelectedClips()).toBe(1);
    expect(useProjectStore.getState().pasteClipsAtPlayhead()).toBe(1);

    const pasted = useProjectStore.getState().clips[1];
    expect(pasted.start).toBe(2);
    expect(pasted.id).not.toBe('source-clip');
    expect(pasted.overlays?.[0].id).not.toBe('source-overlay');
    expect(useProjectStore.getState().selectedClipIds).toEqual([pasted.id]);
  });

  it('duplicates selected clips as an adjacent group and respects track locks', () => {
    useProjectStore.setState({
      clips: [{
        id: 'source-clip',
        trackId: 'video',
        assetId: ASSET.id,
        start: 3,
        trimStart: 0,
        trimEnd: 2,
        effects: [],
      }],
      selectedClipIds: ['source-clip'],
    });

    expect(useProjectStore.getState().duplicateSelectedClips()).toBe(1);
    expect(useProjectStore.getState().clips[1].start).toBe(5);

    useProjectStore.setState({
      tracks: [{ ...TRACKS[0], locked: true }, TRACKS[1]],
      selectedClipIds: ['source-clip'],
    });
    expect(useProjectStore.getState().duplicateSelectedClips()).toBe(0);
  });
});
