// Project save/load — serialise editor state to JSON.
// File-based assets cannot be embedded; instead we record asset metadata and
// match by name+size when reloading.

import { z } from 'zod';
import type {
  Clip,
  IORange,
  KillMarker,
  MediaAsset,
  Track,
} from './types';

export interface ProjectAssetRef {
  id: string;
  name: string;
  size: number;
  kind: 'video' | 'audio';
  duration: number;
}

export interface ProjectFile {
  version: 1;
  // 'fps-clip-editor' は v1.0.1 以前の旧識別子。読み込み時のみ受け入れる。
  app: 'highlight-maker' | 'fps-clip-editor';
  name: string;
  aspectRatio: '16:9' | '9:16';
  fps: 30 | 60;
  resolution: '720p' | '1080p';
  tracks: Track[];
  clips: Clip[];
  markers: KillMarker[];
  ioRanges: IORange[];
  preRollSec: number;
  postRollSec: number;
  assets: ProjectAssetRef[];
  createdAt: string;
}

export interface SerialiseInput {
  name: string;
  aspectRatio: '16:9' | '9:16';
  fps: 30 | 60;
  resolution: '720p' | '1080p';
  tracks: Track[];
  clips: Clip[];
  markers: KillMarker[];
  ioRanges: IORange[];
  preRollSec: number;
  postRollSec: number;
  assets: MediaAsset[];
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
    ioRanges: input.ioRanges,
    preRollSec: input.preRollSec,
    postRollSec: input.postRollSec,
    assets: input.assets.map((a) => ({
      id: a.id,
      name: a.name,
      size: a.file.size,
      kind: a.kind,
      duration: a.duration,
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

// IDs (asset/clip/track/range) are app-generated UUIDs or fixed track slugs.
// Constrain them to a safe alphabet so a hand-edited file can't smuggle
// filter-graph metacharacters into anything that later builds an ffmpeg arg.
const idString = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'IDの形式が不正です');

const clipEffectSchema = z.object({
  type: z.enum(['fade-in', 'fade-out', 'motion-blur']),
  duration: finiteNumber.optional(),
  intensity: finiteNumber.optional(),
});

const overlaySchema = z.object({
  id: idString,
  text: z.string(),
  fontSize: finiteNumber,
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
});

// Keyframe-animatable numeric property: a constant, or a list of keyframes.
const keyframeSchema = z.object({
  t: finiteNumber,
  value: finiteNumber,
  easing: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']).optional(),
});
const animatableSchema = z.union([finiteNumber, z.array(keyframeSchema)]);

const clipTransformSchema = z.object({
  x: animatableSchema.optional(),
  y: animatableSchema.optional(),
  scale: animatableSchema.optional(),
  rotation: animatableSchema.optional(),
  opacity: animatableSchema.optional(),
});

const clipSchema = z.object({
  id: idString,
  trackId: idString,
  assetId: idString,
  start: finiteNumber,
  trimStart: finiteNumber,
  trimEnd: finiteNumber,
  speed: finiteNumber.optional(),
  volume: finiteNumber.optional(),
  muted: z.boolean().optional(),
  stretchToFill: z.boolean().optional(),
  transform: clipTransformSchema.optional(),
  effects: z.array(clipEffectSchema),
  overlays: z.array(overlaySchema).optional(),
});

const trackSchema = z.object({
  id: idString,
  kind: z.enum(['video', 'overlay', 'audio']),
  label: z.string(),
  locked: z.boolean(),
  muted: z.boolean(),
  hidden: z.boolean(),
});

const markerSchema = z.object({
  id: idString,
  assetId: idString,
  time: finiteNumber,
  label: z.string().optional(),
});

const ioRangeSchema = z.object({
  id: idString,
  assetId: idString,
  inTime: finiteNumber,
  outTime: finiteNumber,
  label: z.string().optional(),
});

const assetRefSchema = z.object({
  id: idString,
  name: z.string(),
  size: finiteNumber,
  kind: z.enum(['video', 'audio']),
  duration: finiteNumber,
});

const projectFileSchema = z.object({
  version: z.literal(1),
  app: z.enum(['highlight-maker', 'fps-clip-editor']),
  name: z.string(),
  aspectRatio: z.enum(['16:9', '9:16']),
  fps: z.union([z.literal(30), z.literal(60)]),
  resolution: z.enum(['720p', '1080p']),
  tracks: z.array(trackSchema),
  clips: z.array(clipSchema),
  markers: z.array(markerSchema),
  ioRanges: z.array(ioRangeSchema),
  preRollSec: finiteNumber,
  postRollSec: finiteNumber,
  assets: z.array(assetRefSchema),
  createdAt: z.string(),
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
  for (const pa of projectAssets) {
    const match = currentAssets.find(
      (a) => a.name === pa.name && a.file.size === pa.size,
    );
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
