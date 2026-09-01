// Solvability solver + hint search (spec §4, issue #8).
//
// Two-stage bounded search under one shared state budget:
// 1. Deterministic randomized-restart greedy playouts — on reverse-constructed
//    deals these find a winning line almost immediately, keeping the common
//    case in the sub-millisecond range even at 144 tiles.
// 2. Bounded DFS + memoization of dead states — the sound prover that playouts
//    fall back to, and the only stage that can return 'unsolvable'.
// Matching is identical-face only (decision 0005), which both stages exploit:
// - parity precheck: any face with an odd present count can never clear;
// - safe-move reduction: when every present copy of a face is free, removing
//   them all is always optimal (removals only ever unblock other tiles, and
//   identical copies pair interchangeably), so no branching is needed there.
// Branching order matters enormously at 144-tile scale: candidate pairs are
// tried most-unblocking first (tiles that cover or side-block the most present
// tiles), which keeps reverse-constructed deals in the low-millisecond range.
// The same search powers the Hint booster (spec §5): a hint is the first move
// of a found winning line, falling back to any legal pair in lost positions.
//
// The holder (issue #43) is first-class here, not an afterthought: a held tile
// is a search node with no adjacency at all, so the existing free-tile test
// already answers "always free" for it and the parity precheck already counts
// it. Two consequences worth stating, because the deadlock dialog rests on
// them:
//   * Holding still helps the *position*. It takes a tile off the lattice,
//     which frees at least as many tiles as before and never fewer, so any
//     winning line of the un-held position is still a winning line of the held
//     one. `solve` therefore stays sound while ignoring holds entirely.
//   * But holding no longer helps the *player* unconditionally. Under decision
//     0009 the holder is one-way and filling the fourth slot loses the level,
//     so a hold now costs a slot the player can never buy back except by
//     matching. That is why `hasPlayableMove` below stops one slot short: a
//     park that fills the last slot is a loss, not a way out. Everything a
//     position needs to stay winnable is still true; what changed is which
//     holds a *player* may take, and that is a rules question, not a search one.
//   * The converse still fails: holding unblocks without needing a matching
//     partner, so some positions are winnable only with the holder. The search
//     itself does not plan holds (a plain `solve` answers the question the
//     generator and Shuffle ask, which is about the deal, not the assist), so
//     `hasPlayableMove` below is the one place that looks ahead through them.

import { Board, footprintsOverlap } from './board.js';
import type { Tile, TileId, TileInput } from './board.js';
import { mulberry32 } from './rng.js';

export type SolveVerdict = 'solvable' | 'unsolvable' | 'unknown';

export interface SolveResult {
  readonly verdict: SolveVerdict;
  /** Pair-removal order that clears the board; null unless solvable. */
  readonly solution: ReadonlyArray<readonly [TileId, TileId]> | null;
  /** DFS states expanded — the bounded-search cost metric. */
  readonly statesVisited: number;
}

export interface SolveOptions {
  /** DFS state budget; exceeding it yields verdict 'unknown'. */
  readonly maxStates?: number;
  /** Holder occupancy for the position (issue #43) — pass `board.holderSlots()`
   *  alongside `board.allTiles()`, or held tiles read as ordinary board tiles
   *  sitting in slots they have actually vacated. */
  readonly holder?: readonly (TileId | null)[];
}

/** Generous for reverse-constructed deals (typically well under 1k states)
 *  while still bounding pathological hand-built positions. */
export const DEFAULT_MAX_STATES = 100_000;

/** Greedy playout attempts before falling back to the DFS prover. 50 restarts
 *  cycling 4 bias levels were tuned empirically on 144-tile stacked layouts
 *  (1000 seeds): enough to solve >99% of deals in stage 1 at ~72 states per
 *  attempt, cheap enough to be noise when a deal needs the DFS anyway. */
const PLAYOUT_RESTARTS = 50;

/** All currently playable pairs: matchable tiles — free on the board or held
 *  (issue #43) — with identical faces, each pair [low, high] id,
 *  lexicographically ordered (deterministic hint cycling). */
export function legalPairs(board: Board): Array<[TileId, TileId]> {
  const byFace = new Map<string, TileId[]>();
  for (const id of board.matchableTileIds()) {
    const face = board.get(id).face;
    let ids = byFace.get(face);
    if (!ids) byFace.set(face, (ids = []));
    ids.push(id);
  }
  const pairs: Array<[TileId, TileId]> = [];
  for (const ids of byFace.values()) {
    for (let i = 0; i < ids.length - 1; i++) {
      for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i]!, ids[j]!]);
    }
  }
  return pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Search-internal tile: adjacency precomputed once (indices, not ids). A held
 *  tile's four lists all stay empty — it is off the lattice, so it blocks
 *  nothing and nothing blocks it, which is exactly what `isFree` then reads. */
interface Node {
  readonly id: TileId;
  readonly face: string;
  /** Tiles overlapping this tile's footprint at z+1 (they cover it). */
  readonly above: number[];
  /** Same-z tiles overlapping the adjacent footprint on each side. */
  readonly left: number[];
  readonly right: number[];
  /** Tiles this tile blocks: covers from above, or side-blocks (mutual). */
  readonly blocks: number[];
}

function buildNodes(inPlay: readonly Tile[], held: ReadonlySet<TileId>): Node[] {
  const nodes: Node[] = inPlay.map((t) => ({
    id: t.id,
    face: t.face,
    above: [],
    left: [],
    right: [],
    blocks: [],
  }));
  for (let i = 0; i < inPlay.length; i++) {
    if (held.has(inPlay[i]!.id)) continue;
    const a = inPlay[i]!.slot;
    for (let j = 0; j < inPlay.length; j++) {
      if (i === j || held.has(inPlay[j]!.id)) continue;
      const b = inPlay[j]!.slot;
      if (b.z === a.z + 1 && footprintsOverlap(a.x, a.y, b.x, b.y)) {
        nodes[i]!.above.push(j);
        nodes[j]!.blocks.push(i);
      } else if (b.z === a.z && footprintsOverlap(a.x - 2, a.y, b.x, b.y)) {
        nodes[i]!.left.push(j);
        nodes[j]!.blocks.push(i);
      } else if (b.z === a.z && footprintsOverlap(a.x + 2, a.y, b.x, b.y)) {
        nodes[i]!.right.push(j);
        nodes[j]!.blocks.push(i);
      }
    }
  }
  return nodes;
}

/**
 * Decide solvability of the position given by `tiles` (removed tiles are
 * honored, as in the Board constructor). Bounded DFS + memoized dead states;
 * budget exhaustion reports 'unknown' — callers treat it as failure (reseed).
 */
export function solve(tiles: Iterable<TileInput>, options: SolveOptions = {}): SolveResult {
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  // The Board validates the lattice (ids, slots, overlaps) and the holder;
  // the search itself runs on precomputed adjacency below.
  const board = options.holder ? new Board(tiles, { holder: options.holder }) : new Board(tiles);
  const present = board.inPlayTiles();
  const held = new Set(board.heldTileIds());

  // Parity precheck: identical-only matching means every face must have an
  // even in-play count — held tiles included, since they still need a partner.
  // (Also catches odd total tile counts.)
  const presentByFace = new Map<string, number>();
  for (const t of present) presentByFace.set(t.face, (presentByFace.get(t.face) ?? 0) + 1);
  for (const count of presentByFace.values()) {
    if (count % 2 !== 0) return { verdict: 'unsolvable', solution: null, statesVisited: 0 };
  }

  const nodes = buildNodes(present, held);
  const n = nodes.length;
  const removed = new Array<boolean>(n).fill(false);
  const mask = new Uint32Array((n >>> 5) + 1);
  const solution: Array<readonly [TileId, TileId]> = [];
  const deadStates = new Set<string>();
  let remaining = n;
  let statesVisited = 0;
  let exhausted = false;

  const isFree = (i: number): boolean => {
    const t = nodes[i]!;
    if (t.above.some((a) => !removed[a])) return false;
    return !t.left.some((l) => !removed[l]) || !t.right.some((r) => !removed[r]);
  };

  /** Index pairs mirroring `solution`, for unwinding playouts. */
  const path: Array<[number, number]> = [];

  const take = (i: number, j: number): void => {
    removed[i] = removed[j] = true;
    mask[i >>> 5]! |= 1 << (i & 31);
    mask[j >>> 5]! |= 1 << (j & 31);
    const face = nodes[i]!.face;
    presentByFace.set(face, presentByFace.get(face)! - 2);
    solution.push([nodes[i]!.id, nodes[j]!.id]);
    path.push([i, j]);
    remaining -= 2;
  };

  const untake = (i: number, j: number): void => {
    removed[i] = removed[j] = false;
    mask[i >>> 5]! &= ~(1 << (i & 31));
    mask[j >>> 5]! &= ~(1 << (j & 31));
    const face = nodes[i]!.face;
    presentByFace.set(face, presentByFace.get(face)! + 2);
    solution.pop();
    path.pop();
    remaining += 2;
  };

  /** Present tiles that pair (i, j) still blocks — its unblocking potential. */
  const blockScore = (i: number, j: number): number => {
    let score = 0;
    for (const b of nodes[i]!.blocks) if (!removed[b] && b !== j) score++;
    for (const b of nodes[j]!.blocks) if (!removed[b] && b !== i) score++;
    return score;
  };

  /** One greedy playout: safe moves + a score-biased random pick, no
   *  backtracking. Restores the start position on failure. */
  const playout = (rng: () => number, bias: number): boolean => {
    while (remaining > 0) {
      if (++statesVisited > maxStates) {
        exhausted = true;
        break;
      }
      const freeByFace = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        if (removed[i] || !isFree(i)) continue;
        const face = nodes[i]!.face;
        let ids = freeByFace.get(face);
        if (!ids) freeByFace.set(face, (ids = []));
        ids.push(i);
      }
      let moved = false;
      for (const [face, ids] of freeByFace) {
        if (ids.length !== presentByFace.get(face)) continue;
        for (let i = 0; i + 1 < ids.length; i += 2) take(ids[i]!, ids[i + 1]!);
        freeByFace.delete(face);
        moved = true;
      }
      if (moved) continue;

      let candidates: Array<[number, number, number]> = [];
      for (const ids of freeByFace.values()) {
        for (let i = 0; i < ids.length - 1; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            candidates.push([ids[i]!, ids[j]!, blockScore(ids[i]!, ids[j]!)]);
          }
        }
      }
      if (candidates.length === 0) break; // dead end
      const unblocking = candidates.filter((c) => c[2] > 0);
      if (unblocking.length > 0) candidates = unblocking;
      candidates.sort((a, b) => b[2] - a[2] || a[0] - b[0] || a[1] - b[1]);
      // Biased pick: higher bias leans toward the highest-scoring pairs;
      // bias 1 is uniform. Restarts vary the bias to diversify the search.
      const pick = candidates[Math.floor(Math.pow(rng(), bias) * candidates.length)]!;
      take(pick[0], pick[1]);
    }
    if (remaining === 0) return true;
    while (path.length > 0) {
      const [i, j] = path[path.length - 1]!;
      untake(i, j);
    }
    return false;
  };

  const dfs = (): boolean => {
    if (remaining === 0) return true;
    const key = mask.join(',');
    if (deadStates.has(key)) return false;
    if (++statesVisited > maxStates) {
      exhausted = true;
      return false;
    }

    const freeByFace = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      if (removed[i] || !isFree(i)) continue;
      const face = nodes[i]!.face;
      let ids = freeByFace.get(face);
      if (!ids) freeByFace.set(face, (ids = []));
      ids.push(i);
    }

    // Safe-move reduction: faces whose every present copy is free.
    const safePairs: Array<[number, number]> = [];
    for (const [face, ids] of freeByFace) {
      if (ids.length !== presentByFace.get(face)) continue;
      for (let i = 0; i + 1 < ids.length; i += 2) safePairs.push([ids[i]!, ids[i + 1]!]);
      freeByFace.delete(face);
    }
    if (safePairs.length > 0) {
      for (const [i, j] of safePairs) take(i, j);
      if (dfs()) return true;
      for (let k = safePairs.length - 1; k >= 0; k--) untake(safePairs[k]![0], safePairs[k]![1]);
      if (!exhausted) deadStates.add(key);
      return false;
    }

    // Branch over candidate pairs, most-unblocking first (ids break ties).
    // Zero-score pairs unblock nothing, so playing them can always be deferred
    // (their absence is never a precondition of another move): branch on them
    // only when no unblocking pair exists at all.
    let candidates: Array<[number, number, number]> = [];
    for (const ids of freeByFace.values()) {
      for (let i = 0; i < ids.length - 1; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          candidates.push([ids[i]!, ids[j]!, blockScore(ids[i]!, ids[j]!)]);
        }
      }
    }
    const unblocking = candidates.filter((c) => c[2] > 0);
    if (unblocking.length > 0) candidates = unblocking;
    candidates.sort((a, b) => b[2] - a[2] || a[0] - b[0] || a[1] - b[1]);

    for (const [i, j] of candidates) {
      take(i, j);
      if (dfs()) return true;
      untake(i, j);
      if (exhausted) return false;
    }
    deadStates.add(key);
    return false;
  };

  // Stage 1: playouts (seeded constant — solve stays a pure function of its
  // inputs). Stage 2: the DFS prover, sharing the same state budget.
  const rng = mulberry32(0x51afe17e);
  for (let k = 0; k < PLAYOUT_RESTARTS && !exhausted; k++) {
    if (playout(rng, 1 + (k % 4))) return { verdict: 'solvable', solution, statesVisited };
  }
  if (!exhausted && dfs()) return { verdict: 'solvable', solution, statesVisited };
  return { verdict: exhausted ? 'unknown' : 'unsolvable', solution: null, statesVisited };
}

/**
 * Hint booster search (spec §5): the first move of a winning line when one is
 * found within budget, otherwise the first legal pair (a lost or unknown
 * position still deserves a highlight), or null with no legal pair at all.
 */
export function findHint(board: Board, options: SolveOptions = {}): readonly [TileId, TileId] | null {
  const result = solve(board.allTiles(), { ...options, holder: board.holderSlots() });
  if (result.verdict === 'solvable' && result.solution!.length > 0) return result.solution![0]!;
  return legalPairs(board)[0] ?? null;
}

/** Node budget for the hold lookahead: ample for a real deadlock (a handful of
 *  free tiles and at most a few slots) and a hard stop on a pathological one. */
export const DEFAULT_MAX_HOLD_STATES = 5_000;

/**
 * Is any move available — a legal pair right now, or one that holding would
 * expose (issue #43)?
 *
 * This is the deadlock question, and the holder changes it. Parking a free tile
 * vacates its slot, which can free the tile underneath and reveal a pair, so
 * "no legal pair" is no longer "no moves left" while the holder has room. A
 * deadlock dialog that ignored this would offer Shuffle over a move the player
 * already has — and with the holder always available (PM decision 2026-08-31)
 * that is not a corner case.
 *
 * Decision 0009 narrows which holds count. The holder is one-way and a full one
 * loses the level, so the park that fills the *last* slot is not an escape from
 * a deadlock — it is a different way to lose. The search therefore stops one
 * slot short: it only takes a hold that leaves a vacancy behind it. A position
 * whose only "move" is that final park is stuck, and the dialog is right to
 * offer Shuffle rather than a move that ends the level.
 *
 * Only holds are searched. Unholding is not a player move any more, and it
 * never could expose what a hold could not, so nothing is lost by that. States
 * are keyed by the set of held tiles, and running out of budget answers false —
 * a conservative "treat it as stuck", never a phantom move. The probe is a
 * private copy (and `unhold` on it is backtracking, not a move), so the
 * caller's board is untouched whatever happens.
 */
export function hasPlayableMove(board: Board, options: { maxStates?: number } = {}): boolean {
  if (legalPairs(board).length > 0) return true;
  const probe = new Board(board.allTiles(), {
    holder: board.holderSlots(),
    holderCapacity: board.holderCapacity,
  });
  let budget = options.maxStates ?? DEFAULT_MAX_HOLD_STATES;
  const seen = new Set<string>();
  const search = (): boolean => {
    // Fewer than two vacancies: any hold from here fills the holder, which
    // ends the level (decision 0009). Not a way out.
    if (probe.holderVacancies() < 2) return false;
    for (const id of probe.freeTileIds()) {
      if (budget-- <= 0) return false;
      probe.hold(id);
      const key = probe.heldTileIds().join(',');
      const live = seen.has(key) ? false : legalPairs(probe).length > 0 || search();
      seen.add(key);
      probe.unhold(id);
      if (live) return true;
    }
    return false;
  };
  return search();
}
