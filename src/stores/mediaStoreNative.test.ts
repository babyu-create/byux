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
