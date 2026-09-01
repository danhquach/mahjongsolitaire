// Holder: temporary tile store slots (issues #43, #63).
//
// Covers the ticket's acceptance criteria at the core layer: hold and
// holder-match as move types with exact undo, solver and hint treating held
// tiles as matchable, and determinism across a move list containing holds.
//
// Issue #63 (decision 0009, superseding 0008) makes the holder one-way, which
// inverts one property here and adds another. Issue #43's safety property —
// "no sequence of holds can turn a solvable position unwinnable" — is now
// *false* by design, so it is tested as false: a hold can lose the level, and
// there is a witness. What is still true is the narrower statement the solver
// actually rests on: holding never makes the *position* less winnable, only the
// player's remaining room. And `hasPlayableMove` now stops one slot short,
// because the park that fills the last slot is a loss rather than a way out.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Board, HOLDER_SLOTS } from '../src/board.js';
import type { Slot, TileId } from '../src/board.js';
import { generateLevel } from '../src/generator.js';
import { SEED_LAYOUTS } from '../src/layouts.js';
import { canMatch } from '../src/match.js';
import { MoveStack } from '../src/moves.js';
import { mulberry32 } from '../src/rng.js';
import { ScoreKeeper } from '../src/scoring.js';
import { shuffleBoard } from '../src/shuffle.js';
import { findHint, hasPlayableMove, legalPairs, solve, takeablePairs } from '../src/solver.js';

const slot = (x: number, y: number, z = 0): Slot => ({ x, y, z });

/**
 * Tile 1 sits on tile 0 and shares no face with anything free; tile 0's partner
 * (tile 2) is free the whole time. So the only way to a pair is to park tile 1.
 * Tile 3 gives tile 1 a partner of its own, keeping the deal solvable.
 */
function coveredBoard(): Board {
  return new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(0, 0, 1), face: 'bamboo-2' },
    { id: 2, slot: slot(4, 0, 0), face: 'dots-1' },
    { id: 3, slot: slot(8, 0, 0), face: 'bamboo-2' },
  ]);
}

/** Four spaced single-layer tiles, all free: two dots, two bamboo. */
function rowBoard(): Board {
  return new Board([
    { id: 0, slot: slot(0, 0), face: 'dots-1' },
    { id: 1, slot: slot(4, 0), face: 'dots-1' },
    { id: 2, slot: slot(8, 0), face: 'bamboo-2' },
    { id: 3, slot: slot(12, 0), face: 'bamboo-2' },
  ]);
}

// --- Board: holding and unholding ---------------------------------------------

test('holding a tile takes it off the lattice and frees what it covered', () => {
  const board = coveredBoard();
  assert.equal(board.isFree(0), false); // covered by tile 1
  assert.equal(board.hold(1), 0); // first empty slot
  assert.deepEqual(board.holderSlots(), [1, null, null, null]);
  assert.equal(board.isHeld(1), true);
  assert.equal(board.isFree(1), false); // not on the board any more…
  assert.equal(board.isMatchable(1), true); // …but still playable
  assert.equal(board.isFree(0), true); // the point of the whole feature
  assert.deepEqual(board.freeTileIds(), [0, 2, 3]);
  assert.deepEqual(board.matchableTileIds(), [0, 1, 2, 3]);
});

test('held tiles stay in play: present excludes them, in-play does not', () => {
  const board = coveredBoard();
  board.hold(1);
  assert.deepEqual(
    board
      .presentTiles()
      .map((t) => t.id)
      .sort(),
    [0, 2, 3],
  );
  assert.equal(board.inPlayTiles().length, 4);
  assert.deepEqual(board.heldTileIds(), [1]);
});

test('only free tiles can be held', () => {
  const board = coveredBoard();
  assert.throws(() => board.hold(0), /not free/); // covered
  assert.deepEqual(board.holderSlots(), [null, null, null, null]);
});

test('unhold — the undo mechanism — puts the tile back in its own slot', () => {
  // Not a player move since decision 0009: this is what MoveStack.undo rewinds
  // a hold with, and the only thing that still calls it.
  const board = coveredBoard();
  board.hold(1);
  board.unhold(1);
  assert.deepEqual(board.holderSlots(), [null, null, null, null]);
  assert.equal(board.isHeld(1), false);
  assert.equal(board.isFree(1), true);
  assert.equal(board.isFree(0), false); // covered once more
  assert.throws(() => board.unhold(1), /not held/);
});

test('a full holder throws rather than silently dropping a hold', () => {
  // Decision 0009 makes a full holder a lost level, so play never asks for a
  // fifth slot — the game controller gates on status first. This is the model
  // refusing an impossible call, not a rule.
  const board = new Board(
    Array.from({ length: 5 }, (_, i) => ({ id: i, slot: slot(i * 4, 0), face: `dots-${i + 1}` })),
  );
  for (let i = 0; i < HOLDER_SLOTS; i++) {
    assert.equal(board.holderVacancies(), HOLDER_SLOTS - i);
    board.hold(i);
  }
  assert.equal(board.holderFull(), true);
  assert.equal(board.holderVacancies(), 0);
  assert.throws(() => board.hold(4), /holder is full/);
  // Nothing moved: the fifth tile is still on the board.
  assert.equal(board.isHeld(4), false);
  assert.equal(board.isFree(4), true);
  assert.equal(board.inPlayTiles().length, 5);
});

test('matching out of the holder frees the slot; matching a held pair frees two', () => {
  const board = coveredBoard();
  board.hold(1);
  board.hold(3);
  assert.deepEqual(board.holderSlots(), [1, 3, null, null]);
  assert.equal(canMatch(board, 1, 3).ok, true); // holder to holder
  board.remove(1);
  board.remove(3);
  assert.deepEqual(board.holderSlots(), [null, null, null, null]);
  assert.equal(board.isMatchable(1), false); // removed, not held
});

test('a board round-trips through allTiles + holderSlots', () => {
  const board = coveredBoard();
  board.hold(1);
  board.remove(2);
  const copy = new Board(board.allTiles(), { holder: board.holderSlots() });
  assert.deepEqual(copy.holderSlots(), board.holderSlots());
  assert.deepEqual(copy.freeTileIds(), board.freeTileIds());
  assert.deepEqual(copy.matchableTileIds(), board.matchableTileIds());
});

test('a holder that does not describe the tiles is rejected at construction', () => {
  const tiles = [
    { id: 0, slot: slot(0, 0), face: 'dots-1' },
    { id: 1, slot: slot(4, 0), face: 'dots-1', removed: true },
  ];
  assert.throws(() => new Board(tiles, { holder: [7, null, null, null] }), /unknown tile 7/);
  assert.throws(() => new Board(tiles, { holder: [1, null, null, null] }), /removed tile 1/);
  assert.throws(() => new Board(tiles, { holder: [0, 0, null, null] }), /two holder slots/);
  assert.throws(
    () => new Board(tiles, { holder: [null, null, null, null, null], holderCapacity: 4 }),
    /capacity is 4/,
  );
});

// --- solver + hint (acceptance: no false "no moves left") ---------------------

test('legalPairs and hint see holder matches', () => {
  const board = coveredBoard();
  board.hold(1); // tile 0 (dots-1) is now free, partner tile 2 is free
  const pairs = legalPairs(board);
  assert.deepEqual(pairs, [
    [0, 2],
    [1, 3],
  ]);
  // The held tile's own pair is reachable too, and hint offers a real move.
  const hint = findHint(board);
  assert.notEqual(hint, null);
  assert.equal(canMatch(board, hint![0], hint![1]).ok, true);
});

test('a position whose only pair involves a held tile is not "no moves left"', () => {
  // Two tiles left: one parked, one on the board, and they match.
  const board = new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(0, 0, 1), face: 'dots-1' }, // covers tile 0
  ]);
  board.hold(1);
  assert.deepEqual(legalPairs(board), [[0, 1]]);
  assert.equal(hasPlayableMove(board), true);
  assert.equal(solve(board.allTiles(), { holder: board.holderSlots() }).verdict, 'solvable');
});

test('solve keeps a held tile off the lattice: it blocks nothing and is always free', () => {
  const board = coveredBoard();
  const before = solve(board.allTiles());
  assert.equal(before.verdict, 'solvable');
  board.hold(1);
  const after = solve(board.allTiles(), { holder: board.holderSlots() });
  assert.equal(after.verdict, 'solvable');
  // Held tiles are still counted for parity — dropping one would leave an odd
  // face count and report 'unsolvable'.
  assert.equal(
    solve(board.allTiles().filter((t) => t.id !== 1)).verdict,
    'unsolvable',
  );
});

test('hasPlayableMove looks ahead through holds — one deep', () => {
  const board = new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(0, 0, 1), face: 'bamboo-2' }, // covers tile 0
    { id: 2, slot: slot(4, 0, 0), face: 'dots-1' },
    { id: 3, slot: slot(8, 0, 0), face: 'bamboo-5' },
  ]);
  assert.deepEqual(legalPairs(board), []); // free: 1, 2, 3 — no two alike
  assert.equal(hasPlayableMove(board), true); // hold 1 and 0 pairs with 2
  // Exhausting the budget answers "stuck": conservative, never a phantom move.
  assert.equal(hasPlayableMove(board, { maxStates: 0 }), false);
  // And the probe never touches the caller's board.
  assert.deepEqual(board.holderSlots(), [null, null, null, null]);
  assert.deepEqual(board.freeTileIds(), [1, 2, 3]);
});

test('hasPlayableMove looks ahead through holds — two deep', () => {
  // Tiles 1 and 2 straddle tile 0 from above without overlapping each other,
  // so both have to be parked before tile 0 can pair with tile 3.
  const board = new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(-1, 0, 1), face: 'wind-east' },
    { id: 2, slot: slot(1, 0, 1), face: 'wind-south' },
    { id: 3, slot: slot(6, 0, 0), face: 'dots-1' },
  ]);
  assert.equal(board.isFree(0), false);
  assert.deepEqual(legalPairs(board), []);
  assert.equal(hasPlayableMove(board), true);
  // With only one slot left there is no way through, and that is a real deadlock.
  const oneSlot = new Board(board.allTiles(), { holderCapacity: 1 });
  assert.equal(hasPlayableMove(oneSlot), false);
});

test('hasPlayableMove says stuck when no hold can expose a pair', () => {
  const board = new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(0, 0, 1), face: 'bamboo-2' },
  ]);
  assert.equal(hasPlayableMove(board), false);
});

test('the park that fills the last slot is not a way out (decision 0009 / 0013)', () => {
  // Parking tile 1 frees tile 0, which pairs with tile 2 — the one-deep
  // lookahead above. Under issue #43 that made this position live at any holder
  // depth. Decision 0009 made the park that fills the holder a loss, and
  // decision 0013 (issue #93) made every pair transit the holder — so the
  // exposed pair itself must still be takeable: a board pair costs a park and
  // a clear, and needs two vacancies *after* the park that exposed it.
  const tiles = [
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(0, 0, 1), face: 'bamboo-2' }, // covers tile 0
    { id: 2, slot: slot(4, 0, 0), face: 'dots-1' },
    { id: 3, slot: slot(8, 0, 0), face: 'bamboo-5' },
  ];
  for (const capacity of [4, 3]) {
    const board = new Board(tiles, { holderCapacity: capacity });
    assert.deepEqual(legalPairs(board), [], `capacity ${capacity}: no pair on the board`);
    assert.equal(
      hasPlayableMove(board),
      true,
      `capacity ${capacity}: the exposed pair can still transit`,
    );
  }
  // Two slots: the park that exposes the pair leaves one vacancy, and the
  // exposed board pair would need that last slot to transit — a dead end
  // under issue #93, where it used to be live.
  const twoSlots = new Board(tiles, { holderCapacity: 2 });
  assert.deepEqual(legalPairs(twoSlots), []);
  assert.equal(hasPlayableMove(twoSlots), false, 'the exposed pair could not transit');
  const lastSlot = new Board(tiles, { holderCapacity: 1 });
  assert.deepEqual(legalPairs(lastSlot), []);
  assert.equal(hasPlayableMove(lastSlot), false, 'the only park would fill the holder');

  // Same thing reached the way a player reaches it: slots spent on tiles that
  // pair with nothing. With three vacancies the line is live (park tile 1,
  // then transit the exposed pair through the two slots left); with two it is
  // not, and with one even the park itself would lose.
  const spent = new Board([
    ...tiles,
    { id: 4, slot: slot(12, 0, 0), face: 'wind-east' },
    { id: 5, slot: slot(16, 0, 0), face: 'wind-south' },
    { id: 6, slot: slot(20, 0, 0), face: 'wind-west' },
  ]);
  spent.hold(4);
  assert.equal(spent.holderVacancies(), 3);
  assert.equal(hasPlayableMove(spent), true, 'three vacancies: park, then transit');
  spent.hold(5);
  assert.equal(spent.holderVacancies(), 2);
  assert.equal(hasPlayableMove(spent), false, 'two: the exposed pair could not transit');
  spent.hold(6);
  assert.equal(spent.holderVacancies(), 1);
  assert.deepEqual(legalPairs(spent), []);
  assert.equal(hasPlayableMove(spent), false, 'one: the only park would lose');
});

test('takeablePairs filters legal pairs down to the issue #93 gesture', () => {
  // dots-1 ×2 free on the board, bamboo-2 ×2 of which one is parked.
  const board = new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(4, 0, 0), face: 'dots-1' },
    { id: 2, slot: slot(8, 0, 0), face: 'bamboo-2' },
    { id: 3, slot: slot(12, 0, 0), face: 'bamboo-2' },
    { id: 4, slot: slot(16, 0, 0), face: 'wind-east' },
    { id: 5, slot: slot(20, 0, 0), face: 'wind-south' },
  ]);
  board.hold(2);
  // Board–held pair: one tap, always takeable. Board–board pair: needs two
  // vacancies to transit.
  assert.deepEqual(takeablePairs(board), [
    [0, 1],
    [2, 3],
  ]);
  board.hold(4);
  board.hold(5); // one vacancy left
  assert.deepEqual(
    takeablePairs(board),
    [[2, 3]],
    'with one vacancy only the board–held pair is takeable',
  );
  assert.equal(hasPlayableMove(board), true, 'and it keeps the position live');

  // A held–held pair has no gesture at all (a held tile is not tappable).
  const heldPair = new Board(
    [
      { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
      { id: 1, slot: slot(4, 0, 0), face: 'dots-1' },
      { id: 2, slot: slot(8, 0, 0), face: 'wind-east' },
    ],
    { holder: [0, 1, null, null] },
  );
  assert.deepEqual(legalPairs(heldPair), [[0, 1]], 'the pure match rule still sees it');
  assert.deepEqual(takeablePairs(heldPair), [], 'but no gesture can play it');
  assert.equal(hasPlayableMove(heldPair), false, 'so the position is honestly stuck');
});

test('shuffle permutes the board around a held tile, which keeps its own face', () => {
  // Regression: the candidate assignment was built from `allTiles()` and read a
  // held tile's new face out of a map that only covered *board* tiles — so
  // every held tile came back face `undefined`, every candidate failed the
  // solver's parity precheck, and Shuffle refused every board with an odd
  // number of tiles parked.
  for (const layout of SEED_LAYOUTS) {
    for (const heldCount of [1, 2]) {
      const board = new Board(generateLevel(layout, 11).tiles);
      for (let i = 0; i < heldCount; i++) board.hold(board.freeTileIds()[0]!);
      const heldFaces = board.heldTileIds().map((id) => board.get(id).face);
      const boardFaces = board
        .presentTiles()
        .map((t) => t.face)
        .sort();

      shuffleBoard(board, 4242);

      const label = `${layout.id}, ${heldCount} held`;
      assert.deepEqual(
        board.heldTileIds().map((id) => board.get(id).face),
        heldFaces,
        `${label}: a parked tile keeps its face`,
      );
      assert.deepEqual(
        board
          .presentTiles()
          .map((t) => t.face)
          .sort(),
        boardFaces,
        `${label}: the board's face multiset is preserved`,
      );
      assert.equal(
        solve(board.allTiles(), { holder: board.holderSlots() }).verdict,
        'solvable',
        `${label}: the shuffled position is still winnable`,
      );
    }
  }
});

// --- move stack: hold / holder-match ------------------------------------------

test('hold is a move: it is recorded, and undo returns the tile', () => {
  const board = coveredBoard();
  const stack = new MoveStack(board);
  const before = stack.stateHash();
  assert.equal(stack.hold(1, 1000), 0);
  assert.equal(stack.depth, 1);
  assert.equal(stack.holdsUsed, 1);
  assert.equal(stack.selection, null);
  assert.deepEqual(stack.moves(), []); // a hold is not a pair

  const undone = stack.undo();
  assert.equal(undone?.kind, 'hold');
  assert.deepEqual(board.holderSlots(), [null, null, null, null]);
  assert.equal(stack.holdsUsed, 0);
  assert.equal(stack.stateHash(), before);
});

test('the holder is one-way in play: a slot frees only by match or Undo', () => {
  // Decision 0009 as amended by issue #100. There is no `unhold` move on the
  // stack — a slot comes free by matching the tile in it, or by the Undo
  // booster returning the newest parked tile.
  const board = coveredBoard();
  const stack = new MoveStack(board);
  assert.equal('unhold' in stack, false, 'no return move exists on the stack');

  stack.hold(3, 1000);
  stack.hold(1, 2000);
  assert.deepEqual(board.holderSlots(), [3, 1, null, null]);
  assert.deepEqual(
    stack.state.moves.map((m) => m.kind),
    ['hold', 'hold'],
  );

  assert.equal(stack.undo()?.kind, 'hold');
  assert.deepEqual(board.holderSlots(), [3, null, null, null]);
  assert.equal(stack.holdsUsed, 1, 'and the undone hold stops counting');
});

test('a holder match is permanent: undo has nothing left to return', () => {
  const board = coveredBoard();
  const stack = new MoveStack(board);
  stack.hold(1, 1000); // slot 0
  stack.hold(3, 2000); // slot 1

  stack.play(1, 3, 3000); // holder to holder — both slots free again, for good
  assert.deepEqual(board.holderSlots(), [null, null, null, null]);
  assert.equal(board.get(1).removed, true);

  assert.equal(stack.undo(), null, 'matched out of the holder means gone');
  assert.equal(board.get(1).removed, true);
  assert.equal(board.get(3).removed, true);
});

test('undo after a mixed match returns only the tile still parked', () => {
  const board = coveredBoard();
  const stack = new MoveStack(board);
  stack.hold(1, 1000); // frees tile 0
  stack.play(0, 2, 2000); // both board tiles, played after the park
  const scoreAfter = stack.score;

  const undone = stack.undo();
  assert.equal(undone?.tile, 1, 'the parked tile comes back');
  assert.equal(board.isHeld(1), false);
  assert.equal(board.get(0).removed, true, 'the match played after it stays');
  assert.equal(board.get(2).removed, true);
  assert.equal(stack.score, scoreAfter, 'and its score stays too');
});

test('a full holder makes hold a no-op rather than an error — the level is over', () => {
  const board = new Board(
    Array.from({ length: 5 }, (_, i) => ({ id: i, slot: slot(i * 4, 0), face: `dots-${i + 1}` })),
  );
  const stack = new MoveStack(board);
  for (let i = 0; i < HOLDER_SLOTS; i++) assert.equal(stack.hold(i, (i + 1) * 1000), i);
  const full = stack.stateHash();
  assert.equal(stack.hold(4, 9000), null);
  assert.equal(stack.stateHash(), full);
  assert.equal(stack.depth, HOLDER_SLOTS);
  assert.equal(stack.holdsUsed, HOLDER_SLOTS);
});

test('the holder is part of the state hash, slot by slot', () => {
  const a = new MoveStack(rowBoard());
  const b = new MoveStack(rowBoard());
  a.hold(0, 1000);
  b.hold(0, 1000);
  assert.equal(a.stateHash(), b.stateHash());
  // Same tiles held, different slots: different states, because undo has to put
  // each tile back where it was.
  a.hold(1, 2000);
  a.hold(2, 3000);
  b.hold(2, 2000);
  b.hold(1, 3000);
  assert.notEqual(a.stateHash(), b.stateHash());
});

test('holder contents survive a state round-trip, undo depth included', () => {
  const board = coveredBoard();
  const stack = new MoveStack(board);
  stack.hold(1, 1000);
  stack.play(0, 2, 2000);
  stack.select(3);
  const live = stack.stateHash();

  const reopenedBoard = new Board(board.allTiles(), { holder: board.holderSlots() });
  const reopened = new MoveStack(reopenedBoard, new ScoreKeeper());
  reopened.restoreState(stack.state);
  assert.equal(reopened.stateHash(), live);
  assert.equal(reopened.holdsUsed, 1);

  // …and the parked tile is still returnable from there; the match stays.
  while (reopened.undo());
  assert.equal(reopenedBoard.holderSlots().every((s) => s === null), true);
  assert.equal(reopenedBoard.presentTiles().length, 2, 'the match is permanent');
});

test('a held tile is a selectable, restorable selection', () => {
  const board = coveredBoard();
  const stack = new MoveStack(board);
  stack.hold(1, 1000);
  stack.select(1);
  assert.equal(stack.selection, 1);
  const reopened = new MoveStack(new Board(board.allTiles(), { holder: board.holderSlots() }));
  reopened.restoreState(stack.state);
  assert.equal(reopened.selection, 1);
});

// --- acceptance: undo across a move list containing holds ---------------------

test('property: undo returns parked tiles newest-first, skipping matched-out parks', () => {
  const rng = mulberry32(0x43043043);
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [3, 77, 4242]) {
      const level = generateLevel(layout, seed);
      const board = new Board(level.tiles);
      const stack = new MoveStack(board);

      // A random script of holds and matches, in an order a player could
      // produce. Holds stop one slot short, because filling the holder ends
      // the level and a lost level has no further moves.
      const holdsInOrder: TileId[] = [];
      let clock = 0;
      for (let i = 0; i < 24; i++) {
        const free = board.freeTileIds();
        const pairs = legalPairs(board);
        const roll = rng();
        clock += 1000;
        if (roll < 0.45 && board.holderVacancies() > 1 && free.length > 0) {
          const tile = free[Math.floor(rng() * free.length)]!;
          stack.hold(tile, clock);
          holdsInOrder.push(tile);
        } else if (pairs.length > 0) {
          const pair = pairs[Math.floor(rng() * pairs.length)]!;
          stack.play(pair[0], pair[1], clock);
        } else break;
      }
      assert.ok(holdsInOrder.length > 0, 'script should contain a hold');

      const inPlayBefore = board.inPlayTiles().length;
      const scoreBefore = stack.score;
      // Expected returns: parked tiles still in the holder, newest first —
      // a park later matched out of the holder is not a candidate.
      const expected = holdsInOrder.filter((t) => board.isHeld(t)).reverse();
      assert.equal(stack.undoDepth, expected.length, `${layout.id} seed ${seed}`);

      for (const tile of expected) {
        assert.equal(stack.undo()?.tile, tile, `${layout.id} seed ${seed}: newest-first`);
      }
      assert.equal(stack.undo(), null, 'matches are permanent');
      assert.ok(board.holderSlots().every((slot) => slot === null));
      assert.equal(
        board.inPlayTiles().length,
        inPlayBefore,
        'returns never resurrect a matched tile',
      );
      assert.equal(stack.score, scoreBefore, 'returns never touch the score');
    }
  }
});

// --- acceptance: what holding does and no longer does (decision 0009) --------

test('property: holding never makes the position itself less winnable', () => {
  // The narrow statement `solve` rests on, and all that survives of issue #43's
  // safety property: a held tile is off the lattice, so every winning line of
  // the un-held position is still a winning line of the held one. What is gone
  // is the *player-facing* half — see the next test.
  const rng = mulberry32(0x5afe5afe);
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [1, 8, 64, 512]) {
      const level = generateLevel(layout, seed);
      const board = new Board(level.tiles);
      const stack = new MoveStack(board);
      let clock = 0;

      // Play into the middle of the level, then fill the holder at random.
      const played = Math.floor((rng() * level.solution.length) / 2);
      for (let i = 0; i < played; i++) {
        const pairs = legalPairs(board);
        if (pairs.length === 0) break;
        const pair = pairs[Math.floor(rng() * pairs.length)]!;
        stack.play(pair[0], pair[1], (clock += 1000));
      }
      const beforeHolds = solve(board.allTiles(), { holder: board.holderSlots() });
      assert.equal(beforeHolds.verdict, 'solvable', `${layout.id} seed ${seed} mid-level`);

      for (let i = 0; i < HOLDER_SLOTS; i++) {
        const free = board.freeTileIds();
        if (free.length === 0 || board.holderFull()) break;
        stack.hold(free[Math.floor(rng() * free.length)]!, (clock += 1000));
        assert.equal(
          solve(board.allTiles(), { holder: board.holderSlots() }).verdict,
          'solvable',
          `${layout.id} seed ${seed} with ${board.heldTileIds().length} held`,
        );
      }

      // Undo is the only way back, and it still is one: unwind to the start.
      while (board.heldTileIds().length > 0) assert.notEqual(stack.undo(), null);
      assert.deepEqual(board.holderSlots(), new Array(HOLDER_SLOTS).fill(null));
      assert.equal(
        solve(board.allTiles(), { holder: board.holderSlots() }).verdict,
        beforeHolds.verdict,
      );
    }
  }
});

test('property (inverted): a sequence of holds CAN lose a solvable level', () => {
  // Issue #43 / decision 0008 asserted the opposite, and decision 0009 reverses
  // it deliberately: the holder is a resource the player can spend themselves
  // out of. This is the witness that the reversal actually took — if it ever
  // goes green-by-accident, the one-way rule has been undone somewhere.
  const rng = mulberry32(0x105e105e);
  let witnesses = 0;
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [1, 8, 64, 512]) {
      const level = generateLevel(layout, seed);
      const board = new Board(level.tiles);
      const stack = new MoveStack(board);
      assert.equal(
        solve(board.allTiles()).verdict,
        'solvable',
        `${layout.id} seed ${seed} deals solvable`,
      );

      // Park four tiles that pair with nothing else currently matchable, so no
      // slot can be bought back. Skipped when the deal offers no such quartet.
      let clock = 0;
      while (!board.holderFull()) {
        const candidate = board
          .freeTileIds()
          .filter((id) => rng() >= 0) // keep the rng in step across layouts
          .find((id) => {
            const face = board.get(id).face;
            return !board
              .matchableTileIds()
              .some((other) => other !== id && board.get(other).face === face);
          });
        if (candidate === undefined) break;
        stack.hold(candidate, (clock += 1000));
      }
      if (!board.holderFull()) continue;
      witnesses++;

      // The position is *still* winnable — holding never hurt it — and the
      // player has still lost, because the holder is full and one-way.
      assert.equal(
        solve(board.allTiles(), { holder: board.holderSlots() }).verdict,
        'solvable',
        `${layout.id} seed ${seed}: the position stayed winnable`,
      );
      assert.equal(board.holderFull(), true, `${layout.id} seed ${seed}: and the level is lost`);
      // Every one of those four holds was legal when it was taken — the loss is
      // something the player walked into, not a state the model forbade.
      assert.equal(board.heldTileIds().length, HOLDER_SLOTS);
      assert.equal(stack.holdsUsed, HOLDER_SLOTS);
      // The "stops one slot short" boundary is not asserted here: with the
      // holder full, `holderVacancies() < 2` holds for any threshold, so the
      // answer would be the same whatever the rule said. That boundary has its
      // own unit test above.
    }
  }
  assert.ok(witnesses > 0, `the property needs at least one witness (${witnesses})`);
});

test('property: a level can be cleared entirely through the holder', () => {
  // Every pair played out of the holder rather than off the board. Under
  // decision 0009 this is no longer a safety claim about holds in general — the
  // test above is the counter-example — but the narrower one that still holds:
  // a hold taken to *play* a pair immediately never spends a slot, so a whole
  // level can still be cleared through the holder without ever filling it.
  const level = generateLevel(SEED_LAYOUTS[0]!, 21);
  const board = new Board(level.tiles);
  const stack = new MoveStack(board);
  let clock = 0;
  let guard = 0;
  while (board.inPlayTiles().length > 0) {
    assert.ok(guard++ < 500, 'clearing through the holder should terminate');
    const pairs = legalPairs(board);
    if (pairs.length > 0) {
      const [a, b] = pairs[0]!;
      // Park whichever half is still on the board, so the match is a holder one.
      if (!board.isHeld(a) && !board.holderFull()) stack.hold(a, (clock += 1000));
      stack.play(a, b, (clock += 1000));
      continue;
    }
    const free = board.freeTileIds();
    assert.ok(free.length > 0 && !board.holderFull(), 'should never run out of moves');
    stack.hold(free[0]!, (clock += 1000));
  }
  assert.equal(board.inPlayTiles().length, 0);
  assert.ok(stack.holdsUsed > 0);
});
