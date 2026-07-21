export const MAX_SUBTITLE_CUES: number;
export function assText(value: unknown): string;
export function assTime(seconds: number): string;
export function buildAssSubtitles(
  cues: Array<{ start: number; end: number; text: string }>,
  style: Record<string, unknown> | undefined,
  width: number,
  height: number,
): string;
