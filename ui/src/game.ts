// Vertical-slice game controller (issue #11): tap semantics on top of the
// core engine. Pure logic — no rendering, no timers — so tap flows are
// unit-testable headlessly. Spec §7: tap select/deselect only; a mismatch
// never costs points (§6) but breaks the combo.

import { Board, MoveStack, ScoreKeeper, canMatch, legalPairs } from '@mahjongsolitaire/core';
import type { GeneratedLevel, MatchScore, TileId } from '@mahjongsolitaire/core';
import type { Hit, HitCandidate } from './hit-test.js';

export type GameStatus = 'playing' | 'won' | 'stuck';

export type TapOutcome =
  | { readonly kind: 'selected'; readonly id: TileId }
  | { readonly kind: 'deselected'; readonly id: TileId }
  | { readonly kind: 'matched'; readonly a: TileId; readonly b: TileId; readonly score: MatchScore }
  | { readonly kind: 'mismatch'; readonly a: TileId; readonly b: TileId }
  | { readonly kind: 'blocked'; readonly id: TileId }
  | { readonly kind: 'selection-cleared' }
  | { readonly kind: 'none' };

export class Game {
  readonly board: Board;
  private readonly stack: MoveStack;
  private readonly scores: ScoreKeeper;

  constructor(readonly level: GeneratedLevel) {
    this.board = new Board(level.tiles);
    this.scores = new ScoreKeeper();
    this.stack = new MoveStack(this.board, this.scores);
  }

  get selection(): TileId | null {
    return this.stack.selection;
  }

  get score(): number {
    return this.stack.score;
  }

  get tilesLeft(): number {
    return this.board.presentTiles().length;
  }

  status(): GameStatus {
    if (this.tilesLeft === 0) return 'won';
    if (legalPairs(this.board).length === 0) return 'stuck';
    return 'playing';
  }

  /** Present tiles with their free state, ready for hitTest. */
  hitCandidates(): HitCandidate[] {
    return this.board
      .presentTiles()
      .map((t) => ({ id: t.id, slot: t.slot, free: this.board.isFree(t.id) }));
  }

  /**
   * Apply one resolved tap. `nowMs` must be monotonic within a game (combo
   * timing + replay determinism, spec §6/§9).
   */
  tap(hit: Hit, nowMs: number): TapOutcome {
    switch (hit.kind) {
      case 'miss':
        if (this.stack.selection === null) return { kind: 'none' };
        this.stack.clearSelection();
        return { kind: 'selection-cleared' };
      case 'blocked':
        // Keep any selection — a stray tap on a buried tile shouldn't cost it.
        return { kind: 'blocked', id: hit.id };
      case 'free': {
        const selected = this.stack.selection;
        if (selected === null) {
          this.stack.select(hit.id);
          return { kind: 'selected', id: hit.id };
        }
        if (selected === hit.id) {
          this.stack.clearSelection();
          return { kind: 'deselected', id: hit.id };
        }
        if (canMatch(this.board, selected, hit.id).ok) {
          const score = this.stack.play(selected, hit.id, nowMs);
          return { kind: 'matched', a: selected, b: hit.id, score };
        }
        // Face mismatch: combo breaks (§6), selection moves to the new tile.
        this.scores.recordMismatch();
        this.stack.select(hit.id);
        return { kind: 'mismatch', a: selected, b: hit.id };
      }
    }
  }
}
