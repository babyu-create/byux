import { useEffect, useRef, useState } from 'react';
import { MediaLibrary } from './components/MediaLibrary/MediaLibrary';
import { Preview } from './components/Preview/Preview';
import { PropertiesPanel } from './components/Properties/PropertiesPanel';
import { Timeline } from './components/Timeline/Timeline';
import { Toast } from './components/Common/Toast';
import { HelpDialog } from './components/Common/HelpDialog';
import { SettingsDialog } from './components/Common/SettingsDialog';
import { UpdateBanner } from './components/Common/UpdateBanner';
import { ExportDialog } from './components/Export/ExportDialog';
import { useProjectStore } from './stores/projectStore';
import { useMediaStore } from './stores/mediaStore';
import {
  buildAssetIdMap,
  downloadProjectFile,
  parseProjectFile,
  serialiseProject,
} from './lib/project';
import styles from './App.module.css';

function App() {
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasVideoClips = useProjectStore((s) =>
    s.clips.some(
      (c) => s.tracks.find((t) => t.id === c.trackId)?.kind === 'video',
    ),
  );

  const handleSaveProject = () => {
    const ps = useProjectStore.getState();
    const ms = useMediaStore.getState();
    if (ps.clips.length === 0 && ms.assets.length === 0) {
      ps.showMessage('info', '保存するクリップがありません');
      return;
    }
    const project = serialiseProject({
      name: ps.name,
      aspectRatio: ps.aspectRatio,
      fps: ps.fps,
      resolution: ps.resolution,
      tracks: ps.tracks,
      clips: ps.clips,
      markers: ps.markers,
      ioRanges: ps.ioRanges,
      preRollSec: ps.preRollSec,
      postRollSec: ps.postRollSec,
      assets: ms.assets,
    });
    downloadProjectFile(project);
    ps.showMessage('success', '💾 プロジェクト保存');
  };

  const handleLoadClick = () => {
    fileInputRef.current?.click();
  };

  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const ps = useProjectStore.getState();
    try {
      const text = await file.text();
      const project = parseProjectFile(text);
      const ms = useMediaStore.getState();
      const { idMap, missingAssetIds } = buildAssetIdMap(project.assets, ms.assets);
      ps.loadProject(project, idMap);
      if (missingAssetIds.length > 0) {
        ps.showMessage(
          'info',
          `📂 ロード完了 (${missingAssetIds.length}個のメディア未マッチ — 同名・同サイズのファイルを追加してください)`,
          5000,
        );
      } else {
        ps.showMessage('success', '📂 プロジェクトをロードしました');
      }
    } catch (err) {
      ps.showMessage(
        'error',
        err instanceof Error ? err.message : 'ロードに失敗しました',
        4000,
      );
    }
  };

  // Global shortcuts: Ctrl+S, ?
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSaveProject();
      } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-relink: when media library changes, try to match against any
  // expected (loaded but missing) assets and remap clips/markers/ranges.
  const mediaAssets = useMediaStore((s) => s.assets);
  const expectedAssets = useProjectStore((s) => s.expectedAssets);
  useEffect(() => {
    if (expectedAssets.length === 0) return;
    const idMap: Record<string, string> = {};
    let matched = 0;
    for (const ref of expectedAssets) {
      const match = mediaAssets.find(
        (a) => a.name === ref.name && a.file.size === ref.size,
      );
      if (match) {
        idMap[ref.id] = match.id;
        matched += 1;
      }
    }
    if (matched > 0) {
      useProjectStore.getState().remapAssetIds(idMap);
      const ps = useProjectStore.getState();
      ps.showMessage(
        'success',
        `🔗 ${matched}個のメディアを自動再リンク`,
        2500,
      );
    }
  }, [mediaAssets, expectedAssets]);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logoMark}>FCE</span>
          <span className={styles.logoText}>FPS Clip Editor</span>
          <span className={styles.versionTag}>v1.0</span>
        </div>
        <nav className={styles.headerNav}>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setHelpOpen(true)}
            title="ショートカット (?)"
          >
            ⌨ ヘルプ
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setSettingsOpen(true)}
            title="ショートカット設定"
          >
            ⚙ 設定
          </button>
          <button type="button" className={styles.navBtn} onClick={handleLoadClick}>
            📂 ロード
          </button>
          <button type="button" className={styles.navBtn} onClick={handleSaveProject}>
            💾 保存
          </button>
          <button
            type="button"
            className={styles.exportBtn}
            onClick={() => setExportOpen(true)}
            disabled={!hasVideoClips}
          >
            📦 書き出し
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleLoadFile}
            style={{ display: 'none' }}
          />
        </nav>
      </header>

      {exportOpen ? <ExportDialog onClose={() => setExportOpen(false)} /> : null}
      {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}

      <main className={styles.workspace}>
        <section className={styles.panelLeft}>
          <MediaLibrary />
        </section>
        <section className={styles.panelCenter}>
          <Preview />
        </section>
        <section className={styles.panelRight}>
          <PropertiesPanel />
        </section>
      </main>

      <footer className={styles.timelineSection}>
        <Timeline />
      </footer>
      <Toast />
      <UpdateBanner />
    </div>
  );
}

export default App;
