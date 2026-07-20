import { describe, expect, it } from 'vitest';
import {
  NativeExportPlanError,
  buildAtempoChain,
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

describe('native atempo precision', () => {
  it('does not discard small tempo corrections at long adaptive anchors', () => {
    expect(buildAtempoChain(1.0005)).toEqual(['atempo=1.0005']);
    expect(buildAtempoChain(0.9995)).toEqual(['atempo=0.9995']);
  });

  it('keeps the composed tempo factor accurate', () => {
    const speed = 3.1415926535;
    const product = buildAtempoChain(speed).reduce((value, filter) => {
      const factor = Number(filter.split('=')[1]);
      return value * factor;
    }, 1);
    expect(Math.abs(product - speed)).toBeLessThan(1e-8);
  });
});

describe('nativeExportPlan', () => {
  it('accepts 1440p, 4K and 120 fps output presets', () => {
    const source = new Map([
      ['asset', { path: 'source.mp4', hasAudio: false }],
    ]);
    const highFps = request();
    highFps.options = { ...highFps.options, resolution: '1440p', fps: 120 };
    const highFpsPlan = buildNativeExportPlan(
      highFps,
      source,
      new Map(),
      'output.part',
    );
    expect(highFpsPlan.width).toBe(2560);
    expect(highFpsPlan.height).toBe(1440);
    expect(highFpsPlan.fps).toBe(120);

    const fourK = request();
    fourK.options = {
      ...fourK.options,
      resolution: '2160p',
      aspectRatio: '9:16',
    };
    const fourKPlan = buildNativeExportPlan(
      fourK,
      source,
      new Map(),
      'output.part',
    );
    expect(fourKPlan.width).toBe(2160);
    expect(fourKPlan.height).toBe(3840);
  });

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
    expect(plan.filterGraph).toContain('setpts=0.5*PTS');
    expect(plan.filterGraph).toContain('fade=t=in:st=0:d=0.25');
    expect(plan.filterGraph).toContain('concat=n=2:v=1:a=1[vbase0][abase]');
    expect(plan.filterGraph).not.toContain('perspective=');
    expect(plan.filterGraph).not.toContain('geq=');
    expect(plan.args).toContain('-filter_complex_script');
    expect(plan.args.at(-1)).toBe('C:\\output\\.movie.part');
  });

  it('skips an empty visible video lane when selecting the base lane', () => {
    const base = request();
    const plan = buildNativeExportPlan(
      {
        ...base,
        tracks: [
          {
            id: 'empty-video',
            kind: 'video',
            label: 'Empty',
            locked: false,
            muted: false,
            hidden: false,
          },
          ...base.tracks,
        ],
      },
      new Map([
        ['asset', { path: 'source.mp4', hasAudio: false }],
      ]),
      new Map(),
      'output.part',
    );

    expect(plan.totalDuration).toBe(4);
  });

  it('renders speed ramp, transforms, grade, transitions, blur, and upper lanes', () => {
    const base = request();
    const rich = {
      ...base,
      options: {
        ...base.options,
        motionBlur: true,
        motionBlurStrength: 0.7,
        motionBlurHudPreset: 'valorant',
        motionBlurHudMaskStrength: 0.85,
      },
      tracks: [
        ...base.tracks,
        { id: 'upper', kind: 'overlay', label: 'Upper', locked: false, muted: false, hidden: false },
      ],
      assets: [
        ...base.assets,
        { id: 'asset2', name: 'upper.mp4', kind: 'video', size: 100, width: 1920, height: 1080 },
      ],
      clips: [
        {
          ...base.clips[0],
          speedRamp: { from: 0.5, to: 2, easing: 'easeIn' },
          transform: {
            x: [{ t: 0, value: 0, easing: 'easeOut' }, { t: 2, value: 12 }],
            scale: 1.2,
          },
          colorGrade: { preset: 'cinema', saturation: 20 },
          transitionIn: { type: 'slide', duration: 0.4 },
          effects: [{ type: 'motion-blur', intensity: 70 }],
        },
        {
          ...base.clips[0],
          id: 'upper-clip',
          trackId: 'upper',
          assetId: 'asset2',
          start: 1,
          trimStart: 0,
          trimEnd: 1,
          speed: 1,
          effects: [],
        },
      ],
    };

    expect(collectUnsupportedFeatures(rich)).toEqual([]);
    const plan = buildNativeExportPlan(
      rich,
      new Map([
        ['asset', { path: 'source.mp4', hasAudio: true }],
        ['asset2', { path: 'upper.mp4', hasAudio: false }],
      ]),
      new Map(),
      'output.part',
    );
    expect(plan.filterGraph).toContain('root(');
    expect(plan.filterGraph).toContain('asplit=16');
    expect(plan.filterGraph).toContain('concat=n=16:v=0:a=1');
    expect(plan.filterGraph).toContain('perspective=');
    expect(plan.filterGraph).toContain('colorchannelmixer=');
    expect(plan.filterGraph).toContain("tmix=frames=4:weights='1 0.56 0.34 0'");
    expect(plan.filterGraph).toContain('blend=all_expr=');
    expect(plan.filterGraph).toContain('0.85*gt(');
    expect(plan.filterGraph).toContain('overlay=0:0:eof_action=pass');
    expect(plan.filterGraph).toContain('color=c=black');
  });

  it('treats a normalized hold speed ramp as the authored constant speed', () => {
    const base = request();
    const hold = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        speedRamp: { from: 0.5, to: 2, easing: 'hold' },
      })),
    };
    expect(collectUnsupportedFeatures(hold)).toEqual([]);
    const plan = buildNativeExportPlan(
      hold,
      new Map([['asset', { path: 'source.mp4', hasAudio: true }]]),
      new Map(),
      'output.part',
    );
    expect(plan.filterGraph).toContain('setpts=0.5*PTS');
    expect(plan.filterGraph).not.toContain('root(');
    expect(plan.filterGraph).not.toContain('asplit=16');
  });

  it('adds synchronization anchors as a speed-ramp clip gets longer', () => {
    const base = request();
    const longRamp = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        start: 0,
        trimStart: 0,
        trimEnd: 600,
        speed: 1,
        speedRamp: { from: 0.35, to: 2.4, easing: 'easeIn' },
      })),
    };
    const plan = buildNativeExportPlan(
      longRamp,
      new Map([['asset', { path: 'source.mp4', hasAudio: true }]]),
      new Map(),
      'output.part',
    );
    const segments = Number(/asplit=(\d+)/.exec(plan.filterGraph)?.[1]);

    expect(segments).toBeGreaterThan(16);
    expect(plan.filterGraph).toContain(`concat=n=${segments}:v=0:a=1`);
  });

  it('bounds same-event timeline error near an extreme slow ramp edge', () => {
    const base = request();
    const steepRamp = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        start: 0,
        trimStart: 0,
        trimEnd: 10,
        speed: 1,
        speedRamp: { from: 0.0001, to: 8, easing: 'linear' },
      })),
    };
    const plan = buildNativeExportPlan(
      steepRamp,
      new Map([['asset', { path: 'source.mp4', hasAudio: true }]]),
      new Map(),
      'output.part',
    );
    const segments = Number(/asplit=(\d+)/.exec(plan.filterGraph)?.[1]);

    expect(segments).toBeGreaterThan(32);
  });

  it('bounds aggregate adaptive ramp work before allocating the graph', () => {
    const base = request();
    const extreme = {
      ...base,
      clips: Array.from({ length: 3 }, (_, index) => ({
        ...base.clips[0],
        id: `ramp-${index}`,
        start: 0,
        trimStart: 0,
        trimEnd: 100_000,
        speed: 1,
        speedRamp: { from: 0.35, to: 2.4, easing: 'easeIn' },
      })),
    };

    expect(() =>
      buildNativeExportPlan(
        extreme,
        new Map([['asset', { path: 'source.mp4', hasAudio: true }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(/速度ランプ音声の精密処理/);
  });

  it('rejects a ramp that cannot meet the declared synchronization error', () => {
    const base = request();
    const extreme = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        start: 0,
        trimStart: 0,
        trimEnd: 7 * 24 * 60 * 60,
        speed: 1,
        speedRamp: { from: 0.0001, to: 8, easing: 'easeIn' },
      })),
    };

    expect(() =>
      buildNativeExportPlan(
        extreme,
        new Map([['asset', { path: 'source.mp4', hasAudio: true }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(/速度ランプが長すぎるか変化が急すぎます/);
  });

  it('bounds authored keyframe complexity before building the FFmpeg graph', () => {
    const base = request();
    const tooMany = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        transform: {
          x: Array.from({ length: 65 }, (_, index) => ({
            t: index / 100,
            value: index % 2,
          })),
        },
      })),
    };
    expect(() =>
      buildNativeExportPlan(
        tooMany,
        new Map([['asset', { path: 'source.mp4', hasAudio: true }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(NativeExportPlanError);
  });

  it('rejects aggregate keyframe complexity before allocating filter strings', () => {
    const base = request();
    const keyframes = Array.from({ length: 64 }, (_, index) => ({
      t: index / 60,
      value: index,
    }));
    const tooManyAcrossLayers = {
      ...base,
      clips: Array.from({ length: 13 }, (_, index) => ({
        ...base.clips[0],
        id: `animated-${index}`,
        transform: {
          x: keyframes,
          y: keyframes,
          scale: keyframes,
          rotation: keyframes,
          opacity: keyframes,
        },
      })),
    };

    expect(() =>
      buildNativeExportPlan(
        tooManyAcrossLayers,
        new Map([['asset', { path: 'source.mp4', hasAudio: false }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(/キーフレームが多すぎます/);
  });

  it('accepts the smoke-tested 64-key native expression boundary', () => {
    const base = request();
    const atLimit = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        effects: [],
        transform: {
          x: Array.from({ length: 64 }, (_, index) => ({
            t: index / 30,
            value: index % 2,
          })),
        },
      })),
    };
    const plan = buildNativeExportPlan(
      atLimit,
      new Map([['asset', { path: 'source.mp4', hasAudio: false }]]),
      new Map(),
      'output.part',
    );
    expect(plan.filterGraph).toContain('perspective=');
  });

  it('skips motion blur at zero intensity', () => {
    const base = request();
    const zeroBlur = {
      ...base,
      options: { ...base.options, motionBlur: true },
      clips: base.clips.map((clip) => ({
        ...clip,
        effects: [{ type: 'motion-blur', intensity: 0 }],
      })),
    };
    const plan = buildNativeExportPlan(
      zeroBlur,
      new Map([['asset', { path: 'source.mp4', hasAudio: false }]]),
      new Map(),
      'output.part',
    );
    expect(plan.filterGraph).not.toContain('tmix=');
  });

  it('flattens base opacity onto black while keeping the alpha expression', () => {
    const base = request();
    const transparentBase = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        effects: [],
        transform: { opacity: 0.2 },
      })),
    };
    const plan = buildNativeExportPlan(
      transparentBase,
      new Map([['asset', { path: 'source.mp4', hasAudio: false }]]),
      new Map(),
      'output.part',
    );
    expect(plan.filterGraph).toContain("a='alpha(X,Y)*");
    expect(plan.filterGraph).toContain('overlay=0:0:shortest=1:format=auto');
    expect(plan.filterGraph).toContain('format=yuv420p[cv1]');
  });

  it('maps duck markers through the inverse speed ramp', () => {
    const base = request();
    const withDucking = {
      ...base,
      options: {
        ...base.options,
        audioDucking: { enabled: true, amountDb: 12, attack: 0.2, release: 0.6 },
      },
      assets: [
        ...base.assets,
        { id: 'music', name: 'music.wav', kind: 'audio', size: 2_048 },
      ],
      clips: [
        {
          ...base.clips[0],
          speedRamp: { from: 0.5, to: 2, easing: 'easeIn' },
        },
        {
          id: 'music-clip',
          trackId: 'audio',
          assetId: 'music',
          start: 0,
          trimStart: 0,
          trimEnd: 4,
          speed: 1,
          volume: 1,
          effects: [],
        },
      ],
      markers: [{ id: 'kill', assetId: 'asset', time: 3 }],
    };
    const plan = buildNativeExportPlan(
      withDucking,
      new Map([
        ['asset', { path: 'source.mp4', hasAudio: false }],
        ['music', { path: 'music.wav', hasAudio: true }],
      ]),
      new Map(),
      'output.part',
    );
    // Constant-speed placement would be 3.00000; inverse ease-in is 3.36466.
    expect(plan.filterGraph).toContain('3.36466');
  });

  it('rejects invalid upper-lane time, media kind, and ramp easing at the boundary', () => {
    const base = request();
    const upperTrack = {
      id: 'upper',
      kind: 'overlay',
      label: 'Upper',
      locked: false,
      muted: false,
      hidden: false,
    };
    const invalidStart = {
      ...base,
      tracks: [...base.tracks, upperTrack],
      clips: [
        ...base.clips,
        {
          ...base.clips[0],
          id: 'upper-clip',
          trackId: 'upper',
          start: Number.NaN,
        },
      ],
    };
    expect(() =>
      buildNativeExportPlan(
        invalidStart,
        new Map([['asset', { path: 'source.mp4', hasAudio: false }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(NativeExportPlanError);

    const wrongMediaKind = {
      ...base,
      assets: base.assets.map((asset) => ({ ...asset, kind: 'audio' })),
    };
    expect(() =>
      buildNativeExportPlan(
        wrongMediaKind,
        new Map([['asset', { path: 'source.wav', hasAudio: true }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(NativeExportPlanError);

    const invalidRamp = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        speedRamp: { from: 0.5, to: 2, easing: 'bounce' },
      })),
    };
    expect(() =>
      buildNativeExportPlan(
        invalidRamp,
        new Map([['asset', { path: 'source.mp4', hasAudio: false }]]),
        new Map(),
        'output.part',
      ),
    ).toThrow(NativeExportPlanError);
  });

  it('uses CSS-style multiplicative brightness and midpoint contrast LUTs', () => {
    const base = request();
    const graded = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        effects: [],
        colorGrade: { exposure: -40, contrast: 20 },
      })),
    };
    const plan = buildNativeExportPlan(
      graded,
      new Map([['asset', { path: 'source.mp4', hasAudio: false }]]),
      new Map(),
      'output.part',
    );
    expect(plan.filterGraph).toContain("lutrgb=r='clip(val*0.8");
    expect(plan.filterGraph).toContain("(val-127.5)*1.1+127.5");
    expect(plan.filterGraph).not.toContain('eq=brightness=');

    const cssLike = (value: number) =>
      Math.max(0, Math.min(255, (value * 0.8 - 127.5) * 1.1 + 127.5));
    const emittedLuts = (value: number) => {
      const bright = Math.max(0, Math.min(255, value * 0.8));
      return Math.max(0, Math.min(255, (bright - 127.5) * 1.1 + 127.5));
    };
    for (const representative of [0, 127.5, 255]) {
      expect(Math.abs(emittedLuts(representative) - cssLike(representative))).toBeLessThan(
        1 / 255,
      );
    }
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
