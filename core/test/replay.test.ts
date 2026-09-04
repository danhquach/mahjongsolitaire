// Replaying a move history against a regenerated deal (issue #187, decision
// 0030). The contract the leaderboard rests on: a history the game actually
// wrote replays to the same score on a cleared board, and a history the game
// could not have written is refused, naming the record.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { Board } from '../src/board.js';
import { generateLevel } from '../src/generator.js';
import type { GeneratedLevel } from '../src/generator.js';
import { parseLayout } from '../src/layouts.js';
import { MoveStack } from '../src/moves.js';
import type { MoveRecord } from '../src/moves.js';
import { replayMoves } from '../src/replay.js';
import { ScoreKeeper } from '../src/scoring.js';
import { solve } from '../src/solver.js';

/** What the client sends: the record minus its undo bookkeeping. */
function compact(moves: readonly MoveRecord[]): Record<string, unknown>[] {
  return moves.map((move) => {
    const { prevSelection, prevScores, ...rest } = move;
    void prevSelection;
    void prevScores;
    return rest;
  });
}

/** A played game to replay: the deal, the stack it was played on, its board. */
function played(level: GeneratedLevel, multiplier = 1) {
  const board = new Board(level.tiles);
  const stack = new MoveStack(board, new ScoreKeeper(multiplier));
  return { board, stack };
}

/** Clear whatever is left on `board` from the solver's witness, `stepMs` apart. */
function finish(board: Board, stack: MoveStack, fromMs: number, stepMs: number): number {
  const result = solve(board.allTiles(), { holder: board.holderSlots() });
  assert.equal(result.verdict, 'solvable');
  let t = fromMs;
  for (const [a, b] of result.solution!) {
    t += stepMs;
    stack.play(a, b, t);
  }
  return t;
}

/** A shipped 144-tile layout, not a 20-tile seed one: the scores the
 *  leaderboard bounds (72 pairs, 20970 flawless) are what is being checked. */
const TURTLE = parseLayout(
  JSON.parse(readFileSync(new URL('../../../data/layouts/turtle_classic.json', import.meta.url), 'utf8')),
);
const LEVEL = generateLevel(TURTLE, 187);

test('a flawless run replays to the score it earned, on a cleared board', () => {
  const { stack } = played(LEVEL, 1.5);
  LEVEL.solution.forEach(([a, b], i) => stack.play(a, b, (i + 1) * 1000));
  const verdict = replayMoves(LEVEL, compact(stack.state.moves), 1.5);
  assert.deepEqual(verdict, {
    ok: true,
    score: stack.score,
    matches: LEVEL.solution.length,
    cleared: true,
    lastMs: LEVEL.solution.length * 1000,
  });
});

test('the multiplier is the caller’s: the same moves pay differently per band', () => {
  const { stack } = played(LEVEL);
  LEVEL.solution.forEach(([a, b], i) => stack.play(a, b, (i + 1) * 10_000));
  const flat = replayMoves(LEVEL, compact(stack.state.moves), 1);
  const hard = replayMoves(LEVEL, compact(stack.state.moves), 2.5);
  assert.ok(flat.ok && hard.ok);
  assert.equal(flat.score, stack.score);
  assert.equal(hard.score, stack.score * 2.5);
});

test('a run that stopped short replays fine but is not cleared', () => {
  const { stack } = played(LEVEL);
  LEVEL.solution.slice(0, 10).forEach(([a, b], i) => stack.play(a, b, (i + 1) * 1000));
  const verdict = replayMoves(LEVEL, compact(stack.state.moves));
  assert.ok(verdict.ok);
  assert.equal(verdict.cleared, false);
  assert.equal(verdict.matches, 10);
});

test('holds, a return after an intervening match, and holder matches all replay', () => {
  const { board, stack } = played(LEVEL);
  // Park a free tile, match something else while it is out, bring it back —
  // the sequence a spliced-out hold record could never reproduce.
  const [a0, b0] = LEVEL.solution[0]!;
  const [a1, b1] = LEVEL.solution[1]!;
  stack.hold(a0, 1000);
  stack.play(a1, b1, 2000);
  assert.equal(stack.undo(3000)?.tile, a0);
  // And a pair cleared *through* the holder, so heldA/heldB are exercised.
  stack.hold(a0, 4000);
  stack.play(a0, b0, 5000);
  const end = finish(board, stack, 5000, 1000);
  assert.equal(board.inPlayTiles().length, 0);

  const verdict = replayMoves(LEVEL, compact(stack.state.moves));
  assert.deepEqual(verdict, {
    ok: true,
    score: stack.score,
    matches: LEVEL.solution.length,
    cleared: true,
    lastMs: end,
  });
});

test('a shuffled run replays: the recorded seed lands on the same faces', () => {
  const { board, stack } = played(LEVEL, 2);
  LEVEL.solution.slice(0, 20).forEach(([a, b], i) => stack.play(a, b, (i + 1) * 1000));
  assert.equal(stack.shuffle(0x9e3779b1, 21_000), true);
  // After a shuffle the witness no longer applies; the solver finds a new one.
  const mid = finish(board, stack, 21_000, 1000);
  assert.equal(stack.shuffle(77, mid + 500), false, 'nothing left to shuffle');
  assert.equal(board.inPlayTiles().length, 0);

  const verdict = replayMoves(LEVEL, compact(stack.state.moves), 2);
  assert.ok(verdict.ok, JSON.stringify(verdict));
  assert.equal(verdict.score, stack.score);
  assert.equal(verdict.cleared, true);
});

test('a history is refused at the first record the game could not have made', () => {
  const { stack } = played(LEVEL);
  LEVEL.solution.slice(0, 3).forEach(([a, b], i) => stack.play(a, b, (i + 1) * 1000));
  const honest = compact(stack.state.moves);
  // The fourth witness pair: still on the board and free after the three played.
  const third = LEVEL.solution[3];
  const cases: [string, unknown, string, number][] = [
    ['not a list', { moves: honest }, 'not_a_list', -1],
    ['a record that is not a move', [...honest, 42], 'malformed', 3],
    ['an unknown kind', [...honest, { kind: 'teleport', atMs: 4000 }], 'malformed', 3],
    ['a match with no ids', [...honest, { kind: 'match', atMs: 4000 }], 'malformed', 3],
    ['a negative id', [...honest, { kind: 'hold', tile: -1, slotIndex: 0, atMs: 4000 }], 'malformed', 3],
    ['a clock that runs backwards', [...honest, { ...honest[2]!, atMs: 500, a: third![0], b: third![1] }], 'time_backwards', 3],
    ['the same pair played twice', [...honest, { ...honest[0]!, atMs: 4000 }], 'illegal', 3],
    ['a pair of unknown tiles', [...honest, { kind: 'match', a: 9000, b: 9001, heldA: null, heldB: null, atMs: 4000 }], 'illegal', 3],
    ['a match that lies about the holder', [...honest, { kind: 'match', a: third![0], b: third![1], heldA: 0, heldB: null, atMs: 4000 }], 'holder_disagrees', 3],
    ['a hold that names the wrong slot', [...honest, { kind: 'hold', tile: third![0], slotIndex: 3, atMs: 4000 }], 'holder_disagrees', 3],
    ['a return of a tile that is not parked', [...honest, { kind: 'return', tile: third![0], slotIndex: 0, atMs: 4000 }], 'holder_disagrees', 3],
  ];
  for (const [name, moves, reason, index] of cases) {
    assert.deepEqual(replayMoves(LEVEL, moves), { ok: false, reason, index }, name);
  }
});

test('a return must name the newest parked tile — undo returns nothing else', () => {
  const { stack } = played(LEVEL);
  const [a0] = LEVEL.solution[0]!;
  const [a1] = LEVEL.solution[1]!;
  stack.hold(a0, 1000);
  stack.hold(a1, 2000);
  const moves = compact(stack.state.moves);
  // Claim the *older* park came back first.
  moves.push({ kind: 'return', tile: a0, slotIndex: 0, atMs: 3000 });
  assert.deepEqual(replayMoves(LEVEL, moves), { ok: false, reason: 'illegal', index: 2 });
});

test('a shuffle record the game could not have written is refused', () => {
  const { stack } = played(LEVEL);
  LEVEL.solution.slice(0, 3).forEach(([a, b], i) => stack.play(a, b, (i + 1) * 1000));
  const honest = compact(stack.state.moves);
  const cases: [string, unknown, string][] = [
    ['no attempt', { kind: 'shuffle', seed: 1, atMs: 4000 }, 'malformed'],
    ['a fractional attempt', { kind: 'shuffle', seed: 1, attempt: 0.5, atMs: 4000 }, 'malformed'],
    ['an attempt past what shuffleBoard tries', { kind: 'shuffle', seed: 1, attempt: 1000, atMs: 4000 }, 'illegal'],
  ];
  for (const [name, record, reason] of cases) {
    assert.deepEqual(replayMoves(LEVEL, [...honest, record]), { ok: false, reason, index: 3 }, name);
  }
  // And a shuffle of a cleared board: the client's shuffle records nothing there.
  const { stack: full } = played(LEVEL);
  LEVEL.solution.forEach(([a, b], i) => full.play(a, b, (i + 1) * 1000));
  const cleared = compact(full.state.moves);
  assert.deepEqual(
    replayMoves(LEVEL, [...cleared, { kind: 'shuffle', seed: 1, attempt: 0, atMs: 99_000 }]),
    { ok: false, reason: 'illegal', index: cleared.length },
  );
});

test('a shuffle is reproduced from its attempt, not re-solved — and a changed attempt changes the board', () => {
  const { board, stack } = played(LEVEL);
  LEVEL.solution.slice(0, 20).forEach(([a, b], i) => stack.play(a, b, (i + 1) * 1000));
  stack.shuffle(5, 21_000);
  finish(board, stack, 21_000, 1000);
  const moves = compact(stack.state.moves);
  const honest = replayMoves(LEVEL, moves);
  assert.ok(honest.ok && honest.cleared);
  // Any other attempt is a different permutation, so the matches that followed
  // no longer pair up somewhere — the run fails on its own moves.
  const other = moves.map((m) => (m['kind'] === 'shuffle' ? { ...m, attempt: (m['attempt'] as number) + 1 } : m));
  const forged = replayMoves(LEVEL, other);
  assert.equal(forged.ok, false);
  assert.equal(!forged.ok && forged.reason, 'illegal');
});

test('a replayed score is exact: a forged score cannot ride an honest history', () => {
  // The point of the ticket. The moves say what was earned; a client's own
  // `score` field is the Worker's cross-check, and here it would disagree.
  const { stack } = played(LEVEL);
  LEVEL.solution.forEach(([a, b], i) => stack.play(a, b, (i + 1) * 100));
  const verdict = replayMoves(LEVEL, compact(stack.state.moves));
  assert.ok(verdict.ok);
  assert.notEqual(verdict.score, 52_425, 'the ceiling is not what this run earned');
  assert.equal(verdict.score, 20_970, 'a flawless in-window run at ×1');
});

test('a full replay, shuffles included, fits a Worker’s CPU budget', () => {
  // Decision 0030 states the cost; this keeps the statement honest. Generous
  // bound so a slow CI box does not flake — the measured figure is a few ms,
  // and it would be hundreds if a shuffle were re-solved rather than replayed
  // from its attempt.
  const { board, stack } = played(LEVEL);
  LEVEL.solution.slice(0, 30).forEach(([a, b], i) => stack.play(a, b, (i + 1) * 1000));
  stack.shuffle(1, 31_000);
  stack.shuffle(2, 32_000);
  stack.shuffle(3, 33_000);
  finish(board, stack, 33_000, 1000);
  const moves = compact(stack.state.moves);
  const started = performance.now();
  const verdict = replayMoves(LEVEL, moves);
  const took = performance.now() - started;
  assert.ok(verdict.ok && verdict.cleared);
  assert.ok(took < 100, `replay took ${took.toFixed(1)} ms`);
});
