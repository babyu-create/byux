import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHistory, useProjectStore } from './projectStore';
import { useMediaStore } from './mediaStore';
import type { Clip, MediaAsset, OverlayText, Track } from '../lib/types';
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

  it('rejects non-finite placement values and never trims beyond the source', () => {
    const state = useProjectStore.getState();
    expect(state.addClipFromAsset(ASSET.id, 'video', Number.NaN)).toBeNull();
    expect(state.addClipFromAsset(ASSET.id, 'video', 5, Number.POSITIVE_INFINITY)).toBeNull();
    expect(state.addClipFromAsset(ASSET.id, 'video', 999)).toBeTruthy();
    expect(useProjectStore.getState().clips[0].trimEnd).toBe(ASSET.duration);
  });

  it('ignores non-finite editor values instead of corrupting the project', () => {
    useProjectStore.setState({ playhead: 2, zoom: 1, verticalReframe: 0.25 });
    const state = useProjectStore.getState();
    state.setPlayhead(Number.NaN);
    state.setZoom(Number.POSITIVE_INFINITY);
    state.setVerticalReframe(Number.NaN);
    state.setPreRoll(Number.NaN);
    state.setPostRoll(Number.NEGATIVE_INFINITY);

    expect(useProjectStore.getState()).toMatchObject({
      playhead: 2,
      zoom: 1,
      verticalReframe: 0.25,
      preRollSec: 3,
      postRollSec: 1,
    });
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

  it('blocks every property edit while the owning track is locked', () => {
    const original = {
      id: 'locked-clip',
      trackId: 'video',
      assetId: ASSET.id,
      start: 0,
      trimStart: 0,
      trimEnd: 5,
      effects: [{ type: 'fade-in' as const, duration: 0.2 }],
      overlays: [{
        id: 'overlay',
        text: 'ACE',
        fontSize: 8,
        color: '#fff',
        position: 'center' as const,
      }],
      volume: 1,
    };
    useProjectStore.setState({
      tracks: [{ ...TRACKS[0], locked: true }, TRACKS[1]],
      clips: [original],
    });
    const state = useProjectStore.getState();
    state.setClipEffects(original.id, []);
    state.toggleClipEffect(original.id, 'motion-blur');
    state.updateClipEffect(original.id, 'fade-in', { duration: 1 });
    state.setClipVolume(original.id, 0.2);
    state.setClipAudioProcessing(original.id, { highPassHz: 100 });
    state.toggleClipMuted(original.id);
    state.addClipOverlay(original.id, { ...original.overlays[0], id: 'new' });
    state.updateClipOverlay(original.id, 'overlay', { text: 'changed' });
    state.removeClipOverlay(original.id, 'overlay');
    state.applyOverlayToClips([original.id], { ...original.overlays[0], id: 'applied' });

    expect(useProjectStore.getState().clips).toEqual([original]);
  });

  it('normalizes invalid audio controls to saveable finite values', () => {
    useProjectStore.setState({
      clips: [{
        id: 'clip',
        trackId: 'video',
        assetId: ASSET.id,
        start: 0,
        trimStart: 0,
        trimEnd: 5,
        effects: [],
      }],
    });
    const state = useProjectStore.getState();
    state.setClipVolume('clip', Number.NaN);
    state.setClipAudioProcessing('clip', {
      highPassHz: Number.NaN,
      lowGainDb: Number.POSITIVE_INFINITY,
      midGainDb: -99,
      highGainDb: 99,
    });
    state.setAudioDucking({
      enabled: true,
      amountDb: Number.NaN,
      attack: Number.POSITIVE_INFINITY,
      release: -1,
    });

    const next = useProjectStore.getState();
    expect(next.clips[0].volume).toBeUndefined();
    expect(next.clips[0].audioProcessing).toEqual({
      highPassHz: 0,
      lowGainDb: 0,
      midGainDb: -12,
      highGainDb: 12,
      compressor: false,
    });
    expect(Object.values(next.audioDucking ?? {}).every(
      (value) => typeof value !== 'number' || Number.isFinite(value),
    )).toBe(true);
  });

  it('keeps effects, transitions, transforms and overlays saveable', () => {
    const clip: Clip = {
      id: 'clip',
      trackId: 'video',
      assetId: ASSET.id,
      start: 0,
      trimStart: 0,
      trimEnd: 5,
      effects: [],
    };
    useProjectStore.setState({ clips: [clip] });
    const state = useProjectStore.getState();
    state.setClipEffects('clip', Array.from({ length: 40 }, () => ({
      type: 'motion-blur',
      duration: -5,
      intensity: 999,
    })));
    state.setClipTransition('clip', 'in', { type: 'fade', duration: -2 });
    state.setClipTransform('clip', {
      x: [{ t: -1, value: 10 }],
    });
    state.addClipOverlay('clip', {
      id: 'invalid id',
      text: 'x'.repeat(10_050),
      fontSize: -4,
      color: 'c'.repeat(600),
      position: 'center',
      strokeWidth: -1,
      introDuration: -2,
    });

    const updated = useProjectStore.getState().clips[0];
    expect(updated.effects).toHaveLength(32);
    expect(updated.effects[0]).toMatchObject({ duration: 0, intensity: 100 });
    expect(updated.transitionIn?.duration).toBe(0);
    expect(updated.transform).toBeUndefined();
    expect(updated.overlays?.[0]).toMatchObject({
      fontSize: 0.1,
      strokeWidth: 0,
      introDuration: 0,
    });
    expect(updated.overlays?.[0].id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(updated.overlays?.[0].text).toHaveLength(10_000);
    expect(updated.overlays?.[0].color).toHaveLength(512);
  });

  it('never exceeds the per-clip overlay limit', () => {
    const overlay = (index: number): OverlayText => ({
      id: `overlay-${index}`,
      text: String(index),
      fontSize: 8,
      color: '#fff',
      position: 'center',
    });
    useProjectStore.setState({
      clips: [{
        id: 'clip',
        trackId: 'video',
        assetId: ASSET.id,
        start: 0,
        trimStart: 0,
        trimEnd: 5,
        effects: [],
        overlays: Array.from({ length: 100 }, (_, index) => overlay(index)),
      }],
    });
    useProjectStore.getState().addClipOverlay('clip', overlay(100));
    expect(useProjectStore.getState().clips[0].overlays).toHaveLength(100);
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

  it('refuses edits that would exceed the project clip limit', () => {
    const clips = Array.from({ length: 10_000 }, (_, index) => ({
      id: `clip-${index}`,
      trackId: index === 0 ? 'video' : 'audio',
      assetId: ASSET.id,
      start: index,
      trimStart: 0,
      trimEnd: 1,
      effects: [],
    }));
    useProjectStore.setState({ clips });

    expect(useProjectStore.getState().addClipFromAsset(ASSET.id, 'video', 1)).toBeNull();
    expect(useProjectStore.getState().duplicateTrack('video')).toBeNull();
    useProjectStore.getState().splitClipAt('clip-0', 0.5);
    expect(useProjectStore.getState().clips).toHaveLength(10_000);
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

  it('moves a multi-track selection as one group and stops at the nearest blocker', () => {
    useProjectStore.setState({
      clips: [
        {
          id: 'video-selected',
          trackId: 'video',
          assetId: ASSET.id,
          start: 1,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
        {
          id: 'audio-selected',
          trackId: 'audio',
          assetId: ASSET.id,
          start: 2,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
        {
          id: 'blocker',
          trackId: 'video',
          assetId: ASSET.id,
          start: 4,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
      ],
      selectedClipIds: ['video-selected', 'audio-selected'],
    });

    expect(useProjectStore.getState().moveSelectedClips('video-selected', 8)).toBe(2);
    expect(
      useProjectStore.getState().clips.map((clip) => [clip.id, clip.start]),
    ).toEqual([
      ['video-selected', 3],
      ['audio-selected', 4],
      ['blocker', 4],
    ]);
    expect(useProjectStore.getState().moveSelectedClips('video-selected', 9)).toBe(0);
  });

  it('does not partially move a selection that includes a locked track', () => {
    useProjectStore.setState({
      tracks: [TRACKS[0], { ...TRACKS[1], locked: true }],
      clips: [
        {
          id: 'video-selected',
          trackId: 'video',
          assetId: ASSET.id,
          start: 1,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
        {
          id: 'locked-selected',
          trackId: 'audio',
          assetId: ASSET.id,
          start: 2,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
      ],
      selectedClipIds: ['video-selected', 'locked-selected'],
    });

    expect(useProjectStore.getState().moveSelectedClips('video-selected', 3)).toBe(0);
    expect(useProjectStore.getState().clips.map((clip) => clip.start)).toEqual([1, 2]);
  });

  it('ripple deletes on each editable track while preserving locked selections', () => {
    useProjectStore.setState({
      tracks: [TRACKS[0], { ...TRACKS[1], locked: true }],
      clips: [
        {
          id: 'remove-first',
          trackId: 'video',
          assetId: ASSET.id,
          start: 0,
          trimStart: 0,
          trimEnd: 2,
          effects: [],
        },
        {
          id: 'keep-middle',
          trackId: 'video',
          assetId: ASSET.id,
          start: 3,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
        {
          id: 'remove-second',
          trackId: 'video',
          assetId: ASSET.id,
          start: 5,
          trimStart: 0,
          trimEnd: 2,
          effects: [],
        },
        {
          id: 'keep-last',
          trackId: 'video',
          assetId: ASSET.id,
          start: 7,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
        {
          id: 'locked-selected',
          trackId: 'audio',
          assetId: ASSET.id,
          start: 1,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
      ],
      selectedClipIds: ['remove-first', 'remove-second', 'locked-selected'],
    });

    expect(useProjectStore.getState().rippleDeleteSelectedClips()).toBe(2);
    expect(
      useProjectStore.getState().clips.map((clip) => [clip.id, clip.start]),
    ).toEqual([
      ['keep-middle', 1],
      ['keep-last', 3],
      ['locked-selected', 1],
    ]);
    expect(useProjectStore.getState().selectedClipIds).toEqual(['locked-selected']);
  });

  it('normalizes batch selection ids and supports additive marquee selection', () => {
    useProjectStore.setState({
      clips: [
        {
          id: 'first',
          trackId: 'video',
          assetId: ASSET.id,
          start: 0,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
        {
          id: 'second',
          trackId: 'video',
          assetId: ASSET.id,
          start: 2,
          trimStart: 0,
          trimEnd: 1,
          effects: [],
        },
      ],
    });

    useProjectStore.getState().selectClips(['first', 'first', 'missing']);
    expect(useProjectStore.getState().selectedClipIds).toEqual(['first']);
    useProjectStore.getState().selectClips(['second'], true);
    expect(useProjectStore.getState().selectedClipIds).toEqual(['first', 'second']);
  });
});
