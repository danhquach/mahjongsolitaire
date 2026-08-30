# Decision 0003 — Amend 0002: free/open-licensed artwork instead of commissioned art

**Status:** APPROVED (PM, 2026-08-30) · **Date:** 2026-08-30 · **Issue:** #26 · **Amends:** 0002

## Decision

- **No artist commission.** Tile art and UI art are sourced from free/open-licensed assets. The 0002 commission scope, schedule, and contract terms are void.
- **Name and art *direction* from 0002 stand:** "Lantern Tiles" naming, warm lantern-light palette, accessibility bar (contrast, S–XL readability, shape-first colorblind-safe suits). Free assets are selected/re-themed to meet that direction.
- **License bar:** CC0 preferred; CC-BY 4.0 acceptable with attribution in-app (settings/credits screen) and in store listing where required. Never: NC, ND, share-alike-on-app, "free for personal use", or unclear provenance.
- **Icon + store assets stay original** (made in-house, even if simple): they are the storefront likeness surface spec §12 worries about, and free assets there are the highest clone-collision risk.

## Candidate sources (licenses to verify at selection time — acceptance criterion)

| Source | License (claimed) | Notes |
|---|---|---|
| [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles) | CC-BY 4.0 | Clean vector set, widely used — likeness check required for exactly that reason |
| [LibreRiichi assets](https://codeberg.org/davidgomez/libreriichi-assets) | CC0 1.0 | SVG source, public domain |
| [publicdomainvectors.org mahjong sets](https://publicdomainvectors.org/en/free-mahjong-tiles-vector) | CC0 | Quality varies; per-file check |
| [freesvg.org mahjong tiles](https://freesvg.org/mahjongtiles) | CC0 | Per-file check |

## Selection rules (spec §12 guardrail)

1. **Provenance:** license file/page archived (screenshot + URL) per asset at adoption time; prefer sets with a git history over aggregator downloads.
2. **Likeness sweep:** before adopting a set, search the stores for apps using it; if a top-charting mahjong app visibly ships the same faces, re-theme (recolor, restroke, new backs/frames) until visually distinct. Budget: our own palette + tile frame applied over any adopted linework — this alone differentiates most sets.
3. **Accessibility gate unchanged:** whatever is adopted must pass the 0002 bar — contrast, S–XL legibility, numeral+symbol pairing; edit the SVGs if needed (CC0/CC-BY permit modification).
4. **Attribution ledger:** `docs/ATTRIBUTIONS.md` lists every third-party asset, source URL, license, and modifications; shipped in-app on the credits screen.

## Consequences

- Artist contract and "delivery schedule" acceptance criteria of issue #2 are void; #2 remains satisfied via name + this amendment.
- Mid-Phase-2 "final art" external dependency disappears; art becomes an internal selection/re-theme task, doable any time before Phase 5 asset lock.
- Roadmap staffing note (1 contract artist) drops; small in-house effort for icon + store assets remains (Phase 5).
- Legal task narrows: name clearance (unchanged) + license verification ledger instead of a work-for-hire contract review.

## Acceptance criteria mapping (issue #26)

| Criterion | Status |
|---|---|
| Amendment doc merged | this doc |
| Candidate sources listed, licenses verified | candidates above; **verification happens at adoption, logged in ATTRIBUTIONS.md** |
| Icon plan settled | original in-house lantern icon (0002 motif), due Phase 5 with store assets |
