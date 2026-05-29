import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Clip as ClipType, IORange, KillMarker, MediaAsset, TrackKind } from '../../lib/types';
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { useTimelineAutoScroll } from '../../hooks/useTimelineAutoScroll';
import {
  clipDuration,
  collectSnapPoints,
  pxPerSecond,
  pxToTime,
  snapClipMove,
  snapTime,
  timeToPx,
} from '../../lib/timeline';
import { formatDuration } from '../../lib/media';
import { KillMarkerFlag } from './KillMarkerFlag';
import { IORangeBar, PendingInIndicator } from './IORangeBar';
import { AudioWaveform } from './AudioWaveform';
import styles from './Clip.module.css';

const SNAP_THRESHOLD_PX = 8;

interface ClipProps {
  clip: ClipType;
  zoom: number;
  asset?: MediaAsset;
  kind: TrackKind;
  locked?: boolean;
}

type DragMode = 'move' | 'trim-start' | 'trim-end';

interface DragState {
  mode: DragMode;
  pointerId: number;
  startX: number;
  /** scrollLeft of the timeline container when the drag began. */
  startScroll: number;
  origStart: number;
  origTrimStart: number;
  origTrimEnd: number;
  origSpeed: number;
  assetDuration: number;
}

export const Clip = memo(function Clip({ clip, zoom, asset, kind, locked = false }: ClipProps) {
  const moveClip = useProjectStore((s) => s.moveClip);
  const trimClipStart = useProjectStore((s) => s.trimClipStart);
  const trimClipEnd = useProjectStore((s) => s.trimClipEnd);
  const selectClipAction = useProjectStore((s) => s.selectClip);
  const selectMediaAsset = useMediaStore((s) => s.selectAsset);
  const isSelected = useProjectStore((s) => s.selectedClipIds.includes(clip.id));

  const selectClip = (id: string, additive = false) => {
    selectClipAction(id, additive);
    if (asset && !additive) selectMediaAsset(asset.id);
  };

  const dragRef = useRef<DragState | null>(null);
  const lastClientXRef = useRef(0);
  const lastShiftKeyRef = useRef(false);
  const [draggingMode, setDraggingMode] = useState<DragMode | null>(null);
  const { maybeScroll, stopAutoScroll, getScrollLeft, onScrollTick } =
    useTimelineAutoScroll();

  const left = timeToPx(clip.start, zoom);
  const width = Math.max(8, timeToPx(clipDuration(clip), zoom));

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, mode: DragMode) => {
    e.stopPropagation();
    e.preventDefault();
    if (!asset) return;
    selectClip(clip.id, e.shiftKey);
    if (locked) return;

    dragRef.current = {
      mode,
      pointerId: e.pointerId,
      startX: e.clientX,
      startScroll: getScrollLeft(),
      origStart: clip.start,
      origTrimStart: clip.trimStart,
      origTrimEnd: clip.trimEnd,
      origSpeed: clip.speed ?? 1,
      assetDuration: asset.duration,
    };
    lastClientXRef.current = e.clientX;
    lastShiftKeyRef.current = e.shiftKey;
    onScrollTick(applyDrag);
    setDraggingMode(mode);
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };

  // Core drag-update routine. Reads the latest cursor position from refs so
  // both real pointermove events and auto-scroll rAF ticks can drive it.
  const applyDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    const clientX = lastClientXRef.current;
    const shiftKey = lastShiftKeyRef.current;
    // Compose pointer delta (screen-space) with scroll delta (content-space)
    // so the clip tracks the cursor's content position even as auto-scroll
    // moves the viewport under it.
    const scrollDelta = getScrollLeft() - drag.startScroll;
    const deltaPx = clientX - drag.startX + scrollDelta;
    const deltaSec = pxToTime(deltaPx, zoom);

    const state = useProjectStore.getState();
    const useSnap = state.snapEnabled && !shiftKey;
    let points = useSnap
      ? collectSnapPoints(state.clips, clip.id, state.playhead)
      : [];

    // Append beat positions from any audio clip on the audio track.
    if (useSnap) {
      const mediaState = useMediaStore.getState();
      const audioTrackId = state.tracks.find((t) => t.kind === 'audio')?.id;
      if (audioTrackId) {
        for (const c of state.clips) {
          if (c.trackId !== audioTrackId) continue;
          const a = mediaState.assets.find((x) => x.id === c.assetId);
          if (!a?.beats) continue;
          const speed = c.speed ?? 1;
          for (const b of a.beats) {
            if (b < c.trimStart - 1e-6 || b > c.trimEnd + 1e-6) continue;
            const t = c.start + (b - c.trimStart) / speed;
            points = [...points, { time: t, type: 'beat' }];
          }
        }
      }
    }

    if (drag.mode === 'move') {
      const desired = drag.origStart + deltaSec;
      const duration = drag.origTrimEnd - drag.origTrimStart;
      const result = useSnap
        ? snapClipMove(desired, duration, points, SNAP_THRESHOLD_PX, zoom)
        : { time: desired, snappedTo: null };
      moveClip(clip.id, result.time);
      state.setSnapIndicator(
        result.snappedTo ? { time: result.snappedTo.time, type: result.snappedTo.type } : null,
      );
    } else if (drag.mode === 'trim-start') {
      // Snap on the clip's left edge (which equals clip.start in timeline coords).
      const desiredEdge = drag.origStart + deltaSec;
      let snappedEdge = desiredEdge;
      let snappedTo: { time: number; type: string } | null = null;
      if (useSnap) {
        const r = snapTime(desiredEdge, points, SNAP_THRESHOLD_PX, zoom);
        snappedEdge = r.time;
        snappedTo = r.snappedTo
          ? { time: r.snappedTo.time, type: r.snappedTo.type }
          : null;
      }
      // Convert timeline-time edge shift to source-time trim shift.
      const adjustedTimelineDelta = snappedEdge - drag.origStart;
      const sourceDelta = adjustedTimelineDelta * drag.origSpeed;
      const next = Math.max(
        0,
        Math.min(drag.origTrimEnd - 0.1, drag.origTrimStart + sourceDelta),
      );
      trimClipStart(clip.id, next);
      state.setSnapIndicator(snappedTo);
    } else if (drag.mode === 'trim-end') {
      // Old timeline right edge = origStart + sourceDur / speed
      const oldRightEdge =
        drag.origStart + (drag.origTrimEnd - drag.origTrimStart) / drag.origSpeed;
      const desiredEdge = oldRightEdge + deltaSec;
      let snappedEdge = desiredEdge;
      let snappedTo: { time: number; type: string } | null = null;
      if (useSnap) {
        const r = snapTime(desiredEdge, points, SNAP_THRESHOLD_PX, zoom);
        snappedEdge = r.time;
        snappedTo = r.snappedTo
          ? { time: r.snappedTo.time, type: r.snappedTo.type }
          : null;
      }
      // New source duration = (snappedEdge - origStart) * speed
      const newSourceDuration =
        (snappedEdge - drag.origStart) * drag.origSpeed;
      const next = Math.max(
        drag.origTrimStart + 0.1,
        Math.min(drag.assetDuration, drag.origTrimStart + newSourceDuration),
      );
      trimClipEnd(clip.id, next);
      state.setSnapIndicator(snappedTo);
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    lastClientXRef.current = e.clientX;
    lastShiftKeyRef.current = e.shiftKey;
    maybeScroll(e.clientX);
    applyDrag();
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
      setDraggingMode(null);
      stopAutoScroll();
      useProjectStore.getState().setSnapIndicator(null);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectClip(clip.id, e.shiftKey);
  };

  const label = asset?.name ?? '(missing media)';
  const showThumbnail = asset?.kind === 'video' && pxPerSecond(zoom) > 24;

  // Use narrowed selectors so this clip only re-renders when markers/ranges
  // for THIS asset (within this trim window) actually change. We subscribe
  // to the stable top-level arrays, then derive the filtered slice with
  // useMemo locally. A direct `.filter(...)` inside the zustand selector
  // would return a fresh array reference on every store tick — Object.is
  // would mark the value as changed and trigger a render loop.
  const assetId = asset?.id;
  const trimStart = clip.trimStart;
  const trimEnd = clip.trimEnd;

  const allMarkers = useProjectStore((s) => s.markers);
  const allRanges = useProjectStore((s) => s.ioRanges);

  const visibleMarkers = useMemo<KillMarker[]>(() => {
    if (!assetId) return [];
    return allMarkers.filter(
      (m) =>
        m.assetId === assetId &&
        m.time >= trimStart - 1e-6 &&
        m.time <= trimEnd + 1e-6,
    );
  }, [allMarkers, assetId, trimStart, trimEnd]);

  const visibleRanges = useMemo<IORange[]>(() => {
    if (!assetId) return [];
    return allRanges.filter(
      (r) =>
        r.assetId === assetId &&
        r.outTime > trimStart - 1e-6 &&
        r.inTime < trimEnd + 1e-6,
    );
  }, [allRanges, assetId, trimStart, trimEnd]);

  const pendingIn = useProjectStore((s) => s.pendingIn);
  const clipSpeed = clip.speed ?? 1;
  const pendingInPx =
    pendingIn &&
    asset &&
    pendingIn.assetId === asset.id &&
    pendingIn.time >= clip.trimStart - 1e-6 &&
    pendingIn.time <= clip.trimEnd + 1e-6
      ? timeToPx((pendingIn.time - clip.trimStart) / clipSpeed, zoom)
      : null;

  return (
    <div
      className={`${styles.clip} ${isSelected ? styles.selected : ''} ${draggingMode ? styles.dragging : ''} ${locked ? styles.locked : ''}`}
      data-kind={kind}
      style={{ left, width }}
      onPointerDown={(e) => startDrag(e, 'move')}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={handleClick}
      role="button"
      tabIndex={0}
    >
      <div
        className={styles.handleStart}
        onPointerDown={(e) => startDrag(e, 'trim-start')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={locked ? { display: 'none' } : undefined}
      />
      <div className={styles.body}>
        {showThumbnail && asset?.url ? (
          <video
            src={asset.url}
            className={styles.thumbVideo}
            muted
            playsInline
            preload="metadata"
          />
        ) : null}
        {asset?.kind === 'audio' ? (
          <div className={styles.waveformWrap}>
            <AudioWaveform
              asset={asset}
              trimStart={clip.trimStart}
              trimEnd={clip.trimEnd}
              width={Math.max(8, width - 12)}
              height={50}
            />
          </div>
        ) : null}
        <div className={styles.label}>
          <span className={styles.labelText}>{label}</span>
          <span className={styles.labelDuration}>{formatDuration(clipDuration(clip))}</span>
        </div>
        {visibleRanges.map((r) => {
          const visibleStart = Math.max(r.inTime, clip.trimStart);
          const visibleEnd = Math.min(r.outTime, clip.trimEnd);
          const leftPx = timeToPx((visibleStart - clip.trimStart) / clipSpeed, zoom);
          const widthPx = timeToPx((visibleEnd - visibleStart) / clipSpeed, zoom);
          if (widthPx <= 0) return null;
          return <IORangeBar key={r.id} range={r} leftPx={leftPx} widthPx={widthPx} />;
        })}
        {pendingInPx !== null ? <PendingInIndicator leftPx={pendingInPx} /> : null}
        {visibleMarkers.map((m) => {
          const offsetSec = (m.time - clip.trimStart) / clipSpeed;
          const localPx = timeToPx(offsetSec, zoom);
          return <KillMarkerFlag key={m.id} marker={m} leftPx={localPx} />;
        })}
      </div>
      <div
        className={styles.handleEnd}
        onPointerDown={(e) => startDrag(e, 'trim-end')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={locked ? { display: 'none' } : undefined}
      />
    </div>
  );
});
