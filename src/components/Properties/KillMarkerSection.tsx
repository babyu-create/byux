import { useMemo, useState } from 'react';
import { Target } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { formatTimecode } from '../../lib/media';
import {
  clipDuration,
  sourceTimeAtTimelineTime,
  timelineTimeAtSourceTime,
} from '../../lib/timeline';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import type { MediaAsset } from '../../lib/types';
import styles from './KillMarkerSection.module.css';

interface KillMarkerSectionProps {
  asset: MediaAsset;
}

export function KillMarkerSection({ asset }: KillMarkerSectionProps) {
  const allMarkers = useProjectStore((s) => s.markers);
  const sortedMarkers = useMemo(
    () =>
      allMarkers
        .filter((m) => m.assetId === asset.id)
        .sort((a, b) => a.time - b.time),
    [allMarkers, asset.id],
  );
  const selectedMarkerId = useProjectStore((s) => s.selectedMarkerId);
  const selectMarker = useProjectStore((s) => s.selectMarker);
  const removeMarker = useProjectStore((s) => s.removeKillMarker);
  const addMarker = useProjectStore((s) => s.addKillMarker);
  const playhead = useProjectStore((s) => s.playhead);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const clips = useProjectStore((s) => s.clips);
  const tracks = useProjectStore((s) => s.tracks);
  const preRollSec = useProjectStore((s) => s.preRollSec);
  const postRollSec = useProjectStore((s) => s.postRollSec);
  const setPreRoll = useProjectStore((s) => s.setPreRoll);
  const setPostRoll = useProjectStore((s) => s.setPostRoll);
  const autoClip = useProjectStore((s) => s.autoClipFromMarkers);
  const removeMediaAsset = useMediaStore((s) => s.removeAsset);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const jumpToMarker = (markerId: string, time: number) => {
    selectMarker(markerId);
    // Find a clip on the video track that contains this asset and seek to it.
    const videoTrackId = tracks.find((t) => t.kind === 'video')?.id;
    const targetClip = clips
      .filter(
        (c) =>
          c.trackId === videoTrackId &&
          c.assetId === asset.id &&
          time >= c.trimStart - 1e-6 &&
          time <= c.trimEnd + 1e-6,
      )
      .sort((a, b) => a.start - b.start)[0];
    if (targetClip) {
      setPlayhead(timelineTimeAtSourceTime(targetClip, time));
    }
  };

  const handleAddAtPlayhead = () => {
    // Determine source time from playhead by inverting the active clip mapping.
    const videoTrackId = tracks.find((t) => t.kind === 'video')?.id;
    if (!videoTrackId) return;
    const activeClip = clips.find((c) => {
      if (c.trackId !== videoTrackId) return false;
      if (c.assetId !== asset.id) return false;
      const end = c.start + clipDuration(c);
      return playhead >= c.start - 1e-6 && playhead < end - 1e-6;
    });
    let sourceTime = 0;
    if (activeClip) {
      // Convert timeline time → source time: multiply the timeline offset by the
      // clip's playback speed (a 2× clip covers 2 source-seconds per timeline-
      // second). Mirrors extractCurrentRange / jumpToAdjacentMarker in the store.
      sourceTime = sourceTimeAtTimelineTime(activeClip, playhead);
    }
    addMarker(asset.id, sourceTime);
  };

  const beginAutoClip = () => {
    if (sortedMarkers.length === 0) return;
    const videoTrack = useProjectStore.getState().tracks.find((track) => track.kind === 'video');
    if (videoTrack?.locked) {
      setResultMessage('映像トラックのロックを解除してください');
      return;
    }
    setConfirmOpen(true);
  };

  const runAutoClip = () => {
    const generated = autoClip(asset.id, {
      preRoll: preRollSec,
      postRoll: postRollSec,
      deleteSourceClips: true,
    });
    setResultMessage(
      generated > 0
        ? `${generated}本のクリップを生成しました`
        : 'マーカーがありません',
    );
    void removeMediaAsset; // currently unused
    window.setTimeout(() => setResultMessage(null), 2400);
  };

  const handleConfirm = () => {
    setConfirmOpen(false);
    runAutoClip();
  };

  const totalSec = sortedMarkers.length * (preRollSec + postRollSec);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>キルマーカー</span>
        <span className={styles.count}>{sortedMarkers.length}</span>
      </div>

      <div className={styles.list}>
        {sortedMarkers.length === 0 ? (
          <div className={styles.empty}>
            動画再生中に <kbd>W</kbd> キーで追加
          </div>
        ) : (
          sortedMarkers.map((m, idx) => (
            <div
              key={m.id}
              className={`${styles.row} ${selectedMarkerId === m.id ? styles.selected : ''}`}
            >
              <button
                type="button"
                className={styles.rowSelect}
                onClick={() => jumpToMarker(m.id, m.time)}
                aria-pressed={selectedMarkerId === m.id}
                aria-label={`マーカー${idx + 1}、${formatTimecode(m.time)}へ移動`}
              >
                <span className={styles.idx}>{idx + 1}</span>
                <span className={styles.time}>{formatTimecode(m.time)}</span>
              </button>
              <button
                type="button"
                className={styles.removeBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  removeMarker(m.id);
                }}
                aria-label="削除"
                title="削除"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      <div className={styles.footer}>
        <button type="button" className={styles.smallBtn} onClick={handleAddAtPlayhead}>
          ＋ 現在位置に追加
        </button>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>オートクリップ設定</div>
        <RollSlider
          label="Pre-roll"
          value={preRollSec}
          onChange={setPreRoll}
          min={0}
          max={10}
        />
        <RollSlider
          label="Post-roll"
          value={postRollSec}
          onChange={setPostRoll}
          min={0}
          max={10}
        />
        <div className={styles.estimateRow}>
          <span className={styles.estimateLabel}>合計予測長</span>
          <span className={styles.estimateValue}>{totalSec.toFixed(1)}秒</span>
        </div>

        <button
          type="button"
          className={styles.primaryBtn}
          onClick={beginAutoClip}
          disabled={sortedMarkers.length === 0}
        >
          <Target size={15} strokeWidth={2} aria-hidden="true" />
          <span>マーカーから自動切り出し</span>
        </button>

        {resultMessage ? <div className={styles.toast}>{resultMessage}</div> : null}
      </div>

      {confirmOpen ? (
        <ConfirmDialog
          title="オートクリップ生成"
          message={`元クリップ (${asset.name}) を削除して、${sortedMarkers.length}本のキルクリップに置き換えます。よろしいですか？`}
          confirmLabel="生成する"
          cancelLabel="キャンセル"
          variant="destructive"
          onConfirm={handleConfirm}
          onCancel={() => setConfirmOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface RollSliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}

function RollSlider({ label, value, onChange, min, max }: RollSliderProps) {
  return (
    <div className={styles.rollRow}>
      <span className={styles.rollLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.5}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={styles.rollSlider}
        aria-label={label}
        aria-valuetext={`${value.toFixed(1)}秒`}
      />
      <span className={styles.rollValue}>{value.toFixed(1)}s</span>
    </div>
  );
}
