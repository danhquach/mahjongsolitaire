// Move stack: selection, match moves, unlimited-depth undo (spec §5, issue #10).
//
// Wraps a Board + ScoreKeeper and tracks the player's selection. Every played
// move records the pre-move selection and score state, so undo restores both
// exactly (spec §5: "must restore selection state and score"). Deterministic:
// timestamps are inputs, and stateHash() is a pure function of the tracked
// state — the §11.1 acceptance property `apply(moves) → undo(n) → apply(same n)`
// yields an identical hash.
//
// Issue #14 adds `state` / `restoreState`: the stack's own contribution to the
// spec §9 save state. Board occupancy travels separately (Board's constructor
// already round-trips `allTiles()` plus `holderSlots()`), so the two together
// restore a game hash-identically — including its remaining undo depth.
//
// Issue #43 makes the holder part of the same contract. A move is no longer
// always a pair: a hold is a recorded move too, so undo walks back through
// holds in the order they happened and the holder's contents come back exactly.
// A match records which holder slot each of its tiles came out of (null for one
// taken off the board), because that is the only thing `restore` cannot
// re-derive — the tile has to go back where the player put it.
//
// Issue #63 removes the other direction. The holder is one-way (decision 0009):
// a parked tile can only leave by being matched, so `unhold` is no longer a
// move and `MoveRecord` is a pair or a hold. `Board.unhold` survives as the
// mechanism this file rewinds a hold with — undoing a hold is not the player
// taking a tile back, it is the move never having happened.

import type { Board, TileId } from './board.js';
import { canMatch, matchPair } from './match.js';
import { hashString } from './rng.js';
import { ScoreKeeper } from './scoring.js';
import type { MatchScore, ScoreSnapshot } from './scoring.js';

/** What every move records so undo can rewind the state around it. */
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

export type MoveRecord = MatchMove | HoldMove;

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
   *  so undo rolls it back for free and a resumed game carries it. */
  get holdsUsed(): number {
    return this.stack.reduce((n, m) => n + (m.kind === 'hold' ? 1 : 0), 0);
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

  /**
   * Undo the last move — a match or a hold — restoring the board, the holder,
   * the score state and the selection as of just before it. Returns the undone
   * record, or null on an empty stack.
   */
  undo(): MoveRecord | null {
    const record = this.stack.pop();
    if (!record) return null;
    switch (record.kind) {
      case 'match':
        this.board.restore(record.a);
        this.board.restore(record.b);
        // A tile matched out of the holder goes back to the slot it was in.
        // `restore` is the only way back onto the lattice, so it lands on the
        // board for an instant first — its own slot, which nothing else can
        // ever occupy, so the round trip is safe (see Board.unhold).
        if (record.heldA !== null) this.board.holdAt(record.a, record.heldA);
        if (record.heldB !== null) this.board.holdAt(record.b, record.heldB);
        break;
      case 'hold':
        // Not the player taking a tile back (decision 0009 forbids that) — the
        // hold never happened, so the tile is where it was before it.
        this.board.unhold(record.tile);
        break;
    }
    this.scores.restore(record.prevScores);
    this.selected = record.prevSelection;
    return record;
  }

  /** Pairs played so far, oldest first (spec §9 replay order). Holds are moves
   *  but not pairs, so they are not listed — `state.moves` is the full record. */
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
