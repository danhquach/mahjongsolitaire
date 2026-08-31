// Vertical-slice game controller (issue #11): tap semantics on top of the
// core engine. Pure logic — no rendering, no timers — so tap flows are
// unit-testable headlessly. Spec §7: tap select/deselect only; a mismatch
// never costs points (§6) but breaks the combo.
//
// Issue #13 adds the three boosters on top of the same core primitives:
// `hint()` (solver-backed, cycling), `undo()` (the move stack's unlimited
// depth), and `shuffle()` (face permutation re-validated for solvability).
// Each reports whether it actually did anything; charge accounting lives in
// boosters.ts and only spends on a successful use.
//
// Issue #14 makes a game in progress round-trippable: `snapshot()` captures
// everything the deal itself does not imply (shuffled faces, removed tiles, the
// undo stack, the selection, the score ladder), and the constructor's `resume`
// argument reopens it. Storage and validation live in save.ts.
//
// Issue #43 adds the holder: four off-board slots a free tile can be parked in
// to reach what is under it. It is always available (PM decision 2026-08-31),
// so it is not a charged booster — but it *is* a move, and every core primitive
// here already accounts for it: a held tile is matchable, so `hint` and the
// stuck check see holder pairs, and `useHolder` is one control whose meaning
// follows the selection (park a board tile, or return a parked one).

import {
  Board,
  MoveStack,
  ScoreKeeper,
  canMatch,
  findHint,
  hasPlayableMove,
  legalPairs,
  shuffleBoard,
} from '@mahjongsolitaire/core';
import type {
  GeneratedLevel,
  MatchScore,
  MoveRecord,
  MoveStackState,
  Tile,
  TileId,
} from '@mahjongsolitaire/core';
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

/** A pair of tile ids the Hint booster is pointing at. */
export type HintPair = readonly [TileId, TileId];

/**
 * A game in progress, minus the deal (issue #14, spec §9). Regenerating
 * `(layoutId, seed)` reproduces the slots; this carries what play changed.
 *
 * Faces are indexed by tile id — the Shuffle booster permutes them, so they
 * cannot be re-derived from the seed once it has been used.
 */
export interface GameSnapshot {
  readonly faces: readonly string[];
  /** Ids of removed tiles, ascending. */
  readonly removed: readonly TileId[];
  /** Holder occupancy (issue #43), one entry per slot, null where empty. */
  readonly holder: readonly (TileId | null)[];
  readonly stack: MoveStackState;
}

/** What the Hold control does on the current selection (issue #43). One button
 *  covers both directions: rule 2 parks a free tile, rule 4 takes it back. */
export type HolderAction = 'hold' | 'return' | 'full' | 'none';

export type HoldOutcome =
  | { readonly kind: 'held'; readonly id: TileId; readonly slot: number }
  | { readonly kind: 'returned'; readonly id: TileId }
  /** Rule 5: a full holder refuses the move. It never ends the level. */
  | { readonly kind: 'full' }
  | { readonly kind: 'none' };

/**
 * The deal's tiles with a snapshot's faces and removed flags applied. Faces are
 * positional in ascending-id order — the same order `snapshot()` writes them —
 * so the two stay in step without assuming ids are contiguous.
 */
function applySnapshot(level: GeneratedLevel, snapshot: GameSnapshot): Tile[] {
  const tiles = [...level.tiles].sort((a, b) => a.id - b.id);
  if (snapshot.faces.length !== tiles.length) {
    throw new RangeError(
      `snapshot has ${snapshot.faces.length} faces, deal has ${tiles.length} tiles`,
    );
  }
  const removed = new Set(snapshot.removed);
  for (const id of removed) {
    if (!tiles.some((t) => t.id === id)) throw new RangeError(`snapshot removes unknown tile ${id}`);
  }
  return tiles.map((t, i) => ({ ...t, face: snapshot.faces[i]!, removed: removed.has(t.id) }));
}

export class Game {
  readonly board: Board;
  private readonly stack: MoveStack;
  private readonly scores: ScoreKeeper;
  /** Hint state, both invalidated by anything that changes the board. */
  private hintPairs: HintPair[] | null = null;
  private hintCursor = 0;

  /**
   * A fresh deal, or — with `resume` — a saved game reopened on the same deal.
   * Throws (leaving nothing half-built) if the snapshot does not fit this deal:
   * save.ts validates untrusted records before they get here, and main.ts falls
   * back to a fresh deal on anything that still slips through.
   */
  constructor(
    readonly level: GeneratedLevel,
    resume?: GameSnapshot,
  ) {
    this.board = resume
      ? new Board(applySnapshot(level, resume), { holder: resume.holder })
      : new Board(level.tiles);
    this.scores = new ScoreKeeper();
    this.stack = new MoveStack(this.board, this.scores);
    if (resume) this.stack.restoreState(resume.stack);
  }

  /** Everything about this game the deal does not imply (issue #14). */
  snapshot(): GameSnapshot {
    const tiles = [...this.board.allTiles()].sort((a, b) => a.id - b.id);
    return {
      faces: tiles.map((t) => t.face),
      removed: tiles.filter((t) => t.removed).map((t) => t.id),
      holder: this.board.holderSlots(),
      stack: this.stack.state,
    };
  }

  get selection(): TileId | null {
    return this.stack.selection;
  }

  get score(): number {
    return this.stack.score;
  }

  /** Tiles still in play — the holder's included, or parking the last pair
   *  would read as a win (issue #43). */
  get tilesLeft(): number {
    return this.board.inPlayTiles().length;
  }

  /** Holder occupancy, slot by slot (issue #43) — what the holder strip draws. */
  holderSlots(): readonly (TileId | null)[] {
    return this.board.holderSlots();
  }

  get holderFull(): boolean {
    return this.board.holderFull();
  }

  /** Holds taken on this level. Nothing deducts for them in v1; the count is
   *  kept because Vita Mahjong reports a per-level holder average and a later
   *  star rating may want it (issue #43, PM decision 2026-08-31). */
  get holdsUsed(): number {
    return this.stack.holdsUsed;
  }

  status(): GameStatus {
    if (this.tilesLeft === 0) return 'won';
    // Not `legalPairs`: with the holder always available, parking a free tile
    // can expose a pair, so a board with no pair *right now* is not
    // necessarily stuck (issue #43 — hasPlayableMove looks through holds).
    if (!hasPlayableMove(this.board)) return 'stuck';
    return 'playing';
  }

  /**
   * Deterministic hash of the whole tracked state — faces, removed flags,
   * selection, score ladder. The save/resume acceptance check (issue #14,
   * spec §11.2) compares this across a force-quit.
   */
  stateHash(): number {
    return this.stack.stateHash();
  }

  /** Moves available to the Undo booster (spec §5: unlimited depth). */
  get undoDepth(): number {
    return this.stack.depth;
  }

  /**
   * Hint booster (spec §5): the pair to highlight. The first press on a given
   * board state offers a move from a winning line (the solver's own hint);
   * repeat presses cycle the remaining legal pairs, wrapping around. Null when
   * the board has no matching free pair at all — nothing to charge for.
   */
  hint(): HintPair | null {
    if (this.hintPairs === null) this.hintPairs = this.rankedPairs();
    if (this.hintPairs.length === 0) return null;
    const pair = this.hintPairs[this.hintCursor % this.hintPairs.length]!;
    this.hintCursor++;
    return pair;
  }

  /**
   * Undo booster (spec §5): take back the last move — a match, a hold or a
   * return (issue #43) — with the board, holder, score and selection exactly as
   * they were before it. Returns the undone record, or null on an empty move
   * stack (nothing happened, nothing to charge for).
   */
  undo(): MoveRecord | null {
    const record = this.stack.undo();
    if (record === null) return null;
    this.forgetHints();
    return record;
  }

  // --- holder (issue #43) -----------------------------------------------------

  /**
   * What the Hold control would do right now. One button covers both
   * directions, because the selection already says which one the player means:
   * a free board tile is parked, a parked tile is returned.
   */
  holderAction(): HolderAction {
    const selected = this.stack.selection;
    if (selected === null) return 'none';
    if (this.board.isHeld(selected)) return 'return';
    return this.board.holderFull() ? 'full' : 'hold';
  }

  /**
   * Run the Hold control on the current selection. Nothing is charged and
   * nothing can fail destructively: a full holder and an empty selection both
   * report back and leave the game exactly as it was (issue #43 rule 5).
   */
  useHolder(nowMs: number): HoldOutcome {
    const selected = this.stack.selection;
    switch (this.holderAction()) {
      case 'hold': {
        const slot = this.stack.hold(selected!, nowMs);
        if (slot === null) return { kind: 'full' };
        this.forgetHints(); // the board changed: the cycled pairs are stale
        return { kind: 'held', id: selected!, slot };
      }
      case 'return':
        this.stack.unhold(selected!, nowMs);
        this.forgetHints();
        return { kind: 'returned', id: selected! };
      case 'full':
        return { kind: 'full' };
      case 'none':
        return { kind: 'none' };
    }
  }

  /**
   * Tap on a tile in the holder. Same semantics as a tap on a free board tile —
   * select, deselect, match — because a held tile is matchable; the holder just
   * reaches it through its own control instead of the canvas hit test.
   */
  tapHeld(id: TileId, nowMs: number): TapOutcome {
    if (!this.board.isHeld(id)) return { kind: 'none' };
    return this.tapPlayable(id, nowMs);
  }

  /**
   * Shuffle booster (spec §5): re-randomize the faces of the remaining tiles,
   * preserving slot occupancy, re-validating solvability inside the core
   * primitive. False — board untouched — when no solvable assignment exists
   * (or the board is already clear), so an impossible shuffle costs nothing.
   *
   * Not an undoable move: the move stack keeps pointing at the pairs actually
   * played, and undoing across a shuffle still restores a matching pair
   * (removed tiles keep their faces; only present tiles are permuted).
   */
  shuffle(seed: number): boolean {
    // Board tiles, not `tilesLeft`: shuffle permutes the faces of what is on
    // the board, and held tiles keep theirs (issue #43).
    if (this.board.presentTiles().length === 0) return false;
    try {
      shuffleBoard(this.board, seed);
    } catch {
      return false; // no solvable face assignment for this geometry
    }
    this.stack.clearSelection();
    this.forgetHints();
    return true;
  }

  /** Hint cycle order: the solver's move first, then every other legal pair. */
  private rankedPairs(): HintPair[] {
    const pairs = legalPairs(this.board);
    const best = findHint(this.board);
    if (best === null) return pairs;
    const key = (p: HintPair) => `${Math.min(p[0], p[1])}:${Math.max(p[0], p[1])}`;
    const bestKey = key(best);
    return [best, ...pairs.filter((p) => key(p) !== bestKey)];
  }

  private forgetHints(): void {
    this.hintPairs = null;
    this.hintCursor = 0;
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
      case 'free':
        return this.tapPlayable(hit.id, nowMs);
    }
  }

  /** Select / deselect / match on a matchable tile — free on the board, or in
   *  the holder (issue #43). Shared by both input paths. */
  private tapPlayable(id: TileId, nowMs: number): TapOutcome {
    const selected = this.stack.selection;
    if (selected === null) {
      this.stack.select(id);
      return { kind: 'selected', id };
    }
    if (selected === id) {
      this.stack.clearSelection();
      return { kind: 'deselected', id };
    }
    if (canMatch(this.board, selected, id).ok) {
      const score = this.stack.play(selected, id, nowMs);
      this.forgetHints(); // the board changed: the cycled pairs are stale
      return { kind: 'matched', a: selected, b: id, score };
    }
    // Face mismatch: combo breaks (§6), selection moves to the new tile.
    this.scores.recordMismatch();
    this.stack.select(id);
    return { kind: 'mismatch', a: selected, b: id };
  }
}
