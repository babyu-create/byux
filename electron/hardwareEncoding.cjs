'use strict';

const HARDWARE_VIDEO_ENCODERS = Object.freeze([
  Object.freeze({ id: 'h264_nvenc', label: 'NVIDIA NVENC' }),
  Object.freeze({ id: 'h264_qsv', label: 'Intel Quick Sync' }),
  Object.freeze({ id: 'h264_amf', label: 'AMD AMF' }),
]);

const SUPPORTED_VIDEO_ENCODERS = new Set([
  'libx264',
  ...HARDWARE_VIDEO_ENCODERS.map((encoder) => encoder.id),
]);

function assertVideoEncoder(value) {
  if (!SUPPORTED_VIDEO_ENCODERS.has(value)) {
    throw new Error(`Unsupported video encoder: ${String(value)}`);
  }
  return value;
}

function qualityValue(quality) {
  if (quality === 'high') return 16;
  if (quality === 'compact') return 27;
  if (quality !== undefined && quality !== 'recommended') {
    throw new Error(`Unsupported quality: ${String(quality)}`);
  }
  return 20;
}

function softwarePreset(quality) {
  return quality === 'high' ? 'veryfast' : 'superfast';
}

function buildVideoEncodingArgs(encoder, quality) {
  assertVideoEncoder(encoder);
  const value = qualityValue(quality);
  if (encoder === 'libx264') {
    return [
      '-c:v',
      'libx264',
      '-preset',
      softwarePreset(quality),
      '-crf',
      String(value),
    ];
  }
  if (encoder === 'h264_nvenc') {
    return [
      '-c:v',
      encoder,
      '-preset',
      quality === 'high' ? 'p5' : quality === 'compact' ? 'p3' : 'p4',
      '-tune',
      'hq',
      '-rc',
      'vbr',
      '-cq',
      String(value),
      '-b:v',
      '0',
    ];
  }
  if (encoder === 'h264_qsv') {
    return [
      '-c:v',
      encoder,
      '-preset',
      quality === 'high' ? 'slow' : quality === 'compact' ? 'fast' : 'medium',
      '-global_quality',
      String(value),
    ];
  }
  return [
    '-c:v',
    encoder,
    '-quality',
    quality === 'high' ? 'quality' : quality === 'compact' ? 'speed' : 'balanced',
    '-rc',
    'cqp',
    '-qp_i',
    String(value),
    '-qp_p',
    String(value),
    '-qp_b',
    String(Math.min(51, value + 2)),
  ];
}

function buildHardwareProbeArgs(encoder, width, height, fps) {
  assertVideoEncoder(encoder);
  if (encoder === 'libx264') throw new Error('A hardware encoder is required');
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(fps) ||
    width < 320 ||
    height < 240 ||
    width > 8_192 ||
    height > 8_192 ||
    fps < 1 ||
    fps > 240
  ) {
    throw new Error('Invalid hardware probe dimensions');
  }
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${width}x${height}:r=${fps}:d=0.05`,
    '-frames:v',
    '1',
    '-an',
    '-pix_fmt',
    'yuv420p',
    ...buildVideoEncodingArgs(encoder, 'recommended'),
    '-f',
    'null',
    '-',
  ];
}

function isHardwareEncoderFailure(text, encoder) {
  assertVideoEncoder(encoder);
  if (encoder === 'libx264') return false;
  const diagnostic = String(text || '');
  const namesEncoder = diagnostic.toLowerCase().includes(encoder.toLowerCase());
  return namesEncoder && /(?:error while opening encoder|initializeencoder failed|no capable devices found|cannot load .*nvenc|driver does not support|error creating (?:a )?mfx session|current mfx implementation is not supported|failed to (?:open|initiali[sz]e).*(?:amf|encoder)|dll .* failed to open|device (?:not available|setup failed)|unsupported device|hardware accelerator failed)/i.test(diagnostic);
}

function encoderLabel(encoder) {
  if (encoder === 'libx264') return 'CPU / x264';
  return HARDWARE_VIDEO_ENCODERS.find((candidate) => candidate.id === encoder)?.label ?? encoder;
}

module.exports = {
  HARDWARE_VIDEO_ENCODERS,
  SUPPORTED_VIDEO_ENCODERS,
  buildHardwareProbeArgs,
  buildVideoEncodingArgs,
  encoderLabel,
  isHardwareEncoderFailure,
};
