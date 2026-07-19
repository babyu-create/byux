// BGM auto-ducking around kill moments (Phase P5) — pure logic.
//
// Byux keeps pro features SIMPLE: instead of a full sidechain-compressor / audio
// automation NLE, the project carries a small AudioDucking setting — a one-click
// toggle + amount + attack/release — and the BGM is automatically dipped around
// each kill marker (the game's SE / kill moments). The SAME envelope drives the
// live Preview (best-effort lowering of the BGM <audio> element volume near a
// duck point) AND the WebCodecs/ffmpeg export (a `volume=...:eval=frame`
// expression on each BGM clip), so the dipped BGM in the preview matches the
// exported MP4 as closely as the two playback paths allow.
//
// No dependency on the React store or the DOM — this is pure mapping logic so it
// can be unit-tested and reused identically by both render paths (like
// clipTransform / colorGrade / speedRamp / transitions).
import { timelineTimeAtSourceTime } from './timeline';

/**
 * Project-level BGM auto-ducking setting. All numeric fields are authored in
 * intuitive units (dB / seconds) and clamped to a safe band on use, so a
 * hand-edited project file can't drive the gain negative or attack to 0.
 *
 * The duck DROPS the BGM by `amountDb` decibels (a negative gain) around each
 * kill moment, ramping DOWN over `attack` seconds before the kill and ramping
 * back UP over `release` seconds after it. Between duck points the BGM plays at
 * full level.
 *
 * Persisted but OPTIONAL so older projects without a ducking setting stay valid
 * (backward compatible — see types.ts / project.ts schema).
 */
export interface AudioDucking {
  /** Master on/off. When false the BGM plays at full level everywhere. */
  enabled: boolean;
  /** How far the BGM dips at the duck floor, in dB BELOW full (e.g. 12 = -12dB). */
  amountDb: number;
  /** Ramp-down time BEFORE the kill moment, seconds. */
  attack: number;
  /** Ramp-up time AFTER the kill moment, seconds. */
  release: number;
}

/** Safe authoring bands — clamp hand-edited / preset values on use. */
export const DUCK_MIN_AMOUNT_DB = 0;
export const DUCK_MAX_AMOUNT_DB = 40;
export const DUCK_MIN_TIME = 0.02;
export const DUCK_MAX_TIME = 3;

/** Neutral / off default (a fresh project starts with ducking disabled). */
export const DEFAULT_AUDIO_DUCKING: AudioDucking = {
  enabled: false,
  amountDb: 12,
  attack: 0.12,
  release: 0.45,
};

/**
 * One-click amount presets (how deep the dip is). Attack/release are tuned per
 * preset so the user picks a feel, not four numbers. Subtle for a barely-there
 * sidechain pump; Heavy for a hard "music gets out of the way" cut.
 */
export type DuckingPresetName = 'subtle' | 'medium' | 'heavy';

export const DUCKING_PRESETS: Record<DuckingPresetName, Omit<AudioDucking, 'enabled'>> = {
  subtle: { amountDb: 6, attack: 0.1, release: 0.35 },
  medium: { amountDb: 12, attack: 0.12, release: 0.45 },
  heavy: { amountDb: 20, attack: 0.08, release: 0.6 },
};

/** Ordered list of presets for building UI button rows. */
export const DUCKING_PRESET_ORDER: DuckingPresetName[] = ['subtle', 'medium', 'heavy'];

/** Human-facing (Japanese) label for each preset. */
export const DUCKING_PRESET_LABELS: Record<DuckingPresetName, string> = {
  subtle: '弱',
  medium: '標準',
  heavy: '強',
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Convert a decibel value to a linear amplitude gain. dB 0 → 1, -6 → ~0.5. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Resolve an AudioDucking into clamped, render-ready fields. Guarantees finite,
 * in-band numbers so both the preview and the ffmpeg expression are safe. A
 * disabled / absent setting resolves to `enabled: false` with the defaults so
 * callers can read fields without extra guards.
 */
export interface ResolvedDucking {
  enabled: boolean;
  amountDb: number;
  attack: number;
  release: number;
  /** Linear gain at the duck floor (0..1). 1 = no dip (amountDb 0). */
  floorGain: number;
}

export function resolveDucking(ducking: AudioDucking | undefined): ResolvedDucking {
  const d = ducking ?? DEFAULT_AUDIO_DUCKING;
  const amountDb = clamp(
    Number.isFinite(d.amountDb) ? d.amountDb : DEFAULT_AUDIO_DUCKING.amountDb,
    DUCK_MIN_AMOUNT_DB,
    DUCK_MAX_AMOUNT_DB,
  );
  const attack = clamp(
    Number.isFinite(d.attack) ? d.attack : DEFAULT_AUDIO_DUCKING.attack,
    DUCK_MIN_TIME,
    DUCK_MAX_TIME,
  );
  const release = clamp(
    Number.isFinite(d.release) ? d.release : DEFAULT_AUDIO_DUCKING.release,
    DUCK_MIN_TIME,
    DUCK_MAX_TIME,
  );
  return {
    enabled: d.enabled === true,
    amountDb,
    attack,
    release,
    // amountDb is a DROP, so the floor gain is -amountDb in linear terms.
    floorGain: dbToGain(-amountDb),
  };
}

/**
 * True when ducking is enabled and actually dips (amountDb > 0). Used to decide
 * whether the export needs the duck volume expression and whether the preview
 * should bother sampling the envelope (zero cost for the common off case).
 */
export function hasDucking(ducking: AudioDucking | undefined): boolean {
  if (!ducking || ducking.enabled !== true) return false;
  return Number.isFinite(ducking.amountDb) && ducking.amountDb > 1e-3;
}

/**
 * Sample the duck GAIN multiplier (0..1, 1 = full BGM) at output-timeline time
 * `t` given the sorted duck points (kill moments on the OUTPUT timeline, in
 * seconds). The envelope around each duck point is:
 *
 *   full ── ramp down (attack) ──▶ floor ── ramp up (release) ──▶ full
 *           [point-attack, point]        [point, point+release]
 *
 * Overlapping ducks take the DEEPEST dip (min gain) so two close kills don't
 * cancel out into a quieter-then-louder artifact. Linear ramps in linear-gain
 * space — simple, click-free enough for a montage, and trivially reproduced by
 * the ffmpeg `volume` expression. Pure; no allocation per call beyond locals.
 *
 * @param t          output-timeline time (seconds)
 * @param duckPoints kill moments on the output timeline (seconds), any order
 * @param resolved   resolved ducking fields (call resolveDucking first)
 */
export function duckGainAt(
  t: number,
  duckPoints: readonly number[],
  resolved: ResolvedDucking,
): number {
  if (!resolved.enabled || duckPoints.length === 0) return 1;
  const { attack, release, floorGain } = resolved;
  if (floorGain >= 1) return 1; // amountDb 0 → no dip

  let gain = 1;
  for (let i = 0; i < duckPoints.length; i++) {
    const p = duckPoints[i];
    if (!Number.isFinite(p)) continue;
    // Only the window [p - attack, p + release] is affected.
    if (t < p - attack || t > p + release) continue;
    let g: number;
    if (t < p) {
      // Attack: full → floor over [p - attack, p].
      const prog = attack > 0 ? (t - (p - attack)) / attack : 1;
      g = 1 + (floorGain - 1) * clamp(prog, 0, 1);
    } else {
      // Release: floor → full over [p, p + release].
      const prog = release > 0 ? (t - p) / release : 1;
      g = floorGain + (1 - floorGain) * clamp(prog, 0, 1);
    }
    if (g < gain) gain = g; // deepest dip wins for overlapping ducks
  }
  return gain;
}

/**
 * Project a list of SOURCE-time kill markers onto the OUTPUT timeline (the
 * concatenated, back-to-back clip windows the export produces), returning the
 * duck points in OUTPUT seconds. A marker contributes a duck point for every
 * video segment whose source range covers it (a source frame can appear in more
 * than one trimmed clip). Segments are the same {clip,start,end} windows the
 * export builds (see exporter TransformSegment), reused here so preview/export
 * agree on WHERE the kills land.
 *
 * The mapping mirrors the editor's timeline↔source convention: within a segment
 * playing at constant `speed`, output-local time = (sourceTime - trimStart) /
 * speed, offset by the segment's output start.
 *
 * @param markers   source-time kill moments grouped by assetId
 * @param segments  output-timeline video segments (clip + [start,end))
 */
export interface DuckSourceMarker {
  assetId: string;
  time: number;
}
export interface DuckSegment {
  assetId: string;
  trimStart: number;
  trimEnd: number;
  speed?: number;
  speedRamp?: import('./speedRamp').SpeedRamp;
  /** Output-timeline start (seconds). */
  start: number;
}

export function buildDuckPoints(
  markers: readonly DuckSourceMarker[],
  segments: readonly DuckSegment[],
): number[] {
  const points: number[] = [];
  for (const seg of segments) {
    for (const m of markers) {
      if (m.assetId !== seg.assetId) continue;
      if (!Number.isFinite(m.time)) continue;
      if (m.time < seg.trimStart - 1e-6 || m.time > seg.trimEnd + 1e-6) continue;
      const outT = timelineTimeAtSourceTime(
        { ...seg, start: seg.start },
        m.time,
      );
      if (Number.isFinite(outT) && outT >= 0) points.push(outT);
    }
  }
  points.sort((a, b) => a - b);
  return points;
}

/**
 * Build an ffmpeg `volume` filter expression argument (used with `eval=frame`)
 * that reproduces {@link duckGainAt} for the given duck points. The expression
 * is a product of per-point factors; each factor multiplies the channel by the
 * point's gain inside its [attack,release] window and by 1 outside it, so the
 * combined value tracks the analytic envelope. To match the "deepest dip wins"
 * rule the export keeps windows from OVERLAPPING by merging points closer than
 * (attack + release): only the nearest representative point of a cluster is
 * emitted, so the per-point factors never stack into an over-dip.
 *
 * Returns null when ducking would have no effect (disabled, no points, or a
 * zero dip) so the caller can skip adding the filter entirely. The returned
 * string is safe to embed in a filter_complex chain — it contains only digits,
 * `t`, arithmetic, `min`/`max`/`if`/`between`, and the escaped commas ffmpeg
 * needs (callers must NOT re-escape it).
 */
export function buildDuckVolumeExpr(
  duckPoints: readonly number[],
  resolved: ResolvedDucking,
): string | null {
  if (!resolved.enabled || duckPoints.length === 0) return null;
  const { attack, release, floorGain } = resolved;
  if (floorGain >= 1) return null;

  // Merge near-adjacent points so their windows don't overlap (keeps the
  // multiplicative expression from stacking dips deeper than the floor).
  const merged: number[] = [];
  const minGap = attack + release;
  const sorted = [...duckPoints].filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  for (const p of sorted) {
    if (merged.length === 0 || p - merged[merged.length - 1] >= minGap) {
      merged.push(p);
    }
  }
  if (merged.length === 0) return null;

  const f = floorGain.toFixed(5);
  const a = attack.toFixed(5);
  const r = release.toFixed(5);
  // Per-point gain g(t): floor + (1-floor)*ramp, where ramp is 0 at the floor
  // (point) and 1 at the window edges. Outside the window → 1 (no dip).
  // Commas inside ffmpeg expression functions are ESCAPED (\,) so the
  // filtergraph parser doesn't split the filter on them.
  const factors = merged.map((p) => {
    const c = p.toFixed(5);
    // attackRamp = (c-t)/a on [c-a, c]; releaseRamp = (t-c)/r on [c, c+r].
    // We build a single ramp value in [0,1] that is 0 at the point and 1 at the
    // window edges, then map: gain = floor + (1-floor)*ramp — matching duckGainAt
    // (floor AT the kill point, full at the window edges).
    const attackRamp = `((${c}-t)/${a})`;
    const releaseRamp = `((t-${c})/${r})`;
    const ramp = `if(lt(t\\,${c})\\,${attackRamp}\\,${releaseRamp})`;
    const inWindow = `between(t\\,${c}-${a}\\,${c}+${r})`;
    // Clamp the ramp to [0,1] then map to gain; outside the window → 1.
    const clampedRamp = `min(1\\,max(0\\,${ramp}))`;
    const gain = `(${f}+(1-${f})*${clampedRamp})`;
    return `(if(${inWindow}\\,${gain}\\,1))`;
  });
  // Product of factors. With non-overlapping windows at most one factor differs
  // from 1 at any t, so the product equals that factor (matches duckGainAt).
  return factors.join('*');
}
