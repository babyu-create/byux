import { describe, expect, it, vi } from 'vitest'
import {
  renameWithRetry,
  syncFileForCommit,
} from '../../electron/nativeFs.cjs'

function fsError(code: string) {
  return Object.assign(new Error(code), { code })
}

describe('renameWithRetry', () => {
  it('retries transient Windows locks and eventually commits', async () => {
    const rename = vi.fn()
      .mockRejectedValueOnce(fsError('EPERM'))
      .mockRejectedValueOnce(fsError('EBUSY'))
      .mockResolvedValue(undefined)

    await renameWithRetry('source.part', 'output.mp4', {
      rename,
      attempts: 4,
      delayMs: 0,
    })

    expect(rename).toHaveBeenCalledTimes(3)
  })

  it('does not retry a non-transient filesystem error', async () => {
    const rename = vi.fn().mockRejectedValue(fsError('ENOENT'))

    await expect(
      renameWithRetry('missing.part', 'output.mp4', {
        rename,
        attempts: 4,
        delayMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('stops after the configured transient-lock budget', async () => {
    const rename = vi.fn().mockRejectedValue(fsError('EACCES'))

    await expect(
      renameWithRetry('source.part', 'output.mp4', {
        rename,
        attempts: 3,
        delayMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'EACCES' })
    expect(rename).toHaveBeenCalledTimes(3)
  })

  it('does not commit after cancellation during a transient-lock retry', async () => {
    let cancelled = false
    const rename = vi.fn().mockImplementation(async () => {
      cancelled = true
      throw fsError('EPERM')
    })

    await expect(
      renameWithRetry('source.part', 'output.mp4', {
        rename,
        attempts: 4,
        delayMs: 0,
        shouldAbort: () => cancelled,
      }),
    ).rejects.toMatchObject({ code: 'ECANCELED' })
    expect(rename).toHaveBeenCalledOnce()
  })
})

describe('syncFileForCommit', () => {
  it('opens the completed output as writable before flushing on Windows', async () => {
    const handle = {
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const open = vi.fn().mockResolvedValue(handle)

    await syncFileForCommit('output.part', { open })

    expect(open).toHaveBeenCalledWith('output.part', 'r+')
    expect(handle.sync).toHaveBeenCalledOnce()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('closes the output handle even when flushing fails', async () => {
    const handle = {
      sync: vi.fn().mockRejectedValue(fsError('EPERM')),
      close: vi.fn().mockResolvedValue(undefined),
    }

    await expect(
      syncFileForCommit('output.part', {
        open: vi.fn().mockResolvedValue(handle),
        attempts: 1,
        delayMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('retries transient Windows flush failures and closes every handle', async () => {
    const first = {
      sync: vi.fn().mockRejectedValue(fsError('EBUSY')),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const second = {
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const open = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)

    await syncFileForCommit('output.part', {
      open,
      attempts: 3,
      delayMs: 0,
    })

    expect(open).toHaveBeenCalledTimes(2)
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('preserves the flush error if closing the handle also fails', async () => {
    const handle = {
      sync: vi.fn().mockRejectedValue(fsError('EPERM')),
      close: vi.fn().mockRejectedValue(fsError('EIO')),
    }

    await expect(
      syncFileForCommit('output.part', {
        open: vi.fn().mockResolvedValue(handle),
        attempts: 1,
        delayMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'EPERM' })
  })
})
