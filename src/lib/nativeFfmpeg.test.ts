import { describe, expect, it } from 'vitest';
import {
  buildHdrToSdrFilter,
  buildBoundedSegmentPlan,
  buildSegmentPlan,
  buildVideoDecodeProbePlan,
  estimatePreviewProxyBytes,
  parseDuration,
  parseInputMediaStreams,
  parseInputVideoColorMetadata,
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
