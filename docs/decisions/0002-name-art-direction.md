# Decision 0002 — App name & art direction: "Lantern Tiles", original commissioned art

**Status:** DRAFT — pending PM approval + legal clearance · **Date:** 2026-08-30 · **Issue:** #2 · **Roadmap:** §2.2

## Decision

- **Working name: "Lantern Tiles"** — store listing title **"Lantern Tiles: Mahjong Solitaire"** (distinctive brand word + generic genre descriptor, the standard IP-safe pattern in this category).
- **Backup name: "Willow Tiles"** (same pattern) if clearance on the primary fails.
- **All art commissioned as original work**: tile set, app icon, UI compositions, store assets. No reuse of, or visual likeness to, any existing product — in particular no likeness to the reference product (Vita Mahjong) per spec §12.
- Art commissioning kicks off **week 1, in parallel with M1** (art is the longest external lead time, roadmap §2.2); final tile art due **mid-Phase 2**; store assets by **Phase 5** (roadmap "Art pipeline").

## Naming

### Constraints (spec §12, roadmap Legal/IP)

1. The word *mahjong* is generic for the genre (mechanics, layouts, and tile suits are public domain — spec header note) and is used descriptively by essentially every competitor. It is safe **as a descriptor**, not as the distinctive part of the mark.
2. The distinctive part must not collide with an existing game/app name or read as a likeness of one.
3. Formal clearance (trademark search + store-likeness review) is a legal task, due **before Phase 5 asset lock** (roadmap); the checks below are collision screens, not legal clearance.

### Candidates screened (2026-08-30, web/app-store collision search)

| Candidate | Collision screen | Verdict |
|---|---|---|
| **Lantern Tiles** | No app-store, Steam, or itch.io hit found | ✅ **primary** |
| **Willow Tiles** | Only a physical tile-set product ("Willow" set, Oh My Mahjong) | ✅ backup |
| Mellow Mahjong | No exact hit, but no distinctive word — weak as a mark | ⚠️ reserve |
| Tidepool Tiles | "Tidepool Tile" (physical tile), "Tidal Tile" (match-3 app) nearby | ⚠️ crowded |
| Tile Haven / Tilehaven | **"Mahjong Haven"** exists — a senior-targeted mahjong solitaire app (direct competitor) | ❌ out |
| Tile Garden | ≥5 existing "Tile Garden" apps on both stores | ❌ out |
| Jade Harbor | "Jade Harbor Club" social casino — category we must not be associated with (spec §2.3 excludes gambling) | ❌ out |

### Why "Lantern Tiles"

- Distinctive, ownable brand word; no found collision in games.
- Evokes the calm, warm, evening-wind-down mood that fits the 55+ / no-timer-pressure positioning (spec §1.2, §7).
- Gives the icon a strong, simple, original motif (a lantern) that reads at small sizes — none of the top mahjong apps use it, so no likeness risk.
- Suffixed store title keeps search discoverability ("mahjong solitaire") without leaning on anyone's brand.

## Art direction

Positioning drivers (spec §1.2, §7): audience 55+, accessibility is the differentiator — oversized tiles, high contrast, large type, calm pace.

1. **Tile faces:** traditional suits (public domain) redrawn in an **original style** — thick, simplified strokes; high figure/ground contrast; numerals always paired with suit symbols; readable at tile size S through XL (settings requirement, roadmap M1). No tracing or visual likeness to any existing tile set. WCAG-level contrast on every face; colorblind-safe suit differentiation (shape-first, color-second).
2. **Mood/palette:** warm lantern-light palette (deep indigo/teal grounds, warm amber accents), low-saturation backgrounds so tiles carry the contrast. Calm, not casino.
3. **Icon:** single lantern silhouette + tile edge; must read at 48px; original composition.
4. **UI compositions:** large-type, low-chrome; supports the DOM/ARIA overlay approach from Decision 0001 (art never encodes state that isn't mirrored in the accessible layer).
5. **Themes** (v1.1+, spec §2.2): the tile-face linework is theme-independent; themes swap palette/background only — brief the artist so the atlas is built in separable layers.

### Commission scope & schedule (artist contract)

| Deliverable | Due |
|---|---|
| Style frames: 3 tile-face directions + icon sketches | wk 2 |
| Direction locked (PM pick) | wk 3 |
| Placeholder-replacement tile atlas, one full set, S–XL tested | mid-Phase 2 (roadmap M2 dependency) |
| App icon final (iOS/Android sizes) | mid-Phase 2 |
| UI kit (buttons, dialogs, settings, booster iconography) | end Phase 2 |
| Store assets (screenshots frames, feature graphic) | Phase 5 |

Contract terms to include: **work-for-hire / full IP assignment**, source files delivered (vector or layered), warranty of originality (no AI-scraped or traced assets — this is our §12 defense), 2 revision rounds per deliverable.

## Acceptance criteria status (issue #2)

| Criterion | Status |
|---|---|
| Name cleared | **Proposed** ("Lantern Tiles"); collision-screened ✅; formal trademark + store-likeness clearance = open legal task (before Phase 5 asset lock) |
| Artist contracted | **Open** — PM action; brief + scope above ready to send |
| Delivery schedule agreed | **Drafted** above; becomes agreed when contract signed |

## Sources

- Collision screens (2026-08-30): Apple App Store / Google Play search results for each candidate; itch.io/Steam search for "Lantern Tiles" (no hits). Notable near-collisions: [Mahjong Haven](https://apps.apple.com/us/app/mahjong-haven/id6740552322), [Tile Garden (multiple)](https://apps.apple.com/us/app/tile-garden-classic-match-3/id6447544248), [Jade Harbor Club](https://www.jadeharborclub.com/).
- Spec: `mahjong-solitaire-spec.md` §1.2, §2.2, §7, §12 · Roadmap: `ROADMAP.md` §2.2, "Art pipeline", "Legal/IP".
