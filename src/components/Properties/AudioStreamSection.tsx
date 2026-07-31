import { useState } from 'react';
import { useMediaStore } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import type { MediaAsset, NativeAudioStream } from '../../lib/types';
import styles from './AudioStreamSection.module.css';

function streamLabel(stream: NativeAudioStream): string {
  const details = [
    stream.language,
    stream.channels,
    stream.sampleRate ? `${(stream.sampleRate / 1000).toFixed(1)} kHz` : undefined,
  ].filter(Boolean).join(' · ');
  return `音声 ${stream.index + 1}${details ? ` — ${details}` : ''}${stream.default ? '（既定）' : ''}`;
}

export function AudioStreamSection({ asset }: { asset: MediaAsset }) {
  const selectAudioStream = useMediaStore((state) => state.selectAudioStream);
  const showMessage = useProjectStore((state) => state.showMessage);
  const [busy, setBusy] = useState(false);
  const streams = asset.audioStreams ?? [];
  if (streams.length < 2) return null;
  const selected = asset.audioStreamIndex ?? streams.find((stream) => stream.default)?.index ?? streams[0].index;

  return (
    <div className={styles.root}>
      <p className={styles.help}>複数音声を含む素材です。書き出し・波形に使う音声を選べます。</p>
      <label className={styles.label} htmlFor="audio-stream-select">使用する音声</label>
      <select
        id="audio-stream-select"
        className={styles.select}
        value={selected}
        disabled={busy}
        onChange={(event) => {
          const index = Number(event.target.value);
          setBusy(true);
          void selectAudioStream(asset.id, index)
            .then((ok) => {
              showMessage(
                ok ? 'success' : 'error',
                ok ? `音声 ${index + 1} を選択しました` : '音声ストリームを変更できませんでした',
                2500,
              );
            })
            .finally(() => setBusy(false));
        }}
        aria-label="使用する音声ストリーム"
      >
        {streams.map((stream) => (
          <option key={stream.index} value={stream.index}>{streamLabel(stream)}</option>
        ))}
      </select>
      <p className={styles.note}>既定の音声を初期選択しています。動画の映像は変わりません。</p>
    </div>
  );
}
