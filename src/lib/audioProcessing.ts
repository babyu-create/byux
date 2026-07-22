import type { AudioProcessing } from './types';

export interface ResolvedAudioProcessing {
  highPassHz: number;
  lowGainDb: number;
  midGainDb: number;
  highGainDb: number;
  compressor: boolean;
}

export const DEFAULT_AUDIO_PROCESSING: ResolvedAudioProcessing = {
  highPassHz: 0,
  lowGainDb: 0,
  midGainDb: 0,
  highGainDb: 0,
  compressor: false,
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));

export function resolveAudioProcessing(value?: AudioProcessing): ResolvedAudioProcessing {
  return {
    highPassHz: value?.highPassHz ? clamp(value.highPassHz, 40, 300) : 0,
    lowGainDb: clamp(value?.lowGainDb ?? 0, -12, 12),
    midGainDb: clamp(value?.midGainDb ?? 0, -12, 12),
    highGainDb: clamp(value?.highGainDb ?? 0, -12, 12),
    compressor: value?.compressor === true,
  };
}

export function hasAudioProcessing(value?: AudioProcessing): boolean {
  const resolved = resolveAudioProcessing(value);
  return resolved.highPassHz > 0 || resolved.compressor ||
    Math.abs(resolved.lowGainDb) > 0.01 ||
    Math.abs(resolved.midGainDb) > 0.01 ||
    Math.abs(resolved.highGainDb) > 0.01;
}

export function ffmpegAudioProcessingFilters(value?: AudioProcessing): string[] {
  const resolved = resolveAudioProcessing(value);
  const filters: string[] = [];
  if (resolved.highPassHz > 0) filters.push(`highpass=f=${resolved.highPassHz.toFixed(0)}`);
  if (Math.abs(resolved.lowGainDb) > 0.01) {
    filters.push(`equalizer=f=120:t=q:w=0.7:g=${resolved.lowGainDb.toFixed(2)}`);
  }
  if (Math.abs(resolved.midGainDb) > 0.01) {
    filters.push(`equalizer=f=1000:t=q:w=1:g=${resolved.midGainDb.toFixed(2)}`);
  }
  if (Math.abs(resolved.highGainDb) > 0.01) {
    filters.push(`equalizer=f=6000:t=q:w=0.7:g=${resolved.highGainDb.toFixed(2)}`);
  }
  if (resolved.compressor) {
    filters.push('acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=1.2');
  }
  return filters;
}
