import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUDIO_DUCKING,
  DUCKING_PRESETS,
  DUCKING_PRESET_LABELS,
  DUCKING_PRESET_ORDER,
  DUCK_MAX_AMOUNT_DB,
  DUCK_MAX_TIME,
  DUCK_MIN_TIME,
  buildDuckPoints,
  buildDuckVolumeExpr,
  dbToGain,
  duckGainAt,
  hasDucking,
  resolveDucking,
  type AudioDucking,
  type DuckSegment,
  type DuckSourceMarker,
} from './audioDucking';

describe('dbToGain', () => {
  it('maps 0 dB to unity gain', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
  });

  it('maps -6 dB to ~half amplitude', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.501, 2);
  });

  it('maps -20 dB to 0.1 amplitude', () => {
    expect(dbToGain(-20)).toBeCloseTo(0.1, 5);
  });

  it('a deeper drop yields a smaller gain', () => {
    expect(dbToGain(-20)).toBeLessThan(dbToGain(-6));
  });
});

describe('resolveDucking', () => {
  it('resolves an absent setting to a disabled default', () => {
    const r = resolveDucking(undefined);
    expect(r.enabled).toBe(false);
    expect(r.amountDb).toBe(DEFAULT_AUDIO_DUCKING.amountDb);
  });

  it('floorGain is the linear gain of -amountDb (a drop)', () => {
    const r = resolveDucking({ enabled: true, amountDb: 6, attack: 0.1, release: 0.4 });
    expect(r.floorGain).toBeCloseTo(dbToGain(-6), 6);
    expect(r.floorGain).toBeLessThan(1);
  });

  it('clamps out-of-band amount/attack/release to the safe band', () => {
    const r = resolveDucking({
      enabled: true,
      amountDb: 10_000,
      attack: 0,
      release: 10_000,
    });
    expect(r.amountDb).toBeLessThanOrEqual(DUCK_MAX_AMOUNT_DB);
    expect(r.attack).toBeGreaterThanOrEqual(DUCK_MIN_TIME);
    expect(r.release).toBeLessThanOrEqual(DUCK_MAX_TIME);
  });

  it('replaces NaN/Infinity fields with the defaults (no NaN leaks)', () => {
    const bad = {
      enabled: true,
      amountDb: NaN,
      attack: Infinity,
      release: NaN,
    } as unknown as AudioDucking;
    const r = resolveDucking(bad);
    expect(Number.isFinite(r.amountDb)).toBe(true);
    expect(Number.isFinite(r.attack)).toBe(true);
    expect(Number.isFinite(r.release)).toBe(true);
    expect(Number.isFinite(r.floorGain)).toBe(true);
  });

  it('amountDb 0 resolves to floorGain 1 (no dip)', () => {
    const r = resolveDucking({ enabled: true, amountDb: 0, attack: 0.1, release: 0.4 });
    expect(r.floorGain).toBeCloseTo(1, 6);
  });
});

describe('hasDucking', () => {
  it('false for undefined / disabled', () => {
    expect(hasDucking(undefined)).toBe(false);
    expect(hasDucking({ enabled: false, amountDb: 12, attack: 0.1, release: 0.4 })).toBe(false);
  });

  it('false for an enabled-but-zero dip', () => {
    expect(hasDucking({ enabled: true, amountDb: 0, attack: 0.1, release: 0.4 })).toBe(false);
  });

  it('true for an enabled dip', () => {
    expect(hasDucking({ enabled: true, amountDb: 12, attack: 0.1, release: 0.4 })).toBe(true);
  });
});

describe('duckGainAt envelope', () => {
  const resolved = resolveDucking({ enabled: true, amountDb: 12, attack: 0.2, release: 0.5 });

  it('returns full gain (1) with no duck points', () => {
    expect(duckGainAt(5, [], resolved)).toBe(1);
  });

  it('returns full gain when disabled', () => {
    const off = resolveDucking({ enabled: false, amountDb: 12, attack: 0.2, release: 0.5 });
    expect(duckGainAt(5, [5], off)).toBe(1);
  });

  it('reaches the floor gain exactly at the duck point', () => {
    expect(duckGainAt(5, [5], resolved)).toBeCloseTo(resolved.floorGain, 5);
  });

  it('is full gain just before the attack window starts', () => {
    // attack = 0.2 → window starts at 4.8. At 4.79 still full.
    expect(duckGainAt(4.79, [5], resolved)).toBeCloseTo(1, 5);
  });

  it('is full gain just after the release window ends', () => {
    // release = 0.5 → window ends at 5.5. At 5.51 back to full.
    expect(duckGainAt(5.51, [5], resolved)).toBeCloseTo(1, 5);
  });

  it('ramps DOWN monotonically through the attack phase', () => {
    const before = duckGainAt(4.9, [5], resolved); // mid-attack
    const atPoint = duckGainAt(5, [5], resolved);
    expect(before).toBeGreaterThan(atPoint);
    expect(before).toBeLessThan(1);
  });

  it('ramps UP monotonically through the release phase', () => {
    const justAfter = duckGainAt(5.1, [5], resolved);
    const later = duckGainAt(5.4, [5], resolved);
    expect(later).toBeGreaterThan(justAfter);
    expect(justAfter).toBeGreaterThan(resolved.floorGain - 1e-9);
  });

  it('attack midpoint is halfway between full and floor (linear)', () => {
    const mid = duckGainAt(4.9, [5], resolved); // halfway in a 0.2s attack
    const expected = 1 + (resolved.floorGain - 1) * 0.5;
    expect(mid).toBeCloseTo(expected, 5);
  });

  it('takes the deepest dip when two ducks overlap', () => {
    // Two points 0.1s apart; between them both windows overlap. The gain at the
    // later point should equal the floor (deepest), not a blend.
    const close = [5, 5.1];
    expect(duckGainAt(5.1, close, resolved)).toBeCloseTo(resolved.floorGain, 5);
    // A time between the points should be at or below the single-point gain.
    const between = duckGainAt(5.05, close, resolved);
    const single = duckGainAt(5.05, [5], resolved);
    expect(between).toBeLessThanOrEqual(single + 1e-9);
  });

  it('ignores non-finite duck points', () => {
    expect(duckGainAt(5, [NaN, 5], resolved)).toBeCloseTo(resolved.floorGain, 5);
  });
});

describe('buildDuckPoints', () => {
  const segOf = (extra: Partial<DuckSegment>): DuckSegment => ({
    assetId: 'a1',
    trimStart: 0,
    trimEnd: 10,
    speed: 1,
    start: 0,
    ...extra,
  });

  it('maps a source marker inside a segment to its output time', () => {
    const markers: DuckSourceMarker[] = [{ assetId: 'a1', time: 4 }];
    const segs = [segOf({ trimStart: 2, trimEnd: 8, start: 100, speed: 1 })];
    // outT = start + (time - trimStart)/speed = 100 + (4-2)/1 = 102.
    expect(buildDuckPoints(markers, segs)).toEqual([102]);
  });

  it('respects clip speed in the timeline mapping', () => {
    const markers: DuckSourceMarker[] = [{ assetId: 'a1', time: 4 }];
    const segs = [segOf({ trimStart: 0, trimEnd: 8, start: 0, speed: 2 })];
    // outT = 0 + (4-0)/2 = 2.
    expect(buildDuckPoints(markers, segs)).toEqual([2]);
  });

  it('uses nonlinear source mapping for a speed-ramped clip', () => {
    const markers: DuckSourceMarker[] = [{ assetId: 'a1', time: 4 }];
    const segs = [segOf({
      trimStart: 0,
      trimEnd: 8,
      speed: 1,
      speedRamp: { from: 0.5, to: 2, easing: 'easeIn' },
    })];
    const [point] = buildDuckPoints(markers, segs);

    expect(point).toBeGreaterThan(4);
    expect(point).toBeLessThan(8);
  });

  it('drops markers outside the segment trim range', () => {
    const markers: DuckSourceMarker[] = [
      { assetId: 'a1', time: 1 },
      { assetId: 'a1', time: 9 },
    ];
    const segs = [segOf({ trimStart: 2, trimEnd: 8, start: 0 })];
    expect(buildDuckPoints(markers, segs)).toEqual([]);
  });

  it('ignores markers for a different asset', () => {
    const markers: DuckSourceMarker[] = [{ assetId: 'other', time: 4 }];
    const segs = [segOf({ trimStart: 0, trimEnd: 10, start: 0 })];
    expect(buildDuckPoints(markers, segs)).toEqual([]);
  });

  it('emits a point per segment that covers the marker (repeated source)', () => {
    const markers: DuckSourceMarker[] = [{ assetId: 'a1', time: 5 }];
    const segs = [
      segOf({ trimStart: 0, trimEnd: 10, start: 0 }),
      segOf({ trimStart: 0, trimEnd: 10, start: 20 }),
    ];
    expect(buildDuckPoints(markers, segs)).toEqual([5, 25]);
  });

  it('returns points sorted ascending', () => {
    const markers: DuckSourceMarker[] = [
      { assetId: 'a1', time: 8 },
      { assetId: 'a1', time: 3 },
    ];
    const segs = [segOf({ trimStart: 0, trimEnd: 10, start: 0 })];
    expect(buildDuckPoints(markers, segs)).toEqual([3, 8]);
  });
});

describe('buildDuckVolumeExpr', () => {
  const resolved = resolveDucking({ enabled: true, amountDb: 12, attack: 0.2, release: 0.5 });

  it('returns null when disabled / no points / zero dip', () => {
    expect(buildDuckVolumeExpr([5], resolveDucking({ enabled: false, amountDb: 12, attack: 0.2, release: 0.5 }))).toBeNull();
    expect(buildDuckVolumeExpr([], resolved)).toBeNull();
    expect(buildDuckVolumeExpr([5], resolveDucking({ enabled: true, amountDb: 0, attack: 0.2, release: 0.5 }))).toBeNull();
  });

  it('produces a non-empty expression for a real duck', () => {
    const expr = buildDuckVolumeExpr([5], resolved);
    expect(expr).toBeTruthy();
    expect(expr).toContain('between');
    expect(expr).not.toContain('NaN');
  });

  it('escapes commas for the ffmpeg filtergraph parser', () => {
    const expr = buildDuckVolumeExpr([5], resolved)!;
    // Every comma inside an ffmpeg expression function must be backslash-escaped
    // so the filtergraph parser does not split the filter on it.
    expect(expr).not.toMatch(/[^\\],/);
  });

  it('contains the floor gain as a literal', () => {
    const expr = buildDuckVolumeExpr([5], resolved)!;
    expect(expr).toContain(resolved.floorGain.toFixed(5));
  });

  it('merges near-adjacent points so windows do not overlap', () => {
    // Two points 0.1s apart, window span = attack+release = 0.7s, so the second
    // is merged away → only ONE factor (one `between`).
    const expr = buildDuckVolumeExpr([5, 5.1], resolved)!;
    expect((expr.match(/between/g) ?? []).length).toBe(1);
  });

  it('keeps separated points as distinct factors', () => {
    const expr = buildDuckVolumeExpr([5, 10], resolved)!;
    expect((expr.match(/between/g) ?? []).length).toBe(2);
  });

  // Numerically evaluate the built ffmpeg expression at a given time `t` so we
  // can assert preview/export PARITY (the existing string-shape tests pass
  // regardless of ramp direction). The ffmpeg builtins used here (if/between/
  // lt/min/max) are modeled as JS functions; un-escaping the commas then makes
  // the expression directly evaluable. The duck expression is pure arithmetic
  // (no division by zero, no side effects), so ffmpeg's lazy `if` vs JS's eager
  // argument evaluation make no difference to the result.
  const evalDuckExpr = (expr: string, t: number): number => {
    const js = expr
      .replace(/\\,/g, ',') // un-escape ffmpeg commas
      .replace(/\bif\(/g, 'ffif('); // `if` is a JS keyword → rename the call
    const ffif = (c: number, a: number, b: number) => (c ? a : b);
    const between = (x: number, lo: number, hi: number) => (x >= lo && x <= hi ? 1 : 0);
    const lt = (x: number, y: number) => (x < y ? 1 : 0);
    const fn = Function('t', 'min', 'max', 'ffif', 'between', 'lt', `return (${js});`);
    return fn(t, Math.min, Math.max, ffif, between, lt) as number;
  };

  it('matches duckGainAt across the window (preview/export parity)', () => {
    const point = 5;
    const expr = buildDuckVolumeExpr([point], resolved)!;
    // Sample densely across the full window [c-attack, c+release] and a little
    // outside it; the expression must equal duckGainAt within 1e-4 everywhere.
    let maxDiff = 0;
    for (let t = point - resolved.attack - 0.1; t <= point + resolved.release + 0.1; t += 0.01) {
      const analytic = duckGainAt(t, [point], resolved);
      const fromExpr = evalDuckExpr(expr, t);
      maxDiff = Math.max(maxDiff, Math.abs(analytic - fromExpr));
    }
    expect(maxDiff).toBeLessThan(1e-4);
  });

  it('hits the floor AT the kill point and full at the window edges (not inverted)', () => {
    const point = 5;
    const expr = buildDuckVolumeExpr([point], resolved)!;
    // At the kill point the BGM is dipped to the floor (LOUDEST is the bug).
    expect(evalDuckExpr(expr, point)).toBeCloseTo(resolved.floorGain, 4);
    // At both window edges the BGM is back to full level.
    expect(evalDuckExpr(expr, point - resolved.attack)).toBeCloseTo(1, 4);
    expect(evalDuckExpr(expr, point + resolved.release)).toBeCloseTo(1, 4);
  });
});

describe('preset metadata', () => {
  it('every ordered preset has a definition and a label', () => {
    for (const name of DUCKING_PRESET_ORDER) {
      expect(DUCKING_PRESETS[name]).toBeTruthy();
      expect(DUCKING_PRESET_LABELS[name]).toBeTruthy();
    }
  });

  it('presets get progressively deeper (subtle < medium < heavy)', () => {
    expect(DUCKING_PRESETS.subtle.amountDb).toBeLessThan(DUCKING_PRESETS.medium.amountDb);
    expect(DUCKING_PRESETS.medium.amountDb).toBeLessThan(DUCKING_PRESETS.heavy.amountDb);
  });
});
