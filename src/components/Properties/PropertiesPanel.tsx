import { useSelectedAsset } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import { formatDuration, formatFileSize, formatTimecode } from '../../lib/media';
import { KillMarkerSection } from './KillMarkerSection';
import { IORangeSection } from './IORangeSection';
import { ClipEffectsSection } from './ClipEffectsSection';
import { ClipSpeedSection } from './ClipSpeedSection';
import { ClipStretchSection } from './ClipStretchSection';
import { ClipTransformSection } from './ClipTransformSection';
import { ClipColorSection } from './ClipColorSection';
import { ClipTransitionSection } from './ClipTransitionSection';
import { ClipVolumeSection } from './ClipVolumeSection';
import { ClipOverlaysSection } from './ClipOverlaysSection';
import { ClipPresetsSection } from './ClipPresetsSection';
import { BeatDetectionSection } from './BeatDetectionSection';
import { AudioDuckingSection } from './AudioDuckingSection';
import styles from './PropertiesPanel.module.css';

export function PropertiesPanel() {
  const asset = useSelectedAsset();
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds);
  const clips = useProjectStore((s) => s.clips);
  const tracks = useProjectStore((s) => s.tracks);
  const selectedClip =
    selectedClipIds.length === 1
      ? (clips.find((c) => c.id === selectedClipIds[0]) ?? null)
      : null;
  const selectedClipTrackKind = selectedClip
    ? (tracks.find((t) => t.id === selectedClip.trackId)?.kind ?? null)
    : null;
  // The FIRST audio track is the BGM lane; auto-ducking is a BGM feature, so
  // the ducking control only shows for a clip on that track (not SE etc.).
  const bgmTrackId = tracks.find((t) => t.kind === 'audio')?.id ?? null;
  const isBgmClip = !!selectedClip && selectedClip.trackId === bgmTrackId;

  return (
    <div className={styles.root}>
      <div className={styles.header}>プロパティ</div>
      {!asset ? (
        <div className={styles.empty}>メディアが未選択です</div>
      ) : (
        <div className={styles.content}>
          <div className={styles.section}>
            <div className={styles.sectionLabel}>ファイル</div>
            <PropRow label="名前" value={asset.name} mono />
            <PropRow label="種類" value={asset.kind === 'video' ? '動画' : '音声'} />
            <PropRow label="サイズ" value={formatFileSize(asset.file.size)} mono />
            <PropRow label="MIME" value={asset.file.type || '-'} mono />
          </div>

          <div className={styles.section}>
            <div className={styles.sectionLabel}>メタデータ</div>
            <PropRow label="長さ" value={formatDuration(asset.duration)} mono />
            <PropRow
              label="長さ (frames)"
              value={formatTimecode(asset.duration)}
              mono
            />
            {asset.kind === 'video' && asset.width && asset.height ? (
              <>
                <PropRow label="解像度" value={`${asset.width} × ${asset.height}`} mono />
                <PropRow
                  label="アスペクト"
                  value={(asset.width / asset.height).toFixed(3)}
                  mono
                />
              </>
            ) : null}
          </div>

          {selectedClip ? (
            <>
              <div className={styles.markerSlot}>
                <ClipSpeedSection clip={selectedClip} />
              </div>
              {selectedClipTrackKind !== 'audio' ? (
                <div className={styles.markerSlot}>
                  <ClipStretchSection clip={selectedClip} />
                </div>
              ) : null}
              {selectedClipTrackKind !== 'audio' ? (
                <div className={styles.markerSlot}>
                  <ClipTransformSection clip={selectedClip} />
                </div>
              ) : null}
              {selectedClipTrackKind !== 'audio' ? (
                <div className={styles.markerSlot}>
                  <ClipColorSection clip={selectedClip} />
                </div>
              ) : null}
              {selectedClipTrackKind !== 'audio' ? (
                <div className={styles.markerSlot}>
                  <ClipTransitionSection clip={selectedClip} />
                </div>
              ) : null}
              <div className={styles.markerSlot}>
                <ClipVolumeSection clip={selectedClip} />
              </div>
              {isBgmClip ? (
                <div className={styles.markerSlot}>
                  <AudioDuckingSection />
                </div>
              ) : null}
              <div className={styles.markerSlot}>
                <ClipEffectsSection clip={selectedClip} />
              </div>
              {selectedClip.assetId && selectedClipTrackKind !== 'audio' ? (
                <div className={styles.markerSlot}>
                  <ClipOverlaysSection clip={selectedClip} />
                </div>
              ) : null}
              {selectedClipTrackKind !== 'audio' ? (
                <div className={styles.markerSlot}>
                  <ClipPresetsSection clip={selectedClip} />
                </div>
              ) : null}
            </>
          ) : null}
          {asset.kind === 'video' ? (
            <>
              <div className={styles.markerSlot}>
                <KillMarkerSection asset={asset} />
              </div>
              <div className={styles.markerSlot}>
                <IORangeSection asset={asset} />
              </div>
            </>
          ) : null}
          {asset.kind === 'audio' ? (
            <div className={styles.markerSlot}>
              <BeatDetectionSection asset={asset} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface PropRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function PropRow({ label, value, mono }: PropRowProps) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={`${styles.rowValue} ${mono ? styles.rowValueMono : ''}`} title={value}>
        {value}
      </span>
    </div>
  );
}
