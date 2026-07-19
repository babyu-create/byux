import { MoveHorizontal } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import type { Clip } from '../../lib/types';
import styles from './ClipStretchSection.module.css';

interface ClipStretchSectionProps {
  clip: Clip;
}

const SIXTEEN_NINE = 16 / 9;

/**
 * Classify a source aspect into a human label + whether it's a stretch
 * candidate. Common FPS "stretched" recording resolutions are 4:3 (1.333) and
 * 16:10 (1.600); both get displayed stretched to a 16:9 monitor in-game, so
 * both should be re-stretched to 16:9 on export. Anything already ~16:9 (or
 * portrait 9:16) doesn't need it.
 */
function classifyAspect(ratio: number): { label: string; needsStretch: boolean } {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.04;
  if (near(ratio, SIXTEEN_NINE)) return { label: '16:9', needsStretch: false };
  if (near(ratio, 9 / 16)) return { label: '9:16', needsStretch: false };
  if (near(ratio, 4 / 3)) return { label: '4:3', needsStretch: true };
  if (near(ratio, 16 / 10)) return { label: '16:10', needsStretch: true };
  if (near(ratio, 5 / 4)) return { label: '5:4', needsStretch: true };
  // Any other non-16:9 landscape narrower than 16:9 is also a candidate.
  return { label: ratio.toFixed(2), needsStretch: ratio < SIXTEEN_NINE - 0.04 };
}

export function ClipStretchSection({ clip }: ClipStretchSectionProps) {
  const setStretch = useProjectStore((s) => s.setClipStretch);
  const assets = useMediaStore((s) => s.assets);
  const asset = assets.find((a) => a.id === clip.assetId);
  const on = clip.stretchToFill ?? false;

  const w = asset?.width;
  const h = asset?.height;
  const ratio = w && h ? w / h : null;
  const aspect = ratio != null ? classifyAspect(ratio) : null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>引き伸ばし</span>
        <span className={`${styles.badge} ${on ? styles.badgeOn : ''}`}>
          {on ? 'ON' : 'OFF'}
        </span>
      </div>

      <button
        type="button"
        className={`${styles.toggle} ${on ? styles.toggleOn : ''}`}
        onClick={() => setStretch(clip.id, !on)}
        aria-pressed={on}
      >
        <span className={styles.toggleIcon} aria-hidden="true">
          <MoveHorizontal size={18} strokeWidth={2} />
        </span>
        <span className={styles.toggleMain}>16:9 にフル引き伸ばし</span>
        <span className={styles.toggleHint}>
          VALORANT等の「引き伸ばし(stretched)」設定で 4:3 / 16:10 録画された映像を、
          インゲームと同じ横長表示に補正します（プレビュー・書き出し共通）。
        </span>
      </button>

      {asset && w && h && aspect ? (
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>元素材</span>
          <span className={styles.metaValue}>
            {w}×{h}（{aspect.label}）
          </span>
          {aspect.needsStretch && !on ? (
            <span className={styles.recommend}>{aspect.label} を検出 · 引き伸ばし推奨</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
