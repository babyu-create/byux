import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStore, useSelectedAsset } from '../../stores/mediaStore';
import { useProjectStore, useTimelineDuration } from '../../stores/projectStore';
import { clipDuration } from '../../lib/timeline';
import { formatTimecode } from '../../lib/media';
import type { Clip, MediaAsset } from '../../lib/types';
import { MotionBlurCanvas, type HudPreset } from './MotionBlurCanvas';
import { shapeStrength } from '../../lib/motionBlurCore';
import { OverlayLayer } from './OverlayLayer';
import styles from './Preview.module.css';

// Motion-blur strength shaping (shapeStrength + gamma/peak constants) now lives
// in lib/motionBlurCore.ts so the preview and the export renderer map a clip's
// authored intensity to the SAME shader strength. Imported above.

const HUD_PRESET_LABELS: Record<HudPreset, string> = {
  valorant: 'VALORANT',
  cs2: 'CS2',
  apex: 'Apex',
  none: 'OFF',
};
// Color chips per preset for quick visual identification. Picked from each
// game's signature accent so users recognize the preset at a glance even
// without reading the label.
const HUD_PRESET_CHIP: Record<HudPreset, string> = {
  valorant: '#ff4655',
  cs2: '#f5a623',
  apex: '#da292a',
  none: '#888',
};
const HUD_PRESET_TITLES: Record<HudPreset, string> = {
  valorant: 'VALORANT 用HUD保護プリセット',
  cs2: 'CS2 用HUD保護プリセット',
  apex: 'Apex Legends 用HUD保護プリセット',
  none: 'HUD保護OFF（汎用映像向け）',
};
const HUD_PRESET_ORDER: HudPreset[] = ['valorant', 'cs2', 'apex', 'none'];

export function Preview() {
  const fallbackAsset = useSelectedAsset();
  const assets = useMediaStore((s) => s.assets);
  const clips = useProjectStore((s) => s.clips);
  const tracks = useProjectStore((s) => s.tracks);
  const playhead = useProjectStore((s) => s.playhead);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying);
  const togglePlay = useProjectStore((s) => s.togglePlay);
  const aspectRatio = useProjectStore((s) => s.aspectRatio);
  const totalDuration = useTimelineDuration();

  const videoTrack = useMemo(
    () => tracks.find((t) => t.kind === 'video') ?? null,
    [tracks],
  );
  const videoTrackId = videoTrack?.id ?? null;
  const videoTrackHidden = videoTrack?.hidden ?? false;
  const videoTrackMuted = videoTrack?.muted ?? false;

  const audioTrack = useMemo(
    () => tracks.find((t) => t.kind === 'audio') ?? null,
    [tracks],
  );
  const audioTrackId = audioTrack?.id ?? null;
  const audioTrackMuted = audioTrack?.muted ?? false;

  const activeClip = useMemo<Clip | null>(() => {
    if (!videoTrackId) return null;
    return (
      clips.find((c) => {
        if (c.trackId !== videoTrackId) return false;
        const end = c.start + clipDuration(c);
        return playhead >= c.start - 1e-6 && playhead < end - 1e-6;
      }) ?? null
    );
  }, [clips, videoTrackId, playhead]);

  const assetMap = useMemo(() => {
    const map: Record<string, MediaAsset> = {};
    assets.forEach((a) => {
      map[a.id] = a;
    });
    return map;
  }, [assets]);

  const activeAsset = activeClip ? (assetMap[activeClip.assetId] ?? null) : null;
  const showFallback = clips.length === 0 && fallbackAsset?.kind === 'video';
  const displayAsset: MediaAsset | null = activeAsset ?? (showFallback ? fallbackAsset : null);

  // Find the active audio clip at the playhead.
  const activeAudioClip = useMemo<Clip | null>(() => {
    if (!audioTrackId) return null;
    return (
      clips.find((c) => {
        if (c.trackId !== audioTrackId) return false;
        const end = c.start + clipDuration(c);
        return playhead >= c.start - 1e-6 && playhead < end - 1e-6;
      }) ?? null
    );
  }, [clips, audioTrackId, playhead]);
  const activeAudioAsset = activeAudioClip
    ? (assetMap[activeAudioClip.assetId] ?? null)
    : null;

  const fadeIn = activeClip?.effects.find((e) => e.type === 'fade-in') ?? null;
  const fadeOut = activeClip?.effects.find((e) => e.type === 'fade-out') ?? null;
  const motionBlur =
    activeClip?.effects.find((e) => e.type === 'motion-blur') ?? null;
  const clipSpeed = activeClip?.speed ?? 1;
  // Stretch-to-fill: object-fit:fill makes the <video> distort to the 16:9
  // frame, matching the motion-blur canvas (which already fills) and the
  // exported result. See Clip.stretchToFill.
  const stretchActive = activeClip?.stretchToFill ?? false;

  // Preview-only multiplier on the canvas strength. Lets the user dial in
  // the look during preview without touching the per-clip intensity stored
  // by the effects panel. 0..1.5 — anything above 1 boosts beyond the
  // clip's authored strength for spot-checking.
  const [previewBlurBoost, setPreviewBlurBoost] = useState(1);

  // Preview motion blur strength fed into MotionBlurCanvas. The canvas runs
  // a per-pixel directional blur in a WebGL shader, sampling along the
  // detected global motion vector — intensity here scales how far that
  // line integral extends. A gamma curve (<1) maps the linear 0..100 panel
  // value into a perceptually balanced 0..STRENGTH_PEAK so the middle of
  // the slider does the visible work instead of the last 20% breaking.
  // The previewBlurBoost is applied on top and lets you eyeball alternative
  // strengths without re-editing the clip.
  const motionBlurStrength = useMemo(() => {
    if (!motionBlur) return 0;
    const intensity = Math.max(0, Math.min(100, motionBlur.intensity ?? 40));
    const speedFactor = Math.max(0.5, Math.min(2, clipSpeed));
    return shapeStrength(intensity / 100) * speedFactor * previewBlurBoost;
  }, [motionBlur, clipSpeed, previewBlurBoost]);

  // Build template context (e.g. {n}/{total} for kill counter)
  const overlayContext = useMemo<Record<string, string>>(() => {
    const ctx: Record<string, string> = {};
    if (!activeClip || !videoTrackId) return ctx;
    const sameTrack = clips
      .filter((c) => c.trackId === videoTrackId)
      .sort((a, b) => a.start - b.start);
    const idx = sameTrack.findIndex((c) => c.id === activeClip.id);
    ctx.n = idx >= 0 ? String(idx + 1) : '?';
    ctx.total = String(sameTrack.length);
    return ctx;
  }, [activeClip, clips, videoTrackId]);

  // Black overlay opacity when fade-in or fade-out is active.
  const fadeOpacity = useMemo(() => {
    if (!activeClip) return 0;
    const total = clipDuration(activeClip);
    if (total <= 0) return 0;
    const elapsed = playhead - activeClip.start;
    let opacity = 0;
    if (fadeIn) {
      const d = Math.max(0.05, fadeIn.duration ?? 0.4);
      if (elapsed < d) {
        opacity = Math.max(opacity, 1 - elapsed / d);
      }
    }
    if (fadeOut) {
      const d = Math.max(0.05, fadeOut.duration ?? 0.4);
      const remaining = total - elapsed;
      if (remaining < d) {
        opacity = Math.max(opacity, 1 - remaining / d);
      }
    }
    return Math.max(0, Math.min(1, opacity));
  }, [fadeIn, fadeOut, activeClip, playhead]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;

  // HUD preset for the motion blur canvas. Each preset wraps a per-game
  // set of view-locked UI zones. 'valorant' (default) preserves the
  // historical behaviour; 'cs2' and 'apex' target their respective
  // layouts; 'none' disables the positional protect so the per-pixel
  // luma-diff mask handles the entire workload — appropriate for non-FPS
  // footage where the hard-coded HUD rectangles would falsely protect
  // moving content.
  // HUD preset lives in the store (project scope) so the export uses the same
  // preset the user picks here — see projectStore.hudPreset.
  const hudPreset = useProjectStore((s) => s.hudPreset);
  const setHudPreset = useProjectStore((s) => s.setHudPreset);


  // Sync audio element to active audio clip + playhead (similar to video).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeAudioAsset) return;
    const speed = activeAudioClip?.speed ?? 1;
    const target = activeAudioClip
      ? activeAudioClip.trimStart + (playhead - activeAudioClip.start) * speed
      : 0;
    const clamped = Math.max(0, Math.min(activeAudioAsset.duration, target));
    if (Math.abs(audio.currentTime - clamped) > 1 / 30) {
      audio.currentTime = clamped;
    }
    audio.playbackRate = Math.max(0.0625, Math.min(4, speed));
    const v = activeAudioClip?.volume ?? 1;
    audio.volume = Math.max(0, Math.min(1, v));
    audio.muted = audioTrackMuted || (activeAudioClip?.muted ?? false) || v === 0;
    if (isPlaying) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
    // Cleanup: ensure audio is paused when the effect tears down (clip
    // switch, asset swap, component unmount). Without this, briefly two
    // <audio> elements can play concurrently between react's render and
    // unmount of the old keyed element.
    return () => {
      if (audio && !audio.paused) {
        audio.pause();
      }
    };
  }, [
    activeAudioClip?.id,
    activeAudioAsset?.id,
    playhead,
    isPlaying,
    audioTrackMuted,
    activeAudioAsset,
    activeAudioClip,
  ]);

  // Pause audio when no active audio clip
  useEffect(() => {
    if (!activeAudioClip || !activeAudioAsset) {
      const audio = audioRef.current;
      if (audio) audio.pause();
    }
  }, [activeAudioClip, activeAudioAsset]);

  // Seek video to match playhead when not playing (smooth scrub).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !displayAsset) return;
    if (isPlaying) return;
    let target = 0;
    if (activeClip) {
      const speed = activeClip.speed ?? 1;
      target = activeClip.trimStart + (playhead - activeClip.start) * speed;
    }
    target = Math.max(0, Math.min(displayAsset.duration, target));
    if (Math.abs(video.currentTime - target) > 1 / 120) {
      const fast = (video as HTMLVideoElement & { fastSeek?: (t: number) => void }).fastSeek;
      if (typeof fast === 'function') {
        fast.call(video, target);
      } else {
        video.currentTime = target;
      }
    }
  }, [playhead, activeClip, displayAsset, isPlaying]);

  // Auto-pause when no clip available at playhead while playing.
  useEffect(() => {
    if (isPlaying && clips.length > 0 && !activeClip) {
      // Seek forward to next clip if any
      const nextClipStart = clips
        .filter((c) => c.trackId === videoTrackId && c.start > playhead + 1e-6)
        .sort((a, b) => a.start - b.start)[0]?.start;
      if (nextClipStart !== undefined) {
        setPlayhead(nextClipStart);
      } else {
        setIsPlaying(false);
      }
    }
  }, [isPlaying, activeClip, clips, videoTrackId, playhead, setPlayhead, setIsPlaying]);

  // Drive playback. Video element is the source of truth; playhead follows
  // its currentTime each animation frame, ensuring zero drift between the
  // displayed frame and the timeline cursor.
  useEffect(() => {
    if (!isPlaying) return;
    const video = videoRef.current;
    if (!video) return;
    video.play().catch(() => {
      /* ignore autoplay rejection */
    });
    let rafId = 0;
    const step = () => {
      if (!playingRef.current) return;
      const v = videoRef.current;
      if (!v) return;
      const state = useProjectStore.getState();

      // Resolve videoTrackId fresh each tick (not from the effect closure).
      // The closure'd value could be stale across track reorders or after
      // a project reload that briefly clears tracks, leaving playback
      // pointed at a track that no longer exists.
      const liveVideoTrackId =
        state.tracks.find((t) => t.kind === 'video')?.id ?? null;
      if (!liveVideoTrackId) {
        state.setIsPlaying(false);
        return;
      }

      const totalDur = state.clips.reduce(
        (m, c) => Math.max(m, c.start + clipDuration(c)),
        0,
      );
      if (totalDur === 0) {
        state.setIsPlaying(false);
        return;
      }

      // Find the clip currently under the playhead.
      const current = state.clips.find((c) => {
        if (c.trackId !== liveVideoTrackId) return false;
        const end = c.start + clipDuration(c);
        return state.playhead >= c.start - 1e-6 && state.playhead < end - 1e-6;
      });

      if (current) {
        const localTime = v.currentTime;
        const speed = current.speed ?? 1;
        if (localTime >= current.trimEnd - 1e-3) {
          // Reached the end of this clip — advance to the next clip on the
          // same track, or stop playback if none.
          const next = state.clips
            .filter(
              (c) =>
                c.trackId === liveVideoTrackId &&
                c.start > current.start + 1e-6,
            )
            .sort((a, b) => a.start - b.start)[0];
          if (next) {
            state.setPlayhead(next.start);
          } else {
            state.setPlayhead(current.start + clipDuration(current));
            state.setIsPlaying(false);
            return;
          }
        } else {
          // playhead = clip.start + (localTime - trimStart) / speed
          state.setPlayhead(
            current.start + (localTime - current.trimStart) / speed,
          );
        }
      } else {
        // Not in any clip — try to jump forward to the next one.
        const next = state.clips
          .filter(
            (c) => c.trackId === liveVideoTrackId && c.start > state.playhead + 1e-6,
          )
          .sort((a, b) => a.start - b.start)[0];
        if (next) {
          state.setPlayhead(next.start);
        } else {
          state.setIsPlaying(false);
          return;
        }
      }

      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafId);
      const v = videoRef.current;
      if (v) v.pause();
    };
  }, [isPlaying, videoTrackId]);

  // When the active asset changes mid-play, jump the video to the right local time.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip || !activeAsset) return;
    const speed = activeClip.speed ?? 1;
    const target = activeClip.trimStart + (playhead - activeClip.start) * speed;
    video.currentTime = Math.max(0, Math.min(activeAsset.duration, target));
    if (isPlaying) {
      video.play().catch(() => {
        /* ignore */
      });
    }
    // We intentionally only react to clip/asset switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip?.id, activeAsset?.id]);

  // Apply per-clip playback speed.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = Math.max(0.0625, Math.min(4, clipSpeed));
  }, [clipSpeed, activeClip?.id]);

  // Apply per-clip + per-track volume to the video element (game audio).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const clipMuted = activeClip?.muted ?? false;
    const v = activeClip?.volume ?? 1;
    video.volume = Math.max(0, Math.min(1, v));
    video.muted = videoTrackMuted || clipMuted || v === 0;
  }, [activeClip?.volume, activeClip?.muted, videoTrackMuted, activeClip?.id]);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPlayhead(parseFloat(e.target.value));
  };

  const skip = (delta: number) => {
    const state = useProjectStore.getState();
    const totalDur = state.clips.reduce(
      (m, c) => Math.max(m, c.start + clipDuration(c)),
      0,
    );
    setPlayhead(Math.max(0, Math.min(totalDur || displayAsset?.duration || 0, playhead + delta)));
  };

  const setAspect = (next: '16:9' | '9:16') => {
    useProjectStore.setState({ aspectRatio: next });
  };

  const totalForDisplay = totalDuration > 0 ? totalDuration : (displayAsset?.duration ?? 0);
  const scrubMax = totalForDisplay || 0;
  const scrubValue = Math.min(playhead, scrubMax);

  if (assets.length === 0 && clips.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🎮</div>
          <div className={styles.emptyText}>左パネルから動画を追加してください</div>
          <div className={styles.emptyHint}>VALORANT等のFPS録画ファイル (.mp4) に対応</div>
        </div>
      </div>
    );
  }

  const showVideo = !!displayAsset && !videoTrackHidden;
  const inGap = clips.length > 0 && !activeClip;
  const isHidden = videoTrackHidden && !!displayAsset;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.aspectGroup} role="group" aria-label="アスペクト比">
          <button
            type="button"
            className={`${styles.aspectBtn} ${aspectRatio === '16:9' ? styles.aspectActive : ''}`}
            onClick={() => setAspect('16:9')}
          >
            16:9
          </button>
          <button
            type="button"
            className={`${styles.aspectBtn} ${aspectRatio === '9:16' ? styles.aspectActive : ''}`}
            onClick={() => setAspect('9:16')}
          >
            9:16
          </button>
        </div>
        {motionBlur && motionBlurStrength > 0 ? (
          <div className={styles.blurControls}>
            <span className={styles.blurLabel} aria-hidden="true">HUD</span>
            <div
              className={styles.hudPresetGroup}
              role="group"
              aria-label="HUD保護プリセット"
            >
              {HUD_PRESET_ORDER.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`${styles.hudPresetBtn} ${hudPreset === preset ? styles.hudPresetActive : ''}`}
                  onClick={() => setHudPreset(preset)}
                  aria-pressed={hudPreset === preset}
                  title={HUD_PRESET_TITLES[preset]}
                >
                  <span
                    className={styles.hudPresetChip}
                    style={{ background: HUD_PRESET_CHIP[preset] }}
                    aria-hidden="true"
                  />
                  {HUD_PRESET_LABELS[preset]}
                </button>
              ))}
            </div>
            <label
              className={styles.previewBoostLabel}
              title="プレビュー時のみのモーションブラー倍率（クリップ強度は変えない）"
            >
              <span className={styles.previewBoostText}>
                プレビュー {Math.round(previewBlurBoost * 100)}%
              </span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.01}
                value={previewBlurBoost}
                onChange={(e) => setPreviewBlurBoost(parseFloat(e.target.value))}
                className={styles.previewBoostSlider}
                aria-label="プレビューブラー強度"
              />
            </label>
          </div>
        ) : null}
        <div className={styles.fileName} title={displayAsset?.name ?? ''}>
          {clips.length > 0
            ? activeClip
              ? displayAsset?.name
              : 'クリップ間 (空)'
            : (displayAsset?.name ?? '')}
        </div>
      </div>

      {activeAudioAsset ? (
        <audio
          key={activeAudioAsset.id}
          ref={audioRef}
          src={activeAudioAsset.url}
          preload="auto"
          style={{ display: 'none' }}
        />
      ) : null}

      <div className={styles.stage}>
        <div className={styles.frame} data-aspect={aspectRatio}>
          {showVideo ? (
            <>
              <video
                key={displayAsset?.id}
                ref={videoRef}
                src={displayAsset?.url}
                className={styles.video}
                style={stretchActive ? { objectFit: 'fill' } : undefined}
                playsInline
                muted={videoTrackMuted}
                onClick={togglePlay}
              />
              <MotionBlurCanvas
                videoRef={videoRef}
                isPlaying={isPlaying}
                active={motionBlur !== null && motionBlurStrength > 0}
                strength={motionBlurStrength}
                hudPreset={hudPreset}
                hudMaskStrength={hudPreset === 'none' ? 0 : 1}
                aspect={aspectRatio === '9:16' ? 9 / 16 : 16 / 9}
              />
              {fadeOpacity > 0 ? (
                <div
                  className={styles.fadeOverlay}
                  style={{ opacity: fadeOpacity }}
                  aria-hidden="true"
                />
              ) : null}
              {clipSpeed !== 1 ? (
                <div className={styles.speedBadge} aria-hidden="true">
                  {clipSpeed === 0.25
                    ? '¼×'
                    : clipSpeed === 0.5
                      ? '½×'
                      : clipSpeed === 0.75
                        ? '¾×'
                        : `${clipSpeed}×`}
                </div>
              ) : null}
              {activeClip?.overlays && activeClip.overlays.length > 0 ? (
                <OverlayLayer
                  overlays={activeClip.overlays}
                  contextValues={overlayContext}
                />
              ) : null}
            </>
          ) : (
            <div className={styles.gap}>
              {isHidden ? (
                <>
                  <div className={styles.gapIcon}>👁</div>
                  <div className={styles.gapText}>映像トラック非表示</div>
                </>
              ) : inGap ? (
                <>
                  <div className={styles.gapIcon}>—</div>
                  <div className={styles.gapText}>クリップ間 (空)</div>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.timecode}>
          <span className={styles.tcCurrent}>{formatTimecode(scrubValue)}</span>
          <span className={styles.tcSep}>/</span>
          <span className={styles.tcTotal}>{formatTimecode(totalForDisplay)}</span>
        </div>

        <div className={styles.transport}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => skip(-5)}
            aria-label="5秒戻る"
            title="5秒戻る (Shift+←)"
          >
            <span className={styles.iconSm}>⏪</span>
          </button>
          <button
            type="button"
            className={styles.playBtn}
            onClick={togglePlay}
            aria-label={isPlaying ? '一時停止' : '再生'}
            title={isPlaying ? '一時停止 (Space)' : '再生 (Space)'}
            disabled={totalForDisplay === 0}
          >
            <span className={styles.playIcon}>{isPlaying ? '❚❚' : '▶'}</span>
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => skip(5)}
            aria-label="5秒進む"
            title="5秒進む (Shift+→)"
          >
            <span className={styles.iconSm}>⏩</span>
          </button>
        </div>

        <input
          type="range"
          min={0}
          max={scrubMax || 0}
          step={1 / 60}
          value={scrubValue}
          onChange={handleSeek}
          className={styles.scrubber}
          aria-label="シークバー"
          disabled={totalForDisplay === 0}
        />
      </div>
    </div>
  );
}
