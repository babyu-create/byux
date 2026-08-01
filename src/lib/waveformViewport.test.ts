import { describe, expect, it } from 'vitest'
import {
  MAX_INLINE_WAVEFORM_CSS_WIDTH,
  calculateWaveformViewport,
  waveformSourceWindow,
} from './waveformViewport'

describe('inline waveform viewport', () => {
  it('keeps a multi-hour clip canvas bounded around the visible area', () => {
    const viewport = calculateWaveformViewport(288_000, 100_000, 101_200)

    expect(viewport.visible).toBe(true)
    expect(viewport.left).toBe(99_808)
    expect(viewport.width).toBe(1_584)
    expect(viewport.width).toBeLessThanOrEqual(MAX_INLINE_WAVEFORM_CSS_WIDTH)
  })

  it('maps the virtual canvas back to the correct source-time section', () => {
    const source = waveformSourceWindow(10, 7_210, 288_000, {
      left: 100_000,
      width: 1_200,
    })

    expect(source.start).toBeCloseTo(2_510)
    expect(source.end).toBeCloseTo(2_540)
  })

  it('does not allocate a canvas for an offscreen clip', () => {
    expect(calculateWaveformViewport(100_000, -2_000, -1_000)).toEqual({
      left: 0,
      width: 1,
      visible: false,
    })
  })
})
