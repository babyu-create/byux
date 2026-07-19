import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Settings,
  FolderOpen,
  Save,
  SaveAll,
  History,
  Download,
  Undo2,
  Redo2,
} from 'lucide-react';
import { MediaLibrary } from './components/MediaLibrary/MediaLibrary';
import { Preview } from './components/Preview/Preview';
import { PropertiesPanel } from './components/Properties/PropertiesPanel';
import { WaveformPanel } from './components/Waveform/WaveformPanel';
import { Timeline } from './components/Timeline/Timeline';
import { Toast } from './components/Common/Toast';
import { Splitter } from './components/Common/Splitter';
import { UpdateBanner } from './components/Common/UpdateBanner';
import type { RecentProject } from './components/Common/UpdateBanner';

const HelpDialog = lazy(() =>
  import('./components/Common/HelpDialog').then((m) => ({ default: m.HelpDialog })),
);
const SettingsDialog = lazy(() =>
  import('./components/Common/SettingsDialog').then((m) => ({ default: m.SettingsDialog })),
);
const ExportDialog = lazy(() =>
  import('./components/Export/ExportDialog').then((m) => ({ default: m.ExportDialog })),
);
const RecentProjectsDialog = lazy(() =>
  import('./components/Common/RecentProjectsDialog').then((m) => ({
    default: m.RecentProjectsDialog,
  })),
);
import {
  useProjectStore,
  undo,
  redo,
  useCanUndo,
  useCanRedo,
  clearHistory,
  markProjectSaved,
  useIsDirty,
} from './stores/projectStore';
import { useMediaStore } from './stores/mediaStore';
import {
  buildAssetIdMap,
  downloadProjectFile,
  parseProjectFile,
  serialiseProject,
  type ProjectAssetRef,
} from './lib/project';
import {
  LAYOUT_BOUNDS,
  clampSize,
  loadLayout,
  saveLayout,
  type LayoutSizes,
} from './lib/layout';
import { getBoolPref, setBoolPref } from './lib/preferences';
import styles from './App.module.css';

const MEDIA_LIBRARY_COLLAPSED_WIDTH = 40;

type CssVars = React.CSSProperties & Record<`--${string}`, string>;

function createProjectSnapshot() {
  const ps = useProjectStore.getState();
  const ms = useMediaStore.getState();
  return serialiseProject({
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
}

// Registers saved source paths with the main process and restores lightweight
// streaming assets. No source bytes cross IPC merely to open a project.
async function relinkFromDisk(
  refs: ProjectAssetRef[],
): Promise<{ recovered: number; idMap: Record<string, string> }> {
  const registerFile = window.fce?.registerMediaFile;
  if (!registerFile) return { recovered: 0, idMap: {} };
  let recovered = 0;
  const idMap: Record<string, string> = {};
  for (const ref of refs) {
    if (!ref.path) continue;
    try {
      const source = await registerFile({
        path: ref.path,
        name: ref.name,
        size: ref.size,
        kind: ref.kind,
      });
      if (!source) continue;
      const asset = useMediaStore.getState().addRecoveredAsset(ref, source);
      idMap[ref.id] = asset.id;
      recovered += 1;
    } catch {
      // leave unmatched — falls through to the manual "add file" message
    }
  }
  return { recovered, idMap };
}

function App() {
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutSizes>(() => loadLayout());
  const [mediaLibraryCollapsed, setMediaLibraryCollapsed] = useState(() =>
    getBoolPref('media-library-collapsed', false),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recoveryCheckedRef = useRef(false);

  const toggleMediaLibraryCollapsed = () => {
    setMediaLibraryCollapsed((prev) => {
      const next = !prev;
      setBoolPref('media-library-collapsed', next);
      return next;
    });
  };

  const updateLayout = <K extends keyof LayoutSizes>(key: K, value: number) => {
    setLayout((prev) => {
      const next = { ...prev, [key]: clampSize(key, value) };
      saveLayout(next);
      return next;
    });
  };

  const hasVideoClips = useProjectStore((s) => {
    const mainVideo = s.tracks.find((track) => track.kind === 'video');
    return !!mainVideo && !mainVideo.hidden && s.clips.some((clip) => clip.trackId === mainVideo.id);
  });
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const isDirty = useIsDirty();

  // Keep the main process informed so it can warn before quitting with
  // unsaved edits (see electron/main.cjs `close` handler). `window.fce` is
  // absent when running as a plain web build, so this is a no-op there.
  useEffect(() => {
    window.fce?.setDirty?.(isDirty);
  }, [isDirty]);

  const refreshRecentProjects = useCallback(async () => {
    const entries = await window.fce?.project?.listRecent();
    if (entries) setRecentProjects(entries);
  }, []);

  const applyProjectText = useCallback(async (
    text: string,
    sourcePath: string | null,
    options: { recovered?: boolean } = {},
  ) => {
    const ps = useProjectStore.getState();
    try {
      const project = parseProjectFile(text);
      const ms = useMediaStore.getState();
      const { idMap, missingAssetIds } = buildAssetIdMap(project.assets, ms.assets);
      ps.loadProject(project, idMap);
      clearHistory(); // a freshly loaded project is the new baseline
      setCurrentProjectPath(sourcePath);

      if (missingAssetIds.length === 0) {
        ps.remapAssetIds(idMap);
        if (!options.recovered) markProjectSaved();
        ps.showMessage(
          options.recovered ? 'info' : 'success',
          options.recovered
            ? '自動保存からプロジェクトを復元しました。保存して内容を確定してください。'
            : 'プロジェクトをロードしました',
          options.recovered ? 5000 : 2500,
        );
        return true;
      }

      const missingRefs = project.assets.filter((a) => missingAssetIds.includes(a.id));
      const { recovered, idMap: recoveredIdMap } = await relinkFromDisk(
        missingRefs.filter((a) => a.path),
      );
      // Relinking changes only runtime asset IDs. Apply it before establishing
      // the clean baseline so opening a project never appears as a user edit.
      ps.remapAssetIds({ ...idMap, ...recoveredIdMap });
      if (!options.recovered) markProjectSaved();
      const stillMissing = missingRefs.length - recovered;
      if (recovered > 0 && stillMissing > 0) {
        ps.showMessage(
          'info',
          `${recovered}個のメディアをディスクから自動復元、${stillMissing}個は見つかりません — 同名・同サイズのファイルを追加してください`,
          5000,
        );
      } else if (recovered > 0) {
        ps.showMessage(
          'success',
          `プロジェクトをロードしました（${recovered}個のメディアをディスクから自動復元）`,
          4000,
        );
      } else {
        ps.showMessage(
          'info',
          `ロード完了 (${stillMissing}個のメディア未マッチ — 同名・同サイズのファイルを追加してください)`,
          5000,
        );
      }
      return true;
    } catch (err) {
      ps.showMessage(
        'error',
        err instanceof Error ? err.message : 'ロードに失敗しました',
        4000,
      );
      return false;
    }
  }, []);

  const handleSaveProject = useCallback(async (saveAs = false) => {
    const ps = useProjectStore.getState();
    const ms = useMediaStore.getState();
    if (ps.clips.length === 0 && ms.assets.length === 0) {
      ps.showMessage('info', '保存するクリップがありません');
      return;
    }

    const project = createProjectSnapshot();
    const nativeProject = window.fce?.project;
    if (!nativeProject) {
      downloadProjectFile(project);
      markProjectSaved();
      ps.showMessage('success', 'プロジェクト保存');
      return;
    }

    const result = await nativeProject.save({
      text: JSON.stringify(project, null, 2),
      suggestedName: project.name || 'project',
      saveAs,
    });
    if (!result.ok) {
      ps.showMessage('error', result.error ?? '保存に失敗しました', 4000);
      return;
    }
    if (result.canceled || !result.path) return;
    setCurrentProjectPath(result.path);
    markProjectSaved();
    await refreshRecentProjects();
    ps.showMessage('success', saveAs ? '別名で保存しました' : 'プロジェクトを保存しました');
  }, [refreshRecentProjects]);

  const confirmDiscardChanges = () =>
    !isDirty ||
    window.confirm('未保存の変更があります。保存せずに別のプロジェクトを開きますか？');

  const handleLoadClick = async () => {
    if (!confirmDiscardChanges()) return;
    const nativeProject = window.fce?.project;
    if (!nativeProject) {
      fileInputRef.current?.click();
      return;
    }
    const result = await nativeProject.openDialog();
    if (!result.ok) {
      useProjectStore
        .getState()
        .showMessage('error', result.error ?? 'ロードに失敗しました', 4000);
      return;
    }
    if (result.canceled || !result.text) return;
    if (await applyProjectText(result.text, result.path ?? null)) {
      if (result.path) await nativeProject.confirmOpen(result.path);
      await refreshRecentProjects();
    }
  };

  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await applyProjectText(await file.text(), null);
  };

  const handleOpenRecent = async (project: RecentProject) => {
    if (!confirmDiscardChanges()) return;
    const result = await window.fce?.project?.openRecent(project.path);
    if (!result?.ok) {
      useProjectStore
        .getState()
        .showMessage('error', result?.error ?? 'プロジェクトを開けませんでした', 4000);
      await refreshRecentProjects();
      return;
    }
    if (result.text && (await applyProjectText(result.text, result.path ?? null))) {
      if (result.path) await window.fce?.project?.confirmOpen(result.path);
      setRecentOpen(false);
      await refreshRecentProjects();
    }
  };

  const handleRemoveRecent = async (project: RecentProject) => {
    await window.fce?.project?.removeRecent(project.path);
    await refreshRecentProjects();
  };

  // Recover a crash/autosave before the user starts editing. The restored
  // document deliberately remains dirty until the user explicitly saves it.
  useEffect(() => {
    if (recoveryCheckedRef.current) return;
    recoveryCheckedRef.current = true;
    void (async () => {
      await refreshRecentProjects();
      const result = await window.fce?.project?.checkRecovery();
      if (result?.ok && result.recovered) {
        await applyProjectText(result.text, result.path, { recovered: true });
      }
    })();
  }, [applyProjectText, refreshRecentProjects]);

  // Persist lightweight project JSON while dirty. Media bytes stay on disk;
  // capturing current store state on each tick means edits made after the
  // first dirty transition are included without serialising on every drag.
  useEffect(() => {
    const autosave = window.fce?.project?.autosave;
    if (!isDirty || !autosave) return;
    const run = () => {
      const project = createProjectSnapshot();
      void autosave(JSON.stringify(project));
    };
    const initial = window.setTimeout(run, 2000);
    const interval = window.setInterval(run, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [isDirty, currentProjectPath]);

  useEffect(() => {
    const filename = currentProjectPath?.split(/[\\/]/).pop();
    document.title = filename ? `${filename} — Byux` : 'Byux';
  }, [currentProjectPath]);

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
        void handleSaveProject(e.shiftKey);
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
  }, [handleSaveProject]);

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
        (a) => a.name === ref.name && a.size === ref.size,
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
    '--layout-left-w': mediaLibraryCollapsed
      ? `${MEDIA_LIBRARY_COLLAPSED_WIDTH}px`
      : `${layout.leftWidth}px`,
    '--layout-right-w': `${layout.rightWidth}px`,
    '--layout-timeline-h': `${layout.timelineHeight}px`,
    '--layout-properties-h': `${layout.propertiesHeight}px`,
  };

  return (
    <div className={styles.app} style={layoutVars}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <img
            src={`${import.meta.env.BASE_URL}icon.png`}
            className={styles.logoMark}
            alt=""
            aria-hidden="true"
          />
          <span className={styles.logoText}>Byux</span>
          {window.fce?.appVersion ? (
            <span className={styles.versionTag}>v{window.fce.appVersion}</span>
          ) : null}
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
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => void handleLoadClick()}
          >
            <FolderOpen size={15} strokeWidth={2} aria-hidden="true" />
            <span>ロード</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setRecentOpen(true)}
            title="最近使ったプロジェクト"
          >
            <History size={15} strokeWidth={2} aria-hidden="true" />
            <span>最近</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => void handleSaveProject(false)}
            title="保存 (Ctrl+S)"
          >
            <Save size={15} strokeWidth={2} aria-hidden="true" />
            <span>保存</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => void handleSaveProject(true)}
            title="名前を付けて保存 (Ctrl+Shift+S)"
          >
            <SaveAll size={15} strokeWidth={2} aria-hidden="true" />
            <span>別名保存</span>
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
        {recentOpen ? (
          <RecentProjectsDialog
            projects={recentProjects}
            onOpen={(project) => void handleOpenRecent(project)}
            onRemove={(project) => void handleRemoveRecent(project)}
            onClose={() => setRecentOpen(false)}
          />
        ) : null}
      </Suspense>

      <main className={styles.workspace}>
        <section className={styles.panelLeft}>
          <MediaLibrary
            collapsed={mediaLibraryCollapsed}
            onToggleCollapse={toggleMediaLibraryCollapsed}
          />
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
