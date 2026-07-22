import { describe, expect, it } from 'vitest'
import { buildRulerTicks } from './timeline'

describe('virtualized ruler ticks', () => {
  it('keeps a seven-day timeline bounded to the visible range', () => {
    const sevenDays = 7 * 24 * 60 * 60
    const ticks = buildRulerTicks(sevenDays, 1, 100_000, 100_060)

    expect(ticks.length).toBeLessThan(100)
    expect(ticks[0].time).toBeGreaterThanOrEqual(100_000)
    expect(ticks.at(-1)?.time).toBeLessThanOrEqual(100_060)
  })

  it('aligns partial visible ranges to stable global tick boundaries', () => {
    const ticks = buildRulerTicks(7_200, 1, 42.4, 47.2)

    expect(ticks.map((tick) => tick.time)).toEqual([42, 43, 44, 45, 46, 47, 48])
    expect(ticks.find((tick) => tick.time === 45)).toMatchObject({
      major: true,
      label: '0:45',
    })
  })
})
