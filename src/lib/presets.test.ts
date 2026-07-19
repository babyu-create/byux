import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MAX_PRESETS,
  PRESETS_STORAGE_KEY,
  applyClipLook,
  createPresetFromClip,
  deserialisePresets,
  extractClipLook,
  loadPresets,
  looksEmpty,
  savePresets,
  serialisePresets,
  type ClipPreset,
} from './presets';
import type { Clip } from './types';

function baseClip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    assetId: 'a1',
    start: 3,
    trimStart: 1,
    trimEnd: 6,
    effects: [],
    ...extra,
  };
}

function styledClip(): Clip {
  return baseClip({
    speed: 0.5,
    stretchToFill: true,
    transform: { scale: 1.2, x: 4 },
    colorGrade: { preset: 'cinema', contrast: 20 },
    transitionIn: { type: 'fade', duration: 0.4 },
    transitionOut: { type: 'zoom', duration: 0.3 },
    effects: [{ type: 'motion-blur', intensity: 40 }],
    overlays: [
      {
        id: 'ov-1',
        text: 'ACE',
        fontSize: 8,
        color: '#fff',
        position: 'bottom-center',
      },
    ],
  });
}

describe('extractClipLook', () => {
  it('captures every visual field of a styled clip', () => {
    const look = extractClipLook(styledClip());
    expect(look.speed).toBe(0.5);
    expect(look.stretchToFill).toBe(true);
    expect(look.transform).toEqual({ scale: 1.2, x: 4 });
    expect(look.colorGrade).toEqual({ preset: 'cinema', contrast: 20 });
    expect(look.transitionIn).toEqual({ type: 'fade', duration: 0.4 });
    expect(look.transitionOut).toEqual({ type: 'zoom', duration: 0.3 });
    expect(look.effects).toHaveLength(1);
    expect(look.overlays).toHaveLength(1);
  });

  it('omits identity / placement / audio fields', () => {
    const look = extractClipLook(styledClip()) as Record<string, unknown>;
    expect(look.id).toBeUndefined();
    expect(look.trackId).toBeUndefined();
    expect(look.assetId).toBeUndefined();
    expect(look.start).toBeUndefined();
    expect(look.trimStart).toBeUndefined();
    expect(look.trimEnd).toBeUndefined();
    expect(look.volume).toBeUndefined();
    expect(look.muted).toBeUndefined();
  });

  it('produces an empty look for an unstyled clip', () => {
    expect(looksEmpty(extractClipLook(baseClip()))).toBe(true);
  });

  it('deep-clones so later clip mutation does not change the saved look', () => {
    const clip = styledClip();
    const look = extractClipLook(clip);
    // Mutate the (immutable-by-convention) source structures in place.
    (clip.transform as { scale?: number }).scale = 9;
    clip.effects[0].intensity = 99;
    expect(look.transform).toEqual({ scale: 1.2, x: 4 });
    expect(look.effects?.[0].intensity).toBe(40);
  });
});

describe('applyClipLook', () => {
  it('preserves identity / placement / audio, replaces the look', () => {
    const target = baseClip({ id: 'c2', start: 10, volume: 0.5, muted: true });
    const out = applyClipLook(target, extractClipLook(styledClip()));
    expect(out.id).toBe('c2');
    expect(out.trackId).toBe('t1');
    expect(out.start).toBe(10);
    expect(out.trimStart).toBe(1);
    expect(out.trimEnd).toBe(6);
    expect(out.volume).toBe(0.5);
    expect(out.muted).toBe(true);
    expect(out.transform).toEqual({ scale: 1.2, x: 4 });
    expect(out.colorGrade).toEqual({ preset: 'cinema', contrast: 20 });
  });

  it('CLEARS fields absent from the look (exact match, no leftovers)', () => {
    const target = baseClip({
      transform: { scale: 2 },
      colorGrade: { preset: 'vivid' },
      effects: [{ type: 'fade-in', duration: 0.4 }],
    });
    // An empty look should strip everything back to neutral.
    const out = applyClipLook(target, {});
    expect(out.transform).toBeUndefined();
    expect(out.colorGrade).toBeUndefined();
    expect(out.transitionIn).toBeUndefined();
    expect(out.effects).toEqual([]);
    expect(out.overlays).toBeUndefined();
  });

  it('regenerates overlay ids so two clips never share an overlay id', () => {
    const look = extractClipLook(styledClip());
    const a = applyClipLook(baseClip({ id: 'a' }), look);
    const b = applyClipLook(baseClip({ id: 'b' }), look);
    expect(a.overlays?.[0].id).not.toBe('ov-1');
    expect(a.overlays?.[0].id).not.toBe(b.overlays?.[0].id);
    // Content is preserved.
    expect(a.overlays?.[0].text).toBe('ACE');
  });

  it('does not mutate the source clip or the look', () => {
    const look = extractClipLook(styledClip());
    const lookSnapshot = JSON.stringify(look);
    const target = baseClip();
    const targetSnapshot = JSON.stringify(target);
    applyClipLook(target, look);
    expect(JSON.stringify(look)).toBe(lookSnapshot);
    expect(JSON.stringify(target)).toBe(targetSnapshot);
  });

  it('round-trips: extract then apply reproduces the look fields', () => {
    const src = styledClip();
    const out = applyClipLook(baseClip({ id: 'x' }), extractClipLook(src));
    expect(out.speed).toBe(src.speed);
    expect(out.transform).toEqual(src.transform);
    expect(out.colorGrade).toEqual(src.colorGrade);
    expect(out.transitionIn).toEqual(src.transitionIn);
    expect(out.effects).toEqual(src.effects);
    expect(out.overlays?.[0].text).toBe(src.overlays?.[0].text);
  });
});

describe('createPresetFromClip', () => {
  it('builds a preset with a trimmed name and the clip look', () => {
    const p = createPresetFromClip(styledClip(), '  シネマ寄り  ');
    expect(p.name).toBe('シネマ寄り');
    expect(p.id).toBeTruthy();
    expect(typeof p.createdAt).toBe('number');
    expect(p.look.colorGrade).toEqual({ preset: 'cinema', contrast: 20 });
  });

  it('falls back to a default name when blank', () => {
    expect(createPresetFromClip(styledClip(), '   ').name).toBe('無題のプリセット');
  });
});

describe('serialise / deserialise presets', () => {
  function preset(id: string, createdAt: number): ClipPreset {
    return { id, name: id, createdAt, look: { colorGrade: { preset: 'warm' } } };
  }

  it('round-trips a valid library', () => {
    const presets = [preset('a', 1), preset('b', 2)];
    const parsed = deserialisePresets(serialisePresets(presets));
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('sorts newest first', () => {
    const parsed = deserialisePresets(
      serialisePresets([preset('old', 1), preset('new', 99)]),
    );
    expect(parsed[0].id).toBe('new');
  });

  it('caps the stored count at MAX_PRESETS', () => {
    const many = Array.from({ length: MAX_PRESETS + 10 }, (_, i) =>
      preset(`p${i}`, i),
    );
    const parsed = deserialisePresets(serialisePresets(many));
    expect(parsed).toHaveLength(MAX_PRESETS);
  });

  it('returns [] for null / empty / non-JSON / wrong-shape input', () => {
    expect(deserialisePresets(null)).toEqual([]);
    expect(deserialisePresets('')).toEqual([]);
    expect(deserialisePresets('{ not json')).toEqual([]);
    expect(deserialisePresets('{"not":"an array"}')).toEqual([]);
    expect(deserialisePresets('[{"id":"x"}]')).toEqual([]); // missing fields
  });

  it('rejects a preset carrying a NaN in its look (no NaN leaks)', () => {
    const bad = JSON.stringify([
      { id: 'x', name: 'x', createdAt: 1, look: { speed: 'NaN' } },
    ]);
    expect(deserialisePresets(bad)).toEqual([]);
  });
});

/**
 * Minimal in-memory localStorage shim. The Vitest environment is `node` (see
 * vitest.config.ts — the pure libs don't need jsdom), so `window.localStorage`
 * is absent; install one for the persistence tests and remove it afterward so
 * the storage-unavailable guards in loadPresets/savePresets are exercised by
 * the rest of the suite.
 */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => {
      store.set(k, String(v));
    },
    removeItem: (k: string): void => {
      store.delete(k);
    },
    clear: (): void => {
      store.clear();
    },
  };
  (globalThis as { window?: unknown }).window = { localStorage: mock };
}

describe('localStorage persistence', () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('saves and loads a library round-trip', () => {
    const p = createPresetFromClip(styledClip(), 'mine');
    savePresets([p]);
    const loaded = loadPresets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('mine');
    expect(loaded[0].look.colorGrade).toEqual({ preset: 'cinema', contrast: 20 });
  });

  it('loadPresets returns [] when nothing is stored', () => {
    expect(loadPresets()).toEqual([]);
  });

  it('loadPresets degrades to [] on a corrupt stored value', () => {
    (globalThis as unknown as {
      window: { localStorage: Storage };
    }).window.localStorage.setItem(PRESETS_STORAGE_KEY, 'corrupt!!');
    expect(loadPresets()).toEqual([]);
  });
});
