import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getSectionOpenPref, setSectionOpenPref } from '../../lib/preferences';
import styles from './CollapsibleSection.module.css';

interface CollapsibleSectionProps {
  /** Stable id used to persist the open/closed state across reloads. */
  id: string;
  /** Header label shown on the toggle. */
  title: string;
  /** Section body. Rendered only while expanded (cheap re-mount). */
  children: ReactNode;
  /**
   * Whether the section currently holds a non-default value. Drives the
   * default-open behaviour (inactive sections collapse) and the header badge.
   */
  active?: boolean;
  /** Short status text (e.g. "ON", "1.5×", "3"); falls back to ON/OFF. */
  badge?: string;
  /**
   * High-frequency sections (Speed / Color / Kill markers) stay open by
   * default even when inactive so the common FPS-montage flow needs no clicks.
   */
  defaultOpen?: boolean;
}

export function CollapsibleSection({
  id,
  title,
  children,
  active = false,
  badge,
  defaultOpen,
}: CollapsibleSectionProps) {
  // Default: open if pinned-open OR currently active; otherwise collapsed.
  const initial = defaultOpen ?? active;
  const [open, setOpen] = useState(() => getSectionOpenPref(id, initial));

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      setSectionOpenPref(id, next);
      return next;
    });
  };

  const badgeText = badge ?? (active ? 'ON' : 'OFF');
  const bodyId = `section-body-${id}`;

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.header}
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className={styles.chevron} aria-hidden="true">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className={styles.title}>{title}</span>
        <span className={`${styles.badge} ${active ? styles.badgeOn : ''}`}>
          {badgeText}
        </span>
      </button>
      {open ? (
        <div id={bodyId} className={styles.body}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
