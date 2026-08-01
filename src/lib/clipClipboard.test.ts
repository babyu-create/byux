import { beforeEach, describe, expect, it } from 'vitest'
import type { Clip } from './types'
import {
  clearClipClipboard,
  placeClipCopies,
  readClipClipboard,
  writeClipClipboard,
} from './clipClipboard'

function clip(id: string, trackId: string, start: number, duration: number): Clip {
  return {
    id,
    trackId,
    assetId: 'asset',
    start,
    trimStart: 0,
    trimEnd: duration,
    effects: [],
  }
}

describe('clip clipboard', () => {
  beforeEach(clearClipClipboard)

  it('stores a detached deep copy', () => {
    const source = clip('source', 'video', 2, 3)
    source.effects = [{ type: 'fade-in', duration: 0.3 }]

    expect(writeClipClipboard([source])).toBe(1)
    source.effects[0].duration = 1

    expect(readClipClipboard()[0].effects?.[0].duration).toBe(0.3)
  })

  it('preserves multi-track offsets and moves the group past collisions', () => {
    const source = [
      clip('video-copy', 'video', 10, 2),
      clip('audio-copy', 'audio', 10.5, 1),
    ]
    const existing = [
      clip('video-existing', 'video', 5, 3),
      clip('audio-existing', 'audio', 7.5, 1),
    ]

    const placed = placeClipCopies(source, existing, 6)

    expect(placed[0].start).toBe(8)
    expect(placed[1].start).toBe(8.5)
  })
})
