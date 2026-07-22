import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useProjectStore, useTimelineDuration } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { clipDuration, pxToTime, sourceTimeAtTimelineTime, timeToPx } from '../../lib/timeline';
import { formatTimecode } from '../../lib/media';
import { eventToKey, matchAction } from '../../lib/keybindings';
import type { MediaAsset } from '../../lib/types';
import { Ruler } from './Ruler';
import { Track } from './Track';
import { TrackHeader } from './TrackHeader';
import { Playhead } from './Playhead';
import { SnapGuide } from './SnapGuide';
import { TimelineToolbar } from './TimelineToolbar';
import {
  removeSelectedWithFeedback,
  splitSelectedWithFeedback,
  copySelectedWithFeedback,
  pasteAtPlayheadWithFeedback,
  duplicateSelectedWithFeedback,
  rippleDeleteSelectedWithFeedback,
  clipIdsIntersectingTimeRange,
} from './timelineCommands';
import { TimelineScrollProvider } from '../../hooks/useTimelineAutoScroll';
import styles from './Timeline.module.css';

// Memoised track header list — only re-renders when tracks array changes identity
const TrackHeaderList = memo(function TrackHeaderList({
  trackIds,
}: {
  trackIds: string[];
}) {
  const tracks = useProjectStore((s) => s.tracks);
  return (
    <>
      {trackIds.map((id) => {
        const track = tracks.find((t) => t.id === id);
        if (!track) return null;
        return <TrackHeader key={id} track={track} />;
      })}
    </>
  );
});

function xInTrackArea(element: HTMLDivElement, clientX: number): number {
  const rect = element.getBoundingClientRect();
  return Math.max(0, Math.min(rect.width, clientX - rect.left));
}

export function Timeline() {
  const tracks = useProjectStore((s) => s.tracks);
  // NOTE: playhead is NOT subscribed here — Playhead component reads it directly.
  // This prevents all of Timeline from re-rendering on every scrub frame.
  const zoom = useProjectStore((s) => s.zoom);
  const clearSelection = useProjectStore((s) => s.clearSelection);
  const zoomIn = useProjectStore((s) => s.zoomIn);
  const zoomOut = useProjectStore((s) => s.zoomOut);

  const assets = useMediaStore((s) => s.assets);
  const assetsById = useMemo(() => {
    const map: Record<string, MediaAsset> = {};
    assets.forEach((a) => {
      map[a.id] = a;
    });
    return map;
  }, [assets]);

  const duration = useTimelineDuration();
  const minDisplaySec = 30;
  const totalSec = Math.max(duration + 5, minDisplaySec);
  const totalWidth = timeToPx(totalSec, zoom);

  // Stable track id list — only changes when tracks themselves change
  const trackIds = useMemo(() => tracks.map((t) => t.id), [tracks]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const [horizontalScrollbarHeight, setHorizontalScrollbarHeight] = useState(0);
  const marqueeRef = useRef<{
    pointerId: number;
    startX: number;
    currentX: number;
    additive: boolean;
    active: boolean;
  } | null>(null);
  const [marquee, setMarquee] = useState<{ startX: number; currentX: number } | null>(null);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const update = () => {
      setHorizontalScrollbarHeight(
        Math.max(0, scroll.offsetHeight - scroll.clientHeight),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  // Stable callbacks so the keydown effect doesn't re-register on every render
  const stableRemoveSelected = useCallback(
    () => removeSelectedWithFeedback(),
    [],
  );
  const stableSplitSelected = useCallback(
    () => splitSelectedWithFeedback(),
    [],
  );
  const stableRippleDeleteSelected = useCallback(
    () => rippleDeleteSelectedWithFeedback(),
    [],
  );
  const stableZoomIn = useCallback(() => zoomIn(), [zoomIn]);
  const stableZoomOut = useCallback(() => zoomOut(), [zoomOut]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = e.target instanceof Element ? e.target : null;
      const isInsideClip = Boolean(target?.closest('[data-timeline-clip="true"]'));
      if (
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        (!isInsideClip &&
          target?.closest('button, [role="button"], [role="slider"], [role="menuitem"]'))
      ) {
        return;
      }
      const state = useProjectStore.getState();
      const shortcut = eventToKey(e);
      if (shortcut === 'ctrl+c' || shortcut === 'meta+c') {
        e.preventDefault();
        copySelectedWithFeedback();
        return;
      }
      if (shortcut === 'ctrl+v' || shortcut === 'meta+v') {
        e.preventDefault();
        pasteAtPlayheadWithFeedback();
        return;
      }
      if (shortcut === 'ctrl+d' || shortcut === 'meta+d') {
        e.preventDefault();
        duplicateSelectedWithFeedback();
        return;
      }
      if (shortcut === 'ctrl+a' || shortcut === 'meta+a') {
        e.preventDefault();
        state.selectClips(state.clips.map((clip) => clip.id));
        state.showMessage(
          state.clips.length > 0 ? 'success' : 'info',
          state.clips.length > 0
            ? `${state.clips.length}本のクリップを選択しました`
            : '選択できるクリップがありません',
          2200,
        );
        return;
      }
      if (shortcut === 'escape' && state.selectedClipIds.length > 0) {
        e.preventDefault();
        state.clearSelection();
        return;
      }
      const action = matchAction(e);
      if (!action) return;

      // Helpers
      const findVideoActiveClip = () => {
        const visibleVideoTrackIds = new Set(
          state.tracks
            .filter((track) => track.kind === 'video' && !track.hidden)
            .map((track) => track.id),
        );
        if (visibleVideoTrackIds.size === 0) return null;
        return (
          state.clips.find((c) => {
            if (!visibleVideoTrackIds.has(c.trackId)) return false;
            const end = c.start + clipDuration(c);
            return state.playhead >= c.start - 1e-6 && state.playhead < end - 1e-6;
          }) ?? null
        );
      };

      switch (action) {
        case 'playback.toggle':
          e.preventDefault();
          if (
            state.clips.some((clip) =>
              state.tracks.some(
                (track) =>
                  track.id === clip.trackId &&
                  (track.kind === 'video' || track.kind === 'overlay') &&
                  !track.hidden,
              ),
            )
          ) {
            state.togglePlay();
          } else {
            state.showMessage('info', '動画をタイムラインに追加すると再生できます');
          }
          return;
        case 'clip.split':
          if (state.selectedClipIds.length > 0) {
            e.preventDefault();
            stableSplitSelected();
          }
          return;
        case 'clip.delete':
          if (state.selectedClipIds.length > 0) {
            e.preventDefault();
            stableRemoveSelected();
          }
          return;
        case 'clip.rippleDelete':
          if (state.selectedClipIds.length > 0) {
            e.preventDefault();
            stableRippleDeleteSelected();
          }
          return;
        case 'zoom.in':
          e.preventDefault();
          stableZoomIn();
          return;
        case 'zoom.out':
          e.preventDefault();
          stableZoomOut();
          return;
        case 'frame.prev':
          e.preventDefault();
          state.setPlayhead(Math.max(0, state.playhead - 1 / state.fps));
          return;
        case 'frame.next':
          e.preventDefault();
          state.setPlayhead(state.playhead + 1 / state.fps);
          return;
        case 'jump.back':
          e.preventDefault();
          state.setPlayhead(Math.max(0, state.playhead - 5));
          return;
        case 'jump.forward':
          e.preventDefault();
          state.setPlayhead(state.playhead + 5);
          return;
        case 'marker.add': {
          e.preventDefault();
          const ac = findVideoActiveClip();
          if (!ac) {
            state.showMessage('error', 'クリップの上に再生ヘッドを置いてください');
            return;
          }
          const sourceTime = sourceTimeAtTimelineTime(ac, state.playhead);
          state.addKillMarker(ac.assetId, sourceTime);
          state.showMessage('success', `キルマーカー @ ${formatTimecode(sourceTime)}`);
          return;
        }
        case 'marker.deleteNear': {
          e.preventDefault();
          const ac = findVideoActiveClip();
          if (!ac) {
            state.showMessage('error', 'クリップの上に再生ヘッドを置いてください');
            return;
          }
          const sourceTime = sourceTimeAtTimelineTime(ac, state.playhead);
          const removed = state.removeNearestMarker(ac.assetId, sourceTime, 1.0);
          state.showMessage(
            removed ? 'success' : 'info',
            removed ? 'マーカー削除' : '近くにマーカーなし',
          );
          return;
        }
        case 'marker.prev':
          e.preventDefault();
          state.jumpToAdjacentMarker('prev');
          return;
        case 'marker.next':
          e.preventDefault();
          state.jumpToAdjacentMarker('next');
          return;
        case 'range.in': {
          e.preventDefault();
          const ac = findVideoActiveClip();
          if (!ac) {
            state.showMessage('error', 'クリップの上に再生ヘッドを置いてください');
            return;
          }
          const sourceTime = sourceTimeAtTimelineTime(ac, state.playhead);
          state.setIoIn(ac.assetId, sourceTime);
          state.showMessage('success', `開始 IN @ ${formatTimecode(sourceTime)}`);
          return;
        }
        case 'range.out': {
          e.preventDefault();
          const ac = findVideoActiveClip();
          if (!ac) {
            state.showMessage('error', 'クリップの上に再生ヘッドを置いてください');
            return;
          }
          const sourceTime = sourceTimeAtTimelineTime(ac, state.playhead);
          const wasPending = !!state.pendingIn;
          const id = state.setIoOut(ac.assetId, sourceTime);
          if (wasPending && id) {
            state.showMessage('success', `レンジ完成 → ${formatTimecode(sourceTime)}`);
          } else {
            state.showMessage('info', `開始 IN @ ${formatTimecode(sourceTime)} (Dで終了)`);
          }
          return;
        }
        case 'range.clearIn':
          e.preventDefault();
          state.clearPendingIn();
          state.showMessage('info', '開始マーククリア');
          return;
        case 'range.deleteNear': {
          e.preventDefault();
          const ac = findVideoActiveClip();
          if (!ac) return;
          const sourceTime = sourceTimeAtTimelineTime(ac, state.playhead);
          const removed = state.removeNearestRange(ac.assetId, sourceTime);
          state.showMessage(
            removed ? 'success' : 'info',
            removed ? 'レンジ削除' : '近くにレンジなし',
          );
          return;
        }
        case 'range.extract': {
          e.preventDefault();
          const id = state.extractCurrentRange();
          state.showMessage(
            id ? 'success' : 'error',
            id ? '即カット完了' : 'まずAキーで開始マークを設定',
          );
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    stableRemoveSelected,
    stableRippleDeleteSelected,
    stableSplitSelected,
    stableZoomIn,
    stableZoomOut,
  ]);

  const handleTrackAreaPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.pointerType === 'touch') return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-timeline-clip="true"]')) return;
      const startX = xInTrackArea(event.currentTarget, event.clientX);
      marqueeRef.current = {
        pointerId: event.pointerId,
        startX,
        currentX: startX,
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
        active: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const handleTrackAreaPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const current = marqueeRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      current.currentX = xInTrackArea(event.currentTarget, event.clientX);
      if (!current.active && Math.abs(current.currentX - current.startX) >= 4) {
        current.active = true;
      }
      if (current.active) {
        event.preventDefault();
        setMarquee({ startX: current.startX, currentX: current.currentX });
      }
    },
    [],
  );
  const finishTrackAreaGesture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
      const current = marqueeRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      marqueeRef.current = null;
      setMarquee(null);
      if (cancelled) return;

      const state = useProjectStore.getState();
      if (current.active) {
        const clipIds = clipIdsIntersectingTimeRange(
          state.clips,
          pxToTime(current.startX, zoom),
          pxToTime(current.currentX, zoom),
        );
        state.selectClips(clipIds, current.additive);
        state.showMessage(
          clipIds.length > 0 ? 'success' : 'info',
          clipIds.length > 0
            ? `${clipIds.length}本を範囲選択しました`
            : '範囲内にクリップがありません',
          1800,
        );
      } else {
        state.setPlayhead(pxToTime(current.currentX, zoom));
        if (!current.additive) clearSelection();
      }
    },
    [clearSelection, zoom],
  );
  const syncFromTimeline = useCallback(() => {
    if (headerScrollRef.current && scrollRef.current) {
      headerScrollRef.current.scrollTop = scrollRef.current.scrollTop;
    }
  }, []);
  const syncFromHeaders = useCallback(() => {
    if (headerScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = headerScrollRef.current.scrollTop;
    }
  }, []);

  return (
    <TimelineScrollProvider value={{ scrollRef }}>
    <div className={styles.root}>
      <TimelineToolbar />
      <div className={styles.body}>
        <div
          className={styles.trackHeaders}
          ref={headerScrollRef}
          onScroll={syncFromHeaders}
          style={{ paddingBottom: horizontalScrollbarHeight }}
        >
          <TrackHeaderList trackIds={trackIds} />
        </div>

        <div
          className={styles.scroll}
          ref={scrollRef}
          onScroll={syncFromTimeline}
          data-timeline-scroll="true"
        >
          <div
            className={styles.scrollInner}
            style={{
              width: totalWidth,
              height: `max(100%, ${28 + tracks.length * 56}px)`,
            }}
          >
            <Ruler totalSec={totalSec} zoom={zoom} />
            <div
              className={styles.trackArea}
              ref={trackAreaRef}
              data-track-area=""
              onPointerDown={handleTrackAreaPointerDown}
              onPointerMove={handleTrackAreaPointerMove}
              onPointerUp={finishTrackAreaGesture}
              onPointerCancel={(event) => finishTrackAreaGesture(event, true)}
            >
              {tracks.map((track) => (
                <Track
                  key={track.id}
                  trackId={track.id}
                  zoom={zoom}
                  totalSec={totalSec}
                  assetsById={assetsById}
                />
              ))}
              {marquee ? (
                <div
                  className={styles.marquee}
                  style={{
                    left: Math.min(marquee.startX, marquee.currentX),
                    width: Math.abs(marquee.currentX - marquee.startX),
                  }}
                  aria-hidden="true"
                />
              ) : null}
              <Playhead zoom={zoom} />
              <SnapGuide zoom={zoom} />
            </div>
          </div>
        </div>
      </div>
    </div>
    </TimelineScrollProvider>
  );
}
