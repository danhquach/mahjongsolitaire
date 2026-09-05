// Move stack: selection, match moves, and the Undo return (spec §5, issue #10).
//
// Wraps a Board + ScoreKeeper and tracks the player's selection. Every played
// move is recorded — the record is the level's history (spec §9 replay order,
// holdsUsed) and the save format's undo chain. Deterministic: timestamps are
// inputs, and stateHash() is a pure function of the tracked state.
//
// Issue #14 adds `state` / `restoreState`: the stack's own contribution to the
// spec §9 save state. Board occupancy travels separately (Board's constructor
// already round-trips `allTiles()` plus `holderSlots()`), so the two together
// restore a game hash-identically — including which tiles are parked, in what
// order, so Undo keeps returning them newest-first after a resume.
//
// Issue #43 makes the holder part of the same contract: a hold is a recorded
// move too. A match records which holder slot each of its tiles came out of
// (null for one taken off the board).
//
// Issue #63 made the holder one-way (decision 0009): a parked tile can only
// leave by being matched, so `unhold` is no longer a move and `MoveRecord` is
// a pair or a hold.
//
// Issue #100 reworks Undo to the Vita Mahjong behavior: `undo()` no longer
// rewinds arbitrary moves. It returns the most recently parked tile still in
// the holder to its own layout slot — matched pairs are permanent, and no
// amount of Undo brings a matched tile back. Score and later matches are
// untouched.
//
// Issue #187 makes the stack a complete replay log, because the leaderboard
// now verifies a run by replaying it (decision 0030). Two things had to
// change for `[deal, moves]` to reproduce a game:
//
//   * Shuffle is a recorded move carrying its seed. `shuffleBoard` is
//     deterministic per (board, seed), so the record is all a replay needs to
//     land on the same faces — but only if it is applied at the same point in
//     the sequence, which is why it lives in the stack rather than in a count.
//   * Undo *appends* a `return` record instead of deleting the hold. A hold
//     frees whatever it covered; if that tile was matched before the undo,
//     a history with the hold spliced out plays that match against a still-
//     covered tile and fails. The return says when the tile went back.
//     `holdsUsed` nets the two, so it still rolls back the way #100 meant.

import type { Board, TileId } from './board.js';
import { canMatch, matchPair } from './match.js';
import { hashString } from './rng.js';
import { ScoreKeeper } from './scoring.js';
import type { MatchScore, ScoreSnapshot } from './scoring.js';
import { shuffleBoard } from './shuffle.js';

/** What every move records. `prevSelection` / `prevScores` are no longer
 *  replayed by `undo` (issue #100: matches are permanent, and a return leaves
 *  the score alone) but stay in the record: the save format's undo-chain
 *  validation reads them, and the history is the audit trail either way. */
export interface MoveBase {
  readonly atMs: number;
  readonly prevSelection: TileId | null;
  readonly prevScores: ScoreSnapshot;
}

/** A played pair. `heldA` / `heldB` name the holder slot each tile was matched
 *  out of, or null for a tile that was on the board (issue #43). */
export interface MatchMove extends MoveBase {
  readonly kind: 'match';
  readonly a: TileId;
  readonly b: TileId;
  readonly heldA: number | null;
  readonly heldB: number | null;
}

/** A free tile parked in the holder (issue #43). */
export interface HoldMove extends MoveBase {
  readonly kind: 'hold';
  readonly tile: TileId;
  readonly slotIndex: number;
}

/** A held tile put back on its own layout slot by Undo (issues #100, #187).
 *  Records the slot it left so a replay can check the holder agrees. */
export interface ReturnMove extends MoveBase {
  readonly kind: 'return';
  readonly tile: TileId;
  readonly slotIndex: number;
}

/** The Shuffle booster, with the seed that re-faced the board and the
 *  construction attempt that completed (issue #187). Occupancy is untouched;
 *  only faces change, and `applyShuffle(board, seed, attempt)` reproduces them
 *  at this point in the sequence. */
export interface ShuffleMove extends MoveBase {
  readonly kind: 'shuffle';
  readonly seed: number;
  readonly attempt: number;
}

export type MoveRecord = MatchMove | HoldMove | ReturnMove | ShuffleMove;

/**
 * A MoveStack's serializable state (spec §9 save/resume, issue #14). Pair it
 * with the tiles from `Board.allTiles()` — faces and removed flags included —
 * to reconstruct a game exactly.
 */
export interface MoveStackState {
  /** Undo records, oldest first. */
  readonly moves: readonly MoveRecord[];
  readonly selection: TileId | null;
  readonly scores: ScoreSnapshot;
}

export class MoveStack {
  private readonly stack: MoveRecord[] = [];
  private selected: TileId | null = null;

  constructor(
    private readonly board: Board,
    private readonly scores: ScoreKeeper = new ScoreKeeper(),
  ) {}

  get selection(): TileId | null {
    return this.selected;
  }

  get depth(): number {
    return this.stack.length;
  }

  get score(): number {
    return this.scores.total;
  }

  /** Holds taken on this level (issue #43) — and since decision 0009 the
   *  measure of how close the player came to losing. Vita Mahjong reports a per-level
   *  holder average, so the count is tracked even though nothing deducts for it
   *  (PM decision 2026-08-31: no score penalty in v1). Derived from the stack,
   *  so undo rolls it back for free and a resumed game carries it: a returned
   *  hold (issue #187 keeps the record) counts as never taken. */
  get holdsUsed(): number {
    return this.stack.reduce(
      (n, m) => n + (m.kind === 'hold' ? 1 : m.kind === 'return' ? -1 : 0),
      0,
    );
  }

  /** The timestamp a caller without a clock gets: no earlier than the last
   *  recorded move, so the record stays non-decreasing (the save format
   *  checks that). Return and shuffle records never affect the score, so
   *  the only property their time has to have is that one. */
  private latestMs(): number {
    return this.stack.length === 0 ? 0 : this.stack[this.stack.length - 1]!.atMs;
  }

  /** Select a matchable tile — free on the board, or held (tap 1 of a pair
   *  attempt). */
  select(id: TileId): void {
    if (!this.board.isMatchable(id)) throw new RangeError(`tile ${id} is not matchable`);
    this.selected = id;
  }

  clearSelection(): void {
    this.selected = null;
  }

  /**
   * Play a matching pair: remove both tiles, score the match, clear the
   * selection, and push an undo record. Throws (changing nothing) on an
   * unplayable pair — a mismatch is the caller's recordMismatch concern.
   */
  play(a: TileId, b: TileId, nowMs: number): MatchScore {
    const check = canMatch(this.board, a, b);
    if (!check.ok) throw new RangeError(`cannot play tiles ${a}, ${b}: ${check.reason}`);
    const record: MatchMove = {
      kind: 'match',
      a,
      b,
      atMs: nowMs,
      prevSelection: this.selected,
      prevScores: this.scores.snapshot(),
      heldA: this.holderIndexOf(a),
      heldB: this.holderIndexOf(b),
    };
    const score = this.scores.recordMatch(nowMs); // throws on non-monotonic time
    matchPair(this.board, a, b);
    this.stack.push(record);
    this.selected = null;
    return score;
  }

  /**
   * Park a free tile in the holder (issue #43 rule 2): it leaves the board —
   * freeing whatever it covered — and stays matchable from the holder. One
   * way, since decision 0009: the only way back out of the slot is a match.
   *
   * Returns the slot index, or null with nothing changed when the holder is
   * already full. That is a defensive answer rather than a rule: the park that
   * fills the last slot loses the level, so a caller that gates on the game's
   * status never reaches it. Throws on a tile that is not free (issue #43
   * rule 2 — blocked tiles cannot be held).
   */
  hold(id: TileId, nowMs: number): number | null {
    if (this.board.holderFull()) return null;
    const prevSelection = this.selected;
    const prevScores = this.scores.snapshot();
    const slotIndex = this.board.hold(id);
    this.stack.push({ kind: 'hold', tile: id, slotIndex, atMs: nowMs, prevSelection, prevScores });
    // The tile is off the board; the player's attention goes back to it.
    this.selected = null;
    return slotIndex;
  }

  private holderIndexOf(id: TileId): number | null {
    const index = this.board.holderSlots().indexOf(id);
    return index === -1 ? null : index;
  }

  /** Parked tiles the Undo booster can still return (issue #100): tiles in
   *  the holder right now. Every held tile has exactly one live hold record —
   *  holds are the only way in, and `undo` removes the record on the way out —
   *  so this is also how many times Undo can fire. */
  get undoDepth(): number {
    return this.stack.reduce(
      (n, m) => n + (m.kind === 'hold' && this.board.isHeld(m.tile) ? 1 : 0),
      0,
    );
  }

  /**
   * Undo (issue #100, Vita Mahjong behavior): return the most recently parked
   * tile still in the holder to its own layout slot, re-covering whatever it
   * had freed. Matched pairs are permanent — a hold whose tile was later
   * matched out of the holder is skipped like any other matched tile. Score,
   * combo ladder and later matches are untouched. Returns the undone hold
   * record, or null when the holder holds nothing to return (no charge).
   *
   * The hold record stays and a `return` record is appended (issue #187): the
   * history has to say when the tile went back, or a match made while it was
   * out cannot be replayed. `nowMs` is the game clock; without one the return
   * is stamped at the last recorded move.
   */
  undo(nowMs: number = this.latestMs()): HoldMove | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const record = this.stack[i]!;
      if (record.kind !== 'hold' || !this.board.isHeld(record.tile)) continue;
      const slotIndex = this.board.holderSlots().indexOf(record.tile);
      this.stack.push({
        kind: 'return',
        tile: record.tile,
        slotIndex,
        atMs: nowMs,
        prevSelection: this.selected,
        prevScores: this.scores.snapshot(),
      });
      this.board.unhold(record.tile);
      // The returned tile re-covers what parking it freed — possibly the
      // selected tile — so the selection does not survive the return.
      this.selected = null;
      return record;
    }
    return null;
  }

  /**
   * Shuffle booster (spec §5, issue #187): re-face the tiles on the board
   * through `shuffleBoard` and record the seed as a move. False — nothing
   * changed, nothing recorded — when the board is clear or no solvable face
   * assignment exists, so an impossible shuffle costs the player nothing.
   * Clears the selection: the face under it just changed.
   */
  shuffle(seed: number, nowMs: number = this.latestMs()): boolean {
    const prevSelection = this.selected;
    const prevScores = this.scores.snapshot();
    let attempt: number | null;
    try {
      attempt = shuffleBoard(this.board, seed);
    } catch {
      return false;
    }
    if (attempt === null) return false;
    this.stack.push({ kind: 'shuffle', seed, attempt, atMs: nowMs, prevSelection, prevScores });
    this.selected = null;
    return true;
  }

  /** Pairs played so far, oldest first (spec §9 replay order). Holds, returns
   *  and shuffles are moves but not pairs, so they are not listed —
   *  `state.moves` is the full record. */
  moves(): ReadonlyArray<readonly [TileId, TileId]> {
    return this.stack
      .filter((m): m is MatchMove => m.kind === 'match')
      .map((m) => [m.a, m.b] as const);
  }

  /** This stack's serializable state (issue #14). */
  get state(): MoveStackState {
    return { moves: [...this.stack], selection: this.selected, scores: this.scores.snapshot() };
  }

  /**
   * Adopt a previously captured state, score ladder and undo depth included.
   * The wrapped Board must *already* hold the matching occupancy — callers
   * rebuild it from the saved tiles first — because the selection is checked
   * against the live board: a state whose selected tile is not free there is
   * rejected rather than restored into an unplayable game.
   */
  restoreState(state: MoveStackState): void {
    if (state.selection !== null && !this.board.isMatchable(state.selection)) {
      throw new RangeError(`restored selection ${state.selection} is not a matchable tile`);
    }
    this.stack.length = 0;
    this.stack.push(...state.moves);
    this.selected = state.selection;
    this.scores.restore(state.scores);
  }

  /**
   * Deterministic hash of the full tracked state: every tile's face and
   * removed flag (ascending id), the holder slot by slot, the selection, and
   * the score state.
   *
   * The holder is in here by slot order, not as a set: two games with the same
   * tiles parked in different slots are different states — undo has to put each
   * tile back where it was — so the §11.1 replay property has to see them apart.
   */
  stateHash(): number {
    const tiles = [...this.board.allTiles()].sort((x, y) => x.id - y.id);
    const s = this.scores.snapshot();
    const parts = tiles.map((t) => `${t.id}:${t.face}:${t.removed ? 1 : 0}`);
    parts.push(
      `hold:${this.board.holderSlots().join(',')}`,
      `sel:${this.selected}`,
      `score:${s.score}:${s.streak}:${s.lastMatchMs}`,
    );
    return hashString(parts.join('|'));
  }
}
