import { useEffect, useRef, useState } from 'react';
import styles from './MotionBlurCanvas.module.css';
import {
  type GlSetup,
  type HudPreset,
  HUD_PRESET_INDEX,
  HALFRES_THRESHOLD_H,
  MIN_PIXEL_SHIFT,
  SAMPLE_W,
  SAMPLE_H,
  VELOCITY_DECAY,
  destroySetup,
  estimateGlobalMotion,
  makeSadHistory,
  motionToUniforms,
  renderFrame,
  setupGl,
} from '../../lib/motionBlurCore';

// HudPreset is re-exported so existing importers of this component module
// (Preview.tsx etc.) keep working without touching their import paths.
export type { HudPreset };

interface MotionBlurCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Drive the RAF loop only when the video is actually playing. */
  isPlaying: boolean;
  /** Master switch — when false the canvas is unmounted and video shows raw. */
  active: boolean;
  /**
   * Peak blur strength multiplier. 0..~1.5 in legacy units, but the UI now
   * feeds a gamma-shaped 0..1 value (see Preview.tsx). The shader caps line
   * length internally so excessive strength can't blow past frame edges.
   */
  strength: number;
  /**
   * Which HUD preset to apply, if any. Optional — defaults to 'valorant'
   * to preserve the original behaviour.
   */
  hudPreset?: HudPreset;
  /**
   * HUD mask attenuation, 0..1. 1 = fully suppress motion blur inside the
   * preset's protected zones, 0 = no positional protect. Optional — defaults
   * to 1 when a preset other than 'none' is selected.
   */
  hudMaskStrength?: number;
  /**
   * Frame aspect ratio (width/height). The shader normalises HUD coords
   * against this so a portrait 9:16 source still has a sensible layout
   * (top/bottom regions stay top/bottom rather than being squashed).
   * Optional — defaults to the canvas aspect when unset.
   */
  aspect?: number;
  /**
   * When set (a CSS object-position like "30% 50%"), the canvas is displayed
   * with object-fit:cover at that position so the blur layer crops to match a
   * vertical (9:16) cover-cropped video instead of stretching to the frame.
   */
  coverPosition?: string;
}

/**
 * Detect prefers-reduced-motion. SSR-safe — returns false when window /
 * matchMedia are unavailable. Subscribes to changes so the canvas can be
 * unmounted live if the user toggles the OS setting mid-session.
 */
function usePrefersReducedMotion(): boolean {
  const getInitial = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };
  const [reduced, setReduced] = useState<boolean>(getInitial);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    // Older Safari: addListener fallback.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduced;
}

export function MotionBlurCanvas({
  videoRef,
  isPlaying,
  active,
  strength,
  hudPreset = 'valorant',
  hudMaskStrength = 1,
  aspect,
  coverPosition,
}: MotionBlurCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Refs so the RAF loop reads the latest values without re-running the effect.
  const strengthRef = useRef(strength);
  const playingRef = useRef(isPlaying);
  const hudMaskRef = useRef(hudMaskStrength);
  const hudPresetRef = useRef<HudPreset>(hudPreset);
  const aspectRef = useRef<number | undefined>(aspect);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    strengthRef.current = strength;
    playingRef.current = isPlaying;
    hudMaskRef.current = Math.max(0, Math.min(1, hudMaskStrength));
    hudPresetRef.current = hudPreset;
    aspectRef.current = aspect;
  }, [strength, isPlaying, hudMaskStrength, hudPreset, aspect]);

  // Force-disable the canvas when the user prefers reduced motion. We still
  // need to call hooks above this branch to keep React's hook order stable.
  const effectiveActive = active && !prefersReducedMotion;

  useEffect(() => {
    if (!effectiveActive) return;
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const initial = setupGl(canvas);
    if (!initial) return;
    // Declared as a definite GlSetup so the render path can read uniforms
    // without re-narrowing. Reassigned only inside webglcontextrestored.
    let setup: GlSetup = initial;

    // Mutable so we can swap which texture is "current" vs "previous" each
    // frame without re-uploading the same data twice.
    let curTexture: WebGLTexture = setup.curTexture;
    let prevTexture: WebGLTexture = setup.prevTexture;
    let prevTextureHasData = false;

    // CPU-side sampling surface for motion estimation.
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = SAMPLE_W;
    sampleCanvas.height = SAMPLE_H;
    const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!sampleCtx) {
      destroySetup(setup);
      return;
    }

    // Persistent buffer for the previous frame's sampled pixels — avoid
    // allocating a fresh Uint8ClampedArray every tick (GC pressure adds up
    // at 60 Hz). `prevValid` tracks whether prevFrame holds usable data.
    const SAMPLE_BYTES = SAMPLE_W * SAMPLE_H * 4;
    const prevFrame = new Uint8ClampedArray(SAMPLE_BYTES);
    let prevValid = false;
    let smoothDx = 0;
    let smoothDy = 0;
    // Carry-over motion from previous tick — produces the "tail" that
    // makes flick→hold transitions feel weighty rather than snapping
    // abruptly to sharp. See VELOCITY_DECAY.
    let carryDx = 0;
    let carryDy = 0;
    const sadHistory = makeSadHistory();
    let rafId = 0;
    let contextLost = false;
    const EMA = 0.4;

    // Context-lost handling. The browser can yank the WebGL context (GPU
    // process restart, tab backgrounded too long on some platforms, driver
    // reset). preventDefault on the lost event tells the browser we want it
    // back; we then re-setup on restore. While lost we suspend RAF and skip
    // any GL calls — those would all be no-ops + spam the console.
    const onContextLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      cancelAnimationFrame(rafId);
      rafId = 0;
      prevTextureHasData = false;
      prevValid = false;
    };
    const onContextRestored = () => {
      const fresh = setupGl(canvas);
      if (!fresh) {
        // setupGl already logs in dev; nothing actionable here.
        return;
      }
      // Release the program/buffer/textures from the previous (lost)
      // context BEFORE reassigning. Without this, every lose/restore
      // cycle leaks one program + two textures + one buffer GPU-side.
      // On low-VRAM platforms (mobile Safari, integrated GPUs) the leak
      // accelerates further context losses → feedback loop.
      const prev = setup;
      setup = fresh;
      curTexture = fresh.curTexture;
      prevTexture = fresh.prevTexture;
      prevTextureHasData = false;
      smoothDx = 0;
      smoothDy = 0;
      carryDx = 0;
      carryDy = 0;
      contextLost = false;
      destroySetup(prev);
      rafId = requestAnimationFrame(tick);
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (contextLost) return;
      // HAVE_CURRENT_DATA (≥2) is enough — strictly waiting for ≥3 caused
      // the canvas to stay at its initial (black, alpha:false) state when
      // the video was paused or scrubbing because readyState would dip to
      // 2. We catch any texImage2D INVALID_STATE_ERR with the try/catch
      // below and just skip motion estimation that tick.
      if (video.readyState < 2) return;
      if (video.videoWidth === 0 || video.videoHeight === 0) return;

      // Backing-store resolution: full for SD/HD-Ready, half for HD/FHD+.
      // Sub-sampling here is fine because the shader's many-sample line
      // integral is already softening detail along the motion direction;
      // we lose no meaningful info while cutting fragment work to a quarter.
      const halfRes = video.videoHeight > HALFRES_THRESHOLD_H;
      const targetW = halfRes ? Math.ceil(video.videoWidth / 2) : video.videoWidth;
      const targetH = halfRes ? Math.ceil(video.videoHeight / 2) : video.videoHeight;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        // Canvas resize blows away the backing store; the ping-pong texture
        // contents are still valid (textures live independently of the
        // canvas surface) but the GL viewport needs to match. We set
        // viewport every frame below, so nothing else is required here.
      }

      // === Motion estimation (CPU) ===
      let dxPx = 0;
      let dyPx = 0;
      if (playingRef.current) {
        try {
          sampleCtx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
          const data = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
          if (prevValid) {
            const est = estimateGlobalMotion(data, prevFrame, sadHistory);
            // Below MIN_PIXEL_SHIFT we treat as still — kills jitter on
            // aim hold. The adaptive threshold inside estimateGlobalMotion
            // already declares the obviously-still frames; this guards
            // against tiny sub-pixel jitter making it past that.
            const mag = Math.hypot(est.dx, est.dy);
            if (!est.isStill && mag >= MIN_PIXEL_SHIFT) {
              dxPx = est.dx;
              dyPx = est.dy;
            }
          }
          prevFrame.set(data);
          prevValid = true;
        } catch {
          // drawImage / getImageData can throw if the frame isn't decoded
          // yet (rare race when seeking) or if the source is tainted.
          // Either way: skip motion this tick, retry next frame.
          prevValid = false;
        }
      } else {
        // Paused — let the smoothed motion decay so any in-flight blur fades.
        prevValid = false;
      }

      // Velocity decay: when motion drops to zero, blend in a fraction of
      // the previous tick's motion so the trail eases out over 2-3 frames
      // instead of snapping. When motion increases (acceleration), the
      // current measurement dominates and the carry adds barely anything.
      const measuredDx = dxPx + carryDx * VELOCITY_DECAY;
      const measuredDy = dyPx + carryDy * VELOCITY_DECAY;
      // Update the carry for next tick. If we picked up genuine motion
      // this tick, that's what we want to carry; if we didn't, the
      // existing carry decays one more step.
      if (Math.hypot(dxPx, dyPx) > 0) {
        carryDx = dxPx;
        carryDy = dyPx;
      } else {
        carryDx *= VELOCITY_DECAY;
        carryDy *= VELOCITY_DECAY;
      }

      smoothDx = smoothDx * (1 - EMA) + measuredDx * EMA;
      smoothDy = smoothDy * (1 - EMA) + measuredDy * EMA;

      // Convert the smoothed sample-cell shift into UV-space uniforms +
      // adaptive sample count (shared with the export renderer).
      const { motionUVX, motionUVY, magnitudeUV, sampleCount } = motionToUniforms(
        smoothDx, smoothDy, strengthRef.current,
      );

      // === GPU render ===
      const { gl } = setup;
      // isContextLost is the canonical guard — onContextLost may not have
      // fired yet on the frame where the context was actually lost.
      if (gl.isContextLost()) return;

      // Upload the new video frame into the "current" texture. If the
      // upload throws (e.g. INVALID_STATE_ERR during a seek), we must
      // NOT bail out of the tick — that would skip drawArrays entirely,
      // leaving the canvas's framebuffer at its initial cleared state
      // (which is opaque black when the context was created with
      // alpha:false). Better to render the LAST successfully-uploaded
      // frame again than to flash to black.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, curTexture);
      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          video,
        );
      } catch {
        // Continue with the existing texture contents. renderFrame still
        // runs below so the canvas displays a stable frame instead of
        // collapsing to black.
      }

      // Keep setup.curTexture / setup.prevTexture pointing at the live
      // ping-pong roles so renderFrame binds the correct textures.
      setup.curTexture = curTexture;
      setup.prevTexture = prevTexture;

      const fallbackAspect = canvas.width / Math.max(1, canvas.height);
      renderFrame(setup, canvas.width, canvas.height, {
        motionUVX,
        motionUVY,
        magnitudeUV,
        sampleCount,
        hudMask: hudMaskRef.current,
        hudPresetIndex: HUD_PRESET_INDEX[hudPresetRef.current],
        aspect: aspectRef.current ?? fallbackAspect,
        hasPrevFrame: prevTextureHasData,
      });

      // Ping-pong: next tick's "previous" is the texture we just rendered from.
      // Keep `setup.curTexture` / `setup.prevTexture` in sync with the local
      // swap variables — `destroySetup` reads from setup.*, and on an odd
      // number of ticks the originals are misnamed relative to the live
      // role. Both textures still get deleted (no leak today) but the
      // mismatch is a latent landmine if cleanup is ever made selective.
      const swap = curTexture;
      curTexture = prevTexture;
      prevTexture = swap;
      setup.curTexture = curTexture;
      setup.prevTexture = prevTexture;
      prevTextureHasData = true;
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      destroySetup(setup);
    };
    // `strength`, `hudMaskStrength`, `hudPreset`, and `aspect` are
    // deliberately read through Refs inside the RAF loop so adjustments
    // don't tear down and rebuild the WebGL context. Including them here
    // would re-allocate textures and shaders on every slider tick.
  }, [effectiveActive, videoRef]);

  if (!effectiveActive) return null;
  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      style={coverPosition ? { objectFit: 'cover', objectPosition: coverPosition } : undefined}
      aria-hidden="true"
    />
  );
}
