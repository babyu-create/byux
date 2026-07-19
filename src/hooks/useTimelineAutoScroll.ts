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
  const tickListenerRef = useRef<(() => void) | null>(null);

  const stop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    directionRef.current = 0;
    speedRef.current = 0;
    tickListenerRef.current = null;
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
    el.scrollBy({
      left: directionRef.current * speedRef.current,
      behavior: 'auto',
    });
    // Let the drag handler reposition the clip to match the new scroll position
    // before the next paint. Without this, the cursor sits still while the
    // viewport scrolls, and the clip visually drifts away from the cursor.
    tickListenerRef.current?.();
    rafRef.current = requestAnimationFrame(tick);
  };

  /**
   * Register a callback fired on every auto-scroll frame. Drag handlers use
   * this to recompute the clip's start position from the new scrollLeft, so
   * the clip stays glued to the cursor while the viewport pans beneath it.
   * Returns an unregister function.
   */
  const onScrollTick = (cb: () => void): (() => void) => {
    tickListenerRef.current = cb;
    return () => {
      if (tickListenerRef.current === cb) tickListenerRef.current = null;
    };
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
      // Pause the loop but keep the tick listener so a subsequent edge entry
      // resumes seamlessly.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      directionRef.current = 0;
      speedRef.current = 0;
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

  /**
   * Returns the current scroll-left of the timeline container, or 0 when no
   * container is registered. Drag handlers call this on pointerdown and on
   * every pointermove to compensate for auto-scroll motion: the clip should
   * follow the cursor in content-space, not screen-space.
   */
  const getScrollLeft = (): number => {
    return ctx?.scrollRef.current?.scrollLeft ?? 0;
  };

  return { maybeScroll, stopAutoScroll: stop, getScrollLeft, onScrollTick };
}
