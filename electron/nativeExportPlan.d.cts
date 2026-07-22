export class NativeExportPlanError extends Error {
  code: string;
  details: string[];
}

export const MAX_OVERLAYS: number;

export function buildAtempoChain(speed: number): string[];

export function buildTimeline(
  clips: Array<Record<string, unknown>>,
): Array<
  | { kind: 'gap'; start: number; end: number }
  | { kind: 'clip'; start: number; end: number; clip: Record<string, unknown> }
>;

export function collectUnsupportedFeatures(request: Record<string, unknown>): string[];

export function buildNativeExportPlan(
  request: Record<string, unknown>,
  sourceByAssetId: Map<
    string,
    { path: string; hasAudio: boolean; hdrToneMap?: 'pq' | 'hlg' | null }
  >,
  overlayPathByClipId: Map<string, string>,
  outputPath: string,
  videoEncoder?: 'libx264' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf',
): {
  args: string[];
  filterGraph: string;
  totalDuration: number;
  width: number;
  height: number;
  fps: number;
  videoEncoder: string;
};

export function parseProgressText(
  text: string,
  totalDuration: number,
  previousProgress?: number,
): {
  processedSeconds: number;
  overallProgress: number;
  speed: number | null;
  fps: number | null;
  totalBytes: number | null;
  etaSec: number | null;
  ended: boolean;
};
