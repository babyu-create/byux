import { describe, expect, it } from 'vitest';
import {
  NativeExportPlanError,
  buildNativeExportPlan,
  collectUnsupportedFeatures,
  parseProgressText,
} from '../../electron/nativeExportPlan.cjs';

function request() {
  return {
    version: 1,
    options: {
      resolution: '720p',
      fps: 30,
      aspectRatio: '16:9',
      quality: 'recommended',
      verticalReframe: 0,
      motionBlur: false,
    },
    tracks: [
      {
        id: 'video',
        kind: 'video',
        label: '映像',
        locked: false,
        muted: false,
        hidden: false,
      },
      {
        id: 'audio',
        kind: 'audio',
        label: '音声',
        locked: false,
        muted: false,
        hidden: false,
      },
    ],
    assets: [
      {
        id: 'asset',
        name: 'source.mp4',
        kind: 'video',
        size: 1_024,
        width: 1920,
        height: 1080,
        sourceToken: 'opaque-token',
      },
    ],
    clips: [
      {
        id: 'clip',
        trackId: 'video',
        assetId: 'asset',
        start: 2,
        trimStart: 1,
        trimEnd: 5,
        speed: 2,
        volume: 0.5,
        effects: [{ type: 'fade-in', duration: 0.25 }],
      },
    ],
    markers: [],
    overlays: [],
  };
}

describe('nativeExportPlan', () => {
  it('keeps authored gaps and builds a disk-backed single-pass graph', () => {
    const source = new Map([
      ['asset', { path: 'C:\\media\\source.mp4', hasAudio: false }],
    ]);
    const plan = buildNativeExportPlan(
      request(),
      source,
      new Map(),
      'C:\\output\\.movie.part',
    );

    expect(plan.totalDuration).toBe(4);
    expect(plan.filterGraph).toContain('color=c=black:s=1280x720:r=30:d=2.0000');
    expect(plan.filterGraph).toContain('anullsrc=r=44100:cl=stereo');
    expect(plan.filterGraph).toContain('setpts=0.5000*PTS');
    expect(plan.filterGraph).toContain('fade=t=in:st=0:d=0.250');
    expect(plan.filterGraph).toContain('concat=n=2:v=1:a=1[vbase][abase]');
    expect(plan.args).toContain('-filter_complex_script');
    expect(plan.args.at(-1)).toBe('C:\\output\\.movie.part');
  });

  it('rejects renderer-only effects instead of silently dropping them', () => {
    const base = request();
    const incompatible = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        speedRamp: { from: 0.5, to: 2 },
        transform: { scale: 1.2 },
      })),
    };

    expect(collectUnsupportedFeatures(incompatible)).toEqual(
      expect.arrayContaining(['速度ランプ', 'キーフレーム/変形']),
    );
    expect(() =>
      buildNativeExportPlan(
        incompatible,
        new Map([['asset', { path: 'source.mp4', hasAudio: true }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(NativeExportPlanError);
  });

  it('requires a renderer-rasterized PNG for authored overlays', () => {
    const base = request();
    const withOverlay = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        overlays: [{
          id: 'text',
          text: 'hello',
          fontSize: 8,
          color: '#fff',
          position: 'center',
        }],
      })),
    };
    expect(() =>
      buildNativeExportPlan(
        withOverlay,
        new Map([['asset', { path: 'source.mp4', hasAudio: true }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(/テキスト画像/);
  });

  it('keeps progress monotonic and reserves one percent for validation', () => {
    const first = parseProgressText(
      'out_time_us=30000000\nspeed=2.0x\nfps=60\nprogress=continue\n',
      100,
    );
    const stale = parseProgressText(
      'out_time_us=20000000\nspeed=1.0x\nprogress=continue\n',
      100,
      first.overallProgress,
    );

    expect(first.overallProgress).toBeCloseTo(0.297);
    expect(first.etaSec).toBe(35);
    expect(stale.overallProgress).toBe(first.overallProgress);
    expect(
      parseProgressText(
        'out_time_us=100000000\nspeed=1x\nprogress=end\n',
        100,
      ).overallProgress,
    ).toBe(0.99);
  });
});
