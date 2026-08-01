import { RotateCcw, Sparkles } from 'lucide-react';
import { resolveAudioProcessing } from '../../lib/audioProcessing';
import type { Clip } from '../../lib/types';
import { useProjectStore } from '../../stores/projectStore';
import styles from './ClipAudioProcessingSection.module.css';

export function ClipAudioProcessingSection({ clip }: { clip: Clip }) {
  const setProcessing = useProjectStore((state) => state.setClipAudioProcessing);
  const value = resolveAudioProcessing(clip.audioProcessing);
  const patch = (next: Partial<typeof value>) =>
    setProcessing(clip.id, { ...value, ...next });
  return (
    <div className={styles.root}>
      <div className={styles.presetRow}>
        <button
          type="button"
          className={styles.presetButton}
          onClick={() => setProcessing(clip.id, {
            highPassHz: 80,
            lowGainDb: -2,
            midGainDb: 2.5,
            highGainDb: 1,
            compressor: true,
          })}
        >
          <Sparkles size={14} aria-hidden="true" />
          ボイスを明瞭に
        </button>
        <button type="button" className={styles.resetButton} onClick={() => setProcessing(clip.id, null)} title="音声処理をリセット">
          <RotateCcw size={14} aria-hidden="true" />
          リセット
        </button>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>低域ノイズ除去</span>
        <div className={styles.segmented} role="group" aria-label="ハイパス周波数">
          {[0, 80, 120].map((hz) => (
            <button
              type="button"
              key={hz}
              className={Math.abs(value.highPassHz - hz) < 1 ? styles.active : ''}
              onClick={() => patch({ highPassHz: hz })}
              aria-pressed={Math.abs(value.highPassHz - hz) < 1}
            >
              {hz === 0 ? 'OFF' : `${hz} Hz`}
            </button>
          ))}
        </div>
      </div>

      {([
        ['lowGainDb', '低音', '銃声・迫力'],
        ['midGainDb', '中音', '声・足音'],
        ['highGainDb', '高音', '明瞭さ'],
      ] as const).map(([key, label, hint]) => (
        <label className={styles.sliderRow} key={key}>
          <span><strong>{label}</strong><small>{hint}</small></span>
          <input type="range" min={-12} max={12} step={0.5} value={value[key]} onChange={(event) => patch({ [key]: Number(event.target.value) })} />
          <output>{value[key] > 0 ? '+' : ''}{value[key].toFixed(1)} dB</output>
        </label>
      ))}

      <label className={styles.toggleRow}>
        <span><strong>コンプレッサー</strong><small>声量差や大きなピークを穏やかに整えます</small></span>
        <input type="checkbox" checked={value.compressor} onChange={(event) => patch({ compressor: event.target.checked })} />
      </label>
      <p className={styles.note}>プレビューと書き出しの両方に同じ設定を適用します。</p>
    </div>
  );
}
