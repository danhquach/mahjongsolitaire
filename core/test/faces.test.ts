// The suit half of a face id (issue #183): the Daily's suit challenges count
// matches by suit, and this is the one place that knows how a face id is spelt.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STANDARD_144, faceSuit } from '../src/faces.js';

test('faceSuit reads the suit off every face in the standard set', () => {
  const counts = new Map<string, number>();
  for (const face of STANDARD_144) {
    const suit = faceSuit(face);
    counts.set(suit, (counts.get(suit) ?? 0) + 1);
  }
  // Spec §3.4: 36 Dots, 36 Bamboo, 36 Characters, 16 Winds, 12 Dragons, 8 Seasons.
  assert.deepEqual(Object.fromEntries([...counts].sort()), {
    bamboo: 36,
    char: 36,
    dots: 36,
    dragon: 12,
    season: 8,
    wind: 16,
  });
});

test('faceSuit rejects a face id it does not know', () => {
  assert.throws(() => faceSuit('flower-plum'), RangeError);
  assert.throws(() => faceSuit('dots'), RangeError);
  assert.throws(() => faceSuit('dots-'), RangeError);
  assert.throws(() => faceSuit(''), RangeError);
});
