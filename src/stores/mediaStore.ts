import { create } from 'zustand';
import type { MediaAsset } from '../lib/types';
import {
  fileToMediaAsset,
  guessMimeType,
  isAudioFile,
  isVideoFile,
  needsAudioPreviewProxy,
  needsVideoPreviewProxy,
  probeAudioUrlMetadata,
  probeVideoUrlMetadata,
  type MediaProbeResult,
} from '../lib/media';
import { computeWaveform } from '../lib/audio';
import type { ProjectAssetRef } from '../lib/project';
import type {
  NativeMediaRegistrationResult,
  NativeMediaSource,
} from '../lib/types';

interface MediaStoreState {
  assets: MediaAsset[];
  selectedAssetId: string | null;
  isImporting: boolean;
  importStatus: string | null;
  importError: string | null;
  /** Returns the assets actually created (skips unsupported files), so a
   *  caller like Track's drop handler can place clips for them immediately. */
  addFiles: (files: File[] | FileList) => Promise<MediaAsset[]>;
  addNativeSources: (sources: NativeMediaSource[]) => Promise<MediaAsset[]>;
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

function nativeRegistrationError(
  fileName: string,
  result: Extract<NativeMediaRegistrationResult, { ok: false }>,
): Error {
  const detail =
    result.code === 'NOT_DISK_BACKED'
      ? 'ドラッグ元からディスク上の場所を取得できません'
      : result.code === 'NOT_AUTHORIZED'
        ? 'ファイルの参照を安全に承認できません'
        : result.code === 'INVALID_KIND'
          ? 'ファイル形式を判定できません'
          : 'ファイルを安全に登録できません';
  return new Error(
    `${detail}: ${fileName}。「ファイルを追加」ボタンから選び直してください`,
  );
}

async function assetFromNativeSource(
  source: NativeMediaSource,
): Promise<MediaAsset> {
  let previewToken: string | undefined;
  try {
    let previewUrl = source.url;
    let previewProxy = false;
    const createCompatiblePreview = async () => {
      const createPreviewProxy = window.fce?.createPreviewProxy;
      if (!createPreviewProxy) {
        throw new Error(`${source.name} の互換プレビュー機能を利用できません`);
      }
      const proxy = await createPreviewProxy(source.token);
      if (!proxy.ok || !proxy.token || !proxy.url || !proxy.size) {
        throw new Error(
          proxy.error ?? `${source.name} の互換プレビューを作成できません`,
        );
      }
      previewToken = proxy.token;
      previewUrl = proxy.url;
      previewProxy = true;
    };
    if (
      (source.kind === 'video' && needsVideoPreviewProxy(source.name)) ||
      (source.kind === 'audio' && needsAudioPreviewProxy(source.name))
    ) {
      await createCompatiblePreview();
    }
    let metadata: MediaProbeResult;
    try {
      metadata =
        source.kind === 'video'
          ? await probeVideoUrlMetadata(previewUrl)
          : await probeAudioUrlMetadata(previewUrl);
    } catch (probeError) {
      // A container extension does not guarantee Chromium can decode the
      // streams inside it (HEVC/AV1/PCM/WMA are common examples). Keep the
      // original token for export and create a compatible editing proxy.
      if (previewProxy || !window.fce?.createPreviewProxy) {
        throw probeError;
      }
      await createCompatiblePreview();
      metadata =
        source.kind === 'video'
          ? await probeVideoUrlMetadata(previewUrl)
          : await probeAudioUrlMetadata(previewUrl);
    }
    return {
      id: crypto.randomUUID(),
      name: source.name,
      kind: source.kind,
      url: previewUrl,
      size: source.size,
      mimeType: guessMimeType(source.name, source.kind),
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      path: source.path,
      sourceToken: source.token,
      previewSourceToken: previewToken,
      previewProxy,
    };
  } catch (error) {
    if (previewToken) {
      await window.fce?.releaseMediaFile?.(previewToken).catch(() => {});
    }
    await window.fce?.releaseMediaFile?.(source.token).catch(() => {});
    throw error;
  }
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

async function releaseAssetMediaTokensNow(asset: MediaAsset): Promise<void> {
  const releaseMediaFile = window.fce?.releaseMediaFile;
  if (!releaseMediaFile) return;
  const tokens = new Set(
    [asset.sourceToken, asset.previewSourceToken].filter(
      (token): token is string => Boolean(token),
    ),
  );
  await Promise.all(
    [...tokens].map(async (token) => {
      try {
        await releaseMediaFile(token);
      } catch {
        // The main process also drops registrations at renderer shutdown.
      }
    }),
  );
}

async function disposeImportedAssets(assets: MediaAsset[]): Promise<void> {
  await Promise.all(
    assets.map(async (asset) => {
      if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url);
      await releaseAssetMediaTokensNow(asset);
    }),
  );
}

async function releaseNativeSources(sources: NativeMediaSource[]): Promise<void> {
  const releaseMediaFile = window.fce?.releaseMediaFile;
  if (!releaseMediaFile) return;
  await Promise.all(
    sources.map(async (source) => {
      try {
        await releaseMediaFile(source.token);
      } catch {
        // A failed cleanup must not strand the import state.
      }
    }),
  );
}

let mediaImportGeneration = 0;

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
    const importGeneration = ++mediaImportGeneration;

    set({ isImporting: true, importStatus: '読み込み中…', importError: null });

    const errors: string[] = [];
    const newAssets: MediaAsset[] = [];

    // Process sequentially: compatibility transcoding is memory-heavy and the
    // shared FFmpeg instance must never receive overlapping commands.
    for (const file of list) {
      if (importGeneration !== mediaImportGeneration) {
        await disposeImportedAssets(newAssets);
        return [];
      }
      let registeredSource: NativeMediaSource | undefined;
      let keepRegisteredSource = false;
      try {
        const kind = isVideoFile(file)
          ? 'video'
          : isAudioFile(file)
            ? 'audio'
            : null;
        const registerFromFile = window.fce?.registerMediaFileFromFile;
        if (window.fce?.isElectron && kind && registerFromFile) {
          const result = await registerFromFile(file, kind);
          if (!result.ok) throw nativeRegistrationError(file.name, result);
          registeredSource = result.source;
        }

        let asset: MediaAsset | null;
        try {
          if (
            window.fce?.isElectron &&
            ((kind === 'video' && needsVideoPreviewProxy(file.name)) ||
              (kind === 'audio' && needsAudioPreviewProxy(file.name))) &&
            window.fce.createPreviewProxy
          ) {
            throw new Error('互換プレビューを作成します');
          }
          asset = await fileToMediaAsset(file);
          if (asset && registeredSource) {
            asset = {
              ...asset,
              path: registeredSource.path,
              sourceToken: registeredSource.token,
            };
          }
        } catch (probeError) {
          if (!kind) throw probeError;
          const { createPreviewProxy } = await import('../lib/exporter');
          const createNativeProxy = window.fce?.createPreviewProxy;
          if (!registeredSource) {
            const originalPath = window.fce?.getPathForFile?.(file) || undefined;
            const registerMediaFile = window.fce?.registerMediaFile;
            if (originalPath && registerMediaFile) {
              const original = await registerMediaFile({
                path: originalPath,
                name: file.name,
                size: file.size,
                kind,
              });
              if (original?.token) {
                registeredSource = {
                  ...original,
                  path: originalPath,
                  name: file.name,
                  kind,
                };
              }
            }
          }
          if (registeredSource && createNativeProxy) {
            if (importGeneration === mediaImportGeneration) {
              set({ importStatus: `${file.name} を互換プレビューへ変換中…` });
            }
            let proxyToken: string | undefined;
            try {
              const proxy = await createNativeProxy(registeredSource.token);
              if (!proxy.ok || !proxy.token || !proxy.url || !proxy.size) {
                throw new Error(
                  proxy.error ?? `${file.name} のプレビュー変換に失敗しました`,
                  { cause: probeError },
                );
              }
              proxyToken = proxy.token;
              const meta =
                kind === 'video'
                  ? await probeVideoUrlMetadata(proxy.url)
                  : await probeAudioUrlMetadata(proxy.url);
              asset = {
                id: crypto.randomUUID(),
                name: file.name,
                kind,
                url: proxy.url,
                file,
                size: file.size,
                mimeType: file.type || guessMimeType(file.name, kind),
                duration: meta.duration,
                width: meta.width,
                height: meta.height,
                path: registeredSource.path,
                sourceToken: registeredSource.token,
                previewSourceToken: proxy.token,
                previewProxy: true,
              };
            } catch (error) {
              if (proxyToken) {
                await window.fce?.releaseMediaFile?.(proxyToken).catch(() => {});
              }
              throw error;
            }
          } else {
            if (kind !== 'video') throw probeError;
            const proxy = await createPreviewProxy(file, (importStatus) =>
              importGeneration === mediaImportGeneration
                ? set({ importStatus })
                : undefined,
            );
            const proxyAsset = await fileToMediaAsset(proxy);
            if (!proxyAsset) throw probeError;
            asset = {
              ...proxyAsset,
              name: file.name,
              file,
              size: file.size,
              mimeType: file.type || guessMimeType(file.name, 'video'),
              path: registeredSource?.path,
              sourceToken: registeredSource?.token,
              previewProxy: true,
            };
          }
        }
        if (asset) {
          if (importGeneration !== mediaImportGeneration) {
            if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url);
            if (asset.previewSourceToken) {
              await window.fce
                ?.releaseMediaFile?.(asset.previewSourceToken)
                .catch(() => {});
            }
            await disposeImportedAssets(newAssets);
            return [];
          }
          newAssets.push(asset);
          keepRegisteredSource = true;
        } else {
          errors.push(`非対応のファイル形式: ${file.name}`);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `読み込み失敗: ${file.name}`);
      } finally {
        if (registeredSource && !keepRegisteredSource) {
          await window.fce?.releaseMediaFile?.(registeredSource.token).catch(() => {});
        }
        if (importGeneration === mediaImportGeneration) {
          set({ importStatus: '読み込み中…' });
        }
      }
    }

    if (importGeneration !== mediaImportGeneration) {
      await disposeImportedAssets(newAssets);
      return [];
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
        if (importGeneration !== mediaImportGeneration) return;
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

  addNativeSources: async (sources) => {
    if (sources.length === 0) return [];
    if (get().isImporting) {
      await releaseNativeSources(sources);
      return [];
    }
    const importGeneration = ++mediaImportGeneration;
    set({ isImporting: true, importStatus: '読み込み中…', importError: null });
    const newAssets: MediaAsset[] = [];
    const errors: string[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      if (importGeneration !== mediaImportGeneration) {
        await Promise.all([
          disposeImportedAssets(newAssets),
          releaseNativeSources(sources.slice(index)),
        ]);
        return [];
      }
      const source = sources[index];
      try {
        set({ importStatus: `${source.name} を読み込み中…` });
        const asset = await assetFromNativeSource(source);
        if (importGeneration !== mediaImportGeneration) {
          await Promise.all([
            disposeImportedAssets([...newAssets, asset]),
            releaseNativeSources(sources.slice(index + 1)),
          ]);
          return [];
        }
        newAssets.push(asset);
      } catch (error) {
        if (importGeneration !== mediaImportGeneration) {
          await Promise.all([
            disposeImportedAssets(newAssets),
            releaseNativeSources(sources.slice(index + 1)),
          ]);
          return [];
        }
        errors.push(
          error instanceof Error
            ? `${source.name}: ${error.message}`
            : `読み込み失敗: ${source.name}`,
        );
      }
    }
    if (importGeneration !== mediaImportGeneration) {
      await disposeImportedAssets(newAssets);
      return [];
    }
    set((state) => ({
      assets: [...state.assets, ...newAssets],
      selectedAssetId: state.selectedAssetId ?? newAssets[0]?.id ?? null,
      isImporting: false,
      importStatus: null,
      importError: errors.length > 0 ? errors.join(' / ') : null,
    }));
    return newAssets;
  },

  addRecoveredAsset: async (ref, source) => {
    const importGeneration = mediaImportGeneration;
    const asset = await assetFromNativeSource({
      path: ref.path ?? '',
      name: ref.name,
      size: source.size,
      kind: ref.kind,
      token: source.token,
      url: source.url,
    });
    if (importGeneration !== mediaImportGeneration) {
      await releaseAssetMediaTokensNow(asset);
      throw new Error('素材の復元が中止されました');
    }
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
      if (target) releaseAssetMediaTokens(target);
      const remaining = state.assets.filter((a) => a.id !== id);
      const nextSelected =
        state.selectedAssetId === id ? (remaining[0]?.id ?? null) : state.selectedAssetId;
      return { assets: remaining, selectedAssetId: nextSelected };
    });
  },

  clearAssets: () => {
    mediaImportGeneration += 1;
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
