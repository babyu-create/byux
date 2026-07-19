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
  FilePlus2,
} from 'lucide-react';
import { MediaLibrary } from './components/MediaLibrary/MediaLibrary';
import { Preview } from './components/Preview/Preview';
import { PropertiesPanel } from './components/Properties/PropertiesPanel';
import { WaveformPanel } from './components/Waveform/WaveformPanel';
import { Timeline } from './components/Timeline/Timeline';
import { Toast } from './components/Common/Toast';
import { Splitter } from './components/Common/Splitter';
import { UpdateBanner } from './components/Common/UpdateBanner';
import { AccessibleDialog } from './components/Common/AccessibleDialog';
import {
  UnsavedChangesDialog,
  type UnsavedChoice,
} from './components/Common/UnsavedChangesDialog';
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
  captureProjectSavedBaseline,
  isProjectDirty,
  markProjectSaved,
  markProjectUnsaved,
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
  const loadedIds = new Set(ms.assets.map((asset) => asset.id));
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
    hudPreset: ps.hudPreset,
    verticalReframe: ps.verticalReframe,
    // Preserve unresolved references as well as currently loaded media. Without
    // this, saving a project before every source has been relinked creates
    // dangling clip/marker IDs that the next load correctly rejects.
    assets: [
      ...ms.assets,
      ...ps.expectedAssets.filter(
        (expected) => !loadedIds.has(expected.id),
      ),
    ],
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
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectLoadingTitle, setProjectLoadingTitle] = useState(
    'プロジェクトを切り替えています',
  );
  const [documentBusy, setDocumentBusy] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [unsavedPrompt, setUnsavedPrompt] = useState<{
    action: string;
    resolve: (choice: UnsavedChoice) => void;
  } | null>(null);
  const [layout, setLayout] = useState<LayoutSizes>(() => loadLayout());
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [mediaLibraryCollapsed, setMediaLibraryCollapsed] = useState(() =>
    getBoolPref('media-library-collapsed', false),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recoveryCheckedRef = useRef(false);
  const documentOperationRef = useRef(false);
  const lastAutosaveGenerationRef = useRef<string | null>(null);

  const beginDocumentOperation = useCallback((
    showLoading: boolean,
    loadingTitle = 'プロジェクトを切り替えています',
  ) => {
    if (documentOperationRef.current) return false;
    documentOperationRef.current = true;
    setDocumentBusy(true);
    if (showLoading) {
      setProjectLoadingTitle(loadingTitle);
      setProjectLoading(true);
    }
    return true;
  }, []);

  const endDocumentOperation = useCallback(() => {
    documentOperationRef.current = false;
    setDocumentBusy(false);
    setProjectLoading(false);
  }, []);

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
  const projectName = useProjectStore((s) => s.name);
  const setProjectName = useProjectStore((s) => s.setName);

  // Keep the main process informed so it can warn before quitting with
  // unsaved edits (see electron/main.cjs `close` handler). `window.fce` is
  // absent when running as a plain web build, so this is a no-op there.
  useEffect(() => {
    let previousInputs: unknown[] = [];
    let lastDirty: boolean | null = null;
    const notify = (force = false) => {
      const project = useProjectStore.getState();
      const media = useMediaStore.getState();
      const inputs = [
        project.name,
        project.aspectRatio,
        project.fps,
        project.resolution,
        project.tracks,
        project.clips,
        project.markers,
        project.ioRanges,
        project.preRollSec,
        project.postRollSec,
        project.audioDucking,
        project.hudPreset,
        project.verticalReframe,
        project.savedDocument,
        project.savedAssetsFingerprint,
        media.assets,
      ];
      if (
        !force &&
        inputs.length === previousInputs.length &&
        inputs.every((input, index) => input === previousInputs[index])
      ) {
        return;
      }
      previousInputs = inputs;
      const dirty = isProjectDirty();
      if (dirty === lastDirty) return;
      lastDirty = dirty;
      window.fce?.setDirty?.(dirty);
    };
    notify(true);
    const offProject = useProjectStore.subscribe(() => notify());
    const offMedia = useMediaStore.subscribe(() => notify());
    return () => {
      offProject();
      offMedia();
    };
  }, []);

  const refreshRecentProjects = useCallback(async () => {
    try {
      const entries = await window.fce?.project?.listRecent();
      if (entries) setRecentProjects(entries);
    } catch {
      // Recent metadata is convenience-only; project save/open paths remain
      // authoritative even if this list cannot be refreshed.
    }
  }, []);

  const applyProjectText = useCallback(async (
    text: string,
    sourcePath: string | null,
    options: { recovered?: boolean } = {},
  ) => {
    const ps = useProjectStore.getState();
    try {
      const project = parseProjectFile(text);
      // A native project owns its media session. Release every Blob URL and
      // source token from the previous project before matching/relinking so a
      // same-name/same-size file from project A cannot leak into project B.
      if (window.fce?.isElectron) useMediaStore.getState().clearAssets();
      const ms = useMediaStore.getState();
      const { idMap, missingAssetIds } = buildAssetIdMap(project.assets, ms.assets);
      ps.loadProject(project, idMap);
      clearHistory(); // a freshly loaded project is the new baseline
      setCurrentProjectPath(sourcePath);

      if (missingAssetIds.length === 0) {
        ps.remapAssetIds(idMap);
        if (options.recovered) markProjectUnsaved();
        else markProjectSaved();
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
      if (options.recovered) markProjectUnsaved();
      else markProjectSaved();
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

  const persistAutosave = useCallback(async (text: string) => {
    const autosave = window.fce?.project?.autosave;
    if (!autosave) return true;
    try {
      const result = await autosave(text);
      if (result.ok) {
        if (result.generation) lastAutosaveGenerationRef.current = result.generation;
        return true;
      }
      if (!result.stale) {
        useProjectStore
          .getState()
          .showMessage('error', `自動保存できません: ${result.error ?? '保存先を確認してください'}`, 6000);
      }
    } catch {
      useProjectStore
        .getState()
        .showMessage('error', '自動保存できません。空き容量と保存先を確認してください', 6000);
    }
    return false;
  }, []);

  const handleSaveProject = useCallback(async (saveAs = false, blockEditing = false) => {
    const ps = useProjectStore.getState();
    if (!beginDocumentOperation(blockEditing, '変更を保存しています')) {
      ps.showMessage('info', '別のプロジェクト操作が完了するまでお待ちください');
      return false;
    }
    try {
      const project = createProjectSnapshot();
      const savedBaseline = captureProjectSavedBaseline();
      const savedText = JSON.stringify(project, null, 2);
      const autosaveGenerationAtSaveStart = lastAutosaveGenerationRef.current;
      try {
        // Refuse to put a document on disk if any reachable editor action has
        // violated the same invariants enforced on load.
        parseProjectFile(savedText);
      } catch (error) {
        ps.showMessage(
          'error',
          error instanceof Error ? error.message : 'プロジェクトの整合性確認に失敗しました',
          6000,
        );
        return false;
      }
      const nativeProject = window.fce?.project;
      if (!nativeProject) {
        downloadProjectFile(project);
        markProjectSaved(savedBaseline);
        ps.showMessage('success', 'プロジェクト保存');
        return true;
      }

      const result = await nativeProject.save({
        text: savedText,
        suggestedName: project.name || 'project',
        saveAs,
      });
      if (!result.ok) {
        if (!result.stale) ps.showMessage('error', result.error ?? '保存に失敗しました', 4000);
        return false;
      }
      if (result.canceled || !result.path || !result.sessionId) return false;
      setCurrentProjectPath(result.path);
      markProjectSaved(savedBaseline);
      let recoveryRetained = false;
      if (isProjectDirty()) {
        // Persist edits made while the native dialog/disk write was in flight
        // immediately; waiting for the periodic timer leaves a crash-loss gap.
        const durable = await persistAutosave(JSON.stringify(createProjectSnapshot()));
        if (!durable) {
          ps.showMessage(
            'error',
            '保存開始時点までは保存しましたが、その後の変更を自動保存できませんでした',
            7000,
          );
          await refreshRecentProjects();
          return false;
        }
      } else {
        const committed = await nativeProject.commitSave(
          savedText,
          autosaveGenerationAtSaveStart,
          result.sessionId,
        );
        if (committed) {
          lastAutosaveGenerationRef.current = null;
        } else {
          recoveryRetained = true;
        }
      }
      await refreshRecentProjects();
      const warning =
        result.warning ??
        (recoveryRetained
          ? 'プロジェクトは保存しました。安全のため自動保存データも保持しています'
          : null);
      ps.showMessage(
        warning ? 'info' : 'success',
        warning ??
          (saveAs ? '別名で保存しました' : 'プロジェクトを保存しました'),
        warning ? 5000 : 2500,
      );
      return !isProjectDirty();
    } catch (error) {
      ps.showMessage(
        'error',
        error instanceof Error ? error.message : '保存に失敗しました',
        6000,
      );
      return false;
    } finally {
      endDocumentOperation();
    }
  }, [beginDocumentOperation, endDocumentOperation, persistAutosave, refreshRecentProjects]);

  const confirmDiscardChanges = async (action: string) => {
    if (!isProjectDirty()) return true;
    const choice = await new Promise<UnsavedChoice>((resolve) => {
      setUnsavedPrompt({ action, resolve });
    });
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;
    const savedCleanly = await handleSaveProject(false, true);
    if (!savedCleanly && isProjectDirty()) {
      useProjectStore
        .getState()
        .showMessage('info', '未保存の変更が残っているため、プロジェクト操作を中止しました', 5000);
    }
    return savedCleanly;
  };

  useEffect(() => {
    const subscribe = window.fce?.onSaveBeforeClose;
    const complete = window.fce?.completeSaveBeforeClose;
    if (!subscribe || !complete) return;
    return subscribe((id) => {
      if (useMediaStore.getState().isImporting) {
        useProjectStore
          .getState()
          .showMessage('info', 'メディアの読み込み完了後に、もう一度終了してください', 6000);
        complete(id, false);
        return;
      }
      void handleSaveProject(false, true).then((success) => {
        complete(id, success && !isProjectDirty());
      });
    });
  }, [handleSaveProject]);

  const handleNewProject = async () => {
    const ps = useProjectStore.getState();
    if (!(await confirmDiscardChanges('新しいプロジェクトを作成'))) return;
    if (!beginDocumentOperation(true)) {
      ps.showMessage('info', '別のプロジェクト操作が完了するまでお待ちください');
      return;
    }
    try {
      const newSession = window.fce?.project?.newSession;
      if (newSession && !(await newSession())) {
        ps.showMessage(
          'error',
          '自動保存データを破棄できなかったため、新規作成を中止しました',
          7000,
        );
        return;
      }
      useMediaStore.getState().clearAssets();
      ps.resetProject();
      clearHistory();
      markProjectSaved();
      lastAutosaveGenerationRef.current = null;
      setCurrentProjectPath(null);
      ps.showMessage('success', '新しいプロジェクトを作成しました');
    } catch (error) {
      ps.showMessage(
        'error',
        error instanceof Error ? error.message : '新しいプロジェクトを開始できませんでした',
        6000,
      );
    } finally {
      endDocumentOperation();
    }
  };

  useEffect(() => {
    let frame = 0;
    const updateViewport = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setViewport({ width: window.innerWidth, height: window.innerHeight });
      });
    };
    window.addEventListener('resize', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const handleLoadClick = async () => {
    const ps = useProjectStore.getState();
    const nativeProject = window.fce?.project;
    // The web fallback cannot choose a file until after the hidden input
    // fires, so it confirms in handleLoadFile. Electron confirms here before
    // opening its native dialog.
    if (nativeProject && !(await confirmDiscardChanges('別のプロジェクトを開く'))) return;
    if (!beginDocumentOperation(Boolean(nativeProject))) {
      ps.showMessage('info', '別のプロジェクト操作が完了するまでお待ちください');
      return;
    }
    try {
      if (!nativeProject) {
        fileInputRef.current?.click();
        return;
      }
      const result = await nativeProject.openDialog();
      if (!result.ok) {
        ps.showMessage('error', result.error ?? 'ロードに失敗しました', 4000);
        return;
      }
      if (result.canceled || !result.text) return;
      if (await applyProjectText(result.text, result.path ?? null)) {
        if (result.path && !(await nativeProject.confirmOpen(result.path))) {
          await nativeProject.newSession(true);
          setCurrentProjectPath(null);
          lastAutosaveGenerationRef.current = null;
          markProjectUnsaved();
          ps.showMessage(
            'error',
            'プロジェクト切替の確定に失敗しました。内容を守るため別名保存に切り替えました',
            7000,
          );
          return;
        }
        lastAutosaveGenerationRef.current = null;
        await refreshRecentProjects();
      }
    } catch (error) {
      ps.showMessage(
        'error',
        error instanceof Error ? error.message : 'ロードに失敗しました',
        6000,
      );
    } finally {
      endDocumentOperation();
    }
  };

  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!(await confirmDiscardChanges('別のプロジェクトを開く'))) return;
    if (!beginDocumentOperation(true)) {
      useProjectStore.getState().showMessage('info', '別のプロジェクト操作が完了するまでお待ちください');
      return;
    }
    try {
      await applyProjectText(await file.text(), null);
    } catch (error) {
      useProjectStore
        .getState()
        .showMessage('error', error instanceof Error ? error.message : 'ロードに失敗しました', 6000);
    } finally {
      endDocumentOperation();
    }
  };

  const handleOpenRecent = async (project: RecentProject) => {
    const ps = useProjectStore.getState();
    setRecentOpen(false);
    if (!(await confirmDiscardChanges('最近使ったプロジェクトを開く'))) {
      setRecentOpen(true);
      return;
    }
    if (!beginDocumentOperation(true)) {
      ps.showMessage('info', '別のプロジェクト操作が完了するまでお待ちください');
      return;
    }
    try {
      const result = await window.fce?.project?.openRecent(project.path);
      if (!result?.ok) {
        ps.showMessage('error', result?.error ?? 'プロジェクトを開けませんでした', 4000);
        await refreshRecentProjects();
        return;
      }
      if (result.text && (await applyProjectText(result.text, result.path ?? null))) {
        if (result.path && !(await window.fce?.project?.confirmOpen(result.path))) {
          await window.fce?.project?.newSession(true);
          setCurrentProjectPath(null);
          lastAutosaveGenerationRef.current = null;
          markProjectUnsaved();
          ps.showMessage(
            'error',
            'プロジェクト切替の確定に失敗しました。内容を守るため別名保存に切り替えました',
            7000,
          );
          return;
        }
        lastAutosaveGenerationRef.current = null;
        await refreshRecentProjects();
      }
    } catch (error) {
      ps.showMessage(
        'error',
        error instanceof Error ? error.message : 'プロジェクトを開けませんでした',
        6000,
      );
    } finally {
      endDocumentOperation();
    }
  };

  const handleRemoveRecent = async (project: RecentProject) => {
    try {
      await window.fce?.project?.removeRecent(project.path);
      await refreshRecentProjects();
    } catch {
      useProjectStore.getState().showMessage('error', '履歴を更新できませんでした', 4000);
    }
  };

  // Recover a crash/autosave before the user starts editing. The restored
  // document deliberately remains dirty until the user explicitly saves it.
  useEffect(() => {
    if (recoveryCheckedRef.current) return;
    recoveryCheckedRef.current = true;
    void (async () => {
      if (!beginDocumentOperation(true)) return;
      try {
        await refreshRecentProjects();
        const result = await window.fce?.project?.checkRecovery();
        if (result && !result.ok) {
          useProjectStore
            .getState()
            .showMessage(
              'error',
              result.error ?? '自動保存データを安全に確認できませんでした',
              7000,
            );
        } else if (result?.ok && result.recovered) {
          const applied = await applyProjectText(result.text, result.path, { recovered: true });
          if (applied) {
            const confirmed = await window.fce?.project?.confirmRecovery(result.recoveryId);
            if (confirmed) {
              lastAutosaveGenerationRef.current = result.generation;
            } else {
              useProjectStore
                .getState()
                .showMessage('error', '復元状態の確定に失敗しました。念のため別名で保存してください。', 6000);
            }
          }
        }
      } catch (error) {
        useProjectStore
          .getState()
          .showMessage(
            'error',
            error instanceof Error ? error.message : '自動保存の復元確認に失敗しました',
            6000,
          );
      } finally {
        endDocumentOperation();
      }
    })();
  }, [applyProjectText, beginDocumentOperation, endDocumentOperation, refreshRecentProjects]);

  // Persist lightweight project JSON while dirty. Media bytes stay on disk;
  // capturing current store state on each tick means edits made after the
  // first dirty transition are included without serialising on every drag.
  useEffect(() => {
    if (!isDirty || projectLoading || !window.fce?.project?.autosave) return;
    const run = async () => {
      await persistAutosave(JSON.stringify(createProjectSnapshot()));
    };
    const initial = window.setTimeout(() => void run(), 2000);
    const interval = window.setInterval(() => void run(), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [currentProjectPath, isDirty, persistAutosave, projectLoading]);

  useEffect(() => {
    const filename = currentProjectPath?.split(/[\\/]/).pop();
    const base = filename ? `${filename} — Byux` : `${projectName || 'untitled'} — Byux`;
    document.title = isDirty ? `● ${base}` : base;
  }, [currentProjectPath, isDirty, projectName]);

  // Global shortcuts: Ctrl+S, ?
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Saving is document-level and must remain available while naming the
      // project or adjusting a focused control. Undo/redo remain native inside
      // text inputs so users can still edit field contents normally.
      if (mod && key === 's') {
        e.preventDefault();
        void handleSaveProject(e.shiftKey);
        return;
      }
      const target = e.target instanceof Element ? e.target : null;
      if (
        target?.closest(
          'input, textarea, select, button, [contenteditable="true"], [role="button"], [role="slider"], [role="menuitem"]',
        )
      ) {
        return;
      }
      if (mod && key === 'z' && !e.shiftKey) {
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
    const projectState = useProjectStore.getState();
    const alreadyAssignedAssetIds = new Set([
      ...projectState.clips.map((clip) => clip.assetId),
      ...projectState.markers.map((marker) => marker.assetId),
      ...projectState.ioRanges.map((range) => range.assetId),
    ]);
    const availableByIdentity = new Map<string, typeof mediaAssets>();
    for (const asset of mediaAssets) {
      if (alreadyAssignedAssetIds.has(asset.id)) continue;
      const key = `${asset.kind}\0${asset.name}\0${asset.size}`;
      const bucket = availableByIdentity.get(key);
      if (bucket) bucket.push(asset);
      else availableByIdentity.set(key, [asset]);
    }
    for (const ref of expectedAssets) {
      const key = `${ref.kind}\0${ref.name}\0${ref.size}`;
      const match = availableByIdentity.get(key)?.shift();
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

  // Preserve the user's large-window preferences, but cap the rendered sizes
  // to keep a useful preview/workspace at the supported minimum window size.
  const responsiveSideMax = Math.max(220, (viewport.width - 376) / 2);
  const responsiveLeftMax = Math.min(LAYOUT_BOUNDS.leftWidth.max, responsiveSideMax);
  const responsiveRightMax = Math.min(LAYOUT_BOUNDS.rightWidth.max, responsiveSideMax);
  const renderedLeftWidth = Math.min(layout.leftWidth, responsiveLeftMax);
  const renderedRightWidth = Math.min(layout.rightWidth, responsiveRightMax);
  const responsiveTimelineMax = Math.max(
    LAYOUT_BOUNDS.timelineHeight.min,
    viewport.height - 48 - 260 - 8,
  );
  const renderedTimelineHeight = Math.min(layout.timelineHeight, responsiveTimelineMax);
  const workspaceHeight = Math.max(0, viewport.height - 48 - renderedTimelineHeight - 4);
  const responsivePropertiesMax = Math.min(
    LAYOUT_BOUNDS.propertiesHeight.max,
    Math.max(LAYOUT_BOUNDS.propertiesHeight.min, workspaceHeight - 160),
  );
  const renderedPropertiesHeight = Math.min(
    layout.propertiesHeight,
    responsivePropertiesMax,
  );

  const layoutVars: CssVars = {
    '--layout-left-w': mediaLibraryCollapsed
      ? `${MEDIA_LIBRARY_COLLAPSED_WIDTH}px`
      : `${renderedLeftWidth}px`,
    '--layout-right-w': `${renderedRightWidth}px`,
    '--layout-timeline-h': `${renderedTimelineHeight}px`,
    '--layout-properties-h': `${renderedPropertiesHeight}px`,
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
          <label className={styles.projectNameWrap}>
            <span className={styles.srOnly}>プロジェクト名</span>
            <input
              className={styles.projectNameInput}
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="プロジェクト名"
              spellCheck={false}
            />
            {isDirty ? <span className={styles.dirtyDot} title="未保存の変更" aria-label="未保存" /> : null}
          </label>
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
            onClick={() => void handleNewProject()}
            disabled={documentBusy}
            title="新しいプロジェクト"
            aria-label="新しいプロジェクト"
          >
            <FilePlus2 size={15} strokeWidth={2} aria-hidden="true" />
            <span>新規</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setHelpOpen(true)}
            title="ショートカット (?)"
            aria-label="ヘルプ"
          >
            <Keyboard size={15} strokeWidth={2} aria-hidden="true" />
            <span>ヘルプ</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setSettingsOpen(true)}
            title="ショートカット設定"
            aria-label="設定"
          >
            <Settings size={15} strokeWidth={2} aria-hidden="true" />
            <span>設定</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => void handleLoadClick()}
            disabled={documentBusy}
            aria-label="プロジェクトを開く"
            title="プロジェクトを開く"
          >
            <FolderOpen size={15} strokeWidth={2} aria-hidden="true" />
            <span>ロード</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setRecentOpen(true)}
            disabled={documentBusy}
            title="最近使ったプロジェクト"
            aria-label="最近使ったプロジェクト"
          >
            <History size={15} strokeWidth={2} aria-hidden="true" />
            <span>最近</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => void handleSaveProject(false)}
            disabled={documentBusy}
            title="保存 (Ctrl+S)"
            aria-label="保存"
          >
            <Save size={15} strokeWidth={2} aria-hidden="true" />
            <span>保存</span>
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => void handleSaveProject(true)}
            disabled={documentBusy}
            title="名前を付けて保存 (Ctrl+Shift+S)"
            aria-label="名前を付けて保存"
          >
            <SaveAll size={15} strokeWidth={2} aria-hidden="true" />
            <span>別名保存</span>
          </button>
          <button
            type="button"
            className={styles.exportBtn}
            onClick={() => setExportOpen(true)}
            disabled={!hasVideoClips}
            aria-label="動画を書き出す"
          >
            <Download size={15} strokeWidth={2.2} aria-hidden="true" />
            <span>書き出し</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleLoadFile}
            aria-label="プロジェクトファイルを選択"
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
            busy={documentBusy}
            onOpen={(project) => void handleOpenRecent(project)}
            onRemove={(project) => void handleRemoveRecent(project)}
            onClose={() => setRecentOpen(false)}
          />
        ) : null}
      </Suspense>

      {unsavedPrompt ? (
        <UnsavedChangesDialog
          action={unsavedPrompt.action}
          onChoose={(choice) => {
            const prompt = unsavedPrompt;
            setUnsavedPrompt(null);
            prompt.resolve(choice);
          }}
        />
      ) : null}

      {projectLoading ? (
        <AccessibleDialog
          backdropClassName={styles.loadingBackdrop}
          dialogClassName={styles.loadingCard}
          titleId="project-loading-title"
          onClose={() => {}}
          dismissible={false}
        >
          <div className={styles.loadingSpinner} aria-hidden="true" />
          <div id="project-loading-title" className={styles.loadingTitle}>
            {projectLoadingTitle}
          </div>
          <div className={styles.loadingText} role="status" aria-live="polite">
            安全に処理しています。完了するまでお待ちください…
          </div>
        </AccessibleDialog>
      ) : null}

      <main className={styles.workspace}>
        <section className={styles.panelLeft}>
          <MediaLibrary
            collapsed={mediaLibraryCollapsed}
            onToggleCollapse={toggleMediaLibraryCollapsed}
          />
        </section>
        <Splitter
          orientation="vertical"
          value={renderedLeftWidth}
          min={LAYOUT_BOUNDS.leftWidth.min}
          max={responsiveLeftMax}
          onResize={(v) => updateLayout('leftWidth', v)}
          ariaLabel="メディアライブラリの幅"
        />
        <section className={styles.panelCenter}>
          <Preview />
        </section>
        <Splitter
          orientation="vertical"
          value={renderedRightWidth}
          min={LAYOUT_BOUNDS.rightWidth.min}
          max={responsiveRightMax}
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
            value={renderedPropertiesHeight}
            min={LAYOUT_BOUNDS.propertiesHeight.min}
            max={responsivePropertiesMax}
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
        value={renderedTimelineHeight}
        min={LAYOUT_BOUNDS.timelineHeight.min}
        max={responsiveTimelineMax}
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
