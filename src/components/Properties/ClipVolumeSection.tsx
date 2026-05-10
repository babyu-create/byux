import { useProjectStore } from '../../stores/projectStore';
import type { Clip } from '../../lib/types';
import styles from './ClipVolumeSection.module.css';

interface ClipVolumeSectionProps {
  clip: Clip;
}

export function ClipVolumeSection({ clip }: ClipVolumeSectionProps) {
  const setVolume = useProjectStore((s) => s.setClipVolume);
  const toggleMuted = useProjectStore((s) => s.toggleClipMuted);
  const volume = clip.volume ?? 1;
  const muted = clip.muted ?? false;
  const percent = Math.round(volume * 100);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>音量</span>
        <span
          className={`${styles.count} ${muted ? styles.countMuted : volume !== 1 ? styles.countActive : ''}`}
        >
          {muted ? 'MUTE' : `${percent}%`}
        </span>
      </div>

      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.muteBtn} ${muted ? styles.muteOn : ''}`}
          onClick={() => toggleMuted(clip.id)}
          aria-pressed={muted}
          title={muted ? 'ミュート解除' : 'ミュート'}
        >
          {muted ? '🔇' : volume === 0 ? '🔇' : volume < 0.5 ? '🔈' : volume < 1 ? '🔉' : '🔊'}
        </button>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(clip.id, parseFloat(e.target.value))}
          className={styles.slider}
          disabled={muted}
        />
        <span className={styles.value}>{percent}%</span>
      </div>

      <div className={styles.presetGroup} role="group" aria-label="音量プリセット">
        {[0, 0.25, 0.5, 0.75, 1, 1.5, 2].map((v) => (
          <button
            key={v}
            type="button"
            className={`${styles.presetBtn} ${
              !muted && Math.abs(volume - v) < 0.01 ? styles.active : ''
            }`}
            onClick={() => setVolume(clip.id, v)}
          >
            {v === 0 ? '0' : `${Math.round(v * 100)}`}
          </button>
        ))}
      </div>
    </div>
  );
}
