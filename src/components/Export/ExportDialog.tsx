import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FolderOpen, Play } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import {
  exportProject,
  getActiveCoreVariant,
  getActiveCoreThreadCount,
  resetFFmpeg,
  type ExportQualityPreset,
} from '../../lib/exporter';
import { clipDuration } from '../../lib/timeline';
import styles from './ExportDialog.module.css';

interface ExportDialogProps {
  onClose: () => void;
}

type Phase = 'idle' | 'rendering' | 'done' | 'error';

/**
 * Structured error result for the dialog. `message` is the headline shown
 * to the user; `steps` is an ordered list of "next things to try" rendered
 * as a small troubleshooting checklist. The detail string is the raw error
 * for the disclosure block.
 */
interface HumanizedError {
  message: string;
  steps: string[];
  detail?: string;
}

/** Maps known error message fragments to user-friendly Japanese explanations
 * with actionable next-step guidance. The "steps" list orders things by
 * effort (cheapest first) so users self-resolve before pinging support. */
function humanizeError(raw: string): HumanizedError {
  if (raw.includes('FFmpeg 初期化失敗') || raw.includes('ffmpeg-core')) {
    return {
      message: 'FFmpeg の初期化に失敗しました',
      steps: [
        'ネットワーク接続を確認',
        'ページをリロード（Ctrl+R / Cmd+R）',
        '別ブラウザで再試行',
        'それでも駄目なら GitHub Issue で報告',
      ],
      detail: raw,
    };
  }
  if (raw.includes('SharedArrayBuffer') || raw.includes('crossOriginIsolated')) {
    return {
      message: 'マルチスレッドモードに必要な SharedArrayBuffer が利用できません',
      steps: [
        'ページをリロード',
        'ブラウザのセキュリティ設定を確認（Cross-Origin Isolation）',
        '単一スレッドモードで再試行',
      ],
      detail: raw,
    };
  }
  if (raw.includes('映像クリップがありません') || raw.includes('元素材が見つかりません')) {
    return {
      message: '書き出せる映像クリップがありません',
      steps: [
        'タイムラインにクリップを追加',
        'メディアライブラリから素材をドラッグ',
      ],
    };
  }
  if (raw.includes('タイムアウト') || raw.includes('timed out')) {
    return {
      message: 'FFmpeg コアの読み込みがタイムアウトしました',
      steps: [
        'ネットワーク接続を確認',
        'ページをリロード',
        '時間を置いて再試行',
      ],
      detail: raw,
    };
  }
  if (raw.includes('out of memory') || raw.includes('OOM') || raw.includes('memory')) {
    return {
      message: 'メモリ不足です',
      steps: [
        '解像度を 720p に下げる',
        'クリップ数を減らして書き出し',
        'ブラウザの他タブを閉じる',
      ],
      detail: raw,
    };
  }
  return {
    message: '書き出しに失敗しました',
    steps: [
      'ページをリロードして再試行',
      '解像度やクリップ数を変えて再試行',
    ],
    detail: raw,
  };
}

function getInitialCoreLabel(): string {
  const variant = getActiveCoreVariant();
  const threadCount = getActiveCoreThreadCount();
  return variant === 'mt' ? `MT (${threadCount} threads)` : '';
}

function estimateExportBytes(
  durationSeconds: number,
  resolution: '720p' | '1080p',
  fps: 30 | 60,
  quality: ExportQualityPreset,
): number {
  const baseVideoBitrate =
    resolution === '1080p'
      ? (fps === 60 ? 16_000_000 : 10_000_000)
      : (fps === 60 ? 9_000_000 : 6_000_000);
  const multiplier = quality === 'high' ? 1.45 : quality === 'compact' ? 0.62 : 1;
  const audioBitrate = quality === 'compact' ? 128_000 : 256_000;
  return Math.ceil(Math.max(1, durationSeconds) * (baseVideoBitrate * multiplier + audioBitrate) / 8);
}

async function writeBlobToNative(
  token: string,
  blob: Blob,
  onProgress: (fraction: number) => void,
): Promise<string> {
  const api = window.fce?.export;
  if (!api) throw new Error('保存機能を利用できません');
  const reader = blob.stream().getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // IPC receives an owned ArrayBuffer so a pooled/SharedArrayBuffer-backed
      // view can never escape the renderer sandbox.
      const chunk = new Uint8Array(value);
      const result = await api.writeChunk(token, offset, chunk, false);
      if (!result.ok) throw new Error(result.error ?? '動画ファイルへの保存に失敗しました');
      offset += chunk.byteLength;
      onProgress(blob.size > 0 ? offset / blob.size : 1);
    }
    const result = await api.writeChunk(token, offset, new Uint8Array(0), true);
    if (!result.ok || !result.complete || !result.path) {
      throw new Error(result.error ?? '動画ファイルを完了できませんでした');
    }
    return result.path;
  } finally {
    reader.releaseLock();
  }
}

export function ExportDialog({ onClose }: ExportDialogProps) {
  const clips = useProjectStore((s) => s.clips);
  const tracks = useProjectStore((s) => s.tracks);
  const markers = useProjectStore((s) => s.markers);
  const aspectRatio = useProjectStore((s) => s.aspectRatio);
  const projectFps = useProjectStore((s) => s.fps);
  const projectResolution = useProjectStore((s) => s.resolution);
  const projectName = useProjectStore((s) => s.name);
  const hudPreset = useProjectStore((s) => s.hudPreset);
  const verticalReframe = useProjectStore((s) => s.verticalReframe);
  const audioDucking = useProjectStore((s) => s.audioDucking);
  const assets = useMediaStore((s) => s.assets);

  const [resolution, setResolution] = useState<'720p' | '1080p'>(projectResolution);
  const [fps, setFps] = useState<30 | 60>(projectFps);
  const [quality, setQuality] = useState<ExportQualityPreset>('recommended');
  const [motionBlur, setMotionBlur] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<HumanizedError | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [fileSizeMb, setFileSizeMb] = useState<number | null>(null);
  const [etaLabel, setEtaLabel] = useState<string>('');
  const [customFilename, setCustomFilename] = useState('');
  const [fallbackFilename] = useState(() => `fps-clip-${Date.now()}.mp4`);
  const startTimeRef = useRef<number>(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Derive core variant label for the badge (updates after FFmpeg loads).
  const [coreLabel, setCoreLabel] = useState<string>(getInitialCoreLabel);

  useEffect(() => {
    if (phase !== 'rendering') return;
    const id = window.setInterval(() => {
      const now = Date.now();
      if (startTimeRef.current === 0) startTimeRef.current = now;
      setElapsedSec((now - startTimeRef.current) / 1000);
      // Refresh the core variant badge while rendering (it may have just loaded).
      const v = getActiveCoreVariant();
      const tc = getActiveCoreThreadCount();
      setCoreLabel(v === 'mt' ? `MT (${tc} threads)` : 'ST (single thread)');
    }, 200);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  const mainVideoTrack = tracks.find((track) => track.kind === 'video');
  const totalClips =
    mainVideoTrack && !mainVideoTrack.hidden
      ? clips.filter((clip) => clip.trackId === mainVideoTrack.id).length
      : 0;
  const exportDuration =
    mainVideoTrack && !mainVideoTrack.hidden
      ? clips
          .filter((clip) => clip.trackId === mainVideoTrack.id)
          .reduce((sum, clip) => sum + clipDuration(clip), 0)
      : 0;
  const estimatedBytes = estimateExportBytes(exportDuration, resolution, fps, quality);
  const estimatedSizeMb = estimatedBytes / (1024 * 1024);

  // Build the output filename: prefer customFilename, fallback to project name,
  // then a timestamp.
  const safeProjectName = (projectName ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const defaultName = safeProjectName
    ? `${safeProjectName}.mp4`
    : fallbackFilename;
  const downloadFilename = customFilename.trim() || defaultName;

  const isExportingRef = useRef(false);

  const handleStart = async () => {
    if (isExportingRef.current) return;
    isExportingRef.current = true;
    let nativeToken: string | null = null;
    try {
      const nativeExport = window.fce?.export;
      if (nativeExport) {
        const destination = await nativeExport.chooseOutput({
          suggestedName: downloadFilename,
          estimatedBytes,
        });
        if (destination.canceled) return;
        if (!destination.ok || !destination.token) {
          throw new Error(destination.error ?? '動画の保存先を選択できませんでした');
        }
        nativeToken = destination.token;
        setSavedPath(destination.path ?? null);
      }

    setPhase('rendering');
    setProgress(0);
    setStage('開始中');
    setLogs([]);
    setError(null);
    setEtaLabel('');
    setSavedPath(null);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
    startTimeRef.current = 0;
    setElapsedSec(0);

      const blob = await exportProject(
        { clips, tracks, assets, markers },
        {
          resolution,
          fps,
          quality,
          aspectRatio,
          motionBlur,
          // Carry the preview's HUD preset into the export so the blur matches
          // what the user saw (otherwise it silently defaulted to 'valorant').
          motionBlurHudPreset: hudPreset,
          motionBlurHudMaskStrength: hudPreset === 'none' ? 0 : 1,
          verticalReframe,
          // Carry the project's BGM auto-ducking into the export so the dipped
          // BGM in the preview matches the exported MP4 (Phase P5).
          audioDucking,
          onProgress: ({ stage: s, percent, log }) => {
            // Update core label whenever we receive a stage update that
            // mentions the variant (FFmpeg just finished loading).
            if (s.includes('MT') || s.includes('ST')) {
              const v = getActiveCoreVariant();
              const tc = getActiveCoreThreadCount();
              setCoreLabel(v === 'mt' ? `MT (${tc} threads)` : 'ST (single thread)');
            }

            // Extract ETA note from stage string if present.
            const etaMatch = /残り約\s*(\d+)s/.exec(s);
            if (etaMatch) {
              setEtaLabel(`残り約 ${etaMatch[1]}s`);
              // Strip ETA from stage label for cleaner display.
              setStage(s.replace(/\s*—\s*残り約\s*\d+s/, '').trim());
            } else {
              setStage(s);
            }

            if (percent >= 0) {
              setProgress(percent);
            }
            if (log) {
              setLogs((prev) => {
                const next = [...prev, log];
                return next.length > 80 ? next.slice(next.length - 80) : next;
              });
            }
          },
        },
      );
      if (nativeToken) {
        setStage('動画ファイルを保存中');
        const path = await writeBlobToNative(nativeToken, blob, (fraction) => {
          setProgress(0.95 + Math.min(1, fraction) * 0.05);
        });
        nativeToken = null;
        setSavedPath(path);
      } else {
        const url = URL.createObjectURL(blob);
        setDownloadUrl(url);
      }
      setFileSizeMb(blob.size / (1024 * 1024));
      setProgress(1);
      setPhase('done');
    } catch (e) {
      if (nativeToken) {
        await window.fce?.export?.abandon(nativeToken);
      }
      const rawMsg = e instanceof Error ? e.message : '不明なエラー';
      setError(humanizeError(rawMsg));
      setPhase('error');
      // Drop the cached FFmpeg singleton so a retry rebuilds it from
      // scratch. An exec failure (OOM, filter-graph deadlock, WASM
      // corruption) can leave the handle alive but unusable; without a
      // reset, every subsequent attempt would hit the same dead handle.
      resetFFmpeg();
    } finally {
      isExportingRef.current = false;
    }
  };

  const handleRetry = () => {
    setError(null);
    setPhase('idle');
    // Schedule the actual start on the next tick so the UI reflects the
    // phase change before re-entering the rendering branch.
    window.setTimeout(() => {
      void handleStart();
    }, 0);
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>書き出し</span>
          <div className={styles.headerRight}>
            {coreLabel ? (
              <span
                className={
                  coreLabel.startsWith('MT')
                    ? styles.badgeMt
                    : styles.badgeSt
                }
                title="FFmpeg コアモード"
              >
                {coreLabel}
              </span>
            ) : null}
            {phase !== 'rendering' ? (
              <button
                type="button"
                className={styles.closeBtn}
                onClick={onClose}
                aria-label="閉じる"
              >
                x
              </button>
            ) : null}
          </div>
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
                <span className={styles.optionLabel}>画質</span>
                <div className={styles.qualityGrid}>
                  <button
                    type="button"
                    className={`${styles.qualityBtn} ${quality === 'recommended' ? styles.qualityActive : ''}`}
                    onClick={() => setQuality('recommended')}
                  >
                    <strong>おすすめ</strong>
                    <small>画質と速さのバランス</small>
                  </button>
                  <button
                    type="button"
                    className={`${styles.qualityBtn} ${quality === 'high' ? styles.qualityActive : ''}`}
                    onClick={() => setQuality('high')}
                  >
                    <strong>高画質</strong>
                    <small>時間と容量を多めに使用</small>
                  </button>
                  <button
                    type="button"
                    className={`${styles.qualityBtn} ${quality === 'compact' ? styles.qualityActive : ''}`}
                    onClick={() => setQuality('compact')}
                  >
                    <strong>軽量</strong>
                    <small>共有しやすい小さめ容量</small>
                  </button>
                </div>
              </div>
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

              <div className={styles.optionRow}>
                <span className={styles.optionLabel}>モーションブラー</span>
                <div className={styles.btnGroup}>
                  <button
                    type="button"
                    className={`${styles.optBtn} ${!motionBlur ? styles.optActive : ''}`}
                    onClick={() => setMotionBlur(false)}
                  >
                    OFF（高速）
                  </button>
                  <button
                    type="button"
                    className={`${styles.optBtn} ${motionBlur ? styles.optActive : ''}`}
                    onClick={() => setMotionBlur(true)}
                  >
                    ON（低速）
                  </button>
                </div>
              </div>

              <div className={styles.optionRow}>
                <span className={styles.optionLabel}>ファイル名</span>
                <input
                  type="text"
                  className={styles.filenameInput}
                  placeholder={defaultName}
                  value={customFilename}
                  onChange={(e) => setCustomFilename(e.target.value)}
                  maxLength={120}
                />
              </div>
              <div className={styles.estimate}>
                約 {estimatedSizeMb < 10 ? estimatedSizeMb.toFixed(1) : Math.round(estimatedSizeMb)} MB
                <span>（{exportDuration.toFixed(1)}秒の目安）</span>
              </div>

              {error ? (
                <div className={styles.error} role="alert">
                  <div className={styles.errorHeader}>
                    <span className={styles.errorIcon} aria-hidden="true">!</span>
                    <div className={styles.errorTitle}>{error.message}</div>
                  </div>
                  {error.steps.length > 0 ? (
                    <>
                      <div className={styles.errorStepsLabel}>次に試すこと</div>
                      <ol className={styles.errorSteps}>
                        {error.steps.map((step, idx) => (
                          <li key={idx} className={styles.errorStep}>
                            {step}
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : null}
                  {error.detail ? (
                    <details className={styles.errorDetails}>
                      <summary className={styles.errorSummary}>詳細を表示</summary>
                      <pre className={styles.errorBody}>{error.detail}</pre>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {phase === 'rendering' ? (
            <>
              <div className={styles.progressLabel}>
                <span className={styles.stageText}>{stage}</span>
                <span className={styles.progressNum}>{Math.round(progress * 100)}%</span>
              </div>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <div className={styles.timerRow}>
                <span className={styles.elapsed}>経過: {elapsedSec.toFixed(1)}s</span>
                {etaLabel ? (
                  <span className={styles.eta}>{etaLabel}</span>
                ) : null}
              </div>
              {logs.length > 0 ? (
                <pre className={styles.log}>{logs.slice(-12).join('\n')}</pre>
              ) : null}
            </>
          ) : null}

          {phase === 'done' ? (
            <div className={styles.doneBlock}>
              <div className={styles.doneIcon}><CheckCircle2 size={40} strokeWidth={1.8} aria-hidden="true" /></div>
              <div className={styles.doneText}>書き出し完了</div>
              <div className={styles.doneStats}>
                {fileSizeMb !== null ? `${fileSizeMb.toFixed(1)} MB` : ''}
                {elapsedSec > 0 ? ` / ${elapsedSec.toFixed(1)}s` : ''}
              </div>
              {savedPath ? (
                <>
                  <div className={styles.savedPath} title={savedPath}>{savedPath}</div>
                  <div className={styles.doneActions}>
                    <button
                      type="button"
                      className={styles.downloadBtn}
                      onClick={() => void window.fce?.export?.openFile()}
                    >
                      <Play size={16} aria-hidden="true" />
                      動画を開く
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryAction}
                      onClick={() => void window.fce?.export?.showInFolder()}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      フォルダを開く
                    </button>
                  </div>
                </>
              ) : downloadUrl ? (
                <a
                  className={styles.downloadBtn}
                  href={downloadUrl}
                  download={downloadFilename}
                >
                  ダウンロード
                </a>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={styles.footer}>
          {phase === 'idle' ? (
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
          ) : phase === 'error' ? (
            <>
              <button type="button" className={styles.btnCancel} onClick={onClose}>
                閉じる
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={handleRetry}
                disabled={totalClips === 0}
              >
                再試行
              </button>
            </>
          ) : phase === 'done' ? (
            <button type="button" className={styles.btnPrimary} onClick={onClose}>
              閉じる
            </button>
          ) : (
            <span className={styles.renderingHint}>書き出し中はこの画面を閉じないでください</span>
          )}
        </div>
      </div>
    </div>
  );
}
