import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStore, useSelectedAsset } from '../../stores/mediaStore';
import { useProjectStore, useTimelineDuration } from '../../stores/projectStore';
import { clipDuration } from '../../lib/timeline';
import { formatTimecode } from '../../lib/media';
import type { Clip, MediaAsset } from '../../lib/types';
import { Rewind, FastForward, Play, Pause, EyeOff, Clapperboard } from 'lucide-react';
import { MotionBlurCanvas, type HudPreset } from './MotionBlurCanvas';
import { shapeStrength } from '../../lib/motionBlurCore';
import { OverlayLayer } from './OverlayLayer';
import { sampleClipTransform, transformToCss } from '../../lib/clipTransform';
import { colorGradeFilter } from '../../lib/colorGrade';
import { transitionModulationAt } from '../../lib/transitions';
import {
  hasSpeedRamp,
  makeRampSampler,
  type RampSampler,
} from '../../lib/speedRamp';
import {
  buildDuckPoints,
  duckGainAt,
  hasDucking,
  resolveDucking,
  type DuckSegment,
} from '../../lib/audioDucking';
import styles from './Preview.module.css';

/**
 * Build a ramp sampler for a clip when (and only when) it has a real speed
 * ramp, so preview playback and seeking use the same timeline↔source mapping
 * the export uses. Returns null for constant-speed clips (zero overhead).
 */
function rampSamplerForClip(clip: Clip | null): RampSampler | null {
  if (!clip || !hasSpeedRamp(clip.speedRamp)) return null;
  return makeRampSampler(
    clip.speedRamp,
    clip.speed ?? 1,
    clip.trimStart,
    clip.trimEnd,
  );
}

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
  const verticalReframe = useProjectStore((s) => s.verticalReframe);
  const setVerticalReframe = useProjectStore((s) => s.setVerticalReframe);
  const markers = useProjectStore((s) => s.markers);
  const audioDucking = useProjectStore((s) => s.audioDucking);
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

  // BGM auto-ducking (Phase P5, preview best-effort). Project the kill markers
  // onto the timeline through the VIDEO clips (each at its own clip.start, since
  // the preview is NOT a back-to-back concat) so the duck points land where the
  // user hears the kills. The export does the same with the concat windows —
  // the duck FEEL (dip around each kill) matches even though the absolute times
  // differ between the live timeline and the concatenated export. Recomputed
  // only when markers / clips change (not every playhead tick).
  const duckResolved = useMemo(() => resolveDucking(audioDucking), [audioDucking]);
  const duckActive = hasDucking(audioDucking);
  const duckPoints = useMemo<number[]>(() => {
    if (!duckActive || !videoTrackId || markers.length === 0) return [];
    const segments: DuckSegment[] = clips
      .filter((c) => c.trackId === videoTrackId)
      .map((c) => ({
        assetId: c.assetId,
        trimStart: c.trimStart,
        trimEnd: c.trimEnd,
        speed: c.speed,
        start: c.start,
      }));
    return buildDuckPoints(markers, segments);
  }, [duckActive, videoTrackId, markers, clips]);
  // Live duck gain (0..1) at the playhead — multiplies the BGM volume below.
  const duckGain = useMemo(
    () => (duckActive ? duckGainAt(playhead, duckPoints, duckResolved) : 1),
    [duckActive, playhead, duckPoints, duckResolved],
  );

  const fadeIn = activeClip?.effects.find((e) => e.type === 'fade-in') ?? null;
  const fadeOut = activeClip?.effects.find((e) => e.type === 'fade-out') ?? null;
  const motionBlur =
    activeClip?.effects.find((e) => e.type === 'motion-blur') ?? null;
  const clipSpeed = activeClip?.speed ?? 1;
  // Ramp sampler for the active clip (null for constant-speed clips). Memoised
  // on the clip's ramp/speed/trim so it isn't rebuilt every playhead tick.
  const activeRampSampler = useMemo(
    () => rampSamplerForClip(activeClip),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeClip?.id,
      activeClip?.speed,
      activeClip?.trimStart,
      activeClip?.trimEnd,
      activeClip?.speedRamp?.from,
      activeClip?.speedRamp?.to,
      activeClip?.speedRamp?.easing,
    ],
  );
  // Instantaneous playback speed at the playhead — equals clipSpeed for a
  // constant clip, or the ramped factor (× base speed) at this moment. Drives
  // the speed badge and the motion-blur strength scaling so blur tracks the
  // live speed (the export does the same per frame).
  const instSpeed = useMemo(() => {
    if (!activeClip) return 1;
    if (!activeRampSampler) return clipSpeed;
    return activeRampSampler.speedFactorAtLocalTime(playhead - activeClip.start);
  }, [activeClip, activeRampSampler, clipSpeed, playhead]);
  // Stretch-to-fill: object-fit:fill makes the <video> distort to the 16:9
  // frame, matching the motion-blur canvas (which already fills) and the
  // exported result. See Clip.stretchToFill.
  const stretchActive = activeClip?.stretchToFill ?? false;
  // Vertical (9:16) preview fills by cropping the landscape source (object-fit
  // cover) and pans with verticalReframe — mirrors the export crop so what you
  // frame here is what you get.
  const isVertical = aspectRatio === '9:16';
  const reframePosition = `${(((verticalReframe + 1) / 2) * 100).toFixed(1)}% 50%`;
  const videoStyle: React.CSSProperties | undefined = isVertical
    ? { objectFit: 'cover', objectPosition: reframePosition }
    : stretchActive
      ? { objectFit: 'fill' }
      : undefined;

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
    // Scale by the INSTANTANEOUS speed so a slow-mo→fast ramp visibly ramps the
    // blur with it (the export bakes the same per-frame scaling).
    const speedFactor = Math.max(0.5, Math.min(2, instSpeed));
    return shapeStrength(intensity / 100) * speedFactor * previewBlurBoost;
  }, [motionBlur, instSpeed, previewBlurBoost]);

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

  // Animated clip transform (position / scale / rotation / opacity). Sampled at
  // clip-local time and applied as a CSS transform to the footage layer (the
  // <video> AND the MotionBlurCanvas together — they're wrapped in one element
  // so both move identically). Fade overlay / text / badges live OUTSIDE this
  // layer so they stay anchored to the frame. The export applies the SAME
  // sampled transform per frame (lib/clipTransform → OffscreenTransformRenderer)
  // so the preview and the MP4 match.
  const footageTransform = useMemo(() => {
    if (!activeClip) return null;
    const localT = playhead - activeClip.start;
    const r = sampleClipTransform(activeClip.transform, localT);
    // Compose the kill-to-kill transition modulation (Phase P4) onto the
    // sampled transform: opacity & scale multiply, translate adds. Sampled at
    // clip-local time over the clip's own boundary windows — the export bakes
    // the SAME modulation per frame (see exporter's transform pass) so the
    // boundary look matches.
    const mod = transitionModulationAt(
      activeClip.transitionIn,
      activeClip.transitionOut,
      localT,
      clipDuration(activeClip),
    );
    const composed = {
      x: r.x + mod.dx,
      y: r.y + mod.dy,
      scale: r.scale * mod.scale,
      rotation: r.rotation,
      opacity: r.opacity * mod.opacity,
    };
    return {
      transform: transformToCss(composed),
      opacity: Math.max(0, Math.min(1, composed.opacity)),
    };
  }, [activeClip, playhead]);

  // One-click color grade (Phase P2) → a single CSS `filter` applied to the
  // footage layer (the <video> AND the MotionBlurCanvas together, since both
  // live inside .footageLayer). The export bakes the SAME filter string per
  // frame (lib/colorGrade → OffscreenTransformRenderer.ctx.filter) for parity.
  // 'none' (neutral grade) leaves the layer un-filtered.
  const footageFilter = useMemo(() => {
    const f = colorGradeFilter(activeClip?.colorGrade);
    return f === 'none' ? undefined : f;
  }, [activeClip?.colorGrade]);

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
    // Reseeking the <audio> element re-buffers it (audible click). During
    // playback the element runs on its own clock and the playhead follows the
    // video (the master), so correcting the few-ms drift EVERY frame produced
    // continuous clicks that sounded like the BGM was distorting. Mirror the
    // video: tight sync only while scrubbing; while playing, reseek only on a
    // genuine jump (clip change / manual seek), not normal clock drift.
    const drift = Math.abs(audio.currentTime - clamped);
    if (drift > (isPlaying ? 0.35 : 1 / 30)) {
      audio.currentTime = clamped;
    }
    audio.playbackRate = Math.max(0.0625, Math.min(4, speed));
    const v = activeAudioClip?.volume ?? 1;
    // BGM auto-ducking (preview best-effort): the active audio clip lives on the
    // FIRST audio track (audioTrackId = the BGM lane), so dip its volume by the
    // live duck gain around kill moments — matching the export's BGM-only duck.
    const bgmGain = duckActive ? duckGain : 1;
    audio.volume = Math.max(0, Math.min(1, v * bgmGain));
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
    duckActive,
    duckGain,
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
      const localT = playhead - activeClip.start;
      if (activeRampSampler) {
        // Ramped clip: timeline→source is the nonlinear ramp integral.
        target = activeRampSampler.sourceTimeAtLocalTime(localT);
      } else {
        const speed = activeClip.speed ?? 1;
        target = activeClip.trimStart + localT * speed;
      }
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
  }, [playhead, activeClip, activeRampSampler, displayAsset, isPlaying]);

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
        // Ramped clips: drive playbackRate from the instantaneous factor and
        // invert the (nonlinear) source→timeline map so the playhead tracks the
        // video exactly. Constant clips keep the original linear mapping.
        const sampler = hasSpeedRamp(current.speedRamp)
          ? makeRampSampler(current.speedRamp, speed, current.trimStart, current.trimEnd)
          : null;
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
        } else if (sampler) {
          // Ramped: map the playing video's SOURCE time → timeline-local time,
          // and set the instantaneous playback rate for the next frames.
          const localTl = sampler.localTimeAtSourceTime(localTime);
          state.setPlayhead(current.start + localTl);
          v.playbackRate = Math.max(
            0.0625,
            Math.min(4, sampler.speedFactorAtLocalTime(localTl)),
          );
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
    const localT = playhead - activeClip.start;
    const target = activeRampSampler
      ? activeRampSampler.sourceTimeAtLocalTime(localT)
      : activeClip.trimStart + localT * (activeClip.speed ?? 1);
    video.currentTime = Math.max(0, Math.min(activeAsset.duration, target));
    if (isPlaying) {
      video.play().catch(() => {
        /* ignore */
      });
    }
    // We intentionally only react to clip/asset switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip?.id, activeAsset?.id]);

  // Apply per-clip playback speed. For ramped clips the RAF loop refines the
  // instantaneous rate each frame; this sets the current (instantaneous) value
  // so scrubbing / the first play frame start at the right rate.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = Math.max(0.0625, Math.min(4, instSpeed));
  }, [instSpeed, activeClip?.id]);

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
          <div className={styles.emptyIcon}>
            <Clapperboard size={44} strokeWidth={1.4} aria-hidden="true" />
          </div>
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
        {isVertical ? (
          <div className={styles.reframeGroup} title="9:16クロップの横位置">
            <span className={styles.reframeLabel}>横位置</span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.02}
              value={verticalReframe}
              onChange={(e) => setVerticalReframe(parseFloat(e.target.value))}
              className={styles.reframeSlider}
              aria-label="9:16クロップの横位置 (左から右)"
            />
            <button
              type="button"
              className={styles.reframeReset}
              onClick={() => setVerticalReframe(0)}
              title="中央に戻す"
              aria-label="中央に戻す"
            >
              中央
            </button>
          </div>
        ) : null}
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
              <div
                className={styles.footageLayer}
                style={
                  footageTransform || footageFilter
                    ? {
                        ...(footageTransform
                          ? {
                              transform: footageTransform.transform,
                              opacity: footageTransform.opacity,
                            }
                          : null),
                        ...(footageFilter ? { filter: footageFilter } : null),
                      }
                    : undefined
                }
              >
                <video
                  key={displayAsset?.id}
                  ref={videoRef}
                  src={displayAsset?.url}
                  className={styles.video}
                  style={videoStyle}
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
                  coverPosition={isVertical ? reframePosition : undefined}
                />
              </div>
              {fadeOpacity > 0 ? (
                <div
                  className={styles.fadeOverlay}
                  style={{ opacity: fadeOpacity }}
                  aria-hidden="true"
                />
              ) : null}
              {activeRampSampler ? (
                <div className={styles.speedBadge} aria-hidden="true">
                  {`${instSpeed.toFixed(1)}×`}
                </div>
              ) : clipSpeed !== 1 ? (
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
                  localTime={playhead - activeClip.start}
                />
              ) : null}
            </>
          ) : (
            <div className={styles.gap}>
              {isHidden ? (
                <>
                  <div className={styles.gapIcon}>
                    <EyeOff size={30} strokeWidth={1.6} aria-hidden="true" />
                  </div>
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
            <Rewind size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.playBtn}
            onClick={togglePlay}
            aria-label={isPlaying ? '一時停止' : '再生'}
            title={isPlaying ? '一時停止 (Space)' : '再生 (Space)'}
            disabled={totalForDisplay === 0}
          >
            {isPlaying ? (
              <Pause size={20} strokeWidth={0} fill="currentColor" aria-hidden="true" />
            ) : (
              <Play size={20} strokeWidth={0} fill="currentColor" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => skip(5)}
            aria-label="5秒進む"
            title="5秒進む (Shift+→)"
          >
            <FastForward size={16} strokeWidth={2} aria-hidden="true" />
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
