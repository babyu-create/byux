import { buildRulerTicks, timeToPx } from '../../lib/timeline';
import { useScrub } from '../../hooks/useScrub';
import styles from './Ruler.module.css';

interface RulerProps {
  totalSec: number;
  zoom: number;
}

export function Ruler({ totalSec, zoom }: RulerProps) {
  const ticks = buildRulerTicks(totalSec, zoom);
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
}
