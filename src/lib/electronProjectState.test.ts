import { describe, expect, it } from 'vitest';
import { canonicalProject, shouldClearRecovery } from '../../electron/projectState.cjs';

const project = (name: string, createdAt: string) =>
  JSON.stringify({ version: 1, name, createdAt, clips: [] });

describe('Electron project recovery generation', () => {
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
