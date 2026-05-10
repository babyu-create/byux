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

export function IORangeBar({ range, leftPx, widthPx }: IORangeBarProps) {
  const isSelected = useProjectStore((s) => s.selectedRangeId === range.id);
  const select = useProjectStore((s) => s.selectRange);

  return (
    <div
      className={`${styles.root} ${isSelected ? styles.selected : ''}`}
      style={{ left: leftPx, width: widthPx }}
      onClick={(e) => {
        e.stopPropagation();
        select(range.id);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      title="I/O レンジ"
    >
      <div className={styles.bar} />
      <div className={styles.bracketLeft}>I</div>
      <div className={styles.bracketRight}>O</div>
    </div>
  );
}

interface PendingInIndicatorProps {
  leftPx: number;
}

export function PendingInIndicator({ leftPx }: PendingInIndicatorProps) {
  return (
    <div className={styles.pendingIn} style={{ left: leftPx }} title="開始マーク">
      <div className={styles.pendingLine} />
      <div className={styles.pendingLabel}>I</div>
    </div>
  );
}
