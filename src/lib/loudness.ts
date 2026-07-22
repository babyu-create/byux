import type { NativeLoudnessAnalysis } from './types';

export const DEFAULT_LOUDNESS_TARGET_LUFS = -14;
export const DEFAULT_TRUE_PEAK_LIMIT_DBFS = -1;
export const MAX_CLIP_VOLUME = 2;

export interface LoudnessRecommendation {
  volume: number;
  targetLufs: number;
  predictedLufs: number;
  predictedTruePeakDbfs: number;
  limitedByPeak: boolean;
  limitedByVolumeRange: boolean;
}

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(Number.EPSILON, gain));
}

export function recommendLoudnessVolume(
  analysis: NativeLoudnessAnalysis,
  targetLufs = DEFAULT_LOUDNESS_TARGET_LUFS,
  truePeakLimitDbfs = DEFAULT_TRUE_PEAK_LIMIT_DBFS,
): LoudnessRecommendation | null {
  const { integratedLufs, truePeakDbfs } = analysis;
  if (
    !Number.isFinite(integratedLufs) ||
    !Number.isFinite(truePeakDbfs) ||
    !Number.isFinite(targetLufs) ||
    !Number.isFinite(truePeakLimitDbfs) ||
    integratedLufs > 0 ||
    integratedLufs < -100 ||
    truePeakDbfs > 6 ||
    truePeakDbfs < -120
  ) {
    return null;
  }

  const loudnessGain = dbToGain(targetLufs - integratedLufs);
  const peakGain = dbToGain(truePeakLimitDbfs - truePeakDbfs);
  const safeGain = Math.max(0, Math.min(loudnessGain, peakGain));
  const volume = Math.min(MAX_CLIP_VOLUME, safeGain);
  const appliedDb = gainToDb(volume);
  return {
    volume,
    targetLufs,
    predictedLufs: integratedLufs + appliedDb,
    predictedTruePeakDbfs: truePeakDbfs + appliedDb,
    limitedByPeak: peakGain + 1e-6 < loudnessGain,
    limitedByVolumeRange: safeGain > MAX_CLIP_VOLUME + 1e-6,
  };
}
