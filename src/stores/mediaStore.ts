import { create } from 'zustand';
import type { MediaAsset } from '../lib/types';
import {
  fileToMediaAsset,
  guessMimeType,
  isVideoFile,
  probeVideoUrlMetadata,
} from '../lib/media';
import { computeWaveform } from '../lib/audio';
import type { ProjectAssetRef } from '../lib/project';

interface MediaStoreState {
  assets: MediaAsset[];
  selectedAssetId: string | null;
  isImporting: boolean;
  importStatus: string | null;
  importError: string | null;
  /** Returns the assets actually created (skips unsupported files), so a
   *  caller like Track's drop handler can place clips for them immediately. */
  addFiles: (files: File[] | FileList) => Promise<MediaAsset[]>;
  addRecoveredAsset: (
    ref: ProjectAssetRef,
    source: { token: string; url: string; size: number },
  ) => Promise<MediaAsset>;
  removeAsset: (id: string) => void;
  clearAssets: () => void;
  selectAsset: (id: string | null) => void;
  clearError: () => void;
  setAssetBeats: (id: string, beats: number[]) => void;
  setAssetWaveform: (id: string, waveform: { peaks: Float32Array; peaksPerSecond: number }) => void;
}

function releaseAssetMediaTokens(asset: MediaAsset): void {
  const releaseMediaFile = window.fce?.releaseMediaFile;
  if (!releaseMediaFile) return;
  // Source and preview registrations normally differ, but de-duplicate
  // defensively so a reused/cached token is never released twice.
  const tokens = new Set(
    [asset.sourceToken, asset.previewSourceToken].filter(
      (token): token is string => Boolean(token),
    ),
  );
  for (const token of tokens) {
    try {
      void releaseMediaFile(token).catch(() => {
        // The main process also drops registrations at renderer shutdown.
      });
    } catch {
      // A tearing-down preload bridge may throw synchronously.
    }
  }
}

export const useMediaStore = create<MediaStoreState>((set, get) => ({
  assets: [],
  selectedAssetId: null,
  isImporting: false,
  importStatus: null,
  importError: null,

  addFiles: async (files) => {
    if (get().isImporting) return [];
    const list = Array.from(files);
    if (list.length === 0) return [];

    set({ isImporting: true, importStatus: '読み込み中…', importError: null });

    const errors: string[] = [];
    const newAssets: MediaAsset[] = [];

    // Process sequentially: compatibility transcoding is memory-heavy and the
    // shared FFmpeg instance must never receive overlapping commands.
    for (const file of list) {
      try {
        let asset: MediaAsset | null;
        try {
          if (
            window.fce?.isElectron &&
            /\.(?:avi|mkv)$/i.test(file.name) &&
            window.fce.createPreviewProxy
          ) {
            throw new Error('長尺対応の互換プレビューを作成します');
          }
          asset = await fileToMediaAsset(file);
        } catch (probeError) {
          if (!isVideoFile(file)) throw probeError;
          const { createPreviewProxy } = await import('../lib/exporter');
          const originalPath = window.fce?.getPathForFile?.(file) || undefined;
          const registerMediaFile = window.fce?.registerMediaFile;
          const createNativeProxy = window.fce?.createPreviewProxy;
          if (originalPath && registerMediaFile && createNativeProxy) {
            set({ importStatus: `${file.name} を長尺対応のプレビューへ変換中…` });
            const original = await registerMediaFile({
              path: originalPath,
              name: file.name,
              size: file.size,
              kind: 'video',
            });
            if (!original?.token) {
              throw new Error(`素材を安全に登録できません: ${file.name}`, {
                cause: probeError,
              });
            }
            let proxyToken: string | undefined;
            try {
              const proxy = await createNativeProxy(original.token);
              if (!proxy.ok || !proxy.token || !proxy.url || !proxy.size) {
                throw new Error(
                  proxy.error ?? `${file.name} のプレビュー変換に失敗しました`,
                  { cause: probeError },
                );
              }
              proxyToken = proxy.token;
              const meta = await probeVideoUrlMetadata(proxy.url);
              asset = {
                id: crypto.randomUUID(),
                name: file.name,
                kind: 'video',
                url: proxy.url,
                file,
                size: file.size,
                mimeType: file.type || guessMimeType(file.name, 'video'),
                duration: meta.duration,
                width: meta.width,
                height: meta.height,
                path: originalPath,
                sourceToken: original.token,
                previewSourceToken: proxy.token,
                previewProxy: true,
              };
            } catch (error) {
              if (proxyToken) {
                await window.fce?.releaseMediaFile?.(proxyToken).catch(() => {});
              }
              await window.fce?.releaseMediaFile?.(original.token).catch(() => {});
              throw error;
            }
          } else {
            const proxy = await createPreviewProxy(file, (importStatus) =>
              set({ importStatus }),
            );
            const proxyAsset = await fileToMediaAsset(proxy);
            if (!proxyAsset) throw probeError;
            asset = {
              ...proxyAsset,
              name: file.name,
              file,
              size: file.size,
              mimeType: file.type || guessMimeType(file.name, 'video'),
              path: originalPath,
              previewProxy: true,
            };
          }
        }
        if (asset) newAssets.push(asset);
        else errors.push(`非対応のファイル形式: ${file.name}`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `読み込み失敗: ${file.name}`);
      } finally {
        set({ importStatus: '読み込み中…' });
      }
    }

    set((state) => {
      const merged = [...state.assets, ...newAssets];
      const nextSelected = state.selectedAssetId ?? newAssets[0]?.id ?? null;
      return {
        assets: merged,
        selectedAssetId: nextSelected,
        isImporting: false,
        importStatus: null,
        importError: errors.length > 0 ? errors.join(' / ') : null,
      };
    });

    // Background: compute waveforms for any new audio assets.
    for (const a of newAssets) {
      if (a.kind !== 'audio' || !a.file) continue;
      void computeWaveform(a.file).then((wf) => {
        useMediaStore.getState().setAssetWaveform(a.id, {
          peaks: wf.peaks,
          peaksPerSecond: wf.peaksPerSecond,
        });
      }).catch(() => {
        // A corrupt/unsupported audio stream should not become an unhandled
        // rejection after the import itself has already completed.
      });
    }

    return newAssets;
  },

  addRecoveredAsset: async (ref, source) => {
    let previewToken: string | undefined;
    try {
      let preview = {
        url: source.url,
        duration: ref.duration,
        width: ref.width,
        height: ref.height,
        previewProxy: false,
      };
      if (
        ref.kind === 'video' &&
        /\.(?:avi|mkv)$/i.test(ref.name) &&
        window.fce?.createPreviewProxy
      ) {
        const proxy = await window.fce.createPreviewProxy(source.token);
        if (!proxy.ok || !proxy.token || !proxy.url || !proxy.size) {
          throw new Error(
            proxy.error ?? `${ref.name} の互換プレビューを復元できません`,
          );
        }
        previewToken = proxy.token;
        const meta = await probeVideoUrlMetadata(proxy.url);
        preview = {
          url: proxy.url,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          previewProxy: true,
        };
      }
      const asset: MediaAsset = {
        id: crypto.randomUUID(),
        name: ref.name,
        kind: ref.kind,
        url: preview.url,
        size: source.size,
        mimeType: guessMimeType(ref.name, ref.kind),
        duration: preview.duration,
        width: preview.width,
        height: preview.height,
        path: ref.path,
        sourceToken: source.token,
        previewSourceToken: previewToken,
        previewProxy: preview.previewProxy,
      };
      set((state) => ({
        assets: [...state.assets, asset],
        selectedAssetId: state.selectedAssetId ?? asset.id,
      }));
      return asset;
    } catch (error) {
      if (previewToken) {
        await window.fce?.releaseMediaFile?.(previewToken).catch(() => {});
      }
      await window.fce?.releaseMediaFile?.(source.token).catch(() => {});
      throw error;
    }
  },

  removeAsset: (id) => {
    set((state) => {
      const target = state.assets.find((a) => a.id === id);
      if (target?.url.startsWith('blob:')) URL.revokeObjectURL(target.url);
      if (target) releaseAssetMediaTokens(target);
      const remaining = state.assets.filter((a) => a.id !== id);
      const nextSelected =
        state.selectedAssetId === id ? (remaining[0]?.id ?? null) : state.selectedAssetId;
      return { assets: remaining, selectedAssetId: nextSelected };
    });
  },

  clearAssets: () => {
    const assets = get().assets;
    for (const asset of assets) {
      if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url);
      releaseAssetMediaTokens(asset);
    }
    set({
      assets: [],
      selectedAssetId: null,
      isImporting: false,
      importStatus: null,
      importError: null,
    });
  },

  selectAsset: (id) => set({ selectedAssetId: id }),

  clearError: () => set({ importError: null }),

  setAssetBeats: (id, beats) =>
    set((state) => ({
      assets: state.assets.map((a) => (a.id === id ? { ...a, beats } : a)),
    })),

  setAssetWaveform: (id, waveform) =>
    set((state) => ({
      assets: state.assets.map((a) => (a.id === id ? { ...a, waveform } : a)),
    })),
}));

export const useSelectedAsset = (): MediaAsset | null => {
  // Subscribe to the primitives (id + array) and derive locally. Returning
  // `s.assets.find(...)` directly from a zustand selector triggers a new
  // ref on every store update (the assets array gets replaced whenever
  // any asset is mutated, including unrelated waveform updates), causing
  // every consumer of useSelectedAsset to re-render. The two narrow
  // selectors below let Object.is compare a string and an array ref,
  // which only change when actually relevant.
  const selectedId = useMediaStore((s) => s.selectedAssetId);
  const assets = useMediaStore((s) => s.assets);
  if (!selectedId) return null;
  return assets.find((a) => a.id === selectedId) ?? null;
};
