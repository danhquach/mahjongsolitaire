# 0024 — Bamboo canes leave a row gap, and take the traditional per-rank accents

**Date:** 2026-09-02 · **Status:** accepted · **Ticket:** issue #163

## Context

Bamboo-6 (a 3 × 2 grid) and Bamboo-9 (a 3 × 3 grid) read as the same tile on
the board. Both had three columns with the same green / red / green column
banding (decision 0023 kept the issue #45 rule: middle band red, by column for
Bamboo), and a cane took 78% of its row pitch, so the canes in a column met
nose to tail and the column read as one unbroken stick. The only difference
left was two canes per column against three, which is a count, not a shape.
A free 6 and a free 9 were selected as a pair in a QA screenshot.

## Decision

1. **A cane takes 0.6 of its row pitch** (was 0.78), capped at 30% of the tile
   height (was 40%). Every stacked rank keeps a clear vertical gap of at least
   10% of the tile height between canes in one column, and Bamboo-6's canes
   are at least 1.4× the length of Bamboo-9's. Both are pinned by unit tests.
2. **Bamboo drops the by-column banding rule for the traditional per-rank
   table:** a red top cane on 3 and 7, a red centre cane on 5, a red bottom
   row on 6, a red middle row on 9; ranks 1, 2, 4 and 8 are all green. Dots
   keep the by-row rule from issue #45. This supersedes the "row/column
   banding is unchanged" wording of decision 0023.
3. **The face-coloured waist node is removed** from the cane. On the shorter
   cane it read as a break rather than a joint, and the row gap now carries
   the countability it was added for. The flared end caps and the two-bulge
   body stay. This supersedes the "face-coloured waist node" wording of
   decision 0023.
4. **Colour is still a secondary cue.** Six and nine differ in cane length and
   in red-row position; the shape difference has to stand on its own under the
   spec §7 "never colour alone" rule, and the accents only reinforce it.

## Consequences

- `ui/src/pips.ts` (fill and cap), `faces.ts` (accent table) and `render.ts`
  (node removal) change together; the by-column `bandAccent` path is no longer
  used by any suit but the helper stays axis-generic.
- Bamboo-7 and Bamboo-9 become the closest pair by silhouette (one cane over
  3 + 3, against 3 + 3 + 3). They differ by the lone top cane and by which cane
  is red; checked at board scale in QA for the ticket.
- Bamboo-1 and 2 draw the longest canes (30% of the tile height). If they read
  as barrels on a phone, lower the cap rather than the fill.
