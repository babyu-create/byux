import { useState } from 'react';
import { useMediaStore } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import { detectBeats } from '../../lib/audio';
import type { MediaAsset } from '../../lib/types';
import styles from './BeatDetectionSection.module.css';

interface BeatDetectionSectionProps {
  asset: MediaAsset;
}

export function BeatDetectionSection({ asset }: BeatDetectionSectionProps) {
  const setBeats = useMediaStore((s) => s.setAssetBeats);
  const showMessage = useProjectStore((s) => s.showMessage);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const beatCount = asset.beats?.length ?? 0;

  const runDetection = async () => {
    setIsAnalyzing(true);
    try {
      const beats = await detectBeats(asset.file);
      setBeats(asset.id, beats);
      showMessage('success', `${beats.length}個のビート検出`);
    } catch (err) {
      showMessage(
        'error',
        err instanceof Error ? err.message : 'ビート検出に失敗しました',
      );
    } finally {
      setIsAnalyzing(false);
    }
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
          onClick={runDetection}
          disabled={isAnalyzing}
        >
          {isAnalyzing ? '🔄 解析中…' : beatCount > 0 ? '🔁 再検出' : '🎵 ビート検出'}
        </button>
        {beatCount > 0 ? (
          <button type="button" className={styles.secondaryBtn} onClick={clearBeats}>
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
