import { useEffect, useMemo, useState } from 'react';
import { Keyboard } from 'lucide-react';
import {
  ACTIONS,
  formatKey,
  getBindings,
  subscribeBindings,
} from '../../lib/keybindings';
import { AccessibleDialog } from './AccessibleDialog';
import styles from './HelpDialog.module.css';

interface HelpDialogProps {
  onClose: () => void;
}

interface StaticEntry {
  keys: string[];
  label: string;
}

const STATIC_GROUPS: { title: string; items: StaticEntry[] }[] = [
  {
    title: '基本操作',
    items: [
      { keys: ['＋'], label: '素材をタイムラインの末尾へ追加' },
      { keys: ['クリック'], label: 'クリップを選択' },
      { keys: ['Shift', 'クリック'], label: '複数クリップを選択' },
      { keys: ['端をドラッグ'], label: 'クリップの開始・終了をトリミング' },
      { keys: ['Shift', 'ドラッグ'], label: 'スナップを一時的に無効化' },
      { keys: ['Esc'], label: 'ドラッグ中の移動・トリミングを取り消す' },
      { keys: ['Alt', '← / →'], label: '選択クリップを0.1秒ずつ移動' },
      { keys: ['Shift', 'Alt', '← / →'], label: '選択クリップを1秒ずつ移動' },
      { keys: ['右クリック'], label: '音量・速度・分割などのメニューを表示' },
    ],
  },
  {
    title: 'プロジェクト',
    items: [
      { keys: ['Ctrl', 'S'], label: 'プロジェクト保存' },
      { keys: ['Ctrl', 'Shift', 'S'], label: '別名で保存' },
      { keys: ['Ctrl', 'Z'], label: '元に戻す' },
      { keys: ['Ctrl', 'Y'], label: 'やり直す' },
      { keys: ['?'], label: 'このヘルプを表示' },
    ],
  },
];

/** Lowercase-includes match across label and key string for a single row. */
function matchesQuery(query: string, label: string, keys: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  if (!q) return true;
  return label.toLowerCase().includes(q) || keys.toLowerCase().includes(q);
}

export function HelpDialog({ onClose }: HelpDialogProps) {
  const [bindings, setBindings] = useState(() => getBindings());
  const [query, setQuery] = useState('');
  useEffect(() => subscribeBindings(() => setBindings({ ...getBindings() })), []);

  // Group dynamic actions by their group name, applying the query filter
  // along the way. Memoize so typing doesn't re-trigger the full reduce
  // on every render.
  const grouped = useMemo(() => {
    return ACTIONS.reduce<Record<string, typeof ACTIONS>>((acc, a) => {
      const keys = formatKey(bindings[a.id]);
      if (!matchesQuery(query, a.label, keys)) return acc;
      if (!acc[a.group]) acc[a.group] = [];
      acc[a.group].push(a);
      return acc;
    }, {});
  }, [bindings, query]);

  const filteredStatic = useMemo(() => {
    return STATIC_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((item) =>
        matchesQuery(query, item.label, item.keys.join(' + ')),
      ),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  const totalHits =
    Object.values(grouped).reduce((n, list) => n + list.length, 0) +
    filteredStatic.reduce((n, g) => n + g.items.length, 0);

  return (
    <AccessibleDialog
      backdropClassName={styles.backdrop}
      dialogClassName={styles.modal}
      titleId="help-dialog-title"
      onClose={onClose}
    >
        <div className={styles.header}>
          <span
            id="help-dialog-title"
            className={styles.title}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Keyboard size={16} strokeWidth={2} aria-hidden="true" />
            ヘルプ / ショートカット
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

        <div className={styles.searchRow}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="検索 (例: 再生 / トリミング / Space)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="ショートカットを検索"
            autoFocus
            data-dialog-initial-focus
          />
          {query ? (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => setQuery('')}
              aria-label="検索をクリア"
              title="クリア"
            >
              ×
            </button>
          ) : null}
        </div>

        <div className={styles.body}>
          {totalHits === 0 ? (
            <div className={styles.empty}>該当するショートカットがありません</div>
          ) : null}
          {Object.entries(grouped).map(([group, items]) => (
            <section key={group} className={styles.group}>
              <h3 className={styles.groupTitle}>{group}</h3>
              <div className={styles.list}>
                {items.map((item) => {
                  const formatted = formatKey(bindings[item.id]);
                  const parts = formatted.split(' + ');
                  return (
                    <div key={item.id} className={styles.row}>
                      <div className={styles.keys}>
                        {parts.map((k, i) => (
                          <span key={i}>
                            {i > 0 ? <span className={styles.plus}>+</span> : null}
                            <kbd className={styles.kbd}>{k}</kbd>
                          </span>
                        ))}
                      </div>
                      <span className={styles.label}>{item.label}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {filteredStatic.map((g) => (
            <section key={g.title} className={styles.group}>
              <h3 className={styles.groupTitle}>{g.title}</h3>
              <div className={styles.list}>
                {g.items.map((item, idx) => (
                  <div key={idx} className={styles.row}>
                    <div className={styles.keys}>
                      {item.keys.map((k, i) => (
                        <span key={i}>
                          {i > 0 ? <span className={styles.plus}>+</span> : null}
                          <kbd className={styles.kbd}>{k}</kbd>
                        </span>
                      ))}
                    </div>
                    <span className={styles.label}>{item.label}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
    </AccessibleDialog>
  );
}
