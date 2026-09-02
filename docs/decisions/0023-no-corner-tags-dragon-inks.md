# 0023 — Faces carry identity in their art alone: no corner tags, Dragons in their own inks

**Date:** 2026-09-02 · **Status:** accepted · **Ticket:** issue #152

## Context

Every face carried a small corner tag — the rank for suited tiles, an initial
for Winds and Dragons, a 1–4 numeral for the Seasons (decision 0012) — so that
"identical faces are matchable at a glance". On a portrait phone it did the
opposite. Upper-layer tiles cover most of a neighbour's face, so the corner tag
was often the only ink still visible, and players matched by it: the West Wind
(西) and the White Dragon (囗) both tagged **W**, and two "W" tiles are not a
pair. The tags also cost face area on tiles that are already small, and the
White Dragon's 囗 read as a missing-glyph box rather than a designed face.

## Decision

1. **No corner tags.** The `tag` field is removed from the face style, not
   blanked; nothing on a face is drawn from it. This supersedes the "identity
   is carried by shape, name and tag" wording of decision 0012 and the
   Seasons' numeric tag; decision 0002's art direction (shape-first,
   colour-second, numerals always paired with suit symbols) stands.
2. **Every distinct face is unique in (art, colour) on its own.** Pinned by a
   unit test over the 38 distinct faces of the 144-tile set; in particular no
   two single-glyph faces share a glyph-and-colour pair.
3. **The art takes the freed room.** The face-art area is centred at ~80% of
   the tile width × ~83% of its height. Font glyphs (Characters, Winds, typed
   Dragons) grow from 42% to 52% of the tile height. Dots rings take a stroke
   of ≈ 0.7 of their radius (was ≈ 0.42). Bamboo canes take ≈ 0.42 of the
   column pitch, capped at 21% of the area width so ranks 1–3 share one width,
   with flared end caps and a face-coloured waist node. Row/column banding is
   unchanged. Rank 9 rings and rank 8 canes keep visible gaps (pinned).
4. **Dragons: one ink and one shape each; the shared purple is retired.**
   Red Dragon 中 in the Characters red; Green Dragon 發 in the Bamboo pine;
   White Dragon a *drawn* double frame — a white-filled rounded rectangle
   (~50% × ~58% of the tile) with a slate outline (~4.5% of the tile width)
   and a thin inner outline at ~45% of that weight. The white fill is what
   reads as "white" on the cream face.
5. **Colour sharing is safe** under the "never colour alone" rule because the
   shapes never collide: a Dragon is a single character or a frame, a
   Character is always a numeral, Bamboo is always canes, a Wind is always one
   of its four characters. Colour now helps identify a Dragon rather than
   misleading. The ink set stays closed — every ink on a face was already in
   the proven palette, so the 4.5:1 depth sweep needed no new colour.
6. **Accessible names are unchanged.**

## Consequences

- `ui/src/faces.ts`, `pips.ts` and `render.ts` change together; the corner-tag
  geometry (`TAG_*`) and its containment tests are removed rather than kept as
  dead constants. The Season name text is now the smallest ink on any face and
  keeps its size (14% of the tile height, pinned).
- The holder strip's tile pictures and the tutorial spotlight pick the change
  up for free — both draw from the same renderer.
- Visual risk: the smallest portrait-phone tile. The gaps in Dots-9 and
  Bamboo-8 and the White Dragon's inner outline were checked at 360 CSS px
  portrait in QA for the ticket.
- Decision 0012's "corner tag disambiguates at a glance" consequence no longer
  holds; each Season is identified by its pictogram composition and name.
