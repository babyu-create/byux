import { createContext, useContext, useEffect, useRef, type RefObject } from 'react';

/**
 * Drag-edge auto-scroll for the timeline.
 *
 * Components that drag clips/handles register the scroll container ref via
 * <TimelineScrollProvider>. While a drag is active, calling {@link maybeScroll}
 * with the current pointer X tests whether the cursor is within the edge band
 * and, if so, starts a smooth rAF loop that translates `scrollLeft` over time.
 * The loop self-cancels when the pointer leaves the band or the drag ends.
 */

const EDGE_BAND_PX = 60;
const MAX_SPEED_PX_PER_FRAME = 20;
const MIN_SPEED_PX_PER_FRAME = 2;

interface TimelineScrollContextValue {
  scrollRef: RefObject<HTMLDivElement | null>;
}

const TimelineScrollContext = createContext<TimelineScrollContextValue | null>(null);

export const TimelineScrollProvider = TimelineScrollContext.Provider;

export function useTimelineAutoScroll() {
  const ctx = useContext(TimelineScrollContext);
  const rafRef = useRef<number | null>(null);
  const directionRef = useRef<-1 | 0 | 1>(0);
  const speedRef = useRef(0);

  const stop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    directionRef.current = 0;
    speedRef.current = 0;
  };

  useEffect(() => {
    return () => stop();
  }, []);

  const tick = () => {
    const el = ctx?.scrollRef.current;
    if (!el || directionRef.current === 0) {
      rafRef.current = null;
      return;
    }
    el.scrollLeft += directionRef.current * speedRef.current;
    rafRef.current = requestAnimationFrame(tick);
  };

  const maybeScroll = (clientX: number) => {
    const el = ctx?.scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const fromLeft = clientX - rect.left;
    const fromRight = rect.right - clientX;

    let dir: -1 | 0 | 1 = 0;
    let dist = 0;
    if (fromLeft < EDGE_BAND_PX && el.scrollLeft > 0) {
      dir = -1;
      dist = Math.max(0, EDGE_BAND_PX - fromLeft);
    } else if (
      fromRight < EDGE_BAND_PX &&
      el.scrollLeft + el.clientWidth < el.scrollWidth
    ) {
      dir = 1;
      dist = Math.max(0, EDGE_BAND_PX - fromRight);
    }

    if (dir === 0) {
      stop();
      return;
    }

    // Cubic ease-in: edges feel responsive but inner band moves gently.
    const ratio = Math.min(1, dist / EDGE_BAND_PX);
    const eased = ratio * ratio * ratio;
    speedRef.current =
      MIN_SPEED_PX_PER_FRAME + (MAX_SPEED_PX_PER_FRAME - MIN_SPEED_PX_PER_FRAME) * eased;
    directionRef.current = dir;

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  };

  return { maybeScroll, stopAutoScroll: stop };
}
