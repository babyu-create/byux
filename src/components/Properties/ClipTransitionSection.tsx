import { ArrowLeftRight } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import type { Clip } from '../../lib/types';
import {
  DEFAULT_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TRANSITION_LABELS,
  TRANSITION_TYPES,
  clipHasTransition,
  type ClipTransition,
  type TransitionType,
} from '../../lib/transitions';
import { clipDuration } from '../../lib/timeline';
import styles from './ClipTransitionSection.module.css';

interface ClipTransitionSectionProps {
  clip: Clip;
}

interface EdgeDef {
  edge: 'in' | 'out';
  label: string;
  key: 'transitionIn' | 'transitionOut';
}

const EDGES: EdgeDef[] = [
  { edge: 'in', label: '入り (開始)', key: 'transitionIn' },
  { edge: 'out', label: '抜け (終了)', key: 'transitionOut' },
];

// Slider max for the boundary window — capped so a transition never eats the
// whole clip (the resolver clamps to half the clip on use anyway).
const MAX_DURATION = 2;

/**
 * Kill-to-kill transition picker (Phase P4). Each clip boundary (in / out) gets
 * a one-click preset (cut / fade / slide / zoom) plus a duration slider. The
 * transition modulates the clip's OWN start/end region (opacity + light
 * transform) via lib/transitions, applied identically by the live Preview (CSS
 * transform on the footage layer) and the WebCodecs export (transform pass), so
 * the boundary look matches. Mirrors the ClipColorSection / ClipStretchSection
 * style. 'cut' / 'none' drops the field (backward-compatible serialisation).
 */
export function ClipTransitionSection({ clip }: ClipTransitionSectionProps) {
  const setTransition = useProjectStore((s) => s.setClipTransition);

  const active = clipHasTransition(clip.transitionIn, clip.transitionOut);
  const dur = clipDuration(clip);
  // Per-edge window cannot exceed half the clip (in + out must not overlap).
  const sliderMax = Math.max(
    MIN_TRANSITION_DURATION,
    Math.min(MAX_DURATION, dur / 2 || MAX_DURATION),
  );

  const pickType = (edge: 'in' | 'out', current: ClipTransition | undefined, type: TransitionType) => {
    if (type === 'cut' || type === 'none') {
      setTransition(clip.id, edge, null);
      return;
    }
    setTransition(clip.id, edge, {
      type,
      duration: current?.duration ?? DEFAULT_TRANSITION_DURATION,
    });
  };

  const setDuration = (edge: 'in' | 'out', current: ClipTransition, value: number) => {
    setTransition(clip.id, edge, { ...current, duration: value });
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>トランジション</span>
        <span className={`${styles.badge} ${active ? styles.badgeOn : ''}`}>
          {active ? 'ON' : 'OFF'}
        </span>
      </div>

      {EDGES.map(({ edge, label, key }) => {
        const transition = clip[key];
        const current: TransitionType = transition?.type ?? 'cut';
        return (
          <div key={edge} className={styles.edgeBlock}>
            <div className={styles.edgeLabel}>{label}</div>
            <div
              className={styles.presetGrid}
              role="group"
              aria-label={`${label} のトランジション`}
            >
              {TRANSITION_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`${styles.presetBtn} ${current === type ? styles.presetActive : ''}`}
                  onClick={() => pickType(edge, transition, type)}
                  aria-pressed={current === type}
                  title={TRANSITION_LABELS[type]}
                >
                  {TRANSITION_LABELS[type]}
                </button>
              ))}
            </div>
            {transition && transition.type !== 'cut' && transition.type !== 'none' ? (
              <div className={styles.fieldRow}>
                <div className={styles.fieldHead}>
                  <span className={styles.fieldLabel}>長さ</span>
                  <span className={styles.fieldValue}>
                    {transition.duration.toFixed(2)}s
                  </span>
                </div>
                <input
                  type="range"
                  min={MIN_TRANSITION_DURATION}
                  max={sliderMax}
                  step={0.05}
                  value={Math.min(transition.duration, sliderMax)}
                  onChange={(e) => setDuration(edge, transition, parseFloat(e.target.value))}
                  className={styles.slider}
                  aria-label={`${label} のトランジション長さ`}
                />
              </div>
            ) : null}
          </div>
        );
      })}

      <div className={styles.hint}>
        <ArrowLeftRight size={12} strokeWidth={2} aria-hidden="true" />
        <span>
          キル間のつなぎを1クリックで演出。各クリップの開始・終了に適用。プレビュー・書き出し共通。
        </span>
      </div>
    </div>
  );
}
