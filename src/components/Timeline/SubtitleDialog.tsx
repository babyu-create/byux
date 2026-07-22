import { useRef } from 'react';
import { FileUp, Plus, Trash2, X } from 'lucide-react';
import { formatTimecode } from '../../lib/media';
import { MAX_SUBTITLE_CUES, parseSubtitleFile } from '../../lib/subtitles';
import { useProjectStore } from '../../stores/projectStore';
import { AccessibleDialog } from '../Common/AccessibleDialog';
import styles from './SubtitleDialog.module.css';

interface SubtitleDialogProps {
  onClose: () => void;
}

export function SubtitleDialog({ onClose }: SubtitleDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cues = useProjectStore((state) => state.subtitles);
  const style = useProjectStore((state) => state.subtitleStyle);
  const playhead = useProjectStore((state) => state.playhead);
  const setSubtitles = useProjectStore((state) => state.setSubtitles);
  const addSubtitle = useProjectStore((state) => state.addSubtitle);
  const updateSubtitle = useProjectStore((state) => state.updateSubtitle);
  const removeSubtitle = useProjectStore((state) => state.removeSubtitle);
  const setSubtitleStyle = useProjectStore((state) => state.setSubtitleStyle);
  const showMessage = useProjectStore((state) => state.showMessage);

  return (
    <AccessibleDialog
      backdropClassName={styles.backdrop}
      dialogClassName={styles.dialog}
      titleId="subtitle-dialog-title"
      descriptionId="subtitle-dialog-description"
      onClose={onClose}
    >
      <header className={styles.header}>
        <div>
          <h2 id="subtitle-dialog-title">字幕</h2>
          <p id="subtitle-dialog-description">
            SRT / WebVTTの読み込み、時刻と文章の修正、見た目の調整ができます。
          </p>
        </div>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="字幕を閉じる">
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className={styles.toolbar}>
        <button type="button" className={styles.primaryButton} onClick={() => inputRef.current?.click()}>
          <FileUp size={15} aria-hidden="true" />
          SRT / VTTを読み込む
        </button>
        <input
          ref={inputRef}
          className={styles.hiddenInput}
          type="file"
          accept=".srt,.vtt,text/plain,text/vtt,application/x-subrip"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) {
              showMessage('error', '字幕ファイルが大きすぎます（上限10MB）');
              return;
            }
            try {
              const parsed = parseSubtitleFile(await file.text());
              if (parsed.length === 0) throw new Error('有効な字幕がありません');
              setSubtitles(parsed);
              showMessage(
                'success',
                parsed.length >= MAX_SUBTITLE_CUES
                  ? `先頭${MAX_SUBTITLE_CUES}件の字幕を読み込みました`
                  : `${parsed.length}件の字幕を読み込みました`,
              );
            } catch (error) {
              showMessage('error', error instanceof Error ? error.message : '字幕を読み込めませんでした');
            }
          }}
        />
        <button type="button" className={styles.secondaryButton} onClick={() => addSubtitle(playhead)}>
          <Plus size={15} aria-hidden="true" />
          再生位置に追加
        </button>
        <span className={styles.count}>{cues.length.toLocaleString()} 件</span>
      </div>

      <section className={styles.stylePanel} aria-label="字幕スタイル">
        <label>
          <span>サイズ</span>
          <input
            type="range"
            min={2}
            max={12}
            step={0.2}
            value={style.fontSize}
            onChange={(event) => setSubtitleStyle({ fontSize: Number(event.target.value) })}
          />
          <output>{style.fontSize.toFixed(1)}%</output>
        </label>
        <label>
          <span>文字</span>
          <input type="color" value={style.color} onChange={(event) => setSubtitleStyle({ color: event.target.value })} />
        </label>
        <label>
          <span>縁取り</span>
          <input type="color" value={style.outlineColor} onChange={(event) => setSubtitleStyle({ outlineColor: event.target.value })} />
        </label>
        <label>
          <span>位置</span>
          <select value={style.position} onChange={(event) => setSubtitleStyle({ position: event.target.value as typeof style.position })}>
            <option value="top">上</option>
            <option value="center">中央</option>
            <option value="bottom">下</option>
          </select>
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={style.background !== 'transparent'}
            onChange={(event) => setSubtitleStyle({ background: event.target.checked ? 'rgba(0,0,0,0.58)' : 'transparent' })}
          />
          半透明背景
        </label>
      </section>

      <div className={styles.cueList}>
        {cues.length === 0 ? (
          <div className={styles.empty}>字幕はありません。ファイルを読み込むか、再生位置に追加してください。</div>
        ) : cues.map((cue, index) => (
          <article className={styles.cue} key={cue.id}>
            <div className={styles.cueNumber}>#{index + 1}</div>
            <label className={styles.timeField}>
              <span>開始</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={cue.start}
                onChange={(event) => {
                  const start = Math.max(0, Number(event.target.value));
                  updateSubtitle(cue.id, { start, end: Math.max(cue.end, start + 0.05) });
                }}
              />
              <small>{formatTimecode(cue.start)}</small>
            </label>
            <label className={styles.timeField}>
              <span>終了</span>
              <input
                type="number"
                min={cue.start + 0.05}
                step={0.01}
                value={cue.end}
                onChange={(event) => updateSubtitle(cue.id, { end: Math.max(Number(event.target.value), cue.start + 0.05) })}
              />
              <small>{formatTimecode(cue.end)}</small>
            </label>
            <label className={styles.textField}>
              <span>字幕本文</span>
              <textarea
                rows={2}
                maxLength={2_000}
                value={cue.text}
                onChange={(event) => updateSubtitle(cue.id, { text: event.target.value })}
              />
            </label>
            <button type="button" className={styles.deleteButton} onClick={() => removeSubtitle(cue.id)} aria-label={`${index + 1}番目の字幕を削除`}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
    </AccessibleDialog>
  );
}
