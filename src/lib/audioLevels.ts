export const DEFAULT_PEAK_TARGET_DB = -1;
export const MAX_CLIP_VOLUME = 2;

export interface PeakVolumeRecommendation {
  volume: number;
  sourcePeak: number;
  targetPeak: number;
  capped: boolean;
}

export function decibelsToGain(decibels: number): number {
  return 10 ** (decibels / 20);
}

export function gainToDecibels(gain: number): number | null {
  return Number.isFinite(gain) && gain > 0 ? 20 * Math.log10(gain) : null;
}

export function waveformPeakInRange(
  waveform: { peaks: Float32Array; peaksPerSecond: number },
  startSeconds: number,
  endSeconds: number,
): number {
  if (
    !Number.isFinite(waveform.peaksPerSecond) ||
    waveform.peaksPerSecond <= 0 ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    endSeconds <= startSeconds
  ) {
    return 0;
  }
  const start = Math.max(0, Math.floor(startSeconds * waveform.peaksPerSecond));
  const end = Math.min(
    waveform.peaks.length,
    Math.max(start + 1, Math.ceil(endSeconds * waveform.peaksPerSecond)),
  );
  let peak = 0;
  for (let index = start; index < end; index += 1) {
    const value = waveform.peaks[index];
    if (Number.isFinite(value) && value > peak) peak = value;
  }
  return Math.min(1, Math.max(0, peak));
}

/**
 * Recommend an absolute clip gain that brings the selected source range's
 * decoded sample peak to the target. This is intentionally peak adjustment,
 * not perceived-loudness (LUFS) normalization.
 */
export function recommendPeakVolume(
  waveform: { peaks: Float32Array; peaksPerSecond: number },
  startSeconds: number,
  endSeconds: number,
  targetDb = DEFAULT_PEAK_TARGET_DB,
  maxVolume = MAX_CLIP_VOLUME,
): PeakVolumeRecommendation | null {
  const sourcePeak = waveformPeakInRange(waveform, startSeconds, endSeconds);
  if (sourcePeak <= 0.000_001) return null;
  const targetPeak = Math.min(1, Math.max(0, decibelsToGain(targetDb)));
  const uncapped = targetPeak / sourcePeak;
  const safeMaximum = Math.max(0, maxVolume);
  return {
    volume: Math.min(safeMaximum, Math.max(0, uncapped)),
    sourcePeak,
    targetPeak,
    capped: uncapped > safeMaximum,
  };
}
