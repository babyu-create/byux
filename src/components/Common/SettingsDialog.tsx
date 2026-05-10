import { useEffect, useState } from 'react';
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  type ActionId,
  eventToKey,
  formatKey,
  getBindings,
  resetBindings,
  setBinding,
  subscribeBindings,
} from '../../lib/keybindings';
import styles from './SettingsDialog.module.css';

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [bindings, setBindingsState] = useState(() => getBindings());
  const [recordingId, setRecordingId] = useState<ActionId | null>(null);
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);

  useEffect(() => {
    return subscribeBindings(() => setBindingsState({ ...getBindings() }));
  }, []);

  // Capture next keypress when recording
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      // Ignore standalone modifier keys
      if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingId(null);
        return;
      }
      const newKey = eventToKey(e);
      // Check for conflicts
      const all = getBindings();
      const conflict = ACTIONS.find(
        (a) => a.id !== recordingId && all[a.id] === newKey,
      );
      if (conflict) {
        setConflictWarning(
          `「${formatKey(newKey)}」は既に「${conflict.label}」に割り当てられています`,
        );
        window.setTimeout(() => setConflictWarning(null), 2500);
        return;
      }
      setBinding(recordingId, newKey);
      setRecordingId(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [recordingId]);

  const grouped = ACTIONS.reduce<Record<string, typeof ACTIONS>>((acc, a) => {
    if (!acc[a.group]) acc[a.group] = [];
    acc[a.group].push(a);
    return acc;
  }, {});

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>⚙ ショートカット設定</span>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        {recordingId ? (
          <div className={styles.recordingBanner}>
            🎙 新しいキーを押してください (Escでキャンセル)
          </div>
        ) : null}
        {conflictWarning ? (
          <div className={styles.conflictBanner}>⚠ {conflictWarning}</div>
        ) : null}

        <div className={styles.body}>
          {Object.entries(grouped).map(([group, items]) => (
            <section key={group} className={styles.group}>
              <h3 className={styles.groupTitle}>{group}</h3>
              <div className={styles.list}>
                {items.map((a) => {
                  const isRecording = recordingId === a.id;
                  const isCustom = bindings[a.id] !== DEFAULT_BINDINGS[a.id];
                  return (
                    <div key={a.id} className={styles.row}>
                      <span className={styles.label}>{a.label}</span>
                      <button
                        type="button"
                        className={`${styles.keyBtn} ${isRecording ? styles.recording : ''} ${isCustom ? styles.custom : ''}`}
                        onClick={() => setRecordingId(a.id)}
                        title={isCustom ? 'カスタム設定中' : 'デフォルト'}
                      >
                        {isRecording ? '...' : formatKey(bindings[a.id])}
                      </button>
                      {isCustom ? (
                        <button
                          type="button"
                          className={styles.resetBtn}
                          onClick={() => setBinding(a.id, DEFAULT_BINDINGS[a.id])}
                          title="デフォルトに戻す"
                          aria-label="リセット"
                        >
                          ↺
                        </button>
                      ) : (
                        <span className={styles.resetSpacer} />
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.btnReset}
            onClick={() => {
              if (window.confirm('全てのショートカットをデフォルトに戻しますか？')) {
                resetBindings();
              }
            }}
          >
            全てリセット
          </button>
          <button type="button" className={styles.btnDone} onClick={onClose}>
            完了
          </button>
        </div>
      </div>
    </div>
  );
}
