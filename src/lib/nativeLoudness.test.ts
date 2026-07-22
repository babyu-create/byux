import { describe, expect, it } from 'vitest';
import {
  buildLoudnessFfmpegArgs,
  parseLoudnessSummary,
} from '../../electron/nativeLoudness.cjs';

describe('native loudness analysis', () => {
  it('builds a bounded metadata-only EBU R128 pass', () => {
    const args = buildLoudnessFfmpegArgs('C:\\media\\source.mp4');
    expect(args).toContain('ebur128=peak=true:framelog=quiet');
    expect(args).toContain('0:a:0');
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('pipe:1');
  });

  it('parses the final summary instead of an earlier measurement', () => {
    const parsed = parseLoudnessSummary(`
      I: -70.0 LUFS
      Summary:
      Integrated loudness:
        I:         -16.8 LUFS
      Loudness range:
        LRA:         7.3 LU
      True peak:
        Peak:        -0.8 dBFS
    `);
    expect(parsed).toEqual({
      integratedLufs: -16.8,
      loudnessRange: 7.3,
      truePeakDbfs: -0.8,
    });
  });

  it('rejects incomplete output', () => {
    expect(parseLoudnessSummary('Integrated loudness: I: -14.0 LUFS')).toBeNull();
  });
});
