// Booster charge accounting and persistence (issue #13, spec §5).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOOSTER_KINDS,
  BoosterCharges,
  CHARGES_STORAGE_KEY,
  STARTING_GRANT,
} from '../src/boosters.js';
import type { ChargeStorage } from '../src/boosters.js';

/** In-memory stand-in for localStorage; `store` is the persisted record. */
function fakeStorage(seed?: string): ChargeStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(CHARGES_STORAGE_KEY, seed);
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

test('every booster starts at the granted charge count', () => {
  const charges = new BoosterCharges();
  for (const kind of BOOSTER_KINDS) {
    assert.equal(charges.remaining(kind), STARTING_GRANT);
    assert.equal(charges.has(kind), true);
  }
});

test('spending decrements only the booster used', () => {
  const charges = new BoosterCharges();
  assert.equal(charges.spend('hint'), true);
  assert.equal(charges.remaining('hint'), STARTING_GRANT - 1);
  assert.equal(charges.remaining('undo'), STARTING_GRANT);
  assert.equal(charges.remaining('shuffle'), STARTING_GRANT);
});

test('a booster at zero cannot be spent again and never goes negative', () => {
  const charges = new BoosterCharges();
  for (let i = 0; i < STARTING_GRANT; i++) assert.equal(charges.spend('undo'), true);
  assert.equal(charges.remaining('undo'), 0);
  assert.equal(charges.has('undo'), false);
  assert.equal(charges.spend('undo'), false);
  assert.equal(charges.remaining('undo'), 0);
});

test('charges persist across restarts', () => {
  const storage = fakeStorage();
  const first = new BoosterCharges(storage);
  first.spend('hint');
  first.spend('hint');
  first.spend('shuffle');

  // A restart is a fresh instance over the same storage.
  const resumed = new BoosterCharges(storage);
  assert.equal(resumed.remaining('hint'), STARTING_GRANT - 2);
  assert.equal(resumed.remaining('undo'), STARTING_GRANT);
  assert.equal(resumed.remaining('shuffle'), STARTING_GRANT - 1);
});

test('an empty store starts a fresh grant and only writes once spent', () => {
  const storage = fakeStorage();
  const charges = new BoosterCharges(storage);
  assert.equal(storage.store.size, 0);
  charges.spend('shuffle');
  assert.deepEqual(JSON.parse(storage.store.get(CHARGES_STORAGE_KEY)!), {
    hint: STARTING_GRANT,
    undo: STARTING_GRANT,
    shuffle: STARTING_GRANT - 1,
  });
});

test('unusable stored values fall back to the grant, per booster', () => {
  const cases: Array<[string, string]> = [
    ['not json', '{oops'],
    ['not an object', '7'],
    ['null', 'null'],
    ['negative', '{"hint":-3}'],
    ['fractional', '{"hint":1.5}'],
    ['wrong type', '{"hint":"3"}'],
  ];
  for (const [name, raw] of cases) {
    const charges = new BoosterCharges(fakeStorage(raw));
    assert.equal(charges.remaining('hint'), STARTING_GRANT, name);
  }
  // A good value alongside a bad one survives.
  const mixed = new BoosterCharges(fakeStorage('{"hint":2,"undo":"x"}'));
  assert.equal(mixed.remaining('hint'), 2);
  assert.equal(mixed.remaining('undo'), STARTING_GRANT);
  // Zero is a legitimate stored balance, not a missing one.
  assert.equal(new BoosterCharges(fakeStorage('{"shuffle":0}')).remaining('shuffle'), 0);
});

test('storage that throws never takes the game down', () => {
  const hostile: ChargeStorage = {
    getItem: () => {
      throw new Error('site data blocked');
    },
    setItem: () => {
      throw new Error('site data blocked');
    },
  };
  const charges = new BoosterCharges(hostile);
  assert.equal(charges.remaining('hint'), STARTING_GRANT);
  assert.equal(charges.spend('hint'), true);
  assert.equal(charges.remaining('hint'), STARTING_GRANT - 1); // in-memory only
});
