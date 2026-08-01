import { describe, expect, it } from 'vitest';
import {
  BEAT_SAMPLE_RATE,
  BEAT_WINDOW_SECONDS,
  buildBeatFfmpegArgs,
  createBeatMetadataAccumulator,
} from '../../electron/nativeBeats.cjs';

const rms = (db: number | '-inf') =>
  `lavfi.astats.Overall.RMS_level=${db}\n`;

describe('native streaming beat detection', () => {
  it('detects the same thresholded onsets across arbitrary stream chunks', () => {
    const input = [
      ...Array.from({ length: 20 }, () => rms(-20)),
      rms(-10),
      rms(-20),
      rms(-20),
      rms(-20),
      rms(-9),
    ].join('');
    const whole = createBeatMetadataAccumulator();
    whole.push(input);
    const split = createBeatMetadataAccumulator();
    for (let index = 0; index < input.length; index += 7) {
      split.push(input.slice(index, index + 7));
    }
    expect(split.finish()).toEqual(whole.finish());
    expect(split.finish()).toHaveLength(2);
    expect(split.finish()[0]).toBeCloseTo(1);
    expect(split.finish()[1]).toBeCloseTo(1.2);
  });

  it('treats silence as zero and keeps only a fixed one-second history', () => {
    const accumulator = createBeatMetadataAccumulator({ maxWindows: 100_000 });
    for (let index = 0; index < 10_000; index += 1) accumulator.push(rms('-inf'));
    expect(accumulator.finish()).toEqual([]);
    expect(accumulator.windowCount).toBe(10_000);
    expect(accumulator.retainedEnergyCount).toBe(20);
  });

  it('enforces the minimum separation and result limit', () => {
    const accumulator = createBeatMetadataAccumulator({ maxBeats: 1 });
    accumulator.push(Array.from({ length: 20 }, () => rms(-30)).join(''));
    accumulator.push(rms(-5));
    accumulator.push(rms(-5));
    accumulator.push(rms(-30));
    accumulator.push(rms(-30));
    expect(() => accumulator.push(rms(-5))).toThrow(/多すぎる/);
  });

  it('builds bounded 48 kHz RMS analysis for the selected audio stream', () => {
    const args = buildBeatFfmpegArgs('C:\\Videos\\match.mp4', 2);
    const filter = args[args.indexOf('-af') + 1];
    expect(BEAT_SAMPLE_RATE).toBe(48_000);
    expect(BEAT_WINDOW_SECONDS).toBe(0.05);
    expect(args).toContain('0:a:2');
    expect(args).toContain('-sn');
    expect(args).toContain('-dn');
    expect(filter).toContain('asetnsamples=n=2400');
    expect(filter).toContain('Overall.RMS_level');
    expect(() => buildBeatFfmpegArgs('source.mkv', -1)).toThrow(/stream index/i);
  });
});
