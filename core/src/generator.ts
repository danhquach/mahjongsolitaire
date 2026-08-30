// Seeded reverse-construction level generator (spec §4, issue #7).
//
// Never a naïve random deal: we start from the fully occupied lattice with
// unassigned faces and repeatedly pick two currently-free slots, assign them a
// matching face pair, and remove them. That removal sequence is, by
// construction, a legal solution of the resulting deal — so every generated
// level is solvable, and the sequence is returned as the solution witness.
// Deterministic given (layoutId, seed); store only the seed (spec §4).

import { Board } from './board.js';
import type { Tile, TileId } from './board.js';
import { STANDARD_144 } from './faces.js';
import type { Layout } from './layouts.js';
import { hashString, mulberry32 } from './rng.js';
import { solve } from './solver.js';
import type { SolveOptions } from './solver.js';

export interface GeneratedLevel {
  readonly layoutId: string;
  readonly seed: number;
  /** Tile ids are 0..n-1 in layout slot order (stable per spec §9 replay). */
  readonly tiles: readonly Tile[];
  /** Pair-removal order that clears the board — the solvability witness. */
  readonly solution: ReadonlyArray<readonly [TileId, TileId]>;
}

/** The 72 matching face pairs of the standard 144 set: identical copies only
 *  (decision 0005 — no wildcard groups; every face has an even copy count). */
function buildPairPool(): [string, string][] {
  const byFace = new Map<string, number>();
  for (const face of STANDARD_144) {
    byFace.set(face, (byFace.get(face) ?? 0) + 1);
  }
  const pairs: [string, string][] = [];
  for (const [face, count] of byFace) {
    for (let i = 0; i < Math.floor(count / 2); i++) pairs.push([face, face]);
  }
  return pairs;
}

function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

const MAX_ATTEMPTS = 1000;

export function generateLevel(layout: Layout, seed: number): GeneratedLevel {
  const n = layout.slots.length;
  if (n % 2 !== 0) {
    throw new RangeError(`layout ${layout.id} must have an even slot count, got ${n}`);
  }
  const pool = buildPairPool();
  if (n / 2 > pool.length) {
    throw new RangeError(
      `layout ${layout.id} needs ${n / 2} pairs but the standard tile set has ${pool.length}`,
    );
  }

  const rng = mulberry32(hashString(layout.id) ^ seed);

  // The rng stream continues across attempts, so retries after a construction
  // dead end (fewer than 2 free slots left) stay deterministic per seed.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pairs = [...pool];
    shuffle(pairs, rng);

    const faces = new Array<string>(n).fill('');
    const board = new Board(layout.slots.map((slot, i) => ({ id: i, slot, face: '' })));
    const solution: [TileId, TileId][] = [];

    while (solution.length < n / 2) {
      const free = board.freeTileIds();
      if (free.length < 2) break; // dead end — retry
      const a = free.splice(Math.floor(rng() * free.length), 1)[0]!;
      const b = free.splice(Math.floor(rng() * free.length), 1)[0]!;
      const [faceA, faceB] = pairs[solution.length]!;
      faces[a] = faceA;
      faces[b] = faceB;
      board.remove(a);
      board.remove(b);
      solution.push([a, b]);
    }

    if (solution.length === n / 2) {
      const tiles: Tile[] = layout.slots.map((slot, i) => ({
        id: i,
        slot,
        face: faces[i]!,
        removed: false,
      }));
      return { layoutId: layout.id, seed, tiles, solution };
    }
  }

  throw new Error(`generator dead-ended ${MAX_ATTEMPTS}× for layout ${layout.id}, seed ${seed}`);
}

// Defense-in-depth headroom only: reverse construction is solvable by
// construction, so validation failures ('unknown' on a budget-busting deal)
// are rare; empirically <1% of seeds even on adversarial stacked layouts.
const MAX_RESEEDS = 64;

/**
 * Spec §4: post-generation solver validation, reseeding (seed+1, seed+2, …)
 * until the bounded DFS confirms solvability. The returned level's `seed` is
 * the one that validated — store that seed (regeneration reproduces the deal).
 * Reverse construction makes failure here a defense-in-depth path, not an
 * expected one.
 */
export function generateValidatedLevel(
  layout: Layout,
  seed: number,
  solveOptions: SolveOptions = {},
): GeneratedLevel {
  for (let i = 0; i < MAX_RESEEDS; i++) {
    const level = generateLevel(layout, seed + i);
    if (solve(level.tiles, solveOptions).verdict === 'solvable') return level;
  }
  throw new Error(
    `no solver-validated deal within ${MAX_RESEEDS} reseeds for layout ${layout.id}, seed ${seed}`,
  );
}
