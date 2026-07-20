import { memo, useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import type { Clip as ClipType, MediaAsset } from '../../lib/types';
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { clipDuration, pxToTime } from '../../lib/timeline';
import { Clip } from './Clip';
import { ContextMenu } from '../Common/ContextMenu';
import { ClipVolumeSection } from '../Properties/ClipVolumeSection';
import { ClipSpeedSection } from '../Properties/ClipSpeedSection';
import {
  removeClipWithFeedback,
  splitClipWithFeedback,
} from './timelineCommands';
import styles from './Track.module.css';

interface TrackProps {
  trackId: string;
  zoom: number;
  totalSec: number;
  assetsById: Record<string, MediaAsset>;
}

export const Track = memo(function Track({
  trackId,
  zoom,
  assetsById,
}: TrackProps) {
  // Subscribe to the stable arrays first, then derive locally with useMemo.
  // Selectors returning `.find()` / `.filter()` directly would build a new
  // reference on every store update — Object.is would mark them as changed
  // and trigger an infinite render loop ("Maximum update depth exceeded").
  const tracks = useProjectStore((s) => s.tracks);
  const allClips = useProjectStore((s) => s.clips);
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds);
  const track = useMemo(() => tracks.find((t) => t.id === trackId), [tracks, trackId]);
  const clips = useMemo(
    () => allClips.filter((c) => c.trackId === trackId),
    [allClips, trackId],
  );
  const orderedClips = useMemo(
    () => [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)),
    [clips],
  );
  const keyboardClipId =
    [...selectedClipIds].reverse().find((id) => orderedClips.some((clip) => clip.id === id)) ??
    orderedClips[0]?.id;

  const [isDragOver, setIsDragOver] = useState(false);

  // AviUtl2-style right-click shortcut menu, detected here (by time position)
  // rather than on the Clip element itself: a clip is inset 6px top/bottom
  // from the track row (see Clip.module.css), so a right-click landing in
  // that margin hits this track's own background, not the clip — which
  // silently ate every attempt when the handler lived on Clip. Resolving by
  // "which clip's time range contains this X position" instead of by exact
  // DOM hit-testing means the whole row is right-clickable, not just the
  // clip's inset visual box.
  const rightClickRef = useRef<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; clip: ClipType } | null
  >(null);
  // Opened from the context menu — a fixed-width popover so volume/speed
  // sliders are never cramped by a short clip's on-screen width (the earlier
  // in-place mini-sliders were unusable for exactly that reason).
  const [quickEdit, setQuickEdit] = useState<
    { x: number; y: number; kind: 'volume' | 'speed'; clipId: string } | null
  >(null);
  const quickEditClip = quickEdit
    ? clips.find((candidate) => candidate.id === quickEdit.clipId)
    : undefined;

  const handleTrackPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button === 2) {
      rightClickRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleTrackPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = rightClickRef.current;
    rightClickRef.current = null;
    if (e.button !== 2 || !start || !track || track.locked) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moved > 6) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const time = pxToTime(start.x - rect.left, zoom);
    const hit = clips.find(
      (c) => time >= c.start - 1e-6 && time <= c.start + clipDuration(c) + 1e-6,
    );
    if (!hit) return;
    useProjectStore.getState().selectClip(hit.id);
    setContextMenu({ x: start.x, y: start.y, clip: hit });
  };

  // Drop OS files straight onto any compatible track. Visible video and
  // overlay lanes are composited in both preview and native export.
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!track || track.locked) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!track || track.locked) return;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const dropTime = Math.max(0, pxToTime(e.clientX - rect.left, zoom));
    const ps = useProjectStore.getState();

    void useMediaStore
      .getState()
      .addFiles(files)
      .then((newAssets) => {
        let cursor = dropTime;
        let skipped = 0;
        for (const asset of newAssets) {
          const compatible =
            asset.kind === 'audio'
              ? track.kind === 'audio'
              : track.kind === 'video' || track.kind === 'overlay';
          if (!compatible) {
            skipped += 1;
            continue;
          }
          const id = ps.addClipFromAsset(asset.id, track.id, asset.duration, cursor);
          if (id) cursor += asset.duration;
        }
        if (skipped > 0) {
          ps.showMessage(
            'error',
            `${skipped}個のファイルはこの種類のトラックに追加できません`,
            3500,
          );
        }
      });
  };

  if (!track) return null;

  return (
    <>
    <div
      className={`${styles.root} ${track.locked ? styles.locked : ''} ${track.hidden ? styles.hidden : ''} ${isDragOver ? styles.dragOver : ''}`}
      data-kind={track.kind}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPointerDown={handleTrackPointerDown}
      onPointerUp={handleTrackPointerUp}
      onPointerCancel={handleTrackPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {orderedClips.map((clip, index) => {
        const asset = assetsById[clip.assetId];
        return (
          <Clip
            key={clip.id}
            clip={clip}
            zoom={zoom}
            asset={asset}
            kind={track.kind}
            locked={track.locked}
            keyboardTabStop={clip.id === keyboardClipId}
            previousClipId={orderedClips[index - 1]?.id}
            nextClipId={orderedClips[index + 1]?.id}
          />
        );
      })}
    </div>
    {contextMenu ? (
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        onClose={() => setContextMenu(null)}
        items={[
          {
            label: '音量...',
            onSelect: () =>
              setQuickEdit({
                x: contextMenu.x,
                y: contextMenu.y,
                kind: 'volume',
                clipId: contextMenu.clip.id,
              }),
          },
          {
            label: '速度...',
            onSelect: () =>
              setQuickEdit({
                x: contextMenu.x,
                y: contextMenu.y,
                kind: 'speed',
                clipId: contextMenu.clip.id,
              }),
          },
          {
            label: '分割（再生位置で）',
            onSelect: () => splitClipWithFeedback(contextMenu.clip.id),
          },
          {
            label: contextMenu.clip.muted ? 'ミュート解除' : 'ミュート',
            onSelect: () => useProjectStore.getState().toggleClipMuted(contextMenu.clip.id),
          },
          {
            label: '削除',
            onSelect: () => removeClipWithFeedback(contextMenu.clip.id),
          },
        ]}
      />
    ) : null}
    {quickEdit && quickEditClip ? (
      <ContextMenu x={quickEdit.x} y={quickEdit.y} width={260} onClose={() => setQuickEdit(null)}>
        {quickEdit.kind === 'volume' ? (
          <ClipVolumeSection clip={quickEditClip} />
        ) : (
          <ClipSpeedSection clip={quickEditClip} />
        )}
      </ContextMenu>
    ) : null}
    </>
  );
});
