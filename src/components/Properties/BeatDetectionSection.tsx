import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Music, Square } from 'lucide-react';
import { useMediaStore } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import { detectBeats } from '../../lib/audio';
import { mediaAssetToFile } from '../../lib/media';
import type { MediaAsset } from '../../lib/types';
import styles from './BeatDetectionSection.module.css';

interface BeatDetectionSectionProps {
  asset: MediaAsset;
}

export function BeatDetectionSection({ asset }: BeatDetectionSectionProps) {
  const setBeats = useMediaStore((s) => s.setAssetBeats);
  const showMessage = useProjectStore((s) => s.showMessage);
  const analysisKey = `${asset.id}:${asset.sourceToken ?? 'web'}:${asset.audioStreamIndex ?? 'default'}`;
  const [analyzingKey, setAnalyzingKey] = useState<string | null>(null);
  const requestId = useRef(0);
  const beatCount = asset.beats?.length ?? 0;
  const isAnalyzing = analyzingKey === analysisKey;
  const canCancelNative = Boolean(
    asset.sourceToken && window.fce?.cancelMediaBeatDetection,
  );

  useEffect(() => {
    return () => {
      requestId.current += 1;
      if (asset.sourceToken) {
        void window.fce?.cancelMediaBeatDetection?.(asset.sourceToken);
      }
    };
  }, [asset.id, asset.sourceToken, asset.audioStreamIndex]);

  const runDetection = async () => {
    const currentRequest = requestId.current + 1;
    const startingAudioStreamIndex = asset.audioStreamIndex;
    requestId.current = currentRequest;
    setAnalyzingKey(analysisKey);
    try {
      let beats: number[];
      if (asset.sourceToken && window.fce?.detectMediaBeats) {
        const result = await window.fce.detectMediaBeats(asset.sourceToken);
        if (!result.ok) {
          if (result.canceled) return;
          throw new Error(result.error);
        }
        beats = result.beats;
      } else {
        // Browser-only fallback. Electron always takes the bounded native path
        // above, so long disk-backed sources are never copied into a Blob.
        beats = await detectBeats(await mediaAssetToFile(asset));
      }
      if (requestId.current !== currentRequest) return;
      const currentAsset = useMediaStore.getState().assets.find(
        (candidate) => candidate.id === asset.id,
      );
      if (
        !currentAsset ||
        currentAsset.sourceToken !== asset.sourceToken ||
        currentAsset.audioStreamIndex !== startingAudioStreamIndex
      ) return;
      setBeats(asset.id, beats);
      showMessage('success', `${beats.length}個のビート検出`);
    } catch (err) {
      showMessage(
        'error',
        err instanceof Error ? err.message : 'ビート検出に失敗しました',
      );
    } finally {
      if (requestId.current === currentRequest) setAnalyzingKey(null);
    }
  };

  const cancelDetection = () => {
    requestId.current += 1;
    if (asset.sourceToken) {
      void window.fce?.cancelMediaBeatDetection?.(asset.sourceToken);
    }
    setAnalyzingKey(null);
    showMessage('info', 'ビート検出を中止しました');
  };

  const clearBeats = () => {
    setBeats(asset.id, []);
    showMessage('info', 'ビートをクリア');
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>ビート検出</span>
        <span className={`${styles.count} ${beatCount > 0 ? styles.countActive : ''}`}>
          {beatCount}
        </span>
      </div>

      <div className={styles.body}>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={isAnalyzing && canCancelNative ? cancelDetection : runDetection}
          disabled={isAnalyzing && !canCancelNative}
        >
          {isAnalyzing ? (
            <>
              {canCancelNative
                ? <Square size={13} strokeWidth={2} fill="currentColor" aria-hidden="true" />
                : <Loader2 size={15} strokeWidth={2} className={styles.spin} aria-hidden="true" />}
              <span>{canCancelNative ? '解析を中止' : '解析中…'}</span>
            </>
          ) : beatCount > 0 ? (
            <>
              <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
              <span>再検出</span>
            </>
          ) : (
            <>
              <Music size={15} strokeWidth={2} aria-hidden="true" />
              <span>ビート検出</span>
            </>
          )}
        </button>
        {beatCount > 0 ? (
          <button type="button" className={styles.secondaryBtn} onClick={clearBeats} disabled={isAnalyzing}>
            クリア
          </button>
        ) : null}
      </div>

      <div className={styles.hint}>
        検出後、クリップ端ドラッグでビートにスナップ可能
      </div>
    </div>
  );
}
