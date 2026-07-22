import type { CSSProperties } from 'react';
import type { SubtitleCue, SubtitleStyle } from '../../lib/types';
import styles from './SubtitleLayer.module.css';

interface SubtitleLayerProps {
  cues: SubtitleCue[];
  style: SubtitleStyle;
}

export function SubtitleLayer({ cues, style }: SubtitleLayerProps) {
  if (cues.length === 0) return null;
  const css = {
    '--subtitle-font-size': `${style.fontSize}cqh`,
    '--subtitle-color': style.color,
    '--subtitle-outline': style.outlineColor,
    '--subtitle-background': style.background,
  } as CSSProperties;
  return (
    <div className={styles.layer} data-position={style.position} style={css} aria-live="off">
      {cues.map((cue) => (
        <div className={styles.cue} key={cue.id}>{cue.text}</div>
      ))}
    </div>
  );
}
