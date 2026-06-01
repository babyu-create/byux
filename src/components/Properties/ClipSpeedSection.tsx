import { useProjectStore } from '../../stores/projectStore';
import type { Clip } from '../../lib/types';
import { clipSourceDuration } from '../../lib/timeline';
import {
  FAST_TO_SLOW_PRESET,
  SLOW_TO_FAST_PRESET,
  hasSpeedRamp,
  type SpeedRamp,
} from '../../lib/speedRamp';
import styles from './ClipSpeedSection.module.css';

interface ClipSpeedSectionProps {
  clip: Clip;
}

const PRESETS: number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

// One-click speed-ramp presets (kept minimal — Byux exposes pro features as
// presets, not a curve editor). Each ramp's mean velocity is 1, so it changes
// WHEN the source is consumed, not the clip's timeline duration.
const RAMP_PRESETS: Array<{ id: string; label: string; ramp: SpeedRamp }> = [
  { id: 'slow-fast', label: 'スロー→急加速', ramp: SLOW_TO_FAST_PRESET },
  { id: 'fast-slow', label: '急→スロー', ramp: FAST_TO_SLOW_PRESET },
];

/** Match a stored ramp to a preset id (for active-state highlighting). */
function activeRampPresetId(ramp: SpeedRamp | undefined): string | null {
  if (!hasSpeedRamp(ramp)) return null;
  for (const p of RAMP_PRESETS) {
    if (
      Math.abs(p.ramp.from - ramp.from) < 1e-3 &&
      Math.abs(p.ramp.to - ramp.to) < 1e-3 &&
      (p.ramp.easing ?? 'easeIn') === (ramp.easing ?? 'easeIn')
    ) {
      return p.id;
    }
  }
  return 'custom';
}

export function ClipSpeedSection({ clip }: ClipSpeedSectionProps) {
  const setSpeed = useProjectStore((s) => s.setClipSpeed);
  const setRamp = useProjectStore((s) => s.setClipSpeedRamp);
  const speed = clip.speed ?? 1;
  const sourceDur = clipSourceDuration(clip);
  const timelineDur = sourceDur / speed;
  const rampActiveId = activeRampPresetId(clip.speedRamp);

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

      <div className={styles.rampHeader}>
        <span className={styles.rampTitle}>速度リマップ</span>
        {rampActiveId ? (
          <button
            type="button"
            className={styles.rampClear}
            onClick={() => setRamp(clip.id, null)}
            title="速度リマップを解除"
          >
            解除
          </button>
        ) : null}
      </div>
      <div className={styles.rampGroup} role="group" aria-label="速度リマップ">
        {RAMP_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`${styles.rampBtn} ${rampActiveId === p.id ? styles.rampActive : ''}`}
            onClick={() =>
              setRamp(clip.id, rampActiveId === p.id ? null : p.ramp)
            }
            aria-pressed={rampActiveId === p.id}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className={styles.rampHint}>
        平均速度は{speed}×のまま、開始→終了で速度が変化（長さは変わりません）
      </p>

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
