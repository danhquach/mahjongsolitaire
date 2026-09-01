# Decision 0005 — Identical-face matching only; no Flower/Season wildcards

**Status:** APPROVED (PM, 2026-08-30) · **Date:** 2026-08-30 · **Issue:** #7 (surfaced during generator review) · **Spec:** §3.3–3.4 amended

> **Amended by decision 0012 (2026-08-31, issue #75):** the Flower suit is
> removed and the Seasons become the four real seasons —
> `season-spring|summer|fall|winter` ×2 each (8 tiles; 144 total unchanged).
> The identical-only match rule below stands; the `flower-*`/`season-1|2`
> face ids in the examples are the pre-0012 ones.

## Decision

The match rule is **identical face for all tiles**. The classic Flower/Season
wildcard groups ("any Flower matches any Flower") specified in the original
§3.3 are removed, at PM direction during the issue #7 review.

Because the classic set carries only one copy of each of the 4 Flower and 4
Season faces, identical-only matching would make those 8 tiles unpairable. The
tile set (§3.4) is therefore redefined: **Flowers and Seasons ship as two
identical copies of two faces each** — `flower-1` ×2, `flower-2` ×2,
`season-1` ×2, `season-2` ×2. Totals are unchanged (4 Flowers, 4 Seasons, 144
tiles, 72 pairs) and every face has an even copy count.

## Alternatives considered

1. Identical-only matching with Flowers/Seasons excluded from generation
   (usable pool drops to 68 pairs / 136 tiles) — rejected: silently shrinks
   the set and wastes commissioned tile art.
2. Keep the wildcard rule (spec as written) — rejected by PM.

## Consequences

- `core/src/faces.ts`: `facesMatch` is strict equality; `matchGroup` removed;
  `STANDARD_144` recomposed (2×2 Flowers/Seasons). Reopens the merged issue #6
  surface — its tests were rewritten in the same change.
- Generator (issue #7) pairs identical copies only; "even count per group"
  invariants become "even count per face" (spec §3.4, §11.1 updated).
- Art order (decision 0002/0003): only 2 Flower + 2 Season designs are needed
  instead of 4 + 4, but each appears twice per board.
- UX note: players see two visually identical Flower (and Season) tiles rather
  than the classic mixed group; deviation from classic behavior is deliberate.
