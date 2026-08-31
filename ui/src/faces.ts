// Placeholder tile-face art (roadmap Phase 2: "placeholder art"; final art
// lands mid-phase). Suits are differentiated by symbol AND color — never
// color alone (spec §7 colorblind-safe requirement).

/** Pip position in unit face coordinates (0–1 within the pip area). */
export interface Pip {
  readonly x: number;
  readonly y: number;
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
  /** How each pip is drawn: filled circle (Dots) or stick (Bamboo). */
  readonly pipShape?: 'dot' | 'stick';
}

const WIND_GLYPHS: Record<string, string> = { east: '東', south: '南', west: '西', north: '北' };
const DRAGON_GLYPHS: Record<string, string> = { red: '中', green: '發', white: '囗' };
const CHAR_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

const SUIT_COLOR = {
  dots: 0x1d4ed8, // blue
  bamboo: 0x15803d, // green
  char: 0xb91c1c, // red
  wind: 0x334155, // slate
  dragon: 0x7e22ce, // purple
  flower: 0xc2410c, // orange
  season: 0x0e7490, // teal
} as const;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Evenly spaced positions for n items along one axis, centered in the unit range. */
function spread(n: number): number[] {
  if (n === 1) return [0.5];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(0.15 + (0.7 * i) / (n - 1));
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
    { x: 0.22, y: 0.22 },
    { x: 0.5, y: 0.5 },
    { x: 0.78, y: 0.78 },
  ], // 3 diagonal
  grid(2, 2), // 4
  [...grid(2, 2), { x: 0.5, y: 0.5 }], // 5
  grid(2, 3), // 6
  [
    { x: 0.22, y: 0.16 },
    { x: 0.5, y: 0.26 },
    { x: 0.78, y: 0.36 },
    { x: 0.3, y: 0.62 },
    { x: 0.7, y: 0.62 },
    { x: 0.3, y: 0.86 },
    { x: 0.7, y: 0.86 },
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

/** Map a core FaceId (`dots-3`, `wind-east`, …) to its placeholder style. */
export function faceStyle(face: string): FaceStyle {
  const dash = face.indexOf('-');
  const suit = dash === -1 ? face : face.slice(0, dash);
  const value = dash === -1 ? '' : face.slice(dash + 1);
  const rank = Number(value);
  switch (suit) {
    case 'dots':
      return {
        glyph: '●',
        tag: value,
        color: SUIT_COLOR.dots,
        label: `Dots ${value}`,
        pips: DOT_PIPS[rank - 1] ?? [],
        pipShape: 'dot',
      };
    case 'bamboo':
      return {
        glyph: '∥',
        tag: value,
        color: SUIT_COLOR.bamboo,
        label: `Bamboo ${value}`,
        pips: BAMBOO_PIPS[rank - 1] ?? [],
        pipShape: 'stick',
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
