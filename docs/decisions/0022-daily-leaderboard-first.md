# 0022 — The Daily board first, and scores are bounded rather than verified

**Date:** 2026-09-02 · **Status:** superseded in part · **Ticket:** issue #70
**Superseded by:** [0027](0027-one-weekly-score.md) — the Daily board chosen
here is replaced by one weekly board ranking the ladder (issue #176) — and
[0030](0030-server-verified-runs.md) — the "bounded rather than verified"
position is retired: since issue #187 the server replays every run's move
history before it counts. Storing that history from day one, which this record
insisted on, is what made the first weeks' rows checkable.

## Context

Issue #70 asks for three boards — a Daily Challenge board per date, a
per-level board for the ladder, and an all-time score board — and says plainly
that "score integrity is the real work, not the list UI".

Its plan for that integrity was "validate a submitted score against the move
list that claims it". That collides with an approved decision: **0007** rejected
a move list as the save format precisely because a move list cannot reconstruct
this game. Shuffle permutes the faces of the tiles present at that moment, undo
can then restore a pair the shuffle never saw, and the Super Combo ladder is a
function of the time between matches — so replaying `[m1, shuffle, m2]` lands on
a different board than the one that was played.

Two things measured since then change what is possible, without changing 0007:

- Regenerating a Daily board server-side (layout + seed → deal, validated) takes
  **3–5 ms**. Replay is not too expensive.
- `shuffleBoard(board, seed)` is already deterministic, and every move already
  carries `atMs`. The only thing missing from a replayable history is that
  shuffles are not recorded with their seed.

So verification is buildable — but it means changing core's move stack and the
save format, which is a larger piece than the board itself.

## Decision

**Ship the Daily board now; verify scores in a follow-up.** (PM, 2026-09-02.)

- **The Daily Challenge board, and only that one.** The date key fixes the
  layout and the seed, so every player on 2026-09-02 played the same tiles in
  the same places — it is the one board where a comparison means something. A
  per-level board is 150 boards of surface for a first cut, and an all-time
  total is both the easiest to forge and the least interesting to compare.
- **Scores are bounded, not checked.** A submission must name a real date that
  someone could still be playing (a day either side of the server's own, and
  nothing older than 30 days) and a score inside what the scoring rules can
  produce: 72 pairs, and a flawless Super Combo run pays
  `100 + 120 + 150 + 200 + 68 × 300 = 20970`. Nothing in the game deducts
  points, so that is a hard ceiling rather than a guess. Inside those bounds the
  server believes the client.
- **Every row keeps the move history it was submitted with.** The client sends
  the whole deal — layout, seed, shuffle count, and the move records with their
  timestamps — and the server stores it without reading it. When the follow-up
  lands, the boards' first weeks can be checked rather than written off, which
  is what would happen if the history only started being kept on the day the
  verifier shipped. The history is not yet *sufficient* for a replay: shuffles
  are counted but their seeds are not recorded, so a run that used Shuffle
  cannot be reconstructed from it. Recording that seed is the first step of the
  follow-up, and everything else a replay needs is already in the row.
- **One row per (date, player), and it only ever moves up.** Replaying a Daily
  to a worse score must not cost a player the rank they earned.
- **Ties break on who got there first.** 72 pairs and a capped multiplier put a
  lot of good runs on the same number, so the order has to be stable, and
  rewarding the earlier submission is the defensible direction.
- **Appearing on the board is its own consent.** Sync (decision 0021) gives the
  profile a server-side home; a public board puts a display name in front of
  strangers, which is a different question. The opt-in is off by default, and
  turning it off *withdraws* every entry the player has posted rather than
  hiding them — anything less would be a lie about what the checkbox does.
- **Reading a board is public.** The entries on it are already public, so an
  unauthenticated request gets the top ten and no "you" row, rather than a 401.

## Consequences

- **A forged score is possible, and the board must not be treated as evidence
  of anything until the follow-up lands.** This is stated in
  `worker/leaderboard.mjs`'s own header so nobody reads the bounds as
  verification. It is the accepted cost of shipping the board this cycle.
- The follow-up is now a concrete piece of work rather than an open question:
  record shuffles as a seeded move in core's move stack, bump the save format,
  and have the Worker recompute a submitted score from
  `(layoutId, seed, moves)`. Decision 0007 stands either way — the save state
  stays a snapshot; a *submission* is what carries a replayable history.
- The score ceiling is stated once, as a constant, because every shipped layout
  is 144 tiles. A layout with a different tile count would make that wrong, and
  the constant's comment says so.
- The routes are inert alongside the profile ones until the D1 database exists
  (decision 0021); `worker/schema-0002-leaderboard.sql` is the migration that
  adds `daily_scores`.
- Ladder and all-time boards are not rejected, only deferred — the row shape
  and the ranking queries generalise to a `(board, key)` pair when they are
  wanted.
