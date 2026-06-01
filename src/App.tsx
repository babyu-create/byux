import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Keyboard, Settings, FolderOpen, Save, Download, Undo2, Redo2 } from 'lucide-react';
import { MediaLibrary } from './components/MediaLibrary/MediaLibrary';
import { Preview } from './components/Preview/Preview';
import { PropertiesPanel } from './components/Properties/PropertiesPanel';
import { WaveformPanel } from './components/Waveform/WaveformPanel';
import { Timeline } from './components/Timeline/Timeline';
import { Toast } from './components/Common/Toast';
import { Splitter } from './components/Common/Splitter';
import { UpdateBanner } from './components/Common/UpdateBanner';

const HelpDialog = lazy(() =>
  import('./components/Common/HelpDialog').then((m) => ({ default: m.HelpDialog })),
);
const SettingsDialog = lazy(() =>
  import('./components/Common/SettingsDialog').then((m) => ({ default: m.SettingsDialog })),
);
const ExportDialog = lazy(() =>
  import('./components/Export/ExportDialog').then((m) => ({ default: m.ExportDialog })),
);
import { useProjectStore, undo, redo, useCanUndo, useCanRedo, clearHistory } from './stores/projectStore';
import { useMediaStore } from './stores/mediaStore';
import {
  buildAssetIdMap,
  downloadProjectFile,
  parseProjectFile,
  serialiseProject,
} from './lib/project';
import {
  LAYOUT_BOUNDS,
  clampSize,
  loadLayout,
  saveLayout,
  type LayoutSizes,
} from './lib/layout';
import styles from './App.module.css';

type CssVars = React.CSSProperties & Record<`--${string}`, string>;

function App() {
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layout, setLayout] = useState<LayoutSizes>(() => loadLayout());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateLayout = <K extends keyof LayoutSizes>(key: K, value: number) => {
    setLayout((prev) => {
      const next = { ...prev, [key]: clampSize(key, value) };
      saveLayout(next);
      return next;
    });
  };

  const hasVideoClips = useProjectStore((s) =>
    s.clips.some(
      (c) => s.tracks.find((t) => t.id === c.trackId)?.kind === 'video',
    ),
  );
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

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
      audioDucking: ps.audioDucking,
      assets: ms.assets,
    });
    downloadProjectFile(project);
    ps.showMessage('success', 'プロジェクト保存');
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
      clearHistory(); // a freshly loaded project is the new baseline
      if (missingAssetIds.length > 0) {
        ps.showMessage(
          'info',
          `ロード完了 (${missingAssetIds.length}個のメディア未マッチ — 同名・同サイズのファイルを追加してください)`,
          5000,
        );
      } else {
        ps.showMessage('success', 'プロジェクトをロードしました');
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
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') {
        e.preventDefault();
        handleSaveProject();
      } else if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
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
        `${matched}個のメディアを自動再リンク`,
        2500,
      );
    }
  }, [mediaAssets, expectedAssets]);

  const layoutVars: CssVars = {
    '--layout-left-w': `${layout.leftWidth}px`,
    '--layout-right-w': `${layout.rightWidth}px`,
    '--layout-timeline-h': `${layout.timelineHeight}px`,
    '--layout-properties-h': `${layout.propertiesHeight}px`,
  };

  return (
    <div className={styles.app} style={layoutVars}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <img src="/icon.png" className={styles.logoMark} alt="" aria-hidden="true" />
          <span className={styles.logoText}>Byux</span>
          <span className={styles.versionTag}>v1.0</span>
        </div>
        <nav className={styles.headerNav}>
          <button
            type="button"
            className={styles.iconNavBtn}
            onClick={undo}
            disabled={!canUndo}
            title="元に戻す (Ctrl+Z)"
            aria-label="元に戻す"
          >
            <Undo2 size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconNavBtn}
            onClick={redo}
            disabled={!canRedo}
            title="やり直す (Ctrl+Shift+Z)"
            aria-label="やり直す"
          >
            <Redo2 size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <span className={styles.navDivider} aria-hidden="true" />
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setHelpOpen(true)}
            title="ショートカット (?)"
          >
            <Keyboard size={15} strokeWidth={2} aria-hidden="true" />
            <span>ヘルプ</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setSettingsOpen(true)}
            title="ショートカット設定"
          >
            <Settings size={15} strokeWidth={2} aria-hidden="true" />
            <span>設定</span>
          </button>
          <button type="button" className={styles.navBtn} onClick={handleLoadClick}>
            <FolderOpen size={15} strokeWidth={2} aria-hidden="true" />
            <span>ロード</span>
          </button>
          <button type="button" className={styles.navBtn} onClick={handleSaveProject}>
            <Save size={15} strokeWidth={2} aria-hidden="true" />
            <span>保存</span>
          </button>
          <button
            type="button"
            className={styles.exportBtn}
            onClick={() => setExportOpen(true)}
            disabled={!hasVideoClips}
          >
            <Download size={15} strokeWidth={2.2} aria-hidden="true" />
            <span>書き出し</span>
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

      <Suspense fallback={null}>
        {exportOpen ? <ExportDialog onClose={() => setExportOpen(false)} /> : null}
        {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
        {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      </Suspense>

      <main className={styles.workspace}>
        <section className={styles.panelLeft}>
          <MediaLibrary />
        </section>
        <Splitter
          orientation="vertical"
          value={layout.leftWidth}
          min={LAYOUT_BOUNDS.leftWidth.min}
          max={LAYOUT_BOUNDS.leftWidth.max}
          onResize={(v) => updateLayout('leftWidth', v)}
          ariaLabel="メディアライブラリの幅"
        />
        <section className={styles.panelCenter}>
          <Preview />
        </section>
        <Splitter
          orientation="vertical"
          value={layout.rightWidth}
          min={LAYOUT_BOUNDS.rightWidth.min}
          max={LAYOUT_BOUNDS.rightWidth.max}
          reverse
          onResize={(v) => updateLayout('rightWidth', v)}
          ariaLabel="プロパティ・波形パネルの幅"
        />
        <section className={styles.panelRight}>
          <div className={styles.panelRightProperties}>
            <PropertiesPanel />
          </div>
          <Splitter
            orientation="horizontal"
            value={layout.propertiesHeight}
            min={LAYOUT_BOUNDS.propertiesHeight.min}
            max={LAYOUT_BOUNDS.propertiesHeight.max}
            onResize={(v) => updateLayout('propertiesHeight', v)}
            ariaLabel="プロパティセクションの高さ"
          />
          <div className={styles.panelRightWaveform}>
            <WaveformPanel />
          </div>
        </section>
      </main>

      <Splitter
        orientation="horizontal"
        value={layout.timelineHeight}
        min={LAYOUT_BOUNDS.timelineHeight.min}
        max={LAYOUT_BOUNDS.timelineHeight.max}
        reverse
        onResize={(v) => updateLayout('timelineHeight', v)}
        ariaLabel="タイムラインの高さ"
      />
      <footer className={styles.timelineSection}>
        <Timeline />
      </footer>
      <Toast />
      <UpdateBanner />
    </div>
  );
}

export default App;
