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
// The red/green accents are the traditional ones. Dots follow one rule: the
// middle row is red, the outer rows green (see `bandAccent`). Bamboo follows
// the traditional per-rank table instead (issue #163, decision 0024): 3 and 7
// take a red top cane, 5 a red centre, 6 a red bottom row, 9 a red middle row,
// and the rest are all green — so the two three-column grid ranks, 6 and 9,
// no longer share a colour pattern as well as a column count. Colour never carries
// meaning here; the shape does.
//
// Issue #152 (2026-09-02) removed the corner tag from every face: the West Wind
// and the White Dragon both tagged "W", and on a phone the tag was often the
// only part of a covered tile still visible — so players matched by it. Every
// face is now identifiable from its main art alone (decision 0023), and the
// art grew into the space the tag left. The Dragons each took their own ink in
// the same change: red 中, green 發, and a drawn white double frame.

/** Pip position in unit face coordinates (0–1 within the pip area). */
export interface Pip {
  readonly x: number;
  readonly y: number;
  /** Second colour for this pip: the accent half of a Dots ring, or the whole
   *  cane for Bamboo. Traditional banding, never a semantic cue. */
  readonly accent?: number;
}

/** A small companion glyph on a composed face (decision 0012), positioned in
 *  the same unit face coordinates the pips use. */
export interface ScatterGlyph {
  readonly glyph: string;
  readonly x: number;
  readonly y: number;
  /** Rotation in radians — Fall's leaves fall; everything else sits upright. */
  readonly rotation?: number;
}

export interface FaceStyle {
  /** Large glyph drawn on the tile (used when `pips` and `frame` are absent). */
  readonly glyph: string;
  /** Drawn face (issue #152, the White Dragon): a white-filled double frame in
   *  `color`, instead of a font glyph — 囗 read as a missing-glyph box. */
  readonly frame?: true;
  /** Suit accent color (hex). */
  readonly color: number;
  /** Human-readable name — becomes the ARIA label in issue #12. */
  readonly label: string;
  /** Per-rank pip positions (issue #35) — replaces the single glyph for Dots/Bamboo. */
  readonly pips?: readonly Pip[];
  /** How each pip is drawn: a split ring (Dots) or a capped cane (Bamboo). */
  readonly pipShape?: 'ring' | 'cane';
  /** Composed face (decision 0012, Seasons): name text drawn under the glyph. */
  readonly name?: string;
  /** Composed face: two small companions scattered around the main glyph. */
  readonly scatter?: readonly ScatterGlyph[];
  /** Rotation of the main glyph in radians (Fall's ❧ tips ~24°). */
  readonly rotation?: number;
}

const WIND_GLYPHS: Record<string, string> = { east: '東', south: '南', west: '西', north: '北' };
const DRAGON_GLYPHS: Record<string, string> = { red: '中', green: '發' };
const CHAR_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

// Deep, saturated inks: the tile face is the light ground, so every ink is
// dark enough to hold 4.5:1 against it on every layer (ui/test/depth.test.ts
// proves the sweep). Dots navy and Bamboo pine replaced a bright blue and a
// mid green with the redraw — both raised the figure/ground floor.
//
// Issue #83: every group's ink keeps clear hue-or-lightness distance from
// every other group's, so color can pre-filter a board scan before the glyph
// resolves. Dots moved from navy (0x22406e) to royal blue — clearly saturated
// beside Winds' slate, which now reads as the neutral gray. Deliberate shares
// (Spring = Bamboo pine, Summer = Characters red, decision 0012) stay — only
// accidental near-misses moved.
//
// Issue #152 retired the Dragons' shared purple: each Dragon now paints in the
// ink its traditional colour names (decision 0023). Sharing is safe under the
// "never colour alone" rule because the shapes never collide — a Dragon is one
// character or a frame, a Character is a numeral, Bamboo is canes, a Wind is a
// character with its own glyphs — and it means the ink set stays closed.
const SUIT_COLOR = {
  dots: 0x1e40af, // royal blue (8.1:1 on the tile face)
  bamboo: 0x1a6b52, // pine (also the Green Dragon)
  char: 0xb91c1c, // red (also the Red Dragon)
  wind: 0x334155, // slate (also the White Dragon's frame)
} as const;

/**
 * Season faces (issue #75, decision 0012): one composed design per season —
 * a large pictogram, two small scattered companions and the season name (the
 * 1–4 numeral tag went with every other corner tag, issue #152). Every ink is
 * reused from the proven palette so the ink set stays closed (fall's orange is
 * the ink the removed Flower suit freed); identity is carried by shape and
 * name — never the color alone (spec §7).
 */
const SEASON_STYLE: Record<
  string,
  Pick<FaceStyle, 'glyph' | 'color' | 'scatter' | 'rotation'>
> = {
  spring: {
    glyph: '❀',
    color: 0x1a6b52, // pine (shared with Bamboo)
    scatter: [
      { glyph: '❀', x: 0.18, y: 0.12 },
      { glyph: '❀', x: 0.84, y: 0.5 },
    ],
  },
  summer: {
    glyph: '☀',
    color: 0xb91c1c, // red (shared with Characters)
    scatter: [
      { glyph: '✦', x: 0.16, y: 0.5 },
      { glyph: '✦', x: 0.84, y: 0.14 },
    ],
  },
  fall: {
    glyph: '❧',
    // Issue #83: russet, not orange — the orange (0xc2410c) was a hue
    // neighbour of Characters' red one row away; russet keeps the autumn
    // read while opening clear hue distance (6.6:1 on the tile face).
    color: 0x92400e,
    rotation: 0.42, // ~24°: the leaf tips over
    scatter: [
      { glyph: '❧', x: 0.2, y: 0.14, rotation: 0.9 },
      { glyph: '❧', x: 0.82, y: 0.52, rotation: 1.4 },
    ],
  },
  winter: {
    glyph: '❄',
    color: 0x0e7490, // teal (the old Season ink)
    scatter: [
      { glyph: '❅', x: 0.17, y: 0.13 },
      { glyph: '❆', x: 0.83, y: 0.5 },
    ],
  },
};

/** The two traditional banding accents, reused from the suit palette so the
 *  ink set stays closed — no colour on a tile that is not already proven. */
const ACCENT_RED = SUIT_COLOR.char;
const ACCENT_GREEN = SUIT_COLOR.bamboo;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Fallback for a face id nothing recognizes (also an unknown season). */
function unknownFace(face: string): FaceStyle {
  return { glyph: '?', color: 0x000000, label: face };
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
 * Which canes of each Bamboo rank are red (issue #163), as indices into the
 * rank's pip list — `rows()` and `grid()` emit top-to-bottom, left-to-right,
 * and Bamboo-5's centre cane is appended last. The traditional set: a red top
 * cane on 3 and 7, a red centre on 5, a red bottom row on 6 and a red middle
 * row on 9. Everything else is green.
 */
const BAMBOO_RED: readonly (readonly number[])[] = [
  [], // 1
  [], // 2
  [0], // 3: the single top cane
  [], // 4
  [4], // 5: the centre cane
  [3, 4, 5], // 6: the bottom row
  [0], // 7: the single top cane
  [], // 8
  [3, 4, 5], // 9: the middle row
];

/** Attach the traditional Bamboo accents to a rank's canes. */
function bambooAccented(rank: number): Pip[] {
  const red = new Set(BAMBOO_RED[rank - 1] ?? []);
  return (BAMBOO_PIPS[rank - 1] ?? []).map((pip, i) => ({
    ...pip,
    accent: red.has(i) ? ACCENT_RED : ACCENT_GREEN,
  }));
}

/**
 * Traditional red/green banding for Dots: the middle band is red and the outer
 * bands are green, bands running by row. A rank whose bands are even in number
 * has no middle, so it is all green rather than picking an arbitrary side.
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
        color: SUIT_COLOR.dots,
        label: `Dots ${value}`,
        // Rings, banded by row: rank 9's three rows read green / red / green.
        pips: banded(DOT_PIPS[rank - 1] ?? [], 'y'),
        pipShape: 'ring',
      };
    case 'bamboo':
      return {
        glyph: '∥',
        color: SUIT_COLOR.bamboo,
        label: `Bamboo ${value}`,
        // Canes with the traditional per-rank accents (issue #163) — the whole
        // cane takes the accent, not half of it.
        pips: bambooAccented(rank),
        pipShape: 'cane',
      };
    case 'char':
      // Rank numeral only (no 萬 suit glyph) — per-rank counting stays visible.
      return {
        glyph: CHAR_NUMERALS[rank - 1] ?? value,
        color: SUIT_COLOR.char,
        label: `Character ${value}`,
      };
    case 'wind':
      return {
        glyph: WIND_GLYPHS[value] ?? '風',
        color: SUIT_COLOR.wind,
        label: `${capitalize(value)} Wind`,
      };
    case 'dragon': {
      // Issue #152: one ink and one shape each. The White Dragon is drawn, not
      // typed — its white fill on the cream face is what reads as "white".
      const label = `${capitalize(value)} Dragon`;
      switch (value) {
        case 'red':
          return { glyph: DRAGON_GLYPHS.red!, color: SUIT_COLOR.char, label };
        case 'green':
          return { glyph: DRAGON_GLYPHS.green!, color: SUIT_COLOR.bamboo, label };
        case 'white':
          return { glyph: '', frame: true, color: SUIT_COLOR.wind, label };
        default:
          return unknownFace(face);
      }
    }
    case 'season': {
      const season = SEASON_STYLE[value];
      if (!season) return unknownFace(face);
      return { ...season, label: `Season ${capitalize(value)}`, name: capitalize(value) };
    }
    default:
      return unknownFace(face);
  }
}
