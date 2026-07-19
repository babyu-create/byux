import { useCallback } from 'react';
import styles from './Splitter.module.css';

export type SplitterOrientation = 'vertical' | 'horizontal';

interface SplitterProps {
  /** 'vertical' = drag horizontally (column separator). 'horizontal' = drag vertically (row separator). */
  orientation: SplitterOrientation;
  /** Current px value of the dimension being resized. */
  value: number;
  /** Minimum allowed value. */
  min: number;
  /** Maximum allowed value. */
  max: number;
  /** If true, drag direction is inverted. Use for right/bottom panel sizing
   *  where dragging "into" the panel should shrink it. */
  reverse?: boolean;
  /** Called with the new value (already clamped). */
  onResize: (next: number) => void;
  /** Accessible label for screen readers. */
  ariaLabel?: string;
}

/**
 * Thin draggable separator between panels. Reads pointer delta from the
 * start of the drag and reports a new clamped pixel value via onResize.
 */
export function Splitter({
  orientation,
  value,
  min,
  max,
  reverse = false,
  onResize,
  ariaLabel,
}: SplitterProps) {
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Ignore a second pointerdown while already dragging (race guard).
      if (e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.preventDefault();
      const startCoord = orientation === 'vertical' ? e.clientX : e.clientY;
      const base = value;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      target.classList.add(styles.dragging);
      document.body.style.cursor =
        orientation === 'vertical' ? 'col-resize' : 'row-resize';

      const onMove = (ev: PointerEvent) => {
        const current = orientation === 'vertical' ? ev.clientX : ev.clientY;
        const delta = current - startCoord;
        const signed = reverse ? -delta : delta;
        const next = Math.max(min, Math.min(max, base + signed));
        onResize(next);
      };
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
        window.removeEventListener('blur', cleanup);
        target.removeEventListener('lostpointercapture', cleanup);
        try {
          if (target.hasPointerCapture(e.pointerId)) {
            target.releasePointerCapture(e.pointerId);
          }
        } catch {
          // Pointer capture already released (e.g. element was briefly removed).
        }
        target.classList.remove(styles.dragging);
        document.body.style.cursor = '';
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
      window.addEventListener('blur', cleanup);
      target.addEventListener('lostpointercapture', cleanup);
    },
    [orientation, value, min, max, reverse, onResize],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const decreaseKey = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      const increaseKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
      let next: number | null = null;
      if (event.key === 'Home') next = min;
      else if (event.key === 'End') next = max;
      else if (event.key === decreaseKey) next = value - (event.shiftKey ? 32 : 8);
      else if (event.key === increaseKey) next = value + (event.shiftKey ? 32 : 8);
      if (next === null) return;
      event.preventDefault();
      const signed = reverse && !['Home', 'End'].includes(event.key)
        ? value - (next - value)
        : next;
      onResize(Math.max(min, Math.min(max, signed)));
    },
    [max, min, onResize, orientation, reverse, value],
  );

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      className={`${styles.splitter} ${
        orientation === 'vertical' ? styles.vertical : styles.horizontal
      }`}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
