import { useProjectStore } from '../../stores/projectStore';
import type { Clip, OverlayPosition, OverlayText } from '../../lib/types';
import styles from './ClipOverlaysSection.module.css';

interface ClipOverlaysSectionProps {
  clip: Clip;
}

const POSITIONS: { value: OverlayPosition; label: string }[] = [
  { value: 'top-left', label: '左上' },
  { value: 'top-center', label: '上' },
  { value: 'top-right', label: '右上' },
  { value: 'center', label: '中央' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-center', label: '下' },
  { value: 'bottom-right', label: '右下' },
];

function buildDefaultOverlay(): Omit<OverlayText, 'id'> {
  return {
    text: 'テキスト',
    fontSize: 8,
    color: '#ffffff',
    position: 'bottom-center',
    weight: 700,
    outline: true,
    outlineColor: '#000000',
  };
}

export function ClipOverlaysSection({ clip }: ClipOverlaysSectionProps) {
  const addOverlay = useProjectStore((s) => s.addClipOverlay);
  const updateOverlay = useProjectStore((s) => s.updateClipOverlay);
  const removeOverlay = useProjectStore((s) => s.removeClipOverlay);
  const overlays = clip.overlays ?? [];

  const handleAdd = () => {
    addOverlay(clip.id, { ...buildDefaultOverlay(), id: crypto.randomUUID() });
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>テキストオーバーレイ</span>
        <span
          className={`${styles.count} ${overlays.length > 0 ? styles.countActive : ''}`}
        >
          {overlays.length}
        </span>
      </div>

      <button type="button" className={styles.addBtn} onClick={handleAdd}>
        ＋ テキスト追加
      </button>

      {overlays.length === 0 ? (
        <div className={styles.empty}>テキストはまだありません</div>
      ) : (
        <div className={styles.list}>
          {overlays.map((o) => (
            <div key={o.id} className={styles.row}>
              <input
                type="text"
                value={o.text}
                onChange={(e) =>
                  updateOverlay(clip.id, o.id, { text: e.target.value })
                }
                className={styles.textInput}
                placeholder="テキスト"
              />
              <div className={styles.controls}>
                <select
                  value={o.position}
                  onChange={(e) =>
                    updateOverlay(clip.id, o.id, {
                      position: e.target.value as OverlayPosition,
                    })
                  }
                  className={styles.select}
                  aria-label="位置"
                >
                  {POSITIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  type="color"
                  value={o.color}
                  onChange={(e) =>
                    updateOverlay(clip.id, o.id, { color: e.target.value })
                  }
                  className={styles.colorInput}
                  aria-label="文字色"
                />
                <button
                  type="button"
                  className={`${styles.outlineBtn} ${o.outline ? styles.outlineOn : ''}`}
                  onClick={() =>
                    updateOverlay(clip.id, o.id, { outline: !o.outline })
                  }
                  title="アウトライン"
                  aria-pressed={!!o.outline}
                >
                  T̲
                </button>
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => removeOverlay(clip.id, o.id)}
                  aria-label="削除"
                >
                  ×
                </button>
              </div>
              <div className={styles.sliderRow}>
                <span className={styles.sliderLabel}>サイズ</span>
                <input
                  type="range"
                  min={3}
                  max={24}
                  step={0.5}
                  value={o.fontSize}
                  onChange={(e) =>
                    updateOverlay(clip.id, o.id, {
                      fontSize: parseFloat(e.target.value),
                    })
                  }
                />
                <span className={styles.sliderValue}>{o.fontSize.toFixed(1)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.hint}>
        トークン: <code>{'{n}'}</code> = キル番号 / <code>{'{total}'}</code> = 総数
      </div>
    </div>
  );
}
