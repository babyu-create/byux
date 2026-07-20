import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeMediaSource } from '../lib/types'

const mediaMocks = vi.hoisted(() => ({
  probeVideoUrlMetadata: vi.fn(),
  probeAudioUrlMetadata: vi.fn(),
}))

vi.mock('../lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/media')>()
  return {
    ...actual,
    probeVideoUrlMetadata: mediaMocks.probeVideoUrlMetadata,
    probeAudioUrlMetadata: mediaMocks.probeAudioUrlMetadata,
  }
})

import { useMediaStore } from './mediaStore'

const SOURCE: NativeMediaSource = {
  path: 'C:\\Videos\\Valorant clip.mp4',
  name: 'Valorant clip.mp4',
  size: 1_371_362_203,
  kind: 'video',
  token: 'source-token',
  url: 'fce-media://asset/source-token',
}

function installFceApi(overrides: Record<string, unknown> = {}) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      fce: {
        appName: 'Byux',
        isElectron: true,
        releaseMediaFile: vi.fn().mockResolvedValue(true),
        ...overrides,
      },
    },
  })
}

describe('mediaStore native source registration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useMediaStore.setState({
      assets: [],
      selectedAssetId: null,
      isImporting: false,
      importStatus: null,
      importError: null,
    })
    installFceApi()
  })

  it('keeps the native path and source token for a >1GB selected recording', async () => {
    mediaMocks.probeVideoUrlMetadata.mockResolvedValue({
      duration: 140.394688,
      width: 1920,
      height: 1080,
    })

    const created = await useMediaStore.getState().addNativeSources([SOURCE])

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      name: SOURCE.name,
      size: SOURCE.size,
      duration: 140.394688,
      width: 1920,
      height: 1080,
      path: SOURCE.path,
      sourceToken: SOURCE.token,
      url: SOURCE.url,
    })
    expect(created[0].file).toBeUndefined()
  })

  it('releases a native registration when metadata probing fails', async () => {
    const releaseMediaFile = vi.fn().mockResolvedValue(true)
    installFceApi({ releaseMediaFile })
    mediaMocks.probeVideoUrlMetadata.mockRejectedValue(new Error('probe failed'))

    const created = await useMediaStore.getState().addNativeSources([SOURCE])

    expect(created).toEqual([])
    expect(releaseMediaFile).toHaveBeenCalledWith(SOURCE.token)
    expect(useMediaStore.getState().importError).toContain('probe failed')
  })

  it('creates a native compatibility proxy before probing an MPEG-TS source', async () => {
    const source = {
      ...SOURCE,
      path: 'C:\\Videos\\match.m2ts',
      name: 'match.m2ts',
      token: 'm2ts-source-token',
      url: 'fce-media://asset/m2ts-source-token',
    }
    const createPreviewProxy = vi.fn().mockResolvedValue({
      ok: true,
      token: 'proxy-token',
      url: 'fce-media://asset/proxy-token',
      size: 4_000_000,
      cached: false,
    })
    installFceApi({ createPreviewProxy })
    mediaMocks.probeVideoUrlMetadata.mockResolvedValue({
      duration: 90,
      width: 1280,
      height: 720,
    })

    const created = await useMediaStore.getState().addNativeSources([source])

    expect(createPreviewProxy).toHaveBeenCalledWith(source.token)
    expect(mediaMocks.probeVideoUrlMetadata).toHaveBeenCalledOnce()
    expect(mediaMocks.probeVideoUrlMetadata).toHaveBeenCalledWith(
      'fce-media://asset/proxy-token',
    )
    expect(created[0]).toMatchObject({
      sourceToken: source.token,
      previewSourceToken: 'proxy-token',
      previewProxy: true,
      url: 'fce-media://asset/proxy-token',
    })
  })

  it('falls back to a proxy when an MP4 contains a Chromium-incompatible codec', async () => {
    const createPreviewProxy = vi.fn().mockResolvedValue({
      ok: true,
      token: 'codec-proxy-token',
      url: 'fce-media://asset/codec-proxy-token',
      size: 5_000_000,
      cached: false,
    })
    installFceApi({ createPreviewProxy })
    mediaMocks.probeVideoUrlMetadata
      .mockRejectedValueOnce(new Error('unsupported codec'))
      .mockResolvedValueOnce({ duration: 140, width: 1280, height: 720 })

    const created = await useMediaStore.getState().addNativeSources([SOURCE])

    expect(createPreviewProxy).toHaveBeenCalledWith(SOURCE.token)
    expect(mediaMocks.probeVideoUrlMetadata).toHaveBeenNthCalledWith(1, SOURCE.url)
    expect(mediaMocks.probeVideoUrlMetadata).toHaveBeenNthCalledWith(
      2,
      'fce-media://asset/codec-proxy-token',
    )
    expect(created[0]).toMatchObject({
      sourceToken: SOURCE.token,
      previewSourceToken: 'codec-proxy-token',
      previewProxy: true,
    })
  })

  it('creates an AAC compatibility proxy for WMA audio', async () => {
    const source: NativeMediaSource = {
      path: 'C:\\Audio\\soundtrack.wma',
      name: 'soundtrack.wma',
      size: 20_000_000,
      kind: 'audio',
      token: 'wma-source-token',
      url: 'fce-media://asset/wma-source-token',
    }
    const createPreviewProxy = vi.fn().mockResolvedValue({
      ok: true,
      token: 'audio-proxy-token',
      url: 'fce-media://asset/audio-proxy-token',
      size: 2_000_000,
      cached: false,
    })
    installFceApi({ createPreviewProxy })
    mediaMocks.probeAudioUrlMetadata.mockResolvedValue({ duration: 180 })

    const created = await useMediaStore.getState().addNativeSources([source])

    expect(createPreviewProxy).toHaveBeenCalledWith(source.token)
    expect(mediaMocks.probeAudioUrlMetadata).toHaveBeenCalledWith(
      'fce-media://asset/audio-proxy-token',
    )
    expect(created[0]).toMatchObject({
      kind: 'audio',
      sourceToken: source.token,
      previewSourceToken: 'audio-proxy-token',
      previewProxy: true,
    })
  })

  it('uses the same compatibility path for a disk-backed WMA drag', async () => {
    const file = new File(['wma'], 'dragged-soundtrack.wma', {
      type: 'audio/x-ms-wma',
    })
    const source: NativeMediaSource = {
      path: 'C:\\Audio\\dragged-soundtrack.wma',
      name: file.name,
      size: file.size,
      kind: 'audio',
      token: 'dragged-wma-token',
      url: 'fce-media://asset/dragged-wma-token',
    }
    const registerMediaFileFromFile = vi.fn().mockResolvedValue({
      ok: true,
      source,
    })
    const createPreviewProxy = vi.fn().mockResolvedValue({
      ok: true,
      token: 'dragged-audio-proxy-token',
      url: 'fce-media://asset/dragged-audio-proxy-token',
      size: 100,
      cached: false,
    })
    installFceApi({ registerMediaFileFromFile, createPreviewProxy })
    mediaMocks.probeAudioUrlMetadata.mockResolvedValue({ duration: 30 })

    const created = await useMediaStore.getState().addFiles([file])

    expect(registerMediaFileFromFile).toHaveBeenCalledWith(file, 'audio')
    expect(createPreviewProxy).toHaveBeenCalledWith(source.token)
    expect(created[0]).toMatchObject({
      kind: 'audio',
      file,
      sourceToken: source.token,
      previewSourceToken: 'dragged-audio-proxy-token',
      previewProxy: true,
    })
  })

  it('discards an in-flight source when the project is cleared', async () => {
    let resolveMetadata:
      | ((value: { duration: number; width: number; height: number }) => void)
      | undefined
    mediaMocks.probeVideoUrlMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve
        }),
    )
    const releaseMediaFile = vi.fn().mockResolvedValue(true)
    installFceApi({ releaseMediaFile })

    const importing = useMediaStore.getState().addNativeSources([SOURCE])
    useMediaStore.getState().clearAssets()
    resolveMetadata?.({ duration: 140, width: 1920, height: 1080 })

    await expect(importing).resolves.toEqual([])
    expect(useMediaStore.getState().assets).toEqual([])
    expect(releaseMediaFile).toHaveBeenCalledTimes(1)
    expect(releaseMediaFile).toHaveBeenCalledWith(SOURCE.token)
  })

  it('rejects a non-disk-backed drop immediately with a recovery action', async () => {
    const registerMediaFileFromFile = vi.fn().mockResolvedValue({
      ok: false,
      code: 'NOT_DISK_BACKED',
    })
    installFceApi({ registerMediaFileFromFile })
    const file = new File(['video'], 'synthetic.mp4', { type: 'video/mp4' })

    const created = await useMediaStore.getState().addFiles([file])

    expect(created).toEqual([])
    expect(useMediaStore.getState().importError).toContain(
      '「ファイルを追加」ボタンから選び直してください',
    )
  })
})
