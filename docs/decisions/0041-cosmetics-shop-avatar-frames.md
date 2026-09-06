# 0041 — Avatar frames in the shop: the first look another player sees

**Date:** 2026-09-06 · **Status:** accepted · **Ticket:** issue #229 (slice 3 of 3)
**Builds on:** [0038](0038-cosmetics-shop-glyph-sets.md) (shop, owning, the
`looks` stamp and its security note), [0039](0039-cosmetics-shop-felts.md)
(opaque look kinds), [0040](0040-cosmetics-shop-tile-backs.md) (bitmap looks).

## Context

Glyph sets, felts and backs change only the player's own board. An avatar
frame is different in one way that matters: the issue puts it on the weekly
leaderboard, so for the first time a cosmetic chosen by one player is drawn on
another player's screen. 0038's security review flagged exactly this — a
`looks` value becomes an attacker-controlled cross-user string — and asked
for the id containment to be re-examined when the slice arrived.

The frame sheet (eight cells: a plain ring as the current look, then seven
frames drawn around an empty cream disc) was generated and dropped in
`docs/design/` on 2026-09-05.

## Decision

### 1. A frame is a bitmap behind the avatar emoji

- Seven frames cut by `docs/design/cut-frames.py` into `data/frames/<id>.png`
  (felt and page white keyed to alpha, the cream disc kept — it is the disc
  the emoji sits on, so a framed avatar reads as a badge). 10–17 KB each.
- The avatar stays what it was, an emoji in a span. `applyFrame` in
  `ui/src/frames.ts` gives that span the `framed` class and the frame's PNG as
  its background, fitted; the CSS sizes the badge per context (44 px on the
  profile row where the bare glyph was 32 px, 30 px in a leaderboard row) so
  a framed avatar takes no more room than a bare one did.
- Shown on the profile row in Settings, in the shop's own preview (the
  player's current avatar wearing each frame), and on every leaderboard row.
  Not on the avatar picker in the profile screen: that chooses the emoji, not
  the frame, and the frame is chosen in the shop.

### 2. Containment: the id never reaches the page

The rule, in one sentence: **a frame id is a key into `FRAMES`, and only what
the table holds reaches a URL, a class or an attribute.** Concretely:

- The client resolves every id — the record's own or another player's from a
  board row — through `frameFor`, which returns the default for anything not
  in the table. `frameUrl` takes a table entry, not an id, so it cannot build
  a URL from user input. `applyFrame` is the one DOM writer and calls both.
  A test feeds it `javascript:`, `url("…")`, path traversal and case variants
  and checks nothing but a table URL, or nothing at all, is written.
- The Worker adds one column to a board row, `json_extract(p.looks, '$.frame')`,
  and sends it only if it matches the cosmetic-id shape (`/^[a-z][a-z0-9-]{0,31}$/`,
  the same regex `validateRecord` already applied on the way in); otherwise the
  default. That is belt and braces — the stored value already passed the
  regex — but a row read from D1 should not trust a write path it cannot see.
- Nothing else of `looks` leaves a player's own account: felts, backs and
  glyph sets are not on the board and are not sent.

### 3. Compatibility

`BoardEntry.frame` is required on the client type but tolerated absent on
the wire: a client built after this change reading a Worker deployed before it
sees no `frame` and draws no frame. `looks.frame` joins `looks` under the same
stamp and rules; `DEFAULT_LOOKS` is `{ back, felt, frame, glyphs }`, sorted.

### 4. Shop

An **Avatar frames** fieldset after the backs, one `ShopRow` per frame, spoken
as "<name> avatar frame". Prices are the issue's tiers until the PM sets final
ones: Gold Ring 10, Jade Square 10, Vermilion Double 25, Wave 25, Lantern 25,
Plum 60, Dragon 60.

## Alternatives considered

- **Send the whole `looks` object in a board row.** Exposes picks nobody can
  see and widens the cross-user surface for no reason. Rejected.
- **Render frames as CSS classes (`frame-<id>`).** Puts the id into a class
  name; safe only while the regex holds and the class list is closed. The
  table lookup makes the containment structural rather than lexical. Rejected.
- **A vector ring in CSS per frame.** Was the plan before the sheet existed;
  the generated motifs (lantern, dragon, blossoms) are not CSS shapes, and one
  mechanism for all seven is simpler than two.

## Consequences

- `Looks` is `{ back, felt, frame, glyphs, …unknown }`; fixtures gained
  `frame: 'lantern'`.
- One Worker read-path change (a column and a regex); no schema change.
- Issue #229 is complete once this lands. Open PM calls carried from
  0038–0040: final prices (a change is a new item id), off-palette glyph
  pixels, Calligraphy pips small at tile size.
