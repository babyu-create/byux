import { memo, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import type { KillMarker } from '../../lib/types';
import styles from './KillMarkerFlag.module.css';

interface KillMarkerFlagProps {
  marker: KillMarker;
  /** Pixel offset within the parent clip body where the flag should sit. */
  leftPx: number;
  focusable?: boolean;
}

export const KillMarkerFlag = memo(function KillMarkerFlag({
  marker,
  leftPx,
  focusable = false,
}: KillMarkerFlagProps) {
  const isSelected = useProjectStore((s) => s.selectedMarkerId === marker.id);
  const selectMarker = useProjectStore((s) => s.selectMarker);
  const removeMarker = useProjectStore((s) => s.removeKillMarker);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      selectMarker(marker.id);
    },
    [selectMarker, marker.id],
  );

  return (
    <div
      className={`${styles.root} ${isSelected ? styles.selected : ''}`}
      style={{ left: leftPx }}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          selectMarker(marker.id);
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          removeMarker(marker.id);
        }
      }}
      onPointerDown={(e) => {
        if (e.button === 0) e.stopPropagation();
      }}
      role="button"
      tabIndex={focusable && isSelected ? 0 : -1}
      aria-pressed={isSelected}
      aria-label={`キルマーカー${marker.label ? `、${marker.label}` : ''}`}
      title={`キル ${marker.label ? `(${marker.label})` : ''}`}
    >
      <div className={styles.flag} />
      <div className={styles.line} />
    </div>
  );
});
