import { memo, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import type { KillMarker } from '../../lib/types';
import styles from './KillMarkerFlag.module.css';

interface KillMarkerFlagProps {
  marker: KillMarker;
  /** Pixel offset within the parent clip body where the flag should sit. */
  leftPx: number;
}

export const KillMarkerFlag = memo(function KillMarkerFlag({
  marker,
  leftPx,
}: KillMarkerFlagProps) {
  const isSelected = useProjectStore((s) => s.selectedMarkerId === marker.id);
  const selectMarker = useProjectStore((s) => s.selectMarker);

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
      onPointerDown={(e) => {
        if (e.button === 0) e.stopPropagation();
      }}
      title={`キル ${marker.label ? `(${marker.label})` : ''}`}
    >
      <div className={styles.flag} />
      <div className={styles.line} />
    </div>
  );
});
