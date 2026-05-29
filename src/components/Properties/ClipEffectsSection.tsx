import { useProjectStore } from '../../stores/projectStore';
import type { Clip } from '../../lib/types';
import styles from './ClipEffectsSection.module.css';

interface ClipEffectsSectionProps {
  clip: Clip;
}

export function ClipEffectsSection({ clip }: ClipEffectsSectionProps) {
  const toggleEffect = useProjectStore((s) => s.toggleClipEffect);
  const updateEffect = useProjectStore((s) => s.updateClipEffect);

  const fadeIn = clip.effects.find((e) => e.type === 'fade-in');
  const fadeOut = clip.effects.find((e) => e.type === 'fade-out');
  const motionBlur = clip.effects.find((e) => e.type === 'motion-blur');

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>エフェクト</span>
        <span className={styles.count}>{clip.effects.length}</span>
      </div>

      {/* Fade In */}
      <div className={`${styles.effect} ${fadeIn ? styles.active : ''}`}>
        <div className={styles.effectHeader}>
          <button
            type="button"
            className={`${styles.toggle} ${fadeIn ? styles.toggleOn : ''}`}
            onClick={() => toggleEffect(clip.id, 'fade-in')}
            aria-pressed={!!fadeIn}
          >
            <span className={styles.toggleIcon}>◐</span>
            <span>フェードイン</span>
            <span className={styles.toggleHint}>黒から徐々に表示</span>
          </button>
        </div>
        {fadeIn ? (
          <div className={styles.controls}>
            <label className={styles.row}>
              <span className={styles.rowLabel}>長さ</span>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.1}
                value={fadeIn.duration ?? 0.4}
                onChange={(e) =>
                  updateEffect(clip.id, 'fade-in', {
                    duration: parseFloat(e.target.value),
                  })
                }
              />
              <span className={styles.rowValue}>
                {(fadeIn.duration ?? 0.4).toFixed(1)}s
              </span>
            </label>
          </div>
        ) : null}
      </div>

      {/* Motion Blur */}
      <div className={`${styles.effect} ${motionBlur ? styles.active : ''}`}>
        <div className={styles.effectHeader}>
          <button
            type="button"
            className={`${styles.toggle} ${motionBlur ? styles.toggleOn : ''}`}
            onClick={() => toggleEffect(clip.id, 'motion-blur')}
            aria-pressed={!!motionBlur}
          >
            <span className={styles.toggleIcon}>≋</span>
            <span>モーションブラー</span>
            <span className={styles.toggleHint}>
              フリック検出型（動いてる時だけ残像、エイム合わせ中は鮮明）
            </span>
          </button>
        </div>
        {motionBlur ? (
          <div className={styles.controls}>
            <div className={styles.intensityRow}>
              <span className={styles.rowLabel}>強さ</span>
              <span className={styles.intensityDescriptor} aria-hidden="true">
                弱
              </span>
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={motionBlur.intensity ?? 40}
                onChange={(e) =>
                  updateEffect(clip.id, 'motion-blur', {
                    intensity: parseInt(e.target.value, 10),
                  })
                }
                aria-label="モーションブラー強度 (5から100)"
                aria-valuemin={5}
                aria-valuemax={100}
                aria-valuenow={motionBlur.intensity ?? 40}
              />
              <span className={styles.intensityDescriptor} aria-hidden="true">
                強
              </span>
              <span className={styles.rowValue}>
                {(motionBlur.intensity ?? 40).toFixed(0)}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Fade Out */}
      <div className={`${styles.effect} ${fadeOut ? styles.active : ''}`}>
        <div className={styles.effectHeader}>
          <button
            type="button"
            className={`${styles.toggle} ${fadeOut ? styles.toggleOn : ''}`}
            onClick={() => toggleEffect(clip.id, 'fade-out')}
            aria-pressed={!!fadeOut}
          >
            <span className={styles.toggleIcon}>◑</span>
            <span>フェードアウト</span>
            <span className={styles.toggleHint}>徐々に黒へフェード</span>
          </button>
        </div>
        {fadeOut ? (
          <div className={styles.controls}>
            <label className={styles.row}>
              <span className={styles.rowLabel}>長さ</span>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.1}
                value={fadeOut.duration ?? 0.4}
                onChange={(e) =>
                  updateEffect(clip.id, 'fade-out', {
                    duration: parseFloat(e.target.value),
                  })
                }
              />
              <span className={styles.rowValue}>
                {(fadeOut.duration ?? 0.4).toFixed(1)}s
              </span>
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}
