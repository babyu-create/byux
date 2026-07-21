import { create, useStore } from 'zustand';
import { temporal } from 'zundo';
import type {
  Clip,
  ClipEffect,
  ClipTransform,
  IORange,
  KillMarker,
  MediaAsset,
  OverlayText,
  PendingIn,
  ProjectFps,
  ProjectResolution,
  SubtitleCue,
  SubtitleStyle,
  Track,
  TrackKind,
} from '../lib/types';
import { useMediaStore } from './mediaStore';
import type { HudPreset } from '../lib/motionBlurCore';
import { resolveDucking, type AudioDucking } from '../lib/audioDucking';
import { applyClipLook, isValidClipLook } from '../lib/presets';
import {
  DEFAULT_SUBTITLE_STYLE,
  MAX_SUBTITLE_CUES,
  MAX_SUBTITLE_TEXT_LENGTH,
} from '../lib/subtitles';
import {
  placeClipCopies,
  readClipClipboard,
  writeClipClipboard,
} from '../lib/clipClipboard';
import {
  applyKillBeatSyncSuggestions,
  buildKillBeatSyncSuggestions,
} from '../lib/killBeatSync';
import {
  clamp,
  clipDuration,
  findFreeSlot,
  nextClipOnTrack,
  prevClipEndOnTrack,
  resolveClipPosition,
  sourceTimeAtTimelineTime,
  timelineTimeAtSourceTime,
} from '../lib/timeline';

const DEFAULT_TRACKS: Track[] = [
  { id: 'track-video', kind: 'video', label: '映像メイン', locked: false, muted: false, hidden: false },
  { id: 'track-audio', kind: 'audio', label: 'BGM', locked: false, muted: false, hidden: false },
  { id: 'track-audio-2', kind: 'audio', label: 'SE', locked: false, muted: false, hidden: false },
];

interface ProjectStoreState {
  name: string;
  aspectRatio: '16:9' | '9:16';
  fps: ProjectFps;
  resolution: ProjectResolution;
  tracks: Track[];
  clips: Clip[];
  markers: KillMarker[];
  subtitles: SubtitleCue[];
  subtitleStyle: SubtitleStyle;
  /**
   * Project-level BGM auto-ducking (Phase P5). Undefined = no ducking. Lives at
   * project scope (like hudPreset) so the BGM is dipped identically in the live
   * preview and the export. See lib/audioDucking.
   */
  audioDucking?: AudioDucking;
  selectedClipIds: string[];
  selectedMarkerId: string | null;
  playhead: number;
  zoom: number;
  snapEnabled: boolean;
  /**
   * HUD positional-protect preset for motion blur (game-specific). Lives at
   * project scope — not Preview-local — so the export uses the SAME preset the
   * user selected in the preview toolbar (otherwise export silently defaulted
   * to 'valorant').
   */
  hudPreset: HudPreset;
  /**
   * Horizontal reframe for 9:16 vertical export, -1 (left) .. 0 (center) .. 1
   * (right). When the 16:9 source is cropped to fill a vertical frame, this
   * pans which slice is kept so the action/crosshair stays in view.
   */
  verticalReframe: number;
  snapIndicator: { time: number; type: string } | null;
  isPlaying: boolean;
  preRollSec: number;
  postRollSec: number;
  ioRanges: IORange[];
  pendingIn: PendingIn | null;
  selectedRangeId: string | null;
  transientMessage: {
    kind: 'info' | 'error' | 'success';
    text: string;
    key: number;
    /** Total visible duration in milliseconds — used by the Toast to render a
     *  visible progress bar so users see when the message will disappear. */
    durationMs: number;
  } | null;

  setName: (name: string) => void;
  resetProject: () => void;

  addClipFromAsset: (
    assetId: string,
    trackId: string,
    durationSec: number,
    atTime?: number,
  ) => string | null;
  moveClip: (clipId: string, newStart: number) => void;
  trimClipStart: (clipId: string, newTrimStart: number) => void;
  trimClipEnd: (clipId: string, newTrimEnd: number) => void;
  splitClipAt: (clipId: string, atTime: number) => void;
  removeClip: (clipId: string) => void;
  removeSelectedClips: () => void;
  /** Remove every timeline/reference object owned by a media asset. */
  removeAssetReferences: (assetId: string) => void;
  selectClip: (clipId: string, additive?: boolean) => void;
  clearSelection: () => void;
  copySelectedClips: () => number;
  pasteClipsAtPlayhead: () => number;
  duplicateSelectedClips: () => number;
  setPlayhead: (time: number) => void;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  toggleSnap: () => void;
  setHudPreset: (preset: HudPreset) => void;
  setVerticalReframe: (value: number) => void;
  /** Set (or clear with null) the project-level BGM auto-ducking. */
  setAudioDucking: (ducking: AudioDucking | null) => void;
  setSubtitles: (cues: SubtitleCue[]) => void;
  addSubtitle: (atTime?: number) => string | null;
  updateSubtitle: (id: string, patch: Partial<Omit<SubtitleCue, 'id'>>) => void;
  removeSubtitle: (id: string) => void;
  setSubtitleStyle: (patch: Partial<SubtitleStyle>) => void;
  splitSelectedAtPlayhead: () => void;
  setIsPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  toggleTrackLocked: (trackId: string) => void;
  toggleTrackMuted: (trackId: string) => void;
  toggleTrackHidden: (trackId: string) => void;
  addTrack: (kind: TrackKind) => string | null;
  renameTrack: (trackId: string, label: string) => boolean;
  moveTrack: (trackId: string, direction: -1 | 1) => boolean;
  duplicateTrack: (trackId: string) => string | null;
  removeTrack: (trackId: string) => boolean;
  setSnapIndicator: (indicator: { time: number; type: string } | null) => void;
  addKillMarker: (assetId: string, time: number, label?: string) => string;
  removeKillMarker: (markerId: string) => void;
  moveKillMarker: (markerId: string, newTime: number) => void;
  removeNearestMarker: (assetId: string, time: number, toleranceSec: number) => boolean;
  selectMarker: (markerId: string | null) => void;
  setPreRoll: (sec: number) => void;
  setPostRoll: (sec: number) => void;
  autoClipFromMarkers: (
    assetId: string,
    options: { preRoll: number; postRoll: number; deleteSourceClips: boolean },
  ) => number;
  syncKillsToBeats: (maxShiftSec?: number) => number;
  jumpToAdjacentMarker: (direction: 'prev' | 'next') => void;

  setIoIn: (assetId: string, time: number) => void;
  setIoOut: (assetId: string, time: number) => string | null;
  clearPendingIn: () => void;
  removeIoRange: (rangeId: string) => void;
  removeNearestRange: (assetId: string, time: number) => boolean;
  selectRange: (rangeId: string | null) => void;
  extractCurrentRange: () => string | null;
  cutFromRanges: (
    assetId: string,
    options: { deleteSourceClips: boolean },
  ) => number;

  showMessage: (kind: 'info' | 'error' | 'success', text: string, durationMs?: number) => void;
  clearMessage: () => void;

  setClipEffects: (clipId: string, effects: import('../lib/types').ClipEffect[]) => void;
  toggleClipEffect: (
    clipId: string,
    type: import('../lib/types').ClipEffectType,
  ) => void;
  updateClipEffect: (
    clipId: string,
    type: import('../lib/types').ClipEffectType,
    patch: Partial<import('../lib/types').ClipEffect>,
  ) => void;
  setClipSpeed: (clipId: string, speed: number) => void;
  setClipSpeedRamp: (
    clipId: string,
    ramp: import('../lib/speedRamp').SpeedRamp | null,
  ) => void;
  setClipVolume: (clipId: string, volume: number) => void;
  setClipAudioProcessing: (
    clipId: string,
    processing: import('../lib/types').AudioProcessing | null,
  ) => void;
  setClipStretch: (clipId: string, stretchToFill: boolean) => void;
  setClipTransform: (
    clipId: string,
    transform: import('../lib/types').ClipTransform,
  ) => void;
  setClipColorGrade: (
    clipId: string,
    grade: import('../lib/types').ColorGrade | null,
  ) => void;
  setClipTransition: (
    clipId: string,
    edge: 'in' | 'out',
    transition: import('../lib/transitions').ClipTransition | null,
  ) => void;
  toggleClipMuted: (clipId: string) => void;
  addClipOverlay: (clipId: string, overlay: import('../lib/types').OverlayText) => void;
  updateClipOverlay: (
    clipId: string,
    overlayId: string,
    patch: Partial<import('../lib/types').OverlayText>,
  ) => void;
  removeClipOverlay: (clipId: string, overlayId: string) => void;
  applyOverlayToClips: (
    clipIds: string[],
    overlay: import('../lib/types').OverlayText,
  ) => void;
  /**
   * Apply a saved clip-look preset (Phase P6) to one or more clips. The clips'
   * identity / placement / audio are preserved; their visual look (transform,
   * color grade, effects, text overlays, transitions, speed) is replaced by the
   * preset's. Clips on locked tracks are skipped. See lib/presets.
   */
  applyPresetToClips: (
    clipIds: string[],
    look: import('../lib/presets').ClipLook,
  ) => number;
  loadProject: (file: import('../lib/project').ProjectFile, idMap: Record<string, string>) => void;
  /** Pending asset references from a loaded project, used to auto-relink later. */
  expectedAssets: import('../lib/project').ProjectAssetRef[];
  remapAssetIds: (idMap: Record<string, string>) => void;
  clearExpectedAssets: () => void;
  /** Immutable document snapshot from the last successful save/load. */
  savedDocument: DocState | null;
  /** Serialized media-library identity from the last successful save/load. */
  savedAssetsFingerprint: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const MIN_CLIP_DURATION = 0.1;
const MAX_TRACKS = 100;
const MAX_TRACK_LABEL_LENGTH = 48;
const MAX_PROJECT_CLIPS = 10_000;
const MAX_CLIP_EFFECTS = 32;
export const MAX_CLIP_OVERLAYS = 100;
const MAX_OVERLAY_TEXT_LENGTH = 10_000;
const MAX_ANIMATION_KEYFRAMES = 2_000;
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function hasOnlyFiniteNumbers(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(hasOnlyFiniteNumbers);
  if (value && typeof value === 'object') {
    return Object.values(value).every(hasOnlyFiniteNumbers);
  }
  return true;
}

function isClipEditable(state: ProjectStoreState, clipId: string): boolean {
  const clip = state.clips.find((candidate) => candidate.id === clipId);
  if (!clip) return false;
  const track = state.tracks.find((candidate) => candidate.id === clip.trackId);
  return Boolean(track && !track.locked);
}

function normalizeAudioDucking(ducking: AudioDucking): AudioDucking {
  const resolved = resolveDucking(ducking);
  return {
    enabled: resolved.enabled,
    amountDb: resolved.amountDb,
    attack: resolved.attack,
    release: resolved.release,
  };
}

function normalizeClipEffect(effect: ClipEffect): ClipEffect {
  return {
    type: effect.type,
    ...(effect.duration !== undefined
      ? { duration: Math.max(0, Number(effect.duration)) }
      : null),
    ...(effect.intensity !== undefined
      ? { intensity: Math.max(0, Math.min(100, Number(effect.intensity))) }
      : null),
  };
}

function normalizeOverlay(overlay: OverlayText): OverlayText | null {
  if (!hasOnlyFiniteNumbers(overlay) || !Number.isFinite(overlay.fontSize)) return null;
  return {
    ...overlay,
    id: VALID_ID.test(overlay.id) ? overlay.id : crypto.randomUUID(),
    text: String(overlay.text).slice(0, MAX_OVERLAY_TEXT_LENGTH),
    fontSize: Math.max(0.1, overlay.fontSize),
    color: String(overlay.color).slice(0, 512),
    ...(overlay.weight !== undefined && Number.isFinite(overlay.weight)
      ? { weight: overlay.weight }
      : null),
    ...(overlay.outlineColor !== undefined
      ? { outlineColor: String(overlay.outlineColor).slice(0, 512) }
      : null),
    ...(overlay.fontFamily !== undefined
      ? { fontFamily: String(overlay.fontFamily).slice(0, 512) }
      : null),
    ...(overlay.background !== undefined
      ? { background: String(overlay.background).slice(0, 512) }
      : null),
    ...(overlay.decorationColor !== undefined
      ? { decorationColor: String(overlay.decorationColor).slice(0, 512) }
      : null),
    ...(overlay.strokeWidth !== undefined
      ? { strokeWidth: Math.max(0, overlay.strokeWidth) }
      : null),
    ...(overlay.introDuration !== undefined
      ? { introDuration: Math.max(0, overlay.introDuration) }
      : null),
  };
}

function isSerializableTransform(transform: ClipTransform | undefined): boolean {
  if (!transform) return true;
  return Object.values(transform).every((value) => {
    if (value === undefined) return true;
    if (typeof value === 'number') return Number.isFinite(value);
    return value.length <= MAX_ANIMATION_KEYFRAMES && value.every((keyframe: {
      t: number;
      value: number;
    }) =>
      Number.isFinite(keyframe.t) &&
      keyframe.t >= 0 &&
      Number.isFinite(keyframe.value),
    );
  });
}

function normalizeSubtitleCue(cue: SubtitleCue): SubtitleCue | null {
  const start = Math.max(0, Number(cue.start));
  const end = Math.max(0, Number(cue.end));
  const text = String(cue.text).slice(0, MAX_SUBTITLE_TEXT_LENGTH);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text.trim()) {
    return null;
  }
  return { id: cue.id, start, end, text };
}

function withFreshClipIdentity(clip: Clip): Clip {
  return {
    ...clip,
    id: crypto.randomUUID(),
    overlays: clip.overlays?.map((overlay) => ({
      ...overlay,
      id: crypto.randomUUID(),
    })),
  };
}

function clipboardCompatibleClips(state: ProjectStoreState, clips: Clip[]): Clip[] {
  const assets = new Map(
    useMediaStore.getState().assets.map((asset) => [asset.id, asset]),
  );
  const tracks = new Map(state.tracks.map((track) => [track.id, track]));
  return clips.filter((clip) => {
    const asset = assets.get(clip.assetId);
    const track = tracks.get(clip.trackId);
    if (!asset || !track || track.locked) return false;
    return asset.kind === 'audio'
      ? track.kind === 'audio'
      : track.kind === 'video' || track.kind === 'overlay';
  });
}

// --- Undo / redo (zundo temporal) ------------------------------------------
// Only the editable "document" is undoable; ephemeral UI state (playhead,
// zoom, selection, isPlaying, transient messages, export prefs) is excluded so
// playback/scrubbing never pollute history.
type DocState = Pick<
  ProjectStoreState,
  | 'name' | 'aspectRatio' | 'fps' | 'resolution'
  | 'tracks' | 'clips' | 'markers' | 'ioRanges'
  | 'subtitles' | 'subtitleStyle'
  | 'preRollSec' | 'postRollSec' | 'audioDucking'
  | 'hudPreset' | 'verticalReframe'
>;

function partializeDoc(s: ProjectStoreState): DocState {
  return {
    name: s.name,
    aspectRatio: s.aspectRatio,
    fps: s.fps,
    resolution: s.resolution,
    tracks: s.tracks,
    clips: s.clips,
    markers: s.markers,
    subtitles: s.subtitles,
    subtitleStyle: s.subtitleStyle,
    ioRanges: s.ioRanges,
    preRollSec: s.preRollSec,
    postRollSec: s.postRollSec,
    audioDucking: s.audioDucking,
    hudPreset: s.hudPreset,
    verticalReframe: s.verticalReframe,
  };
}

// Reference equality per doc field — the store mutates immutably, so a changed
// ref means a real edit. Lets temporal skip non-doc sets (playhead @60fps,
// selection, …) cheaply without deep comparison.
function docEqual(a: DocState, b: DocState): boolean {
  return (
    a.name === b.name &&
    a.aspectRatio === b.aspectRatio &&
    a.fps === b.fps &&
    a.resolution === b.resolution &&
    a.tracks === b.tracks &&
    a.clips === b.clips &&
    a.markers === b.markers &&
    a.subtitles === b.subtitles &&
    a.subtitleStyle === b.subtitleStyle &&
    a.ioRanges === b.ioRanges &&
    a.preRollSec === b.preRollSec &&
    a.postRollSec === b.postRollSec &&
    a.audioDucking === b.audioDucking &&
    a.hudPreset === b.hudPreset &&
    a.verticalReframe === b.verticalReframe
  );
}

function assetsFingerprint(assets: MediaAsset[]): string {
  return JSON.stringify(
    assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      kind: asset.kind,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      path: asset.path,
    })),
  );
}

// Coalesce rapid edits (clip/slider drags fire ~60/s) into a single history
// entry by debouncing when temporal records. 150ms groups per-frame drags
// while staying well under human undo-reaction time.
interface CancelableDebounce<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

let cancelPendingHistory = (): void => {};

function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): CancelableDebounce<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}

export const useProjectStore = create<ProjectStoreState>()(
  temporal(
    (set, get) => ({
  name: 'untitled',
  aspectRatio: '16:9',
  fps: 60,
  resolution: '1080p',
  tracks: DEFAULT_TRACKS,
  clips: [],
  markers: [],
  subtitles: [],
  subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
  audioDucking: undefined,
  selectedClipIds: [],
  selectedMarkerId: null,
  playhead: 0,
  zoom: 1,
  snapEnabled: true,
  hudPreset: 'valorant',
  verticalReframe: 0,
  snapIndicator: null,
  isPlaying: false,
  preRollSec: 3,
  postRollSec: 1,
  ioRanges: [],
  pendingIn: null,
  selectedRangeId: null,
  transientMessage: null,
  expectedAssets: [],
  savedDocument: null,
  savedAssetsFingerprint: '[]',

  setName: (name) => set({ name: name.slice(0, 120) }),
  resetProject: () =>
    set({
      name: 'untitled',
      aspectRatio: '16:9',
      fps: 60,
      resolution: '1080p',
      tracks: DEFAULT_TRACKS.map((track) => ({ ...track })),
      clips: [],
      markers: [],
      subtitles: [],
      subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
      ioRanges: [],
      audioDucking: undefined,
      hudPreset: 'valorant',
      verticalReframe: 0,
      selectedClipIds: [],
      selectedMarkerId: null,
      selectedRangeId: null,
      pendingIn: null,
      playhead: 0,
      isPlaying: false,
      preRollSec: 3,
      postRollSec: 1,
      expectedAssets: [],
    }),

  addClipFromAsset: (assetId, trackId, durationSec, atTime) => {
    if (!isFiniteNumber(durationSec) || durationSec <= 0) return null;
    if (atTime !== undefined && !isFiniteNumber(atTime)) return null;
    const state = get();
    if (state.clips.length >= MAX_PROJECT_CLIPS) return null;
    const track = state.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.locked) return null;
    const asset = useMediaStore
      .getState()
      .assets.find((candidate) => candidate.id === assetId);
    if (!asset) return null;
    if (!isFiniteNumber(asset.duration) || asset.duration <= 0) return null;
    const compatible =
      asset.kind === 'audio'
        ? track.kind === 'audio'
        : track.kind === 'video' || track.kind === 'overlay';
    if (!compatible) return null;
    const sourceDuration = Math.min(durationSec, asset.duration);
    if (sourceDuration < MIN_CLIP_DURATION) return null;
    const id = crypto.randomUUID();
    const sameTrackClips = state.clips.filter((c) => c.trackId === trackId);
    const preferred =
      atTime !== undefined
        ? Math.max(0, atTime)
        : sameTrackClips.reduce(
            (max, c) => Math.max(max, c.start + clipDuration(c)),
            0,
          );
    const start = findFreeSlot(sameTrackClips, sourceDuration, preferred);

    const clip: Clip = {
      id,
      trackId,
      assetId,
      start,
      trimStart: 0,
      trimEnd: sourceDuration,
      effects: [],
    };
    set({ clips: [...state.clips, clip], selectedClipIds: [id] });
    return id;
  },

  moveClip: (clipId, newStart) => {
    if (!isFiniteNumber(newStart)) return;
    set((state) => {
      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip) return state;
      const track = state.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return state;
      const others = state.clips.filter(
        (c) => c.trackId === clip.trackId && c.id !== clipId,
      );
      const duration = clipDuration(clip);
      const resolved = resolveClipPosition(others, newStart, duration, clip.start);
      return {
        clips: state.clips.map((c) =>
          c.id === clipId ? { ...c, start: resolved } : c,
        ),
      };
    });
  },

  trimClipStart: (clipId, newTrimStart) => {
    if (!isFiniteNumber(newTrimStart)) return;
    set((state) => {
      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip) return state;
      const track = state.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return state;

      const speed = clip.speed ?? 1;
      const others = state.clips.filter(
        (c) => c.trackId === clip.trackId && c.id !== clipId,
      );
      // Lower bound on trimStart: clip.start cannot drop below previous clip's end.
      // newStart_timeline = clip.start + (newTrimStart - trimStart) / speed >= prevEnd
      // ⇒ newTrimStart >= (prevEnd - clip.start) * speed + clip.trimStart
      const prevEnd = prevClipEndOnTrack(others, clip.start);
      const minTrimStart = Math.max(
        0,
        (prevEnd - clip.start) * speed + clip.trimStart,
      );
      const next = clamp(
        newTrimStart,
        minTrimStart,
        clip.trimEnd - MIN_CLIP_DURATION,
      );
      const sourceDelta = next - clip.trimStart;
      const timelineDelta = sourceDelta / speed;
      return {
        clips: state.clips.map((c) =>
          c.id === clipId
            ? {
                ...c,
                trimStart: next,
                start: Math.max(0, c.start + timelineDelta),
              }
            : c,
        ),
      };
    });
  },

  trimClipEnd: (clipId, newTrimEnd) => {
    if (!isFiniteNumber(newTrimEnd)) return;
    set((state) => {
      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip) return state;
      const track = state.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return state;
      const speed = clip.speed ?? 1;
      const others = state.clips.filter(
        (c) => c.trackId === clip.trackId && c.id !== clipId,
      );
      // Upper bound: clip's right edge cannot pass the next clip's start.
      // (trimEnd - trimStart) / speed <= maxClipEnd - clip.start
      // ⇒ trimEnd <= (maxClipEnd - clip.start) * speed + trimStart
      const next = nextClipOnTrack(others, clip.start);
      const maxClipEnd = next ? next.start : Infinity;
      const maxTrimEnd = (maxClipEnd - clip.start) * speed + clip.trimStart;
      const finalTrimEnd = Math.max(
        clip.trimStart + MIN_CLIP_DURATION,
        Math.min(maxTrimEnd, newTrimEnd),
      );
      return {
        clips: state.clips.map((c) =>
          c.id === clipId ? { ...c, trimEnd: finalTrimEnd } : c,
        ),
      };
    });
  },

  splitClipAt: (clipId, atTime) => {
    if (!isFiniteNumber(atTime)) return;
    set((state) => {
      if (state.clips.length >= MAX_PROJECT_CLIPS) return state;
      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip) return state;
      const track = state.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return state;
      const localOffset = atTime - clip.start;
      const sourceTime = sourceTimeAtTimelineTime(clip, atTime);
      if (
        localOffset <= MIN_CLIP_DURATION ||
        sourceTime >= clip.trimEnd - MIN_CLIP_DURATION
      ) {
        return state;
      }
      const newId = crypto.randomUUID();
      const left: Clip = { ...clip, trimEnd: sourceTime };
      const right: Clip = {
        ...clip,
        id: newId,
        start: atTime,
        trimStart: sourceTime,
      };
      return {
        clips: state.clips.map((c) => (c.id === clipId ? left : c)).concat(right),
        selectedClipIds: [newId],
      };
    });
  },

  removeClip: (clipId) => {
    set((state) => {
      const clip = state.clips.find((c) => c.id === clipId);
      if (clip) {
        const track = state.tracks.find((t) => t.id === clip.trackId);
        if (track?.locked) return state;
      }
      return {
        clips: state.clips.filter((c) => c.id !== clipId),
        selectedClipIds: state.selectedClipIds.filter((id) => id !== clipId),
      };
    });
  },

  removeSelectedClips: () => {
    set((state) => {
      const lockedTrackIds = new Set(
        state.tracks.filter((t) => t.locked).map((t) => t.id),
      );
      // Determine which selected ids are deletable.
      const deletableIds = new Set(
        state.selectedClipIds.filter((id) => {
          const c = state.clips.find((cc) => cc.id === id);
          return c && !lockedTrackIds.has(c.trackId);
        }),
      );
      return {
        clips: state.clips.filter((c) => !deletableIds.has(c.id)),
        selectedClipIds: state.selectedClipIds.filter((id) => !deletableIds.has(id)),
      };
    });
  },

  removeAssetReferences: (assetId) => {
    set((state) => {
      const removedClipIds = new Set(
        state.clips.filter((clip) => clip.assetId === assetId).map((clip) => clip.id),
      );
      const removedMarkerIds = new Set(
        state.markers.filter((marker) => marker.assetId === assetId).map((marker) => marker.id),
      );
      const removedRangeIds = new Set(
        state.ioRanges.filter((range) => range.assetId === assetId).map((range) => range.id),
      );
      return {
        clips: state.clips.filter((clip) => clip.assetId !== assetId),
        markers: state.markers.filter((marker) => marker.assetId !== assetId),
        ioRanges: state.ioRanges.filter((range) => range.assetId !== assetId),
        selectedClipIds: state.selectedClipIds.filter((id) => !removedClipIds.has(id)),
        selectedMarkerId:
          state.selectedMarkerId && removedMarkerIds.has(state.selectedMarkerId)
            ? null
            : state.selectedMarkerId,
        selectedRangeId:
          state.selectedRangeId && removedRangeIds.has(state.selectedRangeId)
            ? null
            : state.selectedRangeId,
        pendingIn: state.pendingIn?.assetId === assetId ? null : state.pendingIn,
      };
    });
  },

  selectClip: (clipId, additive = false) => {
    set((state) => {
      if (additive) {
        const has = state.selectedClipIds.includes(clipId);
        return {
          selectedClipIds: has
            ? state.selectedClipIds.filter((id) => id !== clipId)
            : [...state.selectedClipIds, clipId],
        };
      }
      return { selectedClipIds: [clipId] };
    });
  },

  clearSelection: () => set({ selectedClipIds: [] }),

  copySelectedClips: () => {
    const state = get();
    const selectedIds = new Set(state.selectedClipIds);
    return writeClipClipboard(
      state.clips.filter((clip) => selectedIds.has(clip.id)),
    );
  },

  pasteClipsAtPlayhead: () => {
    const state = get();
    const available = Math.max(0, MAX_PROJECT_CLIPS - state.clips.length);
    const templates = clipboardCompatibleClips(
      state,
      readClipClipboard(),
    ).slice(0, available);
    if (templates.length === 0) return 0;
    const copies = placeClipCopies(
      templates,
      state.clips,
      state.playhead,
    ).map(withFreshClipIdentity);
    set({
      clips: [...state.clips, ...copies],
      selectedClipIds: copies.map((clip) => clip.id),
    });
    return copies.length;
  },

  duplicateSelectedClips: () => {
    const state = get();
    const selectedIds = new Set(state.selectedClipIds);
    const available = Math.max(0, MAX_PROJECT_CLIPS - state.clips.length);
    const templates = clipboardCompatibleClips(
      state,
      state.clips.filter((clip) => selectedIds.has(clip.id)),
    ).slice(0, available);
    if (templates.length === 0) return 0;
    const origin = Math.min(...templates.map((clip) => clip.start));
    const copies = placeClipCopies(templates, state.clips, origin).map(
      withFreshClipIdentity,
    );
    set({
      clips: [...state.clips, ...copies],
      selectedClipIds: copies.map((clip) => clip.id),
    });
    return copies.length;
  },

  setPlayhead: (time) => {
    if (isFiniteNumber(time)) set({ playhead: Math.max(0, time) });
  },
  setZoom: (zoom) => {
    if (isFiniteNumber(zoom)) set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) });
  },
  zoomIn: () => set((s) => ({ zoom: clamp(s.zoom * 1.4, MIN_ZOOM, MAX_ZOOM) })),
  zoomOut: () => set((s) => ({ zoom: clamp(s.zoom / 1.4, MIN_ZOOM, MAX_ZOOM) })),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),

  setHudPreset: (hudPreset) => set({ hudPreset }),

  setVerticalReframe: (value) =>
    isFiniteNumber(value)
      ? set({ verticalReframe: Math.max(-1, Math.min(1, value)) })
      : undefined,

  setAudioDucking: (ducking) =>
    // Null clears the setting so the project serialises back to a ducking-free
    // (backward-compatible) shape, mirroring setClipColorGrade(null) etc.
    set({
      audioDucking: ducking ? normalizeAudioDucking(ducking) : undefined,
    }),

  setSubtitles: (cues) =>
    set({
      subtitles: cues
        .slice(0, MAX_SUBTITLE_CUES)
        .map(normalizeSubtitleCue)
        .filter((cue): cue is SubtitleCue => cue !== null)
        .sort((a, b) => a.start - b.start || a.end - b.end),
    }),

  addSubtitle: (atTime) => {
    const state = get();
    if (state.subtitles.length >= MAX_SUBTITLE_CUES) return null;
    const start = Math.max(0, Number.isFinite(atTime) ? Number(atTime) : state.playhead);
    const id = crypto.randomUUID();
    set({
      subtitles: [...state.subtitles, { id, start, end: start + 2, text: '字幕' }]
        .sort((a, b) => a.start - b.start || a.end - b.end),
    });
    return id;
  },

  updateSubtitle: (id, patch) =>
    set((state) => ({
      subtitles: state.subtitles
        .map((cue) => {
          if (cue.id !== id) return cue;
          const normalized = normalizeSubtitleCue({ ...cue, ...patch, id });
          return normalized ?? cue;
        })
        .sort((a, b) => a.start - b.start || a.end - b.end),
    })),

  removeSubtitle: (id) =>
    set((state) => ({ subtitles: state.subtitles.filter((cue) => cue.id !== id) })),

  setSubtitleStyle: (patch) =>
    set((state) => ({
      subtitleStyle: {
        ...state.subtitleStyle,
        ...patch,
        fontSize: Math.max(
          2,
          Math.min(
            12,
            Number.isFinite(patch.fontSize)
              ? Number(patch.fontSize)
              : state.subtitleStyle.fontSize,
          ),
        ),
        position: ['top', 'center', 'bottom'].includes(
          patch.position ?? state.subtitleStyle.position,
        )
          ? (patch.position ?? state.subtitleStyle.position)
          : state.subtitleStyle.position,
      },
    })),

  splitSelectedAtPlayhead: () => {
    const { selectedClipIds, playhead, splitClipAt } = get();
    selectedClipIds.forEach((id) => splitClipAt(id, playhead));
  },

  setIsPlaying: (playing) => set({ isPlaying: playing }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),

  toggleTrackLocked: (trackId) =>
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, locked: !t.locked } : t,
      ),
    })),
  toggleTrackMuted: (trackId) =>
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, muted: !t.muted } : t,
      ),
    })),
  toggleTrackHidden: (trackId) =>
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, hidden: !t.hidden } : t,
      ),
    })),
  addTrack: (kind) => {
    const state = get();
    if (!['video', 'overlay', 'audio'].includes(kind) || state.tracks.length >= MAX_TRACKS) {
      return null;
    }
    const count = state.tracks.filter((track) => track.kind === kind).length + 1;
    const baseLabel =
      kind === 'video' ? '映像' : kind === 'overlay' ? 'オーバーレイ' : '音声';
    const id = crypto.randomUUID();
    const track: Track = {
      id,
      kind,
      label: `${baseLabel} ${count}`,
      locked: false,
      muted: false,
      hidden: false,
    };
    const lastVisualIndex = state.tracks.reduce(
      (last, candidate, index) =>
        candidate.kind === 'video' || candidate.kind === 'overlay' ? index : last,
      -1,
    );
    const insertAt = kind === 'audio' ? state.tracks.length : lastVisualIndex + 1;
    set({
      tracks: [
        ...state.tracks.slice(0, insertAt),
        track,
        ...state.tracks.slice(insertAt),
      ],
    });
    return id;
  },
  renameTrack: (trackId, label) => {
    const nextLabel = label.trim().slice(0, MAX_TRACK_LABEL_LENGTH);
    if (!nextLabel || !get().tracks.some((track) => track.id === trackId)) return false;
    set((state) => ({
      tracks: state.tracks.map((track) =>
        track.id === trackId ? { ...track, label: nextLabel } : track,
      ),
    }));
    return true;
  },
  moveTrack: (trackId, direction) => {
    const state = get();
    const index = state.tracks.findIndex((track) => track.id === trackId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= state.tracks.length) return false;
    const tracks = [...state.tracks];
    [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
    set({ tracks });
    return true;
  },
  duplicateTrack: (trackId) => {
    const state = get();
    if (state.tracks.length >= MAX_TRACKS) return null;
    const index = state.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) return null;
    const sourceTrack = state.tracks[index];
    const sourceClips = state.clips.filter((clip) => clip.trackId === trackId);
    if (sourceClips.length > MAX_PROJECT_CLIPS - state.clips.length) return null;
    const id = crypto.randomUUID();
    const track: Track = {
      ...sourceTrack,
      id,
      label: `${sourceTrack.label} コピー`.slice(0, MAX_TRACK_LABEL_LENGTH),
      locked: false,
    };
    const duplicatedClips = sourceClips
      .map((clip) => ({
        ...clip,
        id: crypto.randomUUID(),
        trackId: id,
        effects: clip.effects.map((effect) => ({ ...effect })),
        overlays: clip.overlays?.map((overlay) => ({
          ...overlay,
          id: crypto.randomUUID(),
        })),
      }));
    set({
      tracks: [
        ...state.tracks.slice(0, index + 1),
        track,
        ...state.tracks.slice(index + 1),
      ],
      clips: [...state.clips, ...duplicatedClips],
      selectedClipIds: duplicatedClips.map((clip) => clip.id),
    });
    return id;
  },
  removeTrack: (trackId) => {
    const state = get();
    const track = state.tracks.find((candidate) => candidate.id === trackId);
    if (!track) return false;
    if (
      track.kind === 'video' &&
      state.tracks.filter((candidate) => candidate.kind === 'video').length <= 1
    ) {
      return false;
    }
    const removedClipIds = new Set(
      state.clips.filter((clip) => clip.trackId === trackId).map((clip) => clip.id),
    );
    set({
      tracks: state.tracks.filter((candidate) => candidate.id !== trackId),
      clips: state.clips.filter((clip) => clip.trackId !== trackId),
      selectedClipIds: state.selectedClipIds.filter((id) => !removedClipIds.has(id)),
    });
    return true;
  },
  setSnapIndicator: (indicator) => set({ snapIndicator: indicator }),

  addKillMarker: (assetId, time, label) => {
    const id = crypto.randomUUID();
    const marker: KillMarker = {
      id,
      assetId,
      time: isFiniteNumber(time) ? Math.max(0, time) : 0,
      label,
    };
    set((state) => ({
      markers: [...state.markers, marker].sort((a, b) =>
        a.assetId === b.assetId ? a.time - b.time : a.assetId.localeCompare(b.assetId),
      ),
      selectedMarkerId: id,
    }));
    return id;
  },

  removeKillMarker: (markerId) => {
    set((state) => ({
      markers: state.markers.filter((m) => m.id !== markerId),
      selectedMarkerId:
        state.selectedMarkerId === markerId ? null : state.selectedMarkerId,
    }));
  },

  moveKillMarker: (markerId, newTime) => {
    if (!isFiniteNumber(newTime)) return;
    set((state) => ({
      markers: state.markers.map((m) =>
        m.id === markerId ? { ...m, time: Math.max(0, newTime) } : m,
      ),
    }));
  },

  removeNearestMarker: (assetId, time, toleranceSec) => {
    const state = get();
    const candidates = state.markers
      .filter((m) => m.assetId === assetId)
      .map((m) => ({ marker: m, dist: Math.abs(m.time - time) }))
      .filter(({ dist }) => dist <= toleranceSec)
      .sort((a, b) => a.dist - b.dist);
    const target = candidates[0]?.marker;
    if (!target) return false;
    set({
      markers: state.markers.filter((m) => m.id !== target.id),
      selectedMarkerId:
        state.selectedMarkerId === target.id ? null : state.selectedMarkerId,
    });
    return true;
  },

  selectMarker: (markerId) => set({ selectedMarkerId: markerId }),

  setPreRoll: (sec) => {
    if (isFiniteNumber(sec)) set({ preRollSec: Math.max(0, sec) });
  },
  setPostRoll: (sec) => {
    if (isFiniteNumber(sec)) set({ postRollSec: Math.max(0, sec) });
  },

  autoClipFromMarkers: (assetId, options) => {
    if (
      !isFiniteNumber(options.preRoll) ||
      !isFiniteNumber(options.postRoll) ||
      options.preRoll < 0 ||
      options.postRoll < 0
    ) {
      return 0;
    }
    const state = get();
    const assetDuration = useMediaStore
      .getState()
      .assets.find((asset) => asset.id === assetId)?.duration;
    if (!assetDuration || !Number.isFinite(assetDuration)) return 0;
    const markers = state.markers
      .filter((m) => m.assetId === assetId)
      .sort((a, b) => a.time - b.time);
    if (markers.length === 0) return 0;

    const videoTrack = state.tracks.find(
      (track) =>
        track.kind === 'video' &&
        !track.hidden &&
        !track.locked,
    );
    if (!videoTrack) return 0;
    const videoTrackId = videoTrack.id;

    // Optionally drop existing clips of this asset on the video track.
    let baseClips = state.clips;
    if (options.deleteSourceClips) {
      baseClips = state.clips.filter(
        (c) => !(c.trackId === videoTrackId && c.assetId === assetId),
      );
    }

    const available = Math.max(0, MAX_PROJECT_CLIPS - baseClips.length);
    if (available === 0) return 0;

    // Start placement after the last existing clip on the video track.
    const sameTrack = baseClips.filter((c) => c.trackId === videoTrackId);
    let cursor = sameTrack.reduce(
      (m, c) => Math.max(m, c.start + clipDuration(c)),
      0,
    );

    const newClips: Clip[] = [];
    for (const m of markers) {
      if (newClips.length >= available) break;
      const trimStart = Math.min(assetDuration, Math.max(0, m.time - options.preRoll));
      const trimEnd = Math.min(assetDuration, m.time + options.postRoll);
      if (trimEnd <= trimStart + 0.05) continue;
      const id = crypto.randomUUID();
      const dur = trimEnd - trimStart;
      newClips.push({
        id,
        trackId: videoTrackId,
        assetId,
        start: cursor,
        trimStart,
        trimEnd,
        effects: [],
      });
      cursor += dur;
    }

    // A zero-length pre/post roll (or markers at a clamped boundary) can
    // legitimately produce no valid clips. Do not let a "0 created" result
    // erase the user's source clips.
    if (newClips.length === 0) return 0;
    set({
      clips: [...baseClips, ...newClips],
      selectedClipIds: newClips.map((c) => c.id),
    });
    return newClips.length;
  },

  syncKillsToBeats: (maxShiftSec = 0.45) => {
    const state = get();
    const suggestions = buildKillBeatSyncSuggestions({
      clips: state.clips,
      tracks: state.tracks,
      markers: state.markers,
      assets: useMediaStore.getState().assets,
      fps: state.fps,
      maxShiftSec,
    });
    if (suggestions.length === 0) return 0;
    set({ clips: applyKillBeatSyncSuggestions(state.clips, suggestions) });
    return suggestions.length;
  },

  setIoIn: (assetId, time) => {
    if (!isFiniteNumber(time)) return;
    set({ pendingIn: { assetId, time: Math.max(0, time) } });
  },

  setIoOut: (assetId, time) => {
    if (!isFiniteNumber(time)) return null;
    const state = get();
    const pending = state.pendingIn;
    if (!pending || pending.assetId !== assetId) {
      // No matching IN — just stash this as pending IN for next press
      set({ pendingIn: { assetId, time: Math.max(0, time) } });
      return null;
    }
    const a = Math.min(pending.time, time);
    const b = Math.max(pending.time, time);
    if (b - a < 0.05) {
      set({ pendingIn: null });
      return null;
    }
    const id = crypto.randomUUID();
    const range: IORange = {
      id,
      assetId,
      inTime: Math.max(0, a),
      outTime: b,
    };
    set({
      ioRanges: [...state.ioRanges, range].sort((rA, rB) =>
        rA.assetId === rB.assetId
          ? rA.inTime - rB.inTime
          : rA.assetId.localeCompare(rB.assetId),
      ),
      pendingIn: null,
      selectedRangeId: id,
    });
    return id;
  },

  clearPendingIn: () => set({ pendingIn: null }),

  removeIoRange: (rangeId) => {
    set((state) => ({
      ioRanges: state.ioRanges.filter((r) => r.id !== rangeId),
      selectedRangeId:
        state.selectedRangeId === rangeId ? null : state.selectedRangeId,
    }));
  },

  removeNearestRange: (assetId, time) => {
    const state = get();
    const candidates = state.ioRanges
      .filter((r) => r.assetId === assetId)
      .filter((r) => time >= r.inTime - 0.5 && time <= r.outTime + 0.5);
    const target = candidates[0];
    if (!target) return false;
    set({
      ioRanges: state.ioRanges.filter((r) => r.id !== target.id),
      selectedRangeId:
        state.selectedRangeId === target.id ? null : state.selectedRangeId,
    });
    return true;
  },

  selectRange: (rangeId) => set({ selectedRangeId: rangeId }),

  extractCurrentRange: () => {
    const state = get();
    if (state.clips.length >= MAX_PROJECT_CLIPS) return null;
    const pending = state.pendingIn;
    if (!pending) return null;
    // Find current source time at playhead via the active video clip,
    // searching ALL video tracks (the project may have multiple).
    const videoTrackIds = new Set(
      state.tracks.filter((t) => t.kind === 'video').map((t) => t.id),
    );
    if (videoTrackIds.size === 0) return null;
    const activeClip = state.clips.find((c) => {
      if (!videoTrackIds.has(c.trackId)) return false;
      if (c.assetId !== pending.assetId) return false;
      const end = c.start + clipDuration(c);
      return state.playhead >= c.start - 1e-6 && state.playhead < end - 1e-6;
    });
    if (!activeClip) return null;
    // Speed-adjust the timeline→source mapping. A 2× clip covers twice
    // the source time per timeline second; omitting this caused IO
    // ranges to land off by (1 - 1/speed) on any time-warped clip.
    const sourceTime = sourceTimeAtTimelineTime(activeClip, state.playhead);
    // Resolve the destination track id from the active clip itself so
    // multi-video-track projects place the new clip on the correct lane.
    const videoTrackId = activeClip.trackId;
    const a = Math.min(pending.time, sourceTime);
    const b = Math.max(pending.time, sourceTime);
    if (b - a < 0.05) return null;

    // Place new clip after existing ones on the video track.
    const sameTrack = state.clips.filter((c) => c.trackId === videoTrackId);
    const cursor = sameTrack.reduce(
      (m, c) => Math.max(m, c.start + clipDuration(c)),
      0,
    );
    const id = crypto.randomUUID();
    const newClip: Clip = {
      id,
      trackId: videoTrackId,
      assetId: pending.assetId,
      start: cursor,
      trimStart: a,
      trimEnd: b,
      effects: [],
    };
    set({
      clips: [...state.clips, newClip],
      pendingIn: null,
      selectedClipIds: [id],
    });
    return id;
  },

  cutFromRanges: (assetId, options) => {
    const state = get();
    const ranges = state.ioRanges
      .filter((r) => r.assetId === assetId)
      .sort((a, b) => a.inTime - b.inTime);
    if (ranges.length === 0) return 0;
    const videoTrack = state.tracks.find(
      (track) =>
        track.kind === 'video' &&
        !track.hidden &&
        !track.locked,
    );
    if (!videoTrack) return 0;
    const videoTrackId = videoTrack.id;

    let baseClips = state.clips;
    if (options.deleteSourceClips) {
      baseClips = state.clips.filter(
        (c) => !(c.trackId === videoTrackId && c.assetId === assetId),
      );
    }

    const available = Math.max(0, MAX_PROJECT_CLIPS - baseClips.length);
    if (available === 0) return 0;

    const sameTrack = baseClips.filter((c) => c.trackId === videoTrackId);
    let cursor = sameTrack.reduce(
      (m, c) => Math.max(m, c.start + clipDuration(c)),
      0,
    );

    const newClips: Clip[] = [];
    for (const r of ranges) {
      if (newClips.length >= available) break;
      const dur = r.outTime - r.inTime;
      if (dur < 0.05) continue;
      newClips.push({
        id: crypto.randomUUID(),
        trackId: videoTrackId,
        assetId,
        start: cursor,
        trimStart: r.inTime,
        trimEnd: r.outTime,
        effects: [],
      });
      cursor += dur;
    }
    // Keep both the source clip and ranges when every candidate was too short.
    // The operation must be transactional: either clips are created, or the
    // project remains unchanged.
    if (newClips.length === 0) return 0;
    set({
      clips: [...baseClips, ...newClips],
      ioRanges: state.ioRanges.filter((r) => r.assetId !== assetId),
      selectedClipIds: newClips.map((c) => c.id),
    });
    return newClips.length;
  },

  showMessage: (kind, text, durationMs = 1800) => {
    const key = Date.now() + Math.random();
    set({ transientMessage: { kind, text, key, durationMs } });
    window.setTimeout(() => {
      const cur = get().transientMessage;
      if (cur && cur.key === key) set({ transientMessage: null });
    }, durationMs);
  },
  clearMessage: () => set({ transientMessage: null }),

  setClipEffects: (clipId, effects) => {
    if (!hasOnlyFiniteNumbers(effects)) return;
    const normalized = effects
      .slice(0, MAX_CLIP_EFFECTS)
      .map(normalizeClipEffect);
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return {
        clips: state.clips.map((c) =>
          c.id === clipId ? { ...c, effects: normalized } : c,
        ),
      };
    });
  },

  toggleClipEffect: (clipId, type) => {
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return { clips: state.clips.map((c) => {
        if (c.id !== clipId) return c;
        const has = c.effects.some((e) => e.type === type);
        if (has) {
          return { ...c, effects: c.effects.filter((e) => e.type !== type) };
        }
        const defaults: Record<
          import('../lib/types').ClipEffectType,
          import('../lib/types').ClipEffect
        > = {
          'fade-in': { type: 'fade-in', duration: 0.4 },
          'fade-out': { type: 'fade-out', duration: 0.4 },
          'motion-blur': { type: 'motion-blur', intensity: 40 },
        };
        if (c.effects.length >= MAX_CLIP_EFFECTS) return c;
        return { ...c, effects: [...c.effects, defaults[type]] };
      }) };
    });
  },

  updateClipEffect: (clipId, type, patch) => {
    if (
      (patch.duration !== undefined && !isFiniteNumber(patch.duration)) ||
      (patch.intensity !== undefined && !isFiniteNumber(patch.intensity))
    ) {
      return;
    }
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return { clips: state.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          effects: c.effects.map((e) =>
            e.type === type ? normalizeClipEffect({ ...e, ...patch }) : e,
          ),
        };
      }) };
    });
  },

  setClipSpeed: (clipId, speed) => {
    if (!isFiniteNumber(speed)) return;
    const clamped = Math.max(0.0625, Math.min(4, speed));
    set((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return state;
      const track = state.tracks.find((t) => t.id === target.trackId);
      if (track?.locked) return state;
      const oldDuration = clipDuration(target);
      const updatedTarget = { ...target, speed: clamped };
      const delta = clipDuration(updatedTarget) - oldDuration;
      const oldEnd = target.start + oldDuration;
      return {
        // Ripple later clips on the same track by the duration delta. This
        // preserves gaps and prevents a slower clip from silently overlapping
        // its neighbour (preview/export otherwise disagree on which wins).
        clips: state.clips.map((c) => {
          if (c.id === clipId) return updatedTarget;
          if (
            c.trackId === target.trackId &&
            c.start >= oldEnd - 1e-6 &&
            Math.abs(delta) > 1e-9
          ) {
            return { ...c, start: Math.max(0, c.start + delta) };
          }
          return c;
        }),
      };
    });
  },

  setClipSpeedRamp: (clipId, ramp) => {
    if (
      ramp !== null &&
      (!isFiniteNumber(ramp.from) || !isFiniteNumber(ramp.to))
    ) {
      return;
    }
    set((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return state;
      const track = state.tracks.find((t) => t.id === target.trackId);
      if (track?.locked) return state;
      return {
        clips: state.clips.map((c) => {
          if (c.id !== clipId) return c;
          if (ramp === null) {
            // Drop the ramp entirely so the clip reverts to constant speed and
            // serialises back to a ramp-free (backward-compatible) shape.
            const { speedRamp: _drop, ...rest } = c;
            void _drop;
            return rest;
          }
          // Clamp the relative weights to a sane positive range so a
          // hand-edited / extreme value can't drive playbackRate to 0.
          const clampWeight = (n: number): number =>
            Math.max(0.0625, Math.min(8, n));
          return {
            ...c,
            speedRamp: {
              from: clampWeight(ramp.from),
              to: clampWeight(ramp.to),
              easing: ramp.easing,
            },
          };
        }),
      };
    });
  },

  setClipVolume: (clipId, volume) => {
    if (!isFiniteNumber(volume)) return;
    const clamped = Math.max(0, Math.min(2, volume));
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return {
        clips: state.clips.map((c) =>
          c.id === clipId ? { ...c, volume: clamped } : c,
        ),
      };
    });
  },

  setClipAudioProcessing: (clipId, processing) => {
    const clampDb = (value: number | undefined) => {
      const finite = Number.isFinite(value) ? Number(value) : 0;
      return Math.max(-12, Math.min(12, finite));
    };
    const highPass = Number(processing?.highPassHz ?? 0);
    const normalized = processing
      ? {
          highPassHz:
            Number.isFinite(highPass) && highPass > 0
              ? Math.max(40, Math.min(300, highPass))
              : 0,
          lowGainDb: clampDb(processing.lowGainDb),
          midGainDb: clampDb(processing.midGainDb),
          highGainDb: clampDb(processing.highGainDb),
          compressor: processing.compressor === true,
        }
      : undefined;
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return {
        clips: state.clips.map((clip) =>
          clip.id === clipId ? { ...clip, audioProcessing: normalized } : clip,
        ),
      };
    });
  },

  setClipStretch: (clipId, stretchToFill) => {
    set((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return state;
      const track = state.tracks.find((t) => t.id === target.trackId);
      if (track?.locked) return state;
      return {
        clips: state.clips.map((c) =>
          c.id === clipId ? { ...c, stretchToFill } : c,
        ),
      };
    });
  },

  setClipTransform: (clipId, transform) => {
    if (!isSerializableTransform(transform)) return;
    set((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return state;
      const track = state.tracks.find((t) => t.id === target.trackId);
      if (track?.locked) return state;
      return {
        clips: state.clips.map((c) =>
          c.id === clipId ? { ...c, transform } : c,
        ),
      };
    });
  },

  setClipColorGrade: (clipId, grade) => {
    if (grade !== null && !hasOnlyFiniteNumbers(grade)) return;
    set((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return state;
      const track = state.tracks.find((t) => t.id === target.trackId);
      if (track?.locked) return state;
      return {
        clips: state.clips.map((c) => {
          if (c.id !== clipId) return c;
          if (grade === null) {
            // Drop the grade entirely so the clip reverts to neutral and
            // serialises back to a grade-free (backward-compatible) shape.
            const { colorGrade: _drop, ...rest } = c;
            void _drop;
            return rest;
          }
          return { ...c, colorGrade: grade };
        }),
      };
    });
  },

  setClipTransition: (clipId, edge, transition) => {
    if (transition !== null && !hasOnlyFiniteNumbers(transition)) return;
    const normalized = transition === null
      ? null
      : { ...transition, duration: Math.max(0, transition.duration) };
    set((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return state;
      const track = state.tracks.find((t) => t.id === target.trackId);
      if (track?.locked) return state;
      const key = edge === 'in' ? 'transitionIn' : 'transitionOut';
      return {
        clips: state.clips.map((c) => {
          if (c.id !== clipId) return c;
          if (normalized === null || normalized.type === 'none') {
            // Drop the boundary transition entirely so the clip reverts to a
            // hard cut and serialises back to a transition-free (backward-
            // compatible) shape.
            const { [key]: _drop, ...rest } = c;
            void _drop;
            return rest;
          }
          return { ...c, [key]: normalized };
        }),
      };
    });
  },

  toggleClipMuted: (clipId) => {
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return {
        clips: state.clips.map((c) =>
          c.id === clipId ? { ...c, muted: !c.muted } : c,
        ),
      };
    });
  },

  addClipOverlay: (clipId, overlay) => {
    const normalized = normalizeOverlay(overlay);
    if (!normalized) return;
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return {
        clips: state.clips.map((c) =>
          c.id === clipId && (c.overlays?.length ?? 0) < MAX_CLIP_OVERLAYS
            ? { ...c, overlays: [...(c.overlays ?? []), normalized] }
            : c,
        ),
      };
    });
  },

  updateClipOverlay: (clipId, overlayId, patch) => {
    if (!hasOnlyFiniteNumbers(patch)) return;
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return { clips: state.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          overlays: (c.overlays ?? []).map((o) =>
            o.id === overlayId ? (normalizeOverlay({ ...o, ...patch }) ?? o) : o,
          ),
        };
      }) };
    });
  },

  removeClipOverlay: (clipId, overlayId) => {
    set((state) => {
      if (!isClipEditable(state, clipId)) return state;
      return { clips: state.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          overlays: (c.overlays ?? []).filter((o) => o.id !== overlayId),
        };
      }) };
    });
  },

  applyOverlayToClips: (clipIds, overlay) => {
    const normalized = normalizeOverlay(overlay);
    if (!normalized) return;
    const targetIds = new Set(clipIds);
    set((state) => {
      const lockedTrackIds = new Set(
        state.tracks.filter((track) => track.locked).map((track) => track.id),
      );
      return { clips: state.clips.map((c) =>
        targetIds.has(c.id) &&
        !lockedTrackIds.has(c.trackId) &&
        (c.overlays?.length ?? 0) < MAX_CLIP_OVERLAYS
          ? {
              ...c,
              overlays: [
                ...(c.overlays ?? []),
                { ...normalized, id: crypto.randomUUID() },
              ],
            }
          : c,
      ) };
    });
  },

  applyPresetToClips: (clipIds, look) => {
    if (!isValidClipLook(look)) return 0;
    const targetIds = new Set(clipIds);
    let applied = 0;
    set((state) => {
      const lockedTrackIds = new Set(
        state.tracks.filter((t) => t.locked).map((t) => t.id),
      );
      const clips = state.clips.map((c) => {
        if (!targetIds.has(c.id)) return c;
        if (lockedTrackIds.has(c.trackId)) return c; // skip locked tracks
        applied += 1;
        return applyClipLook(c, look);
      });
      return applied > 0 ? { clips } : state;
    });
    return applied;
  },

  loadProject: (file, idMap) => {
    const remap = <T extends { assetId: string }>(items: T[]): T[] =>
      items.map((it) => ({ ...it, assetId: idMap[it.assetId] ?? it.assetId }));
    set({
      name: file.name,
      aspectRatio: file.aspectRatio,
      fps: file.fps,
      resolution: file.resolution,
      tracks: file.tracks,
      clips: remap(file.clips),
      markers: remap(file.markers),
      subtitles: file.subtitles ?? [],
      subtitleStyle: file.subtitleStyle ?? { ...DEFAULT_SUBTITLE_STYLE },
      ioRanges: remap(file.ioRanges),
      preRollSec: file.preRollSec,
      postRollSec: file.postRollSec,
      // Absent in old files → undefined (no ducking). Backward compatible.
      audioDucking: file.audioDucking,
      hudPreset: file.hudPreset ?? 'valorant',
      verticalReframe: file.verticalReframe ?? 0,
      selectedClipIds: [],
      selectedMarkerId: null,
      selectedRangeId: null,
      pendingIn: null,
      playhead: 0,
      isPlaying: false,
      // Track expected assets so we can auto-relink as the user uploads them.
      expectedAssets: file.assets,
    });
  },

  remapAssetIds: (idMap) => {
    if (Object.keys(idMap).length === 0) return;
    set((state) => ({
      clips: state.clips.map((c) => ({
        ...c,
        assetId: idMap[c.assetId] ?? c.assetId,
      })),
      markers: state.markers.map((m) => ({
        ...m,
        assetId: idMap[m.assetId] ?? m.assetId,
      })),
      ioRanges: state.ioRanges.map((r) => ({
        ...r,
        assetId: idMap[r.assetId] ?? r.assetId,
      })),
      // Update expectedAssets entries we've successfully matched, so they
      // are no longer reported as missing.
      expectedAssets: state.expectedAssets.filter(
        (a) => !(a.id in idMap),
      ),
    }));
  },

  clearExpectedAssets: () => set({ expectedAssets: [] }),

  jumpToAdjacentMarker: (direction) => {
    const state = get();
    // Search across ALL video tracks for the clip under the playhead.
    // Restricting to `tracks[0]` only would miss clips placed on the
    // secondary video track (track-video-2) in the multi-track layout.
    const videoTrackIds = new Set(
      state.tracks.filter((t) => t.kind === 'video').map((t) => t.id),
    );
    if (videoTrackIds.size === 0) return;
    const activeClip = state.clips.find((c) => {
      if (!videoTrackIds.has(c.trackId)) return false;
      const end = c.start + clipDuration(c);
      return state.playhead >= c.start - 1e-6 && state.playhead < end - 1e-6;
    });
    if (!activeClip) return;
    // Speed-adjust the timeline→source mapping (timeline 1s = source `speed`s).
    const localTime = sourceTimeAtTimelineTime(activeClip, state.playhead);
    const sourceMarkers = state.markers
      .filter((m) => m.assetId === activeClip.assetId)
      .sort((a, b) => a.time - b.time);
    if (sourceMarkers.length === 0) return;
    let target: KillMarker | undefined;
    if (direction === 'next') {
      target = sourceMarkers.find((m) => m.time > localTime + 1e-3);
    } else {
      target = [...sourceMarkers].reverse().find((m) => m.time < localTime - 1e-3);
    }
    if (!target) return;
    // Reverse mapping: source seconds → timeline seconds via /speed.
    const newPlayhead = timelineTimeAtSourceTime(activeClip, target.time);
    set({ playhead: Math.max(0, newPlayhead), selectedMarkerId: target.id });
  },
    }),
    {
      partialize: partializeDoc,
      equality: docEqual,
      limit: 100,
      handleSet: (handleSet) => {
        const pending = debounce(handleSet, 150);
        cancelPendingHistory = pending.cancel;
        return pending;
      },
    },
  ),
);

// Derive the reduced number INSIDE the selector so Zustand's Object.is
// comparison runs on the scalar result rather than the clips array. The
// previous form (subscribe to clips, then reduce in component body) caused
// every Preview / WaveformPanel / ExportDialog to re-render on every clip
// mutation (slider drag = 60/s), even when the duration was unchanged.
export const useTimelineDuration = (): number =>
  useProjectStore((s) =>
    s.clips.reduce((max, c) => Math.max(max, c.start + clipDuration(c)), 0),
  );

// --- Undo / redo public API -------------------------------------------------
/** Revert the last document edit. */
export const undo = (): void => useProjectStore.temporal.getState().undo();
/** Re-apply the last undone edit. */
export const redo = (): void => useProjectStore.temporal.getState().redo();
/** Clear undo/redo history (e.g. after loading a project). */
export const clearHistory = (): void => {
  cancelPendingHistory();
  useProjectStore.temporal.getState().clear();
};

/** Reactive: is there anything to undo? */
export const useCanUndo = (): boolean =>
  useStore(useProjectStore.temporal, (s) => s.pastStates.length > 0);
/** Reactive: is there anything to redo? */
export const useCanRedo = (): boolean =>
  useStore(useProjectStore.temporal, (s) => s.futureStates.length > 0);

// --- Unsaved-changes tracking ------------------------------------------------
// Compare the actual immutable document fields, not zundo history depth.
// History recording is debounced and can branch after undo, so its array
// length is neither immediate nor a unique identity for the current document.

export interface ProjectSavedBaseline {
  document: DocState;
  assetsFingerprint: string;
}

/** Capture the exact state that is about to be serialized for an async save. */
export const captureProjectSavedBaseline = (): ProjectSavedBaseline => ({
  document: partializeDoc(useProjectStore.getState()),
  assetsFingerprint: assetsFingerprint(useMediaStore.getState().assets),
});

/**
 * Mark a successful save/load as the clean baseline.
 *
 * Async native saves must pass the baseline captured before the IPC call.
 * Otherwise edits made while the save dialog/disk write is in progress would
 * be incorrectly marked as saved even though they were not in the written JSON.
 */
export const markProjectSaved = (
  baseline: ProjectSavedBaseline = captureProjectSavedBaseline(),
): void => {
  useProjectStore.setState({
    savedDocument: baseline.document,
    savedAssetsFingerprint: baseline.assetsFingerprint,
  });
};

/** Force the current document to require an explicit save (recovery/fail-safe paths). */
export const markProjectUnsaved = (): void => {
  useProjectStore.setState({ savedDocument: null });
};

/** Reactive: are there unsaved edits since the last save/load? */
export const useIsDirty = (): boolean => {
  const documentDirty = useProjectStore((s) =>
    s.savedDocument === null ? true : !docEqual(partializeDoc(s), s.savedDocument),
  );
  const savedAssetsFingerprint = useProjectStore((s) => s.savedAssetsFingerprint);
  const currentAssetsFingerprint = useMediaStore((s) => assetsFingerprint(s.assets));
  return documentDirty || currentAssetsFingerprint !== savedAssetsFingerprint;
};

/** Non-hook form used by the main-window integration and regression tests. */
export const isProjectDirty = (): boolean => {
  const state = useProjectStore.getState();
  const documentDirty =
    state.savedDocument === null ||
    !docEqual(partializeDoc(state), state.savedDocument);
  return (
    documentDirty ||
    assetsFingerprint(useMediaStore.getState().assets) !== state.savedAssetsFingerprint
  );
};

// The initial empty document is the first clean baseline.
markProjectSaved();
