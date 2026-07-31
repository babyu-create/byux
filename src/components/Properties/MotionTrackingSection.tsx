import { useMemo, useState } from 'react';
import { Crosshair, ScanSearch, Square } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { trackVideoElement, type TrackingRegion } from '../../lib/motionTracker';
import { clipDuration } from '../../lib/timeline';
import type { Clip, MediaAsset } from '../../lib/types';
import styles from './MotionTrackingSection.module.css';

interface MotionTrackingSectionProps {
  clip: Clip;
  asset: MediaAsset;
}

const DEFAULT_REGION: TrackingRegion = { x: 0.4, y: 0.3, width: 0.2, height: 0.2 };

export function MotionTrackingSection({ clip, asset }: MotionTrackingSectionProps) {
  const setClipTransform = useProjectStore((state) => state.setClipTransform);
  const showMessage = useProjectStore((state) => state.showMessage);
  const fps = useProjectStore((state) => state.fps);
  const [region, setRegion] = useState(DEFAULT_REGION);
  const [progress, setProgress] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [cancel, setCancel] = useState<AbortController | null>(null);
  const duration = useMemo(() => clipDuration(clip), [clip]);

  const updateRegion = (key: keyof TrackingRegion, value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    setRegion((current) => ({ ...current, [key]: Math.max(0.02, Math.min(0.96, parsed / 100)) }));
  };

  const run = async () => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.src = asset.url;
    const controller = new AbortController();
    setCancel(controller);
    setProgress(0);
    setConfidence(null);
    try {
      await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('動画を追跡用に読み込めませんでした')); };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', done);
          video.removeEventListener('error', fail);
        };
        video.addEventListener('loadedmetadata', done, { once: true });
        video.addEventListener('error', fail, { once: true });
        video.load();
      });
      const result = await trackVideoElement(video, {
        startTime: clip.trimStart,
        endTime: clip.trimEnd,
        fps,
        region,
        onProgress: setProgress,
        signal: controller.signal,
      });
      setClipTransform(clip.id, {
        ...(clip.transform ?? {}),
        x: result.x,
        y: result.y,
      });
      setConfidence(result.averageConfidence);
      showMessage(
        result.averageConfidence >= 0.55 ? 'success' : 'info',
        `追跡完了（${result.frameCount}フレーム / 信頼度 ${Math.round(result.averageConfidence * 100)}%）`,
        4000,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        showMessage('info', 'モーショントラッキングを中止しました', 2500);
      } else {
        showMessage('error', error instanceof Error ? error.message : '追跡に失敗しました', 5000);
      }
    } finally {
      video.removeAttribute('src');
      video.load();
      setProgress(null);
      setCancel(null);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.description}>
        <Crosshair size={14} aria-hidden="true" />
        <span>映像内の範囲を追跡し、位置キーフレームとして適用します。</span>
      </div>
      <div className={styles.regionGrid}>
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <label key={key}>
            <span>{key === 'x' ? '左' : key === 'y' ? '上' : key === 'width' ? '幅' : '高さ'} %</span>
            <input
              type="number"
              min={2}
              max={96}
              step={1}
              value={Math.round(region[key] * 100)}
              onChange={(event) => updateRegion(key, event.target.value)}
              disabled={progress !== null}
            />
          </label>
        ))}
      </div>
      {progress !== null ? (
        <div className={styles.progress} role="status">
          <div className={styles.progressBar} style={{ width: `${Math.round(progress * 100)}%` }} />
          <span>{Math.round(progress * 100)}% / 追跡中（クリックで中止）</span>
          <button type="button" onClick={() => cancel?.abort()} aria-label="追跡を中止">
            <Square size={12} fill="currentColor" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button type="button" className={styles.run} onClick={() => void run()}>
          <ScanSearch size={14} aria-hidden="true" />
          {confidence === null ? `範囲を追跡（${duration.toFixed(1)}秒）` : `再追跡（信頼度 ${Math.round(confidence * 100)}%）`}
        </button>
      )}
      <p className={styles.note}>まず対象を中央付近に置き、4つの数値で囲みを合わせてください。追跡結果は横/縦位置のキーフレームになります。</p>
    </div>
  );
}
