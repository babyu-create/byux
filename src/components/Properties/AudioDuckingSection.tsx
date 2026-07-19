import { Waves } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import {
  DEFAULT_AUDIO_DUCKING,
  DUCKING_PRESETS,
  DUCKING_PRESET_LABELS,
  DUCKING_PRESET_ORDER,
  DUCK_MAX_AMOUNT_DB,
  DUCK_MIN_AMOUNT_DB,
  type AudioDucking,
  type DuckingPresetName,
} from '../../lib/audioDucking';
import styles from './AudioDuckingSection.module.css';

/**
 * Project-level BGM auto-ducking control (Phase P5). A one-click toggle + an
 * amount slider + three feel presets. Shown in the properties panel when a BGM
 * (first audio track) clip is selected. Kept minimal per Byux's "expose pro
 * features as presets, not an NLE" principle — the music dips automatically
 * around each kill marker; the user only chooses how deep.
 */
export function AudioDuckingSection() {
  const ducking = useProjectStore((s) => s.audioDucking);
  const setAudioDucking = useProjectStore((s) => s.setAudioDucking);
  const markerCount = useProjectStore((s) => s.markers.length);

  const enabled = ducking?.enabled === true;
  const current: AudioDucking = ducking ?? DEFAULT_AUDIO_DUCKING;
  const amountDb = Math.round(current.amountDb);

  const toggle = () => {
    if (enabled) {
      // Keep the tuned amount/attack/release but turn the dip off.
      setAudioDucking({ ...current, enabled: false });
    } else {
      setAudioDucking({ ...current, enabled: true });
    }
  };

  const setAmount = (db: number) => {
    setAudioDucking({ ...current, enabled: true, amountDb: db });
  };

  const applyPreset = (name: DuckingPresetName) => {
    setAudioDucking({ enabled: true, ...DUCKING_PRESETS[name] });
  };

  // Which preset (if any) the current amount matches, for active highlighting.
  const activePreset = DUCKING_PRESET_ORDER.find(
    (n) => Math.abs(DUCKING_PRESETS[n].amountDb - current.amountDb) < 0.01,
  );

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>BGMダッキング</span>
        <button
          type="button"
          className={`${styles.toggle} ${enabled ? styles.toggleOn : ''}`}
          onClick={toggle}
          aria-pressed={enabled}
          title={enabled ? 'ダッキングOFF' : 'ダッキングON'}
        >
          <Waves size={13} strokeWidth={2} aria-hidden="true" />
          <span>{enabled ? 'ON' : 'OFF'}</span>
        </button>
      </div>

      {enabled ? (
        <>
          <div className={styles.row}>
            <span className={styles.rowLabel}>下げ幅</span>
            <input
              type="range"
              min={DUCK_MIN_AMOUNT_DB}
              max={DUCK_MAX_AMOUNT_DB}
              step={1}
              value={amountDb}
              onChange={(e) => setAmount(parseFloat(e.target.value))}
              className={styles.slider}
              aria-label="ダッキング下げ幅 (dB)"
            />
            <span className={styles.value}>-{amountDb}dB</span>
          </div>

          <div className={styles.presetGroup} role="group" aria-label="ダッキングプリセット">
            {DUCKING_PRESET_ORDER.map((name) => (
              <button
                key={name}
                type="button"
                className={`${styles.presetBtn} ${activePreset === name ? styles.active : ''}`}
                onClick={() => applyPreset(name)}
              >
                {DUCKING_PRESET_LABELS[name]}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className={styles.hint}>
        {markerCount > 0
          ? `キルマーカー${markerCount}箇所でBGMが自動的に下がります`
          : 'キルマーカーを打つと、その瞬間にBGMが自動で下がります'}
      </div>
    </div>
  );
}
