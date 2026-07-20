import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../../lib/types';
import {
  MAX_INLINE_WAVEFORM_CSS_WIDTH,
  calculateWaveformViewport,
  waveformSourceWindow,
  type WaveformViewport,
} from '../../lib/waveformViewport';

const CONTENT_INSET_PX = 6;
const MAX_CANVAS_BACKING_WIDTH = 16_384;

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
  const [viewport, setViewport] = useState<WaveformViewport>(() =>
    calculateWaveformViewport(
      width,
      0,
      Math.min(width, MAX_INLINE_WAVEFORM_CSS_WIDTH),
      0,
    ),
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = canvas?.parentElement;
    if (!canvas || !wrapper) return;
    const scroll = canvas.closest<HTMLElement>('[data-timeline-scroll="true"]');
    let frame = 0;

    const update = () => {
      frame = 0;
      const wrapperRect = wrapper.getBoundingClientRect();
      const contentLeft = wrapperRect.left + CONTENT_INSET_PX;
      const next = scroll
        ? (() => {
            const scrollRect = scroll.getBoundingClientRect();
            return calculateWaveformViewport(
              width,
              scrollRect.left - contentLeft,
              scrollRect.right - contentLeft,
            );
          })()
        : calculateWaveformViewport(
            width,
            0,
            Math.min(width, MAX_INLINE_WAVEFORM_CSS_WIDTH),
            0,
          );
      setViewport((current) =>
        current.left === next.left &&
        current.width === next.width &&
        current.visible === next.visible
          ? current
          : next,
      );
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };

    update();
    scroll?.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(wrapper);
    if (scroll) observer.observe(scroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroll?.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      observer.disconnect();
    };
  }, [width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport.visible) return;
    const peaks = asset.waveform?.peaks;
    const pps = asset.waveform?.peaksPerSecond;
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      MAX_CANVAS_BACKING_WIDTH / viewport.width,
    );
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, viewport.width, height);

    if (!peaks || !pps) {
      // Loading placeholder (subtle horizontal line).
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
      ctx.fillRect(0, height / 2 - 0.5, viewport.width, 1);
      return;
    }

    const sourceWindow = waveformSourceWindow(
      trimStart,
      trimEnd,
      width,
      viewport,
    );
    const startIdx = Math.max(0, Math.floor(sourceWindow.start * pps));
    const endIdx = Math.min(peaks.length, Math.ceil(sourceWindow.end * pps));
    const slice = endIdx - startIdx;
    if (slice <= 0) return;

    ctx.fillStyle = color ?? 'rgba(74, 222, 128, 0.85)';
    const midY = height / 2;
    // Aggregate peaks per pixel column.
    for (let x = 0; x < viewport.width; x++) {
      const peakStart = startIdx + Math.floor((x / viewport.width) * slice);
      const peakEnd = startIdx + Math.floor(((x + 1) / viewport.width) * slice);
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
      const visibleDur = sourceWindow.end - sourceWindow.start;
      if (visibleDur > 0) {
        for (const b of asset.beats) {
          if (b < sourceWindow.start - 1e-6 || b > sourceWindow.end + 1e-6) continue;
          const x = ((b - sourceWindow.start) / visibleDur) * viewport.width;
          ctx.fillRect(x, 0, 1.4, height);
        }
      }
    }
  }, [asset.waveform, asset.beats, trimStart, trimEnd, width, height, color, showBeats, viewport]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        left: CONTENT_INSET_PX + viewport.left,
        top: '50%',
        transform: 'translateY(-50%)',
        width: viewport.width,
        height,
        display: viewport.visible ? 'block' : 'none',
      }}
      data-waveform-viewport-left={viewport.left}
      data-waveform-viewport-width={viewport.width}
      aria-hidden="true"
    />
  );
}
