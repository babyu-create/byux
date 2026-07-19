import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from './projectStore';
import type { Clip, Track } from '../lib/types';
import { extractClipLook } from '../lib/presets';

const TRACKS: Track[] = [
  { id: 'tv', kind: 'video', label: 'V', locked: false, muted: false, hidden: false },
  { id: 'tlock', kind: 'video', label: 'L', locked: true, muted: false, hidden: false },
];

function clip(id: string, trackId: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId,
    assetId: 'a1',
    start: 0,
    trimStart: 0,
    trimEnd: 5,
    effects: [],
    ...extra,
  };
}

describe('projectStore.applyPresetToClips', () => {
  beforeEach(() => {
    useProjectStore.setState({
      tracks: TRACKS,
      clips: [],
      selectedClipIds: [],
    });
  });

  it('applies a look to the targeted clips and returns the count', () => {
    const source = clip('src', 'tv', {
      transform: { scale: 1.5 },
      colorGrade: { preset: 'vivid' },
    });
    const target = clip('dst', 'tv');
    useProjectStore.setState({ clips: [source, target] });

    const look = extractClipLook(source);
    const applied = useProjectStore.getState().applyPresetToClips(['dst'], look);

    expect(applied).toBe(1);
    const out = useProjectStore.getState().clips.find((c) => c.id === 'dst')!;
    expect(out.transform).toEqual({ scale: 1.5 });
    expect(out.colorGrade).toEqual({ preset: 'vivid' });
    // Identity / placement untouched.
    expect(out.trackId).toBe('tv');
    expect(out.start).toBe(0);
  });

  it('skips clips on locked tracks (count excludes them)', () => {
    useProjectStore.setState({
      clips: [clip('free', 'tv'), clip('locked', 'tlock')],
    });
    const applied = useProjectStore
      .getState()
      .applyPresetToClips(['free', 'locked'], { colorGrade: { preset: 'cool' } });
    expect(applied).toBe(1);
    const locked = useProjectStore.getState().clips.find((c) => c.id === 'locked')!;
    expect(locked.colorGrade).toBeUndefined();
  });

  it('returns 0 and leaves clips unchanged when nothing matches', () => {
    const before = [clip('a', 'tv')];
    useProjectStore.setState({ clips: before });
    const applied = useProjectStore
      .getState()
      .applyPresetToClips(['missing'], { colorGrade: { preset: 'warm' } });
    expect(applied).toBe(0);
    expect(useProjectStore.getState().clips).toBe(before);
  });
});
