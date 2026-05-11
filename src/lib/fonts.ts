// Curated font catalog for text overlays.
// All fonts are loaded from Google Fonts in index.html.
// `stack` is the full CSS font-family fallback chain used when rendering.

export type FontCategory = 'jp' | 'serif' | 'sans' | 'mono' | 'gaming';

export interface FontDefinition {
  /** Stable identifier (matches the primary family name). */
  id: string;
  /** Display name shown in the picker. */
  label: string;
  /** Sample text rendered in the option (defaults to the label). */
  sample?: string;
  category: FontCategory;
  /** Full CSS font-family stack, including fallbacks. */
  stack: string;
}

const JP_FALLBACK = `'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic UI', sans-serif`;
const EN_FALLBACK = `Inter, -apple-system, BlinkMacSystemFont, sans-serif`;

export const FONT_LIBRARY: FontDefinition[] = [
  // Japanese
  { id: 'Noto Sans JP', label: 'Noto Sans JP', category: 'jp', stack: `'Noto Sans JP', ${JP_FALLBACK}`, sample: '日本語テキスト Aa 123' },
  { id: 'M PLUS 1', label: 'M PLUS 1', category: 'jp', stack: `'M PLUS 1', ${JP_FALLBACK}`, sample: '日本語テキスト Aa 123' },
  { id: 'Zen Kaku Gothic New', label: 'Zen Kaku Gothic', category: 'jp', stack: `'Zen Kaku Gothic New', ${JP_FALLBACK}`, sample: '日本語テキスト Aa 123' },
  { id: 'Reggae One', label: 'Reggae One', category: 'jp', stack: `'Reggae One', ${JP_FALLBACK}`, sample: '日本語 Reggae 123' },
  { id: 'RocknRoll One', label: 'RocknRoll One', category: 'jp', stack: `'RocknRoll One', ${JP_FALLBACK}`, sample: '日本語 RocknRoll' },
  { id: 'Yusei Magic', label: 'Yusei Magic', category: 'jp', stack: `'Yusei Magic', ${JP_FALLBACK}`, sample: '日本語 ゆせい Magic' },
  { id: 'Dela Gothic One', label: 'Dela Gothic One', category: 'jp', stack: `'Dela Gothic One', ${JP_FALLBACK}`, sample: '日本語 デラゴシック' },
  { id: 'Stick', label: 'Stick', category: 'jp', stack: `Stick, ${JP_FALLBACK}`, sample: '日本語 Stick 123' },

  // English Serif / Display
  { id: 'Playfair Display', label: 'Playfair Display', category: 'serif', stack: `'Playfair Display', Georgia, serif`, sample: 'Aa Bb 123 Playfair' },
  { id: 'Cormorant Garamond', label: 'Cormorant Garamond', category: 'serif', stack: `'Cormorant Garamond', Georgia, serif`, sample: 'Aa Bb 123 Cormorant' },
  { id: 'Bebas Neue', label: 'Bebas Neue', category: 'serif', stack: `'Bebas Neue', Impact, sans-serif`, sample: 'AA BB 123 BEBAS' },
  { id: 'Anton', label: 'Anton', category: 'serif', stack: `Anton, Impact, sans-serif`, sample: 'AA BB 123 ANTON' },
  { id: 'Russo One', label: 'Russo One', category: 'serif', stack: `'Russo One', Impact, sans-serif`, sample: 'AA BB 123 RUSSO' },

  // English Sans-serif
  { id: 'Inter', label: 'Inter', category: 'sans', stack: `Inter, ${EN_FALLBACK}`, sample: 'Aa Bb 123 Inter' },
  { id: 'Montserrat', label: 'Montserrat', category: 'sans', stack: `Montserrat, ${EN_FALLBACK}`, sample: 'Aa Bb 123 Montserrat' },
  { id: 'Oswald', label: 'Oswald', category: 'sans', stack: `Oswald, ${EN_FALLBACK}`, sample: 'AA BB 123 OSWALD' },
  { id: 'Archivo Black', label: 'Archivo Black', category: 'sans', stack: `'Archivo Black', ${EN_FALLBACK}`, sample: 'Aa Bb 123 Archivo' },
  { id: 'Audiowide', label: 'Audiowide', category: 'sans', stack: `Audiowide, ${EN_FALLBACK}`, sample: 'Aa Bb 123 Audiowide' },

  // Monospace
  { id: 'JetBrains Mono', label: 'JetBrains Mono', category: 'mono', stack: `'JetBrains Mono', ui-monospace, monospace`, sample: 'Aa Bb 123 JetBrains' },
  { id: 'Space Mono', label: 'Space Mono', category: 'mono', stack: `'Space Mono', ui-monospace, monospace`, sample: 'Aa Bb 123 Space' },

  // Gaming / Decorative
  { id: 'Press Start 2P', label: 'Press Start 2P', category: 'gaming', stack: `'Press Start 2P', ui-monospace, monospace`, sample: 'AA 123 PRESS' },
  { id: 'VT323', label: 'VT323', category: 'gaming', stack: `VT323, ui-monospace, monospace`, sample: 'Aa Bb 123 VT323 Terminal' },
  { id: 'Bungee', label: 'Bungee', category: 'gaming', stack: `Bungee, Impact, sans-serif`, sample: 'AA 123 BUNGEE' },
  { id: 'Shrikhand', label: 'Shrikhand', category: 'gaming', stack: `Shrikhand, Impact, sans-serif`, sample: 'Aa Bb 123 Shrikhand' },
  { id: 'Faster One', label: 'Faster One', category: 'gaming', stack: `'Faster One', Impact, sans-serif`, sample: 'AA 123 FASTER' },
  { id: 'Major Mono Display', label: 'Major Mono Display', category: 'gaming', stack: `'Major Mono Display', ui-monospace, monospace`, sample: 'aa bb 123 major' },
];

export const DEFAULT_FONT_ID = 'Inter';

const FONT_BY_ID = new Map(FONT_LIBRARY.map((f) => [f.id, f]));

export function getFontStack(id: string | undefined): string {
  if (!id) {
    return FONT_BY_ID.get(DEFAULT_FONT_ID)!.stack;
  }
  return FONT_BY_ID.get(id)?.stack ?? id;
}

export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  jp: '日本語',
  serif: '英文 セリフ / Display',
  sans: '英文 サンセリフ',
  mono: 'モノスペース',
  gaming: 'ゲーミング / 装飾',
};

/** Fonts grouped by category for `<optgroup>` rendering. */
export function getFontGroups(): { category: FontCategory; label: string; fonts: FontDefinition[] }[] {
  const order: FontCategory[] = ['jp', 'serif', 'sans', 'mono', 'gaming'];
  return order.map((category) => ({
    category,
    label: FONT_CATEGORY_LABELS[category],
    fonts: FONT_LIBRARY.filter((f) => f.category === category),
  }));
}
