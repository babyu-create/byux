import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore, useTimelineDuration } from '../../stores/projectStore';
import { useMediaStore } from '../../stores/mediaStore';
import type { Clip, MediaAsset } from '../../lib/types';
import styles from './WaveformPanel.module.css';

interface CanvasSize {
  width: number;
  height: number;
}

/**
 * Playhead overlay — subscribes to playhead independently so the canvas
 * component does not re-render on every scrub frame.
 */
const WaveformPlayhead = memo(function WaveformPlayhead({
  visibleDuration,
}: {
  visibleDuration: number;
}) {
  const playhead = useProjectStore((s) => s.playhead);
  // Map playhead to the same visible-duration axis as the click handler
  // so the indicator and the seek target agree.
  const pct = visibleDuration > 0 ? (playhead / visibleDuration) * 100 : 0;
  return (
    <div
      className={styles.playhead}
      style={{ left: `${Math.max(0, Math.min(100, pct))}%` }}
    />
  );
});

/**
 * Canvas-only inner component. Only re-renders when audio clips, waveform
 * data, or container size change — NOT on playhead movement.
 */
const WaveformCanvas = memo(function WaveformCanvas({
  audioClips,
  assets,
  audioDuration,
  size,
}: {
  audioClips: Clip[];
  assets: MediaAsset[];
  audioDuration: number;
  size: CanvasSize;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(size.width * dpr));
    canvas.height = Math.max(1, Math.floor(size.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.width, size.height);

    const pps = size.width / audioDuration;
    const midY = size.height / 2;
    const halfHMax = size.height / 2 - 4;

    const accent = getCssVar('--clip-audio') || 'rgba(74, 222, 128, 0.85)';
    const accentBg = getCssVar('--clip-audio-bg') || 'rgba(74, 222, 128, 0.18)';
    const beatColor = getCssVar('--beat-line') || 'rgba(10, 174, 253, 0.7)';

    const assetById = new Map<string, MediaAsset>(assets.map((a) => [a.id, a]));

    for (const clip of audioClips) {
      const asset = assetById.get(clip.assetId);
      if (!asset) continue;
      const clipLenSec = clip.trimEnd - clip.trimStart;
      const x0 = clip.start * pps;
      const x1 = (clip.start + clipLenSec) * pps;
      const clipW = Math.max(1, x1 - x0);

      ctx.fillStyle = accentBg;
      ctx.fillRect(x0, 0, clipW, size.height);

      const peaks = asset.waveform?.peaks;
      const peaksPerSecond = asset.waveform?.peaksPerSecond;
      if (peaks && peaksPerSecond) {
        const startIdx = Math.max(0, Math.floor(clip.trimStart * peaksPerSecond));
        const endIdx = Math.min(
          peaks.length,
          Math.ceil(clip.trimEnd * peaksPerSecond),
        );
        const slice = endIdx - startIdx;
        if (slice > 0) {
          ctx.fillStyle = accent;
          for (let dx = 0; dx < clipW; dx++) {
            const peakStart = startIdx + Math.floor((dx / clipW) * slice);
            const peakEnd = startIdx + Math.floor(((dx + 1) / clipW) * slice);
            let max = 0;
            for (let p = peakStart; p < Math.min(peaks.length, peakEnd); p++) {
              if (peaks[p] > max) max = peaks[p];
            }
            const halfH = Math.max(0.5, max * halfHMax);
            ctx.fillRect(x0 + dx, midY - halfH, 1, halfH * 2);
          }
        }
      } else {
        ctx.fillStyle = accent;
        ctx.fillRect(x0, midY - 0.5, clipW, 1);
      }

      if (asset.beats && asset.beats.length > 0) {
        ctx.fillStyle = beatColor;
        for (const b of asset.beats) {
          if (b < clip.trimStart - 1e-6 || b > clip.trimEnd + 1e-6) continue;
          const px = x0 + ((b - clip.trimStart) / clipLenSec) * clipW;
          ctx.fillRect(px, 0, 1.2, size.height);
        }
      }
    }
  }, [audioClips, assets, audioDuration, size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size.width, height: size.height, display: 'block' }}
      aria-hidden="true"
    />
  );
});

/**
 * Dedicated audio waveform sidebar. Shows every audio clip in the project
 * mapped to its project-time position, so the user can read overall audio
 * coverage and intensity at a glance — bigger than the inline timeline strip.
 */
export function WaveformPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });

  // NOTE: playhead is NOT subscribed here — WaveformPlayhead reads it directly.
  const clips = useProjectStore((s) => s.clips);
  const tracks = useProjectStore((s) => s.tracks);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const assets = useMediaStore((s) => s.assets);
  const totalDuration = useTimelineDuration();

  const audioClips = useMemo<Clip[]>(() => {
    const audioTrackIds = new Set(
      tracks.filter((t) => t.kind === 'audio').map((t) => t.id),
    );
    return clips.filter((c) => audioTrackIds.has(c.trackId));
  }, [clips, tracks]);

  const audioDuration = useMemo(() => {
    if (audioClips.length === 0) return 0;
    return Math.max(
      ...audioClips.map((c) => c.start + Math.max(0, c.trimEnd - c.trimStart)),
    );
  }, [audioClips]);

  const hasAudio = audioClips.length > 0 && audioDuration > 0;

  // Track container size — canvas needs explicit pixel dimensions.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hasAudio) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Map click-x to timeline time using the canvas's visible duration —
    // which is whichever is longer of the audio extent or the full
    // timeline. The previous form computed `t = x * audioDuration` and
    // then clamped to `max(audioDuration, totalDuration)`, but the clamp
    // was unreachable because `t` could never exceed `audioDuration`.
    // The result: clicking the right edge of the waveform when video is
    // longer than audio always landed at audioDuration, never into the
    // video-only tail.
    const visibleDuration = Math.max(audioDuration, totalDuration);
    const t = (x / rect.width) * visibleDuration;
    setPlayhead(Math.max(0, Math.min(visibleDuration, t)));
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span>オーディオ波形</span>
        {hasAudio ? (
          <span className={styles.meta}>
            {audioClips.length}本 / {audioDuration.toFixed(1)}s
          </span>
        ) : null}
      </div>
      {!hasAudio ? (
        <div className={styles.empty}>
          音声クリップを追加すると<br />ここに波形が表示されます
        </div>
      ) : (
        <div
          ref={containerRef}
          className={styles.canvasWrap}
          onPointerDown={handlePointerDown}
        >
          <WaveformCanvas
            audioClips={audioClips}
            assets={assets}
            audioDuration={audioDuration}
            size={size}
          />
          <WaveformPlayhead visibleDuration={Math.max(audioDuration, totalDuration)} />
        </div>
      )}
    </div>
  );
}

function getCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
