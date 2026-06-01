import { useMemo } from 'react';
import { Palette, RotateCcw } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import type { Clip, ColorGradePreset } from '../../lib/types';
import {
  COLOR_GRADE_LABELS,
  COLOR_GRADE_PRESETS,
  clipHasColorGrade,
  colorGradeFilter,
} from '../../lib/colorGrade';
import styles from './ClipColorSection.module.css';

interface ClipColorSectionProps {
  clip: Clip;
}

/** Editable fine-knob fields + slider ranges. All authored in [-100, 100]. */
type Knob = 'exposure' | 'contrast' | 'saturation' | 'temperature';

interface KnobDef {
  key: Knob;
  label: string;
}

const KNOBS: KnobDef[] = [
  { key: 'exposure', label: '明るさ' },
  { key: 'contrast', label: 'コントラスト' },
  { key: 'saturation', label: '彩度' },
  { key: 'temperature', label: '色温度' },
];

// A tiny gradient swatch per preset so users recognise the look at a glance
// without reading the label — built from the same filter the grade applies.
const SWATCH_FILTER: Record<ColorGradePreset, string> = COLOR_GRADE_PRESETS.reduce(
  (acc, preset) => {
    acc[preset] = colorGradeFilter({ preset });
    return acc;
  },
  {} as Record<ColorGradePreset, string>,
);

/**
 * One-click color grade editor (Phase P2). Mirrors the ClipTransform / ClipSpeed
 * section style: a row of preset buttons (one-click look) plus optional fine
 * sliders that nudge the preset. Maps to a single CSS/Canvas2D filter via
 * lib/colorGrade, applied identically by the preview and the export.
 */
export function ClipColorSection({ clip }: ClipColorSectionProps) {
  const setColorGrade = useProjectStore((s) => s.setClipColorGrade);

  const grade = clip.colorGrade;
  const active = clipHasColorGrade(grade);
  const preset: ColorGradePreset = grade?.preset ?? 'none';

  // Whether any fine knob is non-zero (drives the "詳細" reset affordance).
  const hasFineTune = useMemo(
    () =>
      !!grade &&
      [grade.exposure, grade.contrast, grade.saturation, grade.temperature].some(
        (v) => typeof v === 'number' && Math.abs(v) > 1e-3,
      ),
    [grade],
  );

  /** Pick a preset (one-click). Keeps any fine-tune nudges already applied. */
  const selectPreset = (next: ColorGradePreset) => {
    if (next === 'none' && !hasFineTune) {
      // Neutral + no nudges → drop the grade entirely (backward-compatible).
      setColorGrade(clip.id, null);
      return;
    }
    setColorGrade(clip.id, { ...(grade ?? {}), preset: next });
  };

  /** Set one fine knob at -100..100 (immutable). */
  const setKnob = (key: Knob, value: number) => {
    setColorGrade(clip.id, { ...(grade ?? {}), [key]: value });
  };

  /** Clear the grade entirely (back to neutral). */
  const reset = () => setColorGrade(clip.id, null);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>カラー</span>
        <span className={`${styles.badge} ${active ? styles.badgeOn : ''}`}>
          {active ? 'ON' : 'OFF'}
        </span>
      </div>

      <div className={styles.presetGrid} role="group" aria-label="カラープリセット">
        {COLOR_GRADE_PRESETS.map((p) => {
          const swatch = SWATCH_FILTER[p];
          return (
            <button
              key={p}
              type="button"
              className={`${styles.presetBtn} ${preset === p ? styles.presetActive : ''}`}
              onClick={() => selectPreset(p)}
              aria-pressed={preset === p}
              title={COLOR_GRADE_LABELS[p]}
            >
              <span
                className={styles.swatch}
                style={swatch !== 'none' ? { filter: swatch } : undefined}
                aria-hidden="true"
              />
              {COLOR_GRADE_LABELS[p]}
            </button>
          );
        })}
      </div>

      <div className={styles.fineHead}>
        <span className={styles.fineLabel}>詳細調整</span>
        <button
          type="button"
          className={styles.resetBtn}
          onClick={reset}
          title="カラーをリセット"
          aria-label="リセット"
          disabled={!active}
        >
          <RotateCcw size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>

      {KNOBS.map((k) => {
        const value = (grade?.[k.key] as number | undefined) ?? 0;
        return (
          <div key={k.key} className={styles.fieldRow}>
            <div className={styles.fieldHead}>
              <span className={styles.fieldLabel}>{k.label}</span>
              <span className={styles.fieldValue}>{value > 0 ? `+${value}` : value}</span>
            </div>
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={value}
              onChange={(e) => setKnob(k.key, parseFloat(e.target.value))}
              className={styles.slider}
              aria-label={k.label}
            />
          </div>
        );
      })}

      <div className={styles.hint}>
        <Palette size={12} strokeWidth={2} aria-hidden="true" />
        <span>
          ワンクリックでルックを適用。詳細でプリセットを微調整。プレビュー・書き出し共通。
        </span>
      </div>
    </div>
  );
}
