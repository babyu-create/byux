import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSubtitleCues, parseSubtitleFile } from './subtitles';

describe('subtitles', () => {
  beforeEach(() => vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'cue-id') }));

  it('parses and sorts SRT cues as plain text', () => {
    const cues = parseSubtitleFile(`2\n00:00:03,500 --> 00:00:04,750\nSecond\n\n1\n00:00:01,000 --> 00:00:02,000\n<i>First</i><br>line`);
    expect(cues).toEqual([
      { id: 'cue-id', start: 1, end: 2, text: 'First\nline' },
      { id: 'cue-id', start: 3.5, end: 4.75, text: 'Second' },
    ]);
  });

  it('accepts WebVTT settings and rejects invalid ranges', () => {
    const cues = parseSubtitleFile(`WEBVTT\n\ncue-a\n00:01.250 --> 00:03.000 align:start\nReady\n\n00:05.000 --> 00:04.000\ninvalid`);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ start: 1.25, end: 3, text: 'Ready' });
  });

  it('uses half-open cue ranges', () => {
    const cues = [{ id: 'a', start: 1, end: 2, text: 'A' }];
    expect(activeSubtitleCues(cues, 1)).toHaveLength(1);
    expect(activeSubtitleCues(cues, 2)).toHaveLength(0);
  });
});
