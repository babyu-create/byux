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

  it('reports every WebCodecs-only feature without duplicate reasons', () => {
    const clip = makeClip({
      speedRamp: { from: 0.5, to: 1.5 },
      transform: { x: 10 },
      colorGrade: { preset: 'mono' },
      transitionIn: { type: 'fade', duration: 0.4 },
    });
    const result = getNativeExportCompatibility(
      makeInput([clip]),
      makeOptions({ motionBlur: true }),
    );

    expect(result.compatible).toBe(false);
    expect(result.reasons).toHaveLength(5);
    expect(result.reasons.join(' ')).toContain('速度ランプ');
    expect(result.reasons.join(' ')).toContain('トランスフォーム');
    expect(result.reasons.join(' ')).toContain('カラー調整');
    expect(result.reasons.join(' ')).toContain('トランジション');
    expect(result.reasons.join(' ')).toContain('モーションブラー');
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

  it('mirrors main-process checks for unsupported secondary visual lanes', () => {
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
          makeClip({ id: 'secondary', trackId: overlayTrack.id }),
        ],
        [makeAsset()],
        [VIDEO_TRACK, AUDIO_TRACK, overlayTrack],
      ),
      makeOptions(),
    );
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toContain('オーバーレイトラック');
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

  it('rejects incompatible projects before registering any source', async () => {
    const registerMediaFile = vi.fn();
    const releaseMediaFile = vi.fn();
    installFceApi({ registerMediaFile, releaseMediaFile });
    await expect(
      prepareNativeExportRequest(
        makeInput([makeClip({ transform: { scale: 1.2 } })]),
        makeOptions(),
      ),
    ).rejects.toThrow('トランスフォーム');
    expect(registerMediaFile).not.toHaveBeenCalled();
  });
});
