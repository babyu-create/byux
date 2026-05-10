import { timeToPx } from '../../lib/timeline';
import { useScrub } from '../../hooks/useScrub';
import styles from './Playhead.module.css';

interface PlayheadProps {
  time: number;
  zoom: number;
}

export function Playhead({ time, zoom }: PlayheadProps) {
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
}
