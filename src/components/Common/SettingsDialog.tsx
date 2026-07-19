import { useEffect, useState } from 'react';
import { Settings, Keyboard, Palette, Mic, AlertTriangle, RotateCcw } from 'lucide-react';
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  RESERVED_BINDINGS,
  type ActionId,
  eventToKey,
  formatKey,
  getBindings,
  resetBindings,
  setBinding,
  subscribeBindings,
} from '../../lib/keybindings';
import { ThemeSettings } from './ThemeSettings';
import { AccessibleDialog } from './AccessibleDialog';
import styles from './SettingsDialog.module.css';

type SettingsTab = 'shortcuts' | 'theme';

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>('shortcuts');
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
      const reserved = RESERVED_BINDINGS[newKey];
      if (reserved) {
        setConflictWarning(
          `「${formatKey(newKey)}」は「${reserved}」で使用する予約キーです`,
        );
        window.setTimeout(() => setConflictWarning(null), 2500);
        return;
      }
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
    <AccessibleDialog
      backdropClassName={styles.backdrop}
      dialogClassName={styles.modal}
      titleId="settings-dialog-title"
      onClose={onClose}
    >
        <div className={styles.header}>
          <span
            id="settings-dialog-title"
            className={styles.title}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Settings size={16} strokeWidth={2} aria-hidden="true" />
            設定
          </span>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <div className={styles.tabBar} role="tablist">
          <button
            type="button"
            role="tab"
            id="settings-tab-shortcuts"
            aria-controls="settings-panel-shortcuts"
            aria-selected={tab === 'shortcuts'}
            tabIndex={tab === 'shortcuts' ? 0 : -1}
            data-dialog-initial-focus
            className={`${styles.tabBtn} ${tab === 'shortcuts' ? styles.tabActive : ''}`}
            onClick={() => setTab('shortcuts')}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                setTab('theme');
                document.getElementById('settings-tab-theme')?.focus();
              }
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Keyboard size={14} strokeWidth={2} aria-hidden="true" />
            ショートカット
          </button>
          <button
            type="button"
            role="tab"
            id="settings-tab-theme"
            aria-controls="settings-panel-theme"
            aria-selected={tab === 'theme'}
            tabIndex={tab === 'theme' ? 0 : -1}
            className={`${styles.tabBtn} ${tab === 'theme' ? styles.tabActive : ''}`}
            onClick={() => setTab('theme')}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                setTab('shortcuts');
                document.getElementById('settings-tab-shortcuts')?.focus();
              }
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Palette size={14} strokeWidth={2} aria-hidden="true" />
            テーマ
          </button>
        </div>

        {tab === 'shortcuts' && recordingId ? (
          <div className={styles.recordingBanner} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Mic size={15} strokeWidth={2} aria-hidden="true" />
            新しいキーを押してください (Escでキャンセル)
          </div>
        ) : null}
        {tab === 'shortcuts' && conflictWarning ? (
          <div className={styles.conflictBanner} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={15} strokeWidth={2} aria-hidden="true" />
            {conflictWarning}
          </div>
        ) : null}

        {tab === 'theme' ? (
          <div
            id="settings-panel-theme"
            role="tabpanel"
            aria-labelledby="settings-tab-theme"
            className={styles.body}
          >
            <ThemeSettings />
          </div>
        ) : null}

        {tab === 'shortcuts' ? (
        <div
          id="settings-panel-shortcuts"
          role="tabpanel"
          aria-labelledby="settings-tab-shortcuts"
          className={styles.body}
        >
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
                          <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
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
        ) : null}

        <div className={styles.footer}>
          {tab === 'shortcuts' ? (
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
          ) : (
            <span />
          )}
          <button type="button" className={styles.btnDone} onClick={onClose}>
            完了
          </button>
        </div>
    </AccessibleDialog>
  );
}
