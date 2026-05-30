import { useEffect, useRef, useState } from 'react';
import styles from './MotionBlurCanvas.module.css';

/**
 * HUD preset names. Each preset describes a per-game family of view-locked
 * UI rectangles in normalised UV space. The shader treats them as soft
 * smoothstep regions so the boundary doesn't read as a hard seam.
 *   - valorant: classic FPS layout (bottom weapon band + corner readouts + top bar)
 *   - cs2:      slightly different ammo/radar positions, no weapon band
 *   - apex:     larger bottom-right ammo/ult region + minimap top-left
 *   - none:     disable the positional mask entirely (rely on luma diff)
 */
export type HudPreset = 'valorant' | 'cs2' | 'apex' | 'none';

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
}

const VERT_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

// Per-pixel directional motion blur with a frame-diff mask to spare
// static UI elements (minimap, scoreboard, weapon HUD) from the global
// camera-pan blur. For each output texel we:
//   1. Sample current and previous frame at the same UV.
//   2. Compute the luma-distance between them (gated by HUD mask).
//   3. smoothstep that distance into a 0..1 "is this pixel moving?" mask.
//   4. Walk the motion vector and accumulate samples in *linear* light.
//   5. Average → return to sRGB → mix sharp/blurred by the mask.
//
// Linear-light accumulation is the headline upgrade — averaging in sRGB
// makes motion trails look muddy/dark because sRGB stores perceived
// brightness on a non-linear curve. Going to linear, averaging, and back
// gives the "film-strip" look real motion blur has on physical sensors.
//
// We also use a 'mirror repeat' fade at the integration edges so that
// samples falling outside the texture don't sit on the clamped border
// pixel (which produces a smeared stripe on long blurs). Instead the
// out-of-range portion of the integral fades to the in-range mean,
// matching the energy of the centre samples without the stripe artifact.
const FRAG_SRC = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_frame;        // current frame
  uniform sampler2D u_prevFrame;    // previous frame (for diff mask)
  uniform vec2 u_motionUV;          // motion vector in UV space (already scaled by strength)
  uniform float u_magnitude;        // length of motion in UV space, used to gate the loop
  uniform float u_maskLow;          // diff below this → fully sharp
  uniform float u_maskHigh;         // diff above this → fully blurred
  uniform float u_hudMask;          // 0..1 weight on the positional HUD protect
  uniform int u_hudPreset;          // 0=valorant 1=cs2 2=apex 3=none
  uniform float u_aspect;           // viewport aspect (w/h) for HUD layout
  uniform int u_samples;            // adaptive sample count (cap at SAMPLES_MAX)

  // Maximum sample count — must be a compile-time constant in WebGL 1 GLSL
  // because the for-loop iteration count has to be statically bounded.
  // We escape the bound dynamically with an early break on i >= u_samples.
  const int SAMPLES_MAX = 48;
  const float HALF = 0.5;

  // Baseline blur blend applied across the WHOLE frame when confident global
  // (camera) motion is detected — see the note in main(). During a camera pan
  // flat/low-contrast regions are moving too, but their frame-to-frame luma
  // barely changes, so the per-pixel diff mask alone left them sharp and made
  // the effect read as weak. This floor restores a body-of-frame blur.
  const float GLOBAL_BLUR_FLOOR = 0.7;

  // Rec.601 luma — cheap motion proxy, robust to chroma noise.
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  // sRGB <-> linear-light conversion.
  //
  // CRITICAL: GLSL ES 1.0 spec says pow(0, y) is UNDEFINED behaviour. On
  // some GPUs this returns NaN, which then propagates through acc/weightSum
  // and renders the affected fragments as solid black. Pure-black source
  // pixels (HUD backgrounds, dark scene corners) were hitting this and
  // showing up as black streaks in the blurred output. Clamp to a tiny
  // positive floor so pow() is always well-defined; the perceptual cost of
  // 0 vs 1/255 in linear space is invisible.
  vec3 toLinear(vec3 c) { return pow(max(c, vec3(1.0 / 255.0)), vec3(2.2)); }
  vec3 toSRGB(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }

  // Aspect-corrected UV. We compute HUD positions against a (1, 1/aspect)
  // virtual canvas so 9:16 portrait sources still have horizontal HUD
  // zones at the visual top/bottom. For 16:9 this is a no-op.
  vec2 hudUV(vec2 uv) {
    // No remap — using raw uv keeps top/bottom/left/right intuitive
    // for both 16:9 and 9:16. The aspect is reserved for future per-
    // preset metric scaling (e.g. minimap diameter in pixels).
    return uv;
  }

  // ===== HUD presets ============================================
  // Each returns a 0..1 mask: 1 inside the protected zone, 0 outside,
  // smoothed at the edges so the seam isn't visible as a hard band.
  // Coordinates are tuned from real screenshots of each title at 1080p,
  // then normalised to UV. Soft borders (smoothstep) so a weapon edge
  // sitting right on the band still blurs slightly rather than snapping
  // to sharp — much less perceptually obvious.

  float bandY(float uvy, float lo, float hi, float feather) {
    // Soft horizontal band: full strength between lo+feather and hi-feather,
    // ramps to zero at lo and hi.
    return smoothstep(lo, lo + feather, uvy) * (1.0 - smoothstep(hi - feather, hi, uvy));
  }

  float rectMask(vec2 uv, vec2 lo, vec2 hi, float feather) {
    float fx = smoothstep(lo.x, lo.x + feather, uv.x) * (1.0 - smoothstep(hi.x - feather, hi.x, uv.x));
    float fy = smoothstep(lo.y, lo.y + feather, uv.y) * (1.0 - smoothstep(hi.y - feather, hi.y, uv.y));
    return fx * fy;
  }

  float valorantHud(vec2 uv) {
    float weaponBand = smoothstep(0.58, 0.74, uv.y);
    float bottomLeft = rectMask(uv, vec2(0.0, 0.85), vec2(0.34, 1.0), 0.04);
    float bottomRight = rectMask(uv, vec2(0.66, 0.85), vec2(1.0, 1.0), 0.04);
    float topBar = 1.0 - smoothstep(0.07, 0.10, uv.y);
    float minimap = rectMask(uv, vec2(0.0, 0.0), vec2(0.22, 0.32), 0.04);
    float timer = rectMask(uv, vec2(0.45, 0.0), vec2(0.55, 0.08), 0.02);
    return max(weaponBand, max(bottomLeft, max(bottomRight, max(topBar, max(minimap, timer)))));
  }

  float cs2Hud(vec2 uv) {
    // CS2: no big weapon overlay (only crosshair), HP bottom-left, ammo
    // bottom-right, radar top-left.
    float hp = rectMask(uv, vec2(0.0, 0.88), vec2(0.28, 1.0), 0.04);
    float ammo = rectMask(uv, vec2(0.78, 0.88), vec2(1.0, 1.0), 0.04);
    float radar = rectMask(uv, vec2(0.0, 0.0), vec2(0.18, 0.26), 0.04);
    float topBar = 1.0 - smoothstep(0.06, 0.09, uv.y);
    return max(hp, max(ammo, max(radar, topBar)));
  }

  float apexHud(vec2 uv) {
    // Apex: prominent bottom-right ammo + ult column, bigger weapon band,
    // minimap top-left, squad indicators bottom-left.
    float weaponBand = smoothstep(0.62, 0.78, uv.y);
    float bottomRight = rectMask(uv, vec2(0.60, 0.78), vec2(1.0, 1.0), 0.05);
    float bottomLeft = rectMask(uv, vec2(0.0, 0.78), vec2(0.32, 1.0), 0.05);
    float minimap = rectMask(uv, vec2(0.0, 0.0), vec2(0.20, 0.28), 0.04);
    return max(weaponBand, max(bottomRight, max(bottomLeft, minimap)));
  }

  float hudPresetMask(vec2 uv) {
    if (u_hudPreset == 0) return valorantHud(uv);
    if (u_hudPreset == 1) return cs2Hud(uv);
    if (u_hudPreset == 2) return apexHud(uv);
    return 0.0;
  }

  // Edge fade weight. Samples whose UV falls OUTSIDE [0,1] in either
  // axis are weighted down rather than snapped to the clamped border
  // (which would smear a hot border pixel along the whole streak).
  //
  // Critical: the fade region must be OUTSIDE [0,1], not inside. Earlier
  // versions used a smoothstep at [0.0, 0.02] which made the in-range
  // edge weight=0 and caused 2%-wide BLACK strips when a pixel column
  // had no other in-range samples (e.g. pure-vertical pan applied to
  // the leftmost column).
  float edgeFade(vec2 sampleUv) {
    // x: weight 1 throughout [0,1], ramps to 0 across the -0.02..0 and
    // 1..1.02 margins outside the frame.
    float fx =
      smoothstep(-0.02, 0.0, sampleUv.x) *
      (1.0 - smoothstep(1.0, 1.02, sampleUv.x));
    float fy =
      smoothstep(-0.02, 0.0, sampleUv.y) *
      (1.0 - smoothstep(1.0, 1.02, sampleUv.y));
    return fx * fy;
  }

  void main() {
    vec4 cur = texture2D(u_frame, v_uv);

    // === Positional HUD mask ======================================
    vec2 uvForHud = hudUV(v_uv);
    float hudRaw = (u_hudPreset == 3) ? 0.0 : hudPresetMask(uvForHud);
    float hudMask = hudRaw * u_hudMask;

    // Below a minimum motion magnitude the scene is effectively still —
    // skip the integration entirely to keep aim-hold frames pixel-perfect.
    if (u_magnitude < 0.0005) {
      gl_FragColor = cur;
      return;
    }

    // Per-pixel "is this moving?" mask from frame-to-frame luma change.
    // Boosts genuinely high-contrast moving edges above the baseline.
    vec3 prev = texture2D(u_prevFrame, v_uv).rgb;
    float diff = abs(luma(cur.rgb) - luma(prev));
    float diffMask = smoothstep(u_maskLow, u_maskHigh, diff);

    // Global camera motion means the ENTIRE scene is shifting, so flat /
    // low-contrast regions are moving too even though their frame-to-frame
    // luma barely changes. Relying on the diff mask alone left those areas
    // sharp and made the blur read as weak. Add a baseline blend that scales
    // with the detected global motion magnitude; the diff mask then layers
    // extra blur onto high-motion edges on top of this floor.
    float globalMotion = smoothstep(0.0015, 0.02, u_magnitude);
    float maskStrength = max(diffMask, globalMotion * GLOBAL_BLUR_FLOOR);

    // HUD wins. Multiplicative suppression forces the blend to zero inside
    // the protected zones, even when global/diff motion would otherwise
    // read as "moving" (e.g. animated minimap blips).
    maskStrength *= (1.0 - hudMask);

    // Motion clamp — cap line-integral length at 8% of UV space. Without
    // this, strength × measured motion can sweep past the actual scene
    // shift, producing a secondary ghost at the integration extremes.
    vec2 motion = u_motionUV;
    float motionLen = length(motion);
    if (motionLen > 0.08) {
      motion = motion * (0.08 / motionLen);
    }

    // ===== Line integral =========================================
    // Uniform sRGB averaging — kept conservative on purpose. Linear-light
    // accumulation was producing solid-black output on some GPUs because
    // pow() near zero is unstable, and the edge-fade weighting could drive
    // weightSum below 1e-4 in corner cases. Plain averaging is robust and
    // visually fine; the muddy-gray-smear concern is dominated by the
    // diff mask which keeps static UI sharp anyway.
    vec3 acc = vec3(0.0);
    float fs = max(float(u_samples), 1.0);
    // Static loop bound for GLSL ES 1.0; break early once we hit u_samples.
    for (int i = 0; i < SAMPLES_MAX; i++) {
      if (i >= u_samples) break;
      float t = (float(i) / max(fs - 1.0, 1.0)) - HALF;
      vec2 sUv = v_uv + motion * t;
      acc += texture2D(u_frame, sUv).rgb;
    }
    vec3 blurred = acc / fs;

    gl_FragColor = vec4(mix(cur.rgb, blurred, maskStrength), cur.a);
  }
`;

// CPU-side motion estimation. Hierarchical SAD: a coarse pass at step 2
// over the full search window pinpoints the rough motion direction, then
// a fine pass at step 1 refines within ±1 of that result. FPS gameplay
// is dominated by camera motion, so a single global vector captures the
// dominant blur direction well — dense optical flow would be more
// accurate for independent object motion but is out of reach for
// real-time pure-JS browser playback.
export const SAMPLE_W = 80;
export const SAMPLE_H = 45;
// Search up to ±16 sample-cells; a VALORANT flick can shift the frame
// 20-30% in a single 60fps frame, so we need this much range.
const SEARCH_RADIUS = 16;
export const MIN_PIXEL_SHIFT = 1.4; // below this, treat as zero motion
// Skip bands fed into SAD. Including the static HUD / weapon area in
// motion estimation drags the estimate toward zero ("most pixels haven't
// moved"). Trim 10% off the top (scoreboard) and 42% off the bottom
// (weapon + lower HUD) so SAD sees mostly the 3D scene.
const SAD_TOP_SKIP = Math.floor(SAMPLE_H * 0.1);
const SAD_BOTTOM_SKIP = Math.floor(SAMPLE_H * 0.42);
// Inner-loop stride for SAD evaluation. Step 2 → ¼ the abs ops per
// candidate vs step 1, with negligible accuracy loss for global motion.
const INNER_STRIDE_Y = 2;
const INNER_STRIDE_X = 2;
// Half-res rendering threshold. Videos taller than this run the shader
// at half backing-store resolution then upscale via CSS — 4× less
// fragment shading at a softness that matches the blur effect anyway.
// Render at half backing-store resolution when the source exceeds this
// height. Set to 1080 so 720p captures (the most common game recording
// resolution for this tool) render at full resolution; only 1440p+ /
// 4K sources drop to half-res. The previous 720 threshold dropped 1080p
// to 540 backing-store, which over-softened a primary use case.
export const HALFRES_THRESHOLD_H = 1080;

// Aim-hold detection — fps-aware. Instead of a hard SAD<600 cutoff
// (which can pop in/out between frames), we keep a rolling history of
// the last N SAD-at-zero readings and pick a dynamic threshold from
// mean + k*stddev. Frames whose SAD is comfortably below the band are
// declared "still" and skip the search.
const SAD_HISTORY = 12;
const SAD_THRESHOLD_K = 1.2; // mean + 1.2σ → ~88% confidence still
const SAD_FLOOR = 350; // never go lower than this — protects against
                       // very dark / very flat scenes whose absolute SAD
                       // is tiny even during real motion.

// Velocity decay — fraction of the previous frame's motion that
// persists into the current frame's contribution. Creates the "tail"
// effect on flick→hold transitions: the blur doesn't vanish the moment
// the camera stops, it fades over ~2-3 frames.
export const VELOCITY_DECAY = 0.6;

// Adaptive sample count bounds. Low motion → 12 samples is plenty
// (visibly indistinguishable from 32). High motion → up to 48 keeps the
// trail smooth without banding. WebGL 1 requires the loop bound to be
// a compile-time constant so SAMPLES_MAX in the shader matches this.
export const SAMPLES_MIN = 12;
export const SAMPLES_MAX = 48;

// Dev-only logger. Compiles out in production builds so we don't ship
// debug noise to end users but keep useful WebGL diagnostics during HMR.
const isDev = import.meta.env?.DEV ?? false;
function devError(...args: unknown[]): void {
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.error(...args);
}

// Uniform locations are nullable on purpose: per the WebGL spec, an unused
// uniform can be optimised out by the GLSL compiler and getUniformLocation
// will then return null. Passing null to gl.uniform*() is a silent no-op,
// which is what we want during partial-shader development / dead-code
// elimination. Gating on truthiness here was the bug that made the whole
// canvas refuse to render after the magenta diagnostic optimised out every
// uniform except u_frame: setup returned null → useEffect early-returned →
// no RAF loop → opaque-black framebuffer.
export interface GlSetup {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  /** Texture currently bound to TEXTURE0 — the freshly uploaded frame. */
  curTexture: WebGLTexture;
  /** Texture bound to TEXTURE1 — the previous tick's frame, used for the mask. */
  prevTexture: WebGLTexture;
  uMotion: WebGLUniformLocation | null;
  uMagnitude: WebGLUniformLocation | null;
  uFrame: WebGLUniformLocation | null;
  uPrevFrame: WebGLUniformLocation | null;
  uMaskLow: WebGLUniformLocation | null;
  uMaskHigh: WebGLUniformLocation | null;
  uHudMask: WebGLUniformLocation | null;
  uHudPreset: WebGLUniformLocation | null;
  uAspect: WebGLUniformLocation | null;
  uSamples: WebGLUniformLocation | null;
  aPos: number;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    devError('Shader compile error:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function setupGl(canvas: HTMLCanvasElement): GlSetup | null {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    devError('Program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  const buffer = gl.createBuffer();
  if (!buffer) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const makeTex = (): WebGLTexture | null => {
    const t = gl.createTexture();
    if (!t) return null;
    gl.bindTexture(gl.TEXTURE_2D, t);
    // CLAMP_TO_EDGE — the shader uses edgeFade() to weight down out-of-
    // range samples instead of relying on wrap-around behaviour, so the
    // raw clamping never produces visible smear.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // LINEAR so the shader's sub-pixel sample offsets give bilinear interp.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  const curTexture = makeTex();
  const prevTexture = makeTex();
  if (!curTexture || !prevTexture) return null;

  // Uniform locations are intentionally NOT gated on truthiness — a null
  // here is a valid signal from the driver that the uniform was optimised
  // out (e.g. during shader iteration). Setting a null location via
  // gl.uniform*() is a documented no-op, so storing null and letting the
  // tick call through is safe and avoids the catastrophic "whole canvas
  // goes black" failure mode if a uniform is ever unused.
  const uMotion = gl.getUniformLocation(program, 'u_motionUV');
  const uMagnitude = gl.getUniformLocation(program, 'u_magnitude');
  const uFrame = gl.getUniformLocation(program, 'u_frame');
  const uPrevFrame = gl.getUniformLocation(program, 'u_prevFrame');
  const uMaskLow = gl.getUniformLocation(program, 'u_maskLow');
  const uMaskHigh = gl.getUniformLocation(program, 'u_maskHigh');
  const uHudMask = gl.getUniformLocation(program, 'u_hudMask');
  const uHudPreset = gl.getUniformLocation(program, 'u_hudPreset');
  const uAspect = gl.getUniformLocation(program, 'u_aspect');
  const uSamples = gl.getUniformLocation(program, 'u_samples');
  const aPos = gl.getAttribLocation(program, 'a_pos');
  // aPos < 0 means the attribute is genuinely unbound; with a single
  // fullscreen-quad vertex attribute this would be a real bug, so we keep
  // failing here.
  if (aPos < 0) {
    devError('a_pos attribute not found in shader');
    return null;
  }

  return {
    gl,
    program,
    buffer,
    curTexture,
    prevTexture,
    uMotion,
    uMagnitude,
    uFrame,
    uPrevFrame,
    uMaskLow,
    uMaskHigh,
    uHudMask,
    uHudPreset,
    uAspect,
    uSamples,
    aPos,
  };
}

function computeSad(
  current: Uint8ClampedArray,
  previous: Uint8ClampedArray,
  dx: number,
  dy: number,
): number {
  let sad = 0;
  // Constrain y to the middle band: outside SAD_TOP_SKIP / SAD_BOTTOM_SKIP
  // we're looking at view-locked HUD / weapon, which would bias the
  // estimate toward "no motion". SEARCH_RADIUS bounds keep all (y+dy)
  // accesses in-bounds.
  const yStart = Math.max(SEARCH_RADIUS, SAD_TOP_SKIP);
  const yEnd = Math.min(SAMPLE_H - SEARCH_RADIUS, SAMPLE_H - SAD_BOTTOM_SKIP);
  for (let y = yStart; y < yEnd; y += INNER_STRIDE_Y) {
    const rowCur = y * SAMPLE_W;
    const rowPrev = (y + dy) * SAMPLE_W;
    for (let x = SEARCH_RADIUS; x < SAMPLE_W - SEARCH_RADIUS; x += INNER_STRIDE_X) {
      // R channel as luma proxy — cheap and well-correlated for natural footage.
      const a = current[(rowCur + x) * 4];
      const b = previous[(rowPrev + (x + dx)) * 4];
      sad += a > b ? a - b : b - a;
    }
  }
  return sad;
}

export interface SadHistoryState {
  values: Float32Array;
  index: number;
  filled: number;
}

export function makeSadHistory(): SadHistoryState {
  return { values: new Float32Array(SAD_HISTORY), index: 0, filled: 0 };
}

/**
 * Compute the rolling (mean + k*stddev) threshold from a sliding window
 * of recent SAD-at-zero readings. Returns a `MIN_THRESHOLD` floor so
 * pathologically dark/flat scenes don't get falsely flagged.
 */
function adaptiveStillThreshold(hist: SadHistoryState): number {
  if (hist.filled < 4) return SAD_FLOOR; // not enough history yet
  let sum = 0;
  for (let i = 0; i < hist.filled; i++) sum += hist.values[i];
  const mean = sum / hist.filled;
  let varSum = 0;
  for (let i = 0; i < hist.filled; i++) {
    const d = hist.values[i] - mean;
    varSum += d * d;
  }
  const stddev = Math.sqrt(varSum / hist.filled);
  return Math.max(SAD_FLOOR, mean + SAD_THRESHOLD_K * stddev);
}

function pushSadHistory(hist: SadHistoryState, sad: number): void {
  hist.values[hist.index] = sad;
  hist.index = (hist.index + 1) % SAD_HISTORY;
  if (hist.filled < SAD_HISTORY) hist.filled++;
}

export function estimateGlobalMotion(
  current: Uint8ClampedArray,
  previous: Uint8ClampedArray,
  hist: SadHistoryState,
): { dx: number; dy: number; sadAtZero: number; isStill: boolean } {
  // Phase 1: still-frame check at (0,0) using a *dynamic* threshold from
  // the rolling SAD history. Without history (warm-up) we fall back to
  // the SAD_FLOOR. This is fps-aware and adapts to clip-specific noise.
  const sadAtZero = computeSad(current, previous, 0, 0);
  const stillThreshold = adaptiveStillThreshold(hist);
  if (sadAtZero < stillThreshold) {
    pushSadHistory(hist, sadAtZero);
    return { dx: 0, dy: 0, sadAtZero, isStill: true };
  }

  // Phase 2: coarse search at step 2 across the full ±SEARCH_RADIUS window.
  let bestDx = 0;
  let bestDy = 0;
  let bestSad = sadAtZero;
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += 2) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 2) {
      const sad = computeSad(current, previous, dx, dy);
      if (sad < bestSad) {
        bestSad = sad;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  // Phase 3: refine around the coarse winner at step 1.
  const refineMinX = Math.max(-SEARCH_RADIUS, bestDx - 1);
  const refineMaxX = Math.min(SEARCH_RADIUS, bestDx + 1);
  const refineMinY = Math.max(-SEARCH_RADIUS, bestDy - 1);
  const refineMaxY = Math.min(SEARCH_RADIUS, bestDy + 1);
  for (let dy = refineMinY; dy <= refineMaxY; dy++) {
    for (let dx = refineMinX; dx <= refineMaxX; dx++) {
      // Skip the coarse-grid points we already evaluated.
      if (dx % 2 === 0 && dy % 2 === 0) continue;
      const sad = computeSad(current, previous, dx, dy);
      if (sad < bestSad) {
        bestSad = sad;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  // Record this frame's at-zero reading so the rolling threshold tracks
  // scene-level luminance / noise drift over time.
  pushSadHistory(hist, sadAtZero);
  return { dx: bestDx, dy: bestDy, sadAtZero, isStill: false };
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
    // Sync once on mount (covers the SSR-false → CSR-true case).
    setReduced(mq.matches);
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

export const HUD_PRESET_INDEX: Record<HudPreset, number> = {
  valorant: 0,
  cs2: 1,
  apex: 2,
  none: 3,
};

export function MotionBlurCanvas({
  videoRef,
  isPlaying,
  active,
  strength,
  hudPreset = 'valorant',
  hudMaskStrength = 1,
  aspect,
}: MotionBlurCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Refs so the RAF loop reads the latest values without re-running the effect.
  const strengthRef = useRef(strength);
  strengthRef.current = strength;
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;
  const hudMaskRef = useRef(hudMaskStrength);
  hudMaskRef.current = Math.max(0, Math.min(1, hudMaskStrength));
  const hudPresetRef = useRef<HudPreset>(hudPreset);
  hudPresetRef.current = hudPreset;
  const aspectRef = useRef<number | undefined>(aspect);
  aspectRef.current = aspect;
  const prefersReducedMotion = usePrefersReducedMotion();

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
        devError('WebGL context restore: setup failed');
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

      // Convert the SAD sample-cell shift into UV space at the video's
      // resolution. SAMPLE_W cells span the whole frame, so 1 cell =
      // 1/SAMPLE_W of UV. Multiply by strength so the slider controls
      // the visible blur length.
      const motionUVX = (smoothDx / SAMPLE_W) * strengthRef.current;
      const motionUVY = (smoothDy / SAMPLE_H) * strengthRef.current;
      const magnitudeUV = Math.hypot(motionUVX, motionUVY);

      // Adaptive sample count — more samples for bigger blurs (avoids
      // banding) and fewer for tiny ones (saves fragment work). Scale
      // by the UV magnitude relative to the 8% clamp.
      const samplesRange = SAMPLES_MAX - SAMPLES_MIN;
      const adaptive = SAMPLES_MIN + Math.ceil(
        Math.min(1, magnitudeUV / 0.08) * samplesRange,
      );
      const sampleCount = Math.max(SAMPLES_MIN, Math.min(SAMPLES_MAX, adaptive));

      // === GPU render ===
      const {
        gl, program, buffer,
        uMotion, uMagnitude, uFrame, uPrevFrame,
        uMaskLow, uMaskHigh, uHudMask, uHudPreset, uAspect, uSamples,
        aPos,
      } = setup;
      // isContextLost is the canonical guard — onContextLost may not have
      // fired yet on the frame where the context was actually lost.
      if (gl.isContextLost()) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);

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
        // Continue with the existing texture contents. drawArrays still
        // runs below so the canvas displays a stable frame instead of
        // collapsing to black.
      }
      gl.uniform1i(uFrame, 0);

      // Bind the previous frame (from the last tick) into TEXTURE1 so the
      // shader can compute a per-pixel diff and keep static UI sharp. On
      // the very first frame there's no prev yet — fall back to TEXTURE0,
      // which makes the diff zero everywhere → no blur applied (sharp).
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, prevTextureHasData ? prevTexture : curTexture);
      gl.uniform1i(uPrevFrame, 1);

      gl.uniform2f(uMotion, motionUVX, motionUVY);
      gl.uniform1f(uMagnitude, magnitudeUV);
      // Diff thresholds in 0..1 luma space. Anything below MASK_LOW reads
      // as static and stays sharp; above MASK_HIGH gets the full blur.
      // 0.04 / 0.12 keeps UI (≤ a few %) sharp while modest gameplay
      // contrast changes hit the blur path.
      gl.uniform1f(uMaskLow, 0.04);
      gl.uniform1f(uMaskHigh, 0.12);
      gl.uniform1f(uHudMask, hudMaskRef.current);
      gl.uniform1i(uHudPreset, HUD_PRESET_INDEX[hudPresetRef.current]);
      const fallbackAspect = canvas.width / Math.max(1, canvas.height);
      gl.uniform1f(uAspect, aspectRef.current ?? fallbackAspect);
      gl.uniform1i(uSamples, sampleCount);

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveActive, videoRef]);

  if (!effectiveActive) return null;
  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      aria-hidden="true"
    />
  );
}

export function destroySetup(setup: GlSetup): void {
  const { gl, program, buffer, curTexture, prevTexture } = setup;
  // No early-return on isContextLost. WebGL deleteXxx calls become no-ops
  // when the context is lost (per spec), but skipping them entirely is
  // worse: some drivers (Firefox with lose-context-on-tab-switch) keep
  // GPU-side resources alive until the JS handles are GC'd, which can
  // outlive the next page navigation. Always call delete so the driver
  // gets the explicit cue regardless of context state.
  gl.deleteProgram(program);
  gl.deleteBuffer(buffer);
  gl.deleteTexture(curTexture);
  gl.deleteTexture(prevTexture);
}
