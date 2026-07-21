import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOUDNESS_TARGET_LUFS,
  recommendLoudnessVolume,
} from './loudness';

describe('recommendLoudnessVolume', () => {
  it('targets -14 LUFS when true peak has enough headroom', () => {
    const result = recommendLoudnessVolume({
      integratedLufs: -20,
      loudnessRange: 5,
      truePeakDbfs: -10,
    });
    expect(result?.targetLufs).toBe(DEFAULT_LOUDNESS_TARGET_LUFS);
    expect(result?.volume).toBeCloseTo(10 ** (6 / 20));
    expect(result?.predictedLufs).toBeCloseTo(-14);
    expect(result?.limitedByPeak).toBe(false);
  });

  it('protects -1 dBTP even when that cannot reach the loudness target', () => {
    const result = recommendLoudnessVolume({
      integratedLufs: -24,
      loudnessRange: 8,
      truePeakDbfs: -3,
    });
    expect(result?.volume).toBeCloseTo(10 ** (2 / 20));
    expect(result?.predictedTruePeakDbfs).toBeCloseTo(-1);
    expect(result?.predictedLufs).toBeCloseTo(-22);
    expect(result?.limitedByPeak).toBe(true);
  });

  it('respects the editor volume range and rejects corrupt analysis', () => {
    const limited = recommendLoudnessVolume({
      integratedLufs: -60,
      loudnessRange: 0,
      truePeakDbfs: -80,
    });
    expect(limited?.volume).toBe(2);
    expect(limited?.limitedByVolumeRange).toBe(true);
    expect(recommendLoudnessVolume({
      integratedLufs: Number.NaN,
      loudnessRange: 0,
      truePeakDbfs: -2,
    })).toBeNull();
  });
});
