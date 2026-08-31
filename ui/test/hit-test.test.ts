// Mis-tap forgiveness behavior (spec §7: nearest free tile within 8dp).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HALF_UNIT_X, LAYER_LIFT, TILE_H, TILE_W } from '../src/geometry.js';
import { hitTest } from '../src/hit-test.js';
import type { HitCandidate } from '../src/hit-test.js';

const c = (id: number, x: number, y: number, z: number, free: boolean): HitCandidate => ({
  id,
  slot: { x, y, z },
  free,
});

test('direct hit on a free tile wins, no forgiveness flag', () => {
  const hit = hitTest([c(0, 0, 0, 0, true)], TILE_W / 2, TILE_H / 2, 8);
  assert.deepEqual(hit, { kind: 'free', id: 0, forgiven: false });
});

test('topmost layer wins when tiles overlap under the point', () => {
  // z1 tile lifted up-left still covers the center of the z0 tile beneath.
  const tiles = [c(0, 0, 0, 0, false), c(1, 0, 0, 1, true)];
  const hit = hitTest(tiles, TILE_W / 2 - LAYER_LIFT, TILE_H / 2 - LAYER_LIFT, 0);
  assert.deepEqual(hit, { kind: 'free', id: 1, forgiven: false });
});

test('tap on a blocked tile is forgiven to a free tile within the radius', () => {
  // Free tile 1 sits to the right of blocked tile 0; tap 5px inside tile 0's
  // right edge → 5px from tile 1.
  const tiles = [c(0, 0, 0, 0, false), c(1, 2, 0, 0, true)];
  const hit = hitTest(tiles, 2 * HALF_UNIT_X - 5, TILE_H / 2, 8);
  assert.deepEqual(hit, { kind: 'free', id: 1, forgiven: true });
});

test('tap on empty space near a free tile is forgiven too', () => {
  const tiles = [c(0, 0, 0, 0, true)];
  const hit = hitTest(tiles, TILE_W + 6, TILE_H / 2, 8);
  assert.deepEqual(hit, { kind: 'free', id: 0, forgiven: true });
});

test('nearest free tile is chosen among several in range', () => {
  // Tile 0 spans [0, 64)px, tile 1 spans [192, 256)px.
  const tiles = [c(0, 0, 0, 0, true), c(1, 6, 0, 0, true)];
  // 140px: 76px from tile 0, 52px from tile 1.
  assert.deepEqual(hitTest(tiles, 140, TILE_H / 2, 60), { kind: 'free', id: 1, forgiven: true });
  // 100px: 36px from tile 0, 92px from tile 1.
  assert.deepEqual(hitTest(tiles, 100, TILE_H / 2, 60), { kind: 'free', id: 0, forgiven: true });
});

test('beyond the radius: blocked stays blocked, empty space is a miss', () => {
  const tiles = [c(0, 0, 0, 0, false), c(1, 6, 0, 0, true)];
  const onBlocked = hitTest(tiles, 5, 5, 8);
  assert.deepEqual(onBlocked, { kind: 'blocked', id: 0 });
  const inSpace = hitTest(tiles, TILE_W + 20, TILE_H * 3, 8);
  assert.deepEqual(inSpace, { kind: 'miss' });
});

test('equidistant candidates: higher layer wins, then lower id', () => {
  // Same layer, equal 64px distance from the midpoint: lower id wins.
  const sameLayer = [c(5, 0, 0, 0, true), c(3, 6, 0, 0, true)];
  assert.deepEqual(hitTest(sameLayer, 128, TILE_H / 2, 64), {
    kind: 'free',
    id: 3,
    forgiven: true,
  });
  // Right tile on z1: its edge is lifted to 192 - 7 = 185px; the point
  // equidistant from both edges is (64 + 185) / 2 = 124.5px.
  const mixed = [c(0, 0, 0, 0, true), c(1, 6, 0, 1, true)];
  assert.deepEqual(hitTest(mixed, (TILE_W + 6 * HALF_UNIT_X - LAYER_LIFT) / 2, TILE_H / 2, 61), {
    kind: 'free',
    id: 1,
    forgiven: true,
  });
});
