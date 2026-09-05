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
