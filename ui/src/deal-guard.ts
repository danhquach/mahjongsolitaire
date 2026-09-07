// Confirmation before a deal button throws a game away (issue #248).
//
// `New game` and `Restart` sit in the header next to the boosters and used to
// act on a single tap: one stray reach for Hint or Undo re-dealt the board and
// `beginDeal` overwrote the auto-save on the spot, with nothing to undo. The
// rule here is the gate — the dialog itself is the #201 confirmation panel,
// which main.ts now opens for four actions instead of two.
//
// Pure so it can be tested without a page: main.ts reads the live game, this
// decides, and the copy comes from the same place so the two can never drift.

/** The deal a button asks for — `startLevel`'s two player-facing modes. */
export type DealMode = 'reroll' | 'replay';

/** Everything the gate looks at. Taken as plain numbers rather than the live
 *  `Game` so the rule is testable and states no other opinion about it. */
export interface DealProgress {
  /** The level is still in play. A won, lost or stuck board is decided by the
   *  end-of-level dialog's own buttons — there is nothing left to lose. */
  readonly playing: boolean;
  /** Tiles still in play, the holder's included (`Game.tilesLeft`). */
  readonly tilesLeft: number;
  /** Tiles the deal put on the table — `tilesLeft` at move zero. */
  readonly dealtTiles: number;
  /** Parked tiles Undo could still return (`Game.undoDepth`). */
  readonly undoDepth: number;
  /** Shuffles spent on this deal. */
  readonly shuffles: number;
}

/**
 * Has this board been played on? Three ways, because a match, a park and a
 * shuffle are each work the re-deal destroys and only the first shows up in
 * `tilesLeft` (a parked tile is still in play, and a shuffle moves every tile
 * without removing one).
 *
 * Deliberately *not* elapsed time: a board that has only been looked at is
 * untouched, and gating on the clock would put a dialog in front of the
 * second tap of a player re-rolling for a deal they like.
 */
export function dealNeedsConfirm(p: DealProgress): boolean {
  return p.playing && (p.tilesLeft < p.dealtTiles || p.undoDepth > 0 || p.shuffles > 0);
}

/** What the dialog says. Names the level and the score so the player can see
 *  what the tap costs before it is spent, and says "cannot be undone" in so
 *  many words, like the #201 copy it sits beside. */
export function dealConfirmCopy(
  mode: DealMode,
  where: { readonly level: number; readonly score: number; readonly tilesLeft: number },
): { title: string; text: string; button: string } {
  const board = `level ${where.level}, score ${where.score}, ${where.tilesLeft} ${
    where.tilesLeft === 1 ? 'tile' : 'tiles'
  } left`;
  return mode === 'reroll'
    ? {
        title: 'Start a new game?',
        text: `Your current game (${board}) is thrown away and a fresh board is dealt. This cannot be undone.`,
        button: 'New game',
      }
    : {
        title: 'Restart this level?',
        text: `Your progress on this board (${board}) is lost and the same board is dealt again. This cannot be undone.`,
        button: 'Restart',
      };
}
