// Ladder progress persistence (issue #79).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LADDER_LENGTH } from '@mahjongsolitaire/core';
import { PROGRESS_STORAGE_KEY, ProgressStore } from '../src/progress.js';
import type { KeyValueStorage } from '../src/storage.js';

function fakeStorage(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('a fresh store starts at level 1', () => {
  assert.equal(new ProgressStore(fakeStorage()).level, 1);
  assert.equal(new ProgressStore(undefined).level, 1);
});

test('advance moves one level and persists it', () => {
  const storage = fakeStorage();
  const store = new ProgressStore(storage);
  assert.equal(store.advance(), 2);
  assert.equal(store.level, 2);
  assert.equal(new ProgressStore(storage).level, 2);
});

test('advance caps at the ladder end', () => {
  const storage = fakeStorage({ [PROGRESS_STORAGE_KEY]: JSON.stringify({ level: LADDER_LENGTH }) });
  const store = new ProgressStore(storage);
  assert.equal(store.level, LADDER_LENGTH);
  assert.equal(store.advance(), LADDER_LENGTH);
});

test('malformed or out-of-range records read as level 1 (clamped into range)', () => {
  for (const raw of ['not json{', '"str"', '{}', JSON.stringify({ level: 2.5 }), 'null']) {
    assert.equal(new ProgressStore(fakeStorage({ [PROGRESS_STORAGE_KEY]: raw })).level, 1, raw);
  }
  const high = fakeStorage({ [PROGRESS_STORAGE_KEY]: JSON.stringify({ level: 9999 }) });
  assert.equal(new ProgressStore(high).level, LADDER_LENGTH);
  const low = fakeStorage({ [PROGRESS_STORAGE_KEY]: JSON.stringify({ level: -3 }) });
  assert.equal(new ProgressStore(low).level, 1);
});

test('a storage that throws still yields a working in-memory store', () => {
  const broken: KeyValueStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  const store = new ProgressStore(broken);
  assert.equal(store.level, 1);
  assert.equal(store.advance(), 2);
});
