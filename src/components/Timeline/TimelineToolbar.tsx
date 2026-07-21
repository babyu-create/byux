import { useState, type MouseEvent } from 'react';
import { Captions, Scissors, Trash2, Magnet, ZoomIn, ZoomOut, ListPlus } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { formatTimecode } from '../../lib/media';
import {
  removeSelectedWithFeedback,
  splitSelectedWithFeedback,
} from './timelineCommands';
import styles from './TimelineToolbar.module.css';
import { ContextMenu } from '../Common/ContextMenu';
import type { TrackKind } from '../../lib/types';
import { SubtitleDialog } from './SubtitleDialog';

export function TimelineToolbar() {
  const [trackMenu, setTrackMenu] = useState<{ x: number; y: number } | null>(null);
  const [subtitleDialogOpen, setSubtitleDialogOpen] = useState(false);
  const zoom = useProjectStore((s) => s.zoom);
  const zoomIn = useProjectStore((s) => s.zoomIn);
  const zoomOut = useProjectStore((s) => s.zoomOut);
  const setZoom = useProjectStore((s) => s.setZoom);
  const playhead = useProjectStore((s) => s.playhead);
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds);
  const snapEnabled = useProjectStore((s) => s.snapEnabled);
  const toggleSnap = useProjectStore((s) => s.toggleSnap);
  const addTrack = useProjectStore((s) => s.addTrack);
  const showMessage = useProjectStore((s) => s.showMessage);
  const pendingIn = useProjectStore((s) => s.pendingIn);
  const subtitleCount = useProjectStore((s) => s.subtitles.length);
  const clearPendingIn = useProjectStore((s) => s.clearPendingIn);
  const assets = useMediaStore((s) => s.assets);
  const pendingAssetName = pendingIn
    ? (assets.find((a) => a.id === pendingIn.assetId)?.name ?? '')
    : '';

  const hasSelection = selectedClipIds.length > 0;
  const openTrackMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTrackMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const handleAddTrack = (kind: TrackKind) => {
    const id = addTrack(kind);
    showMessage(
      id ? 'success' : 'error',
      id ? 'トラックを追加しました' : 'トラックを追加できません（最大100本）',
    );
  };

  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <div className={styles.timecode}>
          <span className={styles.timecodeLabel}>位置</span>
          <span className={styles.timecodeValue}>{formatTimecode(playhead)}</span>
        </div>
      </div>

      {pendingIn ? (
        <div
          className={styles.pendingBadge}
          title={`開始マーク: ${pendingAssetName}\nD キーで終了マーク確定 / Shift+A で解除`}
        >
          <span className={styles.pendingDot} />
          <span className={styles.pendingLabel}>IN</span>
          <span className={styles.pendingTime}>{formatTimecode(pendingIn.time)}</span>
          <button
            type="button"
            className={styles.pendingClear}
            onClick={clearPendingIn}
            aria-label="開始マーククリア"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={openTrackMenu}
          aria-haspopup="menu"
          aria-expanded={Boolean(trackMenu)}
          title="映像・オーバーレイ・音声トラックを追加"
        >
          <ListPlus size={14} strokeWidth={2} aria-hidden="true" />
          <span>トラック</span>
        </button>
        <button
          type="button"
          className={`${styles.actionBtn} ${subtitleCount > 0 ? styles.actionActive : ''}`}
          onClick={() => setSubtitleDialogOpen(true)}
          title="字幕（SRT / WebVTT）を読み込み・編集"
          aria-label={`字幕を編集（${subtitleCount}件）`}
        >
          <Captions size={14} strokeWidth={2} aria-hidden="true" />
          <span>字幕{subtitleCount > 0 ? ` ${subtitleCount}` : ''}</span>
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={splitSelectedWithFeedback}
          disabled={!hasSelection}
          title="選択クリップを分割 (J)"
          aria-label={`選択クリップを分割（${selectedClipIds.length}本選択中）`}
        >
          <Scissors size={14} strokeWidth={2} aria-hidden="true" />
          <span>分割</span>
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={removeSelectedWithFeedback}
          disabled={!hasSelection}
          title="選択クリップを削除 (Delete)"
          aria-label={`選択クリップを削除（${selectedClipIds.length}本選択中）`}
        >
          <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
          <span>削除</span>
        </button>
        <button
          type="button"
          className={`${styles.actionBtn} ${snapEnabled ? styles.actionActive : ''}`}
          onClick={toggleSnap}
          title={`スナップ ${snapEnabled ? 'ON' : 'OFF'}`}
          aria-pressed={snapEnabled}
        >
          <Magnet size={14} strokeWidth={2} aria-hidden="true" />
          <span>スナップ</span>
        </button>
      </div>
      {trackMenu ? (
        <ContextMenu
          x={trackMenu.x}
          y={trackMenu.y}
          onClose={() => setTrackMenu(null)}
          items={[
            { label: '映像トラックを追加', onSelect: () => handleAddTrack('video') },
            { label: 'オーバーレイを追加', onSelect: () => handleAddTrack('overlay') },
            { label: '音声トラックを追加', onSelect: () => handleAddTrack('audio') },
          ]}
        />
      ) : null}
      {subtitleDialogOpen ? (
        <SubtitleDialog onClose={() => setSubtitleDialogOpen(false)} />
      ) : null}

      <div className={styles.zoomGroup}>
        <button type="button" className={styles.zoomBtn} onClick={zoomOut} title="ズームアウト (-)" aria-label="ズームアウト">
          <ZoomOut size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <input
          type="range"
          min={-2}
          max={3}
          step={0.1}
          value={Math.log2(zoom)}
          onChange={(e) => setZoom(2 ** parseFloat(e.target.value))}
          aria-label="タイムラインのズーム"
          aria-valuetext={`${Math.round(zoom * 100)}%`}
          className={styles.zoomSlider}
        />
        <button type="button" className={styles.zoomBtn} onClick={zoomIn} title="ズームイン (+)" aria-label="ズームイン">
          <ZoomIn size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <span className={styles.zoomValue}>{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}
