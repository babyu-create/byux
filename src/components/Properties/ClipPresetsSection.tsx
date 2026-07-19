import { useCallback, useMemo, useState } from 'react';
import { BookMarked, Check, Plus, Trash2 } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import type { Clip } from '../../lib/types';
import {
  createPresetFromClip,
  extractClipLook,
  loadPresets,
  looksEmpty,
  savePresets,
  type ClipPreset,
} from '../../lib/presets';
import styles from './ClipPresetsSection.module.css';

interface ClipPresetsSectionProps {
  /**
   * The single selected clip whose look can be SAVED as a new preset. Omitted in
   * multi-select mode, where the panel becomes apply-only (you can't save the
   * look of "many" clips, but you CAN apply a saved preset to all of them).
   */
  clip?: Clip;
}

/**
 * Preset / montage-template panel (Phase P6). Lets the user save the current
 * clip's look (transform / color grade / effects / text / transitions / speed)
 * as a named preset and one-click apply any saved preset to ALL selected clips.
 * The library is persisted to localStorage via lib/presets (pure, validated).
 *
 * Two modes:
 * - single-select (`clip` provided): save the clip's look AND apply presets.
 * - multi-select (`clip` omitted): apply-only — the whole point of presets is
 *   grading many clips identically, so the apply path must stay reachable when
 *   more than one clip is selected.
 */
export function ClipPresetsSection({ clip }: ClipPresetsSectionProps) {
  const applyPresetToClips = useProjectStore((s) => s.applyPresetToClips);
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds);
  const showMessage = useProjectStore((s) => s.showMessage);

  // The library lives in component state seeded from localStorage; every change
  // is mirrored back to storage so it survives reloads.
  const [presets, setPresets] = useState<ClipPreset[]>(() => loadPresets());
  const [name, setName] = useState('');

  const persist = useCallback((next: ClipPreset[]) => {
    setPresets(next);
    savePresets(next);
  }, []);

  // A clip with a default (untouched) look has nothing worth saving. In
  // multi-select mode there is no single clip, so saving is unavailable.
  const canSave = useMemo(
    () => (clip ? !looksEmpty(extractClipLook(clip)) : false),
    [clip],
  );
  const targetCount = selectedClipIds.length || 1;

  const handleSave = () => {
    if (!clip || !canSave) {
      showMessage('info', 'このクリップにはまだ保存できるルックがありません');
      return;
    }
    const preset = createPresetFromClip(clip, name);
    persist([preset, ...presets]);
    setName('');
    showMessage('success', `プリセット「${preset.name}」を保存`);
  };

  const handleApply = (preset: ClipPreset) => {
    const ids =
      selectedClipIds.length > 0 ? selectedClipIds : clip ? [clip.id] : [];
    const applied = applyPresetToClips(ids, preset.look);
    if (applied > 0) {
      showMessage('success', `「${preset.name}」を${applied}クリップに適用`);
    } else {
      showMessage('info', '適用先がありません（ロックされたトラック）');
    }
  };

  const handleDelete = (id: string) => {
    persist(presets.filter((p) => p.id !== id));
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>プリセット</span>
        <span className={`${styles.count} ${presets.length > 0 ? styles.countActive : ''}`}>
          {presets.length}
        </span>
      </div>

      {clip ? (
        <div className={styles.saveRow}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
            className={styles.nameInput}
            placeholder="プリセット名（例: シネマ寄り）"
            maxLength={60}
            aria-label="プリセット名"
          />
          <button
            type="button"
            className={styles.saveBtn}
            onClick={handleSave}
            disabled={!canSave}
            title={canSave ? 'このクリップのルックを保存' : '保存できるルックがありません'}
          >
            <Plus size={14} strokeWidth={2.4} aria-hidden="true" />
            保存
          </button>
        </div>
      ) : (
        <div className={styles.applyAllNote}>
          選択中の{targetCount}クリップに一括適用できます
        </div>
      )}

      {presets.length === 0 ? (
        <div className={styles.empty}>
          保存したルックはここに並びます
        </div>
      ) : (
        <div className={styles.list}>
          {presets.map((p) => (
            <div key={p.id} className={styles.row}>
              <button
                type="button"
                className={styles.applyBtn}
                onClick={() => handleApply(p)}
                title={`「${p.name}」を選択中の${targetCount}クリップに適用`}
              >
                <Check size={13} strokeWidth={2.4} aria-hidden="true" />
                <span className={styles.presetName}>{p.name}</span>
              </button>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => handleDelete(p.id)}
                aria-label={`プリセット「${p.name}」を削除`}
                title="削除"
              >
                <Trash2 size={13} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.hint}>
        <BookMarked size={12} strokeWidth={2} aria-hidden="true" />
        <span>
          ルック（変形・カラー・エフェクト・テキスト・トランジション）を保存して他のクリップへワンクリック適用。
        </span>
      </div>
    </div>
  );
}
