// Shuffle booster primitive (spec §5, issue #10).
//
// Re-randomizes the faces of the tiles still *on the board* in place — a
// permutation of their face multiset, so slot occupancy, removed tiles, and
// per-face counts are all preserved — and the result is solvable by
// construction: the new faces are dealt the way the generator deals a level,
// by taking the position apart pair by pair from the tiles that are free and
// naming each pair as it goes (issue #213). The original shuffle drew random
// permutations and kept the first the solver accepted; on the dense layouts of
// decision 0036 a random permutation is solvable well under one time in ten,
// so a shuffle burned its whole attempt budget — a minute of solver time — and
// then refused. Reverse construction never needs the solver.
//
// Held tiles (issue #43) keep their faces: a tile the player parked is on
// screen in the holder, and swapping its face under them would read as the
// game taking their pick away. Each held face is instead dealt to exactly one
// board tile — its partner — which the construction takes off the board on its
// own, the way the player will (a held tile is matchable at any time, so its
// partner only has to become free). Every other board face is dealt in pairs.
// Per-face counts across board+holder are therefore untouched and the parity
// the solver checks still holds.

import { Board } from './board.js';
import type { Tile } from './board.js';
import { mulberry32 } from './rng.js';

/** Construction attempts before a shuffle gives up. A construction dead-ends
 *  only when the tiles left cannot come off in pairs (one free tile and no
 *  held partner to take it), which a re-drawn order almost always avoids; the
 *  cap is for geometry no order can save, such as a pair stacked on itself. */
export const MAX_SHUFFLE_ATTEMPTS = 1000;

/** The present tiles, ascending by id — the order faces are assigned in. */
function presentSorted(board: Board): Tile[] {
  return [...board.presentTiles()].sort((a, b) => a.id - b.id);
}

function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

/** What has to be dealt: one single per held tile (its board partner) and the
 *  rest of the board's faces in pairs. Throws when the board cannot pair off
 *  at all — a held face with no board copy, or a face with an odd board count
 *  once the held partners are taken out — since no assignment could fix that. */
function dealList(board: Board, present: readonly Tile[]): { singles: string[]; pairs: string[] } {
  const counts = new Map<string, number>();
  for (const t of present) counts.set(t.face, (counts.get(t.face) ?? 0) + 1);
  const singles: string[] = [];
  for (const id of board.heldTileIds()) {
    const face = board.get(id).face;
    const left = counts.get(face) ?? 0;
    if (left === 0) throw new Error(`no solvable shuffle: held ${face} has no partner on the board`);
    counts.set(face, left - 1);
    singles.push(face);
  }
  const pairs: string[] = [];
  for (const [face, count] of counts) {
    if (count % 2 !== 0) throw new Error(`no solvable shuffle: odd count of ${face} on the board`);
    for (let i = 0; i < count / 2; i++) pairs.push(face);
  }
  return { singles, pairs };
}

/**
 * One construction pass: deal `singles` and `pairs` onto `present` in a random
 * order by repeatedly taking free tiles off a scratch copy of the board. The
 * removal order is, by construction, a winning line for the faces it names.
 * Returns the face per present index, or null on a dead end (fewer free tiles
 * than the next item needs and nothing else left to deal). Always consumes the
 * same rng draws for the same inputs, dead end or not, so an attempt index
 * names the result exactly.
 */
function construct(
  board: Board,
  present: readonly Tile[],
  singles: readonly string[],
  pairs: readonly string[],
  rng: () => number,
): string[] | null {
  const items: Array<{ face: string; size: 1 | 2 }> = [
    ...singles.map((face) => ({ face, size: 1 as const })),
    ...pairs.map((face) => ({ face, size: 2 as const })),
  ];
  shuffleInPlace(items, rng);

  const scratch = new Board(board.allTiles(), { holder: board.holderSlots() });
  const indexOf = new Map(present.map((t, i) => [t.id, i]));
  const faces = new Array<string>(present.length).fill('');
  const take = (free: number[]): number => {
    const id = free.splice(Math.floor(rng() * free.length), 1)[0]!;
    scratch.remove(id);
    return indexOf.get(id)!;
  };

  while (items.length > 0) {
    const free = scratch.freeTileIds();
    if (free.length === 0) return null;
    // The drawn order stands while two tiles are free. With one lone free
    // tile only a single can go, so the next single jumps the queue; no single
    // left is the dead end.
    const next = free.length >= 2 ? 0 : items.findIndex((item) => item.size === 1);
    if (next === -1) return null;
    const [item] = items.splice(next, 1);
    faces[take(free)] = item!.face;
    if (item!.size === 2) faces[take(free)] = item!.face;
  }
  return faces;
}

/**
 * Shuffle the present tiles' faces into a position that is solvable by
 * construction, and apply it to the board. Returns the index of the
 * construction attempt that completed (issue #187 records it so a replay can
 * reproduce the shuffle with `applyShuffle`), or null with the board untouched
 * when nothing was present to shuffle. Throws — leaving the board unchanged —
 * if no attempt completes (e.g. a geometry no face assignment can save, such
 * as a matching pair stacked on top of itself).
 */
export function shuffleBoard(board: Board, seed: number): number | null {
  const present = presentSorted(board);
  if (present.length === 0) return null;

  const { singles, pairs } = dealList(board, present);
  const rng = mulberry32(seed);
  for (let attempt = 0; attempt < MAX_SHUFFLE_ATTEMPTS; attempt++) {
    const faces = construct(board, present, singles, pairs, rng);
    if (faces !== null) {
      present.forEach((t, i) => board.setFace(t.id, faces[i]!));
      return attempt;
    }
  }
  throw new Error(`no solvable shuffle within ${MAX_SHUFFLE_ATTEMPTS} attempts (seed ${seed})`);
}

/**
 * Re-apply a shuffle that already happened (issue #187): the face assignment
 * `shuffleBoard(board, seed)` reached on its `attempt`-th construction. Same
 * board state and the same (seed, attempt) give the same faces — every
 * attempt before it is re-drawn too, so the rng stream lines up — which is
 * what lets a replay reproduce a shuffled run in microseconds. Throws
 * RangeError on an attempt outside what `shuffleBoard` can produce, on an
 * attempt whose construction does not complete, or when nothing is present to
 * shuffle — none of which is a record the game writes.
 */
export function applyShuffle(board: Board, seed: number, attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_SHUFFLE_ATTEMPTS) {
    throw new RangeError(`no shuffle attempt ${attempt}`);
  }
  const present = presentSorted(board);
  if (present.length === 0) throw new RangeError('nothing on the board to shuffle');
  let dealt: { singles: string[]; pairs: string[] };
  try {
    dealt = dealList(board, present);
  } catch (error) {
    throw new RangeError((error as Error).message);
  }
  const rng = mulberry32(seed);
  let faces: string[] | null = null;
  for (let i = 0; i <= attempt; i++) faces = construct(board, present, dealt.singles, dealt.pairs, rng);
  if (faces === null) throw new RangeError(`shuffle attempt ${attempt} does not complete on this board`);
  present.forEach((t, i) => board.setFace(t.id, faces![i]!));
}
