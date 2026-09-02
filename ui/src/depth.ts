// Tile depth rendering (issue #45). Stacked layers used to read as one flat
// sheet: every tile painted the same face colour, the extruded side was a
// single flat fill, and nothing cast a shadow — so you could not see which
// tiles were on top without tapping.
//
// Four cues, in descending order of how much work they do:
//
//   1. a soft drop shadow down-right of every tile (SHADOW_RINGS) — the one
//      cue that actually detaches an upper layer from the stack below it;
//   2. a shaded side face, light where it meets the top face and near-dark at
//      its base (SIDE_BAND_FACTORS), instead of one flat colour;
//   3. a per-layer value shift so lower layers sit back (tileShade);
//   4. a darker, heavier outline so same-layer neighbours separate (BORDER_*).
//
// Everything here is plain geometry and colour arithmetic — no filters. The
// ticket's 60fps floor rules out per-frame filters on a 144-tile board; the
// renderer bakes the ring stack into one texture at construction and reuses it
// as a sprite per tile (see render.ts).
//
// Three constraints shape the numbers, all pinned by ui/test/depth.test.ts:
//
//   * Contrast ≥ 4.5:1 between every face and every suit ink, on every layer,
//     dimmed or not (spec §7, issue #12). The per-layer shift therefore moves
//     the *ink* as well as the face, and moves it faster — so a receding layer
//     gets more contrast than the top one, never less.
//   * Depth must survive greyscale (no colour-only cue): the layer shift is a
//     pure luminance ladder, and the shadow and side shading are achromatic in
//     effect, so all three read with the hue thrown away.
//   * Warm lantern palette per decision 0002 — the shift scales the existing
//     cream/tan toward black rather than introducing a new hue.

/**
 * The board's felt background (issue #82). Lives here with the rest of the
 * palette because the face-down back is picked *against* it: the theme rule
 * (shared with special-level theming, #67) is soft background / strong tile
 * back of the same hue — the background takes the muted, dark variant to ease
 * the eye, the back takes the saturated, light variant so a concealed tile
 * can never sink into the table.
 */
export const BOARD_FELT = 0x14532d;

/** Top face of a tile on the topmost layer, undimmed — the palette anchor. */
export const BASE_FACE = 0xfdf6e3;
/** Base colour of the extruded side face; SIDE_BAND_FACTORS shade it. */
export const BASE_SIDE = 0xcbb891;
/**
 * Tile outline. Darker and heavier than the old hairline (which was 0x8a7a55
 * at 1.5px, 3.9:1 against the face): same-layer neighbours have no shadow
 * between them — a tile's shadow falls where its right/lower neighbours paint
 * — so the outline is the only thing separating them.
 */
export const BASE_BORDER = 0x6b5c3a;

/**
 * A board palette (issue #67): everything about a board's look that is *not*
 * the face art. Special levels swap the palette; the face fill, suit inks,
 * glyphs and corner tags stay exactly as they are (decision 0002 — the
 * linework is theme-independent), so the ink-vs-face contrast proof is the
 * same for every palette and only the border, side, back and felt need
 * re-proving — which ui/test/depth.test.ts does per palette. A value the
 * renderer is handed, not a per-level special case: the v1.1+ themes work
 * (spec §2.2) adds palettes here, nothing else changes.
 */
export interface BoardPalette {
  readonly id: PaletteId;
  /** Spoken with the level heading — colour alone must never carry the
   *  meaning (spec §7). */
  readonly label: string;
  /** Board felt — the muted, dark variant of the palette hue. */
  readonly felt: number;
  /** Tile outline; must clear 3:1 against the (shared) face on every layer. */
  readonly border: number;
  /** Base of the extruded side; SIDE_BAND_FACTORS ramp it. */
  readonly side: number;
  /** Face-down back — the strong, light variant of the felt hue (issue #82),
   *  so a concealed tile never sinks into the table. */
  readonly back: number;
  /** The back's inset keyline. */
  readonly backKeyline: number;
}

export type PaletteId = 'lantern' | 'daily' | 'milestone';

/** The default warm lantern palette — the constants above, named. */
export const LANTERN: BoardPalette = {
  id: 'lantern',
  label: 'Lantern',
  felt: BOARD_FELT,
  border: BASE_BORDER,
  side: BASE_SIDE,
  back: 0x62c98a,
  backKeyline: 0x1b4d30,
};

/** Every shipped palette, by the level kind that wears it: ordinary ladder
 *  levels → lantern; the Daily Challenge → night indigo with gold edges; the
 *  decade milestone spikes (decision 0011) → burgundy with rose edges. */
export const PALETTES: Record<PaletteId, BoardPalette> = {
  lantern: LANTERN,
  daily: {
    id: 'daily',
    label: 'Daily Challenge',
    felt: 0x1e1b4b,
    border: 0x5b4a1e,
    side: 0xd4b96a,
    back: 0x8b95f5,
    backKeyline: 0x1e1b4b,
  },
  milestone: {
    id: 'milestone',
    label: 'Milestone',
    felt: 0x4c0519,
    border: 0x6b2a3a,
    side: 0xd9a3ad,
    back: 0xf28ea6,
    backKeyline: 0x4c0519,
  },
};

/** `#rrggbb` for CSS, from a packed RGB colour. */
export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export const BORDER_WIDTH = 2;
/** Outline width for the selected / hinted / mismatch-flash highlight. */
export const BORDER_WIDTH_ACTIVE = 4;

/**
 * Per-layer darkening of the top face, per layer below the top one.
 * Issue #86 softened it from 0.04: occlusion cues (cast shadow, thick beveled
 * side, larger lift) carry depth now, so faces stay bright on every layer and
 * the ink palette keeps its contrast headroom. Non-zero on purpose — a whisper
 * of a ladder still helps a greyscale read of deep wells.
 */
export const LAYER_FACE_STEP = 0.015;
/**
 * Per-layer darkening of the suit ink. Deliberately twice LAYER_FACE_STEP:
 * darkening the face alone would eat into the 4.5:1 figure/ground budget,
 * while moving the ink faster than the face *widens* it as layers recede.
 */
export const LAYER_INK_STEP = 0.03;

/**
 * Extra depth steps a blocked tile takes when "Highlight free tiles" is on
 * (issue #45 item 5, default off): a blocked tile is shaded as if it sat
 * several layers further back, so free tiles are the bright ones. Three steps
 * since issue #86 softened the per-step size — the aid keeps the visibility one
 * old-scale step used to give it — through the same arithmetic as the layer
 * ladder, so its contrast is covered by the same proof.
 */
export const DIMMED_STEPS = 3;

/**
 * Side-face bands as multipliers on BASE_SIDE, **base first**: near-dark where
 * the tile contacts what is underneath, lifted where the side meets the lit
 * top face. That is also the paint order — the outermost (darkest) band is
 * laid down first and each lighter band overpaints its inner part, so what
 * survives is a ramp from the face down to the base (render.ts).
 */
export const SIDE_BAND_FACTORS: readonly number[] = [0.52, 0.95, 1.22];

/**
 * Soft drop shadow, baked once into a texture and blitted per tile.
 *
 * Each entry grows the tile silhouette by `grow` board px and paints it black
 * at `alpha`; drawn largest-first they accumulate to ~0.42 alpha at the
 * contact edge, fading to 0.065 at the outer reach — a ramp, not a hard edge.
 * Issue #86 deepened and widened the stack: with the face ladder softened, the
 * cast shadow is the cue that detaches a raised tile from the layer below,
 * and its reach has to clear the larger LAYER_LIFT visibly.
 */
// Same alpha on every ring is deliberate, not a copy-paste: the ramp comes from
// how many rings overlap at a given distance, not from the per-ring value.
export const SHADOW_RINGS: readonly { readonly grow: number; readonly alpha: number }[] = [
  { grow: 16, alpha: 0.065 },
  { grow: 13, alpha: 0.065 },
  { grow: 10.5, alpha: 0.065 },
  { grow: 8, alpha: 0.065 },
  { grow: 6, alpha: 0.065 },
  { grow: 4, alpha: 0.065 },
  { grow: 2.5, alpha: 0.065 },
  { grow: 1, alpha: 0.065 },
];

/** Shadow offset in board px. The lift is up-left, so the light is too. */
export const SHADOW_DX = 4;
export const SHADOW_DY = 5;

/**
 * How far a ring reaches up-left, as a fraction of its down-right reach. Small
 * but non-zero: a ring is a rect, and a shadow that grew evenly would smear
 * over the left/upper neighbours that were already painted (painter's order
 * only covers what comes *after*). Kept below SHADOW_DX / max grow so no ring
 * ever escapes the silhouette on that side.
 */
export const SHADOW_UP_LEFT_RATIO = 0.2;

/** Board-px padding the baked shadow texture needs around the silhouette. */
export const SHADOW_PAD = Math.ceil(
  Math.max(...SHADOW_RINGS.map((r) => r.grow)) * (1 + SHADOW_UP_LEFT_RATIO) +
    Math.max(SHADOW_DX, SHADOW_DY),
);

export interface TileShade {
  /** Top-face fill. */
  readonly face: number;
  /** Outline colour. */
  readonly border: number;
  /** Side-face bands, outermost (base, darkest) first — paint order. */
  readonly sideBands: readonly number[];
  /** Applied to the suit's own colour (faces.ts owns the hue, this owns the
   *  value) — every ink on the tile: pips, glyph, and the corner tag. */
  readonly ink: (suitColor: number) => number;
}

/** Scale a packed RGB colour's channels, clamped to a byte. */
export function scaleColor(color: number, factor: number): number {
  const channel = (shift: number): number =>
    Math.max(0, Math.min(255, Math.round(((color >> shift) & 0xff) * factor)));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * How many steps back a tile sits: layers below the layout's top one, plus the
 * dim step when a blocked tile is being pushed back. Anchored on the layout's
 * own top layer rather than an absolute z, so the topmost tiles are the
 * brightest on a two-layer layout (Butterfly) exactly as on a five-layer one
 * (Turtle) — a flat layout is not dimmed for having no depth to show.
 */
export function depthSteps(z: number, topZ: number, dimmed = false): number {
  return Math.max(0, topZ - z) + (dimmed ? DIMMED_STEPS : 0);
}

/** Shade for a tile at layer `z` of a layout whose top layer is `topZ`, in
 *  `palette` (issue #67; lantern by default). The face and ink ladders are
 *  palette-independent — only border and side take the palette's colours. */
export function tileShade(z: number, topZ: number, dimmed = false, palette: BoardPalette = LANTERN): TileShade {
  const steps = depthSteps(z, topZ, dimmed);
  const faceFactor = 1 - LAYER_FACE_STEP * steps;
  const inkFactor = 1 - LAYER_INK_STEP * steps;
  return {
    face: scaleColor(BASE_FACE, faceFactor),
    border: scaleColor(palette.border, faceFactor),
    sideBands: SIDE_BAND_FACTORS.map((f) => scaleColor(palette.side, f * faceFactor)),
    ink: (suitColor: number) => scaleColor(suitColor, inkFactor),
  };
}

/** WCAG relative luminance of a packed RGB colour. */
export function relativeLuminance(color: number): number {
  const channel = (shift: number): number => {
    const c = ((color >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** WCAG contrast ratio between two packed RGB colours (1–21). */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
