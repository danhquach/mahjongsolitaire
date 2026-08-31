// Issue #45: pip art must stay on the tile and off the corner tag.
//
// These are regression tests for two defects found by looking at a rendered
// face sheet, which is exactly the problem: nothing threw, nothing failed, the
// board just looked wrong. Five Bamboo ranks hung over the bottom edge of the
// tile and eight ranks drew under the rank tag, because pips were sized from
// the gap between centres and drawn centred there — with no check that the
// result still fitted.
//
// The sweep is over the shipped 144-tile set, so it covers the hand-authored
// ranks (Dots-3, Dots-7) as well as the generated grids.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STANDARD_144 } from '@mahjongsolitaire/core';
import { faceStyle } from '../src/faces.js';
import { TILE_H, TILE_W } from '../src/geometry.js';
import { PIP_AREA, TAG_BOX, pipBounds, pipCenter, pipMetrics } from '../src/pips.js';
import type { Rect } from '../src/geometry.js';

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

const FACE: Rect = { x: 0, y: 0, w: TILE_W, h: TILE_H };

/** Every distinct pip face on a shipped board, with its shape. */
const PIP_FACES = [...new Set(STANDARD_144)]
  .map((face) => ({ face, style: faceStyle(face) }))
  .filter((f) => f.style.pips !== undefined && f.style.pips.length > 0);

// --- the area itself ----------------------------------------------------------

test('the pip area is inside the face and clear of the corner tag', () => {
  assert.ok(contains(FACE, PIP_AREA), `PIP_AREA escapes the face: ${JSON.stringify(PIP_AREA)}`);
  assert.ok(contains(FACE, TAG_BOX), `TAG_BOX escapes the face: ${JSON.stringify(TAG_BOX)}`);
  assert.ok(
    !overlaps(PIP_AREA, TAG_BOX),
    `PIP_AREA overlaps TAG_BOX: ${JSON.stringify({ PIP_AREA, TAG_BOX })}`,
  );
  // Worth the room: art squeezed into a third of the face is not readable at
  // tile size S. Half the face is the floor.
  assert.ok(
    PIP_AREA.w * PIP_AREA.h > 0.5 * TILE_W * TILE_H,
    'the pip area gave away too much of the face',
  );
});

// --- the two defects ---------------------------------------------------------

test('no rank draws outside the tile face', () => {
  assert.ok(PIP_FACES.length >= 18, `expected the 18 suited ranks, got ${PIP_FACES.length}`);
  for (const { face, style } of PIP_FACES) {
    const box = pipBounds(style.pips!, style.pipShape!);
    assert.ok(
      contains(FACE, box),
      `${face} overflows the face: [${box.x.toFixed(1)}, ${box.y.toFixed(1)}] ` +
        `${box.w.toFixed(1)}x${box.h.toFixed(1)} vs ${TILE_W}x${TILE_H}`,
    );
  }
});

test('no rank draws under the corner tag', () => {
  for (const { face, style } of PIP_FACES) {
    const box = pipBounds(style.pips!, style.pipShape!);
    assert.ok(
      !overlaps(box, TAG_BOX),
      `${face} collides with the tag: ${JSON.stringify(box)} vs ${JSON.stringify(TAG_BOX)}`,
    );
  }
});

test('every rank stays inside the pip area, not merely inside the face', () => {
  // The stronger claim, and the one that keeps holding if the area is ever
  // moved or shrunk: the clamp in pipMetrics is what makes it true, so it holds
  // for a hand-authored rank as well as a generated grid.
  for (const { face, style } of PIP_FACES) {
    const box = pipBounds(style.pips!, style.pipShape!);
    assert.ok(contains(PIP_AREA, box), `${face} leaves the pip area: ${JSON.stringify(box)}`);
  }
});

// --- sizing stays sane -------------------------------------------------------

test('pips are big enough to read at every rank', () => {
  // A clamp that fits by shrinking to nothing would pass every test above.
  for (const { face, style } of PIP_FACES) {
    const m = pipMetrics(style.pips!);
    if (style.pipShape === 'cane') {
      assert.ok(m.caneW >= 4 && m.caneH >= 10, `${face} cane too small: ${JSON.stringify(m)}`);
      assert.ok(m.caneH > m.caneW, `${face} cane is not a tall segment: ${JSON.stringify(m)}`);
    } else {
      assert.ok(m.ringR >= 4, `${face} ring too small: r=${m.ringR.toFixed(2)}`);
    }
  }
});

test('a sparse rank draws bigger pips than a dense one', () => {
  // What the per-rank measurement buys: one table, no per-rank sizes to tune.
  const ring = (face: string): number => pipMetrics(faceStyle(face).pips!).ringR;
  const cane = (face: string): number => pipMetrics(faceStyle(face).pips!).caneH;
  assert.ok(ring('dots-1') > ring('dots-4'), 'dots-1 ring should dwarf dots-4');
  assert.ok(ring('dots-4') > ring('dots-9'), 'dots-4 ring should beat dots-9');
  assert.ok(cane('bamboo-1') > cane('bamboo-9'), 'bamboo-1 cane should be the tallest');
});

test('pips never collide with each other', () => {
  // The gap is what makes a rank countable — a 9 that reads as a blob is the
  // same bug as a 9 that overflows.
  //
  // Separation is tested per shape, because the shapes are not the same kind of
  // thing: two rings clear each other when their centres are a diameter apart
  // in *any* direction, so a diagonal pair (Dots-2) is fine even though their
  // bounding boxes overlap. A cane is a rectangle, so it needs separation on an
  // axis.
  for (const { face, style } of PIP_FACES) {
    const m = pipMetrics(style.pips!);
    const pips = style.pips!;
    for (let i = 0; i < pips.length; i++) {
      for (let j = i + 1; j < pips.length; j++) {
        const a = pipCenter(pips[i]!);
        const b = pipCenter(pips[j]!);
        const clear =
          style.pipShape === 'cane'
            ? Math.abs(a.x - b.x) >= m.caneW || Math.abs(a.y - b.y) >= m.caneH
            : Math.hypot(a.x - b.x, a.y - b.y) >= 2 * m.ringR;
        assert.ok(clear, `${face}: pips ${i} and ${j} overlap`);
      }
    }
  }
});
