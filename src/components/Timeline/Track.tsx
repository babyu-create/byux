import { memo, useMemo } from 'react';
import type { MediaAsset } from '../../lib/types';
import { useProjectStore } from '../../stores/projectStore';
import { Clip } from './Clip';
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
  totalSec: _totalSec,
  assetsById,
}: TrackProps) {
  // Subscribe to the stable arrays first, then derive locally with useMemo.
  // Selectors returning `.find()` / `.filter()` directly would build a new
  // reference on every store update — Object.is would mark them as changed
  // and trigger an infinite render loop ("Maximum update depth exceeded").
  const tracks = useProjectStore((s) => s.tracks);
  const allClips = useProjectStore((s) => s.clips);
  const track = useMemo(() => tracks.find((t) => t.id === trackId), [tracks, trackId]);
  const clips = useMemo(
    () => allClips.filter((c) => c.trackId === trackId),
    [allClips, trackId],
  );

  if (!track) return null;

  return (
    <div
      className={`${styles.root} ${track.locked ? styles.locked : ''} ${track.hidden ? styles.hidden : ''}`}
      data-kind={track.kind}
    >
      {clips.map((clip) => {
        const asset = assetsById[clip.assetId];
        return (
          <Clip
            key={clip.id}
            clip={clip}
            zoom={zoom}
            asset={asset}
            kind={track.kind}
            locked={track.locked}
          />
        );
      })}
    </div>
  );
});
