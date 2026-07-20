import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useProjectStore, useTimelineDuration } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { clipDuration, sourceTimeAtTimelineTime, timeToPx } from '../../lib/timeline';
import { formatTimecode } from '../../lib/media';
import { matchAction } from '../../lib/keybindings';
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
  const trackAreaRef = useRef<HTMLDivElement>(null);

  // Stable callbacks so the keydown effect doesn't re-register on every render
  const stableRemoveSelected = useCallback(
    () => removeSelectedWithFeedback(),
    [],
  );
  const stableSplitSelected = useCallback(
    () => splitSelectedWithFeedback(),
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
      const action = matchAction(e);
      if (!action) return;
      const state = useProjectStore.getState();

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
  }, [stableRemoveSelected, stableSplitSelected, stableZoomIn, stableZoomOut]);

  const handleTrackAreaClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        clearSelection();
      }
    },
    [clearSelection],
  );

  return (
    <TimelineScrollProvider value={{ scrollRef }}>
    <div className={styles.root}>
      <TimelineToolbar />
      <div className={styles.body}>
        <div className={styles.trackHeaders}>
          <TrackHeaderList trackIds={trackIds} />
        </div>

        <div className={styles.scroll} ref={scrollRef}>
          <div className={styles.scrollInner} style={{ width: totalWidth }}>
            <Ruler totalSec={totalSec} zoom={zoom} />
            <div
              className={styles.trackArea}
              ref={trackAreaRef}
              data-track-area=""
              onClick={handleTrackAreaClick}
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
