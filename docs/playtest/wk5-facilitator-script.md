# Wk-5 vertical-slice playtest — facilitator script

**Issue:** #16 · **Phase:** 2 exit · **Build:** current `main` at
https://lantern-tiles.dqtgametesting.workers.dev · **Facilitator:** PM (Danh)

**Exit criterion being measured:** ≥ 4 of 5 testers complete one level **unaided** in **< 3 min**,
with at least one tester a 55+ target-audience proxy.

---

## Scope — desktop and tablet only (PM, 2026-08-31)

Phone is **out of scope for this round**. On a 375×812 portrait phone the board fills 100% of the
width but only **35% of the height**, leaving tiles at ~23 px — measured live on the deployed build,
which corroborates the 24 px figure computed in #37. Issue #37 as scoped does not fix this: it
changes phone *landscape* only, and explicitly defers portrait ("file separately"). Testing phones
this round would spend unrepeatable first-impression sessions rediscovering a known layout problem.

Within the remaining devices, orientation still matters:

| Device | Board fills play area | Use for playtest |
|---|---|---|
| Tablet landscape (1024×768) | 92% W × 90% H | **Yes — preferred** |
| Desktop browser (800×600+) | 96% W × 87% H | **Yes** |
| Tablet portrait (768×1024) | 96% W × **52% H** | Avoid — half the screen is dead space |
| Phone portrait (375×812) | 100% W × **35% H** | Out of scope |

**Tell tablet testers to hold the device in landscape.** Do not explain why.

---

## Before each session

1. **Open a fresh private/incognito window.** This is not optional. Booster charges
   (`mahjong.boosters.v1`) and the auto-save (`mahjong.save.v1`) persist in `localStorage` across
   games and across deals. A tester who inherits your session starts with depleted Hint/Undo/Shuffle
   charges or resumes your board, and the run is void.
2. Load https://lantern-tiles.dqtgametesting.workers.dev and confirm the HUD reads
   **Score 0 · Tiles 144** and all three boosters read **5**.
3. Have the tester sit down *before* you start the clock. Do not pre-demo the game.

## What to say (read it, don't paraphrase)

> "This is an early build of a tile-matching game. I'd like you to play one full level — clear all
> the tiles from the board. I'm not going to help you, and that's the point: anything you find
> confusing is the game's fault, not yours. Think out loud if it's comfortable. Start whenever
> you're ready."

Then stop talking.

## Timing

- **Start the clock** on their first tap on the board — not when you finish speaking.
- **Stop the clock** when the "Level complete!" dialog appears.
- **Hard stop at 5 min.** Record it as a fail with the tile count remaining, thank them, and move to
  the debrief. Do not let a struggling session run long; you learn nothing after minute 5 and the
  tester leaves discouraged.
- The bar is 72 matches in 180 s ≈ **2.5 s per match**, including the time to *find* each pair.

## Unaided means unaided

Say nothing while the clock runs, including:

- Do not point at tiles, or look at tiles you want them to notice.
- Do not explain what "free" means, or that only edge-exposed tiles can be matched.
- Do not mention Hint, Undo, or Shuffle exist. Whether testers discover the boosters unprompted is
  itself a finding.
- If asked a direct question, say: *"I'd like to see what you'd do if I weren't here."*

Break the rule only to end a session (distress, or the 5-min stop).

## Expected events — do not treat these as bugs, do log the reaction

- **"No moves left" dialog.** Reachable by ordinary greedy play — a scripted greedy playthrough hit
  it at 28 tiles remaining. Shuffle recovers it. Watch whether the tester understands the dialog and
  finds their way out **without help**; a tester stuck here is a genuine AC failure, not a
  technicality. Related: #47 (first shuffle should be free).
- **Tiles that look tappable but aren't.** Depth cues are flat (#45), so covered tiles are hard to
  distinguish from free ones. Expect mis-taps. Count them.

## Observe and write down (do not ask during play)

- Time to first successful match.
- Every mis-tap: tapping a covered tile, or a tile that doesn't match the selection.
- Whether they discover boosters, and at what point.
- Any moment they stop and scan the board for > 10 s.
- Exact words when confused. Verbatim beats your summary.

## Debrief (after the clock stops, ≤ 3 min)

1. "What were you trying to do when you got stuck?" (only if they got stuck)
2. "Was anything hard to see or read?"
3. "Did you notice the buttons in the bottom-right corner?" — ask **only** if they never used them.
4. "Would you play this again?"

Do not defend the build or explain what was supposed to happen.

---

## Per-tester timing sheet

Copy one block per tester.

**Keep filled-in sheets out of the repo.** They hold verbatim quotes, device details and an age
band — participant data, even though testers are keyed by number rather than name. Fill them in
somewhere else and commit only the aggregate roll-up at the end of this file.

```
Tester #: ____   Date: ____________   55+ proxy? Y / N
Device: [ ] desktop browser   [ ] tablet landscape
Browser / OS: ______________________

Completed unaided?        [ ] yes   [ ] no
Time to complete:         ____ min ____ s        (hard stop 5:00)
Tiles remaining if unfinished: ____
Time to first match:      ____ s
Mis-taps (count):         ____
Hit "No moves left"?      [ ] no  [ ] yes → recovered unaided? [ ] yes [ ] no
Boosters discovered:      [ ] Hint  [ ] Undo  [ ] Shuffle  [ ] none
Long scans (>10 s):       ____

Verbatim quotes:


Observed problems:


```

## Roll-up

```
Testers run:                  ___ / 5      55+ proxy included? [ ] yes
Completed unaided < 3 min:    ___ / 5      ← AC needs ≥ 4
Median completion time:       ____
AC met?                       [ ] yes  [ ] no
```

If the AC is not met, the blocking finding goes to a GitHub issue before Phase 2 is called done.
