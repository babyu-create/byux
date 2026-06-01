import { useMemo } from 'react';
import { Move3d, Plus, RotateCcw, ZoomIn } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import type { Clip, ClipTransform } from '../../lib/types';
import type { Animatable, Keyframe } from '../../lib/keyframes';
import { isAnimated, upsertKeyframe } from '../../lib/keyframes';
import {
  IDENTITY_TRANSFORM,
  clipHasTransform,
  sampleClipTransform,
} from '../../lib/clipTransform';
import { clipDuration } from '../../lib/timeline';
import styles from './ClipTransformSection.module.css';

interface ClipTransformSectionProps {
  clip: Clip;
}

/** Editable transform fields + their slider ranges / step / formatting. */
type Field = 'scale' | 'x' | 'y' | 'rotation' | 'opacity';

interface FieldDef {
  key: Field;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Identity / reset value. */
  identity: number;
  format: (v: number) => string;
}

const FIELDS: FieldDef[] = [
  { key: 'scale', label: '拡大', min: 0.2, max: 3, step: 0.01, identity: 1, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'x', label: '横位置', min: -50, max: 50, step: 0.5, identity: 0, format: (v) => `${v.toFixed(0)}%` },
  { key: 'y', label: '縦位置', min: -50, max: 50, step: 0.5, identity: 0, format: (v) => `${v.toFixed(0)}%` },
  { key: 'rotation', label: '回転', min: -180, max: 180, step: 1, identity: 0, format: (v) => `${v.toFixed(0)}°` },
  { key: 'opacity', label: '不透明度', min: 0, max: 1, step: 0.01, identity: 1, format: (v) => `${Math.round(v * 100)}%` },
];

/**
 * Animated clip transform editor (Phase 0 keyframe engine). Mirrors the
 * ClipSpeed / ClipStretch section style. Editing a slider sets the value at the
 * current playhead: a constant if the field is not yet animated, or an upserted
 * keyframe if it is. "キーフレーム追加" snapshots the current values into
 * keyframes; "ズームパンチ" is a one-click zoom-in preset (scale 1.0→1.15,
 * easeOut over the clip). Applied identically by the preview and the export.
 */
export function ClipTransformSection({ clip }: ClipTransformSectionProps) {
  const setTransform = useProjectStore((s) => s.setClipTransform);
  const playhead = useProjectStore((s) => s.playhead);

  const transform = clip.transform;
  const active = clipHasTransform(transform);

  // Clip-local time at the playhead (transform keyframes are authored here).
  const localT = useMemo(() => {
    const end = clip.start + clipDuration(clip);
    const within = playhead >= clip.start - 1e-6 && playhead < end + 1e-6;
    return within ? Math.max(0, playhead - clip.start) : 0;
  }, [clip, playhead]);

  const resolved = useMemo(
    () => sampleClipTransform(transform, localT),
    [transform, localT],
  );

  /** Set a single field's value at the current local time (immutable). */
  const setField = (key: Field, value: number) => {
    const base: ClipTransform = transform ?? {};
    const current = base[key];
    let next: Animatable;
    if (isAnimated(current)) {
      // Already keyframed — upsert a keyframe at the playhead.
      const kf: Keyframe = { t: localT, value, easing: 'easeOut' };
      next = upsertKeyframe(current, kf);
    } else {
      // Constant — just replace the constant.
      next = value;
    }
    setTransform(clip.id, { ...base, [key]: next });
  };

  /**
   * Snapshot all current resolved values into keyframes at the playhead. For a
   * field that is still a constant, this also seeds a t:0 keyframe at the
   * constant value (so the value doesn't jump before the new keyframe) unless
   * the playhead is already at t:0.
   */
  const addKeyframeAtPlayhead = () => {
    const base: ClipTransform = transform ?? {};
    const next: ClipTransform = { ...base };
    (Object.keys(IDENTITY_TRANSFORM) as Field[]).forEach((key) => {
      const current = base[key];
      const value = resolved[key];
      const kf: Keyframe = { t: localT, value, easing: 'easeOut' };
      if (isAnimated(current)) {
        next[key] = upsertKeyframe(current, kf);
      } else {
        // Constant (number or undefined) → its value everywhere so far.
        const constVal =
          typeof current === 'number' ? current : IDENTITY_TRANSFORM[key];
        const seed: Keyframe = { t: 0, value: constVal, easing: 'easeOut' };
        next[key] = upsertKeyframe([seed], kf);
      }
    });
    setTransform(clip.id, next);
  };

  /** One-click zoom-punch: scale 1.0 → ~1.15 with easeOut over the clip. */
  const applyZoomPunch = () => {
    const dur = Math.max(0.2, clipDuration(clip));
    const scaleKfs: Keyframe[] = [
      { t: 0, value: 1, easing: 'easeOut' },
      { t: dur, value: 1.15 },
    ];
    setTransform(clip.id, { ...(transform ?? {}), scale: scaleKfs });
  };

  /** Clear the transform entirely (back to identity). */
  const reset = () => {
    setTransform(clip.id, {});
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>トランスフォーム</span>
        <span className={`${styles.badge} ${active ? styles.badgeOn : ''}`}>
          {active ? 'ON' : 'OFF'}
        </span>
      </div>

      <div className={styles.presetRow}>
        <button
          type="button"
          className={styles.presetBtn}
          onClick={applyZoomPunch}
          title="クリップ全体でゆっくりズームイン（1.0→1.15、easeOut）"
        >
          <ZoomIn size={14} strokeWidth={2} aria-hidden="true" />
          ズームパンチ
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={addKeyframeAtPlayhead}
          title="再生位置に現在値のキーフレームを追加"
          aria-label="キーフレーム追加"
        >
          <Plus size={14} strokeWidth={2.4} aria-hidden="true" />
          キーフレーム
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={reset}
          title="トランスフォームをリセット"
          aria-label="リセット"
          disabled={!active}
        >
          <RotateCcw size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>

      {FIELDS.map((f) => {
        const value = resolved[f.key];
        const animated = isAnimated(transform?.[f.key]);
        return (
          <div key={f.key} className={styles.fieldRow}>
            <div className={styles.fieldHead}>
              <span className={styles.fieldLabel}>
                {f.label}
                {animated ? <span className={styles.kfDot} title="キーフレーム制御中" /> : null}
              </span>
              <span className={styles.fieldValue}>{f.format(value)}</span>
            </div>
            <input
              type="range"
              min={f.min}
              max={f.max}
              step={f.step}
              value={value}
              onChange={(e) => setField(f.key, parseFloat(e.target.value))}
              className={styles.slider}
              aria-label={f.label}
            />
          </div>
        );
      })}

      <div className={styles.hint}>
        <Move3d size={12} strokeWidth={2} aria-hidden="true" />
        <span>
          再生位置の値を編集。キーフレーム制御中（●）の項目はその位置に
          キーフレームを打ちます。プレビュー・書き出し共通。
        </span>
      </div>
    </div>
  );
}
