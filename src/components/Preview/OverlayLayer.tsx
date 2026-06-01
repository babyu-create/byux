import type { OverlayText } from '../../lib/types';
import { getFontStack } from '../../lib/fonts';
import {
  buildTextShadow,
  introPoseToCss,
  overlayDecoration,
  sampleOverlayIntro,
} from '../../lib/overlayText';
import styles from './OverlayLayer.module.css';

interface OverlayLayerProps {
  overlays: OverlayText[];
  /** Used by templates that say things like "1/3" — passed in from caller. */
  contextValues?: Record<string, string>;
  /**
   * Clip-local time in seconds (playhead − clip.start). Drives the intro
   * animation sampling so the preview matches the export. Defaults to a large
   * value (settled pose) when omitted, e.g. for static previews/thumbnails.
   */
  localTime?: number;
}

function applyTokens(text: string, ctx?: Record<string, string>): string {
  if (!ctx) return text;
  return text.replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? `{${key}}`);
}

function positionStyle(pos: OverlayText['position']): React.CSSProperties {
  const styles: React.CSSProperties = { position: 'absolute' };
  if (pos.startsWith('top')) {
    styles.top = '5%';
  } else if (pos.startsWith('bottom')) {
    styles.bottom = '5%';
  } else {
    styles.top = '50%';
    styles.transform = 'translateY(-50%)';
  }
  if (pos.endsWith('left')) {
    styles.left = '5%';
  } else if (pos.endsWith('right')) {
    styles.right = '5%';
    styles.textAlign = 'right';
  } else {
    styles.left = '50%';
    styles.transform = (styles.transform || '') + ' translateX(-50%)';
    styles.textAlign = 'center';
  }
  return styles;
}

export function OverlayLayer({ overlays, contextValues, localTime }: OverlayLayerProps) {
  if (overlays.length === 0) return null;
  // Settled pose by default (no intro / static preview) → a large local time.
  const t = localTime ?? 1e9;
  return (
    <div className={styles.root} aria-hidden="true">
      {overlays.map((o) => {
        const text = applyTokens(o.text, contextValues);
        // Font px is unknown here (cqh-relative); pass a representative size so
        // shadow offsets scale sensibly. Use 1px → buildTextShadow returns
        // fractions in em-equivalent via the cqh font; instead compute against a
        // nominal 100px and emit em so the look is resolution-independent.
        const textShadow = buildTextShadow(o, 100);
        const deco = overlayDecoration(o);

        // Intro pose (opacity/offset/scale) sampled at the clip-local time.
        const pose = sampleOverlayIntro(o, t);
        const introTransform = introPoseToCss(pose, 100)
          // introPoseToCss uses px against the nominal 100px → convert to em so
          // it scales with the cqh font size (1em == fontPx).
          .replace(/(-?\d+\.?\d*)px/g, (_, n) => `${(parseFloat(n) / 100).toFixed(4)}em`);

        const base = positionStyle(o.position);
        // Compose the intro transform AFTER the positioning transform so the
        // centering (translateX/Y -50%) is preserved.
        const composedTransform = base.transform
          ? `${base.transform} ${introTransform}`
          : introTransform;

        const wrapperStyle: React.CSSProperties = {
          ...base,
          transform: composedTransform,
          transformOrigin: 'center',
          opacity: pose.opacity,
          fontSize: `${o.fontSize}cqh`,
          fontFamily: getFontStack(o.fontFamily),
          fontWeight: o.weight ?? 700,
          fontStyle: o.italic ? 'italic' : 'normal',
          color: deco === 'gradient' ? 'transparent' : o.color,
          textShadow: deco === 'gradient' ? 'none' : textShadow,
          padding: o.background ? '0.2em 0.6em' : 0,
          background: o.background ?? 'transparent',
          borderRadius: o.background ? '0.2em' : 0,
          letterSpacing: '0.02em',
          lineHeight: 1.1,
          maxWidth: '90%',
          whiteSpace: 'pre-wrap',
        };
        if (deco === 'gradient') {
          // Vertical gradient text fill: top = color, bottom = decorationColor.
          // Gradient text clips the element background to the glyphs, which is
          // incompatible with a background pill — so a pill is dropped here (the
          // raster path matches). Outline still shows via text-shadow.
          const top = o.color;
          const bottom = o.decorationColor ?? o.color;
          wrapperStyle.background = 'transparent';
          wrapperStyle.padding = 0;
          wrapperStyle.backgroundImage = `linear-gradient(180deg, ${top}, ${bottom})`;
          (wrapperStyle as React.CSSProperties & { WebkitBackgroundClip?: string }).WebkitBackgroundClip = 'text';
          wrapperStyle.backgroundClip = 'text';
          (wrapperStyle as React.CSSProperties & { WebkitTextFillColor?: string }).WebkitTextFillColor = 'transparent';
          // Keep the outline visible behind the gradient text.
          wrapperStyle.textShadow = o.outline ? buildTextShadow({ ...o, decoration: 'none' }, 100) : 'none';
        }
        return (
          <div key={o.id} style={wrapperStyle}>
            {text}
          </div>
        );
      })}
    </div>
  );
}
