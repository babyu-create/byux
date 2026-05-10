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
