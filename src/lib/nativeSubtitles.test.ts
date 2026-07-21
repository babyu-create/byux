import { describe, expect, it } from 'vitest';
import { assText, assTime, buildAssSubtitles } from '../../electron/nativeSubtitles.cjs';

describe('native ASS subtitles', () => {
  it('formats long timestamps without a 24 hour rollover', () => {
    expect(assTime(3_661.239)).toBe('1:01:01.24');
  });

  it('neutralizes ASS override injection and preserves line breaks', () => {
    expect(assText('{\\pos(0,0)}A\nB')).toBe('｛＼pos(0,0)｝A\\NB');
  });

  it('builds bounded ASS events with requested placement', () => {
    const ass = buildAssSubtitles(
      [{ start: 1, end: 2.5, text: 'hello' }],
      { fontSize: 5, color: '#ffffff', outlineColor: '#000000', background: 'transparent', position: 'top' },
      1920,
      1080,
    );
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain(',8,96,96,76,1');
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:02.50');
  });
});
