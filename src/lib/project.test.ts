import { describe, it, expect } from 'vitest';
import {
  parseProjectFile,
  buildAssetIdMap,
  remapClipAssetIds,
  type ProjectFile,
  type ProjectAssetRef,
} from './project';
import type { Clip, MediaAsset } from './types';

function validProject(): ProjectFile {
  return {
    version: 1,
    app: 'highlight-maker',
    name: 'test',
    aspectRatio: '16:9',
    fps: 60,
    resolution: '1080p',
    tracks: [{ id: 't1', kind: 'video', label: 'V', locked: false, muted: false, hidden: false }],
    clips: [{ id: 'c1', trackId: 't1', assetId: 'a1', start: 0, trimStart: 0, trimEnd: 5, effects: [] }],
    markers: [],
    ioRanges: [],
    preRollSec: 0,
    postRollSec: 0,
    assets: [{ id: 'a1', name: 'clip.mp4', size: 1234, kind: 'video', duration: 5 }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('parseProjectFile', () => {
  it('accepts a well-formed project and round-trips the data', () => {
    const parsed = parseProjectFile(JSON.stringify(validProject()));
    expect(parsed.name).toBe('test');
    expect(parsed.clips).toHaveLength(1);
    expect(parsed.clips[0].trimEnd).toBe(5);
  });

  it('accepts the legacy app identifier', () => {
    const p = { ...validProject(), app: 'fps-clip-editor' as const };
    expect(() => parseProjectFile(JSON.stringify(p))).not.toThrow();
  });

  it('rejects non-JSON text', () => {
    expect(() => parseProjectFile('{ not json')).toThrow();
  });

  it('rejects a file from a different app', () => {
    const p = { ...validProject(), app: 'some-other-tool' };
    expect(() => parseProjectFile(JSON.stringify(p))).toThrow(/プロジェクトファイル/);
  });

  it('rejects an unsupported version', () => {
    const p = { ...validProject(), version: 2 };
    expect(() => parseProjectFile(JSON.stringify(p))).toThrow(/バージョン/);
  });

  it('rejects a structurally invalid file (missing clips array)', () => {
    const p: Record<string, unknown> = { ...validProject() };
    delete p.clips;
    expect(() => parseProjectFile(JSON.stringify(p))).toThrow(/形式が不正/);
  });

  it('rejects a non-numeric trim value (would corrupt the filter graph)', () => {
    const p = validProject();
    // simulate a hand-edited file with a string where a number is expected
    const broken = JSON.parse(JSON.stringify(p));
    broken.clips[0].trimStart = 'oops';
    expect(() => parseProjectFile(JSON.stringify(broken))).toThrow(/形式が不正/);
  });

  it('accepts an optional clip colorGrade and round-trips it', () => {
    const p = validProject();
    p.clips[0].colorGrade = {
      preset: 'cinema',
      exposure: 10,
      contrast: -5,
      saturation: 8,
      temperature: 20,
    };
    const parsed = parseProjectFile(JSON.stringify(p));
    expect(parsed.clips[0].colorGrade?.preset).toBe('cinema');
    expect(parsed.clips[0].colorGrade?.temperature).toBe(20);
  });

  it('stays valid for a clip WITHOUT a colorGrade (backward compatible)', () => {
    const parsed = parseProjectFile(JSON.stringify(validProject()));
    expect(parsed.clips[0].colorGrade).toBeUndefined();
  });

  it('rejects an unknown colorGrade preset', () => {
    const p = validProject();
    const broken = JSON.parse(JSON.stringify(p));
    broken.clips[0].colorGrade = { preset: 'teal-orange' };
    expect(() => parseProjectFile(JSON.stringify(broken))).toThrow(/形式が不正/);
  });

  it('accepts optional overlay decoration + intro fields and round-trips them', () => {
    const p = validProject();
    p.clips[0].overlays = [
      {
        id: 'ov1',
        text: 'KILL',
        fontSize: 8,
        color: '#ffffff',
        position: 'bottom-center',
        outline: true,
        decoration: 'gradient',
        decorationColor: '#00ffcc',
        strokeWidth: 0.12,
        intro: 'slide-up',
        introDuration: 0.5,
      },
    ];
    const parsed = parseProjectFile(JSON.stringify(p));
    const ov = parsed.clips[0].overlays?.[0];
    expect(ov?.decoration).toBe('gradient');
    expect(ov?.decorationColor).toBe('#00ffcc');
    expect(ov?.strokeWidth).toBe(0.12);
    expect(ov?.intro).toBe('slide-up');
    expect(ov?.introDuration).toBe(0.5);
  });

  it('stays valid for a legacy overlay WITHOUT the new fields (backward compatible)', () => {
    const p = validProject();
    p.clips[0].overlays = [
      { id: 'ov1', text: 'X', fontSize: 8, color: '#fff', position: 'center' },
    ];
    const parsed = parseProjectFile(JSON.stringify(p));
    const ov = parsed.clips[0].overlays?.[0];
    expect(ov?.decoration).toBeUndefined();
    expect(ov?.intro).toBeUndefined();
  });

  it('rejects an unknown overlay intro kind', () => {
    const p = validProject();
    const broken = JSON.parse(JSON.stringify(p));
    broken.clips[0].overlays = [
      { id: 'ov1', text: 'X', fontSize: 8, color: '#fff', position: 'center', intro: 'spin' },
    ];
    expect(() => parseProjectFile(JSON.stringify(broken))).toThrow(/形式が不正/);
  });

  it('accepts an optional project audioDucking and round-trips it', () => {
    const p = { ...validProject(), audioDucking: { enabled: true, amountDb: 12, attack: 0.12, release: 0.45 } };
    const parsed = parseProjectFile(JSON.stringify(p));
    expect(parsed.audioDucking?.enabled).toBe(true);
    expect(parsed.audioDucking?.amountDb).toBe(12);
    expect(parsed.audioDucking?.release).toBe(0.45);
  });

  it('stays valid for a project WITHOUT audioDucking (backward compatible)', () => {
    const parsed = parseProjectFile(JSON.stringify(validProject()));
    expect(parsed.audioDucking).toBeUndefined();
  });

  it('rejects a structurally invalid audioDucking (non-numeric amount)', () => {
    const broken = JSON.parse(JSON.stringify(validProject()));
    broken.audioDucking = { enabled: true, amountDb: 'loud', attack: 0.1, release: 0.4 };
    expect(() => parseProjectFile(JSON.stringify(broken))).toThrow(/形式が不正/);
  });
});

describe('buildAssetIdMap', () => {
  const projAssets: ProjectAssetRef[] = [
    { id: 'p1', name: 'a.mp4', size: 100, kind: 'video', duration: 3 },
    { id: 'p2', name: 'b.mp3', size: 200, kind: 'audio', duration: 9 },
  ];
  const makeAsset = (id: string, name: string, size: number): MediaAsset => ({
    id, name, kind: 'video', url: '', file: { name, size } as File, duration: 0,
  });

  it('maps by name + size and reports unmatched assets', () => {
    const current = [makeAsset('cur1', 'a.mp4', 100)];
    const { idMap, missingAssetIds } = buildAssetIdMap(projAssets, current);
    expect(idMap.p1).toBe('cur1');
    expect(missingAssetIds).toEqual(['p2']);
  });

  it('does not match when size differs', () => {
    const current = [makeAsset('cur1', 'a.mp4', 999)];
    const { idMap, missingAssetIds } = buildAssetIdMap(projAssets, current);
    expect(idMap.p1).toBeUndefined();
    expect(missingAssetIds).toContain('p1');
  });
});

describe('remapClipAssetIds', () => {
  it('rewrites assetIds via the map and leaves unmapped ones intact', () => {
    const clips: Clip[] = [
      { id: 'c1', trackId: 't1', assetId: 'p1', start: 0, trimStart: 0, trimEnd: 1, effects: [] },
      { id: 'c2', trackId: 't1', assetId: 'pX', start: 1, trimStart: 0, trimEnd: 1, effects: [] },
    ];
    const out = remapClipAssetIds(clips, { p1: 'cur1' });
    expect(out[0].assetId).toBe('cur1');
    expect(out[1].assetId).toBe('pX');
  });
});
