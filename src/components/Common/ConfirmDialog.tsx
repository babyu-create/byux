import { useState } from 'react';
import styles from './ConfirmDialog.module.css';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  rememberLabel?: string;
  onConfirm: (rememberSkip: boolean) => void;
  onCancel: () => void;
  variant?: 'default' | 'destructive';
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '確定',
  cancelLabel = 'キャンセル',
  rememberLabel,
  onConfirm,
  onCancel,
  variant = 'default',
}: ConfirmDialogProps) {
  const [rememberSkip, setRememberSkip] = useState(false);

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <div className={styles.header}>{title}</div>
        <div className={styles.body}>
          <p>{message}</p>
        </div>
        {rememberLabel ? (
          <label className={styles.rememberRow}>
            <input
              type="checkbox"
              checked={rememberSkip}
              onChange={(e) => setRememberSkip(e.target.checked)}
            />
            <span>{rememberLabel}</span>
          </label>
        ) : null}
        <div className={styles.footer}>
          <button type="button" className={styles.btnCancel} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`${styles.btnConfirm} ${variant === 'destructive' ? styles.destructive : ''}`}
            onClick={() => onConfirm(rememberSkip)}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
