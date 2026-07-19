import { Clock3, FolderOpen, Trash2, X } from 'lucide-react';
import type { RecentProject } from './UpdateBanner';
import { AccessibleDialog } from './AccessibleDialog';
import styles from './RecentProjectsDialog.module.css';

interface RecentProjectsDialogProps {
  projects: RecentProject[];
  onOpen: (project: RecentProject) => void;
  onRemove: (project: RecentProject) => void;
  onClose: () => void;
  busy?: boolean;
}

function formatOpenedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('ja-JP', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

export function RecentProjectsDialog({
  projects,
  onOpen,
  onRemove,
  onClose,
  busy = false,
}: RecentProjectsDialogProps) {
  return (
    <AccessibleDialog
      backdropClassName={styles.backdrop}
      dialogClassName={styles.modal}
      titleId="recent-projects-title"
      onClose={onClose}
    >
        <div className={styles.header}>
          <div>
            <div id="recent-projects-title" className={styles.title}>
              最近使ったプロジェクト
            </div>
            <div className={styles.subtitle}>前回の編集をすぐに再開できます</div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="閉じる">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.list}>
          {projects.length === 0 ? (
            <div className={styles.empty}>最近開いたプロジェクトはありません。</div>
          ) : (
            projects.map((project) => (
              <div
                key={project.path}
                className={`${styles.item} ${project.available ? '' : styles.missing}`}
              >
                <button
                  type="button"
                  className={styles.open}
                  onClick={() => onOpen(project)}
                  disabled={!project.available || busy}
                >
                  <span className={styles.icon}>
                    <FolderOpen size={18} aria-hidden="true" />
                  </span>
                  <span className={styles.meta}>
                    <span className={styles.name}>{project.name}</span>
                    <span className={styles.path} title={project.path}>{project.path}</span>
                    <span className={styles.date}>
                      <Clock3 size={12} aria-hidden="true" />
                      {project.available ? formatOpenedAt(project.lastOpenedAt) : 'ファイルが見つかりません'}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => onRemove(project)}
                  disabled={busy}
                  aria-label={`${project.name}を履歴から削除`}
                  title="履歴から削除"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            ))
          )}
        </div>
    </AccessibleDialog>
  );
}
