import { useProjectStore } from '../../stores/projectStore';
import type { Track } from '../../lib/types';
import styles from './TrackHeader.module.css';

interface TrackHeaderProps {
  track: Track;
}

export function TrackHeader({ track }: TrackHeaderProps) {
  const toggleLocked = useProjectStore((s) => s.toggleTrackLocked);
  const toggleMuted = useProjectStore((s) => s.toggleTrackMuted);
  const toggleHidden = useProjectStore((s) => s.toggleTrackHidden);

  const isAudio = track.kind === 'audio';

  return (
    <div
      className={`${styles.root} ${track.locked ? styles.locked : ''} ${track.hidden ? styles.hidden : ''}`}
      data-kind={track.kind}
    >
      <div className={styles.label}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.text}>{track.label}</span>
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          className={`${styles.iconBtn} ${track.hidden ? styles.iconActive : ''}`}
          onClick={() => toggleHidden(track.id)}
          aria-label={track.hidden ? '表示する' : '非表示にする'}
          title={track.hidden ? '表示する' : '非表示にする'}
        >
          {track.hidden ? '⌐' : '◉'}
        </button>
        <button
          type="button"
          className={`${styles.iconBtn} ${track.locked ? styles.iconActive : ''}`}
          onClick={() => toggleLocked(track.id)}
          aria-label={track.locked ? 'ロック解除' : 'ロック'}
          title={track.locked ? 'ロック解除' : 'ロック'}
        >
          {track.locked ? '🔒' : '🔓'}
        </button>
        {isAudio ? (
          <button
            type="button"
            className={`${styles.iconBtn} ${track.muted ? styles.iconActive : ''}`}
            onClick={() => toggleMuted(track.id)}
            aria-label={track.muted ? 'ミュート解除' : 'ミュート'}
            title={track.muted ? 'ミュート解除' : 'ミュート'}
          >
            {track.muted ? '🔇' : '🔊'}
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.iconBtn} ${track.muted ? styles.iconActive : ''}`}
            onClick={() => toggleMuted(track.id)}
            aria-label={track.muted ? '音声ON' : '音声OFF'}
            title={track.muted ? '音声ON' : '音声OFF'}
          >
            {track.muted ? '🔇' : '🔊'}
          </button>
        )}
      </div>
    </div>
  );
}
