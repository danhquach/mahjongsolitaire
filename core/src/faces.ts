// Tile faces + match rule (spec §3.3–3.4, issue #6).
//
// FaceId scheme: `dots-1`…`dots-9`, `bamboo-1`…`bamboo-9`, `char-1`…`char-9`,
// `wind-east|south|west|north`, `dragon-red|green|white`,
// `flower-1`…`flower-4`, `season-1`…`season-4`.

/** Match rule §3.3: exact face for all suits; any Flower matches any Flower,
 *  any Season matches any Season. `matchGroup` collapses only the wildcards,
 *  so unknown/placeholder faces fall back to exact-match. */
export function matchGroup(face: string): string {
  if (face.startsWith('flower-')) return 'flower';
  if (face.startsWith('season-')) return 'season';
  return face;
}

export function facesMatch(a: string, b: string): boolean {
  return matchGroup(a) === matchGroup(b);
}

const WINDS = ['east', 'south', 'west', 'north'];
const DRAGONS = ['red', 'green', 'white'];

/** Standard 144 tile set (spec §3.4): 36 Dots, 36 Bamboo, 36 Characters,
 *  16 Winds, 12 Dragons, 4 Flowers, 4 Seasons. */
export const STANDARD_144: readonly string[] = (() => {
  const faces: string[] = [];
  for (const suit of ['dots', 'bamboo', 'char']) {
    for (let rank = 1; rank <= 9; rank++) {
      for (let copy = 0; copy < 4; copy++) faces.push(`${suit}-${rank}`);
    }
  }
  for (const wind of WINDS) for (let copy = 0; copy < 4; copy++) faces.push(`wind-${wind}`);
  for (const dragon of DRAGONS) for (let copy = 0; copy < 4; copy++) faces.push(`dragon-${dragon}`);
  for (let i = 1; i <= 4; i++) faces.push(`flower-${i}`);
  for (let i = 1; i <= 4; i++) faces.push(`season-${i}`);
  return faces;
})();
