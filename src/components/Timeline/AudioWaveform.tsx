import { useEffect, useRef } from 'react';
import type { MediaAsset } from '../../lib/types';

interface AudioWaveformProps {
  asset: MediaAsset;
  /** Source-time start of the clip (trimStart). */
  trimStart: number;
  /** Source-time end of the clip (trimEnd). */
  trimEnd: number;
  /** Width and height for the canvas in CSS pixels. */
  width: number;
  height: number;
  /** Stroke/fill color. Defaults to currentColor. */
  color?: string;
  /** Whether to overlay beat tick lines. */
  showBeats?: boolean;
}

export function AudioWaveform({
  asset,
  trimStart,
  trimEnd,
  width,
  height,
  color,
  showBeats = true,
}: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const peaks = asset.waveform?.peaks;
    const pps = asset.waveform?.peaksPerSecond;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (!peaks || !pps) {
      // Loading placeholder (subtle horizontal line).
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
      ctx.fillRect(0, height / 2 - 0.5, width, 1);
      return;
    }

    const startIdx = Math.max(0, Math.floor(trimStart * pps));
    const endIdx = Math.min(peaks.length, Math.ceil(trimEnd * pps));
    const slice = endIdx - startIdx;
    if (slice <= 0) return;

    ctx.fillStyle = color ?? 'rgba(74, 222, 128, 0.85)';
    const midY = height / 2;
    // Aggregate peaks per pixel column.
    for (let x = 0; x < width; x++) {
      const peakStart = startIdx + Math.floor((x / width) * slice);
      const peakEnd = startIdx + Math.floor(((x + 1) / width) * slice);
      let max = 0;
      for (let p = peakStart; p < Math.min(peaks.length, peakEnd); p++) {
        if (peaks[p] > max) max = peaks[p];
      }
      const halfH = Math.max(0.5, max * (height / 2 - 1));
      ctx.fillRect(x, midY - halfH, 1, halfH * 2);
    }

    // Overlay beat tick lines.
    if (showBeats && asset.beats && asset.beats.length > 0) {
      ctx.fillStyle = 'rgba(10, 174, 253, 0.85)';
      const visibleDur = trimEnd - trimStart;
      if (visibleDur > 0) {
        for (const b of asset.beats) {
          if (b < trimStart - 1e-6 || b > trimEnd + 1e-6) continue;
          const x = ((b - trimStart) / visibleDur) * width;
          ctx.fillRect(x, 0, 1.4, height);
        }
      }
    }
  }, [asset.waveform, asset.beats, trimStart, trimEnd, width, height, color, showBeats]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      aria-hidden="true"
    />
  );
}
