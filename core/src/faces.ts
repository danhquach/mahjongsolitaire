// Tile faces + match rule (spec §3.3–3.4, issue #6; amended by decisions
// 0005 and 0012).
//
// FaceId scheme: `dots-1`…`dots-9`, `bamboo-1`…`bamboo-9`, `char-1`…`char-9`,
// `wind-east|south|west|north`, `dragon-red|green|white`,
// `season-spring|summer|fall|winter` (two identical copies each).

/** Match rule §3.3 (decision 0005, 2026-08-30): identical face required for
 *  ALL tiles — the classic Flower/Season wildcard groups are removed. */
export function facesMatch(a: string, b: string): boolean {
  return a === b;
}

const WINDS = ['east', 'south', 'west', 'north'];
const DRAGONS = ['red', 'green', 'white'];
const SEASONS = ['spring', 'summer', 'fall', 'winter'];

/** Standard 144 tile set (spec §3.4): 36 Dots, 36 Bamboo, 36 Characters,
 *  16 Winds, 12 Dragons, 8 Seasons. The Flower suit is gone (decision 0012):
 *  the four real seasons ship as two identical copies each, so every tile
 *  keeps an identical partner under exact-only matching (decision 0005). */
export const STANDARD_144: readonly string[] = (() => {
  const faces: string[] = [];
  for (const suit of ['dots', 'bamboo', 'char']) {
    for (let rank = 1; rank <= 9; rank++) {
      for (let copy = 0; copy < 4; copy++) faces.push(`${suit}-${rank}`);
    }
  }
  for (const wind of WINDS) for (let copy = 0; copy < 4; copy++) faces.push(`wind-${wind}`);
  for (const dragon of DRAGONS) for (let copy = 0; copy < 4; copy++) faces.push(`dragon-${dragon}`);
  for (const season of SEASONS) for (let copy = 0; copy < 2; copy++) faces.push(`season-${season}`);
  return faces;
})();

/** The suit half of a face id. */
export type FaceSuit = 'dots' | 'bamboo' | 'char' | 'wind' | 'dragon' | 'season';

const FACE_SUITS: readonly FaceSuit[] = ['dots', 'bamboo', 'char', 'wind', 'dragon', 'season'];

/** The suit a face id names — `dots-7` is Dots, `wind-east` is a Wind. Throws
 *  on anything this game does not deal: a caller reading a suit off an unknown
 *  id has a bug, and a silent fallback would miscount a challenge (issue #183). */
export function faceSuit(face: string): FaceSuit {
  const dash = face.indexOf('-');
  if (dash === -1 || dash === face.length - 1) throw new RangeError(`not a face id: ${face}`);
  const suit = FACE_SUITS.find((s) => s === face.slice(0, dash));
  if (suit === undefined) throw new RangeError(`not a face id: ${face}`);
  return suit;
}
