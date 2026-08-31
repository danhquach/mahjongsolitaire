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
// already round-trips `allTiles()`), so the two together restore a game
// hash-identically — including its remaining undo depth.

import type { Board, TileId } from './board.js';
import { canMatch, matchPair } from './match.js';
import { hashString } from './rng.js';
import { ScoreKeeper } from './scoring.js';
import type { MatchScore, ScoreSnapshot } from './scoring.js';

export interface MoveRecord {
  readonly a: TileId;
  readonly b: TileId;
  readonly atMs: number;
  readonly prevSelection: TileId | null;
  readonly prevScores: ScoreSnapshot;
}

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

  /** Select a free tile (tap 1 of a pair attempt). */
  select(id: TileId): void {
    if (!this.board.isFree(id)) throw new RangeError(`tile ${id} is not free`);
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
    const record: MoveRecord = {
      a,
      b,
      atMs: nowMs,
      prevSelection: this.selected,
      prevScores: this.scores.snapshot(),
    };
    const score = this.scores.recordMatch(nowMs); // throws on non-monotonic time
    matchPair(this.board, a, b);
    this.stack.push(record);
    this.selected = null;
    return score;
  }

  /** Undo the last move: restore the pair, the score state, and the selection
   *  as of just before that move. Returns false on an empty stack. */
  undo(): boolean {
    const record = this.stack.pop();
    if (!record) return false;
    this.board.restore(record.a);
    this.board.restore(record.b);
    this.scores.restore(record.prevScores);
    this.selected = record.prevSelection;
    return true;
  }

  /** All moves played so far, oldest first (spec §9 replay order). */
  moves(): ReadonlyArray<readonly [TileId, TileId]> {
    return this.stack.map((m) => [m.a, m.b] as const);
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
    if (state.selection !== null && !this.board.isFree(state.selection)) {
      throw new RangeError(`restored selection ${state.selection} is not a free tile`);
    }
    this.stack.length = 0;
    this.stack.push(...state.moves);
    this.selected = state.selection;
    this.scores.restore(state.scores);
  }

  /**
   * Deterministic hash of the full tracked state: every tile's face and
   * removed flag (ascending id), the selection, and the score state.
   */
  stateHash(): number {
    const tiles = [...this.board.allTiles()].sort((x, y) => x.id - y.id);
    const s = this.scores.snapshot();
    const parts = tiles.map((t) => `${t.id}:${t.face}:${t.removed ? 1 : 0}`);
    parts.push(`sel:${this.selected}`, `score:${s.score}:${s.streak}:${s.lastMatchMs}`);
    return hashString(parts.join('|'));
  }
}
