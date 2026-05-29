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
      const onUp = () => {
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          // Pointer capture already released (e.g. element was briefly removed).
        }
        target.classList.remove(styles.dragging);
        document.body.style.cursor = '';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [orientation, value, min, max, reverse, onResize],
  );

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      className={`${styles.splitter} ${
        orientation === 'vertical' ? styles.vertical : styles.horizontal
      }`}
      onPointerDown={handlePointerDown}
    />
  );
}
