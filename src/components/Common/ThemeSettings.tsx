import { useEffect, useState } from 'react';
import {
  DEFAULT_GAMING_COLORS,
  GAMING_PRESETS,
  applyTheme,
  loadGamingColors,
  loadTheme,
  saveGamingColors,
  saveTheme,
  type GamingColors,
  type ThemeId,
} from '../../lib/theme';
import styles from './ThemeSettings.module.css';

const THEMES: { id: ThemeId; label: string; description: string; icon: string }[] = [
  { id: 'light', label: 'ライト', description: '昼間向け、明るく落ち着いた配色', icon: '☀' },
  { id: 'dark', label: 'ダーク', description: '夜間向け、目に優しい暗色', icon: '🌙' },
  { id: 'gaming', label: 'ゲーミング', description: 'RGB配色を自由にカスタマイズ', icon: '🎮' },
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

export function ThemeSettings() {
  const [theme, setTheme] = useState<ThemeId>(() => loadTheme());
  const [colors, setColors] = useState<GamingColors>(() => loadGamingColors());

  // Re-apply whenever theme or colors change so the user sees a live preview.
  useEffect(() => {
    applyTheme(theme, colors);
  }, [theme, colors]);

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
              <span className={styles.themeIcon}>{t.icon}</span>
              <span className={styles.themeLabel}>{t.label}</span>
              <span className={styles.themeDesc}>{t.description}</span>
            </button>
          ))}
        </div>
      </section>

      {theme === 'gaming' ? (
        <>
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
              >
                ↺ リセット
              </button>
            </div>
            <div className={styles.colorGrid}>
              {COLOR_FIELDS.map((field) => (
                <label key={field.key} className={styles.colorRow}>
                  <span className={styles.colorLabel}>{field.label}</span>
                  <span className={styles.colorControls}>
                    <input
                      type="color"
                      value={colors[field.key]}
                      onChange={(e) => changeColor(field.key, e.target.value)}
                      className={styles.colorPicker}
                      aria-label={field.label}
                    />
                    <span className={styles.colorHex}>{colors[field.key].toUpperCase()}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
