# 0039 — Board felts in the shop, and a `looks` object that keeps kinds it does not know

**Date:** 2026-09-05 · **Status:** accepted · **Ticket:** issue #229 (slice 2, felts half)
**Builds on:** [0038](0038-cosmetics-shop-glyph-sets.md) (the shop, owning and
spending, the `looks` stamp) and [0017](0017-board-palettes.md) (the
palette system and its reserved colours).

## Context

0038 shipped the shop with one kind of look, glyph sets, and left tile backs,
felts and avatar frames as later slices "once their art lands". A felt needs no
art: the brief in `docs/design/cosmetics-prompts.md` describes five plain, dark,
low-saturation surfaces whose optional tone-on-tone pattern may differ from the
base by at most 8% lightness — a flat colour is a legal felt. Tile backs are
not in the same position: their brief requires a pattern that identifies the
back in greyscale, and no sheet has been generated yet. So the slice splits:
felts now, backs when the art exists.

Adding a second key to `looks` also exposed a gap in 0038 §3: `parseLooks`
kept only the keys it knew, so a pick of a kind a newer build introduced was
rewritten to the default the moment an older device wrote the record. Unknown
*ids* were kept opaquely; unknown *kinds* were not.

## Decision

### 1. What a felt is

A felt is one colour, `FELTS` in `ui/src/depth.ts`, worn by the ordinary
Lantern palette in place of `BOARD_FELT`. Nothing else changes: border, side,
back and keyline stay Lantern's (`withFelt` copies the palette with one field
swapped and the same `id`). Consequences that fall out of "one field":

- **One proof per felt.** The only contrast pair a felt can break is Lantern's
  back against it (issue #82: 3:1 on every undimmed layer). `ui/test/depth.test.ts`
  runs that proof and the soft-felt / strong-back rule for every entry in
  `FELTS`, and refuses any felt within 40 RGB units of the reserved Milestone
  burgundy `#4c0519` or Daily indigo `#1e1b4b` (0017). Two of the brief's
  bases failed that guard and were moved: slate `#1e293b` → `#334155` (21
  units from the Daily indigo), walnut `#3f2a1d` → `#4a3728` (39 units from the
  burgundy). The brief carries both corrections.
- **The renderer keeps its tile pictures.** `setPalette` now distinguishes a
  new palette (drop the holder's baked tiles: border and side changed) from
  the same palette under a new felt (repaint the background only). The tile
  key carries the palette id, not the felt, so a felt change redraws nothing
  but the table.
- **The spike and the Daily are untouched.** `paletteInPlay` returns the
  milestone palette for a decade spike before it looks at the record; the
  Daily board never used the palette system (issue #183). A bought felt is
  decoration on ordinary levels, never a signal.
- **No pattern.** *Superseded the same day by [0040](0040-cosmetics-shop-tile-backs.md) §5:*
  a composite of the generated sheet showed the weaves reading clearly at
  phone size, and the PM chose to ship them as seamless textures painted by
  the page behind a transparent canvas. The table here is unchanged; each
  felt gained the texture's brightest pixel for the proofs.

### 2. The record: `looks.felt`, and unknown kinds kept

- **`looks` gains `felt`**, default `'lantern'`, chosen with `setLook('felt', …)`
  under the same rules as `glyphs` (default or owned, else refused; a change
  stamps `looksAt`). `LookKind` is now `'glyphs' | 'felt'`.
- **`parseLooks` keeps every well-formed kind** (`/^[a-z]{1,16}$/` key, cosmetic
  id value, at most 8 entries), fills the kinds it knows with their defaults
  when missing or malformed, and **sorts the keys**. The Worker mirrors it.
  Sorting matters because the merge's tie-break (0038 §3) compares the JSON
  text of two `looks` objects: two devices holding the same picks must
  serialise them identically whatever order the keys arrived in.
  `DEFAULT_LOOKS` is written in sorted order for the same reason, and
  `setLook` spreads the existing object so it never reorders a key.
- **This does not repair slice 1 clients.** A device still running the
  slice-1 build drops `felt` from any record it writes with a fresh stamp.
  That is the same window every schema-additive change has had, and it closes
  as those installs update; from this build on the window does not reopen for
  backs or frames.

### 3. The shop

The Shop dialog gains a **Board felts** fieldset under the glyph sets, same
row idiom: name, price, description, a preview, one action. The preview is
the felt itself with a face-down Lantern back on it — the one pairing the felt
is proven against, not a decorative swatch. The row code in `main.ts` is now
one `shopRow` over a `ShopRow` record (kind, id, label, spoken name, price,
description, preview, apply), so slice 3 adds a list and a row table, not a
third copy of the Buy / Confirm / Cancel state machine. Buttons are named by
kind as well as name ("Use the Forest felt", "Walnut felt, in use") so a
screen reader hears which list it is in.

Prices are the issue's tiers spread over the five felts until the PM sets
final ones (0038 §2: a change of price is a new item id): Forest 10, Ink 10,
Teal 25, Slate 25, Walnut 60. A felt and a glyph set spend the same derived
balance.

## Alternatives considered

- **A `PaletteId` per felt** (`lantern-walnut`, …) so `setPalette`'s id check
  stayed a one-liner. Every consumer of the id — the tile key, the holder's
  cache, `paletteId` — would then rebuild every tile for a change that touches
  none of them. Rejected for the one extra comparison.
- **Wait for the felt sheet like the backs.** The sheet would add nothing a
  colour does not, at the 8% ceiling; the brief's own numbers make the felt a
  colour. The reserved-colour guard, which caught two of those numbers, would
  have been needed either way.
- **Keep `parseLooks` strict and add `felt` to the known list.** Repeats the
  slice-1 gap for slice 3. Rejected.

## Consequences

- `PlayerRecord.looks` is `{ felt, glyphs, …unknown kinds }`; `EMPTY_RECORD`
  and every fixture that spelled out `looks` gained `felt: 'lantern'`.
- No schema change: `players.looks` was already an opaque JSON column (0038 §4).
- The renderer's `paletteInPlay` reads the record, so the record store is
  constructed before the first `applyPalette` at boot.
- Tile backs remain open on issue #229 for want of art; avatar frames (slice 3)
  add a list to the shop and a key to `looks` with the machinery here, plus the
  leaderboard re-review 0038's security note called for.
