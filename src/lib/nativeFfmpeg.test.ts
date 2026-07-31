import { describe, expect, it } from 'vitest';
import {
  buildHdrToSdrFilter,
  buildPreviewFrameRateArgs,
  buildBoundedSegmentPlan,
  buildSegmentPlan,
  buildVideoDecodeProbePlan,
  estimatePreviewProxyBytes,
  parseDuration,
  parseAudioStreams,
  parsePreferredAudioStreamIndex,
  parseInputMediaStreams,
  parseInputVideoColorMetadata,
  parseInputVideoCompatibility,
  needsChromiumPreviewProxy,
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

  it('prefers the default recording audio stream and supports MPEG-TS stream ids', () => {
    const probe = [
      'Stream #0:0[0x100]: Video: h264',
      'Stream #0:1[0x101](eng): Audio: aac, 48000 Hz, stereo',
      'Stream #0:2[0x102](jpn): Audio: aac, 48000 Hz, stereo (default)',
    ].join('\n');
    expect(parsePreferredAudioStreamIndex(probe)).toBe(1);
    expect(parseInputMediaStreams(probe)).toEqual({
      hasVideo: true,
      hasAudio: true,
      kind: 'video',
    });
  });

  it('falls back to the first audio stream when no default is declared', () => {
    expect(parsePreferredAudioStreamIndex(
      'Stream #0:3: Audio: opus\nStream #0:5: Audio: aac',
    )).toBe(0);
    expect(parsePreferredAudioStreamIndex('Stream #0:0: Video: h264')).toBeNull();
  });

  it('exposes selectable audio stream metadata in stable audio ordinals', () => {
    expect(parseAudioStreams([
      'Stream #0:0: Video: h264',
      'Stream #0:1(eng): Audio: aac, 48000 Hz, stereo',
      'Stream #0:2(jpn): Audio: opus, 44100 Hz, mono (default)',
    ].join('\n'))).toEqual([
      {
        index: 0,
        codec: 'aac',
        language: 'eng',
        sampleRate: 48000,
        channels: 'stereo',
        default: false,
      },
      {
        index: 1,
        codec: 'opus',
        language: 'jpn',
        sampleRate: 44100,
        channels: 'mono',
        default: true,
      },
    ]);
  });

  it('classifies PQ and HLG only from video color metadata', () => {
    expect(
      parseInputVideoColorMetadata(
        'Stream #0:0: Video: hevc, yuv420p10le(tv, bt2020nc/bt2020/smpte2084)',
      ),
    ).toEqual({ transfer: 'smpte2084', primaries: 'bt2020', toneMap: 'pq' });
    expect(
      parseInputVideoColorMetadata(
        'Stream #0:0: Video: hevc, yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67)',
      ),
    ).toEqual({ transfer: 'arib-std-b67', primaries: 'bt2020', toneMap: 'hlg' });
    expect(
      parseInputVideoColorMetadata(
        'Stream #0:0: Audio: pcm_s16le, metadata: smpte2084 bt2020',
      ).toneMap,
    ).toBeNull();
    expect(
      parseInputVideoColorMetadata(
        'Stream #0:0: Video: h264, yuv420p(tv, bt709)\n' +
          'Stream #0:1: Video: hevc, yuv420p10le(tv, bt2020nc/bt2020/smpte2084)',
      ).toneMap,
    ).toBeNull();
  });

  it('detects codecs, high-bit-depth formats and variable frame rate', () => {
    expect(parseInputVideoCompatibility(
      'Stream #0:0: Video: hevc, yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 1920x1080, 59.94 fps, 29.97 tbr',
    )).toMatchObject({
      codec: 'hevc',
      pixelFormat: 'yuv420p10le',
      frameRate: 59.94,
      variableFrameRate: true,
      toneMap: 'pq',
    });
    expect(parseInputVideoCompatibility(
      'Stream #0:0: Video: h264, yuv420p(tv, bt709), 1920x1080, 60 fps, 60 tbr',
    )).toMatchObject({
      codec: 'h264',
      pixelFormat: 'yuv420p',
      variableFrameRate: false,
    });
    expect(needsChromiumPreviewProxy({
      codec: 'hevc', pixelFormat: 'yuv420p10le', toneMap: 'pq',
    })).toBe(true);
    expect(needsChromiumPreviewProxy({
      codec: 'h264', pixelFormat: 'yuv420p', toneMap: null, variableFrameRate: false,
    })).toBe(false);
  });

  it('uses one shared linear-light BT.709 tone-map chain', () => {
    const pq = buildHdrToSdrFilter('pq');
    const hlg = buildHdrToSdrFilter('hlg');
    expect(pq).toContain('zscale=tin=smpte2084:t=linear:npl=100');
    expect(hlg).toContain('zscale=tin=arib-std-b67:t=linear:npl=100');
    for (const filter of [pq, hlg]) {
      expect(filter).toContain('tonemap=tonemap=hable:desat=0');
      expect(filter).toContain('zscale=p=bt709:t=bt709:m=bt709:r=tv');
      expect(filter).toMatch(/format=yuv420p$/);
    }
    expect(buildHdrToSdrFilter(null)).toBe('');
    expect(buildHdrToSdrFilter('unsafe' as never)).toBe('');
  });

  it('normalises only VFR preview proxies to a seekable CFR stream', () => {
    expect(buildPreviewFrameRateArgs(true)).toEqual(['-fps_mode', 'cfr', '-r', '60']);
    expect(buildPreviewFrameRateArgs(false)).toEqual([]);
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

  it('caps FFmpeg restarts for multi-hour repair proxies', () => {
    const twoHours = buildBoundedSegmentPlan(2 * 60 * 60, 10, 120);
    const fiveHours = buildBoundedSegmentPlan(5 * 60 * 60, 10, 120);

    expect(twoHours).toHaveLength(120);
    expect(twoHours[1].start).toBe(60);
    expect(fiveHours).toHaveLength(120);
    expect(fiveHours[1].start).toBe(150);
    expect(fiveHours.at(-1)?.duration).toBe(150);
    expect(
      fiveHours.reduce((total, segment) => total + segment.duration, 0),
    ).toBe(5 * 60 * 60);
  });

  it('keeps ten-second decoder resets for short damaged captures', () => {
    expect(buildBoundedSegmentPlan(20.25, 10, 120)).toEqual([
      { start: 0, duration: 10 },
      { start: 10, duration: 10 },
      { start: 20, duration: 0.25 },
    ]);
    expect(buildBoundedSegmentPlan(60, 10, 0)).toEqual([]);
  });

  it('parses the source duration reported by FFmpeg', () => {
    expect(parseDuration('Duration: 00:02:20.46, start: 0.000000')).toBeCloseTo(140.46);
    expect(parseDuration('Duration: N/A')).toBeNull();
  });

  it('samples the middle and late GOPs without duration-proportional work', () => {
    const oneMinute = buildVideoDecodeProbePlan(60);
    const fiveHours = buildVideoDecodeProbePlan(5 * 60 * 60);

    expect(oneMinute.map((sample) => sample.start)).toEqual([
      0,
      15,
      30,
      45,
      54,
      55,
    ]);
    expect(fiveHours).toHaveLength(oneMinute.length);
    expect(fiveHours.at(-1)).toEqual({ start: 17_995, duration: 2 });
    expect(buildVideoDecodeProbePlan(null)).toEqual([{ start: 0, duration: 2 }]);
  });

  it('estimates proxy space from the bounded output profile', () => {
    expect(estimatePreviewProxyBytes('audio', 60)).toBe(1_200_000);
    expect(estimatePreviewProxyBytes('video', 60)).toBe(60_960_000);
  });
});
