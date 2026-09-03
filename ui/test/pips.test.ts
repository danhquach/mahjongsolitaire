// Issue #45: pip art must stay on the tile (and, until issue #152 removed it,
// off the corner tag).
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
import { PIP_AREA, RING_STROKE, pipBounds, pipCenter, pipMetrics } from '../src/pips.js';
import type { Rect } from '../src/geometry.js';

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

test('the pip area is inside the face, centred, and takes the room the tag left', () => {
  assert.ok(contains(FACE, PIP_AREA), `PIP_AREA escapes the face: ${JSON.stringify(PIP_AREA)}`);
  // Issue #152: ~80% of the width and ~83% of the height, centred — the art
  // grew into the space the corner tag used to reserve.
  assert.ok(PIP_AREA.w >= 0.78 * TILE_W && PIP_AREA.w <= 0.82 * TILE_W, `area width ${PIP_AREA.w}`);
  assert.ok(PIP_AREA.h >= 0.81 * TILE_H && PIP_AREA.h <= 0.85 * TILE_H, `area height ${PIP_AREA.h}`);
  assert.ok(Math.abs(PIP_AREA.x + PIP_AREA.w / 2 - TILE_W / 2) < 0.01, 'not centred horizontally');
  assert.ok(Math.abs(PIP_AREA.y + PIP_AREA.h / 2 - TILE_H / 2) < 0.01, 'not centred vertically');
});

// --- the defect --------------------------------------------------------------

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

test('issue #152: rings are bold and the dense ranks keep visible gaps', () => {
  // Stroke ≈ 0.7 of the radius (was ≈ 0.42): the ring is mostly ink now.
  assert.ok(RING_STROKE >= 0.65 && RING_STROKE <= 0.75, `ring stroke ${RING_STROKE}`);
  // Dots-9 is the tightest ring rank; the gap between neighbouring rings must
  // survive the smallest phone tile (~0.4 board px per CSS px), so ≥ 2 board px.
  const nine = faceStyle('dots-9').pips!;
  const m9 = pipMetrics(nine);
  const centres = nine.map(pipCenter);
  let minGap = Infinity;
  for (let i = 0; i < centres.length; i++) {
    for (let j = i + 1; j < centres.length; j++) {
      minGap = Math.min(minGap, Math.hypot(centres[i]!.x - centres[j]!.x, centres[i]!.y - centres[j]!.y) - 2 * m9.ringR);
    }
  }
  assert.ok(minGap >= 2, `dots-9 ring gap ${minGap.toFixed(2)} board px`);
  // Bamboo-8 is four columns wide; canes in one row must keep clear water too.
  const eight = faceStyle('bamboo-8').pips!;
  const m8 = pipMetrics(eight);
  const rowGap = (eight[1]!.x - eight[0]!.x) * PIP_AREA.w - m8.caneW;
  assert.ok(rowGap >= 2, `bamboo-8 cane gap ${rowGap.toFixed(2)} board px`);
});

test('issue #152: canes are thick, and ranks 1-3 share one width', () => {
  const w = (face: string): number => pipMetrics(faceStyle(face).pips!).caneW;
  // ≈ 0.42 of the column pitch, capped at 21% of the pip area's width.
  assert.ok(Math.abs(w('bamboo-1') - 0.21 * PIP_AREA.w) < 0.01, `bamboo-1 width ${w('bamboo-1')}`);
  assert.equal(w('bamboo-1'), w('bamboo-2'));
  assert.equal(w('bamboo-1'), w('bamboo-3'));
  const pitch9 = PIP_AREA.w / 3;
  assert.ok(Math.abs(w('bamboo-9') - 0.42 * pitch9) < 0.01, `bamboo-9 width ${w('bamboo-9')}`);
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

// --- issue #163: Bamboo-6 and Bamboo-9 were the same three columns ------------

/** Smallest clear vertical gap between canes sharing a column, in board px. */
function rowGap(face: string): number {
  const pips = faceStyle(face).pips!;
  const m = pipMetrics(pips);
  let gap = Infinity;
  for (let i = 0; i < pips.length; i++) {
    for (let j = i + 1; j < pips.length; j++) {
      if (Math.abs(pips[i]!.x - pips[j]!.x) * PIP_AREA.w > 0.5) continue;
      gap = Math.min(gap, Math.abs(pips[i]!.y - pips[j]!.y) * PIP_AREA.h - m.caneH);
    }
  }
  return gap;
}

test('issue #163: every stacked bamboo rank leaves a clear row gap', () => {
  // Two canes nose to tail read as one long cane, so the gap between rows is
  // what makes a rank countable. Floor: 10% of the tile height — ~4 CSS px on
  // the smallest phone tile.
  for (const rank of [2, 4, 5, 6, 7, 8, 9]) {
    const gap = rowGap(`bamboo-${rank}`);
    assert.ok(gap >= TILE_H * 0.1, `bamboo-${rank} row gap ${gap.toFixed(2)} board px`);
  }
});

test('issue #163: bamboo-6 canes are markedly taller than bamboo-9 canes', () => {
  // Same footprint, same column count: the cane length is the shape cue that
  // tells the two ranks apart, so it has to be a difference you see, not one
  // you measure.
  const six = pipMetrics(faceStyle('bamboo-6').pips!).caneH;
  const nine = pipMetrics(faceStyle('bamboo-9').pips!).caneH;
  assert.ok(six >= 1.4 * nine, `bamboo-6 ${six.toFixed(1)} vs bamboo-9 ${nine.toFixed(1)}`);
});
