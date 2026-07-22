export const WAVEFORM_SAMPLE_RATE: number;
export const WAVEFORM_PEAKS_PER_SECOND: number;
export const MAX_WAVEFORM_PEAKS: number;

export interface WaveformMetadataAccumulator {
  push(chunk: Uint8Array | string): void;
  finish(): Float32Array;
  readonly peakCount: number;
}

export function createWaveformMetadataAccumulator(options?: {
  maxPeaks?: number;
}): WaveformMetadataAccumulator;

export function buildWaveformFfmpegArgs(sourcePath: string): string[];
