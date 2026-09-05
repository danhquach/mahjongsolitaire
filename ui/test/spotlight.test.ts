// Tutorial spotlight geometry (issue #150): the fully-visible rule, the
// same-half rule, neighbour preference, fallbacks, tag fan-out and the scrim.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardCoversHole,
  cardSide,
  fullyVisible,
  half,
  layoutTags,
  panelHole,
  pickFreeBlocked,
  pickVisiblePair,
  scrimPath,
  tileHole,
} from '../src/spotlight.js';
import type { Hole, SpotTile } from '../src/spotlight.js';

const W = 40;
const H = 52;
/** A tile on a 40×52 grid; `col`/`row` are grid cells, `z` the layer. Higher
 *  layers sit half a cell up-left, as the renderer draws them. */
function tile(id: number, col: number, row: number, opts: Partial<Omit<SpotTile, 'id' | 'rect'>> = {}): SpotTile {
  const z = opts.z ?? 0;
  return {
    id,
    z,
    free: opts.free ?? true,
    face: opts.face ?? `f${id}`,
    rect: { x: col * W - z * 4, y: row * H - z * 6, w: W, h: H },
  };
}
const MID = 4 * H; // an eight-row board

// --- fully visible -------------------------------------------------------------

test('a tile is fully visible unless a higher-layer tile overlaps its face', () => {
  const base = tile(1, 2, 2);
  const onTop = tile(2, 2, 2, { z: 1 });
  const besideSameLayer = tile(3, 1, 2); // left neighbour: the higher tile is drawn up-left onto it
  const higherButFar = tile(4, 6, 6, { z: 1 });
  const tiles = [base, onTop, besideSameLayer, higherButFar];
  assert.equal(fullyVisible(base, tiles), false, 'covered by a higher tile');
  assert.equal(fullyVisible(besideSameLayer, tiles), false, 'the higher tile spills onto its edge');
  assert.equal(fullyVisible(onTop, tiles), true, 'nothing above it');
  assert.equal(fullyVisible(higherButFar, tiles), true);
  assert.equal(fullyVisible(tile(5, 5, 1), [tile(5, 5, 1), tile(6, 5, 2)]), true, 'a lower neighbour does not hide it');
});

test('half() splits on the rect centre', () => {
  assert.equal(half({ x: 0, y: 0, w: W, h: H }, MID), 'top');
  assert.equal(half({ x: 0, y: MID - 1, w: W, h: H }, MID), 'bottom');
});

// --- step 2: free + blocked ------------------------------------------------------

test('pickFreeBlocked prefers adjacent fully visible tiles in one half', () => {
  const tiles = [
    tile(1, 1, 1, { free: true }),
    tile(2, 2, 1, { free: false }), // neighbour of 1, top half
    tile(3, 6, 1, { free: false }), // far away, top half
    tile(4, 1, 6, { free: false }), // bottom half
    tile(5, 2, 6, { free: true }), // bottom half, but covered:
    tile(6, 2, 6, { free: true, z: 1 }),
  ];
  const pick = pickFreeBlocked(tiles, MID);
  assert.deepEqual([pick?.free.id, pick?.blocked.id], [1, 2]);
});

test('pickFreeBlocked never mixes halves and returns null with no candidates', () => {
  const split = [tile(1, 1, 1, { free: true }), tile(2, 1, 6, { free: false })];
  assert.equal(pickFreeBlocked(split, MID), null, 'free on top, blocked below: no pair');
  assert.equal(pickFreeBlocked([tile(1, 1, 1)], MID), null, 'no blocked tile at all');
  const covered = [tile(1, 1, 1, { free: false }), tile(2, 1, 1, { z: 1 }), tile(3, 3, 1)];
  assert.equal(pickFreeBlocked(covered, MID), null, 'the only blocked tile is under another');
});

// --- step 3: matchable pair -----------------------------------------------------

test('pickVisiblePair takes the same-face free pair in one half with most room from the middle', () => {
  const tiles = [
    tile(1, 1, 0, { face: 'a' }), // top, far from middle
    tile(2, 5, 0, { face: 'a' }),
    tile(3, 1, 3, { face: 'b' }), // top, near the middle
    tile(4, 5, 3, { face: 'b' }),
    tile(5, 1, 7, { face: 'c' }), // bottom, but covered
    tile(6, 1, 7, { face: 'c', z: 1 }),
    tile(7, 6, 7, { face: 'c' }),
  ];
  const pair = pickVisiblePair(tiles, MID);
  assert.deepEqual(pair?.map((t) => t.id).sort(), [1, 2]);
});

test('pickVisiblePair never takes a pair that straddles the middle, and is null without one (issue #199)', () => {
  const crossHalf = [tile(1, 1, 0, { face: 'a' }), tile(2, 1, 7, { face: 'a' })];
  assert.equal(pickVisiblePair(crossHalf, MID), null, 'the card would have no half to take');
  const withSameHalf = [...crossHalf, tile(3, 3, 7, { face: 'a' })];
  assert.deepEqual(pickVisiblePair(withSameHalf, MID)?.map((t) => t.id).sort(), [2, 3], 'a same-half pair wins over the straddling one');
  const blockedPair = [tile(1, 1, 0, { face: 'a', free: false }), tile(2, 3, 0, { face: 'a' })];
  assert.equal(pickVisiblePair(blockedPair, MID), null, 'only free tiles pair');
  assert.equal(pickVisiblePair([tile(1, 1, 0, { face: 'a' }), tile(2, 3, 0, { face: 'b' })], MID), null);
});

// --- holes, card side, scrim ----------------------------------------------------

test('holes pad the rect; the card takes the half with no actor', () => {
  const t = tileHole({ x: 10, y: 20, w: W, h: H }, 'pair');
  assert.deepEqual(t, { x: 10, y: 20, w: W, h: H + 6, r: 8, kind: 'pair' });
  const p = panelHole({ x: 10, y: 20, w: 100, h: 50 });
  assert.deepEqual(p, { x: 4, y: 14, w: 112, h: 62, r: 12, kind: 'panel' });
  assert.equal(cardSide([t], MID), 'bottom', 'actor in the top half → card at the bottom');
  assert.equal(cardSide([tileHole({ x: 0, y: MID + 10, w: W, h: H }, 'pair')], MID), 'top');
  assert.equal(cardSide([], MID), 'bottom', 'no actor → the usual place');
  assert.equal(cardCoversHole({ x: 0, y: 0, w: 100, h: 100 }, [t]), true);
  assert.equal(cardCoversHole({ x: 200, y: 200, w: 100, h: 100 }, [t]), false);
});

test('scrimPath is the viewport with one even-odd sub-path per hole', () => {
  const holes: Hole[] = [tileHole({ x: 10, y: 20, w: W, h: H }, 'pair'), panelHole({ x: 100, y: 100, w: 30, h: 30 })];
  const d = scrimPath(390, 844, holes);
  assert.ok(d.startsWith('M0,0H390V844H0z '), d);
  assert.equal(d.split('z').length - 1, 3, 'outer rect + two holes');
  assert.equal(scrimPath(390, 844, []), 'M0,0H390V844H0z');
});

// --- step 2 tags -------------------------------------------------------------------

test('tags fan outward from the pair, never overlap, and point at their own tile', () => {
  const free = tileHole({ x: 240, y: 300, w: W, h: H }, 'free');
  const blocked = tileHole({ x: 200, y: 300, w: W, h: H }, 'blocked');
  const tags = layoutTags([free, blocked], 0);
  assert.equal(tags.length, 2);
  const [tFree, tBlocked] = tags as [(typeof tags)[0], (typeof tags)[0]];
  assert.equal(tFree.text, 'FREE');
  assert.equal(tBlocked.text, 'BLOCKED');
  assert.ok(tBlocked.x + tBlocked.w <= tFree.x, 'left tile’s tag is entirely left of the right tile’s');
  assert.ok(tFree.above && tBlocked.above, 'room above → tags above');
  assert.ok(tFree.to.y < free.y && tFree.from.y > tFree.y, 'arrow runs from the pill down to the tile top');
  assert.ok(tFree.to.x > free.x && tFree.to.x < free.x + free.w, 'arrow lands on its own tile');
  assert.ok(tBlocked.to.x > blocked.x && tBlocked.to.x < blocked.x + blocked.w);
});

test('tags flip below the tiles when there is no room above', () => {
  const free = tileHole({ x: 240, y: 4, w: W, h: H }, 'free');
  const blocked = tileHole({ x: 200, y: 4, w: W, h: H }, 'blocked');
  const tags = layoutTags([free, blocked], 0);
  assert.ok(tags.every((t) => !t.above));
  for (const t of tags) {
    assert.ok(t.y > free.y + free.h, 'pill sits under the tile');
    assert.ok(t.from.y === t.y && t.to.y > free.y + free.h && t.to.y < t.y, 'arrow runs from the pill up to the tile bottom');
  }
  assert.deepEqual(layoutTags([tileHole({ x: 0, y: 0, w: W, h: H }, 'pair')], 0), [], 'only free/blocked holes get tags');
});
