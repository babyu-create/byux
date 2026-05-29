import { memo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { timeToPx } from '../../lib/timeline';
import { useScrub } from '../../hooks/useScrub';
import styles from './Playhead.module.css';

interface PlayheadProps {
  zoom: number;
}

export const Playhead = memo(function Playhead({ zoom }: PlayheadProps) {
  // Subscribe only to playhead — isolated from clips/tracks changes
  const time = useProjectStore((s) => s.playhead);
  const scrub = useScrub();

  return (
    <div
      className={styles.root}
      style={{ transform: `translateX(${timeToPx(time, zoom)}px)` }}
    >
      <div className={styles.head} {...scrub} />
      <div className={styles.line} />
      <div className={styles.hitarea} {...scrub} />
    </div>
  );
});
