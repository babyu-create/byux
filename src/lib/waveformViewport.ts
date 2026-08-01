export const MAX_INLINE_WAVEFORM_CSS_WIDTH = 8_192;
export const INLINE_WAVEFORM_OVERSCAN_PX = 192;

export interface WaveformViewport {
  left: number;
  width: number;
  visible: boolean;
}

/**
 * Limit an inline waveform canvas to the currently visible part of a possibly
 * hours-long clip. Inputs are CSS-pixel positions relative to the waveform's
 * full content box.
 */
export function calculateWaveformViewport(
  totalWidth: number,
  visibleLeft: number,
  visibleRight: number,
  overscan = INLINE_WAVEFORM_OVERSCAN_PX,
): WaveformViewport {
  if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
    return { left: 0, width: 1, visible: false };
  }
  const safeTotal = Math.max(1, Math.floor(totalWidth));
  const rawLeft = Math.max(0, Math.floor(visibleLeft - overscan));
  const rawRight = Math.min(safeTotal, Math.ceil(visibleRight + overscan));
  if (rawRight <= rawLeft) {
    return { left: Math.min(safeTotal - 1, rawLeft), width: 1, visible: false };
  }

  const width = Math.min(MAX_INLINE_WAVEFORM_CSS_WIDTH, rawRight - rawLeft);
  return { left: rawLeft, width: Math.max(1, width), visible: true };
}

export function waveformSourceWindow(
  trimStart: number,
  trimEnd: number,
  totalWidth: number,
  viewport: Pick<WaveformViewport, 'left' | 'width'>,
): { start: number; end: number } {
  const duration = Math.max(0, trimEnd - trimStart);
  const safeWidth = Math.max(1, totalWidth);
  return {
    start: trimStart + (viewport.left / safeWidth) * duration,
    end:
      trimStart +
      (Math.min(safeWidth, viewport.left + viewport.width) / safeWidth) * duration,
  };
}
