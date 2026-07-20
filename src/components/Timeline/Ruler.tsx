import { memo, useEffect, useMemo, useState } from 'react';
import { buildRulerTicks, pxToTime, timeToPx } from '../../lib/timeline';
import { useScrub } from '../../hooks/useScrub';
import { useTimelineScrollRef } from '../../hooks/useTimelineAutoScroll';
import styles from './Ruler.module.css';

const RULER_OVERSCAN_PX = 400;

interface VisibleRulerRange {
  start: number;
  end: number;
}

interface RulerProps {
  totalSec: number;
  zoom: number;
}

export const Ruler = memo(function Ruler({ totalSec, zoom }: RulerProps) {
  const scrollRef = useTimelineScrollRef();
  const [visibleRange, setVisibleRange] = useState<VisibleRulerRange>(() => ({
    start: 0,
    end: Math.min(totalSec, pxToTime(2_000, zoom)),
  }));
  useEffect(() => {
    const scroll = scrollRef?.current;
    if (!scroll) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = {
        start: pxToTime(Math.max(0, scroll.scrollLeft - RULER_OVERSCAN_PX), zoom),
        end: Math.min(
          totalSec,
          pxToTime(
            scroll.scrollLeft + scroll.clientWidth + RULER_OVERSCAN_PX,
            zoom,
          ),
        ),
      };
      setVisibleRange((current) =>
        Math.abs(current.start - next.start) < 1e-6 &&
        Math.abs(current.end - next.end) < 1e-6
          ? current
          : next,
      );
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };
    update();
    scroll.addEventListener('scroll', scheduleUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(scroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroll.removeEventListener('scroll', scheduleUpdate);
      observer.disconnect();
    };
  }, [scrollRef, totalSec, zoom]);

  const ticks = useMemo(
    () => buildRulerTicks(totalSec, zoom, visibleRange.start, visibleRange.end),
    [totalSec, visibleRange.end, visibleRange.start, zoom],
  );
  const scrub = useScrub();

  return (
    <div className={styles.root} data-ruler-tick-count={ticks.length} {...scrub}>
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
