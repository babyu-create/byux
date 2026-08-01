import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { Eye, EyeOff, Lock, LockOpen, MoreHorizontal, Volume2, VolumeX } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import type { Track } from '../../lib/types';
import styles from './TrackHeader.module.css';
import { ContextMenu } from '../Common/ContextMenu';
import { ConfirmDialog } from '../Common/ConfirmDialog';

interface TrackHeaderProps {
  track: Track;
}

export const TrackHeader = memo(function TrackHeader({ track }: TrackHeaderProps) {
  const toggleLocked = useProjectStore((s) => s.toggleTrackLocked);
  const toggleMuted = useProjectStore((s) => s.toggleTrackMuted);
  const toggleHidden = useProjectStore((s) => s.toggleTrackHidden);
  const renameTrack = useProjectStore((s) => s.renameTrack);
  const moveTrack = useProjectStore((s) => s.moveTrack);
  const duplicateTrack = useProjectStore((s) => s.duplicateTrack);
  const removeTrack = useProjectStore((s) => s.removeTrack);
  const tracks = useProjectStore((s) => s.tracks);
  const clips = useProjectStore((s) => s.clips);
  const clipCount = useMemo(
    () => clips.reduce((count, clip) => count + Number(clip.trackId === track.id), 0),
    [clips, track.id],
  );
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(track.label);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isAudio = track.kind === 'audio';
  const index = tracks.findIndex((candidate) => candidate.id === track.id);
  const isOnlyVideo =
    track.kind === 'video' &&
    tracks.filter((candidate) => candidate.kind === 'video').length <= 1;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  useEffect(() => setDraftLabel(track.label), [track.label]);

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
  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom });
  };
  const commitRename = () => {
    if (!renameTrack(track.id, draftLabel)) setDraftLabel(track.label);
    setEditing(false);
  };
  const requestDelete = () => {
    if (clipCount > 0) setConfirmDelete(true);
    else removeTrack(track.id);
  };

  return (
    <div
      className={`${styles.root} ${track.locked ? styles.locked : ''} ${track.hidden ? styles.hidden : ''}`}
      data-kind={track.kind}
      title={track.label}
    >
      <span className={styles.dot} aria-hidden="true" />
      {editing ? (
        <input
          ref={inputRef}
          className={styles.labelInput}
          value={draftLabel}
          maxLength={48}
          aria-label="トラック名"
          onChange={(event) => setDraftLabel(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraftLabel(track.label);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={styles.label}
          onDoubleClick={() => setEditing(true)}
          title={`${track.label}（ダブルクリックで名前変更）`}
        >
          {track.label}
        </button>
      )}
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
        <button
          type="button"
          className={styles.iconBtn}
          onClick={openMenu}
          aria-label={`${track.label}の操作`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          title="トラックの操作"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: '名前を変更', onSelect: () => setEditing(true) },
            { label: '上へ移動', onSelect: () => moveTrack(track.id, -1), disabled: index <= 0 },
            {
              label: '下へ移動',
              onSelect: () => moveTrack(track.id, 1),
              disabled: index < 0 || index >= tracks.length - 1,
            },
            {
              label: clipCount > 0 ? `複製（クリップ${clipCount}本）` : '複製',
              onSelect: () => duplicateTrack(track.id),
              disabled: tracks.length >= 100,
            },
            {
              label: clipCount > 0 ? `削除（クリップ${clipCount}本）` : '削除',
              onSelect: requestDelete,
              disabled: isOnlyVideo,
            },
          ]}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="トラックを削除"
          message={`「${track.label}」と、その上のクリップ${clipCount}本を削除します。`}
          confirmLabel="削除"
          variant="destructive"
          onConfirm={() => {
            setConfirmDelete(false);
            removeTrack(track.id);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </div>
  );
});
