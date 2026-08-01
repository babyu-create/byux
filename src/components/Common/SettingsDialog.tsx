import { useEffect, useState } from 'react';
import { Settings, Keyboard, Palette, Mic, AlertTriangle, RotateCcw, Activity, FileDown, CheckCircle2, HardDrive, Trash2 } from 'lucide-react';
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
import { useProjectStore } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import { clipDuration } from '../../lib/timeline';
import styles from './SettingsDialog.module.css';

type SettingsTab = 'shortcuts' | 'theme' | 'support';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>('shortcuts');
  const [bindings, setBindingsState] = useState(() => getBindings());
  const [recordingId, setRecordingId] = useState<ActionId | null>(null);
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);
  const [diagnosticStatus, setDiagnosticStatus] = useState<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const [cacheSummary, setCacheSummary] = useState<{
    waveform: { files: number; bytes: number };
    previewProxy: { files: number; bytes: number };
  } | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const tracks = useProjectStore((state) => state.tracks);
  const clips = useProjectStore((state) => state.clips);
  const subtitleCount = useProjectStore((state) => state.subtitles.length);
  const assetCount = useMediaStore((state) => state.assets.length);

  useEffect(() => {
    return subscribeBindings(() => setBindingsState({ ...getBindings() }));
  }, []);

  useEffect(() => {
    if (tab !== 'support') return;
    let cancelled = false;
    void window.fce?.cache?.getSummary().then((result) => {
      if (!cancelled && result.ok && result.summary) setCacheSummary(result.summary);
    });
    return () => { cancelled = true; };
  }, [tab]);

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
                const next = event.key === 'ArrowRight' ? 'theme' : 'support';
                setTab(next);
                document.getElementById(`settings-tab-${next}`)?.focus();
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
                const next = event.key === 'ArrowRight' ? 'support' : 'shortcuts';
                setTab(next);
                document.getElementById(`settings-tab-${next}`)?.focus();
              }
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Palette size={14} strokeWidth={2} aria-hidden="true" />
            テーマ
          </button>
          <button
            type="button"
            role="tab"
            id="settings-tab-support"
            aria-controls="settings-panel-support"
            aria-selected={tab === 'support'}
            tabIndex={tab === 'support' ? 0 : -1}
            className={`${styles.tabBtn} ${tab === 'support' ? styles.tabActive : ''}`}
            onClick={() => setTab('support')}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const next = event.key === 'ArrowRight' ? 'shortcuts' : 'theme';
                setTab(next);
                document.getElementById(`settings-tab-${next}`)?.focus();
              }
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Activity size={14} strokeWidth={2} aria-hidden="true" />
            サポート
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

        {tab === 'support' ? (
          <div
            id="settings-panel-support"
            role="tabpanel"
            aria-labelledby="settings-tab-support"
            className={styles.body}
          >
            <section className={styles.supportCard}>
              <Activity size={22} aria-hidden="true" />
              <div>
                <h3>診断情報</h3>
                <p>
                  動作環境、FFmpeg/GPUの状態、キャッシュ容量、匿名の件数情報をJSONへ保存します。
                  素材名・プロジェクト名・ユーザー名・ローカルパスは含めません。
                </p>
              </div>
            </section>
            <button
              type="button"
              className={styles.diagnosticButton}
              onClick={async () => {
                const saveDiagnostics = window.fce?.saveDiagnostics;
                if (!saveDiagnostics) {
                  setDiagnosticStatus('診断情報の保存はデスクトップ版で利用できます');
                  return;
                }
                setDiagnosticStatus('診断情報を収集中…');
                const durationSeconds = clips.reduce(
                  (end, clip) => Math.max(end, clip.start + clipDuration(clip)),
                  0,
                );
                const result = await saveDiagnostics({
                  tracks: tracks.length,
                  clips: clips.length,
                  assets: assetCount,
                  subtitles: subtitleCount,
                  durationSeconds,
                });
                setDiagnosticStatus(
                  result.canceled
                    ? null
                    : result.ok
                      ? `保存しました: ${result.path ?? ''}`
                      : (result.error ?? '診断情報を保存できませんでした'),
                );
              }}
            >
              <FileDown size={16} aria-hidden="true" />
              診断情報を保存
            </button>
            {diagnosticStatus ? (
              <p className={styles.diagnosticStatus} aria-live="polite">
                {diagnosticStatus.startsWith('保存しました') ? <CheckCircle2 size={14} aria-hidden="true" /> : null}
                {diagnosticStatus}
              </p>
            ) : null}
            <section className={styles.cacheCard}>
              <HardDrive size={22} aria-hidden="true" />
              <div>
                <h3>キャッシュ管理</h3>
                <p>
                  {cacheSummary
                    ? `互換プレビュー ${formatBytes(cacheSummary.previewProxy.bytes)} / 波形 ${formatBytes(cacheSummary.waveform.bytes)}`
                    : 'キャッシュ容量を確認しています…'}
                </p>
                <p>編集中の素材は保護し、再生成できる未使用ファイルだけを削除します。</p>
              </div>
            </section>
            <button
              type="button"
              className={styles.cacheButton}
              disabled={clearingCache || !window.fce?.cache}
              onClick={async () => {
                const cache = window.fce?.cache;
                if (!cache) return;
                if (!window.confirm('未使用の互換プレビューと波形キャッシュを削除しますか？')) return;
                setClearingCache(true);
                setCacheStatus('未使用キャッシュを削除中…');
                try {
                  const result = await cache.clearUnused();
                  if (result.ok && result.summary) {
                    const removedBytes =
                      (result.removed?.previewProxy.bytes ?? 0) +
                      (result.removed?.waveform.bytes ?? 0);
                    setCacheSummary(result.summary);
                    setCacheStatus(`${formatBytes(removedBytes)}を削除しました`);
                  } else {
                    setCacheStatus(result.error ?? 'キャッシュを削除できませんでした');
                  }
                } finally {
                  setClearingCache(false);
                }
              }}
            >
              <Trash2 size={16} aria-hidden="true" />
              {clearingCache ? '削除中…' : '未使用キャッシュを削除'}
            </button>
            {cacheStatus ? (
              <p className={styles.diagnosticStatus} aria-live="polite">{cacheStatus}</p>
            ) : null}
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
