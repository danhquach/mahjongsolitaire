// Issue #35: per-rank pip faces — every suited rank must be visually distinct.
// Issue #45 redrew the pip shapes (Dots rings, Bamboo canes) and added the
// traditional red/green banding; the banding rule is pinned at the bottom.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faceStyle } from '../src/faces.js';
import {
  PIP_AREA,
  SEASON_GLYPH_POS,
  SEASON_GLYPH_SIZE,
  SEASON_NAME_POS,
  SEASON_NAME_SIZE,
  SEASON_SCATTER_SIZE,
  TAG_BOX,
  TAG_FONT_SIZE,
} from '../src/pips.js';

test('dots ranks 1-9 draw exactly N ring pips', () => {
  for (let rank = 1; rank <= 9; rank++) {
    const s = faceStyle(`dots-${rank}`);
    assert.equal(s.pipShape, 'ring');
    assert.equal(s.pips?.length, rank, `dots-${rank}`);
  }
});

test('bamboo ranks 1-9 draw exactly N cane pips', () => {
  for (let rank = 1; rank <= 9; rank++) {
    const s = faceStyle(`bamboo-${rank}`);
    assert.equal(s.pipShape, 'cane');
    assert.equal(s.pips?.length, rank, `bamboo-${rank}`);
  }
});

test('char ranks 1-9 use the rank numeral as the glyph (no 萬)', () => {
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  for (let rank = 1; rank <= 9; rank++) {
    const s = faceStyle(`char-${rank}`);
    assert.equal(s.glyph, numerals[rank - 1], `char-${rank}`);
  }
});

test('per-rank face output differs across ranks within each suit', () => {
  for (const suit of ['dots', 'bamboo', 'char']) {
    const seen = new Set<string>();
    for (let rank = 1; rank <= 9; rank++) {
      const s = faceStyle(`${suit}-${rank}`);
      seen.add(JSON.stringify({ pips: s.pips, glyph: s.glyph }));
    }
    assert.equal(seen.size, 9, suit);
  }
});

test('pip positions stay inside the unit face area', () => {
  for (const suit of ['dots', 'bamboo']) {
    for (let rank = 1; rank <= 9; rank++) {
      for (const pip of faceStyle(`${suit}-${rank}`).pips ?? []) {
        assert.ok(pip.x > 0 && pip.x < 1 && pip.y > 0 && pip.y < 1, `${suit}-${rank}`);
      }
    }
  }
});

test('honors and season tiles keep their distinct glyphs (no pips)', () => {
  for (const face of ['wind-east', 'dragon-red', 'season-spring', 'season-winter']) {
    const s = faceStyle(face);
    assert.equal(s.pips, undefined, face);
    assert.notEqual(s.glyph, '?');
  }
});

// --- issue #75 / decision 0012: four composed Season faces ---------------------

const SEASON_FACES = ['season-spring', 'season-summer', 'season-fall', 'season-winter'];

test('each season is a composed face: pictogram, two scatter glyphs, name, tag 1-4', () => {
  const names = ['Spring', 'Summer', 'Fall', 'Winter'];
  SEASON_FACES.forEach((face, i) => {
    const s = faceStyle(face);
    assert.equal(s.name, names[i], face);
    assert.equal(s.tag, String(i + 1), `${face} tag follows the traditional 1-4 order`);
    assert.equal(s.label, `Season ${names[i]}`, face);
    assert.equal(s.scatter?.length, 2, `${face} carries two scatter glyphs`);
    assert.notEqual(s.glyph, '?');
  });
});

test('season identity is never color alone: pictogram+name differ even where inks repeat', () => {
  // Inks are reused from the proven suit palette (decision 0012), so two
  // seasons may share a color with another suit — the composed art is the
  // identity. Pin that every season differs from every other in shape+name.
  const seen = new Set(
    SEASON_FACES.map((f) => {
      const s = faceStyle(f);
      return JSON.stringify({ glyph: s.glyph, name: s.name, scatter: s.scatter });
    }),
  );
  assert.equal(seen.size, 4);
});

test('composed season art stays inside the pip area and clear of the corner tag', () => {
  // The lesson pips.ts opens with: face art sized inline can overflow the tile
  // and nothing throws. So bound the season text the way pips.test.ts bounds
  // pip art — approximate glyph boxes from the type sizes (a bold sans glyph is
  // ~1em square; a word runs ~0.65em per character) and assert containment.
  const box = (cx: number, cy: number, w: number, h: number) => ({
    x0: cx - w / 2,
    y0: cy - h / 2,
    x1: cx + w / 2,
    y1: cy + h / 2,
  });
  const inArea = (b: ReturnType<typeof box>, what: string) => {
    assert.ok(b.x0 >= PIP_AREA.x - 0.5 && b.x1 <= PIP_AREA.x + PIP_AREA.w + 0.5, `${what} x`);
    assert.ok(b.y0 >= PIP_AREA.y - 0.5 && b.y1 <= PIP_AREA.y + PIP_AREA.h + 0.5, `${what} y`);
  };
  const clearOfTag = (b: ReturnType<typeof box>, what: string) => {
    const overlaps =
      b.x0 < TAG_BOX.x + TAG_BOX.w && b.x1 > TAG_BOX.x && b.y0 < TAG_BOX.y + TAG_BOX.h && b.y1 > TAG_BOX.y;
    assert.ok(!overlaps, `${what} rides under the corner tag`);
  };
  const at = (x: number, y: number) => ({
    cx: PIP_AREA.x + x * PIP_AREA.w,
    cy: PIP_AREA.y + y * PIP_AREA.h,
  });
  for (const face of SEASON_FACES) {
    const s = faceStyle(face);
    const glyph = at(SEASON_GLYPH_POS.x, SEASON_GLYPH_POS.y);
    const glyphBox = box(glyph.cx, glyph.cy, SEASON_GLYPH_SIZE, SEASON_GLYPH_SIZE);
    inArea(glyphBox, `${face} pictogram`);
    clearOfTag(glyphBox, `${face} pictogram`);
    for (const g of s.scatter!) {
      const c = at(g.x, g.y);
      const b = box(c.cx, c.cy, SEASON_SCATTER_SIZE, SEASON_SCATTER_SIZE);
      inArea(b, `${face} scatter`);
      clearOfTag(b, `${face} scatter`);
    }
    const name = at(SEASON_NAME_POS.x, SEASON_NAME_POS.y);
    const nameBox = box(name.cx, name.cy, s.name!.length * 0.65 * SEASON_NAME_SIZE, SEASON_NAME_SIZE);
    inArea(nameBox, `${face} name`);
    clearOfTag(nameBox, `${face} name`);
  }
});

test('season name text never shrinks below 70% of the corner-tag size', () => {
  // The tag is the established smallest-legible type on a tile; the name is a
  // whole word (more shape per point) so it may run smaller — but this is the
  // floor QA confirmed legible at the smallest rendered tile, pinned so a
  // future retheme cannot silently regress it (decision 0012's stated risk).
  assert.ok(SEASON_NAME_SIZE >= 0.7 * TAG_FONT_SIZE);
  assert.ok(SEASON_SCATTER_SIZE >= 0.6 * TAG_FONT_SIZE);
});

test('flower faces no longer exist', () => {
  const s = faceStyle('flower-1');
  assert.equal(s.glyph, '?');
});

// --- issue #45: traditional red/green banding ---------------------------------

/** Distinct band positions along one axis, in the order they appear on screen. */
const bands = (pips: readonly { x: number; y: number; accent?: number }[], axis: 'x' | 'y') =>
  [...new Set(pips.map((p) => Math.round(p[axis] * 100)))].sort((a, b) => a - b);

/** The accent every pip in a given band carries (asserts the band is uniform). */
function bandAccents(
  pips: readonly { x: number; y: number; accent?: number }[],
  axis: 'x' | 'y',
): (number | undefined)[] {
  return bands(pips, axis).map((band) => {
    const inBand = pips.filter((p) => Math.round(p[axis] * 100) === band);
    const accents = new Set(inBand.map((p) => p.accent));
    assert.equal(accents.size, 1, `band ${band} on ${axis} is not one colour`);
    return inBand[0]!.accent;
  });
}

test('rank 9 reproduces the traditional banding: dots by row, bamboo by column', () => {
  // The reference case, and the reason the rule is per-axis: Dots-9 reads
  // green / red / green down its three rows, Bamboo-9 across its three columns.
  const dots = bandAccents(faceStyle('dots-9').pips!, 'y');
  const bamboo = bandAccents(faceStyle('bamboo-9').pips!, 'x');
  assert.equal(dots.length, 3);
  assert.equal(bamboo.length, 3);
  assert.equal(dots[0], dots[2], 'outer rows share the green accent');
  assert.notEqual(dots[1], dots[0], 'the middle row is the red one');
  assert.equal(bamboo[0], bamboo[2], 'outer columns share the green accent');
  assert.notEqual(bamboo[1], bamboo[0], 'the middle column is the red one');
});

test('every pip carries an accent, and only two accents are ever used', () => {
  const accents = new Set<number>();
  for (const suit of ['dots', 'bamboo']) {
    for (let rank = 1; rank <= 9; rank++) {
      const pips = faceStyle(`${suit}-${rank}`).pips!;
      assert.ok(pips.length > 0, `${suit}-${rank}`);
      for (const pip of pips) {
        assert.equal(typeof pip.accent, 'number', `${suit}-${rank} pip has no accent`);
        accents.add(pip.accent!);
      }
    }
  }
  assert.equal(accents.size, 2, `expected exactly red and green, got ${accents.size}`);
});

test('an even number of bands has no middle, so it stays all green', () => {
  // Dots-8 is a 2x4 grid: four rows, no middle one. Picking a side would be
  // arbitrary, so the rank is uniform instead.
  const rows = bandAccents(faceStyle('dots-8').pips!, 'y');
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows).size, 1, 'four rows must not invent a middle');
});

test('banding never carries meaning: two ranks can share an accent pattern', () => {
  // Colour is decoration here (spec §7 is shape-first): what distinguishes
  // ranks is the pip count and layout, asserted above. This pins the intent so
  // nobody later reads the accent as a rank cue.
  const four = bandAccents(faceStyle('dots-4').pips!, 'y');
  const eight = bandAccents(faceStyle('dots-8').pips!, 'y');
  assert.equal(new Set(four).size, 1);
  assert.equal(new Set(eight).size, 1);
  assert.notEqual(faceStyle('dots-4').pips!.length, faceStyle('dots-8').pips!.length);
});
