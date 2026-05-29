import { useProjectStore } from '../../stores/projectStore';
import styles from './Toast.module.css';

const ICON_BY_KIND: Record<'success' | 'error' | 'info', string> = {
  success: '✓',
  error: '!',
  info: 'i',
};

export function Toast() {
  const message = useProjectStore((s) => s.transientMessage);
  if (!message) return null;
  return (
    <div
      className={styles.root}
      data-kind={message.kind}
      role="status"
      aria-live="polite"
      /* key ensures the slide-in animation replays for back-to-back messages
         of the same kind (React reuses the same DOM otherwise). */
      key={message.key}
    >
      <span className={styles.icon} aria-hidden="true">
        {ICON_BY_KIND[message.kind]}
      </span>
      <span className={styles.text}>{message.text}</span>
      {/* Progress bar: width animates from 100% to 0% over the message's
          duration via inline style so the timing matches the store's
          setTimeout exactly. */}
      <div
        className={styles.progress}
        style={{ animationDuration: `${message.durationMs}ms` }}
        aria-hidden="true"
      />
    </div>
  );
}
