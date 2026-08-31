// Issue #35: per-rank pip faces — every suited rank must be visually distinct.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faceStyle } from '../src/faces.js';

test('dots ranks 1-9 draw exactly N dot pips', () => {
  for (let rank = 1; rank <= 9; rank++) {
    const s = faceStyle(`dots-${rank}`);
    assert.equal(s.pipShape, 'dot');
    assert.equal(s.pips?.length, rank, `dots-${rank}`);
  }
});

test('bamboo ranks 1-9 draw exactly N stick pips', () => {
  for (let rank = 1; rank <= 9; rank++) {
    const s = faceStyle(`bamboo-${rank}`);
    assert.equal(s.pipShape, 'stick');
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

test('honors and bonus tiles keep their distinct glyphs (no pips)', () => {
  for (const face of ['wind-east', 'dragon-red', 'flower-1', 'season-2']) {
    const s = faceStyle(face);
    assert.equal(s.pips, undefined, face);
    assert.notEqual(s.glyph, '?');
  }
});
