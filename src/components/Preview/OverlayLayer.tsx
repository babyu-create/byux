import type { OverlayText } from '../../lib/types';
import { getFontStack } from '../../lib/fonts';
import styles from './OverlayLayer.module.css';

interface OverlayLayerProps {
  overlays: OverlayText[];
  /** Used by templates that say things like "1/3" — passed in from caller. */
  contextValues?: Record<string, string>;
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

export function OverlayLayer({ overlays, contextValues }: OverlayLayerProps) {
  if (overlays.length === 0) return null;
  return (
    <div className={styles.root} aria-hidden="true">
      {overlays.map((o) => {
        const text = applyTokens(o.text, contextValues);
        const stroke = o.outline
          ? `0 0 4px ${o.outlineColor ?? '#000000'}, 0 0 2px ${o.outlineColor ?? '#000000'}, 0 0 1px ${o.outlineColor ?? '#000000'}`
          : 'none';
        const wrapperStyle: React.CSSProperties = {
          ...positionStyle(o.position),
          fontSize: `${o.fontSize}cqh`,
          fontFamily: getFontStack(o.fontFamily),
          fontWeight: o.weight ?? 700,
          fontStyle: o.italic ? 'italic' : 'normal',
          color: o.color,
          textShadow: stroke,
          padding: o.background ? '0.2em 0.6em' : 0,
          background: o.background ?? 'transparent',
          borderRadius: o.background ? '0.2em' : 0,
          letterSpacing: '0.02em',
          lineHeight: 1.1,
          maxWidth: '90%',
          whiteSpace: 'pre-wrap',
        };
        return (
          <div key={o.id} style={wrapperStyle}>
            {text}
          </div>
        );
      })}
    </div>
  );
}
