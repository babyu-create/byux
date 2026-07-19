// Customisable keyboard shortcuts. Bindings are persisted to localStorage so
// users can rebind keys to fit their workflow.

export type ActionId =
  | 'playback.toggle'
  | 'clip.split'
  | 'clip.delete'
  | 'zoom.in'
  | 'zoom.out'
  | 'marker.add'
  | 'marker.deleteNear'
  | 'marker.prev'
  | 'marker.next'
  | 'range.in'
  | 'range.out'
  | 'range.clearIn'
  | 'range.deleteNear'
  | 'range.extract'
  | 'frame.prev'
  | 'frame.next'
  | 'jump.back'
  | 'jump.forward';

export interface ActionDef {
  id: ActionId;
  group: string;
  label: string;
  defaultKey: string;
}

export const ACTIONS: ActionDef[] = [
  // Playback
  { id: 'playback.toggle', group: '再生', label: '再生 / 一時停止', defaultKey: 'space' },
  { id: 'frame.prev', group: '再生', label: '1フレーム戻る', defaultKey: 'arrowleft' },
  { id: 'frame.next', group: '再生', label: '1フレーム進む', defaultKey: 'arrowright' },
  { id: 'jump.back', group: '再生', label: '5秒戻る', defaultKey: 'shift+arrowleft' },
  { id: 'jump.forward', group: '再生', label: '5秒進む', defaultKey: 'shift+arrowright' },
  // Clip editing
  { id: 'clip.split', group: 'クリップ', label: '選択クリップを分割', defaultKey: 'j' },
  { id: 'clip.delete', group: 'クリップ', label: '選択クリップを削除', defaultKey: 'delete' },
  { id: 'zoom.in', group: 'クリップ', label: 'ズームイン', defaultKey: '=' },
  { id: 'zoom.out', group: 'クリップ', label: 'ズームアウト', defaultKey: '-' },
  // Kill markers — default bound to W (rests under the FPS left hand on WASD).
  { id: 'marker.add', group: 'キルマーカー', label: '現在位置にマーカー追加', defaultKey: 'w' },
  { id: 'marker.deleteNear', group: 'キルマーカー', label: '近傍のマーカー削除', defaultKey: 'shift+w' },
  { id: 'marker.prev', group: 'キルマーカー', label: '前のマーカーへジャンプ', defaultKey: '[' },
  { id: 'marker.next', group: 'キルマーカー', label: '次のマーカーへジャンプ', defaultKey: ']' },
  // A/D range cuts — IN on A, OUT on D (FPS strafe keys; were I/O).
  { id: 'range.in', group: 'A/Dレンジ', label: '開始マーク (IN)', defaultKey: 'a' },
  { id: 'range.out', group: 'A/Dレンジ', label: '終了マーク (OUT)', defaultKey: 'd' },
  { id: 'range.clearIn', group: 'A/Dレンジ', label: '開始マーククリア', defaultKey: 'shift+a' },
  { id: 'range.deleteNear', group: 'A/Dレンジ', label: '近傍のレンジ削除', defaultKey: 'shift+d' },
  { id: 'range.extract', group: 'A/Dレンジ', label: '即カット', defaultKey: 'x' },
];

export const DEFAULT_BINDINGS: Record<ActionId, string> = ACTIONS.reduce(
  (acc, a) => {
    acc[a.id] = a.defaultKey;
    return acc;
  },
  {} as Record<ActionId, string>,
);

/** App-level commands that are intentionally not rebindable. */
export const RESERVED_BINDINGS: Readonly<Record<string, string>> = {
  'ctrl+s': 'プロジェクト保存',
  'meta+s': 'プロジェクト保存',
  'ctrl+shift+s': '別名で保存',
  'meta+shift+s': '別名で保存',
  'ctrl+z': '元に戻す',
  'meta+z': '元に戻す',
  'ctrl+y': 'やり直す',
  'ctrl+shift+z': 'やり直す',
  'meta+shift+z': 'やり直す',
};

const STORAGE_KEY = 'fce.pref.keybindings.v1';

let cache: Record<ActionId, string> | null = null;
const subscribers = new Set<() => void>();

function loadFromStorage(): Record<ActionId, string> {
  if (typeof window === 'undefined') return { ...DEFAULT_BINDINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const parsed = JSON.parse(raw) as Record<string, string>;
    const merged: Record<ActionId, string> = { ...DEFAULT_BINDINGS };
    for (const a of ACTIONS) {
      if (typeof parsed[a.id] === 'string') {
        merged[a.id] = parsed[a.id];
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

export function getBindings(): Record<ActionId, string> {
  if (!cache) cache = loadFromStorage();
  return cache;
}

export function getBinding(id: ActionId): string {
  return getBindings()[id];
}

export function setBinding(id: ActionId, key: string): void {
  cache = { ...getBindings(), [id]: key };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  }
  subscribers.forEach((cb) => cb());
}

export function resetBindings(): void {
  cache = { ...DEFAULT_BINDINGS };
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  subscribers.forEach((cb) => cb());
}

export function subscribeBindings(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Convert a KeyboardEvent into the canonical key string (e.g. "shift+k"). */
export function eventToKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push(e.metaKey && !e.ctrlKey ? 'meta' : 'ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  // Use e.key for letters (so "j" not "KeyJ"), lowercased.
  const k = e.key.toLowerCase();
  // Normalize spaces and special keys
  const map: Record<string, string> = {
    ' ': 'space',
    spacebar: 'space',
  };
  parts.push(map[k] ?? k);
  return parts.join('+');
}

/** Pretty-print a canonical key string for UI display ("shift+k" → "Shift + K"). */
export function formatKey(key: string): string {
  return key
    .split('+')
    .map((p) => {
      const lower = p.toLowerCase();
      if (lower === 'space') return 'Space';
      if (lower === 'arrowleft') return '←';
      if (lower === 'arrowright') return '→';
      if (lower === 'arrowup') return '↑';
      if (lower === 'arrowdown') return '↓';
      if (lower === 'delete') return 'Delete';
      if (lower === 'backspace') return 'Backspace';
      if (lower === 'enter') return 'Enter';
      if (lower === 'escape') return 'Esc';
      if (lower === 'shift') return 'Shift';
      if (lower === 'ctrl') return 'Ctrl';
      if (lower === 'meta') return 'Cmd';
      if (lower === 'alt') return 'Alt';
      if (lower.length === 1) return p.toUpperCase();
      return p[0].toUpperCase() + p.slice(1);
    })
    .join(' + ');
}

/** Returns the matching action id for a keyboard event, or null. */
export function matchAction(e: KeyboardEvent): ActionId | null {
  const key = eventToKey(e);
  const bindings = getBindings();
  for (const a of ACTIONS) {
    if (bindings[a.id] === key) return a.id;
  }
  return null;
}
