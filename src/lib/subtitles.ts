import type { SubtitleCue, SubtitleStyle } from './types';

export const MAX_SUBTITLE_CUES = 10_000;
export const MAX_SUBTITLE_TEXT_LENGTH = 2_000;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: 5.2,
  color: '#ffffff',
  outlineColor: '#000000',
  background: 'transparent',
  position: 'bottom',
};

function timestampToSeconds(value: string): number | null {
  const match = value.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] ?? '').padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) return null;
  const result = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  return Number.isFinite(result) ? result : null;
}

function plainSubtitleText(lines: string[]): string {
  const value = lines
    .join('\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:b|i|u|font)(?:\s+[^>]*)?>/gi, '');
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127 || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .trim()
    .slice(0, MAX_SUBTITLE_TEXT_LENGTH);
}

/** Parse SRT or WebVTT into bounded, sorted project-timeline cues. */
export function parseSubtitleFile(text: string): SubtitleCue[] {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    if (cues.length >= MAX_SUBTITLE_CUES) break;
    const lines = block.split('\n').map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].split('-->');
    if (timing.length !== 2) continue;
    const start = timestampToSeconds(timing[0]);
    const endToken = timing[1].trim().split(/\s+/)[0];
    const end = timestampToSeconds(endToken);
    const cueText = plainSubtitleText(lines.slice(timingIndex + 1));
    if (start === null || end === null || end <= start || !cueText) continue;
    cues.push({
      id: crypto.randomUUID(),
      start,
      end,
      text: cueText,
    });
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function activeSubtitleCues(
  cues: readonly SubtitleCue[],
  time: number,
): SubtitleCue[] {
  return cues.filter((cue) => time >= cue.start && time < cue.end);
}
