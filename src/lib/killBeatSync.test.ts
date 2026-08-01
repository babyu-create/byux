import { describe, expect, it } from 'vitest';
import type { Clip, KillMarker, MediaAsset, Track } from './types';
import {
  applyKillBeatSyncSuggestions,
  buildKillBeatSyncSuggestions,
} from './killBeatSync';
import { timelineTimeAtSourceTime } from './timeline';

const tracks: Track[] = [
  { id: 'video', kind: 'video', label: '映像', locked: false, muted: false, hidden: false },
  { id: 'bgm', kind: 'audio', label: 'BGM', locked: false, muted: false, hidden: false },
];
const video: MediaAsset = {
  id: 'video-asset',
  name: 'game.mp4',
  kind: 'video',
  url: 'blob:video',
  size: 1,
  mimeType: 'video/mp4',
  duration: 10,
};
const bgm: MediaAsset = {
  id: 'bgm-asset',
  name: 'song.mp3',
  kind: 'audio',
  url: 'blob:bgm',
  size: 1,
  mimeType: 'audio/mpeg',
  duration: 10,
  beats: [2],
};
const videoClip: Clip = {
  id: 'video-clip',
  trackId: 'video',
  assetId: video.id,
  start: 0,
  trimStart: 0,
  trimEnd: 4,
  effects: [],
};
const bgmClip: Clip = {
  id: 'bgm-clip',
  trackId: 'bgm',
  assetId: bgm.id,
  start: 0,
  trimStart: 0,
  trimEnd: 10,
  effects: [],
};
const marker: KillMarker = {
  id: 'kill',
  assetId: video.id,
  time: 2.2,
};

describe('kill-to-beat sync', () => {
  it('shifts the source window while preserving clip duration and placement', () => {
    const suggestions = buildKillBeatSyncSuggestions({
      clips: [videoClip, bgmClip],
      tracks,
      markers: [marker],
      assets: [video, bgm],
      fps: 60,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].trimStart).toBeCloseTo(0.2);
    expect(suggestions[0].trimEnd).toBeCloseTo(4.2);
    const adjusted = applyKillBeatSyncSuggestions([videoClip], suggestions)[0];
    expect(timelineTimeAtSourceTime(adjusted, marker.time)).toBeCloseTo(2);
  });

  it('does not move a clip when the nearest beat is too far away', () => {
    expect(
      buildKillBeatSyncSuggestions({
        clips: [videoClip, bgmClip],
        tracks,
        markers: [{ ...marker, time: 3 }],
        assets: [video, bgm],
        fps: 60,
      }),
    ).toEqual([]);
  });

  it('skips locked video and muted BGM tracks', () => {
    expect(
      buildKillBeatSyncSuggestions({
        clips: [videoClip, bgmClip],
        tracks: [{ ...tracks[0], locked: true }, tracks[1]],
        markers: [marker],
        assets: [video, bgm],
        fps: 60,
      }),
    ).toEqual([]);
    expect(
      buildKillBeatSyncSuggestions({
        clips: [videoClip, bgmClip],
        tracks: [tracks[0], { ...tracks[1], muted: true }],
        markers: [marker],
        assets: [video, bgm],
        fps: 60,
      }),
    ).toEqual([]);
  });
});
