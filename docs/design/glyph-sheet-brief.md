# Glyph prompts for Lantern Tiles purchasable sets

Two prompts, one per set. Copy everything between `=== COPY FROM HERE ===` and
`=== COPY TO HERE ===`. One paste, one sheet of 38 glyphs.

The 2026-09-05 Set A attempt got Dots and Bamboo right, then failed on the
rest: numerals in the wrong ink, a 萬 added under every numeral, and rows 4 to
6 (Winds, Dragons, Seasons) never drawn. Both prompts below name every row and
every cell explicitly and say the sheet is incomplete without all six rows.

After a sheet comes back: check all six rows exist, count pips against the
prompt, reject gradients or shading, cut on the cell grid, key out the cream
`#fdf6e3`, and name each file by its label.

Reference values come from `ui/src/faces.ts` and `ui/src/geometry.ts`: face
cream `#fdf6e3`, tile ratio 64:84, inks blue `#1e40af`, pine `#1a6b52`, red
`#b91c1c`, slate `#334155`, russet `#92400e`, teal `#0e7490`.


############################################################################
#                                                                          #
#                         SET A  ·  CALLIGRAPHY                             #
#                                                                          #
############################################################################

=== COPY FROM HERE ===
Draw one sprite sheet of 38 mahjong tile-face glyphs for the "Calligraphy" glyph set of the game Lantern Tiles. The sheet is a grid of 6 rows by 9 columns. Rows 1 to 3 fill all 9 columns. Row 4 uses 4 columns, row 5 uses 3, row 6 uses 4; leave the remaining cells in those rows empty. The sheet is incomplete and wrong if any of the 6 rows is missing.

STYLE
Everything written with one loaded brush: visible entry and exit strokes, slight taper, single confident passes, no outlines around fills. Legible first, expressive second. One stroke weight and one level of detail across every cell.

LAYOUT
Each cell is 256 x 336 px with a 16 px gutter. Output the largest landscape image you can. Flat cream background #fdf6e3 across the whole image: no texture, no vignette, no tile body, no border, no shadow. Artwork only, centred inside a 200 x 260 px safe area in each cell. Below each glyph write its label in small grey text exactly as given.

COLOURS
Flat fills and strokes only. No gradients, no shading, no tints. Use only these inks: blue #1e40af, pine #1a6b52, red #b91c1c, slate #334155, russet #92400e, teal #0e7490, and cream #fdf6e3 for knock-outs. Each row says which inks it may use.

ROW 1, DOTS. Labels A-dots-1 to A-dots-9. Inks: blue, pine, red.
Each pip is an open brush ring in blue, drawn in one pass, with an accent colour as a heavier second sweep on the right side of the ring. The accent never covers more than half the ring.
1: one large ring, red accent
2: two rings stacked vertically, pine accents
3: three rings on a diagonal, middle ring red accent, outer rings pine accent
4: four rings in the corners, all pine accent
5: four corner rings pine accent plus a centre ring red accent
6: two columns of three, middle row red accent, top and bottom rows pine accent
7: one ring top centre, then two rows of three below; middle row red accent, top ring and bottom row pine accent
8: two columns of four, all pine accent
9: three by three, middle row red accent, top and bottom rows pine accent

ROW 2, BAMBOO. Labels A-bamboo-1 to A-bamboo-9. Inks: pine, red.
Each cane is two brushed segments meeting at a waist, like a fast 竹 stroke. No node line. A whole cane is one colour, never part of one.
1: one large cane, pine
2: two canes stacked vertically, pine
3: one cane over two, top cane red, the other two pine
4: two by two, all pine
5: four corner canes pine plus a centre cane red
6: two rows of three, bottom row red, top row pine
7: one cane over two rows of three, top cane red, the rest pine
8: two rows of four, all pine
9: three rows of three, middle row red, top and bottom rows pine

ROW 3, CHARACTERS. Labels A-char-1 to A-char-9. Ink: red only.
One Chinese numeral per cell in a bold kaisho or semi-cursive brush hand, red ink. The numeral is the whole glyph. Do NOT add 萬 or any second character under it. Do NOT use blue.
1: 一   2: 二   3: 三   4: 四   5: 五   6: 六   7: 七   8: 八   9: 九

ROW 4, WINDS. Labels A-wind-east, A-wind-south, A-wind-west, A-wind-north. Ink: slate only.
One character per cell, same brush hand as row 3, slate ink. Nothing else in the cell.
east: 東   south: 南   west: 西   north: 北

ROW 5, DRAGONS. Labels A-dragon-red, A-dragon-green, A-dragon-white.
Brush-drawn pictures, not characters. Three clearly different silhouettes, never the same drawing recoloured. One ink each.
red dragon: a dragon head in profile, mouth open, whiskers and mane in a few brush strokes, red ink
green dragon: a coiled dragon body with the head at one end, pine ink
white dragon: a flaming pearl inside a ring, slate ink

ROW 6, SEASONS. Labels A-season-spring, A-season-summer, A-season-fall, A-season-winter.
One brushed motif per cell, each a different silhouette, one ink each.
spring: a blossom branch, pine ink
summer: a sun, red ink
fall: a single falling leaf, russet ink
winter: a snowflake, teal ink

RULES
Minimum stroke width 14 px. Every glyph must be identifiable in greyscale and at 25% scale. Every character must be the correct character and readable. Do not copy or resemble any existing commercial mahjong tile set or Unicode mahjong emoji. No text inside the artwork other than the characters listed. Before finishing, confirm all 6 rows and all 38 labelled cells are present.
=== COPY TO HERE ===


############################################################################
#                                                                          #
#                           SET B  ·  FANTASY                               #
#                                                                          #
############################################################################

Attach the sleeping white dragon and gem-pip cells from the 2026-09-05 sheet
as the style anchor.

=== COPY FROM HERE ===
Draw one sprite sheet of 38 mahjong tile-face glyphs for the "Fantasy" glyph set of the game Lantern Tiles. The sheet is a grid of 6 rows by 9 columns. Rows 1 to 3 fill all 9 columns. Row 4 uses 4 columns, row 5 uses 3, row 6 uses 4; leave the remaining cells in those rows empty. The sheet is incomplete and wrong if any of the 6 rows is missing.

STYLE
Storybook carved-jade feel: bold flat silhouettes, chunky shapes, small stylised details, like enamel-pin or board-game-token art. Solid fills with cream knock-outs for detail, at most three interior details per glyph. Match the attached reference cells. One level of detail across every cell.

LAYOUT
Each cell is 256 x 336 px with a 16 px gutter. Output the largest landscape image you can. Flat cream background #fdf6e3 across the whole image: no texture, no vignette, no tile body, no border, no shadow. Artwork only, centred inside a 200 x 260 px safe area in each cell. Below each glyph write its label in small grey text exactly as given.

COLOURS
Flat fills only. No gradients, no shading, no tints. Use only these inks: blue #1e40af, pine #1a6b52, red #b91c1c, slate #334155, russet #92400e, teal #0e7490, and cream #fdf6e3 for knock-outs. Each row says which inks it may use.

ROW 1, DOTS. Labels B-dots-1 to B-dots-9. Inks: blue, pine, red.
Each pip is a faceted gemstone in blue with flat-colour facets. The accent colour is one facet on the right side, never the whole gem, never more than half of it.
1: one large gem, red accent facet
2: two gems stacked vertically, pine accent facets
3: three gems on a diagonal, middle gem red accent, outer gems pine accent
4: four gems in the corners, all pine accent
5: four corner gems pine accent plus a centre gem red accent
6: two columns of three, middle row red accent, top and bottom rows pine accent
7: one gem top centre, then two rows of three below; middle row red accent, top gem and bottom row pine accent
8: two columns of four, all pine accent
9: three by three, middle row red accent, top and bottom rows pine accent

ROW 2, BAMBOO. Labels B-bamboo-1 to B-bamboo-9. Inks: pine, red.
Each cane is a short carved stave with simple capped ends, one solid colour, no inner lines. A whole cane is one colour, never part of one.
1: one large stave, pine
2: two staves stacked vertically, pine
3: one stave over two, top stave red, the other two pine
4: two by two, all pine
5: four corner staves pine plus a centre stave red
6: two rows of three, bottom row red, top row pine
7: one stave over two rows of three, top stave red, the rest pine
8: two rows of four, all pine
9: three rows of three, middle row red, top and bottom rows pine

ROW 3, CHARACTERS. Labels B-char-1 to B-char-9. Ink: red only.
One Chinese numeral per cell as a chunky carved form with a uniform stroke and slightly rounded ends, red ink, still unmistakably the correct character. The numeral is the whole glyph. Do NOT add 萬 or any second character under it. Do NOT use blue.
1: 一   2: 二   3: 三   4: 四   5: 五   6: 六   7: 七   8: 八   9: 九

ROW 4, WINDS. Labels B-wind-east, B-wind-south, B-wind-west, B-wind-north. Ink: slate only.
One character per cell, same carved treatment as row 3, slate ink. Nothing else in the cell.
east: 東   south: 南   west: 西   north: 北

ROW 5, DRAGONS. Labels B-dragon-red, B-dragon-green, B-dragon-white.
Full-figure fantasy creatures as solid-fill silhouettes with cream knock-outs for the eye and detail, at most three interior details each. Three clearly different poses, never the same drawing recoloured. Match the attached sleeping white dragon exactly in style. One ink each.
red dragon: rearing up, mane or wings spread wide, solid red
green dragon: serpentine body coiled around itself, head resting on top, solid pine
white dragon: curled asleep around a pearl, solid slate with cream knock-outs

ROW 6, SEASONS. Labels B-season-spring, B-season-summer, B-season-fall, B-season-winter.
One emblem per cell as a solid silhouette with cream knock-outs, each a different shape, one ink each.
spring: a sprouting seed with two leaves, pine ink
summer: a blazing sun with a calm face, red ink
fall: an acorn, russet ink
winter: a crystal, teal ink

RULES
Minimum fill width 14 px. Every glyph must be identifiable in greyscale and at 25% scale. Every character must be the correct character and readable. Do not copy or resemble any existing commercial mahjong tile set or Unicode mahjong emoji. No text inside the artwork other than the characters listed. Before finishing, confirm all 6 rows and all 38 labelled cells are present.
=== COPY TO HERE ===
