// Project save/load — serialise editor state to JSON.
// File-based assets cannot be embedded; instead we record asset metadata and
// match by name+size when reloading.

import { z } from 'zod';
import type {
  Clip,
  IORange,
  KillMarker,
  MediaAsset,
  ProjectFps,
  ProjectResolution,
  SubtitleCue,
  SubtitleStyle,
  Track,
} from './types';
import type { AudioDucking } from './audioDucking';
import type { HudPreset } from './motionBlurCore';

export interface ProjectAssetRef {
  id: string;
  name: string;
  size: number;
  kind: 'video' | 'audio';
  duration: number;
  width?: number;
  height?: number;
  /** Absolute disk path (Electron only) — enables auto-relink on load. */
  path?: string;
}

export interface ProjectFile {
  version: 1;
  // 'fps-clip-editor' は v1.0.1 以前の旧識別子。読み込み時のみ受け入れる。
  app: 'highlight-maker' | 'fps-clip-editor';
  name: string;
  aspectRatio: '16:9' | '9:16';
  fps: ProjectFps;
  resolution: ProjectResolution;
  tracks: Track[];
  clips: Clip[];
  markers: KillMarker[];
  subtitles?: SubtitleCue[];
  subtitleStyle?: SubtitleStyle;
  ioRanges: IORange[];
  preRollSec: number;
  postRollSec: number;
  assets: ProjectAssetRef[];
  createdAt: string;
  /** Optional project-level BGM auto-ducking (Phase P5). Absent in old files. */
  audioDucking?: AudioDucking;
  /** Preview/export HUD protection. Absent in old files → valorant. */
  hudPreset?: HudPreset;
  /** Horizontal crop position for vertical video. Absent in old files → 0. */
  verticalReframe?: number;
}

export interface SerialiseInput {
  name: string;
  aspectRatio: '16:9' | '9:16';
  fps: ProjectFps;
  resolution: ProjectResolution;
  tracks: Track[];
  clips: Clip[];
  markers: KillMarker[];
  subtitles?: SubtitleCue[];
  subtitleStyle?: SubtitleStyle;
  ioRanges: IORange[];
  preRollSec: number;
  postRollSec: number;
  assets: Array<MediaAsset | ProjectAssetRef>;
  /** Optional project-level BGM auto-ducking (Phase P5). */
  audioDucking?: AudioDucking;
  hudPreset: HudPreset;
  verticalReframe: number;
}

export function serialiseProject(input: SerialiseInput): ProjectFile {
  return {
    version: 1,
    app: 'highlight-maker',
    name: input.name,
    aspectRatio: input.aspectRatio,
    fps: input.fps,
    resolution: input.resolution,
    tracks: input.tracks,
    clips: input.clips,
    markers: input.markers,
    ...(input.subtitles ? { subtitles: input.subtitles } : null),
    ...(input.subtitleStyle ? { subtitleStyle: input.subtitleStyle } : null),
    ioRanges: input.ioRanges,
    preRollSec: input.preRollSec,
    postRollSec: input.postRollSec,
    // Only persist ducking when present (keeps old files byte-identical and the
    // field genuinely optional / backward compatible).
    ...(input.audioDucking ? { audioDucking: input.audioDucking } : null),
    hudPreset: input.hudPreset,
    verticalReframe: input.verticalReframe,
    assets: input.assets.map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      kind: a.kind,
      duration: a.duration,
      ...(a.width !== undefined ? { width: a.width } : null),
      ...(a.height !== undefined ? { height: a.height } : null),
      ...(a.path ? { path: a.path } : null),
    })),
    createdAt: new Date().toISOString(),
  };
}

export function downloadProjectFile(project: ProjectFile, filename?: string): void {
  const text = JSON.stringify(project, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? `${project.name || 'project'}.fce.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Structural validation -------------------------------------------------
// A project file is untrusted input (hand-edited, from another version, or a
// different tool). Its fields flow straight into React state and the ffmpeg
// filter-graph builder, so we validate the shape before trusting it instead of
// casting blindly — a missing array or a NaN trim used to throw deep in
// loadProject with no actionable message (or silently corrupt the graph).

// zod v4 dropped chainable .finite(); use a refine that rejects NaN/Infinity.
const finiteNumber = z.number().refine((n) => Number.isFinite(n), {
  message: '有限の数値が必要です',
});
const nonNegativeNumber = finiteNumber.refine((n) => n >= 0, {
  message: '0以上の数値が必要です',
});
const positiveNumber = finiteNumber.refine((n) => n > 0, {
  message: '0より大きい数値が必要です',
});
const shortString = z.string().max(512, '文字列が長すぎます');

// IDs (asset/clip/track/range) are app-generated UUIDs or fixed track slugs.
// Constrain them to a safe alphabet so a hand-edited file can't smuggle
// filter-graph metacharacters into anything that later builds an ffmpeg arg.
const idString = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'IDの形式が不正です');

const clipEffectSchema = z.object({
  type: z.enum(['fade-in', 'fade-out', 'motion-blur']),
  duration: nonNegativeNumber.optional(),
  intensity: finiteNumber.refine((n) => n >= 0 && n <= 100, {
    message: '0〜100の範囲が必要です',
  }).optional(),
});

const overlaySchema = z.object({
  id: idString,
  text: z.string().max(10_000, 'テキストが長すぎます'),
  fontSize: positiveNumber,
  color: shortString,
  position: z.enum([
    'top-left', 'top-center', 'top-right',
    'center',
    'bottom-left', 'bottom-center', 'bottom-right',
  ]),
  weight: finiteNumber.optional(),
  italic: z.boolean().optional(),
  outline: z.boolean().optional(),
  outlineColor: z.string().optional(),
  fontFamily: shortString.optional(),
  background: shortString.optional(),
  // Phase P3 decorative text + intro animation. All OPTIONAL so older projects
  // without these fields stay valid (backward compatible).
  decoration: z.enum(['none', 'glow', 'shadow', 'gradient']).optional(),
  decorationColor: shortString.optional(),
  strokeWidth: nonNegativeNumber.optional(),
  intro: z.enum(['none', 'fade', 'slide-up', 'slide-left', 'scale-in']).optional(),
  introDuration: nonNegativeNumber.optional(),
});

// Keyframe-animatable numeric property: a constant, or a list of keyframes.
const keyframeSchema = z.object({
  t: nonNegativeNumber,
  value: finiteNumber,
  easing: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']).optional(),
});
const animatableSchema = z.union([finiteNumber, z.array(keyframeSchema).max(2_000)]);

const clipTransformSchema = z.object({
  x: animatableSchema.optional(),
  y: animatableSchema.optional(),
  scale: animatableSchema.optional(),
  rotation: animatableSchema.optional(),
  opacity: animatableSchema.optional(),
});

// Optional time-varying speed ramp (slow-mo → fast). Persisted but OPTIONAL so
// older projects without a ramp stay valid (backward compatible). `from`/`to`
// are relative velocity weights (> 0); easing reuses the keyframe easing set.
const speedRampSchema = z.object({
  from: positiveNumber.refine((n) => n <= 8, { message: '8以下が必要です' }),
  to: positiveNumber.refine((n) => n <= 8, { message: '8以下が必要です' }),
  easing: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']).optional(),
});

// Optional one-click color grade (preset + fine knobs). Persisted but OPTIONAL
// so older projects without a grade stay valid (backward compatible). Fine
// knobs are validated as finite numbers; the colorGrade resolver clamps them.
const colorGradeSchema = z.object({
  preset: z.enum(['none', 'cinema', 'vivid', 'cool', 'warm', 'mono']).optional(),
  exposure: finiteNumber.optional(),
  contrast: finiteNumber.optional(),
  saturation: finiteNumber.optional(),
  temperature: finiteNumber.optional(),
});

// Optional kill-to-kill transition preset at a clip boundary (Phase P4).
// Persisted but OPTIONAL so older projects without transitions stay valid
// (backward compatible). `duration` is the boundary window in seconds; the
// transitions resolver clamps it to a safe range on use.
const clipTransitionSchema = z.object({
  type: z.enum(['none', 'cut', 'fade', 'slide', 'zoom']),
  duration: nonNegativeNumber,
});

// Optional project-level BGM auto-ducking (Phase P5). Persisted but OPTIONAL so
// older projects without it stay valid (backward compatible). The ducking
// resolver clamps amountDb / attack / release to a safe band on use.
const audioDuckingSchema = z.object({
  enabled: z.boolean(),
  amountDb: finiteNumber,
  attack: finiteNumber,
  release: finiteNumber,
});

const audioProcessingSchema = z.object({
  highPassHz: finiteNumber.refine((n) => n === 0 || (n >= 40 && n <= 300), {
    message: 'ハイパスは0または40〜300Hzが必要です',
  }).optional(),
  lowGainDb: finiteNumber.refine((n) => n >= -12 && n <= 12).optional(),
  midGainDb: finiteNumber.refine((n) => n >= -12 && n <= 12).optional(),
  highGainDb: finiteNumber.refine((n) => n >= -12 && n <= 12).optional(),
  compressor: z.boolean().optional(),
});

const clipSchema = z.object({
  id: idString,
  trackId: idString,
  assetId: idString,
  start: nonNegativeNumber,
  trimStart: nonNegativeNumber,
  trimEnd: positiveNumber,
  speed: positiveNumber.refine((n) => n >= 0.0625 && n <= 4, {
    message: '0.0625〜4の範囲が必要です',
  }).optional(),
  speedRamp: speedRampSchema.optional(),
  volume: finiteNumber.refine((n) => n >= 0 && n <= 2, {
    message: '0〜2の範囲が必要です',
  }).optional(),
  muted: z.boolean().optional(),
  audioProcessing: audioProcessingSchema.optional(),
  stretchToFill: z.boolean().optional(),
  transform: clipTransformSchema.optional(),
  colorGrade: colorGradeSchema.optional(),
  transitionIn: clipTransitionSchema.optional(),
  transitionOut: clipTransitionSchema.optional(),
  effects: z.array(clipEffectSchema).max(32),
  overlays: z.array(overlaySchema).max(100).optional(),
}).superRefine((clip, ctx) => {
  if (clip.trimEnd <= clip.trimStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['trimEnd'],
      message: 'trimEndはtrimStartより後である必要があります',
    });
  }
});

const trackSchema = z.object({
  id: idString,
  kind: z.enum(['video', 'overlay', 'audio']),
  label: shortString,
  locked: z.boolean(),
  muted: z.boolean(),
  hidden: z.boolean(),
});

const markerSchema = z.object({
  id: idString,
  assetId: idString,
  time: finiteNumber,
  label: shortString.optional(),
});

const subtitleCueSchema = z.object({
  id: idString,
  start: nonNegativeNumber,
  end: positiveNumber,
  text: z.string().min(1).max(2_000, '字幕が長すぎます'),
}).superRefine((cue, ctx) => {
  if (cue.end <= cue.start) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: '字幕の終了は開始より後である必要があります' });
  }
});

const subtitleStyleSchema = z.object({
  fontSize: finiteNumber.refine((n) => n >= 2 && n <= 12, {
    message: '字幕サイズは2〜12の範囲が必要です',
  }),
  color: z.string().max(64),
  outlineColor: z.string().max(64),
  background: z.string().max(64),
  position: z.enum(['top', 'center', 'bottom']),
});

const ioRangeSchema = z.object({
  id: idString,
  assetId: idString,
  inTime: nonNegativeNumber,
  outTime: positiveNumber,
  label: shortString.optional(),
}).superRefine((range, ctx) => {
  if (range.outTime <= range.inTime) {
    ctx.addIssue({
      code: 'custom',
      path: ['outTime'],
      message: 'outTimeはinTimeより後である必要があります',
    });
  }
});

const assetRefSchema = z.object({
  id: idString,
  name: shortString,
  size: z.number().int().safe().nonnegative(),
  kind: z.enum(['video', 'audio']),
  duration: nonNegativeNumber,
  width: positiveNumber.optional(),
  height: positiveNumber.optional(),
  path: z.string().max(32_768, 'パスが長すぎます').optional(),
});

const projectFileSchema = z.object({
  version: z.literal(1),
  app: z.enum(['highlight-maker', 'fps-clip-editor']),
  name: shortString,
  aspectRatio: z.enum(['16:9', '9:16']),
  fps: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  resolution: z.enum(['720p', '1080p', '1440p', '2160p']),
  tracks: z.array(trackSchema).max(100),
  clips: z.array(clipSchema).max(10_000),
  markers: z.array(markerSchema).max(100_000),
  subtitles: z.array(subtitleCueSchema).max(10_000).optional(),
  subtitleStyle: subtitleStyleSchema.optional(),
  ioRanges: z.array(ioRangeSchema).max(100_000),
  preRollSec: nonNegativeNumber.refine((n) => n <= 60, { message: '60秒以下が必要です' }),
  postRollSec: nonNegativeNumber.refine((n) => n <= 60, { message: '60秒以下が必要です' }),
  assets: z.array(assetRefSchema).max(10_000),
  createdAt: shortString,
  audioDucking: audioDuckingSchema.optional(),
  hudPreset: z.enum(['valorant', 'cs2', 'apex', 'none']).optional(),
  verticalReframe: finiteNumber
    .refine((n) => n >= -1 && n <= 1, { message: '-1〜1の範囲が必要です' })
    .optional(),
}).superRefine((project, ctx) => {
  const reportDuplicates = (
    values: string[],
    path: 'tracks' | 'clips' | 'markers' | 'subtitles' | 'ioRanges' | 'assets',
  ) => {
    const seen = new Set<string>();
    values.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({ code: 'custom', path: [path, index, 'id'], message: 'IDが重複しています' });
      }
      seen.add(id);
    });
  };
  reportDuplicates(project.tracks.map((item) => item.id), 'tracks');
  reportDuplicates(project.clips.map((item) => item.id), 'clips');
  reportDuplicates(project.markers.map((item) => item.id), 'markers');
  reportDuplicates((project.subtitles ?? []).map((item) => item.id), 'subtitles');
  reportDuplicates(project.ioRanges.map((item) => item.id), 'ioRanges');
  reportDuplicates(project.assets.map((item) => item.id), 'assets');

  const tracksById = new Map(project.tracks.map((track) => [track.id, track]));
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  project.clips.forEach((clip, index) => {
    const track = tracksById.get(clip.trackId);
    const asset = assetsById.get(clip.assetId);
    if (!track) {
      ctx.addIssue({
        code: 'custom',
        path: ['clips', index, 'trackId'],
        message: '参照先トラックが存在しません',
      });
    }
    if (!asset) {
      ctx.addIssue({
        code: 'custom',
        path: ['clips', index, 'assetId'],
        message: '参照先素材が存在しません',
      });
    } else {
      const compatible = asset.kind === 'audio'
        ? track?.kind === 'audio'
        : track?.kind === 'video' || track?.kind === 'overlay';
      if (track && !compatible) {
        ctx.addIssue({
          code: 'custom',
          path: ['clips', index, 'assetId'],
          message: '素材とトラックの種類が一致しません',
        });
      }
      if (clip.trimEnd > asset.duration + 1e-6) {
        ctx.addIssue({
          code: 'custom',
          path: ['clips', index, 'trimEnd'],
          message: '素材の長さを超えています',
        });
      }
    }
  });

  project.markers.forEach((marker, index) => {
    const asset = assetsById.get(marker.assetId);
    if (!asset || marker.time < 0 || marker.time > asset.duration + 1e-6) {
      ctx.addIssue({
        code: 'custom',
        path: ['markers', index, 'time'],
        message: 'マーカーの素材または時刻が不正です',
      });
    }
  });
  project.ioRanges.forEach((range, index) => {
    const asset = assetsById.get(range.assetId);
    if (!asset || range.outTime > asset.duration + 1e-6) {
      ctx.addIssue({
        code: 'custom',
        path: ['ioRanges', index, 'outTime'],
        message: 'レンジの素材または時刻が不正です',
      });
    }
  });
});

export function parseProjectFile(text: string): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('プロジェクトファイルの JSON 解析に失敗しました');
  }

  // App/version checks first so the common "wrong file" case gets a friendly
  // message instead of a wall of schema errors.
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Byux のプロジェクトファイルではありません');
  }
  const app = (raw as { app?: unknown }).app;
  if (app !== 'highlight-maker' && app !== 'fps-clip-editor') {
    throw new Error('Byux のプロジェクトファイルではありません');
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== 1) {
    throw new Error(`未対応のプロジェクトバージョン: ${String(version)}`);
  }

  const result = projectFileSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : '(ルート)';
    throw new Error(
      `プロジェクトファイルの形式が不正です: ${where} — ${issue?.message ?? '不明なエラー'}`,
    );
  }
  return result.data as ProjectFile;
}

export interface ApplyResult {
  /** Asset IDs from project that could not be matched in the current library. */
  missingAssetIds: string[];
  /** Mapping from project asset ids → current asset ids. */
  idMap: Record<string, string>;
}

export function buildAssetIdMap(
  projectAssets: ProjectAssetRef[],
  currentAssets: MediaAsset[],
): ApplyResult {
  const idMap: Record<string, string> = {};
  const missing: string[] = [];
  const byPath = new Map(
    currentAssets
      .filter((asset): asset is MediaAsset & { path: string } => !!asset.path)
      .map((asset) => [asset.path, asset]),
  );
  const byIdentity = new Map<string, MediaAsset | null>();
  for (const asset of currentAssets) {
    const key = `${asset.name}\u0000${asset.size}`;
    byIdentity.set(key, byIdentity.has(key) ? null : asset);
  }
  for (const pa of projectAssets) {
    const match =
      (pa.path ? byPath.get(pa.path) : undefined) ??
      byIdentity.get(`${pa.name}\u0000${pa.size}`);
    if (match) {
      idMap[pa.id] = match.id;
    } else {
      missing.push(pa.id);
    }
  }
  return { idMap, missingAssetIds: missing };
}

export function remapClipAssetIds(
  clips: Clip[],
  idMap: Record<string, string>,
): Clip[] {
  return clips.map((c) => ({
    ...c,
    assetId: idMap[c.assetId] ?? c.assetId,
  }));
}

export function remapMarkerAssetIds(
  markers: KillMarker[],
  idMap: Record<string, string>,
): KillMarker[] {
  return markers.map((m) => ({
    ...m,
    assetId: idMap[m.assetId] ?? m.assetId,
  }));
}

export function remapRangeAssetIds(
  ranges: IORange[],
  idMap: Record<string, string>,
): IORange[] {
  return ranges.map((r) => ({
    ...r,
    assetId: idMap[r.assetId] ?? r.assetId,
  }));
}
