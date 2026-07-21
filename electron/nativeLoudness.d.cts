export const MAX_LOUDNESS_LOG_BYTES: number;

export function buildLoudnessFfmpegArgs(sourcePath: string): string[];
export function parseLoudnessSummary(stderr: string): {
  integratedLufs: number;
  loudnessRange: number;
  truePeakDbfs: number;
} | null;
