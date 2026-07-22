import { describe, expect, it } from 'vitest';
import {
  canonicalMediaName,
  revokeMediaRegistrations,
} from '../../electron/mediaReference.cjs';

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

describe('renderer media registration cleanup', () => {
  it('removes idle sources and defers leased sources until their job settles', () => {
    const idle = { leases: 0, releaseRequested: false };
    const leased = { leases: 2, releaseRequested: false };
    const registry = new Map([
      ['idle', idle],
      ['leased', leased],
    ]);

    expect(revokeMediaRegistrations(registry)).toEqual({ removed: 1, deferred: 1 });
    expect(registry.has('idle')).toBe(false);
    expect(registry.get('leased')).toBe(leased);
    expect(leased.releaseRequested).toBe(true);
  });
});
