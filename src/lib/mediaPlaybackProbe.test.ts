import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeVideoUrlMetadata } from './media';

type ProbeOutcome = 'decoded' | 'decode-error';

class FakeVideoElement {
  preload = '';
  muted = false;
  crossOrigin: string | null = null;
  duration = 140.458125;
  videoWidth = 1920;
  videoHeight = 1080;
  readyState = 1;
  seeking = false;
  onloadedmetadata: (() => void) | null = null;
  onloadeddata: (() => void) | null = null;
  onseeked: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private time = 0;
  private readonly outcome: ProbeOutcome;

  constructor(outcome: ProbeOutcome) {
    this.outcome = outcome;
  }

  set src(_value: string) {
    queueMicrotask(() => this.onloadedmetadata?.());
  }

  set currentTime(value: number) {
    this.time = value;
    this.seeking = true;
    queueMicrotask(() => {
      this.seeking = false;
      if (this.outcome === 'decoded') {
        this.readyState = 2;
        this.onloadeddata?.();
        this.onseeked?.();
      } else {
        this.onerror?.();
      }
    });
  }

  get currentTime() {
    return this.time;
  }

  removeAttribute() {}
  load() {}
}

function installVideo(outcome: ProbeOutcome) {
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal('document', {
    createElement: (tagName: string) => {
      if (tagName !== 'video') throw new Error(`unexpected element: ${tagName}`);
      return new FakeVideoElement(outcome);
    },
  });
}

describe('video playback probe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a source only after a sample frame is decoded', async () => {
    installVideo('decoded');

    await expect(probeVideoUrlMetadata('fce-media://asset/playable')).resolves.toEqual({
      duration: 140.458125,
      width: 1920,
      height: 1080,
    });
  });

  it('rejects metadata-only sources that fail on the first video packets', async () => {
    installVideo('decode-error');

    await expect(
      probeVideoUrlMetadata('fce-media://asset/black-preview'),
    ).rejects.toThrow('デコードできません');
  });
});
