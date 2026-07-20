import { describe, expect, it } from 'vitest'
import {
  decibelsToGain,
  gainToDecibels,
  recommendPeakVolume,
  waveformPeakInRange,
} from './audioLevels'

const waveform = {
  peaks: new Float32Array([0.1, 0.2, 0.8, 0.4, 0.05, 0]),
  peaksPerSecond: 2,
}

describe('audio peak levels', () => {
  it('finds the peak only inside the trimmed source range', () => {
    expect(waveformPeakInRange(waveform, 0, 1)).toBeCloseTo(0.2)
    expect(waveformPeakInRange(waveform, 1, 2)).toBeCloseTo(0.8)
  })

  it('recommends an absolute gain for a -1 dB sample peak', () => {
    const result = recommendPeakVolume(waveform, 1, 2)

    expect(result?.sourcePeak).toBeCloseTo(0.8)
    expect(result?.targetPeak).toBeCloseTo(decibelsToGain(-1))
    expect(result?.volume).toBeCloseTo(decibelsToGain(-1) / 0.8)
    expect(result?.capped).toBe(false)
  })

  it('caps very quiet material at the clip gain limit', () => {
    const result = recommendPeakVolume(waveform, 2, 2.5)

    expect(result).toMatchObject({ volume: 2, capped: true })
  })

  it('does not recommend gain for silence and formats zero as no dB value', () => {
    expect(recommendPeakVolume(waveform, 2.5, 3)).toBeNull()
    expect(gainToDecibels(0)).toBeNull()
    expect(gainToDecibels(decibelsToGain(-6))).toBeCloseTo(-6)
  })
})
