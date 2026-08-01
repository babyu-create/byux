import { describe, expect, it } from 'vitest';
import {
  HARDWARE_VIDEO_ENCODERS,
  buildHardwareProbeArgs,
  buildVideoEncodingArgs,
  encoderLabel,
  isHardwareEncoderFailure,
} from '../../electron/hardwareEncoding.cjs';

describe('hardware encoding', () => {
  it('tries the common Windows GPU backends in a deterministic order', () => {
    expect(HARDWARE_VIDEO_ENCODERS.map((encoder) => encoder.id)).toEqual([
      'h264_nvenc',
      'h264_qsv',
      'h264_amf',
    ]);
  });

  it('maps the user-facing quality presets to each encoder safely', () => {
    expect(buildVideoEncodingArgs('libx264', 'high')).toEqual(
      expect.arrayContaining(['libx264', 'veryfast', '16']),
    );
    expect(buildVideoEncodingArgs('h264_nvenc', 'recommended')).toEqual(
      expect.arrayContaining(['h264_nvenc', 'p4', 'vbr', '20']),
    );
    expect(buildVideoEncodingArgs('h264_qsv', 'compact')).toEqual(
      expect.arrayContaining(['h264_qsv', 'fast', '27']),
    );
    expect(buildVideoEncodingArgs('h264_amf', 'high')).toEqual(
      expect.arrayContaining(['h264_amf', 'quality', 'cqp', '16']),
    );
  });

  it('probes the actual requested geometry without invoking a shell', () => {
    const args = buildHardwareProbeArgs('h264_nvenc', 3840, 2160, 120);
    expect(args).toContain('color=c=black:s=3840x2160:r=120:d=0.05');
    expect(args).toContain('h264_nvenc');
    expect(args.at(-1)).toBe('-');
    expect(() => buildHardwareProbeArgs('h264_nvenc', 12, 12, 30)).toThrow();
  });

  it('falls back only for diagnostics that name the selected hardware encoder', () => {
    const nvencFailure =
      '[h264_nvenc] InitializeEncoder failed: invalid param\n' +
      'Error while opening encoder';
    expect(isHardwareEncoderFailure(nvencFailure, 'h264_nvenc')).toBe(true);
    expect(isHardwareEncoderFailure(nvencFailure, 'h264_qsv')).toBe(false);
    expect(
      isHardwareEncoderFailure('No such file or directory', 'h264_nvenc'),
    ).toBe(false);
    expect(isHardwareEncoderFailure(nvencFailure, 'libx264')).toBe(false);
  });

  it('uses clear labels for progress feedback', () => {
    expect(encoderLabel('h264_nvenc')).toBe('NVIDIA NVENC');
    expect(encoderLabel('libx264')).toBe('CPU / x264');
  });
});
