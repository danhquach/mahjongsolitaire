// The cosmetics shop (issue #229, decision 0038): what is for sale, what a
// record can afford, and the one way an item is bought. Nothing here deducts
// from `trophies` — the balance is derived from what is owned, so the record's
// never-regress merge cannot undo a purchase or refund one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_RECORD, RecordStore } from '../src/profile.js';
import type { PlayerRecord } from '../src/profile.js';
import {
  GLYPH_SETS,
  SHOP_ITEMS,
  affordability,
  glyphSetFor,
  itemPrice,
  purchase,
  trophyBalance,
} from '../src/shop.js';

const withRecord = (patch: Partial<PlayerRecord>): PlayerRecord => ({ ...EMPTY_RECORD, ...patch });

test('the shop sells the two drawn glyph sets at the issue’s proposed prices', () => {
  assert.deepEqual(
    SHOP_ITEMS.map((i) => [i.id, i.kind, i.price]),
    [
      ['glyphs-calligraphy', 'glyphs', 25],
      ['glyphs-fantasy', 'glyphs', 60],
    ],
  );
  // Every item has something to show and say.
  for (const item of SHOP_ITEMS) {
    assert.ok(item.label.length > 0 && item.description.length > 0, item.id);
  }
  // Ids are unique and plausible record ids.
  assert.equal(new Set(SHOP_ITEMS.map((i) => i.id)).size, SHOP_ITEMS.length);
  for (const item of SHOP_ITEMS) assert.match(item.id, /^[a-z][a-z0-9-]{0,31}$/);
});

test('every purchasable glyph set has art metadata, and the default is free and not for sale', () => {
  assert.equal(GLYPH_SETS['lantern']!.dir, null, 'the default is drawn, not loaded');
  for (const item of SHOP_ITEMS.filter((i) => i.kind === 'glyphs')) {
    const set = GLYPH_SETS[item.id];
    assert.ok(set, `${item.id} has a glyph set`);
    assert.match(set!.dir!, /^[a-z]+$/);
    assert.equal(set!.label, item.label);
  }
  assert.equal(SHOP_ITEMS.some((i) => i.id === 'lantern'), false);
});

test('glyphSetFor resolves a shipped id and falls back to Lantern for anything else', () => {
  assert.equal(glyphSetFor('glyphs-fantasy').id, 'glyphs-fantasy');
  assert.equal(glyphSetFor('lantern').id, 'lantern');
  assert.equal(glyphSetFor('glyphs-from-the-future').id, 'lantern');
});

test('the balance is trophies less the price of everything owned, floored at zero', () => {
  assert.equal(trophyBalance(withRecord({ trophies: 30 })), 30);
  assert.equal(trophyBalance(withRecord({ trophies: 30, owned: ['glyphs-calligraphy'] })), 5);
  assert.equal(trophyBalance(withRecord({ trophies: 90, owned: ['glyphs-calligraphy', 'glyphs-fantasy'] })), 5);
  // An id this build does not price costs nothing here; a re-priced record
  // can go negative on paper and reads as 0, never as a debt.
  assert.equal(trophyBalance(withRecord({ trophies: 10, owned: ['future-item'] })), 10);
  assert.equal(trophyBalance(withRecord({ trophies: 10, owned: ['glyphs-fantasy'] })), 0);
  assert.equal(itemPrice('future-item'), 0);
  assert.equal(itemPrice('glyphs-fantasy'), 60);
});

test('affordability says owned, affordable, or exactly how many trophies short', () => {
  assert.deepEqual(affordability(withRecord({ trophies: 30, owned: ['glyphs-calligraphy'] }), 'glyphs-calligraphy'), {
    state: 'owned',
  });
  assert.deepEqual(affordability(withRecord({ trophies: 30 }), 'glyphs-calligraphy'), { state: 'affordable' });
  assert.deepEqual(affordability(withRecord({ trophies: 30 }), 'glyphs-fantasy'), { state: 'locked', short: 30 });
  // Owning one set spends down what the other can be bought with.
  assert.deepEqual(affordability(withRecord({ trophies: 80, owned: ['glyphs-calligraphy'] }), 'glyphs-fantasy'), {
    state: 'locked',
    short: 5,
  });
});

test('purchase spends the balance once, refuses a short balance and a repeat, and changes nothing else', () => {
  const record = new RecordStore();
  assert.equal(purchase(record, 'glyphs-fantasy'), false, 'nothing to spend');
  assert.deepEqual(record.value, EMPTY_RECORD);

  record.adopt(withRecord({ trophies: 85 }));
  assert.equal(purchase(record, 'glyphs-fantasy'), true);
  assert.deepEqual(record.value.owned, ['glyphs-fantasy']);
  assert.equal(record.value.trophies, 85, 'trophies are never deducted; the balance is derived');
  assert.equal(trophyBalance(record.value), 25);
  assert.equal(purchase(record, 'glyphs-fantasy'), false, 'already owned');
  assert.equal(purchase(record, 'glyphs-calligraphy'), true, 'exactly affordable');
  assert.equal(trophyBalance(record.value), 0);
  // Buying picks nothing: the look is a separate, deliberate tap.
  assert.deepEqual(record.value.looks, { glyphs: 'lantern' });
  assert.equal(purchase(record, 'not-for-sale'), false);
});
