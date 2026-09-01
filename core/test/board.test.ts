// Free-tile rule fixtures (issue #5, spec §3.1–3.2, §11.1): for each fixture
// layout, every tile is asserted against its expected classification —
// covered / left-blocked / right-blocked / both-blocked / free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Board, footprintsOverlap } from '../src/board.js';
import type { Slot } from '../src/board.js';

function board(slots: Slot[]): Board {
  return new Board(slots.map((slot, i) => ({ id: i, slot, face: `f${i}` })));
}

/**
 * Classify every tile of a fixture and compare with expectations.
 * Classification is the full truth table, not just isFree, so a fixture
 * distinguishes left-blocked from right-blocked from both-blocked.
 */
type Expected = 'free' | 'covered' | 'left-blocked' | 'right-blocked' | 'both-blocked';

function classify(b: Board, id: number): Expected {
  if (b.isCovered(id)) return 'covered';
  const left = b.isBlockedLeft(id);
  const right = b.isBlockedRight(id);
  if (left && right) return 'both-blocked';
  if (left) return 'left-blocked';
  if (right) return 'right-blocked';
  return 'free';
}

function assertFixture(slots: Slot[], expected: Expected[]): void {
  const b = board(slots);
  const actual = slots.map((_, i) => classify(b, i));
  assert.deepEqual(actual, expected);
  // isFree must agree with the classification (covered wins even if also side-blocked).
  for (let i = 0; i < slots.length; i++) {
    assert.equal(b.isFree(i), expected[i] === 'free' || expected[i] === 'left-blocked' || expected[i] === 'right-blocked',
      `isFree(${i}) inconsistent with ${expected[i]}`);
  }
}

test('single tile is free', () => {
  assertFixture([{ x: 0, y: 0, z: 0 }], ['free']);
});

test('aligned row: middle tile both-blocked, ends free', () => {
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
    ],
    ['right-blocked', 'both-blocked', 'left-blocked'],
  );
});

test('covered: aligned tile directly above', () => {
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ],
    ['covered', 'free'],
  );
});

test('covered: half-offset tile above still covers (classic turtle cap)', () => {
  // Cap overlaps all four base tiles by one half-unit in x and y.
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 0, y: 2, z: 0 },
      { x: 2, y: 2, z: 0 },
      { x: 1, y: 1, z: 1 },
    ],
    ['covered', 'covered', 'covered', 'covered', 'free'],
  );
});

test('partial cover by any footprint overlap counts as covered', () => {
  // Upper tile shifted (+1,+1): overlaps only one corner half-unit — still covers.
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    ],
    ['covered', 'free'],
  );
});

test('tile above but NOT overlapping does not cover', () => {
  // dx = 2 → footprints touch edges, no overlap.
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 1 },
    ],
    ['free', 'free'],
  );
});

test('half-offset side neighbor blocks (spec: edge must be FULLY unblocked)', () => {
  // Right neighbor offset by one half-unit in y still overlaps the adjacent
  // footprint → right edge blocked. Left edges open on both → both free.
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 1, z: 0 },
    ],
    ['right-blocked', 'left-blocked'],
  );
});

test('half-unit-gap same-layer neighbor does not touch the edge → no block (issue #74)', () => {
  // Neighbor anchored 3 half-units away: overlaps the adjacent footprint but
  // leaves a half-unit gap to the edge — must not block either tile.
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
    ],
    ['free', 'free'],
  );
});

test('half-unit-gap neighbor with y-stagger still does not block (issue #74)', () => {
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 1, z: 0 },
    ],
    ['free', 'free'],
  );
});

test('issue #74 report shape: touching left neighbor, gap-right tile → left-blocked, selectable', () => {
  // Upper-layer cluster: tile touches a same-layer neighbor on the left only;
  // the nearest same-layer tile to the right is a half-unit clear of the edge.
  assertFixture(
    [
      { x: 2, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
      { x: 5, y: 0, z: 1 },
    ],
    ['left-blocked', 'right-blocked', 'free'],
  );
});

test('both-blocked via two half-offset flankers on opposite sides', () => {
  assertFixture(
    [
      { x: 2, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 4, y: -1, z: 0 },
    ],
    ['both-blocked', 'right-blocked', 'left-blocked'],
  );
});

test('vertical (y) adjacency does not block', () => {
  // Column of tiles stacked in y: all free (left and right edges open).
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 2, z: 0 },
      { x: 0, y: 4, z: 0 },
    ],
    ['free', 'free', 'free'],
  );
});

test('diagonal same-z neighbor (corner contact) does not block', () => {
  // (2,2) relative offset: adjacent-left/right footprints touch only at a corner.
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 2, z: 0 },
    ],
    ['free', 'free'],
  );
});

test('side neighbor on a DIFFERENT layer does not block', () => {
  // Same x-adjacency as the aligned-row fixture, but flanker one layer up.
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 1 },
    ],
    ['free', 'free'],
  );
});

test('covered wins over side-blocking: covered even when also flanked', () => {
  const slots: Slot[] = [
    { x: 2, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 2, y: 0, z: 1 },
  ];
  const b = board(slots);
  assert.equal(classify(b, 0), 'covered');
  assert.equal(b.isBlockedLeft(0), true);
  assert.equal(b.isBlockedRight(0), true);
  assert.equal(b.isFree(0), false);
});

// --- Layout-shaped fixtures (spec §11.1: exhaustive per layout) ---

test('pyramid layout: full truth table', () => {
  // 3×2 base, single half-offset cap over the middle column.
  //   base row y=0: (0,0) (2,0) (4,0);  row y=2: (0,2) (2,2) (4,2)
  //   cap: (2,1,1) — overlaps the four middle-column-adjacent base tiles? No:
  //   overlaps x∈(0,4) half-units → base tiles at x=2 (both rows) fully, and
  //   x=0/x=4 tiles by 1 half-unit? |0-2|=2 → no overlap in x. So covers only x=2 tiles.
  assertFixture(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 0, y: 2, z: 0 },
      { x: 2, y: 2, z: 0 },
      { x: 4, y: 2, z: 0 },
      { x: 2, y: 1, z: 1 },
    ],
    [
      'right-blocked',
      'covered',
      'left-blocked',
      'right-blocked',
      'covered',
      'left-blocked',
      'free',
    ],
  );
});

test('fortress row layout: interior all both-blocked until an end is removed', () => {
  const row: Slot[] = [0, 2, 4, 6, 8].map((x) => ({ x, y: 0, z: 0 }));
  const b = board(row);
  assert.deepEqual(b.freeTileIds(), [0, 4]);
  b.remove(0);
  // Tile 1's left edge is now open.
  assert.deepEqual(b.freeTileIds(), [1, 4]);
  b.restore(0);
  assert.deepEqual(b.freeTileIds(), [0, 4]);
});

test('removal uncovers: removing the cap frees covered tiles', () => {
  const b = board([
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 1, y: 0, z: 1 },
  ]);
  assert.deepEqual(b.freeTileIds(), [2]);
  b.remove(2);
  assert.deepEqual(b.freeTileIds(), [0, 1]);
});

test('removed tiles are never free and cannot be re-removed', () => {
  const b = board([{ x: 0, y: 0, z: 0 }]);
  b.remove(0);
  assert.equal(b.isFree(0), false);
  assert.throws(() => b.remove(0), RangeError);
  b.restore(0);
  assert.equal(b.isFree(0), true);
  assert.throws(() => b.restore(0), RangeError);
});

// --- Lattice invariants ---

test('overlapping same-z tiles are rejected at construction', () => {
  assert.throws(
    () => board([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]),
    /overlaps/,
  );
});

test('non-integer and negative-z slots are rejected', () => {
  assert.throws(() => board([{ x: 0.5, y: 0, z: 0 }]), RangeError);
  assert.throws(() => board([{ x: 0, y: 0, z: -1 }]), RangeError);
});

test('duplicate tile ids are rejected', () => {
  assert.throws(
    () => new Board([
      { id: 1, slot: { x: 0, y: 0, z: 0 }, face: 'a' },
      { id: 1, slot: { x: 4, y: 0, z: 0 }, face: 'b' },
    ]),
    /duplicate/,
  );
});

test('footprintsOverlap: exhaustive over the ±3 half-unit neighborhood', () => {
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      assert.equal(
        footprintsOverlap(0, 0, dx, dy),
        Math.abs(dx) < 2 && Math.abs(dy) < 2,
        `dx=${dx} dy=${dy}`,
      );
    }
  }
});

test('free-tile rule agrees with brute-force check on a dense 3-layer board', () => {
  // Turtle-style stack: 4×4 base, half-offset 3×3 middle? Keep it exact:
  // base 4×4 at z=0, aligned 2×2 at z=1 centered, single half-offset cap at z=2.
  const slots: Slot[] = [];
  for (let x = 0; x < 8; x += 2) for (let y = 0; y < 8; y += 2) slots.push({ x, y, z: 0 });
  for (let x = 2; x < 6; x += 2) for (let y = 2; y < 6; y += 2) slots.push({ x, y, z: 1 });
  slots.push({ x: 3, y: 3, z: 2 });
  const b = board(slots);

  const overlap = (a: Slot, c: Slot) => footprintsOverlap(a.x, a.y, c.x, c.y);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    const covered = slots.some((o) => o.z === s.z + 1 && overlap(s, o));
    const left = slots.some((o) => o !== s && o.z === s.z && overlap({ ...s, x: s.x - 2 }, o));
    const right = slots.some((o) => o !== s && o.z === s.z && overlap({ ...s, x: s.x + 2 }, o));
    assert.equal(b.isFree(i), !covered && (!left || !right), `tile ${i} at ${s.x},${s.y},${s.z}`);
  }
});
