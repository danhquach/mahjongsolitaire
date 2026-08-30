// Move stack: selection, match moves, unlimited-depth undo (spec §5, issue #10).
//
// Wraps a Board + ScoreKeeper and tracks the player's selection. Every played
// move records the pre-move selection and score state, so undo restores both
// exactly (spec §5: "must restore selection state and score"). Deterministic:
// timestamps are inputs, and stateHash() is a pure function of the tracked
// state — the §11.1 acceptance property `apply(moves) → undo(n) → apply(same n)`
// yields an identical hash.

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
