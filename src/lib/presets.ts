// Clip "look" presets / montage templates (Phase P6) — pure logic + storage.
//
// Byux keeps pro features SIMPLE: instead of a full template / .mogrt economy,
// a user can save the LOOK of one clip (transform / color grade / effects /
// text overlays / boundary transitions / speed) as a named preset and apply it
// to other clips in one click — the "montage template" idea from the
// competitive research. This is the reuse path competitors monetise (Premiere
// .mogrt, DaVinci PowerBins, AviUtl scripts) reduced to its essence.
//
// This module is PURE: extracting / applying a look is a plain object
// transform with NO dependency on the React store or the DOM, so it can be
// unit-tested and reused by the store action (applyPresetToClips) and by the
// persistence layer. The persisted shape is validated with Zod because
// localStorage (and any project file that embeds presets later) is untrusted
// input — a stale / hand-edited / cross-version entry must never crash the app
// or smuggle a bad value into the render path.

import { z } from 'zod';
import type {
  Clip,
  ClipEffect,
  ColorGrade,
  ClipTransform,
  OverlayText,
} from './types';
import type { ClipTransition } from './transitions';
import type { SpeedRamp } from './speedRamp';

/**
 * The visual "look" of a clip — every field that defines how the clip is
 * rendered, WITHOUT the clip's identity / timeline placement (id, trackId,
 * assetId, start, trim). Applying a look copies these onto another clip but
 * leaves WHERE / WHAT it is untouched. Overlays carry text content too (the
 * research explicitly lists "text" as part of the saved look), but their ids
 * are regenerated on apply so two clips never share an overlay id.
 *
 * Every field is OPTIONAL: a preset can capture just a color grade, or the full
 * look. Absent fields are CLEARED on the target so applying a preset is
 * predictable ("make this clip look exactly like the preset").
 */
export interface ClipLook {
  speed?: number;
  speedRamp?: SpeedRamp;
  stretchToFill?: boolean;
  transform?: ClipTransform;
  colorGrade?: ColorGrade;
  transitionIn?: ClipTransition;
  transitionOut?: ClipTransition;
  effects?: ClipEffect[];
  overlays?: OverlayText[];
}

/** A named, saved clip look. `id` is app-generated; `name` is user-facing. */
export interface ClipPreset {
  id: string;
  name: string;
  /** Epoch ms when the preset was created (for stable newest-first ordering). */
  createdAt: number;
  look: ClipLook;
}

/** The localStorage key holding the serialised preset library (a JSON array). */
export const PRESETS_STORAGE_KEY = 'fce.presets.v1';

/** Hard cap so a runaway save loop can't bloat localStorage unboundedly. */
export const MAX_PRESETS = 50;

/** Max preset name length (trimmed) — keeps the list readable and storage small. */
export const MAX_PRESET_NAME = 60;

// --- Look extraction / application (pure) ----------------------------------

/** Deep-clone any JSON-serialisable look value so a preset never aliases live
 *  store state (mutating a clip later must not mutate a saved preset). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Extract the visual look from a clip (deep-cloned so it is independent of the
 * live clip). Identity / placement fields (id, trackId, assetId, start, trim,
 * volume, muted) are intentionally OMITTED — a look is about appearance, not
 * which footage it is or where it sits on the timeline. Volume/mute are audio
 * mixing decisions per clip, not part of the visual "montage template".
 */
export function extractClipLook(clip: Clip): ClipLook {
  const look: ClipLook = {};
  if (typeof clip.speed === 'number') look.speed = clip.speed;
  if (clip.speedRamp) look.speedRamp = cloneJson(clip.speedRamp);
  if (typeof clip.stretchToFill === 'boolean') look.stretchToFill = clip.stretchToFill;
  if (clip.transform) look.transform = cloneJson(clip.transform);
  if (clip.colorGrade) look.colorGrade = cloneJson(clip.colorGrade);
  if (clip.transitionIn) look.transitionIn = cloneJson(clip.transitionIn);
  if (clip.transitionOut) look.transitionOut = cloneJson(clip.transitionOut);
  if (clip.effects.length > 0) look.effects = cloneJson(clip.effects);
  if (clip.overlays && clip.overlays.length > 0) look.overlays = cloneJson(clip.overlays);
  return look;
}

/**
 * Return a NEW clip with the preset look applied. Identity / placement
 * (id, trackId, assetId, start, trimStart, trimEnd) and audio mix
 * (volume, muted) are preserved from the source clip. Every look field present
 * on the preset is set; every look field ABSENT on the preset is CLEARED on the
 * result, so applying a preset makes the clip look EXACTLY like it (no leftover
 * grade from a previous preset). Overlays get fresh ids so no two clips share
 * an overlay id. Pure: does not mutate `clip` or `look`.
 */
export function applyClipLook(clip: Clip, look: ClipLook): Clip {
  // Start from identity + audio fields only, then layer the look on top.
  const next: Clip = {
    id: clip.id,
    trackId: clip.trackId,
    assetId: clip.assetId,
    start: clip.start,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    effects: look.effects ? cloneJson(look.effects) : [],
  };
  if (typeof clip.volume === 'number') next.volume = clip.volume;
  if (typeof clip.muted === 'boolean') next.muted = clip.muted;

  if (typeof look.speed === 'number') next.speed = look.speed;
  if (look.speedRamp) next.speedRamp = cloneJson(look.speedRamp);
  if (typeof look.stretchToFill === 'boolean') next.stretchToFill = look.stretchToFill;
  if (look.transform) next.transform = cloneJson(look.transform);
  if (look.colorGrade) next.colorGrade = cloneJson(look.colorGrade);
  if (look.transitionIn) next.transitionIn = cloneJson(look.transitionIn);
  if (look.transitionOut) next.transitionOut = cloneJson(look.transitionOut);
  if (look.overlays) {
    next.overlays = look.overlays.map((o) => ({
      ...cloneJson(o),
      id: crypto.randomUUID(),
    }));
  }
  return next;
}

/**
 * True when a look actually carries something to apply. A clip with a default
 * (untouched) appearance produces an empty look; saving that as a preset would
 * be a no-op, so the UI can disable "save" for it.
 */
export function looksEmpty(look: ClipLook): boolean {
  return (
    look.speed === undefined &&
    look.speedRamp === undefined &&
    look.stretchToFill === undefined &&
    look.transform === undefined &&
    look.colorGrade === undefined &&
    look.transitionIn === undefined &&
    look.transitionOut === undefined &&
    (look.effects === undefined || look.effects.length === 0) &&
    (look.overlays === undefined || look.overlays.length === 0)
  );
}

/** Build a fresh preset from a clip's current look. Trims / clamps the name. */
export function createPresetFromClip(clip: Clip, name: string): ClipPreset {
  const trimmed = name.trim().slice(0, MAX_PRESET_NAME) || '無題のプリセット';
  return {
    id: crypto.randomUUID(),
    name: trimmed,
    createdAt: Date.now(),
    look: extractClipLook(clip),
  };
}

// --- Validation (untrusted localStorage / future project embedding) ---------
// zod v4 dropped chainable .finite(); reuse the project.ts pattern.
const finiteNumber = z.number().refine((n) => Number.isFinite(n), {
  message: '有限の数値が必要です',
});
const nonNegativeNumber = finiteNumber.refine((n) => n >= 0);
const positiveNumber = finiteNumber.refine((n) => n > 0);

const easingEnum = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']);

const keyframeSchema = z.object({
  t: nonNegativeNumber,
  value: finiteNumber,
  easing: easingEnum.optional(),
});
const animatableSchema = z.union([finiteNumber, z.array(keyframeSchema).max(2_000)]);

const transformSchema = z.object({
  x: animatableSchema.optional(),
  y: animatableSchema.optional(),
  scale: animatableSchema.optional(),
  rotation: animatableSchema.optional(),
  opacity: animatableSchema.optional(),
});

const colorGradeSchema = z.object({
  preset: z.enum(['none', 'cinema', 'vivid', 'cool', 'warm', 'mono']).optional(),
  exposure: finiteNumber.optional(),
  contrast: finiteNumber.optional(),
  saturation: finiteNumber.optional(),
  temperature: finiteNumber.optional(),
});

const speedRampSchema = z.object({
  from: positiveNumber.refine((n) => n <= 8),
  to: positiveNumber.refine((n) => n <= 8),
  easing: easingEnum.optional(),
});

const transitionSchema = z.object({
  type: z.enum(['none', 'cut', 'fade', 'slide', 'zoom']),
  duration: nonNegativeNumber,
});

const effectSchema = z.object({
  type: z.enum(['fade-in', 'fade-out', 'motion-blur']),
  duration: nonNegativeNumber.optional(),
  intensity: finiteNumber.refine((n) => n >= 0 && n <= 100).optional(),
});

const overlaySchema = z.object({
  // Overlay ids are regenerated on apply, so accept any non-empty string here
  // (a hand-edited preset shouldn't be rejected for an odd id it won't keep).
  id: z.string().min(1),
  text: z.string(),
  fontSize: positiveNumber,
  color: z.string(),
  position: z.enum([
    'top-left', 'top-center', 'top-right',
    'center',
    'bottom-left', 'bottom-center', 'bottom-right',
  ]),
  weight: finiteNumber.optional(),
  italic: z.boolean().optional(),
  outline: z.boolean().optional(),
  outlineColor: z.string().optional(),
  fontFamily: z.string().optional(),
  background: z.string().optional(),
  decoration: z.enum(['none', 'glow', 'shadow', 'gradient']).optional(),
  decorationColor: z.string().optional(),
  strokeWidth: nonNegativeNumber.optional(),
  intro: z.enum(['none', 'fade', 'slide-up', 'slide-left', 'scale-in']).optional(),
  introDuration: nonNegativeNumber.optional(),
});

const lookSchema = z.object({
  speed: finiteNumber.refine((n) => n >= 0.0625 && n <= 4).optional(),
  speedRamp: speedRampSchema.optional(),
  stretchToFill: z.boolean().optional(),
  transform: transformSchema.optional(),
  colorGrade: colorGradeSchema.optional(),
  transitionIn: transitionSchema.optional(),
  transitionOut: transitionSchema.optional(),
  effects: z.array(effectSchema).max(32).optional(),
  overlays: z.array(overlaySchema).max(100).optional(),
});

export function isValidClipLook(value: unknown): value is ClipLook {
  return lookSchema.safeParse(value).success;
}

const presetSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  createdAt: finiteNumber,
  look: lookSchema,
});

const presetArraySchema = z.array(presetSchema);

/**
 * Serialise a preset library to a JSON string for localStorage. Newest first
 * and capped to MAX_PRESETS so the stored payload stays bounded.
 */
export function serialisePresets(presets: readonly ClipPreset[]): string {
  const bounded = [...presets]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_PRESETS);
  return JSON.stringify(bounded);
}

/**
 * Parse a preset library from a JSON string. Returns a clean array on success.
 * Invalid / corrupt / wrong-shape input yields an EMPTY array (never throws) so
 * a bad localStorage entry degrades gracefully instead of breaking the editor.
 */
export function deserialisePresets(text: string | null | undefined): ClipPreset[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const result = presetArraySchema.safeParse(raw);
  if (!result.success) return [];
  return (result.data as ClipPreset[])
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_PRESETS);
}

// --- localStorage persistence (thin, SSR/Node-safe) -------------------------

/** Load the saved preset library. Empty when storage is unavailable / empty. */
export function loadPresets(): ClipPreset[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    return deserialisePresets(window.localStorage.getItem(PRESETS_STORAGE_KEY));
  } catch {
    return [];
  }
}

/** Persist the preset library (best-effort; swallows quota / privacy errors). */
export function savePresets(presets: readonly ClipPreset[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(PRESETS_STORAGE_KEY, serialisePresets(presets));
  } catch {
    // Storage full / disabled (private mode) — keep the in-memory list working.
  }
}
