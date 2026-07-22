import { useSelectedAsset } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import { formatDuration, formatFileSize, formatTimecode } from '../../lib/media';
import type { MediaAsset } from '../../lib/types';
import { clipHasTransform } from '../../lib/clipTransform';
import { clipHasColorGrade } from '../../lib/colorGrade';
import { clipHasTransition } from '../../lib/transitions';
import { hasSpeedRamp } from '../../lib/speedRamp';
import { CollapsibleSection } from './CollapsibleSection';
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
import { ClipAudioProcessingSection } from './ClipAudioProcessingSection';
import { hasAudioProcessing } from '../../lib/audioProcessing';
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
  const selectedClipTrack = selectedClip
    ? (tracks.find((track) => track.id === selectedClip.trackId) ?? null)
    : null;
  const selectedClipTrackKind = selectedClipTrack?.kind ?? null;
  const selectedClipLocked = selectedClipTrack?.locked === true;
  // The FIRST audio track is the BGM lane; auto-ducking is a BGM feature, so
  // the ducking control only shows for a clip on that track (not SE etc.).
  const bgmTrackId = tracks.find((t) => t.kind === 'audio')?.id ?? null;
  const isBgmClip = !!selectedClip && selectedClip.trackId === bgmTrackId;
  const isVideoClip = selectedClipTrackKind !== 'audio';

  return (
    <div className={styles.root}>
      <div className={styles.header}>プロパティ</div>
      {!asset ? (
        <div className={styles.empty}>メディアが未選択です</div>
      ) : (
        <div className={styles.content}>
          {selectedClip ? (
            <>
              {selectedClipLocked ? (
                <div className={styles.lockedNotice} role="status">
                  このトラックはロック中です。タイムラインの鍵を解除すると編集できます。
                </div>
              ) : null}
              <div
                className={selectedClipLocked ? styles.clipEditorLocked : undefined}
                inert={selectedClipLocked}
                aria-disabled={selectedClipLocked}
              >
              {/* High-frequency FPS-montage control: open by default. */}
              <CollapsibleSection
                id="speed"
                title="再生速度"
                defaultOpen
                active={
                  (selectedClip.speed ?? 1) !== 1 || hasSpeedRamp(selectedClip.speedRamp)
                }
                badge={`${selectedClip.speed ?? 1}×`}
              >
                <ClipSpeedSection clip={selectedClip} />
              </CollapsibleSection>

              {/* Also high-frequency: kept open and right after speed so it
                  never needs scrolling past the video-only sections below. */}
              <CollapsibleSection
                id="volume"
                title="音量"
                defaultOpen
                active={(selectedClip.volume ?? 1) !== 1 || (selectedClip.muted ?? false)}
                badge={
                  selectedClip.muted
                    ? 'MUTE'
                    : `${Math.round((selectedClip.volume ?? 1) * 100)}%`
                }
              >
                <ClipVolumeSection clip={selectedClip} />
              </CollapsibleSection>

              <CollapsibleSection
                id="audio-processing"
                title="音声クリア・EQ"
                active={hasAudioProcessing(selectedClip.audioProcessing)}
              >
                <ClipAudioProcessingSection clip={selectedClip} />
              </CollapsibleSection>

              {isVideoClip ? (
                <CollapsibleSection
                  id="stretch"
                  title="引き伸ばし"
                  active={selectedClip.stretchToFill ?? false}
                >
                  <ClipStretchSection clip={selectedClip} />
                </CollapsibleSection>
              ) : null}

              {isVideoClip ? (
                <CollapsibleSection
                  id="transform"
                  title="トランスフォーム"
                  active={clipHasTransform(selectedClip.transform)}
                >
                  <ClipTransformSection clip={selectedClip} />
                </CollapsibleSection>
              ) : null}

              {isVideoClip ? (
                <CollapsibleSection
                  id="color"
                  title="カラー"
                  defaultOpen
                  active={clipHasColorGrade(selectedClip.colorGrade)}
                >
                  <ClipColorSection clip={selectedClip} />
                </CollapsibleSection>
              ) : null}

              {isVideoClip ? (
                <CollapsibleSection
                  id="transition"
                  title="トランジション"
                  active={clipHasTransition(
                    selectedClip.transitionIn,
                    selectedClip.transitionOut,
                  )}
                >
                  <ClipTransitionSection clip={selectedClip} />
                </CollapsibleSection>
              ) : null}

              {isBgmClip ? (
                <CollapsibleSection id="ducking" title="BGMダッキング">
                  <AudioDuckingSection />
                </CollapsibleSection>
              ) : null}

              <CollapsibleSection
                id="effects"
                title="エフェクト"
                active={selectedClip.effects.length > 0}
                badge={String(selectedClip.effects.length)}
              >
                <ClipEffectsSection clip={selectedClip} />
              </CollapsibleSection>

              {selectedClip.assetId && isVideoClip ? (
                <CollapsibleSection
                  id="overlays"
                  title="テキストオーバーレイ"
                  active={(selectedClip.overlays?.length ?? 0) > 0}
                  badge={String(selectedClip.overlays?.length ?? 0)}
                >
                  <ClipOverlaysSection clip={selectedClip} />
                </CollapsibleSection>
              ) : null}

              {isVideoClip ? (
                <CollapsibleSection id="presets" title="プリセット">
                  <ClipPresetsSection clip={selectedClip} />
                </CollapsibleSection>
              ) : null}
              </div>
            </>
          ) : null}
          {selectedClipIds.length > 1 ? (
            // Multi-select: per-clip sliders make no sense, but the WHOLE point
            // of presets is grading many clips identically — so keep an
            // apply-only preset panel reachable (no single `clip` to save from).
            <CollapsibleSection id="presets-multi" title="プリセット" defaultOpen>
              <ClipPresetsSection />
            </CollapsibleSection>
          ) : null}
          {asset.kind === 'video' ? (
            <>
              {/* High-frequency FPS-montage control: open by default. */}
              <CollapsibleSection id="kill-markers" title="キルマーカー" defaultOpen>
                <KillMarkerSection asset={asset} />
              </CollapsibleSection>
              <CollapsibleSection id="io-range" title="A/D レンジ">
                <IORangeSection asset={asset} />
              </CollapsibleSection>
            </>
          ) : null}
          {asset.kind === 'audio' ? (
            <CollapsibleSection id="beat-detection" title="ビート検出">
              <BeatDetectionSection asset={asset} />
            </CollapsibleSection>
          ) : null}

          {/* Reference-only info, not needed for editing — collapsed and
              pushed to the bottom so it never competes with the controls
              above for space. */}
          <CollapsibleSection id="file-info" title="ファイル情報">
            <AssetInfoSection asset={asset} />
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}

function AssetInfoSection({ asset }: { asset: MediaAsset }) {
  return (
    <>
      <PropRow label="名前" value={asset.name} mono />
      <PropRow label="種類" value={asset.kind === 'video' ? '動画' : '音声'} />
      <PropRow label="サイズ" value={formatFileSize(asset.size)} mono />
      <PropRow label="MIME" value={asset.mimeType || '-'} mono />
      <PropRow label="長さ" value={formatDuration(asset.duration)} mono />
      <PropRow label="長さ (frames)" value={formatTimecode(asset.duration)} mono />
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
    </>
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
