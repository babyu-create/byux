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
 * (or stored colors when omitted) override the gaming defaults.
 */
export function applyTheme(theme: ThemeId, colors?: GamingColors): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);

  if (theme !== 'gaming') {
    // Clear any inline overrides set by a previous gaming theme.
    const props = [
      '--accent',
      '--accent-hover',
      '--accent-soft',
      '--clip-video',
      '--clip-video-bg',
      '--clip-overlay',
      '--clip-overlay-bg',
      '--clip-audio',
      '--clip-audio-bg',
      '--playhead',
      '--bg-app',
      '--beat-line',
    ];
    props.forEach((p) => root.style.removeProperty(p));
    return;
  }

  const c = colors ?? loadGamingColors();
  root.style.setProperty('--accent', c.accent);
  root.style.setProperty('--accent-hover', c.accent);
  root.style.setProperty('--accent-soft', softAlpha(c.accent, 0.18));
  root.style.setProperty('--clip-video', c.clipVideo);
  root.style.setProperty('--clip-video-bg', softAlpha(c.clipVideo, 0.22));
  root.style.setProperty('--clip-overlay', c.clipOverlay);
  root.style.setProperty('--clip-overlay-bg', softAlpha(c.clipOverlay, 0.22));
  root.style.setProperty('--clip-audio', c.clipAudio);
  root.style.setProperty('--clip-audio-bg', softAlpha(c.clipAudio, 0.22));
  root.style.setProperty('--playhead', c.playhead);
  root.style.setProperty('--bg-app', c.bgApp);
  root.style.setProperty('--beat-line', softAlpha(c.accent, 0.45));
}
