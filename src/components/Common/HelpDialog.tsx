import { useEffect, useState } from 'react';
import {
  ACTIONS,
  formatKey,
  getBindings,
  subscribeBindings,
} from '../../lib/keybindings';
import styles from './HelpDialog.module.css';

interface HelpDialogProps {
  onClose: () => void;
}

const STATIC_GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: 'プロジェクト',
    items: [
      { keys: ['Ctrl', 'S'], label: 'プロジェクト保存' },
      { keys: ['?'], label: 'このヘルプを表示' },
    ],
  },
];

export function HelpDialog({ onClose }: HelpDialogProps) {
  const [bindings, setBindings] = useState(() => getBindings());
  useEffect(() => subscribeBindings(() => setBindings({ ...getBindings() })), []);

  // Group dynamic actions by their group name
  const grouped = ACTIONS.reduce<Record<string, typeof ACTIONS>>((acc, a) => {
    if (!acc[a.group]) acc[a.group] = [];
    acc[a.group].push(a);
    return acc;
  }, {});

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>⌨ ショートカット</span>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <div className={styles.body}>
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
          {STATIC_GROUPS.map((g) => (
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
      </div>
    </div>
  );
}
