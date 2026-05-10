import { useProjectStore } from '../../stores/projectStore';
import styles from './Toast.module.css';

export function Toast() {
  const message = useProjectStore((s) => s.transientMessage);
  if (!message) return null;
  return (
    <div className={styles.root} data-kind={message.kind} role="status" aria-live="polite">
      {message.text}
    </div>
  );
}
