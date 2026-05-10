import { useEffect, useState } from 'react';
import styles from './UpdateBanner.module.css';

type UpdaterEvent =
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'up-to-date' }
  | { status: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string };

interface UpdaterAPI {
  onEvent(cb: (e: UpdaterEvent) => void): () => void;
  check(): Promise<unknown>;
  installAndRestart(): Promise<unknown>;
}

interface FCEGlobal {
  appName: string;
  isElectron: boolean;
  updater?: UpdaterAPI;
}

declare global {
  interface Window {
    fce?: FCEGlobal;
  }
}

export function UpdateBanner() {
  const [event, setEvent] = useState<UpdaterEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const updater = window.fce?.updater;
    if (!updater) return;
    const off = updater.onEvent((e) => {
      setEvent(e);
      setDismissed(false);
    });
    return off;
  }, []);

  if (dismissed || !event) return null;
  if (event.status === 'up-to-date' || event.status === 'checking') return null;
  if (event.status === 'error') return null; // silent on errors

  const handleInstall = () => {
    window.fce?.updater?.installAndRestart();
  };

  if (event.status === 'available') {
    return (
      <div className={styles.banner} data-state="available" role="status">
        <span className={styles.icon}>🆕</span>
        <span className={styles.text}>
          新しいバージョン <strong>v{event.version}</strong> のダウンロードを開始しました…
        </span>
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={() => setDismissed(true)}
          aria-label="閉じる"
        >
          ×
        </button>
      </div>
    );
  }

  if (event.status === 'downloading') {
    const percent = Math.round(event.percent);
    return (
      <div className={styles.banner} data-state="downloading" role="status">
        <span className={styles.icon}>⬇</span>
        <span className={styles.text}>
          ダウンロード中... <strong>{percent}%</strong>
        </span>
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  if (event.status === 'downloaded') {
    return (
      <div className={styles.banner} data-state="downloaded" role="status">
        <span className={styles.icon}>✓</span>
        <span className={styles.text}>
          <strong>v{event.version}</strong> ダウンロード完了。再起動して適用しますか？
        </span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() => setDismissed(true)}
          >
            次回起動時
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleInstall}
          >
            今すぐ再起動
          </button>
        </div>
      </div>
    );
  }

  return null;
}
