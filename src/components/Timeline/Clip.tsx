import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Clip as ClipType, IORange, KillMarker, MediaAsset, TrackKind } from '../../lib/types';
import { useProjectStore } from '../../stores/projectStore';
import { useShallow } from 'zustand/react/shallow';
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
  timelineTimeAtSourceTime,
} from '../../lib/timeline';
import { formatDuration, formatTimecode } from '../../lib/media';
import { KillMarkerFlag } from './KillMarkerFlag';
import { IORangeBar, PendingInIndicator } from './IORangeBar';
import { AudioWaveform } from './AudioWaveform';
import {
  consumeClipNudgeGesture,
  releasePointerCaptureIfHeld,
} from './timelineCommands';
import styles from './Clip.module.css';

const SNAP_THRESHOLD_PX = 8;

// Stable empty arrays so the "no markers/ranges for this clip" selector result
// is referentially constant across renders (keeps useShallow from re-rendering).
const EMPTY_MARKERS: KillMarker[] = [];
const EMPTY_RANGES: IORange[] = [];

interface ClipProps {
  clip: ClipType;
  zoom: number;
  asset?: MediaAsset;
  kind: TrackKind;
  locked?: boolean;
  keyboardTabStop?: boolean;
  previousClipId?: string;
  nextClipId?: string;
}

type DragMode = 'move' | 'trim-start' | 'trim-end';

interface DragState {
  mode: DragMode;
  pointerId: number;
  captureTarget: HTMLDivElement;
  startX: number;
  /** scrollLeft of the timeline container when the drag began. */
  startScroll: number;
  origStart: number;
  origTrimStart: number;
  origTrimEnd: number;
  origSpeed: number;
  assetDuration: number;
}

export const Clip = memo(function Clip({
  clip,
  zoom,
  asset,
  kind,
  locked = false,
  keyboardTabStop = false,
  previousClipId,
  nextClipId,
}: ClipProps) {
  const moveClip = useProjectStore((s) => s.moveClip);
  const trimClipStart = useProjectStore((s) => s.trimClipStart);
  const trimClipEnd = useProjectStore((s) => s.trimClipEnd);
  const selectClipAction = useProjectStore((s) => s.selectClip);
  const fps = useProjectStore((s) => s.fps);
  const selectMediaAsset = useMediaStore((s) => s.selectAsset);
  const isSelected = useProjectStore((s) => s.selectedClipIds.includes(clip.id));

  const selectClip = (id: string, additive = false) => {
    selectClipAction(id, additive);
    if (asset && !additive) selectMediaAsset(asset.id);
  };

  const dragRef = useRef<DragState | null>(null);
  const clipElementRef = useRef<HTMLDivElement>(null);
  const lastClientXRef = useRef(0);
  const lastShiftKeyRef = useRef(false);
  const [draggingMode, setDraggingMode] = useState<DragMode | null>(null);
  const { maybeScroll, stopAutoScroll, getScrollLeft, onScrollTick } =
    useTimelineAutoScroll();

  const left = timeToPx(clip.start, zoom);
  const width = Math.max(8, timeToPx(clipDuration(clip), zoom));

  const handleTrimKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    edge: 'start' | 'end',
  ) => {
    if (!asset || locked || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    selectClip(clip.id);
    const step = event.shiftKey ? 1 : 0.1;
    if (edge === 'start') {
      const max = clip.trimEnd - 0.1;
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? max
            : Math.max(0, Math.min(max, clip.trimStart + (event.key === 'ArrowRight' ? step : -step)));
      trimClipStart(clip.id, next);
    } else {
      const min = clip.trimStart + 0.1;
      const next =
        event.key === 'Home'
          ? min
          : event.key === 'End'
            ? asset.duration
            : Math.max(
                min,
                Math.min(asset.duration, clip.trimEnd + (event.key === 'ArrowRight' ? step : -step)),
              );
      trimClipEnd(clip.id, next);
    }
  };

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, mode: DragMode) => {
    // Left button only — otherwise a right-click both starts a "move" drag
    // AND (since preventDefault on the pointerdown suppresses the follow-up
    // contextmenu event) silently swallows the right-click menu entirely.
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (!asset) return;
    selectClip(clip.id, e.shiftKey);
    if (locked) return;
    clipElementRef.current?.focus();

    dragRef.current = {
      mode,
      pointerId: e.pointerId,
      captureTarget: e.currentTarget,
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
    const points = useSnap
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
          for (const b of a.beats) {
            if (b < c.trimStart - 1e-6 || b > c.trimEnd + 1e-6) continue;
            const t = timelineTimeAtSourceTime(c, b);
            points.push({ time: t, type: 'beat' });
          }
        }
      }
    }

    if (drag.mode === 'move') {
      const desired = drag.origStart + deltaSec;
      const duration = (drag.origTrimEnd - drag.origTrimStart) / drag.origSpeed;
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
      releasePointerCaptureIfHeld(e.currentTarget, e.pointerId);
      dragRef.current = null;
      setDraggingMode(null);
      stopAutoScroll();
      useProjectStore.getState().setSnapIndicator(null);
    }
  };

  const cancelActiveDrag = () => {
    const drag = dragRef.current;
    if (!drag) return false;
    releasePointerCaptureIfHeld(drag.captureTarget, drag.pointerId);
    if (drag.mode === 'move') {
      moveClip(clip.id, drag.origStart);
    } else if (drag.mode === 'trim-start') {
      trimClipStart(clip.id, drag.origTrimStart);
    } else {
      trimClipEnd(clip.id, drag.origTrimEnd);
    }
    dragRef.current = null;
    setDraggingMode(null);
    stopAutoScroll();
    useProjectStore.getState().setSnapIndicator(null);
    useProjectStore
      .getState()
      .showMessage('info', 'ドラッグ操作を取り消しました', 2200);
    return true;
  };

  const handlePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    cancelActiveDrag();
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectClip(clip.id, e.shiftKey);
  };

  const label = asset?.name ?? '(missing media)';
  const showThumbnail = asset?.kind === 'video' && pxPerSecond(zoom) > 24;
  const [thumbnailVisible, setThumbnailVisible] = useState(false);

  useEffect(() => {
    const element = clipElementRef.current;
    if (!element || !showThumbnail) {
      setThumbnailVisible(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setThumbnailVisible(entry.isIntersecting),
      { rootMargin: '0px 200px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [showThumbnail]);

  // Filter markers/ranges to THIS asset+trim-window inside the selector and
  // shallow-compare the result (useShallow). Adding a kill marker replaces the
  // whole `markers` array, but useShallow keeps this clip from re-rendering
  // unless ITS visible slice actually changed — so pressing M no longer
  // re-renders every clip on the timeline. The stable EMPTY sentinels keep the
  // common "no markers for this clip" result referentially identical.
  const assetId = asset?.id;
  const trimStart = clip.trimStart;
  const trimEnd = clip.trimEnd;

  const visibleMarkers = useProjectStore(
    useShallow((s): KillMarker[] => {
      if (!assetId) return EMPTY_MARKERS;
      const f = s.markers.filter(
        (m) =>
          m.assetId === assetId &&
          m.time >= trimStart - 1e-6 &&
          m.time <= trimEnd + 1e-6,
      );
      return f.length === 0 ? EMPTY_MARKERS : f;
    }),
  );

  const visibleRanges = useProjectStore(
    useShallow((s): IORange[] => {
      if (!assetId) return EMPTY_RANGES;
      const f = s.ioRanges.filter(
        (r) =>
          r.assetId === assetId &&
          r.outTime > trimStart - 1e-6 &&
          r.inTime < trimEnd + 1e-6,
      );
      return f.length === 0 ? EMPTY_RANGES : f;
    }),
  );

  const pendingIn = useProjectStore((s) => s.pendingIn);
  const pendingInPx =
    pendingIn &&
    asset &&
    pendingIn.assetId === asset.id &&
    pendingIn.time >= clip.trimStart - 1e-6 &&
    pendingIn.time <= clip.trimEnd + 1e-6
      ? timeToPx(timelineTimeAtSourceTime(clip, pendingIn.time) - clip.start, zoom)
      : null;

  return (
    <div
      ref={clipElementRef}
      className={`${styles.clip} ${isSelected ? styles.selected : ''} ${draggingMode ? styles.dragging : ''} ${locked ? styles.locked : ''}`}
      data-timeline-clip="true"
      data-kind={kind}
      style={{ left, width }}
      onPointerDown={(e) => startDrag(e, 'move')}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && cancelActiveDrag()) {
          event.preventDefault();
          event.stopPropagation();
        } else if (consumeClipNudgeGesture(event)) {
          selectClip(clip.id);
          if (locked) {
            useProjectStore
              .getState()
              .showMessage('info', 'トラックのロックを解除すると移動できます');
            return;
          }
          const step = event.shiftKey ? 1 : 0.1;
          const requested =
            clip.start + (event.key === 'ArrowRight' ? step : -step);
          moveClip(clip.id, requested);
          const actual =
            useProjectStore.getState().clips.find((item) => item.id === clip.id)
              ?.start ?? clip.start;
          useProjectStore
            .getState()
            .showMessage(
              Math.abs(actual - clip.start) > 1e-6 ? 'success' : 'info',
              Math.abs(actual - clip.start) > 1e-6
                ? `${label}を${formatTimecode(
                    actual,
                    useProjectStore.getState().fps,
                  )}へ移動`
                : '隣のクリップまたは先頭に接しているため、これ以上移動できません',
              1800,
            );
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          selectClip(clip.id, event.shiftKey);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          const targetId = event.key === 'ArrowLeft' ? previousClipId : nextClipId;
          if (!targetId) return;
          const target = [...document.querySelectorAll<HTMLElement>('[data-timeline-clip="true"]')]
            .find((element) => element.dataset.clipId === targetId);
          target?.focus();
          target?.click();
        }
      }}
      role="group"
      data-clip-id={clip.id}
      tabIndex={keyboardTabStop ? 0 : -1}
      aria-current={isSelected ? 'true' : undefined}
      aria-roledescription="タイムラインクリップ"
      aria-label={`${label}、${formatDuration(clipDuration(clip))}、Enterで選択、左右矢印で前後のクリップ、Alt+左右矢印で位置を移動`}
    >
      {!locked && asset ? (
        <div
          className={styles.handleStart}
          onPointerDown={(e) => startDrag(e, 'trim-start')}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onKeyDown={(event) => handleTrimKeyDown(event, 'start')}
          role="slider"
          tabIndex={isSelected ? 0 : -1}
          aria-label={`${label}の開始位置`}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, clip.trimEnd - 0.1)}
          aria-valuenow={clip.trimStart}
          aria-valuetext={formatTimecode(clip.trimStart, fps)}
        />
      ) : null}
      <div className={styles.body}>
        {showThumbnail && thumbnailVisible && asset?.url ? (
          <video
            src={asset.url}
            crossOrigin="anonymous"
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
          const localStart = timelineTimeAtSourceTime(clip, visibleStart) - clip.start;
          const localEnd = timelineTimeAtSourceTime(clip, visibleEnd) - clip.start;
          const leftPx = timeToPx(localStart, zoom);
          const widthPx = timeToPx(localEnd - localStart, zoom);
          if (widthPx <= 0) return null;
          return (
            <IORangeBar
              key={r.id}
              range={r}
              leftPx={leftPx}
              widthPx={widthPx}
              focusable={isSelected}
            />
          );
        })}
        {pendingInPx !== null ? <PendingInIndicator leftPx={pendingInPx} /> : null}
        {visibleMarkers.map((m) => {
          const offsetSec = timelineTimeAtSourceTime(clip, m.time) - clip.start;
          const localPx = timeToPx(offsetSec, zoom);
          return (
            <KillMarkerFlag
              key={m.id}
              marker={m}
              leftPx={localPx}
              focusable={isSelected}
            />
          );
        })}
      </div>
      {!locked && asset ? (
        <div
          className={styles.handleEnd}
          onPointerDown={(e) => startDrag(e, 'trim-end')}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onKeyDown={(event) => handleTrimKeyDown(event, 'end')}
          role="slider"
          tabIndex={isSelected ? 0 : -1}
          aria-label={`${label}の終了位置`}
          aria-valuemin={clip.trimStart + 0.1}
          aria-valuemax={asset.duration}
          aria-valuenow={clip.trimEnd}
          aria-valuetext={formatTimecode(clip.trimEnd, fps)}
        />
      ) : null}
    </div>
  );
});
