import { describe, expect, it } from 'vitest'
import {
  WAVEFORM_PEAKS_PER_SECOND,
  WAVEFORM_SAMPLE_RATE,
  buildWaveformFfmpegArgs,
  createWaveformMetadataAccumulator,
} from '../../electron/nativeWaveform.cjs'

describe('native waveform metadata accumulator', () => {
  it('converts streamed dB peak metadata to bounded linear peaks', () => {
    const accumulator = createWaveformMetadataAccumulator()
    accumulator.push(
      'frame:0 pts:0\nlavfi.astats.Overall.Peak_level=-6.020600\n' +
        'frame:1 pts:2400\nlavfi.astats.Overall.Peak_level=1.5\n' +
        'frame:2 pts:4800\nlavfi.astats.Overall.Peak_level=-inf\n',
    )

    const peaks = accumulator.finish()
    expect(peaks[0]).toBeCloseTo(0.5)
    expect(peaks[1]).toBe(1)
    expect(peaks[2]).toBe(0)
  })

  it('preserves a metadata value split across stream chunks', () => {
    const accumulator = createWaveformMetadataAccumulator()
    accumulator.push('frame:0 pts:0\nlavfi.astats.Overall.Peak_')
    accumulator.push('level=-12.0412\nframe:1 pts:2400\n')
    accumulator.push('lavfi.astats.Overall.Peak_level=-3.0')

    const peaks = accumulator.finish()
    expect(peaks).toHaveLength(2)
    expect(peaks[0]).toBeCloseTo(0.25)
    expect(peaks[1]).toBeCloseTo(10 ** (-3 / 20))
  })

  it('rejects streams that exceed the configured peak budget', () => {
    const accumulator = createWaveformMetadataAccumulator({ maxPeaks: 2 })

    expect(() =>
      accumulator.push(
        [
          'lavfi.astats.Overall.Peak_level=-1',
          'lavfi.astats.Overall.Peak_level=-2',
          'lavfi.astats.Overall.Peak_level=-3',
          '',
        ].join('\n'),
      ),
    ).toThrow(/長すぎて/)
  })

  it('builds 48 kHz windowed peak analysis with compact metadata output', () => {
    const source = 'C:\\Videos\\match recording.mp4'
    const args = buildWaveformFfmpegArgs(source)
    const filter = args[args.indexOf('-af') + 1]

    expect(WAVEFORM_SAMPLE_RATE).toBe(48_000)
    expect(WAVEFORM_PEAKS_PER_SECOND).toBe(20)
    expect(args).toContain(source)
    expect(args).toContain('0:a:0')
    expect(args).toContain('null')
    expect(filter).toContain('aresample=48000')
    expect(filter).toContain('asetnsamples=n=2400')
    expect(filter).toContain('Overall.Peak_level')
  })
})
