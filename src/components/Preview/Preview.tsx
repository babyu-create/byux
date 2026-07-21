import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useMediaStore, useSelectedAsset } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import { clipDuration } from '../../lib/timeline';
import { formatTimecode } from '../../lib/media';
import type { AudioProcessing, Clip, MediaAsset } from '../../lib/types';
import { Rewind, FastForward, Play, Pause, EyeOff, Clapperboard } from 'lucide-react';
import { MotionBlurCanvas, type HudPreset } from './MotionBlurCanvas';
import { shapeStrength } from '../../lib/motionBlurCore';
import { OverlayLayer } from './OverlayLayer';
import { SubtitleLayer } from './SubtitleLayer';
import { activeSubtitleCues } from '../../lib/subtitles';
import { resolveAudioProcessing } from '../../lib/audioProcessing';
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

interface PreviewGainGraph {
  source: MediaElementAudioSourceNode;
  highPass: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  gain: GainNode;
  cleanupTimer: number | null;
}

let previewAudioContext: AudioContext | null = null;
const previewGainGraphs = new WeakMap<HTMLMediaElement, PreviewGainGraph>();

/**
 * Route media through Web Audio so the editor's 0–200% range is audible in
 * preview. HTMLMediaElement.volume itself stops at 100%.
 */
function useMediaElementGain(
  ref: RefObject<HTMLMediaElement | null>,
  gainValue: number,
  muted: boolean,
  isPlaying: boolean,
  processing?: AudioProcessing,
) {
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    let graph: PreviewGainGraph | null = null;
    try {
      previewAudioContext ??= new window.AudioContext();
      graph = previewGainGraphs.get(media) ?? null;
      if (!graph) {
        const source = previewAudioContext.createMediaElementSource(media);
        const highPass = previewAudioContext.createBiquadFilter();
        highPass.type = 'highpass';
        const low = previewAudioContext.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = 120;
        const mid = previewAudioContext.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = 1_000;
        mid.Q.value = 1;
        const high = previewAudioContext.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = 6_000;
        const compressor = previewAudioContext.createDynamicsCompressor();
        const gain = previewAudioContext.createGain();
        source.connect(highPass).connect(low).connect(mid).connect(high).connect(compressor).connect(gain).connect(previewAudioContext.destination);
        graph = { source, highPass, low, mid, high, compressor, gain, cleanupTimer: null };
        previewGainGraphs.set(media, graph);
      }
      if (graph.cleanupTimer !== null) {
        window.clearTimeout(graph.cleanupTimer);
        graph.cleanupTimer = null;
      }
      media.volume = 1;
      media.muted = false;
      const resolved = resolveAudioProcessing(processing);
      graph.highPass.frequency.setValueAtTime(
        resolved.highPassHz > 0 ? resolved.highPassHz : 10,
        previewAudioContext.currentTime,
      );
      graph.low.gain.setValueAtTime(resolved.lowGainDb, previewAudioContext.currentTime);
      graph.mid.gain.setValueAtTime(resolved.midGainDb, previewAudioContext.currentTime);
      graph.high.gain.setValueAtTime(resolved.highGainDb, previewAudioContext.currentTime);
      graph.compressor.threshold.setValueAtTime(
        resolved.compressor ? -18 : 0,
        previewAudioContext.currentTime,
      );
      graph.compressor.knee.setValueAtTime(resolved.compressor ? 18 : 0, previewAudioContext.currentTime);
      graph.compressor.ratio.setValueAtTime(resolved.compressor ? 3 : 1, previewAudioContext.currentTime);
      graph.compressor.attack.setValueAtTime(0.02, previewAudioContext.currentTime);
      graph.compressor.release.setValueAtTime(0.25, previewAudioContext.currentTime);
      graph.gain.gain.setValueAtTime(
        muted ? 0 : Math.max(0, Math.min(2, gainValue)),
        previewAudioContext.currentTime,
      );
      if (isPlaying && previewAudioContext.state === 'suspended') {
        void previewAudioContext.resume().catch(() => {});
      }
    } catch {
      media.volume = Math.max(0, Math.min(1, gainValue));
      media.muted = muted;
    }

    return () => {
      if (!graph) return;
      graph.gain.gain.value = 0;
      graph.cleanupTimer = window.setTimeout(() => {
        // StrictMode immediately reconnects a still-mounted element. Release
        // nodes only after a real DOM removal.
        if (!media.isConnected) {
          graph?.source.disconnect();
          graph?.highPass.disconnect();
          graph?.low.disconnect();
          graph?.mid.disconnect();
          graph?.high.disconnect();
          graph?.compressor.disconnect();
          graph?.gain.disconnect();
          previewGainGraphs.delete(media);
        }
        if (graph) graph.cleanupTimer = null;
      }, 0);
    };
  }, [gainValue, isPlaying, muted, processing, ref]);
}

interface PreviewAudioLayerProps {
  clip: Clip;
  asset: MediaAsset;
  playhead: number;
  isPlaying: boolean;
  trackMuted: boolean;
  gain: number;
}

function PreviewAudioLayer({
  clip,
  asset,
  playhead,
  isPlaying,
  trackMuted,
  gain,
}: PreviewAudioLayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const rampSampler = useMemo(() => rampSamplerForClip(clip), [clip]);
  const volume = clip.volume ?? 1;
  useMediaElementGain(
    audioRef,
    volume * gain,
    trackMuted || (clip.muted ?? false) || volume === 0,
    isPlaying,
    clip.audioProcessing,
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const speed = clip.speed ?? 1;
    const localTime = playhead - clip.start;
    const target = rampSampler
      ? rampSampler.sourceTimeAtLocalTime(localTime)
      : clip.trimStart + localTime * speed;
    const clamped = Math.max(0, Math.min(asset.duration, target));
    const drift = Math.abs(audio.currentTime - clamped);
    if (drift > (isPlaying ? 0.35 : 1 / 30)) {
      audio.currentTime = clamped;
    }
    const instantaneousSpeed = rampSampler
      ? rampSampler.speedFactorAtLocalTime(localTime)
      : speed;
    audio.playbackRate = Math.max(0.0625, Math.min(4, instantaneousSpeed));
    if (isPlaying) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [asset.duration, clip, gain, isPlaying, playhead, rampSampler, trackMuted]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  return (
    <audio
      ref={audioRef}
      src={asset.url}
      crossOrigin="anonymous"
      preload="auto"
      style={{ display: 'none' }}
    />
  );
}

interface PreviewVisualLayerProps {
  clip: Clip;
  asset: MediaAsset;
  playhead: number;
  isPlaying: boolean;
  trackMuted: boolean;
  aspectRatio: '16:9' | '9:16';
  verticalReframe: number;
  hudPreset: HudPreset;
  onTogglePlay: () => void;
}

/**
 * A synchronized upper video/overlay lane. Keeping each visible lane as its
 * own media element makes imported multi-track projects match native export
 * instead of rendering layers that the preview never showed.
 */
function PreviewVisualLayer({
  clip,
  asset,
  playhead,
  isPlaying,
  trackMuted,
  aspectRatio,
  verticalReframe,
  hudPreset,
  onTogglePlay,
}: PreviewVisualLayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rampSampler = useMemo(() => rampSamplerForClip(clip), [clip]);
  const volume = clip.volume ?? 1;
  useMediaElementGain(
    videoRef,
    volume,
    trackMuted || (clip.muted ?? false) || volume === 0,
    isPlaying,
    clip.audioProcessing,
  );
  const localTime = playhead - clip.start;
  const instantaneousSpeed = rampSampler
    ? rampSampler.speedFactorAtLocalTime(localTime)
    : (clip.speed ?? 1);
  const sampled = sampleClipTransform(clip.transform, localTime);
  const transition = transitionModulationAt(
    clip.transitionIn,
    clip.transitionOut,
    localTime,
    clipDuration(clip),
  );
  let effectOpacity = 1;
  const fadeIn = clip.effects.find((effect) => effect.type === 'fade-in');
  const fadeOut = clip.effects.find((effect) => effect.type === 'fade-out');
  if (fadeIn) {
    const duration = Math.max(0.05, fadeIn.duration ?? 0.4);
    effectOpacity *= Math.max(0, Math.min(1, localTime / duration));
  }
  if (fadeOut) {
    const duration = Math.max(0.05, fadeOut.duration ?? 0.4);
    const remaining = clipDuration(clip) - localTime;
    effectOpacity *= Math.max(0, Math.min(1, remaining / duration));
  }
  const composed = {
    x: sampled.x + transition.dx,
    y: sampled.y + transition.dy,
    scale: sampled.scale * transition.scale,
    rotation: sampled.rotation,
    opacity: sampled.opacity * transition.opacity * effectOpacity,
  };
  const filter = colorGradeFilter(clip.colorGrade);
  const motionBlur = clip.effects.find(
    (effect) => effect.type === 'motion-blur',
  );
  const blurStrength = motionBlur
    ? shapeStrength(
        Math.max(0, Math.min(100, motionBlur.intensity ?? 40)) / 100,
      ) * Math.max(0.5, Math.min(2, clip.speed ?? 1))
    : 0;
  const isVertical = aspectRatio === '9:16';
  const reframePosition =
    `${(((verticalReframe + 1) / 2) * 100).toFixed(1)}% 50%`;
  const videoStyle: React.CSSProperties | undefined = isVertical
    ? { objectFit: 'cover', objectPosition: reframePosition }
    : clip.stretchToFill
      ? { objectFit: 'fill' }
      : undefined;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const target = rampSampler
      ? rampSampler.sourceTimeAtLocalTime(localTime)
      : clip.trimStart + localTime * (clip.speed ?? 1);
    const clamped = Math.max(0, Math.min(asset.duration, target));
    if (Math.abs(video.currentTime - clamped) > (isPlaying ? 0.35 : 1 / 60)) {
      video.currentTime = clamped;
    }
    video.playbackRate = Math.max(
      0.0625,
      Math.min(4, instantaneousSpeed),
    );
    if (isPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [
    asset.duration,
    clip,
    instantaneousSpeed,
    isPlaying,
    localTime,
    rampSampler,
    trackMuted,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    return () => video?.pause();
  }, []);

  return (
    <div
      className={styles.footageLayer}
      style={{
        transform: transformToCss(composed),
        opacity: Math.max(0, Math.min(1, composed.opacity)),
        ...(filter === 'none' ? null : { filter }),
      }}
    >
      <video
        ref={videoRef}
        src={asset.url}
        crossOrigin="anonymous"
        className={styles.video}
        style={videoStyle}
        playsInline
        onClick={onTogglePlay}
      />
      <MotionBlurCanvas
        videoRef={videoRef}
        isPlaying={isPlaying}
        active={blurStrength > 0}
        strength={blurStrength}
        hudPreset={hudPreset}
        hudMaskStrength={hudPreset === 'none' ? 0 : 1}
        aspect={isVertical ? 9 / 16 : 16 / 9}
        coverPosition={isVertical ? reframePosition : undefined}
      />
    </div>
  );
}

export function Preview() {
  const fallbackAsset = useSelectedAsset();
  const assets = useMediaStore((s) => s.assets);
  const clips = useProjectStore((s) => s.clips);
  const tracks = useProjectStore((s) => s.tracks);
  const playhead = useProjectStore((s) => s.playhead);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const togglePlay = useProjectStore((s) => s.togglePlay);
  const aspectRatio = useProjectStore((s) => s.aspectRatio);
  const verticalReframe = useProjectStore((s) => s.verticalReframe);
  const setVerticalReframe = useProjectStore((s) => s.setVerticalReframe);
  const markers = useProjectStore((s) => s.markers);
  const subtitles = useProjectStore((s) => s.subtitles);
  const subtitleStyle = useProjectStore((s) => s.subtitleStyle);
  const audioDucking = useProjectStore((s) => s.audioDucking);
  const visibleSubtitles = useMemo(
    () => activeSubtitleCues(subtitles, playhead),
    [playhead, subtitles],
  );
  const videoTrack = useMemo(
    () =>
      tracks.find(
        (track) =>
          track.kind === 'video' &&
          !track.hidden &&
          clips.some((clip) => clip.trackId === track.id),
      ) ??
      null,
    [clips, tracks],
  );
  const videoTrackId = videoTrack?.id ?? null;
  const videoTrackHidden =
    !videoTrack &&
    tracks.some((track) => track.kind === 'video' && track.hidden);
  const videoTrackMuted = videoTrack?.muted ?? false;

  const audioTracks = useMemo(
    () => tracks.filter((track) => track.kind === 'audio' && !track.hidden),
    [tracks],
  );
  const visibleVisualTrackIds = useMemo(
    () =>
      new Set(
        tracks
          .filter(
            (track) =>
              !track.hidden &&
              (track.kind === 'video' || track.kind === 'overlay'),
          )
          .map((track) => track.id),
      ),
    [tracks],
  );
  const visualDuration = useMemo(
    () =>
      clips
        .filter((clip) => visibleVisualTrackIds.has(clip.trackId))
        .reduce(
          (end, clip) => Math.max(end, clip.start + clipDuration(clip)),
          0,
        ),
    [clips, visibleVisualTrackIds],
  );
  const bgmTrackId = useMemo(
    () => tracks.find((track) => track.kind === 'audio')?.id ?? null,
    [tracks],
  );

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

  const activeUpperVisualLayers = useMemo(() => {
    const visualTracks = tracks.filter(
      (track) =>
        !track.hidden &&
        (track.kind === 'video' || track.kind === 'overlay') &&
        track.id !== videoTrackId,
    );
    return visualTracks.flatMap((track) => {
      const trackClips = clips
        .filter((clip) => clip.trackId === track.id)
        .sort((a, b) => a.start - b.start);
      return trackClips.flatMap((clip, index) => {
        const end = clip.start + clipDuration(clip);
        const asset = assetMap[clip.assetId];
        if (
          playhead < clip.start - 1e-6 ||
          playhead >= end - 1e-6 ||
          !asset ||
          asset.kind !== 'video'
        ) {
          return [];
        }
        return [{
          track,
          clip,
          asset,
          context: {
            n: String(index + 1),
            total: String(trackClips.length),
          },
        }];
      });
    });
  }, [assetMap, clips, playhead, tracks, videoTrackId]);

  // One active clip per audio lane can play concurrently (BGM + SE + ...).
  const activeAudioLayers = useMemo(() => {
    return audioTracks.flatMap((track) => {
      const clip = clips.find((candidate) => {
        if (candidate.trackId !== track.id) return false;
        const end = candidate.start + clipDuration(candidate);
        return playhead >= candidate.start - 1e-6 && playhead < end - 1e-6;
      });
      const asset = clip ? assetMap[clip.assetId] : undefined;
      return clip && asset ? [{ track, clip, asset }] : [];
    });
  }, [assetMap, audioTracks, clips, playhead]);

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
        speedRamp: c.speedRamp,
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
  // playback and the speed badge.
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
    // FFmpeg's temporal blend naturally spans more source motion as a ramp
    // accelerates. Keep its authored tap weights stable across the clip and
    // match that behavior here; the detected motion vector still grows.
    const speedFactor = Math.max(0.5, Math.min(2, clipSpeed));
    return shapeStrength(intensity / 100) * speedFactor * previewBlurBoost;
  }, [clipSpeed, motionBlur, previewBlurBoost]);

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
  const mainVolume = activeClip?.volume ?? 1;
  useMediaElementGain(
    videoRef,
    mainVolume,
    videoTrackMuted ||
      (activeClip?.muted ?? false) ||
      mainVolume === 0,
    isPlaying,
    activeClip?.audioProcessing,
  );
  const playingRef = useRef(isPlaying);

  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);

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

  // Preserve authored black gaps and upper-only intervals. When there is no
  // base <video> to drive the clock, wall time advances the same continuous
  // timeline that native export renders.
  useEffect(() => {
    if (!isPlaying || activeClip) return;
    let rafId = 0;
    let previous = performance.now();
    const step = (now: number) => {
      const elapsed = Math.max(0, Math.min(0.1, (now - previous) / 1000));
      previous = now;
      const state = useProjectStore.getState();
      const visibleTrackIds = new Set(
        state.tracks
          .filter(
            (track) =>
              !track.hidden &&
              (track.kind === 'video' || track.kind === 'overlay'),
          )
          .map((track) => track.id),
      );
      const visualEnd = state.clips
        .filter((clip) => visibleTrackIds.has(clip.trackId))
        .reduce(
          (end, clip) => Math.max(end, clip.start + clipDuration(clip)),
          0,
        );
      if (visualEnd <= 0) {
        state.setIsPlaying(false);
        return;
      }
      const next = Math.min(visualEnd, state.playhead + elapsed);
      state.setPlayhead(next);
      if (next >= visualEnd - 1e-6) {
        state.setIsPlaying(false);
        return;
      }
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [activeClip, isPlaying]);

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
        state.tracks.find(
          (track) =>
            track.kind === 'video' &&
            !track.hidden &&
            state.clips.some((clip) => clip.trackId === track.id),
        )?.id ?? null;
      if (!liveVideoTrackId) {
        state.setIsPlaying(false);
        return;
      }

      const liveVisibleVisualIds = new Set(
        state.tracks
          .filter(
            (track) =>
              !track.hidden &&
              (track.kind === 'video' || track.kind === 'overlay'),
          )
          .map((track) => track.id),
      );
      const totalDur = state.clips
        .filter((clip) => liveVisibleVisualIds.has(clip.trackId))
        .reduce(
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
          // Hand the continuous clock to the gap/upper-only RAF. This keeps
          // black gaps instead of jumping directly to the next base clip.
          const end = current.start + clipDuration(current);
          state.setPlayhead(end);
          v.pause();
          if (end >= totalDur - 1e-6) {
            state.setIsPlaying(false);
          }
          return;
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
        // The wall-clock effect owns authored gaps.
        return;
      }

      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafId);
      video.pause();
    };
  }, [activeClip?.id, isPlaying, videoTrackId]);

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

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPlayhead(parseFloat(e.target.value));
  };

  const skip = (delta: number) => {
    const state = useProjectStore.getState();
    const visibleIds = new Set(
      state.tracks
        .filter(
          (track) =>
            !track.hidden &&
            (track.kind === 'video' || track.kind === 'overlay'),
        )
        .map((track) => track.id),
    );
    const totalDur = state.clips
      .filter((clip) => visibleIds.has(clip.trackId))
      .reduce(
        (m, c) => Math.max(m, c.start + clipDuration(c)),
        0,
      );
    setPlayhead(Math.max(0, Math.min(totalDur || displayAsset?.duration || 0, playhead + delta)));
  };

  const setAspect = (next: '16:9' | '9:16') => {
    useProjectStore.setState({ aspectRatio: next });
  };

  const totalForDisplay =
    visualDuration > 0 ? visualDuration : (displayAsset?.duration ?? 0);
  const canPlayTimeline = clips.some((clip) =>
    visibleVisualTrackIds.has(clip.trackId),
  );
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
          <div className={styles.emptyHint}>MP4 / MOV / AVI / MKV などに対応</div>
        </div>
      </div>
    );
  }

  const showVideo = !!displayAsset && !videoTrackHidden;
  const inGap = clips.length > 0 && !activeClip;
  const isHidden = videoTrackHidden;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.aspectGroup} role="group" aria-label="アスペクト比">
          <button
            type="button"
            className={`${styles.aspectBtn} ${aspectRatio === '16:9' ? styles.aspectActive : ''}`}
            onClick={() => setAspect('16:9')}
            aria-pressed={aspectRatio === '16:9'}
          >
            16:9
          </button>
          <button
            type="button"
            className={`${styles.aspectBtn} ${aspectRatio === '9:16' ? styles.aspectActive : ''}`}
            onClick={() => setAspect('9:16')}
            aria-pressed={aspectRatio === '9:16'}
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

      {activeAudioLayers.map(({ track, clip, asset }) => (
        <PreviewAudioLayer
          key={`${track.id}:${clip.id}`}
          clip={clip}
          asset={asset}
          playhead={playhead}
          isPlaying={isPlaying}
          trackMuted={track.muted}
          gain={track.id === bgmTrackId && duckActive ? duckGain : 1}
        />
      ))}

      <div className={styles.stage}>
        <div className={styles.frame} data-aspect={aspectRatio}>
          {showVideo ? (
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
                crossOrigin="anonymous"
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
          {showVideo && fadeOpacity > 0 ? (
            <div
              className={styles.fadeOverlay}
              style={{ opacity: fadeOpacity }}
              aria-hidden="true"
            />
          ) : null}
          {activeUpperVisualLayers.map(({ track, clip, asset }) => (
            <PreviewVisualLayer
              key={`${track.id}:${clip.id}`}
              clip={clip}
              asset={asset}
              playhead={playhead}
              isPlaying={isPlaying}
              trackMuted={track.muted}
              aspectRatio={aspectRatio}
              verticalReframe={verticalReframe}
              hudPreset={hudPreset}
              onTogglePlay={togglePlay}
            />
          ))}
          {showVideo && activeRampSampler ? (
            <div className={styles.speedBadge} aria-hidden="true">
              {`${instSpeed.toFixed(1)}×`}
            </div>
          ) : showVideo && clipSpeed !== 1 ? (
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
          {showVideo && activeClip?.overlays && activeClip.overlays.length > 0 ? (
            <OverlayLayer
              overlays={activeClip.overlays}
              contextValues={overlayContext}
              localTime={playhead - activeClip.start}
            />
          ) : null}
          {activeUpperVisualLayers.map(({ track, clip, context }) =>
            clip.overlays && clip.overlays.length > 0 ? (
              <OverlayLayer
                key={`overlay:${track.id}:${clip.id}`}
                overlays={clip.overlays}
                contextValues={context}
                localTime={playhead - clip.start}
              />
            ) : null,
          )}
          <SubtitleLayer cues={visibleSubtitles} style={subtitleStyle} />
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
            title={
              canPlayTimeline
                ? (isPlaying ? '一時停止 (Space)' : '再生 (Space)')
                : 'タイムラインに動画を追加すると再生できます'
            }
            disabled={!canPlayTimeline}
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
