// Layout sizing state for the resizable panels. Persisted to localStorage
// so the user's chosen widths/heights survive reloads. All values are in
// CSS pixels.

export interface LayoutSizes {
  /** Width of the left panel (Media Library) in px. */
  leftWidth: number;
  /** Width of the right panel (Properties + Waveform) in px. */
  rightWidth: number;
  /** Height of the bottom Timeline strip in px. */
  timelineHeight: number;
  /** Height of the Properties section inside the right panel in px. */
  propertiesHeight: number;
}

export const DEFAULT_LAYOUT: LayoutSizes = {
  leftWidth: 280,
  rightWidth: 280,
  // Tuned so the center preview panel is exactly 16:9 at the default window
  // size (1600x1000) — a 16:9 project then fills the frame edge-to-edge with
  // no letterbox gap, instead of leaving a visible strip top/bottom.
  timelineHeight: 338,
  propertiesHeight: 420,
};

export const LAYOUT_BOUNDS = {
  leftWidth: { min: 180, max: 520 },
  rightWidth: { min: 200, max: 560 },
  timelineHeight: { min: 160, max: 600 },
  propertiesHeight: { min: 160, max: 9999 },
} as const;

/** Increment when the layout schema changes in a breaking way. Stored data
 *  without this version (or with a lower version) is discarded gracefully. */
export const LAYOUT_VERSION = 1;

const LAYOUT_KEY = 'fce.pref.layout';

export function clampSize<K extends keyof LayoutSizes>(key: K, value: number): number {
  const { min, max } = LAYOUT_BOUNDS[key];
  return Math.max(min, Math.min(max, value));
}

/** Return `n` if it is a finite, non-negative number, otherwise `fallback`. */
function safeSize(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadLayout(): LayoutSizes {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  const raw = window.localStorage.getItem(LAYOUT_KEY);
  if (!raw) return DEFAULT_LAYOUT;
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutSizes> & { _v?: number };
    // Discard data from a future (incompatible) schema version.
    if (parsed._v !== undefined && parsed._v > LAYOUT_VERSION) return DEFAULT_LAYOUT;
    // Sanitize each field: reject NaN, Infinity, and negative values.
    const merged: LayoutSizes = {
      leftWidth: safeSize(parsed.leftWidth, DEFAULT_LAYOUT.leftWidth),
      rightWidth: safeSize(parsed.rightWidth, DEFAULT_LAYOUT.rightWidth),
      timelineHeight: safeSize(parsed.timelineHeight, DEFAULT_LAYOUT.timelineHeight),
      propertiesHeight: safeSize(parsed.propertiesHeight, DEFAULT_LAYOUT.propertiesHeight),
    };
    // Re-clamp in case bounds tightened across versions.
    (Object.keys(LAYOUT_BOUNDS) as (keyof LayoutSizes)[]).forEach((k) => {
      merged[k] = clampSize(k, merged[k]);
    });
    return merged;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(sizes: LayoutSizes): void {
  if (typeof window === 'undefined') return;
  // Persist with the version stamp so future schema migrations can detect
  // and discard incompatible payloads. Without `_v` here, loadLayout's
  // version guard would silently fall through for old payloads.
  window.localStorage.setItem(
    LAYOUT_KEY,
    JSON.stringify({ _v: LAYOUT_VERSION, ...sizes }),
  );
}
