import { create } from 'zustand';
import type { MediaAsset } from '../lib/types';
import { fileToMediaAsset } from '../lib/media';
import { computeWaveform } from '../lib/audio';

interface MediaStoreState {
  assets: MediaAsset[];
  selectedAssetId: string | null;
  isImporting: boolean;
  importError: string | null;
  addFiles: (files: File[] | FileList) => Promise<void>;
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
  importError: null,

  addFiles: async (files) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    set({ isImporting: true, importError: null });

    const errors: string[] = [];
    const newAssets: MediaAsset[] = [];

    await Promise.all(
      list.map(async (file) => {
        try {
          const asset = await fileToMediaAsset(file);
          if (asset) newAssets.push(asset);
          else errors.push(`非対応のファイル形式: ${file.name}`);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `読み込み失敗: ${file.name}`);
        }
      }),
    );

    set((state) => {
      const merged = [...state.assets, ...newAssets];
      const nextSelected = state.selectedAssetId ?? newAssets[0]?.id ?? null;
      return {
        assets: merged,
        selectedAssetId: nextSelected,
        isImporting: false,
        importError: errors.length > 0 ? errors.join(' / ') : null,
      };
    });

    // Background: compute waveforms for any new audio assets.
    for (const a of newAssets) {
      if (a.kind !== 'audio') continue;
      void computeWaveform(a.file).then((wf) => {
        useMediaStore.getState().setAssetWaveform(a.id, {
          peaks: wf.peaks,
          peaksPerSecond: wf.peaksPerSecond,
        });
      });
    }
  },

  removeAsset: (id) => {
    set((state) => {
      const target = state.assets.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.url);
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
  const { assets, selectedAssetId } = useMediaStore();
  if (!selectedAssetId) return null;
  return assets.find((a) => a.id === selectedAssetId) ?? null;
};
