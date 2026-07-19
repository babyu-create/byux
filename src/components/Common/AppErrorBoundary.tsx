import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Clipboard, RefreshCw } from 'lucide-react';
import styles from './AppErrorBoundary.module.css';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] unrecoverable render error', error, info);
  }

  private copyDiagnostics = async (): Promise<void> => {
    const error = this.state.error;
    const diagnostic = [
      `Byux ${window.fce?.appVersion ?? 'web'}`,
      navigator.userAgent,
      error?.name ?? 'Error',
      error?.message ?? 'Unknown renderer error',
    ].join('\n');
    await navigator.clipboard.writeText(diagnostic).catch(() => {});
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className={styles.root}>
        <section className={styles.card} role="alert">
          <AlertTriangle className={styles.icon} size={32} aria-hidden="true" />
          <h1>編集画面で問題が発生しました</h1>
          <p>
            自動保存データは保持されています。再読み込み後、復元の案内が表示されたら
            「復元する」を選んでください。
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => void this.copyDiagnostics()}>
              <Clipboard size={16} aria-hidden="true" />
              診断情報をコピー
            </button>
            <button type="button" className={styles.primary} onClick={() => window.location.reload()}>
              <RefreshCw size={16} aria-hidden="true" />
              再読み込み
            </button>
          </div>
        </section>
      </main>
    );
  }
}
