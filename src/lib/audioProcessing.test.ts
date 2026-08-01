import { describe, expect, it } from 'vitest';
import { ffmpegAudioProcessingFilters, hasAudioProcessing, resolveAudioProcessing } from './audioProcessing';

describe('audio processing', () => {
  it('clamps untrusted project values', () => {
    expect(resolveAudioProcessing({ highPassHz: 999, lowGainDb: -30, midGainDb: 4, highGainDb: 30 })).toMatchObject({
      highPassHz: 300,
      lowGainDb: -12,
      midGainDb: 4,
      highGainDb: 12,
    });
  });

  it('builds only enabled FFmpeg filters', () => {
    const filters = ffmpegAudioProcessingFilters({ highPassHz: 80, midGainDb: 3, compressor: true });
    expect(filters).toEqual([
      'highpass=f=80',
      'equalizer=f=1000:t=q:w=1:g=3.00',
      'acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=1.2',
    ]);
    expect(hasAudioProcessing({})).toBe(false);
  });
});
