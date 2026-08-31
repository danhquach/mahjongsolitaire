// Turtle layout data + loader validation (issue #11; JSON-as-data per spec §9).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Board, generateValidatedLevel } from '@mahjongsolitaire/core';
import { parseLayout } from '../src/layout-loader.js';

const TURTLE_URL = new URL('../../../data/layouts/turtle_classic.json', import.meta.url);
const turtleDoc: unknown = JSON.parse(readFileSync(TURTLE_URL, 'utf8'));

test('turtle_classic parses: 144 slots, classic layer counts 87/36/16/4/1', () => {
  const layout = parseLayout(turtleDoc);
  assert.equal(layout.id, 'turtle_classic');
  assert.equal(layout.name, 'Turtle');
  assert.equal(layout.slots.length, 144);
  const byLayer = new Map<number, number>();
  for (const s of layout.slots) byLayer.set(s.z, (byLayer.get(s.z) ?? 0) + 1);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((z) => byLayer.get(z)),
    [87, 36, 16, 4, 1],
  );
});

test('turtle apex covers the 2×2 below it; wings start free', () => {
  const layout = parseLayout(turtleDoc);
  const board = new Board(layout.slots.map((slot, id) => ({ id, slot, face: 'f' })));
  const idAt = (x: number, y: number, z: number) =>
    layout.slots.findIndex((s) => s.x === x && s.y === y && s.z === z);

  const apex = idAt(11, 7, 4);
  assert.notEqual(apex, -1);
  assert.equal(board.isFree(apex), true);
  for (const [x, y] of [
    [10, 6],
    [12, 6],
    [10, 8],
    [12, 8],
  ] as const) {
    const id = idAt(x, y, 3);
    assert.notEqual(id, -1);
    assert.equal(board.isCovered(id), true, `z3 tile at ${x},${y} must be covered by the apex`);
  }
  // Left and right wings straddle two rows and have an open outer edge.
  assert.equal(board.isFree(idAt(-2, 7, 0)), true);
  assert.equal(board.isFree(idAt(26, 7, 0)), true);
  assert.equal(board.isFree(idAt(24, 7, 0)), false); // blocked both sides
});

test('turtle generates solver-validated solvable deals (sample of seeds)', () => {
  const layout = parseLayout(turtleDoc);
  for (let seed = 1; seed <= 25; seed++) {
    const level = generateValidatedLevel(layout, seed * 104729);
    assert.equal(level.tiles.length, 144);
    assert.equal(level.solution.length, 72);
  }
});

test('parseLayout rejects malformed documents', () => {
  assert.throws(() => parseLayout(null), /not an object/);
  assert.throws(() => parseLayout({ name: 'X', slots: [] }), /missing id/);
  assert.throws(() => parseLayout({ id: 'x', slots: [] }), /missing name/);
  assert.throws(() => parseLayout({ id: 'x', name: 'X', slots: 'nope' }), /must be an array/);
  assert.throws(
    () => parseLayout({ id: 'x', name: 'X', slots: [{ x: 0, y: 0, z: 0 }] }),
    /even/,
  );
  assert.throws(
    () => parseLayout({ id: 'x', name: 'X', slots: [{ x: 0, y: 0 }, { x: 2, y: 0, z: 0 }] }),
    /slot 0 malformed/,
  );
  // Same-layer overlap and non-integer coords are caught by the Board lattice.
  assert.throws(() =>
    parseLayout({
      id: 'x',
      name: 'X',
      slots: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
      ],
    }),
  );
  assert.throws(() =>
    parseLayout({
      id: 'x',
      name: 'X',
      slots: [
        { x: 0.5, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
      ],
    }),
  );
});
