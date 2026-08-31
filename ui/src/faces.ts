// Placeholder tile-face art (roadmap Phase 2: "placeholder art"; final art
// lands mid-phase). Suits are differentiated by symbol AND color — never
// color alone (spec §7 colorblind-safe requirement).

export interface FaceStyle {
  /** Large glyph drawn on the tile. */
  readonly glyph: string;
  /** Small corner tag (rank / initial) so identical faces are matchable at a glance. */
  readonly tag: string;
  /** Suit accent color (hex). */
  readonly color: number;
  /** Human-readable name — becomes the ARIA label in issue #12. */
  readonly label: string;
}

const WIND_GLYPHS: Record<string, string> = { east: '東', south: '南', west: '西', north: '北' };
const DRAGON_GLYPHS: Record<string, string> = { red: '中', green: '發', white: '囗' };

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

/** Map a core FaceId (`dots-3`, `wind-east`, …) to its placeholder style. */
export function faceStyle(face: string): FaceStyle {
  const dash = face.indexOf('-');
  const suit = dash === -1 ? face : face.slice(0, dash);
  const value = dash === -1 ? '' : face.slice(dash + 1);
  switch (suit) {
    case 'dots':
      return { glyph: '●', tag: value, color: SUIT_COLOR.dots, label: `Dots ${value}` };
    case 'bamboo':
      return { glyph: '∥', tag: value, color: SUIT_COLOR.bamboo, label: `Bamboo ${value}` };
    case 'char':
      return { glyph: '萬', tag: value, color: SUIT_COLOR.char, label: `Character ${value}` };
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
