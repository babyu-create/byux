import type { Clip, KillMarker, MediaAsset, Track } from './types';
import { beatsToTimeline } from './audio';
import {
  clipDuration,
  sourceTimeAtTimelineTime,
  timelineTimeAtSourceTime,
} from './timeline';

export interface KillBeatSyncSuggestion {
  clipId: string;
  markerId: string;
  fromTimelineTime: number;
  beatTimelineTime: number;
  trimStart: number;
  trimEnd: number;
}

interface KillBeatSyncInput {
  clips: readonly Clip[];
  tracks: readonly Track[];
  markers: readonly KillMarker[];
  assets: readonly MediaAsset[];
  fps: number;
  maxShiftSec?: number;
}

function nearestBeatInWindow(
  beats: readonly number[],
  target: number,
  windowStart: number,
  windowEnd: number,
  maxDistance: number,
): number | undefined {
  let low = 0;
  let high = beats.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (beats[middle] < target) low = middle + 1;
    else high = middle;
  }
  let best: number | undefined;
  for (const index of [low - 1, low]) {
    const beat = beats[index];
    if (
      beat === undefined ||
      beat < windowStart - 1e-6 ||
      beat > windowEnd + 1e-6 ||
      Math.abs(beat - target) > maxDistance
    ) {
      continue;
    }
    if (best === undefined || Math.abs(beat - target) < Math.abs(best - target)) {
      best = beat;
    }
  }
  return best;
}

/**
 * Build non-destructive kill-to-beat suggestions.
 *
 * The clip's source window is shifted without changing its length. Therefore
 * the clip stays in the same timeline slot and later clips never ripple, while
 * the chosen source-time kill marker moves onto the nearest audible BGM beat.
 */
export function buildKillBeatSyncSuggestions(
  input: KillBeatSyncInput,
): KillBeatSyncSuggestion[] {
  const maxShiftSec = Math.max(0.05, Math.min(2, input.maxShiftSec ?? 0.45));
  const assetById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const bgmTrack = input.tracks.find(
    (track) => track.kind === 'audio' && !track.hidden && !track.muted,
  );
  if (!bgmTrack) return [];

  const beatTimes = input.clips
    .filter((clip) => clip.trackId === bgmTrack.id && !clip.muted)
    .flatMap((clip) => {
      const beats = assetById.get(clip.assetId)?.beats ?? [];
      return beatsToTimeline(beats, clip);
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (beatTimes.length === 0) return [];

  const editableVideoTrackIds = new Set(
    input.tracks
      .filter((track) => track.kind === 'video' && !track.hidden && !track.locked)
      .map((track) => track.id),
  );
  const markersByAsset = new Map<string, KillMarker[]>();
  for (const marker of input.markers) {
    const list = markersByAsset.get(marker.assetId);
    if (list) list.push(marker);
    else markersByAsset.set(marker.assetId, [marker]);
  }

  const suggestions: KillBeatSyncSuggestion[] = [];
  const tolerance = Math.max(1 / Math.max(1, input.fps), 0.02);

  for (const clip of input.clips) {
    if (!editableVideoTrackIds.has(clip.trackId)) continue;
    const asset = assetById.get(clip.assetId);
    if (!asset || !Number.isFinite(asset.duration)) continue;
    const clipEnd = clip.start + clipDuration(clip);
    const candidates = (markersByAsset.get(clip.assetId) ?? [])
      .filter(
        (marker) =>
          marker.time >= clip.trimStart - 1e-6 &&
          marker.time <= clip.trimEnd + 1e-6,
      )
      .map((marker) => ({
        marker,
        timelineTime: timelineTimeAtSourceTime(clip, marker.time),
      }))
      .sort(
        (a, b) =>
          Math.abs(a.timelineTime - (clip.start + clipEnd) / 2) -
          Math.abs(b.timelineTime - (clip.start + clipEnd) / 2),
      );
    const chosen = candidates[0];
    if (!chosen) continue;

    const beat = nearestBeatInWindow(
      beatTimes,
      chosen.timelineTime,
      clip.start,
      clipEnd,
      maxShiftSec,
    );
    if (beat === undefined || Math.abs(beat - chosen.timelineTime) <= tolerance) continue;

    const sourceAtBeat = sourceTimeAtTimelineTime(clip, beat);
    const desiredSourceShift = chosen.marker.time - sourceAtBeat;
    const boundedSourceShift = Math.max(
      -clip.trimStart,
      Math.min(asset.duration - clip.trimEnd, desiredSourceShift),
    );
    const trimStart = clip.trimStart + boundedSourceShift;
    const trimEnd = clip.trimEnd + boundedSourceShift;
    const adjusted = { ...clip, trimStart, trimEnd };
    const adjustedKillTime = timelineTimeAtSourceTime(adjusted, chosen.marker.time);
    if (Math.abs(adjustedKillTime - beat) > tolerance) continue;

    suggestions.push({
      clipId: clip.id,
      markerId: chosen.marker.id,
      fromTimelineTime: chosen.timelineTime,
      beatTimelineTime: beat,
      trimStart,
      trimEnd,
    });
  }
  return suggestions;
}

export function applyKillBeatSyncSuggestions(
  clips: readonly Clip[],
  suggestions: readonly KillBeatSyncSuggestion[],
): Clip[] {
  const byClipId = new Map(suggestions.map((suggestion) => [suggestion.clipId, suggestion]));
  return clips.map((clip) => {
    const suggestion = byClipId.get(clip.id);
    return suggestion
      ? { ...clip, trimStart: suggestion.trimStart, trimEnd: suggestion.trimEnd }
      : clip;
  });
}
