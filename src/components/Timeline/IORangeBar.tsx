import { memo, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import type { IORange } from '../../lib/types';
import styles from './IORangeBar.module.css';

interface IORangeBarProps {
  range: IORange;
  /** Pixel offset within parent clip body where the range starts. */
  leftPx: number;
  /** Pixel width of the range. */
  widthPx: number;
}

export const IORangeBar = memo(function IORangeBar({
  range,
  leftPx,
  widthPx,
}: IORangeBarProps) {
  const isSelected = useProjectStore((s) => s.selectedRangeId === range.id);
  const select = useProjectStore((s) => s.selectRange);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      select(range.id);
    },
    [select, range.id],
  );

  return (
    <div
      className={`${styles.root} ${isSelected ? styles.selected : ''}`}
      style={{ left: leftPx, width: widthPx }}
      onClick={handleClick}
      onPointerDown={(e) => e.stopPropagation()}
      title="A/D レンジ"
    >
      <div className={styles.bar} />
      <div className={styles.bracketLeft}>A</div>
      <div className={styles.bracketRight}>D</div>
    </div>
  );
});

interface PendingInIndicatorProps {
  leftPx: number;
}

export const PendingInIndicator = memo(function PendingInIndicator({
  leftPx,
}: PendingInIndicatorProps) {
  return (
    <div className={styles.pendingIn} style={{ left: leftPx }} title="開始マーク">
      <div className={styles.pendingLine} />
      <div className={styles.pendingLabel}>I</div>
    </div>
  );
});
