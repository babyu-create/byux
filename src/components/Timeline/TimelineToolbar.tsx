import { Scissors, Trash2, Magnet, ZoomIn, ZoomOut } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { formatTimecode } from '../../lib/media';
import styles from './TimelineToolbar.module.css';

export function TimelineToolbar() {
  const zoom = useProjectStore((s) => s.zoom);
  const zoomIn = useProjectStore((s) => s.zoomIn);
  const zoomOut = useProjectStore((s) => s.zoomOut);
  const setZoom = useProjectStore((s) => s.setZoom);
  const playhead = useProjectStore((s) => s.playhead);
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds);
  const splitSelected = useProjectStore((s) => s.splitSelectedAtPlayhead);
  const removeSelected = useProjectStore((s) => s.removeSelectedClips);
  const snapEnabled = useProjectStore((s) => s.snapEnabled);
  const toggleSnap = useProjectStore((s) => s.toggleSnap);
  const pendingIn = useProjectStore((s) => s.pendingIn);
  const clearPendingIn = useProjectStore((s) => s.clearPendingIn);
  const assets = useMediaStore((s) => s.assets);
  const pendingAssetName = pendingIn
    ? (assets.find((a) => a.id === pendingIn.assetId)?.name ?? '')
    : '';

  const hasSelection = selectedClipIds.length > 0;

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
          onClick={splitSelected}
          disabled={!hasSelection}
          title="選択クリップを分割 (J)"
        >
          <Scissors size={14} strokeWidth={2} aria-hidden="true" />
          <span>分割</span>
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={removeSelected}
          disabled={!hasSelection}
          title="選択クリップを削除 (Delete)"
        >
          <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
          <span>削除</span>
        </button>
        <button
          type="button"
          className={`${styles.actionBtn} ${snapEnabled ? styles.actionActive : ''}`}
          onClick={toggleSnap}
          title="スナップ ON/OFF"
        >
          <Magnet size={14} strokeWidth={2} aria-hidden="true" />
          <span>スナップ</span>
        </button>
      </div>

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
