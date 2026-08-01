import { useMemo, useState } from 'react';
import { Crosshair, ScanSearch, Square } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import {
  motionTrackingTimelineTime,
  getLegacyClipTrackingMigration,
  trackVideoElement,
  type TrackingRegion,
} from '../../lib/motionTracker';
import { MAX_MOTION_TRACK_SIMPLIFICATION_ERROR_PERCENT } from '../../lib/nativeExportLimits';
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
  const updateClipOverlay = useProjectStore((state) => state.updateClipOverlay);
  const showMessage = useProjectStore((state) => state.showMessage);
  const fps = useProjectStore((state) => state.fps);
  const [region, setRegion] = useState(DEFAULT_REGION);
  const [progress, setProgress] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [cancel, setCancel] = useState<AbortController | null>(null);
  const [target, setTarget] = useState<'clip' | 'overlays'>('clip');
  const effectiveTarget = target === 'overlays' && (clip.overlays?.length ?? 0) > 0 ? target : 'clip';
  const duration = useMemo(() => clipDuration(clip), [clip]);
  const legacyMigration = useMemo(
    () => getLegacyClipTrackingMigration(clip),
    [clip],
  );

  const migrateLegacyTrack = () => {
    if (!legacyMigration) return;
    setClipTransform(clip.id, legacyMigration.transform);
    showMessage(
      'success',
      `旧追跡データを${legacyMigration.originalCount}点から${legacyMigration.keyframeCount}点へ整理しました（最大誤差 ${legacyMigration.maximumError.toFixed(2)}%）`,
      5000,
    );
  };

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
        keyframeTimeAtSourceTime: (sourceTime) =>
          motionTrackingTimelineTime(clip, sourceTime),
        onProgress: setProgress,
        signal: controller.signal,
      });
      if (result.maximumSimplificationError > MAX_MOTION_TRACK_SIMPLIFICATION_ERROR_PERCENT) {
        throw new Error(
          `動きが複雑で、書き出し可能な${result.keyframeCount}点へ精度を保ったまま整理できませんでした（最大誤差 ${result.maximumSimplificationError.toFixed(2)}%）。追跡範囲を短くして再試行してください。`,
        );
      }
      if (effectiveTarget === 'clip') {
        setClipTransform(clip.id, {
          ...(clip.transform ?? {}),
          x: result.x,
          y: result.y,
        });
      } else {
        // The native exporter rasterizes a clip's overlays into one image, so
        // applying the same track to every overlay keeps preview/export parity.
        for (const overlay of clip.overlays ?? []) {
          updateClipOverlay(clip.id, overlay.id, {
            tracking: { x: result.x, y: result.y },
          });
        }
      }
      setConfidence(result.averageConfidence);
      showMessage(
        result.averageConfidence >= 0.55 && result.maximumSimplificationError <= MAX_MOTION_TRACK_SIMPLIFICATION_ERROR_PERCENT ? 'success' : 'info',
        `追跡完了（${result.frameCount}フレーム→${result.keyframeCount}点 / 信頼度 ${Math.round(result.averageConfidence * 100)}% / 軌跡誤差 最大${result.maximumSimplificationError.toFixed(2)}%）`,
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
      <label className={styles.target}>
        <span>追従先</span>
        <select value={effectiveTarget} onChange={(event) => setTarget(event.target.value as 'clip' | 'overlays')} disabled={progress !== null}>
          <option value="clip">映像クリップ</option>
          <option value="overlays" disabled={!clip.overlays?.length}>テキスト全体</option>
        </select>
      </label>
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
        <>
          {legacyMigration ? (
            <button type="button" className={styles.run} onClick={migrateLegacyTrack}>
              <ScanSearch size={14} aria-hidden="true" />
              {`旧追跡データを安全に整理（${legacyMigration.originalCount}→${legacyMigration.keyframeCount}点）`}
            </button>
          ) : null}
          <button type="button" className={styles.run} onClick={() => void run()}>
            <ScanSearch size={14} aria-hidden="true" />
            {confidence === null ? `範囲を追跡（${duration.toFixed(1)}秒）` : `再追跡（信頼度 ${Math.round(confidence * 100)}%）`}
          </button>
        </>
      )}
      <p className={styles.note}>まず対象を中央付近に置き、4つの数値で囲みを合わせてください。追跡結果は横/縦位置のキーフレームになります。テキスト全体を選ぶと同じ動きが全テキストに適用されます。</p>
    </div>
  );
}
