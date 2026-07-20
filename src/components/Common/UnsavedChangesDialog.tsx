import { useId } from 'react';
import { AccessibleDialog } from './AccessibleDialog';
import styles from './ConfirmDialog.module.css';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

interface UnsavedChangesDialogProps {
  action: string;
  onChoose: (choice: UnsavedChoice) => void;
}

export function UnsavedChangesDialog({
  action,
  onChoose,
}: UnsavedChangesDialogProps) {
  const titleId = useId();
  return (
    <AccessibleDialog
      backdropClassName={styles.backdrop}
      dialogClassName={styles.modal}
      titleId={titleId}
      onClose={() => onChoose('cancel')}
    >
      <div id={titleId} className={styles.header}>変更を保存しますか？</div>
      <div className={styles.body}>
        <p>未保存の変更があります。保存してから{action}できます。</p>
      </div>
      <div className={styles.footer}>
        <button
          type="button"
          className={styles.btnCancel}
          onClick={() => onChoose('cancel')}
          data-dialog-initial-focus=""
        >
          キャンセル
        </button>
        <button
          type="button"
          className={`${styles.btnConfirm} ${styles.destructive}`}
          onClick={() => onChoose('discard')}
        >
          保存せず続行
        </button>
        <button
          type="button"
          className={styles.btnConfirm}
          onClick={() => onChoose('save')}
        >
          保存して続行
        </button>
      </div>
    </AccessibleDialog>
  );
}
