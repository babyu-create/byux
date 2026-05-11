import { create } from 'zustand';
import type { Clip, IORange, KillMarker, PendingIn, Track } from '../lib/types';
import {
  clamp,
  clipDuration,
  findFreeSlot,
  nextClipOnTrack,
  prevClipEndOnTrack,
  resolveClipPosition,
} from '../lib/timeline';

const DEFAULT_TRACKS: Track[] = [
  { id: 'track-video', kind: 'video', label: '映像メイン', locked: false, muted: false, hidden: false },
  { id: 'track-overlay', kind: 'overlay', label: 'オーバーレイ', locked: false, muted: false, hidden: false },
  { id: 'track-audio', kind: 'audio', label: 'BGM / SE', locked: false, muted: false, hidden: false },
];

interface ProjectStoreState {
  name: string;
  aspectRatio: '16:9' | '9:16';
  fps: 30 | 60;
  resolution: '720p' | '1080p';
  tracks: Track[];
  clips: Clip[];
  markers: KillMarker[];
  selectedClipIds: string[];
  selectedMarkerId: string | null;
  playhead: number;
  zoom: number;
  snapEnabled: boolean;
  snapIndicator: { time: number; type: string } | null;
  isPlaying: boolean;
  preRollSec: number;
  postRollSec: number;
  ioRanges: IORange[];
  pendingIn: PendingIn | null;
  selectedRangeId: string | null;
  transientMessage: { kind: 'info' | 'error' | 'success'; text: string; key: number } | null;

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
  selectClip: (clipId: string, additive?: boolean) => void;
  clearSelection: () => void;
  setPlayhead: (time: number) => void;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  toggleSnap: () => void;
  splitSelectedAtPlayhead: () => void;
  setIsPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  toggleTrackLocked: (trackId: string) => void;
  toggleTrackMuted: (trackId: string) => void;
  toggleTrackHidden: (trackId: string) => void;
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
  setClipVolume: (clipId: string, volume: number) => void;
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
  loadProject: (file: import('../lib/project').ProjectFile, idMap: Record<string, string>) => void;
  /** Pending asset references from a loaded project, used to auto-relink later. */
  expectedAssets: import('../lib/project').ProjectAssetRef[];
  remapAssetIds: (idMap: Record<string, string>) => void;
  clearExpectedAssets: () => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const MIN_CLIP_DURATION = 0.1;

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  name: 'untitled',
  aspectRatio: '16:9',
  fps: 60,
  resolution: '1080p',
  tracks: DEFAULT_TRACKS,
  clips: [],
  markers: [],
  selectedClipIds: [],
  selectedMarkerId: null,
  playhead: 0,
  zoom: 1,
  snapEnabled: true,
  snapIndicator: null,
  isPlaying: false,
  preRollSec: 3,
  postRollSec: 1,
  ioRanges: [],
  pendingIn: null,
  selectedRangeId: null,
  transientMessage: null,
  expectedAssets: [],

  addClipFromAsset: (assetId, trackId, durationSec, atTime) => {
    if (durationSec <= 0) return null;
    const id = crypto.randomUUID();
    const state = get();
    const sameTrackClips = state.clips.filter((c) => c.trackId === trackId);
    const preferred =
      atTime !== undefined
        ? Math.max(0, atTime)
        : sameTrackClips.reduce(
            (max, c) => Math.max(max, c.start + clipDuration(c)),
            0,
          );
    const start = findFreeSlot(sameTrackClips, durationSec, preferred);

    const clip: Clip = {
      id,
      trackId,
      assetId,
      start,
      trimStart: 0,
      trimEnd: durationSec,
      effects: [],
    };
    set({ clips: [...state.clips, clip], selectedClipIds: [id] });
    return id;
  },

  moveClip: (clipId, newStart) => {
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
    set((state) => {
      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip) return state;
      const track = state.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return state;
      const speed = clip.speed ?? 1;
      const localOffset = atTime - clip.start; // timeline-time
      const sourceTime = clip.trimStart + localOffset * speed; // source-time
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
  setPlayhead: (time) => set({ playhead: Math.max(0, time) }),
  setZoom: (zoom) => set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) }),
  zoomIn: () => set((s) => ({ zoom: clamp(s.zoom * 1.4, MIN_ZOOM, MAX_ZOOM) })),
  zoomOut: () => set((s) => ({ zoom: clamp(s.zoom / 1.4, MIN_ZOOM, MAX_ZOOM) })),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),

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
  setSnapIndicator: (indicator) => set({ snapIndicator: indicator }),

  addKillMarker: (assetId, time, label) => {
    const id = crypto.randomUUID();
    const marker: KillMarker = {
      id,
      assetId,
      time: Math.max(0, time),
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

  setPreRoll: (sec) => set({ preRollSec: Math.max(0, sec) }),
  setPostRoll: (sec) => set({ postRollSec: Math.max(0, sec) }),

  autoClipFromMarkers: (assetId, options) => {
    const state = get();
    const asset = { id: assetId };
    const markers = state.markers
      .filter((m) => m.assetId === assetId)
      .sort((a, b) => a.time - b.time);
    if (markers.length === 0) return 0;

    const videoTrackId =
      state.tracks.find((t) => t.kind === 'video')?.id ?? 'track-video';

    // Optionally drop existing clips of this asset on the video track.
    let baseClips = state.clips;
    if (options.deleteSourceClips) {
      baseClips = state.clips.filter(
        (c) => !(c.trackId === videoTrackId && c.assetId === assetId),
      );
    }

    // Start placement after the last existing clip on the video track.
    const sameTrack = baseClips.filter((c) => c.trackId === videoTrackId);
    let cursor = sameTrack.reduce(
      (m, c) => Math.max(m, c.start + clipDuration(c)),
      0,
    );

    const newClips: Clip[] = [];
    for (const m of markers) {
      const trimStart = Math.max(0, m.time - options.preRoll);
      const trimEnd = m.time + options.postRoll;
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

    set({
      clips: [...baseClips, ...newClips],
      selectedClipIds: newClips.map((c) => c.id),
    });
    void asset;
    return newClips.length;
  },

  setIoIn: (assetId, time) => {
    set({ pendingIn: { assetId, time: Math.max(0, time) } });
  },

  setIoOut: (assetId, time) => {
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
    const pending = state.pendingIn;
    if (!pending) return null;
    // Find current source time at playhead via the active video clip.
    const videoTrackId = state.tracks.find((t) => t.kind === 'video')?.id;
    if (!videoTrackId) return null;
    const activeClip = state.clips.find((c) => {
      if (c.trackId !== videoTrackId) return false;
      if (c.assetId !== pending.assetId) return false;
      const end = c.start + clipDuration(c);
      return state.playhead >= c.start - 1e-6 && state.playhead < end - 1e-6;
    });
    if (!activeClip) return null;
    const sourceTime =
      activeClip.trimStart + (state.playhead - activeClip.start);
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
    const videoTrackId =
      state.tracks.find((t) => t.kind === 'video')?.id ?? 'track-video';

    let baseClips = state.clips;
    if (options.deleteSourceClips) {
      baseClips = state.clips.filter(
        (c) => !(c.trackId === videoTrackId && c.assetId === assetId),
      );
    }

    const sameTrack = baseClips.filter((c) => c.trackId === videoTrackId);
    let cursor = sameTrack.reduce(
      (m, c) => Math.max(m, c.start + clipDuration(c)),
      0,
    );

    const newClips: Clip[] = [];
    for (const r of ranges) {
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
    set({
      clips: [...baseClips, ...newClips],
      ioRanges: state.ioRanges.filter((r) => r.assetId !== assetId),
      selectedClipIds: newClips.map((c) => c.id),
    });
    return newClips.length;
  },

  showMessage: (kind, text, durationMs = 1800) => {
    const key = Date.now() + Math.random();
    set({ transientMessage: { kind, text, key } });
    window.setTimeout(() => {
      const cur = get().transientMessage;
      if (cur && cur.key === key) set({ transientMessage: null });
    }, durationMs);
  },
  clearMessage: () => set({ transientMessage: null }),

  setClipEffects: (clipId, effects) => {
    set((state) => ({
      clips: state.clips.map((c) =>
        c.id === clipId ? { ...c, effects } : c,
      ),
    }));
  },

  toggleClipEffect: (clipId, type) => {
    set((state) => ({
      clips: state.clips.map((c) => {
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
        return { ...c, effects: [...c.effects, defaults[type]] };
      }),
    }));
  },

  updateClipEffect: (clipId, type, patch) => {
    set((state) => ({
      clips: state.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          effects: c.effects.map((e) => (e.type === type ? { ...e, ...patch } : e)),
        };
      }),
    }));
  },

  setClipSpeed: (clipId, speed) => {
    const clamped = Math.max(0.0625, Math.min(4, speed));
    set((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return state;
      const track = state.tracks.find((t) => t.id === target.trackId);
      if (track?.locked) return state;
      const others = state.clips.filter(
        (c) => c.trackId === target.trackId && c.id !== clipId,
      );
      void others;
      return {
        clips: state.clips.map((c) =>
          c.id === clipId ? { ...c, speed: clamped } : c,
        ),
      };
    });
  },

  setClipVolume: (clipId, volume) => {
    const clamped = Math.max(0, Math.min(2, volume));
    set((state) => ({
      clips: state.clips.map((c) =>
        c.id === clipId ? { ...c, volume: clamped } : c,
      ),
    }));
  },

  toggleClipMuted: (clipId) => {
    set((state) => ({
      clips: state.clips.map((c) =>
        c.id === clipId ? { ...c, muted: !c.muted } : c,
      ),
    }));
  },

  addClipOverlay: (clipId, overlay) => {
    set((state) => ({
      clips: state.clips.map((c) =>
        c.id === clipId
          ? { ...c, overlays: [...(c.overlays ?? []), overlay] }
          : c,
      ),
    }));
  },

  updateClipOverlay: (clipId, overlayId, patch) => {
    set((state) => ({
      clips: state.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          overlays: (c.overlays ?? []).map((o) =>
            o.id === overlayId ? { ...o, ...patch } : o,
          ),
        };
      }),
    }));
  },

  removeClipOverlay: (clipId, overlayId) => {
    set((state) => ({
      clips: state.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          overlays: (c.overlays ?? []).filter((o) => o.id !== overlayId),
        };
      }),
    }));
  },

  applyOverlayToClips: (clipIds, overlay) => {
    set((state) => ({
      clips: state.clips.map((c) =>
        clipIds.includes(c.id)
          ? {
              ...c,
              overlays: [
                ...(c.overlays ?? []),
                { ...overlay, id: crypto.randomUUID() },
              ],
            }
          : c,
      ),
    }));
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
      ioRanges: remap(file.ioRanges),
      preRollSec: file.preRollSec,
      postRollSec: file.postRollSec,
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
    // Find the asset at the playhead via the active video clip.
    const videoTrackId = state.tracks.find((t) => t.kind === 'video')?.id;
    if (!videoTrackId) return;
    const activeClip = state.clips.find((c) => {
      if (c.trackId !== videoTrackId) return false;
      const end = c.start + clipDuration(c);
      return state.playhead >= c.start - 1e-6 && state.playhead < end - 1e-6;
    });
    if (!activeClip) return;
    const localTime = activeClip.trimStart + (state.playhead - activeClip.start);
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
    const newPlayhead = activeClip.start + (target.time - activeClip.trimStart);
    set({ playhead: Math.max(0, newPlayhead), selectedMarkerId: target.id });
  },
}));

export const useTimelineDuration = (): number => {
  const clips = useProjectStore((s) => s.clips);
  return clips.reduce(
    (max, c) => Math.max(max, c.start + clipDuration(c)),
    0,
  );
};
