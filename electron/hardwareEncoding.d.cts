export interface HardwareVideoEncoder {
  id: 'h264_nvenc' | 'h264_qsv' | 'h264_amf';
  label: string;
}

export const HARDWARE_VIDEO_ENCODERS: readonly HardwareVideoEncoder[];
export const SUPPORTED_VIDEO_ENCODERS: ReadonlySet<string>;

export function buildHardwareProbeArgs(
  encoder: HardwareVideoEncoder['id'],
  width: number,
  height: number,
  fps: number,
): string[];

export function buildVideoEncodingArgs(
  encoder: 'libx264' | HardwareVideoEncoder['id'],
  quality?: 'recommended' | 'high' | 'compact',
): string[];

export function encoderLabel(encoder: string): string;
export function isHardwareEncoderFailure(text: string, encoder: string): boolean;
