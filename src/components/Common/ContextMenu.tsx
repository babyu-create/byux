import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './ContextMenu.module.css';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  /** Button-list mode. Ignored if `children` is provided. */
  items?: ContextMenuItem[];
  /** Custom-content mode (e.g. embedding a slider section), used instead of `items`. */
  children?: ReactNode;
  onClose: () => void;
  /** Defaults to a narrow menu width; widen for slider/custom content. */
  width?: number;
}

const MENU_WIDTH = 180;

export function ContextMenu({ x, y, items, children, onClose, width = MENU_WIDTH }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Actual size isn't known until the content (button list or arbitrary
  // children) has rendered, so position in two passes: lay out at the raw
  // click point first (hidden), then measure and clamp before it's shown —
  // avoids both a wrong-size estimate and a visible jump.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Capture phase so this fires before the click that opened the menu (a
    // right-click elsewhere) can be mistaken for a click inside it.
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Portal to <body> — the timeline's scroll container uses `contain: paint`
  // (Timeline.module.css `.scroll`) for perf, which makes IT the containing
  // block for any `position: fixed` descendant instead of the viewport. Left
  // inline, this menu would compute a viewport-relative position but then
  // get clipped/mispositioned by that ancestor's `overflow-y: hidden` —
  // it was rendering the whole time, just invisibly.
  return createPortal(
    <div
      ref={ref}
      className={styles.root}
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        width,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="menu"
    >
      {items
        ? items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
            >
              {item.label}
            </button>
          ))
        : children}
    </div>,
    document.body,
  );
}
