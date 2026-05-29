// Theme management: light / dark / gaming, with per-color customization
// for the gaming theme. Persists to localStorage and applies via CSS custom
// properties on the document element.

export type ThemeId = 'light' | 'dark' | 'gaming';

export interface GamingColors {
  accent: string;
  clipVideo: string;
  clipOverlay: string;
  clipAudio: string;
  playhead: string;
  bgApp: string;
}

export interface GamingPreset {
  id: string;
  label: string;
  colors: GamingColors;
}

export const GAMING_PRESETS: GamingPreset[] = [
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    colors: {
      accent: '#ff2bd6',
      clipVideo: '#00f0ff',
      clipOverlay: '#ffe600',
      clipAudio: '#00ff88',
      playhead: '#ff2bd6',
      bgApp: '#0a0014',
    },
  },
  {
    id: 'valorant',
    label: 'Valorant',
    colors: {
      accent: '#ff4655',
      clipVideo: '#0f1923',
      clipOverlay: '#ece8e1',
      clipAudio: '#bd3944',
      playhead: '#ff4655',
      bgApp: '#0f1923',
    },
  },
  {
    id: 'tactical',
    label: 'Tactical',
    colors: {
      accent: '#39ff14',
      clipVideo: '#00ff88',
      clipOverlay: '#ffff00',
      clipAudio: '#00ffff',
      playhead: '#39ff14',
      bgApp: '#0a0f0a',
    },
  },
  {
    id: 'aurora',
    label: 'Aurora',
    colors: {
      accent: '#a855f7',
      clipVideo: '#3b82f6',
      clipOverlay: '#ec4899',
      clipAudio: '#10b981',
      playhead: '#f59e0b',
      bgApp: '#0d0b1f',
    },
  },
];

export const DEFAULT_GAMING_COLORS: GamingColors = GAMING_PRESETS[0].colors;

const THEME_KEY = 'fce.pref.theme';
const COLORS_KEY = 'fce.pref.gamingColors';
const RGB_CYCLE_KEY = 'fce.pref.rgbCycle';

function isThemeId(v: string | null): v is ThemeId {
  return v === 'light' || v === 'dark' || v === 'gaming';
}

export function loadTheme(): ThemeId {
  if (typeof window === 'undefined') return 'light';
  const raw = window.localStorage.getItem(THEME_KEY);
  return isThemeId(raw) ? raw : 'light';
}

export function saveTheme(theme: ThemeId): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(THEME_KEY, theme);
}

export function loadGamingColors(): GamingColors {
  if (typeof window === 'undefined') return DEFAULT_GAMING_COLORS;
  const raw = window.localStorage.getItem(COLORS_KEY);
  if (!raw) return DEFAULT_GAMING_COLORS;
  try {
    const parsed = JSON.parse(raw) as Partial<GamingColors>;
    return { ...DEFAULT_GAMING_COLORS, ...parsed };
  } catch {
    return DEFAULT_GAMING_COLORS;
  }
}

export function saveGamingColors(colors: GamingColors): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(COLORS_KEY, JSON.stringify(colors));
}

export type RgbCycleSpeed = 'off' | 'slow' | 'normal' | 'fast';

const RGB_CYCLE_SPEEDS: RgbCycleSpeed[] = ['off', 'slow', 'normal', 'fast'];

function isCycleSpeed(v: string | null): v is RgbCycleSpeed {
  return v !== null && (RGB_CYCLE_SPEEDS as string[]).includes(v);
}

export function loadRgbCycle(): RgbCycleSpeed {
  if (typeof window === 'undefined') return 'off';
  const raw = window.localStorage.getItem(RGB_CYCLE_KEY);
  return isCycleSpeed(raw) ? raw : 'off';
}

export function saveRgbCycle(speed: RgbCycleSpeed): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(RGB_CYCLE_KEY, speed);
}

export interface RgbCycleTargets {
  /** アクセント / プレイヘッド / ビート線 */
  accent: boolean;
  /** クリップ3色（映像 / オーバーレイ / 音声） */
  clip: boolean;
  /** 背景・パネル・トラック・タイムライン */
  bg: boolean;
  /** ボーダー（区切り線） */
  border: boolean;
  /** グロー（フォーカスハロー） */
  glow: boolean;
}

export const DEFAULT_RGB_TARGETS: RgbCycleTargets = {
  accent: true,
  clip: true,
  bg: true,
  border: true,
  glow: true,
};

const RGB_TARGETS_KEY = 'fce.pref.rgbTargets';

export function loadRgbTargets(): RgbCycleTargets {
  if (typeof window === 'undefined') return DEFAULT_RGB_TARGETS;
  const raw = window.localStorage.getItem(RGB_TARGETS_KEY);
  if (!raw) return DEFAULT_RGB_TARGETS;
  try {
    const parsed = JSON.parse(raw) as Partial<RgbCycleTargets>;
    return { ...DEFAULT_RGB_TARGETS, ...parsed };
  } catch {
    return DEFAULT_RGB_TARGETS;
  }
}

export function saveRgbTargets(targets: RgbCycleTargets): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(RGB_TARGETS_KEY, JSON.stringify(targets));
}

function hexToRgbTuple(hex: string): [number, number, number] | null {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function softAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgbTuple(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/**
 * Apply theme to the document root. For 'gaming', the supplied colors
 * (or stored colors when omitted) override the gaming defaults. The
 * data-rgb-cycle attribute drives a CSS keyframe animation; the
 * data-rgb-{accent,clip,bg,border,glow} attributes scope WHICH variables
 * the keyframe owns, so the user can hue-cycle just borders, just bg, etc.
 */
export function applyTheme(
  theme: ThemeId,
  colors?: GamingColors,
  rgbCycle?: RgbCycleSpeed,
  rgbTargets?: RgbCycleTargets,
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);

  const cycle = rgbCycle ?? loadRgbCycle();
  const targets = rgbTargets ?? loadRgbTargets();
  const cycling = theme === 'gaming' && cycle !== 'off';

  if (cycling) {
    root.setAttribute('data-rgb-cycle', cycle);
  } else {
    root.removeAttribute('data-rgb-cycle');
  }

  // Toggle the per-target attributes that scope the keyframe rules.
  const targetAttrs: ReadonlyArray<readonly [string, boolean]> = [
    ['data-rgb-accent', targets.accent],
    ['data-rgb-clip', targets.clip],
    ['data-rgb-bg', targets.bg],
    ['data-rgb-border', targets.border],
    ['data-rgb-glow', targets.glow],
  ];
  for (const [attr, on] of targetAttrs) {
    if (cycling && on) root.setAttribute(attr, '');
    else root.removeAttribute(attr);
  }

  const groupProps: Record<keyof RgbCycleTargets, readonly string[]> = {
    accent: ['--accent', '--accent-hover', '--accent-soft', '--playhead', '--beat-line'],
    clip: [
      '--clip-video',
      '--clip-video-bg',
      '--clip-overlay',
      '--clip-overlay-bg',
      '--clip-audio',
      '--clip-audio-bg',
    ],
    bg: [
      '--bg-app',
      '--bg-panel',
      '--bg-panel-2',
      '--bg-timeline',
      '--bg-track',
      '--bg-track-alt',
      '--bg-elevated',
    ],
    border: ['--border', '--border-soft', '--border-strong'],
    glow: ['--glow'],
  };

  if (theme !== 'gaming') {
    // Switched away from gaming — clear every inline value we may have set.
    for (const props of Object.values(groupProps)) {
      props.forEach((p) => root.style.removeProperty(p));
    }
    return;
  }

  const c = colors ?? loadGamingColors();
  const clear = (props: readonly string[]) => props.forEach((p) => root.style.removeProperty(p));

  // accent group — keyframe owns it when cycling AND target.accent is on.
  if (cycling && targets.accent) {
    clear(groupProps.accent);
  } else {
    root.style.setProperty('--accent', c.accent);
    root.style.setProperty('--accent-hover', c.accent);
    root.style.setProperty('--accent-soft', softAlpha(c.accent, 0.18));
    root.style.setProperty('--playhead', c.playhead);
    root.style.setProperty('--beat-line', softAlpha(c.accent, 0.45));
  }

  // clip group
  if (cycling && targets.clip) {
    clear(groupProps.clip);
  } else {
    root.style.setProperty('--clip-video', c.clipVideo);
    root.style.setProperty('--clip-video-bg', softAlpha(c.clipVideo, 0.22));
    root.style.setProperty('--clip-overlay', c.clipOverlay);
    root.style.setProperty('--clip-overlay-bg', softAlpha(c.clipOverlay, 0.22));
    root.style.setProperty('--clip-audio', c.clipAudio);
    root.style.setProperty('--clip-audio-bg', softAlpha(c.clipAudio, 0.22));
  }

  // bg group — only --bg-app is user-customizable; other surfaces fall back
  // to the :root[data-theme=gaming] defaults when not cycled.
  if (cycling && targets.bg) {
    clear(groupProps.bg);
  } else {
    root.style.setProperty('--bg-app', c.bgApp);
    clear(['--bg-panel', '--bg-panel-2', '--bg-timeline', '--bg-track', '--bg-track-alt', '--bg-elevated']);
  }

  // border / glow — no custom user color; always clear inline so either the
  // keyframe (when targeted) or the :root[data-theme=gaming] defaults apply.
  clear(groupProps.border);
  clear(groupProps.glow);
}
