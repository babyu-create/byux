// Rasterize a clip's text overlays to a transparent PNG at the export
// resolution, so the MP4 export can composite them with ffmpeg `overlay`.
//
// Why rasterize in the browser instead of ffmpeg `drawtext`: drawtext needs a
// font FILE in the WASM filesystem and fontconfig, and Byux lets users pick any
// of ~25 Google fonts. The browser already has those fonts loaded for the
// preview, so drawing to a <canvas> reproduces the EXACT preview look (font,
// weight, italic, color, outline, background, position) with zero font-file
// plumbing. The result is a full-frame RGBA PNG with transparent background.
//
// Mirrors components/Preview/OverlayLayer.tsx (5% inset, fontSize = % of frame
// height, 9-position grid, {n}/{total} token expansion).

import type { OverlayText } from './types';
import { ensureFontLoaded, getFontStack } from './fonts';
import { overlayDecoration, overlayStrokeWidth } from './overlayText';

const INSET = 0.05; // 5% — matches OverlayLayer top/bottom/left/right inset
const LINE_HEIGHT = 1.1;

function applyTokens(text: string, ctx?: Record<string, string>): string {
  if (!ctx) return text;
  return text.replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? `{${key}}`);
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, rr);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw `overlays` onto a width×height transparent canvas and return PNG bytes,
 * or null if there's nothing to draw / no DOM. `tokens` expands {n}/{total}.
 */
export async function rasterizeOverlays(
  overlays: OverlayText[] | undefined,
  width: number,
  height: number,
  tokens?: Record<string, string>,
): Promise<Uint8Array | null> {
  if (!overlays || overlays.length === 0) return null;
  if (typeof document === 'undefined') return null;

  // Ensure the chosen Google fonts are actually loaded before measuring/drawing.
  try { await document.fonts.ready; } catch { /* best effort */ }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  for (const o of overlays) {
    await ensureFontLoaded(o.fontFamily);
    const text = applyTokens(o.text, tokens);
    const fontPx = Math.max(1, (o.fontSize / 100) * height);
    const weight = o.weight ?? 700;
    const fontStyle = o.italic ? 'italic ' : '';
    ctx.font = `${fontStyle}${weight} ${fontPx}px ${getFontStack(o.fontFamily)}`;
    // Force the specific font to load (covers overlays whose clip was never
    // previewed, so document.fonts.ready alone wouldn't have triggered it).
    try { await document.fonts.load(ctx.font, text); } catch { /* fallback font */ }
    // letterSpacing matches OverlayLayer's 0.02em; not in older type defs.
    try {
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0.02em';
    } catch { /* unsupported — negligible */ }

    const lines = text.split('\n');
    const lineH = fontPx * LINE_HEIGHT;
    const blockH = lines.length * lineH;

    // Horizontal anchor + alignment.
    const pos = o.position;
    let x: number;
    let align: CanvasTextAlign;
    if (pos.endsWith('left')) {
      x = width * INSET;
      align = 'left';
    } else if (pos.endsWith('right')) {
      x = width * (1 - INSET);
      align = 'right';
    } else {
      x = width / 2;
      align = 'center';
    }

    // Vertical anchor (top of the text block).
    let yTop: number;
    if (pos.startsWith('top')) {
      yTop = height * INSET;
    } else if (pos.startsWith('bottom')) {
      yTop = height * (1 - INSET) - blockH;
    } else {
      yTop = height / 2 - blockH / 2;
    }

    ctx.textAlign = align;
    ctx.textBaseline = 'top';

    // Background pill (padding 0.6em horizontal, 0.2em vertical, radius 0.2em).
    if (o.background) {
      const padX = fontPx * 0.6;
      const padY = fontPx * 0.2;
      let maxW = 0;
      for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
      const bw = maxW + padX * 2;
      const bh = blockH + padY * 2;
      let bx: number;
      if (align === 'left') bx = x - padX;
      else if (align === 'right') bx = x - maxW - padX;
      else bx = x - maxW / 2 - padX;
      ctx.fillStyle = o.background;
      fillRoundRect(ctx, bx, yTop - padY, bw, bh, fontPx * 0.2);
    }

    // Decoration (Phase P3). 'glow' / 'shadow' use the canvas shadow on the
    // FILL pass; 'gradient' fills with a vertical linear gradient. The outline
    // (stroke) is drawn first WITHOUT any shadow so the glow/shadow only haloes
    // the fill — matching OverlayLayer's text-shadow layering.
    const deco = overlayDecoration(o);

    // Build the fill style: a vertical gradient for 'gradient', else the color.
    let fillStyle: string | CanvasGradient = o.color;
    if (deco === 'gradient') {
      const g = ctx.createLinearGradient(0, yTop, 0, yTop + blockH);
      g.addColorStop(0, o.color);
      g.addColorStop(1, o.decorationColor ?? o.color);
      fillStyle = g;
    }

    // Text: stroke (outline) then fill, line by line.
    lines.forEach((ln, i) => {
      const y = yTop + i * lineH;
      // Outline first, with NO shadow so the halo doesn't double on the stroke.
      if (o.outline) {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.lineWidth = Math.max(2, fontPx * overlayStrokeWidth(o));
        ctx.strokeStyle = o.outlineColor ?? '#000000';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.strokeText(ln, x, y);
      }
      // Fill, applying the glow / drop-shadow on this pass only.
      if (deco === 'glow') {
        ctx.shadowColor = o.decorationColor ?? o.color;
        ctx.shadowBlur = fontPx * 0.4;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      } else if (deco === 'shadow') {
        ctx.shadowColor = 'rgba(0,0,0,0.65)';
        ctx.shadowBlur = fontPx * 0.12;
        ctx.shadowOffsetX = fontPx * 0.06;
        ctx.shadowOffsetY = fontPx * 0.06;
      } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
      ctx.fillStyle = fillStyle;
      ctx.fillText(ln, x, y);
    });

    // Reset shadow so the next overlay / background pill isn't haloed.
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) return null;
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}
