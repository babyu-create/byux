export const BEAT_SAMPLE_RATE: number;
export const BEAT_WINDOW_SECONDS: number;
export const MAX_BEAT_COUNT: number;
export const MAX_BEAT_WINDOWS: number;

export interface BeatMetadataAccumulator {
  push(chunk: Uint8Array | string): void;
  finish(): number[];
  readonly beatCount: number;
  readonly windowCount: number;
  readonly retainedEnergyCount: number;
}

export function createBeatMetadataAccumulator(options?: {
  windowSeconds?: number;
  threshold?: number;
  minSeparationSeconds?: number;
  lookbackSeconds?: number;
  maxBeats?: number;
  maxWindows?: number;
}): BeatMetadataAccumulator;

export function buildBeatFfmpegArgs(
  sourcePath: string,
  audioStreamIndex?: number,
): string[];
