// Issue #122: the deadlock pulse's near-pair selection. Pure and headless —
// no board needs to actually be stuck, only to have same-face tiles that are
// (or are not) currently blocked, which is all `nearPairs` looks at.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board } from '@mahjongsolitaire/core';
import type { TileInput } from '@mahjongsolitaire/core';
import { nearPairs } from '../src/game.js';

test('a blocked same-face pair is a near-pair', () => {
  // Two tiles of face 'a', each covered by its own cap at z=1.
  const b = new Board([
    { id: 1, slot: { x: 0, y: 0, z: 0 }, face: 'a' },
    { id: 2, slot: { x: 0, y: 0, z: 1 }, face: 'cap1' },
    { id: 3, slot: { x: 4, y: 0, z: 0 }, face: 'a' },
    { id: 4, slot: { x: 4, y: 0, z: 1 }, face: 'cap2' },
  ]);
  assert.equal(b.isFree(1), false);
  assert.equal(b.isFree(3), false);
  assert.deepEqual(nearPairs(b), [[1, 3]]);
});

test('a free tile never joins a near-pair, even if its twin is blocked', () => {
  const board = new Board([
    { id: 1, slot: { x: 0, y: 0, z: 0 }, face: 'a' }, // covered → blocked
    { id: 2, slot: { x: 0, y: 0, z: 1 }, face: 'cap' },
    { id: 3, slot: { x: 4, y: 0, z: 0 }, face: 'a' }, // nothing above it → free
  ]);
  assert.equal(board.isFree(1), false);
  assert.equal(board.isFree(3), true);
  assert.deepEqual(nearPairs(board), []);
});

test('a held tile never joins a near-pair', () => {
  const board = new Board(
    [
      { id: 1, slot: { x: 0, y: 0, z: 0 }, face: 'a' },
      { id: 2, slot: { x: 0, y: 0, z: 1 }, face: 'cap' },
      { id: 3, slot: { x: 4, y: 0, z: 0 }, face: 'a' },
      { id: 4, slot: { x: 4, y: 0, z: 1 }, face: 'cap2' },
    ],
    { holder: [1, null, null, null] },
  );
  // Tile 1 is held — off the lattice — so only tile 3 (still covered) is
  // left of face 'a', and a single tile cannot make a pair.
  assert.deepEqual(nearPairs(board), []);
});

test('no near-pairs on an empty or fully-free board', () => {
  assert.deepEqual(nearPairs(new Board([])), []);
  const allFree = new Board([
    { id: 1, slot: { x: 0, y: 0, z: 0 }, face: 'a' },
    { id: 2, slot: { x: 4, y: 0, z: 0 }, face: 'a' },
  ]);
  assert.deepEqual(nearPairs(allFree), []);
});

test('capped at 3, deterministic, paint-ordered', () => {
  const tiles: TileInput[] = [];
  const faces = ['a', 'b', 'c', 'd'];
  faces.forEach((face, i) => {
    const x = i * 4;
    tiles.push({ id: x * 10 + 1, slot: { x, y: 0, z: 0 }, face });
    tiles.push({ id: x * 10 + 2, slot: { x, y: 0, z: 1 }, face: `${face}-cap` });
    tiles.push({ id: x * 10 + 3, slot: { x, y: 4, z: 0 }, face });
    tiles.push({ id: x * 10 + 4, slot: { x, y: 4, z: 1 }, face: `${face}-cap2` });
  });
  const board = new Board(tiles);
  const pairs = nearPairs(board);
  assert.equal(pairs.length, 3, 'capped at the default limit');
  const again = nearPairs(board);
  assert.deepEqual(pairs, again, 'deterministic given the same board');
  // Paint order is z, then y, then x ascending — the four faces' pairs sort
  // by their first tile's slot, which is (x*10+1) at y=0 for every face, so
  // the winning three are the lowest-x faces: a, b, c.
  assert.deepEqual(
    pairs.map(([a]) => a),
    [1, 41, 81],
  );
});

test('an odd count of blocked same-face tiles leaves the leftover unpaired', () => {
  // Three blocked tiles of face 'a': paint order pairs the first two,
  // and the third — with no partner left — is excluded entirely rather
  // than reused into a second pair.
  const board = new Board([
    { id: 1, slot: { x: 0, y: 0, z: 0 }, face: 'a' },
    { id: 2, slot: { x: 0, y: 0, z: 1 }, face: 'cap1' },
    { id: 3, slot: { x: 4, y: 0, z: 0 }, face: 'a' },
    { id: 4, slot: { x: 4, y: 0, z: 1 }, face: 'cap2' },
    { id: 5, slot: { x: 8, y: 0, z: 0 }, face: 'a' },
    { id: 6, slot: { x: 8, y: 0, z: 1 }, face: 'cap3' },
  ]);
  const pairs = nearPairs(board);
  assert.equal(pairs.length, 1, 'exactly one pair');
  assert.deepEqual(pairs, [[1, 3]]);
  const used = pairs.flat();
  assert.equal(new Set(used).size, used.length, 'no tile reused across pairs');
  assert.ok(!used.includes(5), 'the leftover tile is excluded');
});

test('4 blocked copies of the same face make 2 pairs', () => {
  const board = new Board([
    { id: 1, slot: { x: 0, y: 0, z: 0 }, face: 'a' },
    { id: 2, slot: { x: 0, y: 0, z: 1 }, face: 'cap1' },
    { id: 3, slot: { x: 4, y: 0, z: 0 }, face: 'a' },
    { id: 4, slot: { x: 4, y: 0, z: 1 }, face: 'cap2' },
    { id: 5, slot: { x: 8, y: 0, z: 0 }, face: 'a' },
    { id: 6, slot: { x: 8, y: 0, z: 1 }, face: 'cap3' },
    { id: 7, slot: { x: 12, y: 0, z: 0 }, face: 'a' },
    { id: 8, slot: { x: 12, y: 0, z: 1 }, face: 'cap4' },
  ]);
  const pairs = nearPairs(board);
  assert.equal(pairs.length, 2, 'two pairs from four blocked copies');
  assert.deepEqual(pairs, [
    [1, 3],
    [5, 7],
  ]);
  const used = pairs.flat();
  assert.equal(new Set(used).size, used.length, 'no tile reused across pairs');
});

test('respects a custom limit', () => {
  const tiles: TileInput[] = [];
  ['a', 'b'].forEach((face, i) => {
    const x = i * 4;
    tiles.push({ id: x * 10 + 1, slot: { x, y: 0, z: 0 }, face });
    tiles.push({ id: x * 10 + 2, slot: { x, y: 0, z: 1 }, face: `${face}-cap` });
    tiles.push({ id: x * 10 + 3, slot: { x, y: 4, z: 0 }, face });
    tiles.push({ id: x * 10 + 4, slot: { x, y: 4, z: 1 }, face: `${face}-cap2` });
  });
  const board = new Board(tiles);
  assert.equal(nearPairs(board, 1).length, 1);
  assert.equal(nearPairs(board, 0).length, 0);
});
