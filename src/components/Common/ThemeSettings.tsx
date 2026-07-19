import { useEffect, useState } from 'react';
import { Sun, Moon, Gamepad2, RotateCcw, type LucideIcon } from 'lucide-react';
import {
  DEFAULT_GAMING_COLORS,
  GAMING_PRESETS,
  applyTheme,
  loadGamingColors,
  loadRgbCycle,
  loadRgbTargets,
  loadTheme,
  saveGamingColors,
  saveRgbCycle,
  saveRgbTargets,
  saveTheme,
  type GamingColors,
  type RgbCycleSpeed,
  type RgbCycleTargets,
  type ThemeId,
} from '../../lib/theme';
import styles from './ThemeSettings.module.css';

const THEMES: { id: ThemeId; label: string; description: string; Icon: LucideIcon }[] = [
  { id: 'light', label: 'ライト', description: '昼間向け、明るく落ち着いた配色', Icon: Sun },
  { id: 'dark', label: 'ダーク', description: '夜間向け、目に優しい暗色', Icon: Moon },
  { id: 'gaming', label: 'ゲーミング', description: 'RGB配色を自由にカスタマイズ', Icon: Gamepad2 },
];

interface ColorFieldDef {
  key: keyof GamingColors;
  label: string;
}

const COLOR_FIELDS: ColorFieldDef[] = [
  { key: 'accent', label: 'アクセント (CTA)' },
  { key: 'playhead', label: '再生ヘッド' },
  { key: 'clipVideo', label: '映像クリップ' },
  { key: 'clipOverlay', label: 'オーバーレイ' },
  { key: 'clipAudio', label: '音声クリップ' },
  { key: 'bgApp', label: '背景' },
];

const CYCLE_OPTIONS: { id: RgbCycleSpeed; label: string; hint: string }[] = [
  { id: 'off', label: 'OFF', hint: '静的' },
  { id: 'slow', label: '低速', hint: '24秒/周' },
  { id: 'normal', label: '通常', hint: '8秒/周' },
  { id: 'fast', label: '高速', hint: '3秒/周' },
];

const TARGET_OPTIONS: { key: keyof RgbCycleTargets; label: string; hint: string }[] = [
  { key: 'accent', label: 'アクセント', hint: 'CTA / プレイヘッド / ビート線' },
  { key: 'clip', label: 'クリップ', hint: '映像 / オーバーレイ / 音声' },
  { key: 'bg', label: '背景', hint: 'パネル / トラック / タイムライン' },
  { key: 'border', label: 'ボーダー', hint: '区切り線' },
  { key: 'glow', label: 'グロー', hint: 'フォーカスハロー' },
];

export function ThemeSettings() {
  const [theme, setTheme] = useState<ThemeId>(() => loadTheme());
  const [colors, setColors] = useState<GamingColors>(() => loadGamingColors());
  const [cycle, setCycle] = useState<RgbCycleSpeed>(() => loadRgbCycle());
  const [targets, setTargets] = useState<RgbCycleTargets>(() => loadRgbTargets());

  // Re-apply whenever theme, colors, cycle, or targets change for live preview.
  useEffect(() => {
    applyTheme(theme, colors, cycle, targets);
  }, [theme, colors, cycle, targets]);

  const changeTheme = (next: ThemeId) => {
    setTheme(next);
    saveTheme(next);
  };

  const changeColor = (key: keyof GamingColors, value: string) => {
    const next = { ...colors, [key]: value };
    setColors(next);
    saveGamingColors(next);
  };

  const applyPreset = (presetId: string) => {
    const preset = GAMING_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setColors(preset.colors);
    saveGamingColors(preset.colors);
  };

  const resetGaming = () => {
    setColors(DEFAULT_GAMING_COLORS);
    saveGamingColors(DEFAULT_GAMING_COLORS);
  };

  const changeCycle = (next: RgbCycleSpeed) => {
    setCycle(next);
    saveRgbCycle(next);
  };

  const toggleTarget = (key: keyof RgbCycleTargets) => {
    const next = { ...targets, [key]: !targets[key] };
    setTargets(next);
    saveRgbTargets(next);
  };

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>テーマ</h3>
        <div className={styles.themeGrid}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`${styles.themeCard} ${theme === t.id ? styles.themeActive : ''}`}
              onClick={() => changeTheme(t.id)}
              aria-pressed={theme === t.id}
            >
              <span className={styles.themeIcon}><t.Icon size={18} strokeWidth={2} aria-hidden="true" /></span>
              <span className={styles.themeLabel}>{t.label}</span>
              <span className={styles.themeDesc}>{t.description}</span>
            </button>
          ))}
        </div>
      </section>

      {theme === 'gaming' ? (
        <>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>RGB サイクル</h3>
            <div className={styles.cycleRow} role="radiogroup" aria-label="RGB サイクル速度">
              {CYCLE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={cycle === opt.id}
                  className={`${styles.cycleBtn} ${cycle === opt.id ? styles.cycleActive : ''}`}
                  onClick={() => changeCycle(opt.id)}
                >
                  <span className={styles.cycleLabel}>{opt.label}</span>
                  <span className={styles.cycleHint}>{opt.hint}</span>
                </button>
              ))}
            </div>
            <p className={styles.cycleNote}>
              ※ ON にした要素だけがHSL連続変化。OFF 要素は下のカスタム配色 / ゲーミング既定色のまま静止
            </p>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>サイクル対象</h3>
            <div className={styles.targetGrid}>
              {TARGET_OPTIONS.map((opt) => {
                const on = targets[opt.key];
                return (
                  <label
                    key={opt.key}
                    className={`${styles.targetRow} ${on ? styles.targetOn : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleTarget(opt.key)}
                      disabled={cycle === 'off'}
                      className={styles.targetCheck}
                      aria-label={opt.label}
                    />
                    <span className={styles.targetLabel}>{opt.label}</span>
                    <span className={styles.targetHint}>{opt.hint}</span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>プリセット</h3>
            <div className={styles.presetRow}>
              {GAMING_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={styles.presetBtn}
                  onClick={() => applyPreset(preset.id)}
                  title={preset.label}
                >
                  <span
                    className={styles.presetSwatch}
                    style={{
                      background: `linear-gradient(135deg, ${preset.colors.accent} 0%, ${preset.colors.clipVideo} 50%, ${preset.colors.clipAudio} 100%)`,
                    }}
                  />
                  <span className={styles.presetLabel}>{preset.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.customHeader}>
              <h3 className={styles.sectionTitle}>カスタム配色</h3>
              <button
                type="button"
                className={styles.resetLink}
                onClick={resetGaming}
                title="初期値に戻す"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
                リセット
              </button>
            </div>
            <div className={styles.colorGrid}>
              {COLOR_FIELDS.map((field) => {
                // Determine which rgb-cycle target group governs this field.
                const cycleTarget: keyof RgbCycleTargets | null =
                  field.key === 'accent' || field.key === 'playhead'
                    ? 'accent'
                    : field.key === 'clipVideo' || field.key === 'clipOverlay' || field.key === 'clipAudio'
                    ? 'clip'
                    : field.key === 'bgApp'
                    ? 'bg'
                    : null;
                // Picker is locked while the keyframe owns that variable group.
                const pickerDisabled =
                  cycle !== 'off' && cycleTarget !== null && targets[cycleTarget];
                return (
                  <label
                    key={field.key}
                    className={`${styles.colorRow} ${pickerDisabled ? styles.colorRowCycling : ''}`}
                  >
                    <span className={styles.colorLabel}>{field.label}</span>
                    <span className={styles.colorControls}>
                      <input
                        type="color"
                        value={colors[field.key]}
                        onChange={(e) => changeColor(field.key, e.target.value)}
                        className={styles.colorPicker}
                        aria-label={field.label}
                        disabled={pickerDisabled}
                        title={pickerDisabled ? 'RGB サイクル中は変更できません' : undefined}
                      />
                      <span className={styles.colorHex}>{colors[field.key].toUpperCase()}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
