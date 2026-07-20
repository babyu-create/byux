import { useMemo } from 'react';
import { Sparkles, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useMediaStore } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import {
  gainToDecibels,
  recommendPeakVolume,
} from '../../lib/audioLevels';
import type { Clip } from '../../lib/types';
import styles from './ClipVolumeSection.module.css';

interface ClipVolumeSectionProps {
  clip: Clip;
}

export function ClipVolumeSection({ clip }: ClipVolumeSectionProps) {
  const setVolume = useProjectStore((s) => s.setClipVolume);
  const toggleMuted = useProjectStore((s) => s.toggleClipMuted);
  const asset = useMediaStore((state) =>
    state.assets.find((candidate) => candidate.id === clip.assetId),
  );
  const volume = clip.volume ?? 1;
  const muted = clip.muted ?? false;
  const percent = Math.round(volume * 100);
  const waveform = asset?.waveform;
  const recommendation = useMemo(
    () =>
      waveform
        ? recommendPeakVolume(waveform, clip.trimStart, clip.trimEnd)
        : null,
    [waveform, clip.trimEnd, clip.trimStart],
  );
  const currentPeakDb = recommendation
    ? gainToDecibels(recommendation.sourcePeak * volume)
    : null;
  const peakHint = recommendation
    ? `現在 ${currentPeakDb?.toFixed(1) ?? '−∞'} dBFS · 推奨 ${Math.round(recommendation.volume * 100)}%${recommendation.capped ? '（上限）' : ''}`
    : asset?.waveformStatus === 'loading'
      ? '音声ピークを解析中…'
      : asset?.waveformStatus === 'unavailable'
        ? 'この素材の音声ピークを解析できません'
        : asset?.waveform
          ? '選択範囲は無音です'
          : '音声解析を利用できません';

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>音量</span>
        <span
          className={`${styles.count} ${muted ? styles.countMuted : volume !== 1 ? styles.countActive : ''}`}
        >
          {muted ? 'MUTE' : `${percent}%`}
        </span>
      </div>

      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.muteBtn} ${muted ? styles.muteOn : ''}`}
          onClick={() => toggleMuted(clip.id)}
          aria-pressed={muted}
          title={muted ? 'ミュート解除' : 'ミュート'}
        >
          {muted || volume === 0 ? (
            <VolumeX size={15} strokeWidth={2} aria-hidden="true" />
          ) : volume < 1 ? (
            <Volume1 size={15} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Volume2 size={15} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(clip.id, parseFloat(e.target.value))}
          className={styles.slider}
          disabled={muted}
          aria-label="クリップ音量"
          aria-valuetext={`${percent}%`}
        />
        <span className={styles.value}>{percent}%</span>
      </div>

      <div className={styles.presetGroup} role="group" aria-label="音量プリセット">
        {[0, 0.25, 0.5, 0.75, 1, 1.5, 2].map((v) => (
          <button
            key={v}
            type="button"
            className={`${styles.presetBtn} ${
              !muted && Math.abs(volume - v) < 0.01 ? styles.active : ''
            }`}
            onClick={() => setVolume(clip.id, v)}
            aria-pressed={!muted && Math.abs(volume - v) < 0.01}
          >
            {v === 0 ? '0' : `${Math.round(v * 100)}`}
          </button>
        ))}
      </div>

      <div className={styles.peakTool}>
        <button
          type="button"
          className={styles.normalizeBtn}
          onClick={() => {
            if (recommendation) setVolume(clip.id, recommendation.volume);
          }}
          disabled={!recommendation}
          aria-label="クリップのピークをマイナス1dBに整える"
          title="選択範囲の最大ピークを基準に音量を設定"
        >
          <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
          ピークを -1 dB に整える
        </button>
        <p className={styles.peakHint}>{peakHint}</p>
        <p className={styles.peakNote}>
          クリッピングを避ける目安です。聴感上の音量統一（LUFS）ではありません。
        </p>
      </div>
    </div>
  );
}
