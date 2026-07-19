import { useMemo, useState } from 'react';
import { Scissors } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { formatTimecode } from '../../lib/media';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import type { MediaAsset } from '../../lib/types';
import styles from './KillMarkerSection.module.css';

interface IORangeSectionProps {
  asset: MediaAsset;
}

export function IORangeSection({ asset }: IORangeSectionProps) {
  const allRanges = useProjectStore((s) => s.ioRanges);
  const ranges = useMemo(
    () =>
      allRanges
        .filter((r) => r.assetId === asset.id)
        .sort((a, b) => a.inTime - b.inTime),
    [allRanges, asset.id],
  );
  const selectedRangeId = useProjectStore((s) => s.selectedRangeId);
  const selectRange = useProjectStore((s) => s.selectRange);
  const removeRange = useProjectStore((s) => s.removeIoRange);
  const cutFromRanges = useProjectStore((s) => s.cutFromRanges);
  const pendingIn = useProjectStore((s) => s.pendingIn);
  const isPending = pendingIn?.assetId === asset.id;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const beginCut = () => {
    if (ranges.length === 0) return;
    const videoTrack = useProjectStore.getState().tracks.find((track) => track.kind === 'video');
    if (videoTrack?.locked) {
      setResultMessage('映像トラックのロックを解除してください');
      return;
    }
    setConfirmOpen(true);
  };

  const runCut = () => {
    const generated = cutFromRanges(asset.id, { deleteSourceClips: true });
    setResultMessage(
      generated > 0
        ? `${generated}本のクリップを生成しました`
        : 'レンジがありません',
    );
    window.setTimeout(() => setResultMessage(null), 2400);
  };

  const handleConfirm = () => {
    setConfirmOpen(false);
    runCut();
  };

  const totalSec = ranges.reduce((s, r) => s + (r.outTime - r.inTime), 0);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>A/D レンジ</span>
        <span className={styles.count}>{ranges.length}</span>
      </div>

      <div className={styles.list}>
        {ranges.length === 0 && !isPending ? (
          <div className={styles.empty}>
            再生中に <kbd>A</kbd> → <kbd>D</kbd> でレンジ追加
          </div>
        ) : (
          <>
            {ranges.map((r, idx) => (
              <div
                key={r.id}
                className={`${styles.row} ${selectedRangeId === r.id ? styles.selected : ''}`}
              >
                <button
                  type="button"
                  className={styles.rowSelect}
                  onClick={() => selectRange(r.id)}
                  aria-pressed={selectedRangeId === r.id}
                  aria-label={`レンジ${idx + 1}、${formatTimecode(r.inTime)}から${formatTimecode(r.outTime)}`}
                >
                  <span className={styles.idx}>{idx + 1}</span>
                  <span className={styles.time}>
                    {formatTimecode(r.inTime)} – {formatTimecode(r.outTime)}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRange(r.id);
                  }}
                  aria-label="削除"
                  title="削除"
                >
                  ×
                </button>
              </div>
            ))}
            {isPending && pendingIn ? (
              <div className={`${styles.row} ${styles.pending}`}>
                <span className={styles.idx}>IN</span>
                <span className={styles.time}>{formatTimecode(pendingIn.time)} – ...</span>
                <span className={styles.pendingHint}>
                  <kbd>D</kbd>を押して終了
                </span>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.estimateRow}>
          <span className={styles.estimateLabel}>合計予測長</span>
          <span className={styles.estimateValue}>{totalSec.toFixed(1)}秒</span>
        </div>

        <button
          type="button"
          className={styles.primaryBtn}
          onClick={beginCut}
          disabled={ranges.length === 0}
        >
          <Scissors size={15} strokeWidth={2} aria-hidden="true" />
          <span>レンジから一括カット</span>
        </button>

        {resultMessage ? <div className={styles.toast}>{resultMessage}</div> : null}
      </div>

      {confirmOpen ? (
        <ConfirmDialog
          title="A/Dレンジから一括カット"
          message={`元クリップ (${asset.name}) を削除して、${ranges.length}本のレンジクリップに置き換えます。よろしいですか？`}
          confirmLabel="生成する"
          cancelLabel="キャンセル"
          variant="destructive"
          onConfirm={handleConfirm}
          onCancel={() => setConfirmOpen(false)}
        />
      ) : null}
    </div>
  );
}
