import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportInput, ExportOptions } from './exporter';
import type { Clip, MediaAsset, Track } from './types';

const rasterizeOverlaysMock = vi.hoisted(() => vi.fn());

vi.mock('./overlayRaster', () => ({
  rasterizeOverlays: rasterizeOverlaysMock,
}));

import {
  getNativeExportCompatibility,
  prepareNativeExportRequest,
} from './nativeExporter';

const VIDEO_TRACK: Track = {
  id: 'video',
  kind: 'video',
  label: '映像',
  locked: false,
  muted: false,
  hidden: false,
};

const AUDIO_TRACK: Track = {
  id: 'audio',
  kind: 'audio',
  label: '音声',
  locked: false,
  muted: false,
  hidden: false,
};

function makeClip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    trackId: VIDEO_TRACK.id,
    assetId: 'asset-1',
    start: 0,
    trimStart: 0,
    trimEnd: 2,
    effects: [],
    ...extra,
  };
}

function makeAsset(extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    name: 'source.mp4',
    kind: 'video',
    url: 'blob:source',
    size: 1024,
    mimeType: 'video/mp4',
    duration: 10,
    width: 1920,
    height: 1080,
    sourceToken: 'existing-token',
    ...extra,
  };
}

function makeInput(
  clips: Clip[] = [makeClip()],
  assets: MediaAsset[] = [makeAsset()],
  tracks: Track[] = [VIDEO_TRACK, AUDIO_TRACK],
): ExportInput {
  return {
    clips,
    tracks,
    assets,
    markers: [{ id: 'marker-1', assetId: 'asset-1', time: 1 }],
  };
}

function makeOptions(extra: Partial<ExportOptions> = {}): ExportOptions {
  return {
    resolution: '1080p',
    fps: 60,
    aspectRatio: '16:9',
    ...extra,
  };
}

function installFceApi(api: {
  registerMediaFile?: ReturnType<typeof vi.fn>;
  registerMediaFileFromFile?: ReturnType<typeof vi.fn>;
  releaseMediaFile?: ReturnType<typeof vi.fn>;
}): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      fce: {
        appName: 'Byux',
        isElectron: true,
        ...api,
      },
    },
  });
}

describe('getNativeExportCompatibility', () => {
  it('accepts the FFmpeg-compatible path and reports authored duration', () => {
    const input = makeInput([
      makeClip({ id: 'clip-1', start: 2, trimEnd: 4, speed: 2 }),
      makeClip({ id: 'clip-2', start: 6, trimEnd: 1 }),
    ]);

    expect(getNativeExportCompatibility(input, makeOptions())).toEqual({
      compatible: true,
      reasons: [],
      duration: 7,
    });
  });

  it('accepts every semantic feature supported by the native graph', () => {
    const clip = makeClip({
      speedRamp: { from: 0.5, to: 1.5 },
      transform: {
        x: [
          { t: 0, value: 0 },
          { t: 1, value: 10 },
        ],
      },
      colorGrade: { preset: 'mono', exposure: 10 },
      transitionIn: { type: 'fade', duration: 0.4 },
    });
    const result = getNativeExportCompatibility(
      makeInput([clip]),
      makeOptions({ motionBlur: true }),
    );

    expect(result).toMatchObject({ compatible: true, reasons: [] });
  });

  it('does not reject explicitly configured identity values', () => {
    const clip = makeClip({
      speedRamp: { from: 1, to: 1 },
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      colorGrade: { preset: 'none' },
      transitionIn: { type: 'cut', duration: 0.4 },
    });
    expect(
      getNativeExportCompatibility(makeInput([clip]), makeOptions()),
    ).toMatchObject({ compatible: true, reasons: [] });
  });

  it('accepts hold speed ramps as their normalized constant-speed result', () => {
    const active = getNativeExportCompatibility(
      makeInput([
        makeClip({ speedRamp: { from: 0.5, to: 1.5, easing: 'hold' } }),
      ]),
      makeOptions(),
    );
    const identity = getNativeExportCompatibility(
      makeInput([
        makeClip({ speedRamp: { from: 1, to: 1, easing: 'hold' } }),
      ]),
      makeOptions(),
    );

    expect(active).toMatchObject({ compatible: true, reasons: [] });
    expect(identity).toMatchObject({ compatible: true, reasons: [] });
  });

  it('reports the smoke-tested native keyframe boundary before export starts', () => {
    const result = getNativeExportCompatibility(
      makeInput([
        makeClip({
          transform: {
            x: Array.from({ length: 65 }, (_, index) => ({
              t: index / 60,
              value: index,
            })),
          },
        }),
      ]),
      makeOptions(),
    );

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toContain('64');
  });

  it('accepts visible secondary video and overlay lanes', () => {
    const secondaryVideoTrack: Track = {
      id: 'secondary-video',
      kind: 'video',
      label: 'サブ映像',
      locked: false,
      muted: false,
      hidden: false,
    };
    const overlayTrack: Track = {
      id: 'overlay',
      kind: 'overlay',
      label: 'オーバーレイ',
      locked: false,
      muted: false,
      hidden: false,
    };
    const result = getNativeExportCompatibility(
      makeInput(
        [
          makeClip(),
          makeClip({ id: 'secondary', trackId: secondaryVideoTrack.id }),
          makeClip({ id: 'graphic', trackId: overlayTrack.id }),
        ],
        [makeAsset()],
        [VIDEO_TRACK, secondaryVideoTrack, AUDIO_TRACK, overlayTrack],
      ),
      makeOptions(),
    );
    expect(result).toMatchObject({ compatible: true, reasons: [] });
  });

  it('reports overlay-only projects before native export starts', () => {
    const overlayTrack: Track = {
      id: 'overlay-only',
      kind: 'overlay',
      label: 'Overlay',
      locked: false,
      muted: false,
      hidden: false,
    };
    const result = getNativeExportCompatibility(
      makeInput(
        [makeClip({ trackId: overlayTrack.id })],
        [makeAsset()],
        [overlayTrack],
      ),
      makeOptions(),
    );

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toContain('メイン映像');
  });

  it('uses the first visible video track that actually contains clips', () => {
    const emptyTrack: Track = {
      ...VIDEO_TRACK,
      id: 'empty-video',
      label: 'Empty',
    };
    const result = getNativeExportCompatibility(
      makeInput(
        [makeClip()],
        [makeAsset()],
        [emptyTrack, VIDEO_TRACK, AUDIO_TRACK],
      ),
      makeOptions(),
    );

    expect(result).toMatchObject({ compatible: true, reasons: [] });
  });

  it('uses every visible visual lane for long-export duration', () => {
    const hiddenFirst: Track = {
      ...VIDEO_TRACK,
      id: 'hidden-first',
      hidden: true,
    };
    const visibleSecond: Track = {
      ...VIDEO_TRACK,
      id: 'visible-second',
    };
    const overlayTrack: Track = {
      id: 'overlay',
      kind: 'overlay',
      label: 'オーバーレイ',
      locked: false,
      muted: false,
      hidden: false,
    };
    const result = getNativeExportCompatibility(
      makeInput(
        [
          makeClip({ id: 'hidden', trackId: hiddenFirst.id, trimEnd: 20 }),
          makeClip({ id: 'base', trackId: visibleSecond.id, trimEnd: 3 }),
          makeClip({
            id: 'upper',
            trackId: overlayTrack.id,
            start: 10,
            trimEnd: 5,
          }),
        ],
        [makeAsset()],
        [hiddenFirst, visibleSecond, overlayTrack, AUDIO_TRACK],
      ),
      makeOptions(),
    );

    expect(result).toEqual({
      compatible: true,
      reasons: [],
      duration: 15,
    });
  });
});

describe('prepareNativeExportRequest', () => {
  beforeEach(() => {
    rasterizeOverlaysMock.mockReset();
    rasterizeOverlaysMock.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    installFceApi({});
  });

  it('builds a path-free request and excludes callbacks and abort signals', async () => {
    const controller = new AbortController();
    const progress = vi.fn();
    const input = makeInput();
    const prepared = await prepareNativeExportRequest(
      input,
      makeOptions({
        signal: controller.signal,
        onProgress: progress,
        audioDucking: { enabled: true, amountDb: 10, attack: 0.1, release: 0.4 },
      }),
    );

    expect(prepared.request.version).toBe(1);
    expect(prepared.request.encodingPreference).toBe('auto');
    expect(prepared.request.options).not.toHaveProperty('signal');
    expect(prepared.request.options).not.toHaveProperty('onProgress');
    expect(prepared.request.assets).toEqual([
      {
        id: 'asset-1',
        name: 'source.mp4',
        kind: 'video',
        size: 1024,
        width: 1920,
        height: 1080,
        sourceToken: 'existing-token',
      },
    ]);
    expect(prepared.request.assets[0]).not.toHaveProperty('path');
    expect(prepared.request.markers).toEqual(input.markers);
    expect(progress).toHaveBeenCalled();
    await prepared.release();
  });

  it('registers only referenced path-backed assets and releases temporary tokens once', async () => {
    const registerMediaFile = vi.fn().mockResolvedValue({
      token: 'temporary-token',
      url: 'fce-media://asset/temporary-token',
      size: 1024,
    });
    const releaseMediaFile = vi.fn().mockResolvedValue(true);
    installFceApi({ registerMediaFile, releaseMediaFile });
    const referenced = makeAsset({ sourceToken: undefined, path: 'C:\\video\\source.mp4' });
    const unused = makeAsset({
      id: 'unused',
      name: 'unused.mp4',
      sourceToken: undefined,
      path: 'C:\\video\\unused.mp4',
    });

    const prepared = await prepareNativeExportRequest(
      makeInput([makeClip()], [referenced, unused]),
      makeOptions(),
    );

    expect(registerMediaFile).toHaveBeenCalledTimes(1);
    expect(registerMediaFile).toHaveBeenCalledWith({
      path: 'C:\\video\\source.mp4',
      name: 'source.mp4',
      size: 1024,
      kind: 'video',
    });
    expect(prepared.request.assets.map((asset) => asset.id)).toEqual(['asset-1']);
    expect(prepared.request.assets[0].sourceToken).toBe('temporary-token');

    await prepared.release();
    await prepared.release();
    expect(releaseMediaFile).toHaveBeenCalledTimes(1);
    expect(releaseMediaFile).toHaveBeenCalledWith('temporary-token');
  });

  it('recovers a missing path from the original File before native export', async () => {
    const file = new File(['video'], 'source.mp4', { type: 'video/mp4' });
    const registerMediaFileFromFile = vi.fn().mockResolvedValue({
      ok: true,
      source: {
        token: 'file-token',
        url: 'fce-media://asset/file-token',
        size: file.size,
        path: 'C:\\video\\source.mp4',
        name: file.name,
        kind: 'video',
      },
    });
    const releaseMediaFile = vi.fn().mockResolvedValue(true);
    installFceApi({ registerMediaFileFromFile, releaseMediaFile });
    const asset = makeAsset({
      file,
      size: file.size,
      sourceToken: undefined,
      path: undefined,
    });

    const prepared = await prepareNativeExportRequest(
      makeInput([makeClip()], [asset]),
      makeOptions(),
    );

    expect(registerMediaFileFromFile).toHaveBeenCalledWith(file, 'video');
    expect(prepared.request.assets[0].sourceToken).toBe('file-token');
    await prepared.release();
    expect(releaseMediaFile).toHaveBeenCalledWith('file-token');
  });

  it('explains how to reconnect a source that has neither a path nor a disk-backed File', async () => {
    const releaseMediaFile = vi.fn().mockResolvedValue(true);
    installFceApi({ releaseMediaFile });
    const asset = makeAsset({
      sourceToken: undefined,
      path: undefined,
      file: undefined,
    });

    await expect(
      prepareNativeExportRequest(makeInput([makeClip()], [asset]), makeOptions()),
    ).rejects.toThrow('「ファイルを追加」ボタンで元ファイルを選び直してください');
  });

  it('sends validation metadata without registering hidden or muted sources', async () => {
    const registerMediaFile = vi.fn();
    const releaseMediaFile = vi.fn().mockResolvedValue(true);
    installFceApi({ registerMediaFile, releaseMediaFile });
    const hiddenTrack: Track = {
      id: 'hidden-overlay',
      kind: 'overlay',
      label: '非表示',
      locked: false,
      muted: false,
      hidden: true,
    };
    const mutedTrack: Track = {
      ...AUDIO_TRACK,
      id: 'muted-audio',
      muted: true,
    };
    const hiddenAsset = makeAsset({
      id: 'hidden-asset',
      name: 'hidden.mov',
      sourceToken: undefined,
      path: 'C:\\video\\hidden.mov',
    });
    const mutedAsset = makeAsset({
      id: 'muted-asset',
      name: 'muted.wav',
      kind: 'audio',
      mimeType: 'audio/wav',
      sourceToken: undefined,
      path: 'C:\\audio\\muted.wav',
      width: undefined,
      height: undefined,
    });
    const prepared = await prepareNativeExportRequest(
      makeInput(
        [
          makeClip(),
          makeClip({
            id: 'hidden-clip',
            trackId: hiddenTrack.id,
            assetId: hiddenAsset.id,
          }),
          makeClip({
            id: 'muted-clip',
            trackId: mutedTrack.id,
            assetId: mutedAsset.id,
          }),
        ],
        [makeAsset(), hiddenAsset, mutedAsset],
        [VIDEO_TRACK, AUDIO_TRACK, hiddenTrack, mutedTrack],
      ),
      makeOptions(),
    );

    expect(registerMediaFile).not.toHaveBeenCalled();
    expect(prepared.request.assets).toHaveLength(3);
    expect(
      prepared.request.assets.find((asset) => asset.id === hiddenAsset.id),
    ).not.toHaveProperty('sourceToken');
    expect(
      prepared.request.assets.find((asset) => asset.id === mutedAsset.id),
    ).not.toHaveProperty('sourceToken');
    await prepared.release();
  });

  it('releases earlier temporary registrations when later preparation fails', async () => {
    const registerMediaFile = vi.fn()
      .mockResolvedValueOnce({
        token: 'temporary-token',
        url: 'fce-media://asset/temporary-token',
        size: 1024,
      })
      .mockResolvedValueOnce(null);
    const releaseMediaFile = vi.fn().mockResolvedValue(true);
    installFceApi({ registerMediaFile, releaseMediaFile });
    const video = makeAsset({
      sourceToken: undefined,
      path: 'C:\\video\\source.mp4',
    });
    const audio = makeAsset({
      id: 'asset-2',
      name: 'music.mp3',
      kind: 'audio',
      mimeType: 'audio/mpeg',
      sourceToken: undefined,
      path: 'C:\\audio\\music.mp3',
      width: undefined,
      height: undefined,
    });
    const audioClip = makeClip({
      id: 'audio-clip',
      trackId: AUDIO_TRACK.id,
      assetId: audio.id,
    });

    await expect(
      prepareNativeExportRequest(
        makeInput([makeClip(), audioClip], [video, audio]),
        makeOptions(),
      ),
    ).rejects.toThrow('music.mp3');
    expect(releaseMediaFile).toHaveBeenCalledWith('temporary-token');
  });

  it('rasterizes exported video overlays at output resolution with clip tokens', async () => {
    const clip = makeClip({
      overlays: [{
        id: 'overlay-1',
        text: 'Clip {n}/{total}',
        fontSize: 8,
        color: '#ffffff',
        position: 'center',
      }],
    });
    const prepared = await prepareNativeExportRequest(
      makeInput([clip]),
      makeOptions({ resolution: '720p', aspectRatio: '9:16' }),
    );

    expect(rasterizeOverlaysMock).toHaveBeenCalledWith(
      clip.overlays,
      720,
      1280,
      { n: '1', total: '1' },
    );
    expect(prepared.request.overlays).toHaveLength(1);
    expect(prepared.request.overlays[0].clipId).toBe(clip.id);
    expect(prepared.request.overlays[0].png.buffer).toBeInstanceOf(ArrayBuffer);
    await prepared.release();
  });

  it('preserves native semantic effects and rasterizes secondary visual lanes', async () => {
    const overlayTrack: Track = {
      id: 'overlay',
      kind: 'overlay',
      label: 'オーバーレイ',
      locked: false,
      muted: false,
      hidden: false,
    };
    const semanticClip = makeClip({
      speedRamp: { from: 0.5, to: 1.5, easing: 'linear' },
      transform: {
        x: [
          { t: 0, value: 0 },
          { t: 1, value: 12 },
        ],
        opacity: 0.8,
      },
      colorGrade: { preset: 'warm', saturation: 15 },
      transitionIn: { type: 'slide', duration: 0.35 },
      transitionOut: { type: 'zoom', duration: 0.25 },
      effects: [{ type: 'motion-blur', intensity: 65 }],
    });
    const secondaryClip = makeClip({
      id: 'secondary',
      trackId: overlayTrack.id,
      start: 1,
      overlays: [{
        id: 'overlay-secondary',
        text: 'Secondary {n}/{total}',
        fontSize: 8,
        color: '#ffffff',
        position: 'center',
      }],
    });
    const options = makeOptions({
      motionBlur: true,
      motionBlurStrength: 0.7,
      motionBlurHudPreset: 'valorant',
      motionBlurHudMaskStrength: 0.85,
    });
    const prepared = await prepareNativeExportRequest(
      makeInput(
        [semanticClip, secondaryClip],
        [makeAsset()],
        [VIDEO_TRACK, AUDIO_TRACK, overlayTrack],
      ),
      options,
    );

    expect(prepared.request.options).toMatchObject({
      motionBlur: true,
      motionBlurStrength: 0.7,
      motionBlurHudPreset: 'valorant',
      motionBlurHudMaskStrength: 0.85,
    });
    expect(prepared.request.clips[0]).toMatchObject({
      speedRamp: semanticClip.speedRamp,
      transform: semanticClip.transform,
      colorGrade: semanticClip.colorGrade,
      transitionIn: semanticClip.transitionIn,
      transitionOut: semanticClip.transitionOut,
      effects: semanticClip.effects,
    });
    expect(rasterizeOverlaysMock).toHaveBeenCalledWith(
      secondaryClip.overlays,
      1920,
      1080,
      { n: '1', total: '1' },
    );
    expect(prepared.request.overlays).toEqual([
      expect.objectContaining({ clipId: 'secondary' }),
    ]);

    // The IPC snapshot must not retain references to mutable editor state.
    (semanticClip.transform!.x as Array<{ t: number; value: number }>)[1].value = 99;
    expect(
      (
        prepared.request.clips[0].transform!.x as
          Array<{ t: number; value: number }>
      )[1].value,
    ).toBe(12);
    await prepared.release();
  });

  it('forces scaling when proxy dimensions merely match the requested output', async () => {
    const prepared = await prepareNativeExportRequest(
      makeInput(
        [makeClip()],
        [makeAsset({
          width: 1280,
          height: 720,
          previewProxy: true,
        })],
      ),
      makeOptions({ resolution: '720p' }),
    );

    // The original may be 4K even though its compatibility proxy is 720p.
    // Preserving the aspect at a non-matching size keeps the native graph from
    // incorrectly treating scale as an identity operation.
    expect(prepared.request.assets[0]).toMatchObject({
      width: 2560,
      height: 1440,
    });
    await prepared.release();
  });

  it('bounds renderer memory before sending oversized overlay PNGs', async () => {
    const releaseMediaFile = vi.fn().mockResolvedValue(true);
    installFceApi({ releaseMediaFile });
    rasterizeOverlaysMock.mockResolvedValue(
      new Uint8Array(8 * 1024 * 1024 + 1),
    );
    const clip = makeClip({
      overlays: [{
        id: 'overlay-1',
        text: 'large',
        fontSize: 8,
        color: '#ffffff',
        position: 'center',
      }],
    });
    await expect(
      prepareNativeExportRequest(makeInput([clip]), makeOptions()),
    ).rejects.toThrow('テキスト画像が大きすぎます');
  });

  it('rejects path-backed assets when secure registration is unavailable', async () => {
    const asset = makeAsset({
      sourceToken: undefined,
      path: 'C:\\video\\source.mp4',
    });
    installFceApi({});
    await expect(
      prepareNativeExportRequest(makeInput([makeClip()], [asset]), makeOptions()),
    ).rejects.toThrow('登録できません');
  });

});
