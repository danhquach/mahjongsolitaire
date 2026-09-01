# 0011 — Plateau ladder: flat difficulty bands with milestone spikes

**Date:** 2026-08-31 · **Status:** accepted · **Amends:** spec §4, ROADMAP Phase 3 · **Ticket:** issue #18

## Context

Spec §4 commits the ladder to a rising curve: 500 levels, Easy/Medium/Hard/
Expert buckets interleaved on an upward slope, a relief level every ~5, and an
exit criterion that no level's predicted difficulty deviates more than one
bucket from its ladder position. That last clause is the expensive part. It
requires `assessDifficulty` to be bucket-accurate at every rung — and three
re-flags on #18 have made bucket accuracy a moving target:

- decision 0008 made the no-holder score a lower bound only;
- decision 0009 removed the bound in both directions (the holder helps *and*
  can lose the level);
- #64 added concealment ratios per band that themselves need re-balancing.

Meanwhile the reference game does not have a rising curve. In Vita Mahjong,
level 268 plays like level 50; the only structure a player can feel is that
every 10th level is harder than its neighbours. The pacing the ladder was
imitating turns out to be a plateau with milestone spikes — which needs far
less from the scorer.

PM direction on #18 (2026-08-31): three plateaus, spike every 10th level.

## Decision

The v1 ladder is three flat plateaus with a spike at every 10th level, shipped
at 150 levels.

1. **Bands:** levels 1–20 Easy; 21–60 Medium; 61–150 Medium+. Every 10th level
   spikes one band up: 10 and 20 are Medium; 30–60 tenths are Hard; 70–150
   tenths are Hard.
2. **Medium+** is not a new calibrated bucket: it is the upper half of the
   Medium score range (at or above the band median). Levels 61+ play tangibly
   firmer than 21–60 without a fourth band to calibrate.
3. **The scorer's job shrinks to ordering.** `assessDifficulty` must produce no
   misordered pair among the bands in use: a spike never scores below its
   decade's base levels, and no Medium+ level scores below the Medium median.
   Bucket-accurate calibration — holder-aware metrics, `holdsUsed` modelling,
   concealment re-balance — moves to a follow-up ticket, needed only if the
   ladder ever grows past the plateaus.
4. **The CI solvability gate is unchanged and permanent:** every shipped seed
   validates solvable on every release.
5. **Concealment follows band at the existing ratios** (`core/src/conceal.ts`):
   Easy 0%, Medium and Medium+ 8%, Hard spikes 15%. Expert and the 22% ratio do
   not ship in v1.

## Consequences

**Spec §4's ladder paragraph is rewritten and ROADMAP Phase 3's exit criteria
are replaced.** "Interleaved buckets on a rising curve with relief every ~5"
becomes the plateau shape above; the >1-bucket deviation criterion becomes the
no-misordered-pair criterion. The relief mechanism disappears as a separate
concept — the nine base levels of each decade are the relief.

**500 → 150 levels.** Generation is seeded and cheap, so the count was never
the cost; but a plateau does not need 500 pre-calibrated rungs to feel
complete. The generator and seed format are unchanged, so extending past 150
is additive.

**The player's experience has exactly two steps.** Level 21 (Easy → Medium,
and face-down tiles appear — the shift is felt twice) and level 61 (Medium →
Medium+). Everything else is decade rhythm: nine flat levels, one spike.

**The three re-flags on #18 stop blocking the ladder.** They collapse from
"recalibrate the model" to "sanity-check the ordering of the bands in use" and
are otherwise deferred to the follow-up calibration ticket.

**Expert content is deferred, not deleted.** The bucket, the 22% concealment
ratio, and the full calibration work remain specified and become the follow-up
ticket's scope.

## Alternatives considered

- **Keep the rising curve, ship it anyway.** Rejected: the >1-bucket criterion
  cannot be met honestly until the scorer models the one-way holder and
  concealment, which is the largest open modelling problem in the repo — all of
  it on the critical path of Phase 3.
- **Two plateaus instead of three** (the first draft on #18). Superseded by PM
  direction: Easy 1–20 / Medium 21–60 / Medium+ 61+.
- **Medium+ as higher concealment instead of higher scores.** Rejected for now:
  it couples the third plateau to constants that #64 already flags as
  provisional. Score-range definition uses only the scorer output the gate
  already checks. Revisit in the calibration ticket.
- **Ship 500 levels on the plateau.** Rejected: no player-visible benefit at
  v1, and it multiplies the PM sign-off report and CI gate runtime for content
  nobody reaches before the follow-up lands.
