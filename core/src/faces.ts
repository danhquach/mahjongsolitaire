// Tile faces + match rule (spec §3.3–3.4, issue #6; amended by decision 0005).
//
// FaceId scheme: `dots-1`…`dots-9`, `bamboo-1`…`bamboo-9`, `char-1`…`char-9`,
// `wind-east|south|west|north`, `dragon-red|green|white`,
// `flower-1|flower-2`, `season-1|season-2` (two identical copies each).

/** Match rule §3.3 (decision 0005, 2026-08-30): identical face required for
 *  ALL tiles — the classic Flower/Season wildcard groups are removed. */
export function facesMatch(a: string, b: string): boolean {
  return a === b;
}

const WINDS = ['east', 'south', 'west', 'north'];
const DRAGONS = ['red', 'green', 'white'];

/** Standard 144 tile set (spec §3.4): 36 Dots, 36 Bamboo, 36 Characters,
 *  16 Winds, 12 Dragons, 4 Flowers, 4 Seasons. Flowers/Seasons come as two
 *  identical copies of two faces each (decision 0005) so every tile has an
 *  identical partner under exact-only matching. */
export const STANDARD_144: readonly string[] = (() => {
  const faces: string[] = [];
  for (const suit of ['dots', 'bamboo', 'char']) {
    for (let rank = 1; rank <= 9; rank++) {
      for (let copy = 0; copy < 4; copy++) faces.push(`${suit}-${rank}`);
    }
  }
  for (const wind of WINDS) for (let copy = 0; copy < 4; copy++) faces.push(`wind-${wind}`);
  for (const dragon of DRAGONS) for (let copy = 0; copy < 4; copy++) faces.push(`dragon-${dragon}`);
  for (let i = 1; i <= 2; i++) for (let copy = 0; copy < 2; copy++) faces.push(`flower-${i}`);
  for (let i = 1; i <= 2; i++) for (let copy = 0; copy < 2; copy++) faces.push(`season-${i}`);
  return faces;
})();
