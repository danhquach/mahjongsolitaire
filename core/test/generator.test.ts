// Seeded reverse-construction level generator (issue #7, spec §4, §11.1).
//
// Acceptance: many seeds × each of the 3 seed layouts → 100% solvable
// (verified by replaying the generator's own solution witness through the
// free-tile + match rules), even tile count per matchable group, every slot
// filled, fully deterministic given (layoutId, seed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Board, slotKey } from '../src/board.js';
import { facesMatch, STANDARD_144 } from '../src/faces.js';
import { generateLevel } from '../src/generator.js';
import type { GeneratedLevel } from '../src/generator.js';
import { SEED_LAYOUTS } from '../src/layouts.js';
import type { Layout } from '../src/layouts.js';

// Number of seeds per layout for the acceptance sweep. The roadmap gate is
// 10,000 × 3 layouts; that full sweep runs in this suite (spec §11.1 says it
// becomes a permanent release gate). Override with GEN_SWEEP_SEEDS for a
// quicker local run.
const SWEEP_SEEDS = Number(process.env.GEN_SWEEP_SEEDS ?? 10_000);

/** Replay the solution witness: every pair must be free + matching when
 *  played, and the board must be empty at the end. */
function assertSolvableByWitness(layout: Layout, level: GeneratedLevel): void {
  const board = new Board(level.tiles);
  for (const [a, b] of level.solution) {
    assert.ok(board.isFree(a), `tile ${a} not free when its solution step plays`);
    assert.ok(board.isFree(b), `tile ${b} not free when its solution step plays`);
    assert.ok(
      facesMatch(board.get(a).face, board.get(b).face),
      `solution pair ${a},${b} faces do not match`,
    );
    board.remove(a);
    board.remove(b);
  }
  assert.equal(board.presentTiles().length, 0, 'board not cleared by solution');
}

test('seed layouts: 3 layouts, even slot counts, distinct ids', () => {
  assert.equal(SEED_LAYOUTS.length, 3);
  const ids = new Set(SEED_LAYOUTS.map((l) => l.id));
  assert.equal(ids.size, 3);
  for (const layout of SEED_LAYOUTS) {
    assert.ok(layout.slots.length >= 4, `${layout.id}: too few slots`);
    assert.equal(layout.slots.length % 2, 0, `${layout.id}: odd slot count`);
  }
});

test('deterministic: same (layout, seed) → identical tiles and solution', () => {
  for (const layout of SEED_LAYOUTS) {
    const a = generateLevel(layout, 12345);
    const b = generateLevel(layout, 12345);
    assert.deepEqual(a, b);
  }
});

test('different seeds produce different deals', () => {
  const layout = SEED_LAYOUTS[0]!;
  const deals = new Set(
    [1, 2, 3, 4, 5].map((seed) =>
      JSON.stringify(generateLevel(layout, seed).tiles.map((t) => t.face)),
    ),
  );
  assert.ok(deals.size > 1, 'all 5 seeds produced the same deal');
});

test('every slot filled exactly once, ids stable 0..n-1 in slot order', () => {
  for (const layout of SEED_LAYOUTS) {
    const level = generateLevel(layout, 7);
    assert.equal(level.tiles.length, layout.slots.length);
    const layoutKeys = layout.slots.map(slotKey);
    for (const [i, tile] of level.tiles.entries()) {
      assert.equal(tile.id, i, 'tile ids must be 0..n-1 in layout slot order');
      assert.equal(slotKey(tile.slot), layoutKeys[i]);
    }
  }
});

test('even tile count per face (identical-only matching); faces within the standard-144 multiset', () => {
  const available = new Map<string, number>();
  for (const face of STANDARD_144) {
    available.set(face, (available.get(face) ?? 0) + 1);
  }
  for (const layout of SEED_LAYOUTS) {
    const level = generateLevel(layout, 99);
    const faceCounts = new Map<string, number>();
    for (const t of level.tiles) {
      faceCounts.set(t.face, (faceCounts.get(t.face) ?? 0) + 1);
    }
    for (const [face, count] of faceCounts) {
      assert.equal(count % 2, 0, `${layout.id}: odd count for face ${face}`);
      assert.ok(
        count <= (available.get(face) ?? 0),
        `${layout.id}: face ${face} used ${count}× but only ${available.get(face) ?? 0} exist`,
      );
    }
  }
});

test('rejects a layout with more slots than the tile set can fill', () => {
  const slots = [];
  for (let x = 0; x < 2 * 146; x += 2) slots.push({ x, y: 0, z: 0 });
  const tooBig: Layout = { id: 'too-big', slots };
  assert.throws(() => generateLevel(tooBig, 1), /tile set/i);
});

test('rejects a layout with an odd slot count', () => {
  const odd: Layout = {
    id: 'odd',
    slots: [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
    ],
  };
  assert.throws(() => generateLevel(odd, 1), /even/i);
});

test(`acceptance sweep: ${SWEEP_SEEDS} seeds × 3 seed layouts → 100% solvable`, () => {
  for (const layout of SEED_LAYOUTS) {
    for (let seed = 0; seed < SWEEP_SEEDS; seed++) {
      const level = generateLevel(layout, seed);
      assertSolvableByWitness(layout, level);
    }
  }
});
