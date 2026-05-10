import type { Clip as ClipType, MediaAsset, Track as TrackType } from '../../lib/types';
import { Clip } from './Clip';
import styles from './Track.module.css';

interface TrackProps {
  track: TrackType;
  clips: ClipType[];
  zoom: number;
  totalSec: number;
  assetsById: Record<string, MediaAsset>;
}

export function Track({ track, clips, zoom, totalSec: _totalSec, assetsById }: TrackProps) {
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
}
