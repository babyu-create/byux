import { create } from 'zustand';
import type { MediaAsset } from '../lib/types';
import { fileToMediaAsset, guessMimeType, isVideoFile } from '../lib/media';
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
  ) => MediaAsset;
  removeAsset: (id: string) => void;
  selectAsset: (id: string | null) => void;
  clearError: () => void;
  setAssetBeats: (id: string, beats: number[]) => void;
  setAssetWaveform: (id: string, waveform: { peaks: Float32Array; peaksPerSecond: number }) => void;
}

export const useMediaStore = create<MediaStoreState>((set) => ({
  assets: [],
  selectedAssetId: null,
  isImporting: false,
  importStatus: null,
  importError: null,

  addFiles: async (files) => {
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
          asset = await fileToMediaAsset(file);
        } catch (probeError) {
          if (!isVideoFile(file)) throw probeError;
          const { createPreviewProxy } = await import('../lib/exporter');
          const originalPath = window.fce?.getPathForFile?.(file) || undefined;
          const proxy = await createPreviewProxy(file, (importStatus) => set({ importStatus }));
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
      });
    }

    return newAssets;
  },

  addRecoveredAsset: (ref, source) => {
    const asset: MediaAsset = {
      id: crypto.randomUUID(),
      name: ref.name,
      kind: ref.kind,
      url: source.url,
      size: source.size,
      mimeType: guessMimeType(ref.name, ref.kind),
      duration: ref.duration,
      width: ref.width,
      height: ref.height,
      path: ref.path,
      sourceToken: source.token,
    };
    set((state) => ({
      assets: [...state.assets, asset],
      selectedAssetId: state.selectedAssetId ?? asset.id,
    }));
    return asset;
  },

  removeAsset: (id) => {
    set((state) => {
      const target = state.assets.find((a) => a.id === id);
      if (target?.url.startsWith('blob:')) URL.revokeObjectURL(target.url);
      if (target?.sourceToken) {
        void window.fce?.releaseMediaFile?.(target.sourceToken);
      }
      const remaining = state.assets.filter((a) => a.id !== id);
      const nextSelected =
        state.selectedAssetId === id ? (remaining[0]?.id ?? null) : state.selectedAssetId;
      return { assets: remaining, selectedAssetId: nextSelected };
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
