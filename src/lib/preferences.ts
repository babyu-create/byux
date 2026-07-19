// Lightweight typed wrapper around localStorage for boolean/number prefs.

const PREFIX = 'fce.pref.';

function key(name: string): string {
  return `${PREFIX}${name}`;
}

export function getBoolPref(name: string, fallback = false): boolean {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key(name));
  if (raw === null) return fallback;
  return raw === 'true';
}

export function setBoolPref(name: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key(name), value ? 'true' : 'false');
}

export const PREF_SKIP_AUTO_CLIP_CONFIRM = 'skipAutoClipConfirm';

// Collapsible property-section open/closed state is persisted per section id
// under a shared namespace so that the user's progressive-disclosure choices
// survive reloads and clip re-selection.
export function getSectionOpenPref(id: string, fallback: boolean): boolean {
  return getBoolPref(`section.${id}`, fallback);
}

export function setSectionOpenPref(id: string, open: boolean): void {
  setBoolPref(`section.${id}`, open);
}
