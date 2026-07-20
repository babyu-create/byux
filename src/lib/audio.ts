// Audio decoding + waveform + onset (beat) detection helpers.
import type { Clip } from './types';
import { timelineTimeAtSourceTime } from './timeline';

export interface WaveformData {
  peaks: Float32Array;
  sampleRate: number;
  duration: number;
  peaksPerSecond: number;
}

interface AudioContextCtor {
  new (options?: AudioContextOptions): AudioContext;
}

function getAudioContext(): AudioContext {
  const Ctx =
    (window.AudioContext as AudioContextCtor | undefined) ??
    ((window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext as AudioContextCtor | undefined);
  if (!Ctx) throw new Error('AudioContext not supported');
  return new Ctx();
}

async function decodeFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = getAudioContext();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    void ctx.close();
  }
}

/**
 * Compute waveform peaks (max absolute amplitude per bin) over the entire
 * audio file. peaksPerSecond defaults to 50 (good balance of detail/size).
 */
export async function computeWaveform(
  file: File,
  peaksPerSecond = 50,
): Promise<WaveformData> {
  const buffer = await decodeFile(file);
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, index) => buffer.getChannelData(index),
  );
  const sampleLength = channels[0]?.length ?? 0;
  const totalPeaks = Math.max(1, Math.floor(buffer.duration * peaksPerSecond));
  const samplesPerPeak = Math.max(1, Math.floor(sampleLength / totalPeaks));
  const peaks = new Float32Array(totalPeaks);
  for (let i = 0; i < totalPeaks; i++) {
    let max = 0;
    const start = i * samplesPerPeak;
    const end = Math.min(sampleLength, start + samplesPerPeak);
    for (let j = start; j < end; j++) {
      for (const channel of channels) {
        const value = Math.abs(channel[j]);
        if (value > max) max = value;
      }
    }
    peaks[i] = max;
  }
  return {
    peaks,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    peaksPerSecond,
  };
}

/**
 * Onset-based beat detection. Splits audio into 50ms windows, computes
 * energy per window, then flags windows whose energy exceeds the moving
 * average of the previous 1s by `threshold`. Returns onset times in seconds.
 */
export async function detectBeats(
  file: File,
  options: { threshold?: number; minSeparationSec?: number; windowSec?: number } = {},
): Promise<number[]> {
  const threshold = options.threshold ?? 1.45;
  const minSep = options.minSeparationSec ?? 0.18;
  const windowSec = options.windowSec ?? 0.05;

  const buffer = await decodeFile(file);
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, index) => buffer.getChannelData(index),
  );
  const sampleLength = channels[0]?.length ?? 0;
  const sr = buffer.sampleRate;
  const windowSize = Math.max(1, Math.floor(sr * windowSec));
  const windowCount = Math.floor(sampleLength / windowSize);
  const energies = new Float32Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    let sum = 0;
    const base = w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      for (const channel of channels) {
        const sample = channel[base + i];
        sum += sample * sample;
      }
    }
    energies[w] = sum / (windowSize * Math.max(1, channels.length));
  }

  const lookback = Math.max(4, Math.floor(1 / windowSec));
  const beats: number[] = [];
  let lastBeat = -Infinity;
  // Running-sum sliding window: maintain the sum of the `lookback` windows
  // preceding `w` in O(1) per step instead of re-summing them (was
  // O(windowCount * lookback) — ~1.4M adds on a 3-min track). Mathematically
  // identical to the previous inner-loop average.
  let windowSum = 0;
  for (let k = 0; k < lookback && k < windowCount; k++) windowSum += energies[k];
  for (let w = lookback; w < windowCount; w++) {
    const avg = windowSum / lookback;
    if (avg > 0 && energies[w] > avg * threshold) {
      const t = w * windowSec;
      if (t - lastBeat >= minSep) {
        beats.push(t);
        lastBeat = t;
      }
    }
    // Slide the window forward: drop energies[w-lookback], add energies[w].
    windowSum += energies[w] - energies[w - lookback];
  }
  return beats;
}

/** Convert beats from source-time to timeline-time given a clip's mapping. */
export function beatsToTimeline(
  sourceBeats: number[],
  clip: Pick<Clip, 'start' | 'trimStart' | 'trimEnd' | 'speed' | 'speedRamp'>,
): number[] {
  const result: number[] = [];
  for (const b of sourceBeats) {
    if (b < clip.trimStart - 1e-6 || b > clip.trimEnd + 1e-6) continue;
    result.push(timelineTimeAtSourceTime(clip, b));
  }
  return result;
}
