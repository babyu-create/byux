import { describe, expect, it } from 'vitest';
import { parseInputMediaStreams } from '../../electron/nativeFfmpeg.cjs';

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
