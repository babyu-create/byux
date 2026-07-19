import { memo, useCallback } from 'react';
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import type { Track } from '../../lib/types';
import styles from './TrackHeader.module.css';

interface TrackHeaderProps {
  track: Track;
}

export const TrackHeader = memo(function TrackHeader({ track }: TrackHeaderProps) {
  const toggleLocked = useProjectStore((s) => s.toggleTrackLocked);
  const toggleMuted = useProjectStore((s) => s.toggleTrackMuted);
  const toggleHidden = useProjectStore((s) => s.toggleTrackHidden);

  const isAudio = track.kind === 'audio';

  const handleToggleHidden = useCallback(
    () => toggleHidden(track.id),
    [toggleHidden, track.id],
  );
  const handleToggleLocked = useCallback(
    () => toggleLocked(track.id),
    [toggleLocked, track.id],
  );
  const handleToggleMuted = useCallback(
    () => toggleMuted(track.id),
    [toggleMuted, track.id],
  );

  return (
    <div
      className={`${styles.root} ${track.locked ? styles.locked : ''} ${track.hidden ? styles.hidden : ''}`}
      data-kind={track.kind}
      title={track.label}
    >
      <span className={styles.dot} aria-hidden="true" />
      <div className={styles.controls}>
        <button
          type="button"
          className={`${styles.iconBtn} ${track.hidden ? styles.iconActive : ''}`}
          onClick={handleToggleHidden}
          aria-label={track.hidden ? '表示する' : '非表示にする'}
          title={track.hidden ? '表示する' : '非表示にする'}
        >
          {track.hidden ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={`${styles.iconBtn} ${track.locked ? styles.iconActive : ''}`}
          onClick={handleToggleLocked}
          aria-label={track.locked ? 'ロック解除' : 'ロック'}
          title={track.locked ? 'ロック解除' : 'ロック'}
        >
          {track.locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={`${styles.iconBtn} ${track.muted ? styles.iconActive : ''}`}
          onClick={handleToggleMuted}
          aria-label={
            isAudio
              ? track.muted ? 'ミュート解除' : 'ミュート'
              : track.muted ? '音声ON' : '音声OFF'
          }
          title={
            isAudio
              ? track.muted ? 'ミュート解除' : 'ミュート'
              : track.muted ? '音声ON' : '音声OFF'
          }
        >
          {track.muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
});
