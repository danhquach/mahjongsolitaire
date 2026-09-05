# 0038 — Trophies buy cosmetics: the shop, and glyph sets as the first purchasable look

**Date:** 2026-09-05 · **Status:** accepted · **Ticket:** issue #229 (slice 1 of 3)
**Amends:** [0002](0002-name-art-direction.md) point 5 (the face linework is
theme-independent) and [0023](0023-no-corner-tags-dragon-inks.md) (faces carry
identity in their art alone) — both now hold *per glyph set* rather than for
one fixed set of face art. Everything else in 0002 and 0023 stands.

## Context

Trophies (0016, 0028, 0037) are counted, shown and synced, and buy nothing.
Issue #229 gives them a shop in Settings: four cosmetic categories, none of
which changes what a face means or how a board is read. Two glyph sets are
drawn and cut (`docs/design/glyph-sheet-brief.md`, 2026-09-05); tile backs,
felts and avatar frames have prompts but no art yet, so they are later slices
of the same ticket, not part of this decision.

0002 point 5 fixed the face linework as the one thing no theme may touch, and
0017 built the palette system on that guarantee: only felt, border, side and
back change, so the ink-vs-face contrast proof runs once. 0023 then made every
face identifiable from its main art alone. A purchasable glyph set is, by
definition, different face art — so it needs those two decisions to say what
"different" may and may not mean, and the record needs a way to own things and
spend a counter that was designed never to go down.

## Decision

### 1. What a glyph set is allowed to change

**A glyph set replaces the *drawing* of each face, never its *design*.** The
constraints of 0002/0023 move from "the art" to "every set":

- Same pip grids, same accent rows (0024), same seven inks, same Dragon
  identities (red 中, green 發, white frame) and Season compositions, on the
  same cream face (`BASE_FACE`), inside the same `PIP_AREA`. The shape-first
  rule and the "never colour alone" rule (spec §7) are unchanged.
- The face fill, border, side, back and felt are the palette's (0017), not the
  set's. A set and a palette compose: any set on any palette.
- A set ships as **whole-face bitmaps swapped by set id**, one PNG per face
  (38), not per-pip sprites: the renderer draws the default Lantern faces from
  `pips.ts` geometry, and a bitmap set does not go through that path. Per-layer
  depth is kept by tinting the sprite with the same ink factor `tileShade`
  applies to vector ink (`LAYER_INK_STEP`), so a deep-layer bitmap face recedes
  with its neighbours.
- Scale is fixed, not fit-to-box: the sheet's 256 px cell maps to the 64 px
  tile, so a glyph is drawn at 0.25 of its pixel size, clamped only if it would
  leave `PIP_AREA`. Fit-to-box would blow a single pip up to fill the face and
  destroy the relative sizing the grids depend on.

**Known gap, flagged for the PM.** The cut PNGs do not hold to the seven inks
pixel for pixel: a nearest-ink audit on 2026-09-05 put ~40% of set A's and
~21% of set B's opaque pixels more than 40 RGB units from any allowed ink
(worst: a peach near `#e79172` in `A-season-summer`, `#f79866` in `B-dots-7`).
The generated sheets shaded where the brief said flat. Identity is still shape
(the audit found no glyph whose silhouette depends on those tints), but the
4.5:1 ink-vs-face figure does not carry over unproven the way the issue
assumed. Options are a snap-to-palette pass in `cut-glyphs.py` or a redraw;
neither is taken here. Until one is, the sets ship as drawn.

### 2. Owning and spending, in a record that never regresses

The record's merge rule (0037 §3) is max-or-union everywhere, and `trophies`
is a max. A deduction would be undone by the next merge. So:

- **`PlayerRecord.owned: string[]`** — cosmetic item ids, sorted, deduplicated,
  ids opaque (`/^[a-z][a-z0-9-]{0,31}$/`, at most 64 entries). Merge is the
  **union**, exactly like `cleared`. An id this build does not sell is kept,
  not dropped: a newer build's purchase must survive a round trip through an
  older device.
- **Nothing is ever deducted from `trophies`.** The spendable balance is
  *derived*: `trophies − Σ price(owned)`, prices from the shop's own table
  (`ui/src/shop.ts`), unknown ids priced at 0, floored at 0. No `spent`
  counter to merge, and two devices buying different items offline reconcile
  to the exact sum rather than to whichever spent more. The cost is that a
  price change re-prices every past purchase; a price is therefore part of an
  item's identity, and a re-priced item is a new id.
- **Buying** is a client check (`balance ≥ price`, not already owned) and an
  append to `owned`. The server stores `owned` opaquely and does not know
  prices, so it cannot verify affordability — the same trust it already
  extends to `levelsCleared` and `trophies`. Since 0037 the trophy counter's
  own cap is enforced in the record, which is what made this acceptable
  (0028's "revisit when trophies unlock content" is that revisit).

### 3. Choices, last-write

- **`PlayerRecord.looks: { glyphs: string }`** and **`looksAt: number | null`**
  (epoch ms of the last change). This slice has one look; later slices add
  keys to the same object under the same stamp. An unknown set id is kept
  opaquely and resolves to Lantern at render time, so a newer build's pick is
  never rewritten by an older device.
- Merge: the later `looksAt` wins the whole `looks` object; a null stamp loses
  to any stamp; equal stamps with different content take the lexicographically
  greater JSON so the result is still commutative. A stamp is only ever written
  by a player's own tap, so "later" is "chosen more recently" to within clock
  skew between the player's own devices — the same assumption `lastDaily`
  already makes.
- Choosing a look that is not owned (and is not the free default) is refused
  by the store, not just hidden by the UI.

### 4. Worker persistence

`players.owned TEXT DEFAULT '[]'`, `players.looks TEXT DEFAULT '{}'`,
`players.looks_at INTEGER` — `schema-0007-cosmetics.sql`, additive, applied
**before** the deploy exactly as 0003 and 0006 were; `check-schema.mjs` gates
the deploy on the columns existing. `validateRecord` and `mergeRecords` in
`worker/profile.mjs` mirror the client rule field for field, with the usual
header comment pointing at `ui/src/sync.ts`. Reset progress (0034 / issue
#201) empties `owned` and `looks` with the rest of the record: a reset returns
the trophies that bought them, so keeping the purchases would be a free copy.

### 5. The shop itself

A **Shop** row in Settings opens its own dialog (same card, inert background,
Escape and backdrop dismissal as every other panel). It shows the balance, then
each item with a price, a short description and a preview of four faces baked
by the board renderer from the real set — the shop shows what the board will
draw, not a stand-in. A locked item shows its price and the shortfall and its
Buy is disabled until affordable; Buy is a two-tap confirm in place
(`Buy for 25` → `Confirm 25 trophies` / Cancel), so a mis-tap cannot spend.
Owned items are switchable freely, forever. Prices are the issue's proposed
numbers — Calligraphy 25, Fantasy 60 — until the PM sets final ones (§2: a
change of price is a new item id).

Glyph PNGs ship under `data/glyphs/<set>/<face>.png` (Vite's `publicDir`, so
they are static files, not bundled) and load lazily, only for the set in use
or being previewed, ~1.4 MB per set. The default Lantern set costs nothing to
load because it is still drawn.

## Alternatives considered

- **A `spent` counter merged by max.** Two devices buying different items
  offline would merge to the larger single spend, not the sum — under-charging
  by a whole item. Rejected for the derived balance.
- **Deducting from `trophies` and changing its merge rule.** Would make the
  one counter that feeds a public standing non-monotonic, and 0037 just spent
  a migration making it trustworthy. Rejected.
- **Choices as plain "client wins", like the avatar.** The avatar rides the
  sync route and the pushing device simply wins; for a look that is also
  pushed by every post-win background sync, that let device A's stale pick
  overwrite device B's fresh one. Rejected for the stamp.
- **Per-pip sprites so sets reuse `pips.ts` placement.** Would need every
  set cut to pips, and both delivered sheets are composed per face. Whole-face
  bitmaps are what exists; the geometry rule is enforced by the brief instead.
- **Bundling the PNGs.** +2.8 MB on every install for art most players never
  buy. Rejected for lazy static files.

## Consequences

- `parsePlayerRecord` (client) and `validateRecord` (Worker) grow three
  fields; a record from before this change reads as owning nothing, looking
  Lantern, with a null stamp. Nothing is clawed back and nothing is granted.
- Migration 0007 must precede the deploy (0003's ordering); the gate enforces
  it.
- The renderer's tile key and the holder's baked-picture cache both include
  the set id, so a set change redraws every face and every parked tile.
- Slices 2 (backs and felts) and 3 (avatar frames) add items to the shop table
  and keys to `looks`; the merge, storage and shop mechanics are done here.
- The ink audit gap in §1 stays open until the PM picks a fix; it is a design
  debt, not a shipping blocker, and is called out in the shop's PR.
