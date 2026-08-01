import { describe, expect, it } from 'vitest';
import {
  boundedCrashSummary,
  boundedProjectSummary,
  sanitizeDiagnosticText,
} from '../../electron/diagnostics.cjs';

describe('diagnostics privacy bounds', () => {
  it('redacts local paths and media tokens', () => {
    const text = sanitizeDiagnosticText('failed C:\\Users\\alice\\Videos\\secret.mp4 fce-media://asset/abc-123');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('secret.mp4');
    expect(text).toContain('[token]');
  });

  it('keeps only bounded numeric project counts', () => {
    expect(boundedProjectSummary({ tracks: 4, clips: 20, assets: 3, subtitles: 8, durationSeconds: 12.34567, name: 'secret' })).toEqual({
      tracks: 4,
      clips: 20,
      assets: 3,
      subtitles: 8,
      durationSeconds: 12.346,
    });
  });

  it('revalidates persisted crash records before exporting them', () => {
    expect(boundedCrashSummary({
      type: 'Error',
      message: 'failed C:\\Users\\alice\\Videos\\secret.mp4',
      injected: 'must not be copied',
    })).toEqual({ type: 'Error', message: 'failed [path]' });
  });
});
