import { useProjectStore } from '../../stores/projectStore';
import type { Clip } from '../../lib/types';
import { clipSourceDuration } from '../../lib/timeline';
import styles from './ClipSpeedSection.module.css';

interface ClipSpeedSectionProps {
  clip: Clip;
}

const PRESETS: number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function ClipSpeedSection({ clip }: ClipSpeedSectionProps) {
  const setSpeed = useProjectStore((s) => s.setClipSpeed);
  const speed = clip.speed ?? 1;
  const sourceDur = clipSourceDuration(clip);
  const timelineDur = sourceDur / speed;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>再生速度</span>
        <span
          className={`${styles.count} ${speed !== 1 ? styles.countActive : ''}`}
        >
          {speed === 0.25
            ? '¼×'
            : speed === 0.5
              ? '½×'
              : speed === 0.75
                ? '¾×'
                : `${speed}×`}
        </span>
      </div>

      <div className={styles.presetGroup} role="group" aria-label="再生速度">
        {PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.presetBtn} ${speed === s ? styles.active : ''}`}
            onClick={() => setSpeed(clip.id, s)}
          >
            {s === 0.25
              ? '¼×'
              : s === 0.5
                ? '½×'
                : s === 0.75
                  ? '¾×'
                  : `${s}×`}
          </button>
        ))}
      </div>

      <div className={styles.sliderRow}>
        <input
          type="range"
          min={0.1}
          max={2}
          step={0.05}
          value={speed}
          onChange={(e) => setSpeed(clip.id, parseFloat(e.target.value))}
          className={styles.slider}
        />
      </div>

      <div className={styles.estimateRow}>
        <span className={styles.estimateLabel}>タイムライン上の長さ</span>
        <span className={styles.estimateValue}>{timelineDur.toFixed(2)}秒</span>
      </div>
      <div className={styles.estimateRow}>
        <span className={styles.estimateLabel}>元素材長</span>
        <span className={styles.estimateValueSub}>{sourceDur.toFixed(2)}秒</span>
      </div>
    </div>
  );
}
