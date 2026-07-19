import { useId, useState } from 'react';
import { AccessibleDialog } from './AccessibleDialog';
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
  const titleId = useId();

  return (
    <AccessibleDialog
      backdropClassName={styles.backdrop}
      dialogClassName={styles.modal}
      titleId={titleId}
      onClose={onCancel}
    >
        <div id={titleId} className={styles.header}>{title}</div>
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
          <button
            type="button"
            className={styles.btnCancel}
            onClick={onCancel}
            data-dialog-initial-focus={variant === 'destructive' ? '' : undefined}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`${styles.btnConfirm} ${variant === 'destructive' ? styles.destructive : ''}`}
            onClick={() => onConfirm(rememberSkip)}
            data-dialog-initial-focus={variant === 'default' ? '' : undefined}
          >
            {confirmLabel}
          </button>
        </div>
    </AccessibleDialog>
  );
}
