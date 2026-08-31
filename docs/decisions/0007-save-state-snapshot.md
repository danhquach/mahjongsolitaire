# Decision 0007 — The save state is a board snapshot, not a move-list replay

**Status:** APPROVED (PM, 2026-08-31) · **Date:** 2026-08-31 · **Issue:** #14 · **Spec:** §9 data model amended

## Decision

The auto-save record stores **the state of the board**, not the move list that
produced it. Concretely, per level in progress:

```json
{
  "version": 1,
  "layoutId": "turtle_classic",
  "seed": 88213947,
  "shuffles": 1,
  "elapsedMs": 91400,
  "snapshot": {
    "faces": ["dots-1", "bamboo-5", "…"],
    "removed": [12, 88, 3, 140],
    "stack": { "moves": [{ "a": 12, "b": 88, "atMs": 1200, "prevSelection": 12, "prevScores": {} }], "selection": 64, "scores": {} }
  }
}
```

Deal geometry is still *not* stored: `(layoutId, seed)` regenerates the slots
and tile ids exactly, which is the spec §9 key invariant and stays intact.

## Why the spec's move list cannot work

Spec §9 sketches `saveState` as `{ levelId, seed, moves: [[12,88],…],
boostersUsed, score, elapsedMs }` — replay the moves to rebuild the board.
That is not expressive enough for the mechanics the spec itself defines:

1. **Shuffle × Undo (spec §5).** Shuffle permutes the faces of the tiles
   *present at that moment*. Undo can then restore a pair the shuffle never
   saw. Replaying `[m1, shuffle]` shuffles a board that still holds m2's tiles
   and lands on a different face assignment than the live board had. The
   interleaving is not recoverable from a move list at all.
2. **The Super Combo ladder (spec §6)** is a function of the *time between*
   matches. The sketched move list carries no timestamps, so a replay cannot
   reproduce the streak, and a resumed game would score the next match wrong.
3. **The live selection (spec §5)** — undo must restore it — is state between
   moves, which a list of completed moves cannot express.

Storing the state instead makes resume exact: the acceptance check compares
`MoveStack.stateHash()` (every tile's face and removed flag, the selection, and
the full score state) across a real force-quit at every move index of a sample
level, and requires an identical hash.

## Alternatives considered

1. **Move list plus a shuffle log** (`[move, move, shuffle(seed), move]`) —
   rejected: undoing across a shuffle still diverges (see 1 above), and the
   whole board has to be re-simulated on every boot.
2. **Move list with timestamps, no shuffle support** — rejected: it would mean
   dropping the Shuffle booster's persistence, and a force-quit after a shuffle
   is exactly when a player most wants their board back.
3. **Store the full deal (slots included)** — rejected: `(layoutId, seed)`
   already reproduces it, and a stored copy could silently disagree with the
   layout JSON the build ships.

## Consequences

- `boostersUsed` from the spec sketch is **not** stored. Remaining charges
  already persist separately (issue #13), and per-level usage counts have no
  consumer until analytics (issue #22); the field can be added then.
- The record carries `version`, and `parseSave` accepts only version 1. A
  record from a future or older format reads as absent, so the player gets a
  fresh deal rather than a crash. Every other field and cross-field
  relationship is validated at the same boundary.
- **The game clock is elapsed play time**, not `performance.now()`: a resumed
  page restarts `performance.now()` at 0 while the restored combo ladder still
  holds the previous session's timestamps, and core's `ScoreKeeper` rejects a
  clock that moves backwards. `elapsedMs` is therefore load-bearing state, not
  just a readout for the opt-in timer.
- Record size is ~4KB of JSON for a 144-tile board — well inside any local
  storage budget, and written on every move.
- Cloud save/sync (v1.1+ backlog) inherits a format that is a state snapshot;
  conflict resolution there will be "newest wins per level", not a merge of
  move lists.
