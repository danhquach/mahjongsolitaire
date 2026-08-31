// Tile-face art. Suits are differentiated by symbol AND color — never color
// alone (spec §7 colorblind-safe requirement).
//
// Suited-rank art was redrawn in the traditional idiom (issue #45, 2026-08-31):
// Dots are rings with a two-tone split rather than flat discs, and Bamboo are
// capped, waisted cane segments rather than plain bars. Both are the generic
// mahjong conventions drawn from scratch in our own proportions — decision 0002
// forbids tracing or visual likeness to an existing tile set, and spec §12 puts
// that under store-review IP risk, so nothing here is copied from a specific
// set. Characters, Winds and Dragons stay font glyphs, at bold weight for the
// "thick, simplified strokes" decision 0002 asks for.
//
// The red/green banding is the traditional one, and it is one rule per suit:
// the middle band is red, the outer bands green — by row for Dots, by column
// for Bamboo (see `bandAccent`). Colour never carries meaning here; the shape
// and the corner tag do.

/** Pip position in unit face coordinates (0–1 within the pip area). */
export interface Pip {
  readonly x: number;
  readonly y: number;
  /** Second colour for this pip: the accent half of a Dots ring, or the whole
   *  cane for Bamboo. Traditional banding, never a semantic cue. */
  readonly accent?: number;
}

export interface FaceStyle {
  /** Large glyph drawn on the tile (used when `pips` is absent). */
  readonly glyph: string;
  /** Small corner tag (rank / initial) so identical faces are matchable at a glance. */
  readonly tag: string;
  /** Suit accent color (hex). */
  readonly color: number;
  /** Human-readable name — becomes the ARIA label in issue #12. */
  readonly label: string;
  /** Per-rank pip positions (issue #35) — replaces the single glyph for Dots/Bamboo. */
  readonly pips?: readonly Pip[];
  /** How each pip is drawn: a split ring (Dots) or a capped cane (Bamboo). */
  readonly pipShape?: 'ring' | 'cane';
}

const WIND_GLYPHS: Record<string, string> = { east: '東', south: '南', west: '西', north: '北' };
const DRAGON_GLYPHS: Record<string, string> = { red: '中', green: '發', white: '囗' };
const CHAR_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

// Deep, saturated inks: the tile face is the light ground, so every ink is
// dark enough to hold 4.5:1 against it on every layer (ui/test/depth.test.ts
// proves the sweep). Dots navy and Bamboo pine replaced a bright blue and a
// mid green with the redraw — both raised the figure/ground floor.
const SUIT_COLOR = {
  dots: 0x22406e, // navy
  bamboo: 0x1a6b52, // pine
  char: 0xb91c1c, // red
  wind: 0x334155, // slate
  dragon: 0x7e22ce, // purple
  flower: 0xc2410c, // orange
  season: 0x0e7490, // teal
} as const;

/** The two traditional banding accents, reused from the suit palette so the
 *  ink set stays closed — no colour on a tile that is not already proven. */
const ACCENT_RED = SUIT_COLOR.char;
const ACCENT_GREEN = SUIT_COLOR.bamboo;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Evenly spaced positions for n bands along one axis, in unit pip-area
 * coordinates: each band sits at the *centre* of its own 1/n cell.
 *
 * Cell-centred, not edge-to-edge (this used to be `0.15 + 0.7·i/(n−1)`): a pip
 * is drawn centred on its position and sized from the gap to its neighbour, so
 * an outer band pushed to 15% of the area has only 15% of the area to grow
 * into while its spacing says it may take 70%/(n−1). That mismatch is what put
 * the Bamboo ranks over the bottom edge of the tile. At (i + 0.5)/n every band
 * owns a full cell and half of it on each side, so a pip sized from the pitch
 * fits by construction — pips.ts still clamps, but nothing has to rely on it.
 */
function spread(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((i + 0.5) / n);
  return out;
}

/** Grid of columns × rows pips. */
function grid(cols: number, rows: number): Pip[] {
  const xs = spread(cols);
  const ys = spread(rows);
  const out: Pip[] = [];
  for (const y of ys) for (const x of xs) out.push({ x, y });
  return out;
}

/** Rows of pips (top to bottom), each row centered. */
function rows(...counts: number[]): Pip[] {
  const ys = spread(counts.length);
  const out: Pip[] = [];
  counts.forEach((n, i) => {
    const y = ys[i] ?? 0.5;
    for (const x of spread(n)) out.push({ x, y });
  });
  return out;
}

/** Traditional Dots (circle) arrangements per rank 1–9. */
const DOT_PIPS: readonly (readonly Pip[])[] = [
  [{ x: 0.5, y: 0.5 }], // 1
  [
    { x: 0.3, y: 0.3 },
    { x: 0.7, y: 0.7 },
  ], // 2 diagonal
  [
    { x: 0.25, y: 0.25 },
    { x: 0.5, y: 0.5 },
    { x: 0.75, y: 0.75 },
  ], // 3 diagonal
  grid(2, 2), // 4
  [...grid(2, 2), { x: 0.5, y: 0.5 }], // 5
  grid(2, 3), // 6
  [
    { x: 0.22, y: 0.17 },
    { x: 0.5, y: 0.27 },
    { x: 0.78, y: 0.37 },
    { x: 0.3, y: 0.62 },
    { x: 0.7, y: 0.62 },
    { x: 0.3, y: 0.84 },
    { x: 0.7, y: 0.84 },
  ], // 7: diagonal 3 over square 4
  grid(2, 4), // 8
  grid(3, 3), // 9
];

/** Traditional Bamboo (stick) arrangements per rank 1–9. */
const BAMBOO_PIPS: readonly (readonly Pip[])[] = [
  [{ x: 0.5, y: 0.5 }], // 1
  rows(1, 1), // 2
  rows(1, 2), // 3
  grid(2, 2), // 4
  [...grid(2, 2), { x: 0.5, y: 0.5 }], // 5
  grid(3, 2), // 6
  rows(1, 3, 3), // 7
  grid(4, 2), // 8
  grid(3, 3), // 9
];

/**
 * Traditional red/green banding, one rule for both suited pip suits: the middle
 * band is red and the outer bands are green — bands running by row for Dots and
 * by column for Bamboo. A rank whose bands are even in number has no middle, so
 * it is all green rather than picking an arbitrary side.
 *
 * `axis` is the coordinate the bands run across: 'y' groups pips into rows,
 * 'x' into columns. Values are rounded before grouping — `spread()` produces
 * repeating fractions, and two pips in the same row must land in one band.
 */
function bandAccent(pips: readonly Pip[], axis: 'x' | 'y'): (pip: Pip) => number {
  const band = (pip: Pip): number => Math.round(pip[axis] * 100);
  const bands = [...new Set(pips.map(band))].sort((a, b) => a - b);
  const middle = bands.length % 2 === 1 ? bands[(bands.length - 1) / 2] : null;
  return (pip) => (middle !== null && band(pip) === middle ? ACCENT_RED : ACCENT_GREEN);
}

/** Attach the banding accent to each pip of a rank. */
function banded(pips: readonly Pip[], axis: 'x' | 'y'): Pip[] {
  const accentOf = bandAccent(pips, axis);
  return pips.map((pip) => ({ ...pip, accent: accentOf(pip) }));
}

/** Map a core FaceId (`dots-3`, `wind-east`, …) to its style. */
export function faceStyle(face: string): FaceStyle {
  const dash = face.indexOf('-');
  const suit = dash === -1 ? face : face.slice(0, dash);
  const value = dash === -1 ? '' : face.slice(dash + 1);
  const rank = Number(value);
  switch (suit) {
    case 'dots':
      return {
        glyph: '◎',
        tag: value,
        color: SUIT_COLOR.dots,
        label: `Dots ${value}`,
        // Rings, banded by row: rank 9's three rows read green / red / green.
        pips: banded(DOT_PIPS[rank - 1] ?? [], 'y'),
        pipShape: 'ring',
      };
    case 'bamboo':
      return {
        glyph: '∥',
        tag: value,
        color: SUIT_COLOR.bamboo,
        label: `Bamboo ${value}`,
        // Canes, banded by column: rank 9's three columns read green / red /
        // green — the whole cane takes the accent, not half of it.
        pips: banded(BAMBOO_PIPS[rank - 1] ?? [], 'x'),
        pipShape: 'cane',
      };
    case 'char':
      // Rank numeral only (no 萬 suit glyph) — per-rank counting stays visible.
      return {
        glyph: CHAR_NUMERALS[rank - 1] ?? value,
        tag: value,
        color: SUIT_COLOR.char,
        label: `Character ${value}`,
      };
    case 'wind':
      return {
        glyph: WIND_GLYPHS[value] ?? '風',
        tag: value.charAt(0).toUpperCase(),
        color: SUIT_COLOR.wind,
        label: `${capitalize(value)} Wind`,
      };
    case 'dragon':
      return {
        glyph: DRAGON_GLYPHS[value] ?? '龍',
        tag: value.charAt(0).toUpperCase(),
        color: SUIT_COLOR.dragon,
        label: `${capitalize(value)} Dragon`,
      };
    case 'flower':
      return { glyph: '✿', tag: value, color: SUIT_COLOR.flower, label: `Flower ${value}` };
    case 'season':
      return { glyph: '❋', tag: value, color: SUIT_COLOR.season, label: `Season ${value}` };
    default:
      return { glyph: '?', tag: face, color: 0x000000, label: face };
  }
}
