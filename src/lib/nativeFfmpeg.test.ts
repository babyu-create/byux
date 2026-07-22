import { describe, expect, it } from 'vitest';
import {
  buildSegmentPlan,
  parseDuration,
  parseInputMediaStreams,
} from '../../electron/nativeFfmpeg.cjs';

describe('native media stream probing', () => {
  it('classifies a video container with audio as video', () => {
    expect(parseInputMediaStreams(`Stream #0:0: Video: h264\nStream #0:1(jpn): Audio: aac`)).toEqual({
      hasVideo: true,
      hasAudio: true,
      kind: 'video',
    });
  });

  it('classifies audio-only input without trusting the extension', () => {
    expect(parseInputMediaStreams('Stream #0:0: Audio: pcm_s16le')).toEqual({
      hasVideo: false,
      hasAudio: true,
      kind: 'audio',
    });
  });

  it('rejects files with no media streams', () => {
    expect(parseInputMediaStreams('Invalid data found when processing input').kind).toBeNull();
  });
});

describe('repair proxy planning', () => {
  it('resets the decoder at every repair boundary without a zero-length tail', () => {
    expect(buildSegmentPlan(20, 10)).toEqual([
      { start: 0, duration: 10 },
      { start: 10, duration: 10 },
    ]);
    expect(buildSegmentPlan(20.25, 10)).toEqual([
      { start: 0, duration: 10 },
      { start: 10, duration: 10 },
      { start: 20, duration: 0.25 },
    ]);
  });

  it('rejects invalid segment plans', () => {
    expect(buildSegmentPlan(0, 10)).toEqual([]);
    expect(buildSegmentPlan(60, 0)).toEqual([]);
    expect(buildSegmentPlan(Number.NaN, 10)).toEqual([]);
  });

  it('parses the source duration reported by FFmpeg', () => {
    expect(parseDuration('Duration: 00:02:20.46, start: 0.000000')).toBeCloseTo(140.46);
    expect(parseDuration('Duration: N/A')).toBeNull();
  });
});
