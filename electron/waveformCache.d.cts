export const HEADER_BYTES: number;
export const MAX_CACHE_PEAKS: number;
export function encodeWaveformCache(peaks: Float32Array, peaksPerSecond: number): Uint8Array;
export function decodeWaveformCache(bytes: Uint8Array): {
  peaks: Float32Array;
  peaksPerSecond: number;
} | null;
