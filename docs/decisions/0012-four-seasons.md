# 0012 — Four seasons replace Flowers: distinct pictogram art per season

**Date:** 2026-08-31 · **Status:** accepted; the corner tag (1–4) is superseded by [0023](0023-no-corner-tags-dragon-inks.md) · **Ticket:** issue #75

## Context

QA session, 2026-08-31: the Season tiles read as "blue snow" — the teal `❋`
glyph carries no season meaning, and Flower (`✿` orange) vs Season (`❋` teal)
differ mostly by color, which is against the spirit of the colorblind-safe
"never color alone" rule (spec §7). PM direction: drop the Flower suit, extend
Seasons to the four real seasons, and make each one visually distinctive.

The swap is count-neutral: 4 Flowers + 4 Seasons (8 tiles) become 4 seasons
× 2 identical copies (8 tiles). The 144-tile standard set and the
identical-only matching rule (decision 0005) are untouched.

## Decision

1. **Faces.** `flower-1|2` and `season-1|2` are removed. New faces:
   `season-spring`, `season-summer`, `season-fall`, `season-winter`, two
   identical copies each. Standard 144 becomes: 36 Dots, 36 Bamboo,
   36 Characters, 16 Winds, 12 Dragons, 8 Seasons.
2. **Matching.** Identical-only, unchanged — spring matches spring only. No
   wildcard season group (decision 0005 stands).
3. **Art.** Each season is a composed face, not a single glyph: one large
   Unicode pictogram, two small scattered companions, the season name in small
   text below, and the corner tag 1–4 (traditional order):
   - Spring — `❀` + two small `❀`, name "Spring"
   - Summer — `☀` + two small `✦`, name "Summer"
   - Fall — `❧` rotated ~24° + two small rotated `❧` (falling), name "Fall"
   - Winter — `❄` + small `❅` and `❆`, name "Winter"
4. **Colors.** One distinctive ink per season, all reused from the proven suit
   palette so the ink set stays closed (no new contrast proofs): spring = pine
   `0x1a6b52`, summer = red `0xb91c1c`, fall = orange `0xc2410c` (freed by the
   Flower removal), winter = teal `0x0e7490`. Color never carries meaning
   alone: shape, name text, and tag are the identity; the colorblind-safe rule
   is satisfied without the color.
5. **Accessibility.** ARIA labels become "Season Spring" … "Season Winter".
6. **Renderer.** The tile face renderer grows a composed-glyph face style
   (primary glyph + positioned secondary glyphs + name text) alongside the
   existing single-glyph and pip styles. Positions are in the same unit face
   coordinates the pips use.

## Consequences

- `standard_144` face generation, the UI face-style table, and every fixture
  or test that names `flower-*`/`season-*` faces change together.
- Spec §"identical face match" and the 144 composition line are updated;
  decision 0005's examples reference the new face ids.
- Save compatibility: a saved game holding old `flower-*`/`season-*` face ids
  is discarded on reopen. This ticket **closed a gap** here: the save-state
  snapshot (decision 0007) validated tile counts and ids but not face ids, so
  a stale save would have resumed with unknown-face `?` tiles — `applySnapshot`
  now rejects any snapshot face the deal does not contain. Acceptable for a
  pre-release game, called out in QA.
- Season colors overlap other suits (spring ≈ Bamboo pine, summer = Characters
  red, fall = old Flower orange). Accepted: identity is carried by the
  pictogram composition and name text, and the corner tag disambiguates at a
  glance, same as every other suit.
- Small-size legibility of the name text and scatter glyphs at board tile
  size is the main visual risk — verify on the smallest rendered tile
  (deep-layer dimming included) during QA.
