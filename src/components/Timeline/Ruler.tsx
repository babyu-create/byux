import { memo, useMemo } from 'react';
import { buildRulerTicks, timeToPx } from '../../lib/timeline';
import { useScrub } from '../../hooks/useScrub';
import styles from './Ruler.module.css';

interface RulerProps {
  totalSec: number;
  zoom: number;
}

export const Ruler = memo(function Ruler({ totalSec, zoom }: RulerProps) {
  // Ticks are only recomputed when zoom or totalSec actually changes
  const ticks = useMemo(() => buildRulerTicks(totalSec, zoom), [totalSec, zoom]);
  const scrub = useScrub();

  return (
    <div className={styles.root} {...scrub}>
      {ticks.map((tick) => (
        <div
          key={tick.time}
          className={`${styles.tick} ${tick.major ? styles.tickMajor : styles.tickMinor}`}
          style={{ left: timeToPx(tick.time, zoom) }}
        >
          {tick.label && <span className={styles.label}>{tick.label}</span>}
        </div>
      ))}
    </div>
  );
});
