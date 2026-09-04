# Server-Verified Runs — Implementation Plan (issue #187)

**Goal:** A leaderboard submission counts only if the server can replay its move history against the regenerated deal and arrive at the claimed score on a cleared board. The client's `score` becomes a cross-check; a run that does not replay is a 422 and never touches the standing.

**Architecture:** Core's move stack becomes a complete replay log — Shuffle is recorded with its seed, Undo appends a `return` record instead of deleting the hold — and gains one shared `replayMoves(level, moves, multiplier)` helper (also the helper issue #50 asked for). The Worker imports core's build, holds the ladder and the ten layouts as JSON modules, looks a submission's `(layoutId, seed)` up on the ladder for the band multiplier, and replays before writing. The save format bumps to v8 because a v7 history is not replayable.

**Tech Stack:** TypeScript core (`core/`), Vite UI (`ui/`), Cloudflare Worker + D1 (`worker/`), `node --test`.

## Global constraints

- Repo rule: no commit until the PM approves after QA + review (CLAUDE.md). Branch `issue-187-server-verified-runs` from `main` at `300af56`.
- Suites: `core`: `npm ci && npm test`; `ui`: `npm ci && npm test`; `node --test bench/test/*.test.mjs`; `node --test worker/test/*.test.mjs`.
- No schema change: `weekly_submissions.history` already exists, so no migration and no #185 gate impact.
- Worker CPU: replay = one `generateLevel` (3–5 ms measured in 0022) plus one `solve` per recorded shuffle. Measured before the report; stated in the ADR.

## Decisions made while implementing (for the PM to confirm)

1. **Undo keeps a record.** `undo()` appends `{kind:'return', tile, slotIndex}` rather than splicing the hold out; `holdsUsed` = holds − returns, so the count still rolls back. Without this, a hold whose freed tile was matched before the undo leaves a history that cannot replay.
2. **Save format v8.** A v7 record's history lacks shuffle seeds and undone holds, so a run resumed across the upgrade could never verify. Same clean break as v5→v7: the in-flight deal restarts, progress keeps.
3. **Score mismatch is a rejection**, not a silent correction: if the replay's score differs from the client's, something is wrong on one side and the run is refused with a reason.
4. **History is now required**: a submission without it is 422 `run_rejected` / `history_missing`.
5. **Only ladder deals verify**: `(layoutId, seed)` must be a `data/ladder.json` entry, which is also where the band multiplier comes from.

6. **Shuffles are reproduced, not re-solved** (found during implementation): re-running `shuffleBoard`'s solver validation on replay measured ~130 ms per shuffle (1.2 s for a 10-shuffle run). The record carries the `attempt` index the solver accepted; `applyShuffle(board, seed, attempt)` reaches the same permutation in microseconds. Replay cost is ~2.5 ms per run regardless of shuffles.
7. **Pre-existing bug fixed in passing:** the client posted `elapsed.ms` as a float and the Worker requires an integer, so every live submission since #176 was a 400. `submitRunResult` now sends `Math.ceil(elapsedMs)`.

## Tasks

- [x] **1 core/moves.ts** — `ReturnMove`, `ShuffleMove {seed, attempt}`; `MoveStack.shuffle(seed, nowMs?)`; `undo(nowMs?)` appends a return; `holdsUsed` nets returns. Tests in `core/test/moves.test.ts`.
- [x] **2 core/replay.ts + shuffle.ts** — `replayMoves(level, moves: unknown, scoreMultiplier)` → `{ok:true, score, matches, cleared, lastMs}` | `{ok:false, reason, index}`; `shuffleBoard` returns the accepted attempt, `applyShuffle` reproduces it. Tests in `core/test/replay.test.ts`, `core/test/shuffle.test.ts`.
- [x] **3 ui** — `Game.shuffle(seed, nowMs?)`, `Game.undo(nowMs?)`; `main.ts` passes `elapsed.ms` and ceils the posted elapsed time; `save.ts` v8 parses `return`/`shuffle` and walks them in `checkUndoChain`; `leaderboard.ts` `RunResult.history` required and typed. Tests: `save.test.ts`, `save-v6.test.ts`, `leaderboard.test.ts`.
- [x] **4 worker/replay.mjs** — JSON-imports `data/ladder.json` + `data/layouts/*.json`, imports core's build; `verifyRun(history, {score})`. `leaderboard.mjs`: history required, replay before the run cap check, 422 `run_rejected` with `reason`; header rewritten; `MAX_RUN_SCORE` imported from core. Tests rewritten to post real runs (`playedRun(level, combo)`), plus the ticket's repro and each rejection.
- [x] **5 CI + config** — deploy job builds core before `wrangler deploy`; `wrangler.jsonc` comment; `wrangler deploy --dry-run` bundled 155 KB with core and the JSON modules.
- [x] **6 docs** — ADR 0030; 0022/0027 headers point at it; `leaderboard.mjs`/`main.ts`/`leaderboard.ts` comments.
- [ ] **7 QA** — all four suites from clean install; senior review of the diff; report and STOP for approval.
