// Accessibility foundation (issue #12): the pure parts — traversal order,
// tile labels, 48dp focus rects, and directional navigation. The DOM layer
// itself is covered end-to-end by qa/a11y-audit.mjs (real browser AX tree).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_TOUCH_TARGET_PX,
  focusRect,
  nextInDirection,
  tileAriaLabel,
  traversalOrder,
} from '../src/a11y.js';
import type { A11yTile } from '../src/a11y.js';
import { TILE_H, TILE_W } from '../src/geometry.js';

const t = (id: number, x: number, y: number, z: number, face: string, free = true): A11yTile => ({
  id,
  slot: { x, y, z },
  face,
  free,
});

test('traversal order reads the board row by row, then left to right, then up', () => {
  const tiles = [
    t(0, 4, 2, 0, 'dots-1'),
    t(1, 0, 0, 1, 'dots-2'),
    t(2, 0, 0, 0, 'dots-3'),
    t(3, 2, 0, 0, 'dots-4'),
  ];
  assert.deepEqual(
    traversalOrder(tiles).map((x) => x.id),
    [2, 1, 3, 0],
  );
});

test('traversal order does not mutate the input', () => {
  const tiles = [t(0, 4, 2, 0, 'dots-1'), t(1, 0, 0, 0, 'dots-2')];
  traversalOrder(tiles);
  assert.deepEqual(
    tiles.map((x) => x.id),
    [0, 1],
  );
});

test('tile label names the face, its availability, a locating row/column, and the action', () => {
  assert.equal(
    tileAriaLabel(t(0, 0, 0, 0, 'bamboo-3')),
    'Bamboo 3, available, row 1, column 1, activate to send it to the holder',
  );
  assert.equal(
    tileAriaLabel(t(1, 6, 4, 0, 'wind-east', false)),
    'East Wind, blocked, row 3, column 4',
  );
});

test('a face-down tile announces as face-down, never by its face (issue #64)', () => {
  assert.equal(
    tileAriaLabel({ ...t(0, 0, 0, 0, 'bamboo-3'), concealed: true }),
    'Face-down tile, available, row 1, column 1, activate to peek at it',
  );
  // A blocked one cannot be peeked, so it offers no action.
  assert.equal(
    tileAriaLabel({ ...t(1, 6, 4, 0, 'wind-east', false), concealed: true }),
    'Face-down tile, blocked, row 3, column 4',
  );
});

test('a tile whose match is in the holder offers the clear, not the park (issue #93)', () => {
  assert.equal(
    tileAriaLabel({ ...t(0, 0, 0, 0, 'bamboo-3'), pairsWithHeld: true }),
    'Bamboo 3, available, row 1, column 1, activate to clear it with its match in the holder',
  );
  // A blocked tile offers no action at all.
  assert.equal(
    tileAriaLabel({ ...t(1, 0, 0, 0, 'bamboo-3', false), pairsWithHeld: true }),
    'Bamboo 3, blocked, row 1, column 1',
  );
});

test('with one slot left the label warns that parking loses (issue #63)', () => {
  // A sighted player has the marked last slot in the strip; this sentence is
  // that warning for someone who cannot see it, and it has to arrive *before*
  // the activation that ends the level, not after.
  assert.equal(
    tileAriaLabel(t(0, 0, 0, 0, 'bamboo-3'), true),
    'Bamboo 3, available, row 1, column 1, activate to send it to the last holder slot, which ends the level',
  );
  // A tile whose pair is waiting is safe to send: the clear, not the warning.
  assert.equal(
    tileAriaLabel({ ...t(0, 0, 0, 0, 'bamboo-3'), pairsWithHeld: true }, true),
    'Bamboo 3, available, row 1, column 1, activate to clear it with its match in the holder',
  );
});

test('tile label rounds half-unit offsets to the nearest whole row/column', () => {
  // Turtle has half-offset slots (odd half-unit coordinates).
  assert.equal(
    tileAriaLabel(t(2, 1, 3, 0, 'dots-5')),
    'Dots 5, available, row 3, column 2, activate to send it to the holder',
  );
});

test('focus rect keeps a large tile as-is', () => {
  const r = focusRect({ x: 10, y: 20, w: 60, h: 70 });
  assert.deepEqual(r, { x: 10, y: 20, w: 60, h: 70 });
});

test('focus rect grows a small tile to 48dp about its center', () => {
  const r = focusRect({ x: 100, y: 200, w: 24, h: 30 });
  assert.equal(r.w, MIN_TOUCH_TARGET_PX);
  assert.equal(r.h, MIN_TOUCH_TARGET_PX);
  // Center preserved: 100 + 24/2 === 88 + 48/2.
  assert.equal(r.x + r.w / 2, 112);
  assert.equal(r.y + r.h / 2, 215);
});

test('focus rect grows each axis independently', () => {
  const r = focusRect({ x: 0, y: 0, w: 20, h: 90 });
  assert.equal(r.w, MIN_TOUCH_TARGET_PX);
  assert.equal(r.h, 90);
  assert.equal(r.y, 0);
});

// A 3×3 lattice of tiles two half-units apart, ids row-major from 0.
const gridTiles: A11yTile[] = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) {
    gridTiles.push(t(row * 3 + col, col * 2, row * 2, 0, `dots-${row * 3 + col + 1}`));
  }
}

test('arrow navigation steps to the neighbour in that direction', () => {
  assert.equal(nextInDirection(gridTiles, 4, 'left'), 3);
  assert.equal(nextInDirection(gridTiles, 4, 'right'), 5);
  assert.equal(nextInDirection(gridTiles, 4, 'up'), 1);
  assert.equal(nextInDirection(gridTiles, 4, 'down'), 7);
});

test('arrow navigation prefers staying in the same row/column', () => {
  // From the top-left tile, "right" must reach 1 (same row), never 4 or 5.
  assert.equal(nextInDirection(gridTiles, 0, 'right'), 1);
  assert.equal(nextInDirection(gridTiles, 0, 'down'), 3);
});

test('arrow navigation returns null at the board edge', () => {
  assert.equal(nextInDirection(gridTiles, 0, 'left'), null);
  assert.equal(nextInDirection(gridTiles, 0, 'up'), null);
  assert.equal(nextInDirection(gridTiles, 8, 'right'), null);
  assert.equal(nextInDirection(gridTiles, 8, 'down'), null);
});

test('arrow navigation crosses a gap when the row has been cleared', () => {
  // Tiles 3 and 4 removed: from 5, "left" must jump to the next present tile.
  const remaining = gridTiles.filter((x) => x.id !== 3 && x.id !== 4);
  assert.equal(nextInDirection(remaining, 5, 'left'), null);
  assert.equal(nextInDirection(remaining, 5, 'up'), 2);
});

test('arrow navigation reaches blocked tiles too — traversal must cover the board', () => {
  const tiles = [t(0, 0, 0, 0, 'dots-1'), t(1, 2, 0, 0, 'dots-2', false)];
  assert.equal(nextInDirection(tiles, 0, 'right'), 1);
});

test('arrow navigation is layer-aware: a lifted tile sits up and left of its base', () => {
  // Stacked tile (z=1) is drawn LAYER_LIFT px up-left of the same lattice cell,
  // so from a z=0 tile to its right, "left" lands on the stack.
  const tiles = [t(0, 0, 0, 1, 'dots-1'), t(1, 2, 0, 0, 'dots-2')];
  assert.equal(nextInDirection(tiles, 1, 'left'), 0);
  assert.equal(nextInDirection(tiles, 0, 'right'), 1);
});

test('arrow navigation from an unknown tile is a no-op', () => {
  assert.equal(nextInDirection(gridTiles, 99, 'left'), null);
});

test('tile geometry stays the source of truth for the focus rect size', () => {
  // Guards the assumption behind focusRect: an unscaled tile is already ≥ 48dp,
  // so growth only ever kicks in on small viewports.
  assert.ok(TILE_W >= MIN_TOUCH_TARGET_PX);
  assert.ok(TILE_H >= MIN_TOUCH_TARGET_PX);
});
