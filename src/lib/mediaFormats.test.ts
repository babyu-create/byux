import { describe, expect, it } from 'vitest'
import {
  AUDIO_EXTENSION_LIST,
  VIDEO_EXTENSION_LIST,
  mediaExtensionMatchesKind,
  mediaKindForPath,
} from '../../electron/mediaFormats.cjs'
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_AUDIO_ACCEPT,
  SUPPORTED_MEDIA_ACCEPT,
  SUPPORTED_VIDEO_ACCEPT,
  SUPPORTED_VIDEO_EXTENSIONS,
  guessMimeType,
  isAudioFile,
  isVideoFile,
  needsAudioPreviewProxy,
  needsVideoPreviewProxy,
  shouldPreferPreviewProxy,
} from './media'

describe('media format support', () => {
  it('keeps main-process and renderer extension allowlists identical', () => {
    expect(VIDEO_EXTENSION_LIST.map((ext) => ext.slice(1))).toEqual(
      SUPPORTED_VIDEO_EXTENSIONS,
    )
    expect(AUDIO_EXTENSION_LIST.map((ext) => ext.slice(1))).toEqual(
      SUPPORTED_AUDIO_EXTENSIONS,
    )
  })

  it('keeps file-picker filters aligned with every supported extension', () => {
    for (const extension of SUPPORTED_VIDEO_EXTENSIONS) {
      expect(SUPPORTED_VIDEO_ACCEPT).toContain(`.${extension}`)
      expect(SUPPORTED_MEDIA_ACCEPT).toContain(`.${extension}`)
    }
    for (const extension of SUPPORTED_AUDIO_EXTENSIONS) {
      expect(SUPPORTED_AUDIO_ACCEPT).toContain(`.${extension}`)
      expect(SUPPORTED_MEDIA_ACCEPT).toContain(`.${extension}`)
    }
  })

  it.each(['clip.m4v', 'clip.m2ts', 'clip.wmv', 'clip.mxf', 'clip.3gp'])(
    'recognizes extended video container %s',
    (name) => {
      expect(isVideoFile(new File([], name))).toBe(true)
      expect(mediaKindForPath(`C:\\Videos\\${name}`)).toBe('video')
      expect(mediaExtensionMatchesKind(name, 'video')).toBe(true)
    },
  )

  it.each(['music.opus', 'music.wma', 'music.aiff', 'music.ac3'])(
    'recognizes extended audio container %s',
    (name) => {
      expect(isAudioFile(new File([], name))).toBe(true)
      expect(mediaKindForPath(`C:\\Audio\\${name}`)).toBe('audio')
      expect(mediaExtensionMatchesKind(name, 'audio')).toBe(true)
    },
  )

  it('sends containers Chromium commonly rejects through a preview proxy', () => {
    expect(needsVideoPreviewProxy('match.ts')).toBe(true)
    expect(needsVideoPreviewProxy('capture.WMV')).toBe(true)
    expect(needsVideoPreviewProxy('capture.mp4')).toBe(false)
    expect(needsAudioPreviewProxy('soundtrack.wma')).toBe(true)
    expect(needsAudioPreviewProxy('soundtrack.m4a')).toBe(false)
    expect(guessMimeType('match.m2ts', 'video')).toBe('video/mp2t')
  })

  it('prefers a disk-backed proxy only for genuinely long, heavy captures', () => {
    expect(shouldPreferPreviewProxy(1_500_000_000, 60)).toBe(false)
    expect(shouldPreferPreviewProxy(500_000_000, 1800)).toBe(false)
    expect(shouldPreferPreviewProxy(1_500_000_000, 1800)).toBe(true)
  })

  it('does not treat arbitrary files as media', () => {
    const file = new File([], 'payload.exe', { type: 'application/octet-stream' })
    expect(isVideoFile(file)).toBe(false)
    expect(isAudioFile(file)).toBe(false)
    expect(mediaKindForPath(file.name)).toBeNull()
  })
})
