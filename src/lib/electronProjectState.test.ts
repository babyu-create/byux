import { describe, expect, it } from 'vitest';
import {
  canonicalProject,
  maxAutosaveEnvelopeBytes,
  projectWriteError,
  shouldClearRecovery,
} from '../../electron/projectState.cjs';

const project = (name: string, createdAt: string) =>
  JSON.stringify({ version: 1, name, createdAt, clips: [] });

describe('Electron project recovery generation', () => {
  it('allows JSON envelope escaping overhead beyond exactly twice the project limit', () => {
    expect(maxAutosaveEnvelopeBytes(16 * 1024 * 1024)).toBe(
      32 * 1024 * 1024 + 64 * 1024,
    );
  });

  it('turns disk-full and permission failures into actionable save messages', () => {
    expect(projectWriteError({ code: 'ENOSPC' })).toMatch(/空き容量/);
    expect(projectWriteError({ code: 'EDQUOT' })).toMatch(/空き容量/);
    expect(projectWriteError({ code: 'EACCES' })).toMatch(/アクセス権/);
    expect(projectWriteError({ code: 'EROFS' })).toMatch(/別のフォルダー/);
    expect(projectWriteError({ code: 'UNKNOWN' }, '保存失敗')).toBe('保存失敗');
  });

  it('ignores formatting-only and createdAt differences', () => {
    const compact = project('A', 'old');
    const pretty = JSON.stringify(
      { version: 1, name: 'A', createdAt: 'new', clips: [] },
      null,
      2,
    );
    expect(canonicalProject(compact)).toBe(canonicalProject(pretty));
  });

  it('clears the autosave generation captured when save started', () => {
    expect(
      shouldClearRecovery(
        { version: 1, generation: 'g1', text: project('older C', 't1') },
        project('saved A', 't2'),
        'g1',
      ),
    ).toBe(true);
  });

  it('keeps a newer, different autosave made while save was in flight', () => {
    expect(
      shouldClearRecovery(
        { version: 1, generation: 'g2', text: project('new edit B', 't3') },
        project('saved A', 't2'),
        'g1',
      ),
    ).toBe(false);
  });

  it('clears an equivalent in-flight autosave even with a new generation', () => {
    expect(
      shouldClearRecovery(
        { version: 1, generation: 'g2', text: project('A', 'autosave') },
        project('A', 'explicit'),
        'g1',
      ),
    ).toBe(true);
  });

  it('rejects recovery data outside the supported wrapper version', () => {
    expect(
      shouldClearRecovery(
        { version: 2, generation: 'g1', text: project('A', 'old') },
        project('A', 'explicit'),
        'g1',
      ),
    ).toBe(false);
    expect(shouldClearRecovery(null, project('A', 'explicit'), null)).toBe(false);
  });
});
