import { describe, expect, it } from 'vitest';
import { canonicalMediaName } from '../../electron/mediaReference.cjs';

describe('native media reference names', () => {
  it('derives a safe basename when a Windows drag source reports a full path as File.name', () => {
    expect(canonicalMediaName('A:\\Valorant 2026.07.20 - 16.42.11.10.DVR.mp4')).toBe(
      'Valorant 2026.07.20 - 16.42.11.10.DVR.mp4',
    );
  });

  it('rejects relative paths as media authorities', () => {
    expect(canonicalMediaName('Videos/clip.mp4')).toBeNull();
  });
});
