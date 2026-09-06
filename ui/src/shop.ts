// The cosmetics shop (issue #229, decision 0038): trophies buy looks that
// change how the board is drawn and never what a face means.
//
// This is the one place prices live. The record (profile.ts) only knows what
// is *owned*; the spendable balance is `trophies − Σ price(owned)`, computed
// here, never stored — so the record's never-regress merge (sync.ts) cannot
// undo a purchase or refund one, and two devices buying different items
// offline reconcile to the exact sum. The consequence is that a price is part
// of an item's identity: re-pricing an item re-prices every past purchase, so
// a new price is a new id.
//
// Prices are the issue's proposed numbers until the PM sets final ones.

import { DEFAULT_GLYPH_SET } from './profile.js';
import type { LookKind, PlayerRecord, RecordStore } from './profile.js';
import { BACKS, FELTS } from './depth.js';
import { FRAMES } from './frames.js';

export interface ShopItem {
  readonly id: string;
  /** Which look this item is a choice for. */
  readonly kind: LookKind;
  readonly label: string;
  readonly description: string;
  readonly price: number;
}

/** Everything for sale, in shop order. */
export const SHOP_ITEMS: readonly ShopItem[] = [
  {
    id: 'glyphs-calligraphy',
    kind: 'glyphs',
    label: 'Calligraphy',
    description: 'Brush-drawn faces with a dry-brush edge. Same grids, same inks.',
    price: 25,
  },
  {
    id: 'glyphs-fantasy',
    kind: 'glyphs',
    label: 'Fantasy',
    description: 'Carved-jade emblems: gem pips, staves and storybook dragons.',
    price: 60,
  },
  // Board felts (slice 2, decision 0039): the table under the tiles, nothing
  // else. Colours live with the palette in depth.ts (FELTS); the shop only
  // prices them.
  {
    id: 'felt-forest',
    kind: 'felt',
    label: FELTS['felt-forest']!.label,
    description: 'Deep evergreen, darker than the lantern green.',
    price: 10,
  },
  {
    id: 'felt-ink',
    kind: 'felt',
    label: FELTS['felt-ink']!.label,
    description: 'Near-black, so the tiles carry all the colour.',
    price: 10,
  },
  {
    id: 'felt-teal',
    kind: 'felt',
    label: FELTS['felt-teal']!.label,
    description: 'Dark sea teal.',
    price: 25,
  },
  {
    id: 'felt-slate',
    kind: 'felt',
    label: FELTS['felt-slate']!.label,
    description: 'Cool blue-grey slate.',
    price: 25,
  },
  {
    id: 'felt-walnut',
    kind: 'felt',
    label: FELTS['felt-walnut']!.label,
    description: 'Warm dark walnut, like a wooden table.',
    price: 60,
  },
  // Tile backs (slice 2, decision 0040): the face-down back as one bitmap.
  // Colours live with the palette in depth.ts (BACKS); art under data/backs/.
  {
    id: 'back-night-sky',
    kind: 'back',
    label: BACKS['back-night-sky']!.label,
    description: 'Gold stars and a crescent moon on midnight blue.',
    price: 10,
  },
  {
    id: 'back-blue-wave',
    kind: 'back',
    label: BACKS['back-blue-wave']!.label,
    description: 'Overlapping seigaiha waves in sea green.',
    price: 10,
  },
  {
    id: 'back-bamboo-grove',
    kind: 'back',
    label: BACKS['back-bamboo-grove']!.label,
    description: 'Three bamboo stalks on the lantern green.',
    price: 25,
  },
  {
    id: 'back-cloud-scroll',
    kind: 'back',
    label: BACKS['back-cloud-scroll']!.label,
    description: 'Auspicious cloud scrolls in silver on charcoal.',
    price: 25,
  },
  {
    id: 'back-lacquer-lantern',
    kind: 'back',
    label: BACKS['back-lacquer-lantern']!.label,
    description: 'One paper lantern on red lacquer.',
    price: 25,
  },
  {
    id: 'back-plum-branch',
    kind: 'back',
    label: BACKS['back-plum-branch']!.label,
    description: 'A blossoming plum branch on deep plum.',
    price: 60,
  },
  {
    id: 'back-koi',
    kind: 'back',
    label: BACKS['back-koi']!.label,
    description: 'A koi curling through ripples on deep water.',
    price: 60,
  },
  // Avatar frames (slice 3, decision 0041): a ring around the avatar on the
  // profile row and the leaderboard. Art under data/frames/ (frames.ts).
  {
    id: 'frame-gold-ring',
    kind: 'frame',
    label: FRAMES['frame-gold-ring']!.label,
    description: 'A solid gold ring.',
    price: 10,
  },
  {
    id: 'frame-jade-square',
    kind: 'frame',
    label: FRAMES['frame-jade-square']!.label,
    description: 'A rounded jade square.',
    price: 10,
  },
  {
    id: 'frame-vermilion-double',
    kind: 'frame',
    label: FRAMES['frame-vermilion-double']!.label,
    description: 'Two thin vermilion rings.',
    price: 25,
  },
  {
    id: 'frame-wave',
    kind: 'frame',
    label: FRAMES['frame-wave']!.label,
    description: 'A deep-sea ring with a scalloped wave edge.',
    price: 25,
  },
  {
    id: 'frame-lantern',
    kind: 'frame',
    label: FRAMES['frame-lantern']!.label,
    description: 'A lacquer ring with a paper lantern hung from the top.',
    price: 25,
  },
  {
    id: 'frame-plum',
    kind: 'frame',
    label: FRAMES['frame-plum']!.label,
    description: 'A plum ring with four blossoms at the compass points.',
    price: 60,
  },
  {
    id: 'frame-dragon',
    kind: 'frame',
    label: FRAMES['frame-dragon']!.label,
    description: 'A slate ring with a silver dragon along the top.',
    price: 60,
  },
];

/** A glyph set the renderer can show: the free drawn default, or a bought set
 *  of whole-face bitmaps under `data/glyphs/<dir>/<face>.png`. */
export interface GlyphSet {
  readonly id: string;
  readonly label: string;
  /** Directory under `glyphs/` in the static assets, or null for the drawn
   *  default, which loads nothing. */
  readonly dir: string | null;
}

export const GLYPH_SETS: Readonly<Record<string, GlyphSet>> = {
  [DEFAULT_GLYPH_SET]: { id: DEFAULT_GLYPH_SET, label: 'Lantern', dir: null },
  'glyphs-calligraphy': { id: 'glyphs-calligraphy', label: 'Calligraphy', dir: 'calligraphy' },
  'glyphs-fantasy': { id: 'glyphs-fantasy', label: 'Fantasy', dir: 'fantasy' },
};

/** The set a record's `looks.glyphs` names — Lantern for an id this build does
 *  not ship (a newer build's pick, kept opaquely, has nothing to draw here). */
export function glyphSetFor(id: string): GlyphSet {
  return GLYPH_SETS[id] ?? GLYPH_SETS[DEFAULT_GLYPH_SET]!;
}

/** What an item costs here; 0 for an id this build does not sell. */
export function itemPrice(id: string): number {
  return SHOP_ITEMS.find((item) => item.id === id)?.price ?? 0;
}

/** Trophies left to spend: earned less the price of everything owned, floored
 *  at 0 so a re-priced record never reads as a debt. */
export function trophyBalance(record: PlayerRecord): number {
  const spent = record.owned.reduce((sum, id) => sum + itemPrice(id), 0);
  return Math.max(0, record.trophies - spent);
}

export type Affordability =
  | { readonly state: 'owned' }
  | { readonly state: 'affordable' }
  | { readonly state: 'locked'; readonly short: number };

/** Where an item stands for this record: owned, buyable now, or locked with
 *  the shortfall the shop shows next to the price. */
export function affordability(record: PlayerRecord, id: string): Affordability {
  if (record.owned.includes(id)) return { state: 'owned' };
  const short = itemPrice(id) - trophyBalance(record);
  return short > 0 ? { state: 'locked', short } : { state: 'affordable' };
}

/** Buy `id`: the one path from trophies to an owned item. False, and nothing
 *  changed, unless the item is for sale, not yet owned and affordable. Buying
 *  does not choose the look — that is the player's next, separate tap. */
export function purchase(record: RecordStore, id: string): boolean {
  if (!SHOP_ITEMS.some((item) => item.id === id)) return false;
  if (affordability(record.value, id).state !== 'affordable') return false;
  return record.acquire(id);
}
