import { memo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { timeToPx } from '../../lib/timeline';
import styles from './SnapGuide.module.css';

interface SnapGuideProps {
  zoom: number;
}

const TYPE_LABEL: Record<string, string> = {
  'clip-start': 'クリップ開始',
  'clip-end': 'クリップ終了',
  playhead: '再生ヘッド',
  origin: '原点',
  beat: 'ビート',
};

export const SnapGuide = memo(function SnapGuide({ zoom }: SnapGuideProps) {
  const indicator = useProjectStore((s) => s.snapIndicator);
  if (!indicator) return null;

  return (
    <div
      className={styles.root}
      style={{ transform: `translateX(${timeToPx(indicator.time, zoom)}px)` }}
      data-type={indicator.type}
    >
      <div className={styles.line} />
      <div className={styles.badge}>{TYPE_LABEL[indicator.type] ?? indicator.type}</div>
    </div>
  );
});
