// Project save/load — serialise editor state to JSON.
// File-based assets cannot be embedded; instead we record asset metadata and
// match by name+size when reloading.

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

export function parseProjectFile(text: string): ProjectFile {
  const obj = JSON.parse(text) as ProjectFile;
  if (obj.app !== 'highlight-maker' && obj.app !== 'fps-clip-editor') {
    throw new Error('FPS Clip Editor のプロジェクトファイルではありません');
  }
  if (obj.version !== 1) {
    throw new Error(`未対応のプロジェクトバージョン: ${obj.version}`);
  }
  return obj;
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
