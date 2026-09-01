// The shipped layout data files (spec §4: "Layouts are data files (JSON), not
// code"; issue #17). Covers every file under /data/layouts: it parses, it is a
// full standard set, it stacks legally, and it generates playable deals.
//
// The 10,000-seeds × 10-layouts release gate (spec §11.1) is too slow for this
// suite — it runs as `npm run soak` / the `layout-soak` CI job. What runs here
// is the gate's own solvability proof (replaying the construction witness) on a
// small seed sample, plus a solver pass the soak deliberately skips, so a broken
// layout file fails the normal suite too.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { Board, slotKey } from '../src/board.js';
import { facesMatch, STANDARD_144 } from '../src/faces.js';
import { generateLevel, generateValidatedLevel } from '../src/generator.js';
import { parseLayout } from '../src/layouts.js';
import type { LayoutFile } from '../src/layouts.js';
import { solve } from '../src/solver.js';

const LAYOUT_DIR = new URL('../../../data/layouts/', import.meta.url);

/** Spec §4 names the seven classics; the rest are this project's originals. */
const EXPECTED_IDS = [
  'bridge',
  'butterfly',
  'cat',
  'fortress',
  'moon_gate',
  'pyramid',
  'spider',
  'terrace',
  'turtle_classic',
  'windmill',
];

const files = readdirSync(LAYOUT_DIR).filter((f) => f.endsWith('.json')).sort();
const layouts = new Map<string, LayoutFile>(
  files.map((file) => {
    const doc: unknown = JSON.parse(readFileSync(new URL(file, LAYOUT_DIR), 'utf8'));
    return [file, parseLayout(doc)];
  }),
);

test('ships exactly the 10 layouts of spec §4', () => {
  assert.deepEqual(
    files.map((f) => f.replace(/\.json$/, '')),
    EXPECTED_IDS,
  );
});

for (const [file, layout] of layouts) {
  test(`${file}: id matches filename, named, 144 slots, stacked`, () => {
    assert.equal(layout.id, file.replace(/\.json$/, ''));
    assert.ok(layout.name.length > 0);
    // A full standard set per layout (spec §3.4) — the generator draws its
    // pairs from the 144-tile pool, so every deal uses the whole set.
    assert.equal(layout.slots.length, STANDARD_144.length);
    assert.equal(new Set(layout.slots.map(slotKey)).size, layout.slots.length);
    const layers = [...new Set(layout.slots.map((s) => s.z))].sort((a, b) => a - b);
    assert.ok(layers.length >= 2, `${layout.id}: flat layout, nothing to unstack`);
    // Contiguous from 0 — a gap would mean a whole layer floats.
    assert.deepEqual(layers, layers.map((_, i) => i));
  });

  test(`${file}: fits the compact portrait frame (issue #99)`, () => {
    const xs = layout.slots.map((s) => s.x);
    const ys = layout.slots.map((s) => s.y);
    const zs = layout.slots.map((s) => s.z);
    const width = Math.max(...xs) + 2 - Math.min(...xs);
    const height = Math.max(...ys) + 2 - Math.min(...ys);
    // Issue #99: ≤9 tile columns keeps faces legible on a phone; height may
    // grow to ~10 rows, and depth carries the tile count instead of width.
    assert.ok(width <= 18, `${layout.id}: ${width} half-units wide (max 9 columns)`);
    assert.ok(height <= 20, `${layout.id}: ${height} half-units tall (max 10 rows)`);
    assert.ok(Math.max(...zs) >= 3, `${layout.id}: compact profile stacks 4–5 layers deep`);
  });

  test(`${file}: generates provably solvable deals`, () => {
    for (let seed = 1; seed <= 5; seed++) {
      // The soak's proof, on a sample: replay the generator's own witness
      // through the free-tile and match rules and require an empty board.
      // generateLevel, not generateValidatedLevel — the latter may reseed away
      // from the seed under test, which would hide a bad deal.
      const level = generateLevel(layout, seed * 104729);
      assert.equal(level.tiles.length, 144);
      assert.equal(level.solution.length, 72);
      const board = new Board(level.tiles);
      for (const [a, b] of level.solution) {
        assert.ok(board.isFree(a) && board.isFree(b), `seed ${seed}: pair ${a},${b} not free`);
        assert.ok(facesMatch(board.get(a).face, board.get(b).face), `seed ${seed}: faces differ`);
        board.remove(a);
        board.remove(b);
      }
      assert.equal(board.presentTiles().length, 0, `seed ${seed}: board not cleared`);
    }
  });

  test(`${file}: the bounded solver confirms its deals too`, () => {
    // Independent of the witness: the spec §4 post-generation validation path
    // the app actually calls, which reseeds if the DFS cannot confirm a deal.
    for (let seed = 1; seed <= 3; seed++) {
      const level = generateValidatedLevel(layout, seed * 7919);
      assert.equal(solve(level.tiles).verdict, 'solvable');
    }
  });

  test(`${file}: opens with at least one playable pair`, () => {
    for (let seed = 1; seed <= 5; seed++) {
      const level = generateValidatedLevel(layout, seed);
      const board = new Board(level.tiles);
      const faces = new Map<string, number>();
      for (const id of board.freeTileIds()) {
        const face = board.get(id).face;
        faces.set(face, (faces.get(face) ?? 0) + 1);
      }
      const pairs = [...faces.values()].reduce((n, c) => n + Math.floor(c / 2), 0);
      assert.ok(pairs >= 1, `${layout.id} seed ${seed}: no opening pair`);
    }
  });
}

test('turtle_classic keeps its compact layer counts 72/52/12/6/2', () => {
  const layout = layouts.get('turtle_classic.json')!;
  assert.equal(layout.name, 'Turtle');
  const byLayer = new Map<number, number>();
  for (const s of layout.slots) byLayer.set(s.z, (byLayer.get(s.z) ?? 0) + 1);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((z) => byLayer.get(z)),
    [72, 52, 12, 6, 2],
  );
});

test('turtle silhouette: cap covers the shell below it; the head tip starts free', () => {
  const layout = layouts.get('turtle_classic.json')!;
  const board = new Board(layout.slots.map((slot, id) => ({ id, slot, face: 'f' })));
  const idAt = (x: number, y: number, z: number) =>
    layout.slots.findIndex((s) => s.x === x && s.y === y && s.z === z);

  // The two-tile cap sits on the z3 shell ridge and covers it.
  for (const y of [8, 10] as const) {
    const cap = idAt(8, y, 4);
    assert.notEqual(cap, -1);
    assert.equal(board.isFree(cap), true);
    assert.equal(board.isCovered(idAt(8, y, 3)), true, `ridge tile at 8,${y},3 covered by the cap`);
  }
  // Head (row 0) and tail (row 9) tips are on the open edge and start free.
  assert.equal(board.isFree(idAt(6, 0, 0)), true);
  assert.equal(board.isFree(idAt(10, 18, 0)), true);
  // The shell interior starts buried.
  assert.equal(board.isFree(idAt(8, 8, 0)), false);
});

test('parseLayout rejects malformed documents', () => {
  assert.throws(() => parseLayout(null), /not an object/);
  assert.throws(() => parseLayout({ name: 'X', slots: [] }), /missing id/);
  assert.throws(() => parseLayout({ id: 'x', slots: [] }), /missing name/);
  assert.throws(() => parseLayout({ id: 'x', name: 'X', slots: 'nope' }), /must be an array/);
  assert.throws(() => parseLayout({ id: 'x', name: 'X', slots: [{ x: 0, y: 0, z: 0 }] }), /even/);
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

test('parseLayout rejects slots that float above the layer below', () => {
  // Nothing at all underneath.
  assert.throws(
    () =>
      parseLayout({
        id: 'x',
        name: 'X',
        slots: [
          { x: 0, y: 0, z: 0 },
          { x: 8, y: 0, z: 1 },
        ],
      }),
    /floats/,
  );
  // Half-overhanging: one supporter covers only half the footprint.
  assert.throws(
    () =>
      parseLayout({
        id: 'x',
        name: 'X',
        slots: [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 1 },
        ],
      }),
    /floats/,
  );
  // Two supporters together cover the whole footprint — legal (turtle's apex).
  assert.doesNotThrow(() =>
    parseLayout({
      id: 'x',
      name: 'X',
      slots: [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 1, y: 0, z: 1 },
        { x: 4, y: 0, z: 0 },
      ],
    }),
  );
});
