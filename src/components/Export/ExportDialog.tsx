import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { exportProject } from '../../lib/exporter';
import styles from './ExportDialog.module.css';

interface ExportDialogProps {
  onClose: () => void;
}

type Phase = 'idle' | 'rendering' | 'done' | 'error';

export function ExportDialog({ onClose }: ExportDialogProps) {
  const clips = useProjectStore((s) => s.clips);
  const tracks = useProjectStore((s) => s.tracks);
  const aspectRatio = useProjectStore((s) => s.aspectRatio);
  const projectFps = useProjectStore((s) => s.fps);
  const projectResolution = useProjectStore((s) => s.resolution);
  const assets = useMediaStore((s) => s.assets);

  const [resolution, setResolution] = useState<'720p' | '1080p'>(projectResolution);
  const [fps, setFps] = useState<30 | 60>(projectFps);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [fileSizeMb, setFileSizeMb] = useState<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (phase !== 'rendering') return;
    const id = window.setInterval(() => {
      setElapsedSec((Date.now() - startTimeRef.current) / 1000);
    }, 200);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  const totalClips = clips.filter((c) => {
    const t = tracks.find((tr) => tr.id === c.trackId);
    return t?.kind === 'video';
  }).length;

  const handleStart = async () => {
    setPhase('rendering');
    setProgress(0);
    setStage('開始中');
    setLogs([]);
    setError(null);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
    startTimeRef.current = Date.now();

    try {
      const blob = await exportProject(
        { clips, tracks, assets },
        {
          resolution,
          fps,
          aspectRatio,
          onProgress: ({ stage: s, percent, log }) => {
            setStage(s);
            setProgress(percent);
            if (log) {
              setLogs((prev) => {
                const next = [...prev, log];
                return next.length > 60 ? next.slice(next.length - 60) : next;
              });
            }
          },
        },
      );
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setFileSizeMb(blob.size / (1024 * 1024));
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : '不明なエラー');
      setPhase('error');
    }
  };

  const filename = `fps-clip-${Date.now()}.mp4`;

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>📦 書き出し</span>
          {phase !== 'rendering' ? (
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="閉じる"
            >
              ×
            </button>
          ) : null}
        </div>

        <div className={styles.body}>
          <div className={styles.summary}>
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>映像クリップ</span>
              <span className={styles.summaryValue}>{totalClips}本</span>
            </div>
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>アスペクト比</span>
              <span className={styles.summaryValue}>{aspectRatio}</span>
            </div>
          </div>

          {phase === 'idle' || phase === 'error' ? (
            <>
              <div className={styles.optionRow}>
                <span className={styles.optionLabel}>解像度</span>
                <div className={styles.btnGroup}>
                  <button
                    type="button"
                    className={`${styles.optBtn} ${resolution === '720p' ? styles.optActive : ''}`}
                    onClick={() => setResolution('720p')}
                  >
                    720p
                  </button>
                  <button
                    type="button"
                    className={`${styles.optBtn} ${resolution === '1080p' ? styles.optActive : ''}`}
                    onClick={() => setResolution('1080p')}
                  >
                    1080p
                  </button>
                </div>
              </div>
              <div className={styles.optionRow}>
                <span className={styles.optionLabel}>FPS</span>
                <div className={styles.btnGroup}>
                  <button
                    type="button"
                    className={`${styles.optBtn} ${fps === 30 ? styles.optActive : ''}`}
                    onClick={() => setFps(30)}
                  >
                    30
                  </button>
                  <button
                    type="button"
                    className={`${styles.optBtn} ${fps === 60 ? styles.optActive : ''}`}
                    onClick={() => setFps(60)}
                  >
                    60
                  </button>
                </div>
              </div>

              {error ? <div className={styles.error}>⚠ {error}</div> : null}
            </>
          ) : null}

          {phase === 'rendering' ? (
            <>
              <div className={styles.progressLabel}>
                <span>{stage}</span>
                <span className={styles.progressNum}>{Math.round(progress * 100)}%</span>
              </div>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <div className={styles.elapsed}>経過時間: {elapsedSec.toFixed(1)}s</div>
              {logs.length > 0 ? (
                <pre className={styles.log}>{logs.slice(-12).join('\n')}</pre>
              ) : null}
            </>
          ) : null}

          {phase === 'done' && downloadUrl ? (
            <div className={styles.doneBlock}>
              <div className={styles.doneIcon}>✓</div>
              <div className={styles.doneText}>書き出し完了</div>
              <div className={styles.doneStats}>
                {fileSizeMb !== null ? `${fileSizeMb.toFixed(1)} MB` : ''}
                {elapsedSec > 0 ? ` / ${elapsedSec.toFixed(1)}s` : ''}
              </div>
              <a
                className={styles.downloadBtn}
                href={downloadUrl}
                download={filename}
              >
                ⬇ ダウンロード
              </a>
            </div>
          ) : null}
        </div>

        <div className={styles.footer}>
          {phase === 'idle' || phase === 'error' ? (
            <>
              <button type="button" className={styles.btnCancel} onClick={onClose}>
                キャンセル
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={handleStart}
                disabled={totalClips === 0}
              >
                書き出し開始
              </button>
            </>
          ) : phase === 'done' ? (
            <button type="button" className={styles.btnPrimary} onClick={onClose}>
              閉じる
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
