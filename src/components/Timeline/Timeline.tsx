import { useEffect, useMemo, useRef } from 'react';
import { useProjectStore, useTimelineDuration } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { clipDuration, timeToPx } from '../../lib/timeline';
import { formatTimecode } from '../../lib/media';
import { matchAction } from '../../lib/keybindings';
import type { MediaAsset } from '../../lib/types';
import { Ruler } from './Ruler';
import { Track } from './Track';
import { TrackHeader } from './TrackHeader';
import { Playhead } from './Playhead';
import { SnapGuide } from './SnapGuide';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineScrollProvider } from '../../hooks/useTimelineAutoScroll';
import styles from './Timeline.module.css';

export function Timeline() {
  const tracks = useProjectStore((s) => s.tracks);
  const clips = useProjectStore((s) => s.clips);
  const zoom = useProjectStore((s) => s.zoom);
  const playhead = useProjectStore((s) => s.playhead);
  const clearSelection = useProjectStore((s) => s.clearSelection);
  const removeSelectedClips = useProjectStore((s) => s.removeSelectedClips);
  const splitSelected = useProjectStore((s) => s.splitSelectedAtPlayhead);
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      const action = matchAction(e);
      if (!action) return;
      const state = useProjectStore.getState();

      // Helpers
      const findVideoActiveClip = () => {
        const trackId = state.tracks.find((t) => t.kind === 'video')?.id;
        if (!trackId) return null;
        return (
          state.clips.find((c) => {
            if (c.trackId !== trackId) return false;
            const end = c.start + clipDuration(c);
            return state.playhead >= c.start - 1e-6 && state.playhead < end - 1e-6;
          }) ?? null
        );
      };

      switch (action) {
        case 'playback.toggle':
          e.preventDefault();
          state.togglePlay();
          return;
        case 'clip.split':
          if (state.selectedClipIds.length > 0) {
            e.preventDefault();
            splitSelected();
          }
          return;
        case 'clip.delete':
          if (state.selectedClipIds.length > 0) {
            e.preventDefault();
            removeSelectedClips();
          }
          return;
        case 'zoom.in':
          e.preventDefault();
          zoomIn();
          return;
        case 'zoom.out':
          e.preventDefault();
          zoomOut();
          return;
        case 'frame.prev':
          e.preventDefault();
          state.setPlayhead(Math.max(0, state.playhead - 1 / 60));
          return;
        case 'frame.next':
          e.preventDefault();
          state.setPlayhead(state.playhead + 1 / 60);
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
          const sourceTime = ac.trimStart + (state.playhead - ac.start);
          state.addKillMarker(ac.assetId, sourceTime);
          state.showMessage('success', `🎯 キルマーカー @ ${formatTimecode(sourceTime)}`);
          return;
        }
        case 'marker.deleteNear': {
          e.preventDefault();
          const ac = findVideoActiveClip();
          if (!ac) {
            state.showMessage('error', 'クリップの上に再生ヘッドを置いてください');
            return;
          }
          const sourceTime = ac.trimStart + (state.playhead - ac.start);
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
          const sourceTime = ac.trimStart + (state.playhead - ac.start);
          state.setIoIn(ac.assetId, sourceTime);
          state.showMessage('success', `🟢 開始 IN @ ${formatTimecode(sourceTime)}`);
          return;
        }
        case 'range.out': {
          e.preventDefault();
          const ac = findVideoActiveClip();
          if (!ac) {
            state.showMessage('error', 'クリップの上に再生ヘッドを置いてください');
            return;
          }
          const sourceTime = ac.trimStart + (state.playhead - ac.start);
          const wasPending = !!state.pendingIn;
          const id = state.setIoOut(ac.assetId, sourceTime);
          if (wasPending && id) {
            state.showMessage('success', `✂ レンジ完成 → ${formatTimecode(sourceTime)}`);
          } else {
            state.showMessage('info', `🟢 開始 IN @ ${formatTimecode(sourceTime)} (Oで終了)`);
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
          const sourceTime = ac.trimStart + (state.playhead - ac.start);
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
            id ? '✂ 即カット完了' : 'まずIキーで開始マークを設定',
          );
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [removeSelectedClips, splitSelected, zoomIn, zoomOut]);

  const handleTrackAreaClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      clearSelection();
    }
  };

  return (
    <TimelineScrollProvider value={{ scrollRef }}>
    <div className={styles.root}>
      <TimelineToolbar />
      <div className={styles.body}>
        <div className={styles.trackHeaders}>
          {tracks.map((track) => (
            <TrackHeader key={track.id} track={track} />
          ))}
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
                  track={track}
                  clips={clips.filter((c) => c.trackId === track.id)}
                  zoom={zoom}
                  totalSec={totalSec}
                  assetsById={assetsById}
                />
              ))}
              <Playhead time={playhead} zoom={zoom} />
              <SnapGuide zoom={zoom} />
            </div>
          </div>
        </div>
      </div>
    </div>
    </TimelineScrollProvider>
  );
}
