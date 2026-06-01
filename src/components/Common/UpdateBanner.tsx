import { useEffect, useState } from 'react';
import { Sparkles, Download, CheckCircle2 } from 'lucide-react';
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
  download(): Promise<unknown>;
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

  // Unsigned artifacts have no publisher verification, so the download only
  // starts when the user explicitly requests it — never automatically.
  const handleDownload = () => {
    window.fce?.updater?.download();
  };

  if (event.status === 'available') {
    return (
      <div className={styles.banner} data-state="available" role="status">
        <span className={styles.icon}><Sparkles size={16} strokeWidth={2} aria-hidden="true" /></span>
        <span className={styles.text}>
          新しいバージョン <strong>v{event.version}</strong> が利用可能です。
        </span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() => setDismissed(true)}
          >
            あとで
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleDownload}
          >
            ダウンロード
          </button>
        </div>
      </div>
    );
  }

  if (event.status === 'downloading') {
    const percent = Math.round(event.percent);
    return (
      <div className={styles.banner} data-state="downloading" role="status">
        <span className={styles.icon}><Download size={16} strokeWidth={2} aria-hidden="true" /></span>
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
        <span className={styles.icon}><CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" /></span>
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
