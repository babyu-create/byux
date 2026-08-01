import { describe, expect, it } from 'vitest';
import { decodeWaveformCache, encodeWaveformCache } from '../../electron/waveformCache.cjs';

describe('waveform disk cache format', () => {
  it('round-trips compact float peaks', () => {
    const encoded = encodeWaveformCache(new Float32Array([0, 0.25, 1]), 20);
    const decoded = decodeWaveformCache(encoded);
    expect(decoded?.peaksPerSecond).toBe(20);
    expect([...decoded!.peaks]).toEqual([0, 0.25, 1]);
  });

  it('rejects truncated or corrupted cache data', () => {
    const encoded = encodeWaveformCache(new Float32Array([0.5]), 20);
    expect(decodeWaveformCache(encoded.slice(0, -1))).toBeNull();
    encoded[0] = 0;
    expect(decodeWaveformCache(encoded)).toBeNull();
  });

  it('rejects unsafe peaks before writing', () => {
    expect(() => encodeWaveformCache(new Float32Array([1.1]), 20)).toThrow(/不正/);
  });
});
