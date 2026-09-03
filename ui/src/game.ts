// Vertical-slice game controller (issue #11): tap semantics on top of the
// core engine. Pure logic — no rendering, no timers — so tap flows are
// unit-testable headlessly. Since issue #93 one tap is one move (spec §3.3):
// there is no selection and no mismatch, and the combo breaks only by
// timeout (§6).
//
// Issue #13 adds the three boosters on top of the same core primitives:
// `hint()` (solver-backed, cycling), `undo()` (since issue #100: returns the
// newest parked tile from the holder — matches are permanent), and `shuffle()`
// (face permutation re-validated for solvability).
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
// stuck check see holder pairs.
//
// Issue #63 makes the holder one-way (decision 0009, superseding 0008): a
// parked tile can only leave by being matched, and filling the fourth slot ends
// the level. That is a third terminal status — `lost` — and it is why `status()`
// asks about the holder before it asks whether a move is left.
//
// Issue #93 reworks the whole gesture around the holder (decision 0013,
// superseding issue #62's select-then-park): *every* tap on a revealed free
// tile sends it to the holder, and pairs assemble and clear there. Selection
// stops being a concept for matching — there is no select, no deselect, and no
// mismatch. One tap is the whole move:
//   * the tapped tile's face matches a held tile → the pair clears (the tile
//     never occupies a slot, so completing a pair can never trip the full-
//     holder loss in passing);
//   * otherwise the tile is parked, and the park that fills the fourth slot
//     still loses (decision 0009, unchanged).
//
// Issue #64 adds face-down tiles (decision 0010). Concealment changes what the
// player *knows*, never what is legally matchable: the set of concealed ids is
// fixed at deal time (core's concealedTileIds — deterministic, so a resume
// re-derives it and nothing new is saved), and everything the solver, hint and
// deadlock check read is untouched. The controller owns the reveal state: one
// peek at a time.
//
// Issue #165 (decision 0025, following the reference game) sets the tap rule:
// the holder IS consulted for a hidden face. A face-down free tile whose real
// face matches a held tile clears against it on that very tap — the memory
// payoff — and only otherwise does the tap peek: reveal in place, move
// nothing, cost nothing. A peek is passive: a tap on any other free tile is an
// ordinary move (park, or clear against the holder) and drops the peek; the
// peeked tile's own second tap sends it to the holder like any visible tile.
// Undo leaves the peek alone — only a change to the peeked tile itself (it
// left the board, Shuffle re-faced it) drops it. This supersedes decision
// 0018's "matching against the peek" mode (issue #124) and amends decision
// 0010 point 1.
//
// Issue #169 narrows the "peek is passive" half of that rule (decision 0025
// point 2, amended): a tap on a free tile whose real face matches the tile
// currently peeked — not merely a held tile — also clears, rather than
// parking the tap and dropping the peek. Precedence when both could apply:
// rule 1 (a held partner) wins, exactly as it already did over a peek — see
// tapBoard. The clear still goes through the holder (decision 0013): the
// peeked tile is given a real, if momentary, slot (playPeekMatch) and then
// cleared through the ordinary held-partner path, so it is scored, animated
// and undone exactly like any other holder match, and the momentary slot
// never survives long enough for status() to see it as a park (decision
// 0009's full-holder loss). A non-matching tap keeps the passive rule.

import {
  Board,
  MoveStack,
  ScoreKeeper,
  CONCEAL_RATIO,
  assessDifficulty,
  concealedTileIds,
  findHint,
  hasPlayableMove,
  shuffleBoard,
  takeablePairs,
} from '@mahjongsolitaire/core';
import type {
  GeneratedLevel,
  MatchScore,
  HoldMove,
  MoveStackState,
  Tile,
  TileId,
} from '@mahjongsolitaire/core';
import type { Hit, HitCandidate } from './hit-test.js';
import { paintOrder } from './geometry.js';

/** `stuck` is the deadlock spec §4 never hard-fails — Shuffle and Undo are
 *  offered against it. `lost` is the one that does hard-fail: a full holder,
 *  which decision 0009 made final. */
export type GameStatus = 'playing' | 'won' | 'stuck' | 'lost';

export type TapOutcome =
  /** The tapped board tile paired with `a` — always a held tile (issue #93:
   *  every pair resolves in the holder). `b` is the tile just tapped. `slot`
   *  is the holder slot `a` matched out of, at the moment of the match — read
   *  this instead of diffing the holder before/after the tap, because issue
   *  #169's peek-match gives `a` that slot in the same tap that clears it, so
   *  it never shows up in a "before" snapshot. `revealed` (issue #165): `b`
   *  was face-down when tapped — the flight shows the flip; the board never
   *  did. */
  | {
      readonly kind: 'matched';
      readonly a: TileId;
      readonly b: TileId;
      readonly slot: number;
      readonly score: MatchScore;
      readonly revealed?: true;
    }
  | { readonly kind: 'blocked'; readonly id: TileId }
  /** Issue #93: the tapped free tile went to the holder in one tap. */
  | { readonly kind: 'held'; readonly id: TileId; readonly slot: number }
  /** …and the same tap with every slot taken. Nothing changed: unreachable in
   *  play — a full holder is already a lost level (decision 0009) and the input
   *  layer gates on `status()` — but the controller is pure, so it answers. */
  | { readonly kind: 'holder-full'; readonly id: TileId }
  /** Issue #64: a tap on a face-down free tile peeks at it — reveals the face
   *  in place, moves nothing, costs nothing. Only ever one peek at a time. */
  | { readonly kind: 'peeked'; readonly id: TileId }
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
  // The Shuffle booster only permutes the deal's own faces, so every snapshot
  // face must be one the deal contains. A face it does not — a save written
  // before the tile set changed (issue #75 dropped `flower-*`) — makes the
  // whole save untrustworthy, and reopen() turns this throw into a fresh deal.
  const vocabulary = new Set(tiles.map((t) => t.face));
  for (const face of snapshot.faces) {
    if (!vocabulary.has(face)) throw new RangeError(`snapshot face ${face} is not in this deal`);
  }
  return tiles.map((t, i) => ({ ...t, face: snapshot.faces[i]!, removed: removed.has(t.id) }));
}

/** Up to `limit` near-pairs for the deadlock's amber pulse (issue #122): pairs
 *  of same-face tiles present on the board where *neither* tile is free —
 *  Shuffle or Undo is what would open one of them up, which is the hint the
 *  pulse gives. Deliberately not `legalPairs`/`takeablePairs` (those want a
 *  pair the player can act on *now*; this wants the opposite — pairs blocked
 *  right now) and never touches `hint()` or its cursor, so it costs no Hint
 *  charge and does not disturb hint cycling. Concealed tiles are grouped by
 *  their real face (`board.get(id).face`), not their hidden appearance: the
 *  pulse is a hint about board structure, not about what is currently
 *  visible. Same-face tiles are paired off consecutively in paint order
 *  (roughly top-to-bottom, back-to-front) rather than combinatorially, so a
 *  face with four blocked copies pulses two independent pairs instead of
 *  highlighting one tile in three overlapping ones; the pair list itself is
 *  then paint-ordered and capped at `limit`, so a given stuck board always
 *  pulses the same pairs in the same order. */
export function nearPairs(
  board: Board,
  limit = 3,
): ReadonlyArray<readonly [TileId, TileId]> {
  const byFace = new Map<string, Tile[]>();
  for (const tile of board.presentTiles()) {
    if (board.isFree(tile.id)) continue;
    let tiles = byFace.get(tile.face);
    if (!tiles) byFace.set(tile.face, (tiles = []));
    tiles.push(tile);
  }
  const pairs: Array<readonly [Tile, Tile]> = [];
  for (const tiles of byFace.values()) {
    const ordered = [...tiles].sort((a, b) => paintOrder(a.slot, b.slot));
    for (let i = 0; i + 1 < ordered.length; i += 2) {
      pairs.push([ordered[i]!, ordered[i + 1]!]);
    }
  }
  pairs.sort((a, b) => paintOrder(a[0].slot, b[0].slot) || paintOrder(a[1].slot, b[1].slot));
  return pairs.slice(0, limit).map(([a, b]) => [a.id, b.id] as const);
}

export class Game {
  readonly board: Board;
  private readonly stack: MoveStack;
  private readonly scores: ScoreKeeper;
  /** Hint state, both invalidated by anything that changes the board. */
  private hintPairs: HintPair[] | null = null;
  private hintCursor = 0;
  /** Tiles dealt face-down (issue #64). Fixed for the whole level: matching a
   *  concealed tile removes it, but nothing ever leaves this set — a parked
   *  tile Undo returns comes back concealed, which is what "survives undo"
   *  means (matches themselves are permanent since issue #100). */
  private readonly concealed: ReadonlySet<TileId>;
  /** The one peek (issue #64, decision 0010). Everything else about face
   *  visibility is computed — see isFaceHidden — so re-concealing on undo,
   *  shuffle, match and park mostly falls out for free. */
  private peekedId: TileId | null = null;

  /**
   * A fresh deal, or — with `resume` — a saved game reopened on the same deal.
   * Throws (leaving nothing half-built) if the snapshot does not fit this deal:
   * save.ts validates untrusted records before they get here, and main.ts falls
   * back to a fresh deal on anything that still slips through.
   *
   * `concealed` (issue #64, tests mostly) overrides which tiles are dealt
   * face-down; by default they are derived from the deal and its difficulty
   * bucket. Derived, not saved: a resumed game re-derives the same set, so a
   * reload is never a free reveal-all — it re-conceals, the safe direction.
   */
  constructor(
    readonly level: GeneratedLevel,
    resume?: GameSnapshot,
    concealed?: readonly TileId[],
  ) {
    this.board = resume
      ? new Board(applySnapshot(level, resume), { holder: resume.holder })
      : new Board(level.tiles);
    this.scores = new ScoreKeeper();
    this.stack = new MoveStack(this.board, this.scores);
    if (resume) this.stack.restoreState(resume.stack);
    this.concealed = new Set(
      concealed ?? concealedTileIds(level, CONCEAL_RATIO[assessDifficulty(level).bucket]),
    );
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

  /** Issue #93 retired selection as a gesture: no tap sets it any more. It
   *  survives read-only because the save format carries it (a pre-#93 save can
   *  restore one) and the QA harness asserts on it. */
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

  /** Empty holder slots. One left means the next park ends the level
   *  (decision 0009) — the cue the HUD warns on. */
  get holderVacancies(): number {
    return this.board.holderVacancies();
  }

  /** Holds taken on this level. Nothing deducts for them in v1; the count is
   *  kept because Vita Mahjong reports a per-level holder average (issue #43,
   *  PM decision 2026-08-31). */
  get holdsUsed(): number {
    return this.stack.holdsUsed;
  }

  // --- face-down tiles (issue #64) ---------------------------------------------

  /** Was this tile dealt face-down? Fixed for the level — visibility right now
   *  is `isFaceHidden`. */
  isConcealed(id: TileId): boolean {
    return this.concealed.has(id);
  }

  /** The one peek, or null. */
  get peeked(): TileId | null {
    return this.peekedId;
  }

  /**
   * Is this tile's face hidden this frame? Computed, not stored: a concealed
   * tile shows its face while it is the peek (a restored pre-#93 selection
   * still pins a reveal too), and once parked it stays face-up (the holder
   * strip is the player's own shelf; re-hiding what they knowingly parked
   * would be a memory test the ticket's cap exists to prevent).
   */
  isFaceHidden(id: TileId): boolean {
    if (!this.concealed.has(id)) return false;
    const tile = this.board.get(id);
    if (tile.removed || this.board.isHeld(id)) return false;
    return id !== this.peekedId && id !== this.stack.selection;
  }

  /** Drop the peek. Called when a tap on another tile moves it (park, match —
   *  the reference game re-conceals on the next move) and when the peeked
   *  tile itself changes under the player (shuffle re-faces it, its own tap
   *  parks it). Not on undo (issue #165): the peek is the player's knowledge,
   *  and taking a tile back out of the holder changes nothing they know. */
  private forgetPeek(): void {
    this.peekedId = null;
  }

  status(): GameStatus {
    if (this.tilesLeft === 0) return 'won';
    // A full holder ends the level (decision 0009), and it is asked first
    // because it outranks everything below: there is no move to look for once
    // the fourth slot is taken, and no Shuffle or Undo offered against it. It
    // cannot collide with the win above — a win needs the holder empty.
    if (this.board.holderFull()) return 'lost';
    // Not `legalPairs`: parking a free tile can expose a pair, so a board with
    // no pair *right now* is not necessarily stuck (issue #43 —
    // hasPlayableMove looks through holds, and since decision 0009 stops one
    // slot short of the park that would lose).
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

  /** Tiles the Undo booster can return (issue #100): parked tiles still in
   *  the holder, newest first. Zero means a press has nothing to charge for. */
  get undoDepth(): number {
    return this.stack.undoDepth;
  }

  /**
   * Hint booster (spec §5): the pair to highlight. The first press on a given
   * board state offers a move from a winning line (the solver's own hint);
   * repeat presses cycle the remaining legal pairs, wrapping around. Null when
   * the board has no matching free pair at all — nothing to charge for.
   */
  hint(): HintPair | null {
    const pair = this.peekHint();
    if (pair !== null) this.hintCursor++;
    return pair;
  }

  /**
   * The pair the next `hint()` would offer, without advancing the cycle. The
   * tutorial's step-3 demonstration (issue #59) uses this so the player's own
   * first Hint press still gets the solver's move, not the second-ranked pair.
   */
  peekHint(): HintPair | null {
    if (this.hintPairs === null) this.hintPairs = this.rankedPairs();
    if (this.hintPairs.length === 0) return null;
    return this.hintPairs[this.hintCursor % this.hintPairs.length]!;
  }

  /**
   * Undo booster (issue #100, Vita Mahjong behavior): return the most recently
   * parked tile from the holder to its own layout slot. Matched pairs are
   * permanent — no amount of Undo brings a matched tile back — and the score,
   * combo ladder and later matches are untouched. Returns the undone hold
   * record, or null on an empty holder (nothing to return, nothing to charge
   * for). The loss dialog still offers no Undo: the level ended the moment the
   * fourth slot filled, so a full holder stays final (decision 0009).
   */
  undo(): HoldMove | null {
    const record = this.stack.undo();
    if (record === null) return null;
    this.forgetHints();
    // A returned concealed tile comes back face-down (the set is fixed). The
    // peek stays (issue #165): it is on a board tile, and the undo only moves
    // a held one — the reference game leaves it showing too.
    return record;
  }

  // --- holder (issue #43) -----------------------------------------------------

  /**
   * Send a free tile to the holder (issue #93: one tap is the whole gesture).
   *
   * Since decision 0009 this is the one move that can end the level: the holder
   * is one-way, and the park that fills the fourth slot loses. The outcome is a
   * plain `held` either way — `status()` is what turns the last one into a
   * loss, so nothing here has to know about dialogs.
   *
   * `holder-full` is the belt-and-braces answer to a park asked of an
   * already-full holder. The input layer gates on `status()`, so play never
   * reaches it: by then the level is over.
   */
  private park(id: TileId, nowMs: number): TapOutcome {
    const slot = this.stack.hold(id, nowMs);
    if (slot === null) return { kind: 'holder-full', id };
    this.forgetHints(); // the board changed: the cycled pairs are stale
    this.forgetPeek();
    return { kind: 'held', id, slot };
  }

  /** Does tapping this *visible* board tile clear a pair in the holder (issue
   *  #93)? The a11y labels and the QA harness ask here rather than re-deriving
   *  face sets. Deliberately false for a hidden face (issue #165): the tap
   *  would clear it — see tapBoard — but a label saying so would leak the
   *  face, and the harness treats hidden tiles as unknowns the way a player
   *  does. */
  pairsWithHeld(id: TileId): boolean {
    return !this.isFaceHidden(id) && this.holderPartner(id) !== null;
  }

  /** Does tapping this *visible* board tile clear against the current peek
   *  (issue #169)? Same shape as `pairsWithHeld` and for the same reason: the
   *  a11y label (and `parkEndsLevel`'s warning) must say "clears" rather than
   *  "parks, ending the level" for a tile a peek-match would clear instead —
   *  and, deliberately, must stay false for a hidden face, so a face-down
   *  tile that would clear against the peek never leaks that by wording. */
  pairsWithPeek(id: TileId): boolean {
    return !this.isFaceHidden(id) && this.peekMatchPartner(id) !== null;
  }

  /**
   * The held tile a board tile would clear against (issue #93), or null.
   * Slot order rather than id order: with two identical faces parked (only a
   * pre-#93 save can hold that state), the pair that vanishes should be the
   * one the player reads first in the strip.
   */
  private holderPartner(id: TileId): TileId | null {
    const face = this.board.get(id).face;
    for (const held of this.board.holderSlots()) {
      if (held === null || held === id) continue;
      if (this.board.get(held).face === face) return held;
    }
    return null;
  }

  /**
   * Shuffle booster (spec §5): re-randomize the faces of the remaining tiles,
   * preserving slot occupancy, re-validating solvability inside the core
   * primitive. False — board untouched — when no solvable assignment exists
   * (or the board is already clear), so an impossible shuffle costs nothing.
   *
   * Not an undoable move: the move stack keeps pointing at the moves actually
   * played, and Undo across a shuffle still returns the parked tile to its
   * own slot (issue #100 — held and removed tiles keep their faces; only
   * present tiles are permuted).
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
    this.forgetPeek(); // the face under the peek just changed
    return true;
  }

  /** Hint cycle order: the solver's move first, then every other takeable
   *  pair. Takeable, not merely legal (issue #93): the Hint booster must never
   *  point at a pair whose first tap parks into the fatal fourth slot, nor at
   *  a held–held pair no gesture can play. */
  private rankedPairs(): HintPair[] {
    const pairs = takeablePairs(this.board);
    const key = (p: HintPair) => `${Math.min(p[0], p[1])}:${Math.max(p[0], p[1])}`;
    const best = findHint(this.board);
    if (best === null || !pairs.some((p) => key(p) === key(best))) return pairs;
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
        return { kind: 'none' };
      case 'blocked':
        return { kind: 'blocked', id: hit.id };
      case 'free':
        return this.tapBoard(hit.id, nowMs);
    }
  }

  /**
   * Tap on a free board tile. In order (issue #165/#169, the reference
   * game's rule plus its narrow amendment):
   *
   * 1. its real face matches a held tile → the pair clears (issue #93: pairs
   *    assemble and resolve in the holder), *hidden or not*. A face-down tile
   *    the player remembers goes straight in — the flight shows the flip —
   *    which is the memory payoff; a face-down tile they guess wrong at is
   *    caught by rule 3 and merely peeks, so a blind tap never mis-parks. The
   *    tapped tile never takes a slot, so completing a pair cannot trip the
   *    full-holder loss in passing. This beats rule 2 below: a tile that
   *    matches both a held tile and the peek clears against the *holder*:
   * 2. otherwise, a peek is showing and this tile's real face matches it
   *    (issue #169, amending decision 0025 point 2) → the pair clears, same
   *    as rule 1 but routed through `playPeekMatch` — the peeked tile gets
   *    the holder slot first, so both tiles still travel to and clear in the
   *    holder rather than vanishing off the board in place (decision 0013);
   * 3. its face is hidden → peek at it (issue #64), and nothing else. One peek
   *    at a time: a second peek re-conceals the first in the same frame;
   * 4. otherwise it goes to the holder — one tap, no select-first step.
   *
   * A peek is passive for every other case: a tap on a non-matching tile is
   * what it would do with no peek showing, and it drops the peek (rules 1/4
   * via playPair/park). The peeked tile's own second tap is a visible tile's
   * tap (rule 2 excludes tapping the peeked tile itself).
   */
  private tapBoard(id: TileId, nowMs: number): TapOutcome {
    const partner = this.holderPartner(id);
    if (partner !== null) {
      const revealed = this.isFaceHidden(id);
      const outcome = this.playPair(partner, id, nowMs);
      return revealed ? { ...outcome, revealed: true } : outcome;
    }
    const peeked = this.peekMatchPartner(id);
    if (peeked !== null) {
      const revealed = this.isFaceHidden(id);
      const outcome = this.playPeekMatch(peeked, id, nowMs);
      return revealed ? { ...outcome, revealed: true } : outcome;
    }
    if (this.isFaceHidden(id)) {
      // One peek at a time: this assignment is what re-conceals the previous
      // one (issue #64 answer 3).
      this.peekedId = id;
      return { kind: 'peeked', id };
    }
    return this.park(id, nowMs);
  }

  /**
   * The peeked tile, if it is a match for `id` (issue #169) — a free board
   * tile, still holding its own layout slot, whose real face equals the
   * peek's real face. Excludes `id` itself (the peeked tile's own second tap
   * is rule 4, unaffected) and requires a spare holder slot: the match is
   * played by parking the peeked tile and immediately clearing it against
   * `id` (playPeekMatch), and a holder with no room for that momentary park
   * is unreachable in real play anyway — a full holder already ended the
   * level (decision 0009) before another tap could land.
   */
  private peekMatchPartner(id: TileId): TileId | null {
    const peeked = this.peekedId;
    if (peeked === null || peeked === id) return null;
    if (this.board.holderFull() || !this.board.isFree(peeked)) return null;
    return this.board.get(id).face === this.board.get(peeked).face ? peeked : null;
  }

  private playPair(a: TileId, b: TileId, nowMs: number): TapOutcome & { kind: 'matched' } {
    const slot = this.board.holderSlots().indexOf(a); // a is held until matchPair removes it
    const score = this.stack.play(a, b, nowMs);
    this.forgetHints(); // the board changed: the cycled pairs are stale
    this.forgetPeek(); // a move on another tile, or the peeked tile leaving
    return { kind: 'matched', a, b, slot, score };
  }

  /**
   * The issue #169 clear: `peeked` is still a free board tile, so give it a
   * real holder slot first — same booking as an ordinary park (`stack.hold`,
   * no `forgetPeek`/`forgetHints` yet, since `playPair` right after does both
   * and the peek must survive up to that point in case anything reads it
   * mid-call) — then clear `tapped` against it exactly like rule 1's
   * already-held case. The hold and the match share `nowMs`: both are the
   * same tap, so ScoreKeeper's monotonic-time check never sees them as two
   * ticks. Precondition (peekMatchPartner): the holder has a slot free.
   */
  private playPeekMatch(
    peeked: TileId,
    tapped: TileId,
    nowMs: number,
  ): TapOutcome & { kind: 'matched' } {
    this.stack.hold(peeked, nowMs);
    return this.playPair(peeked, tapped, nowMs);
  }
}
