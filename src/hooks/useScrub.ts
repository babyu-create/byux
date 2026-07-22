import { useRef } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { pxToTime } from '../lib/timeline';
import { useTimelineAutoScroll } from './useTimelineAutoScroll';

interface ScrubOptions {
  /**
   * Selector for the element whose left edge represents time=0 in the timeline.
   * Defaults to `[data-track-area]`.
   */
  containerSelector?: string;
  /**
   * Whether to pause playback when scrubbing starts.
   */
  pausePlayback?: boolean;
}

/** The content element's DOMRect already includes its scroll translation. */
export function timelineContentX(clientX: number, contentLeft: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(contentLeft)) return 0;
  return Math.max(0, clientX - contentLeft);
}

/**
 * Provides pointer-down/move/up handlers that scrub the playhead based on
 * pointer X position relative to the timeline track area.
 */
export function useScrub(options: ScrubOptions = {}) {
  const { containerSelector = '[data-track-area]', pausePlayback = true } = options;
  const draggingRef = useRef(false);
  const lastClientXRef = useRef(0);
  const { maybeScroll, stopAutoScroll, onScrollTick } = useTimelineAutoScroll();

  const updateFromClientX = (clientX: number) => {
    const trackArea = document.querySelector(containerSelector) as HTMLElement | null;
    if (!trackArea) return;
    const rect = trackArea.getBoundingClientRect();
    // `rect.left` moves left with the scrolled content. Adding scrollLeft here
    // a second time made long-timeline scrubbing jump forward by the current
    // horizontal scroll offset.
    const x = timelineContentX(clientX, rect.left);
    const { zoom, setPlayhead } = useProjectStore.getState();
    setPlayhead(pxToTime(x, zoom));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    lastClientXRef.current = e.clientX;
    onScrollTick(() => updateFromClientX(lastClientXRef.current));
    if (pausePlayback) {
      const { isPlaying, setIsPlaying } = useProjectStore.getState();
      if (isPlaying) setIsPlaying(false);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    updateFromClientX(e.clientX);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!draggingRef.current) return;
    lastClientXRef.current = e.clientX;
    maybeScroll(e.clientX);
    updateFromClientX(e.clientX);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    stopAutoScroll();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLElement>) => {
    onPointerUp(e);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
