import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HALF_UNIT_X,
  HALF_UNIT_Y,
  LAYER_LIFT,
  SIDE_DEPTH,
  TILE_H,
  TILE_W,
  boardBounds,
  paintOrder,
  rectContains,
  rectDistance,
  tileRect,
} from '../src/geometry.js';

test('tileRect projects half-units and lifts upper layers up-left', () => {
  assert.deepEqual(tileRect({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, w: TILE_W, h: TILE_H });
  assert.deepEqual(tileRect({ x: 3, y: 2, z: 0 }), {
    x: 3 * HALF_UNIT_X,
    y: 2 * HALF_UNIT_Y,
    w: TILE_W,
    h: TILE_H,
  });
  const lifted = tileRect({ x: 2, y: 2, z: 2 });
  assert.equal(lifted.x, 2 * HALF_UNIT_X - 2 * LAYER_LIFT);
  assert.equal(lifted.y, 2 * HALF_UNIT_Y - 2 * LAYER_LIFT);
});

test('rectContains: inclusive top-left, exclusive bottom-right', () => {
  const r = { x: 10, y: 10, w: 20, h: 20 };
  assert.equal(rectContains(r, 10, 10), true);
  assert.equal(rectContains(r, 29.9, 29.9), true);
  assert.equal(rectContains(r, 30, 15), false);
  assert.equal(rectContains(r, 15, 30), false);
  assert.equal(rectContains(r, 9.9, 15), false);
});

test('rectDistance: zero inside, axis and corner distances outside', () => {
  const r = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(rectDistance(r, 5, 5), 0);
  assert.equal(rectDistance(r, 18, 5), 8);
  assert.equal(rectDistance(r, 5, -8), 8);
  assert.equal(rectDistance(r, 13, 14), 5); // 3-4-5 corner
});

test('boardBounds spans all tiles including lift and side faces', () => {
  const b = boardBounds([
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 2, z: 0 },
    { x: 0, y: 0, z: 1 },
  ]);
  assert.equal(b.x, -LAYER_LIFT);
  assert.equal(b.y, -LAYER_LIFT);
  assert.equal(b.w, 4 * HALF_UNIT_X + TILE_W + LAYER_LIFT + SIDE_DEPTH);
  assert.equal(b.h, 2 * HALF_UNIT_Y + TILE_H + LAYER_LIFT + SIDE_DEPTH);
});

test('paintOrder: layers bottom-up, then rows, then columns', () => {
  const slots = [
    { x: 2, y: 0, z: 1 },
    { x: 4, y: 0, z: 0 },
    { x: 0, y: 2, z: 0 },
    { x: 2, y: 0, z: 0 },
  ];
  slots.sort(paintOrder);
  assert.deepEqual(slots, [
    { x: 2, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 0, y: 2, z: 0 },
    { x: 2, y: 0, z: 1 },
  ]);
});
