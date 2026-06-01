import { useSelectedAsset } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import { formatDuration, formatFileSize, formatTimecode } from '../../lib/media';
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
  const isVideoClip = selectedClipTrackKind !== 'audio';

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

              <CollapsibleSection
                id="volume"
                title="音量"
                active={(selectedClip.volume ?? 1) !== 1 || (selectedClip.muted ?? false)}
                badge={
                  selectedClip.muted
                    ? 'MUTE'
                    : `${Math.round((selectedClip.volume ?? 1) * 100)}%`
                }
              >
                <ClipVolumeSection clip={selectedClip} />
              </CollapsibleSection>

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
