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

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  available: boolean;
}

interface ProjectFileResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  text?: string;
  error?: string;
}

interface ProjectAPI {
  openDialog(): Promise<ProjectFileResult>;
  save(payload: {
    text: string;
    suggestedName: string;
    saveAs: boolean;
  }): Promise<ProjectFileResult>;
  confirmOpen(path: string): Promise<boolean>;
  autosave(text: string): Promise<{ ok: boolean; error?: string }>;
  checkRecovery(): Promise<
    | { ok: true; recovered: false }
    | { ok: true; recovered: true; text: string; path: string | null }
    | { ok: false; error: string }
  >;
  listRecent(): Promise<RecentProject[]>;
  openRecent(path: string): Promise<ProjectFileResult>;
  removeRecent(path: string): Promise<boolean>;
}

interface ExportAPI {
  chooseOutput(payload: {
    suggestedName: string;
    estimatedBytes: number;
  }): Promise<{
    ok: boolean;
    canceled?: boolean;
    token?: string;
    path?: string;
    freeBytes?: number;
    error?: string;
  }>;
  writeChunk(
    token: string,
    offset: number,
    chunk: Uint8Array<ArrayBuffer>,
    final: boolean,
  ): Promise<{
    ok: boolean;
    complete?: boolean;
    path?: string;
    bytesWritten?: number;
    error?: string;
  }>;
  abandon(token: string): Promise<boolean>;
  openFile(): Promise<boolean>;
  showInFolder(): Promise<boolean>;
}

interface FCEGlobal {
  appName: string;
  /** Version from package.json — see preload.cjs. Absent on the web build. */
  appVersion?: string;
  isElectron: boolean;
  updater?: UpdaterAPI;
  project?: ProjectAPI;
  export?: ExportAPI;
  /** Tell the main process whether there are unsaved edits (see `close` handler in electron/main.cjs). */
  setDirty?: (dirty: boolean) => void;
  /** Real disk path of a File the user dropped/picked (empty string if none). */
  getPathForFile?: (file: File) => string;
  /** Register a saved source path and receive an opaque streaming handle. */
  registerMediaFile?: (ref: {
    path: string;
    name: string;
    size: number;
    kind: 'video' | 'audio';
  }) => Promise<{ token: string; url: string; size: number } | null>;
  /** Bounded source read used only by explicit heavyweight operations. */
  readMediaFileChunk?: (
    token: string,
    offset: number,
    length: number,
  ) => Promise<Uint8Array<ArrayBuffer> | null>;
  releaseMediaFile?: (token: string) => Promise<boolean>;
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
