// The weekly leaderboard (issue #176, superseding the Daily board of #70),
// with server-side verification of every run (issue #187, decision 0030).
//
// The ranking is the part worth testing hard: it is SQL, it has a tie-break,
// and "your rank and the entries around you" is three separate queries that
// have to agree with each other. So the board tests run against a real SQLite
// database built from the real schema files (see ./d1.mjs), not a fake.
//
// Since issue #187 a submission is only accepted if its move history replays
// against the regenerated deal to the claimed score on a cleared board, so
// every run these tests post is a real one: `playedRun` plays a ladder level's
// witness solution through core's own move stack and posts what that recorded.
// Score differences between players come from how many matches were made
// inside the combo window, which is the only honest way to vary a score.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

// Reaches into core's *build output*, exactly as the Worker itself does since
// issue #187 (worker/replay.mjs). Core must be built before this suite runs —
// `npm --prefix core run build`, which CLAUDE.md's command order and CI both
// already do before the worker tests.
import {
  Board,
  MAX_RUN_SCORE as CORE_MAX_RUN_SCORE,
  MoveStack,
  ScoreKeeper,
  generateLevel,
  parseLadder,
  parseLayout,
  scoreMultiplierForLevel,
  solve,
} from '../../core/dist/src/index.js';
import { createRateLimitStore } from '../http.mjs';
import {
  BOARD_TOP,
  MAX_RUNS_PER_WEEK,
  MAX_RUN_SCORE,
  MAX_WEEK_SCORE,
  WEEK_MS,
  handleLeaderboard,
  validateSubmission,
  weekResetAt,
  weekStartKey,
} from '../leaderboard.mjs';
import { MAX_SHUFFLES_PER_RUN, verifyRun } from '../replay.mjs';
import { handleRequest } from '../index.mjs';
import { authenticate, handleProfile } from '../profile.mjs';
import { createDb } from './d1.mjs';

/** A Thursday, so the week around it is unambiguous and the tests do not move
 *  with the calendar. The week it belongs to opened on Sunday 2026-08-30. */
const NOW = Date.parse('2026-09-03T12:00:00Z');
const WEEK = '2026-08-30';
const LAST_WEEK_NOW = NOW - WEEK_MS;

function seededRandomBytes() {
  let n = 0;
  return (count) => Uint8Array.from({ length: count }, () => ((n += 1) * 97 + 41) & 0xff);
}

function makeDeps(overrides = {}) {
  return {
    authenticate,
    now: () => NOW,
    randomBytes: seededRandomBytes(),
    rateLimitStore: createRateLimitStore(),
    ...overrides,
  };
}

function request(method, path, { body, headers = {} } = {}) {
  return new Request(`https://lantern.example${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const bearer = (code) => ({ Authorization: `Bearer ${code}` });

// --- real runs ---------------------------------------------------------------

const DATA = new URL('../../data/', import.meta.url);
const LADDER = parseLadder(JSON.parse(readFileSync(new URL('ladder.json', DATA), 'utf8')));
const layouts = new Map();
function layoutFor(id) {
  if (!layouts.has(id)) {
    layouts.set(id, parseLayout(JSON.parse(readFileSync(new URL(`layouts/${id}.json`, DATA), 'utf8'))));
  }
  return layouts.get(id);
}
const deals = new Map();
/** The deal ladder level `level` plays — the same regeneration the Worker does. */
function dealFor(level) {
  if (!deals.has(level)) {
    const entry = LADDER[level - 1];
    deals.set(level, generateLevel(layoutFor(entry.layoutId), entry.seed));
  }
  return deals.get(level);
}
/** A level in the hard band, where a flawless run pays exactly MAX_RUN_SCORE. */
const HARD_LEVEL = LADDER.find((e) => scoreMultiplierForLevel(e.level) === 2.5).level;

/** What the client sends: the record minus the undo bookkeeping it strips. */
function compact(moves) {
  return moves.map(({ prevSelection, prevScores, ...rest }) => rest);
}

/** A fresh board and stack on `level`'s deal, scored at its band. */
function fresh(level) {
  const deal = dealFor(level);
  const board = new Board(deal.tiles);
  const stack = new MoveStack(board, new ScoreKeeper(scoreMultiplierForLevel(level)));
  return { deal, board, stack };
}

/** The submission a finished game produces from its stack. */
function submissionOf(level, stack, lastMs) {
  return {
    score: stack.score,
    elapsedMs: Math.max(20_000, Math.ceil(lastMs) + 1000),
    history: {
      layoutId: dealFor(level).layoutId,
      seed: dealFor(level).seed,
      shuffles: stack.state.moves.filter((m) => m.kind === 'shuffle').length,
      moves: compact(stack.state.moves),
    },
  };
}

/**
 * A real, verifiable clear of ladder `level`: the witness solution, with the
 * first `combo` matches one second apart (inside the Super Combo window) and
 * the rest ten seconds apart. The score rises with `combo`, so distinct values
 * are easy to come by and equal ones easy to make on purpose.
 */
function playedRun(level = 1, combo = 0) {
  const { deal, stack } = fresh(level);
  let t = 0;
  deal.solution.forEach(([a, b], i) => {
    t += i < combo ? 1000 : 10_000;
    stack.play(a, b, t);
  });
  return submissionOf(level, stack, t);
}

/** Clear whatever is left on `board` from the solver's witness. */
function finish(board, stack, fromMs) {
  const result = solve(board.allTiles(), { holder: board.holderSlots() });
  assert.equal(result.verdict, 'solvable');
  let t = fromMs;
  for (const [a, b] of result.solution) {
    t += 10_000;
    stack.play(a, b, t);
  }
  return t;
}

/** A registered player, so an entry has an owner and a display name. Each
 *  registration comes from its own address: these are meant to be different
 *  people, and the profile route caps registrations per address (in the
 *  database since issue #186, so a throwaway store no longer bypasses it). */
let nextAddress = 0;
async function addPlayer(env, deps, name) {
  nextAddress += 1;
  const response = await handleProfile(
    request('POST', '/api/profile/register', {
      headers: { 'CF-Connecting-IP': `203.0.${Math.floor(nextAddress / 256)}.${nextAddress % 256}` },
      body: { name, avatar: 'lantern', record: {} },
    }),
    env,
    deps,
  );
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return { name, code: body.code, playerId: body.playerId };
}

async function post(env, deps, player, body, at = NOW) {
  const response = await handleLeaderboard(
    request('POST', '/api/leaderboard/weekly', { headers: bearer(player.code), body }),
    env,
    { ...deps, now: () => at },
  );
  return { status: response.status, body: await response.json() };
}

async function board(env, deps, player = null, at = NOW) {
  const response = await handleLeaderboard(
    request('GET', '/api/leaderboard/weekly', {
      headers: player === null ? {} : bearer(player.code),
    }),
    env,
    { ...deps, now: () => at },
  );
  return { status: response.status, body: await response.json() };
}

const count = (env, table) => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/** A board with `count` players on it, each scoring less than the one before
 *  (fewer combo matches), so rank and score tell the same story and an
 *  off-by-one is obvious. Returns the players and the run each one posted. */
async function fillBoard(env, deps, count) {
  const players = [];
  for (let i = 0; i < count; i += 1) {
    const player = await addPlayer(env, deps, `Player ${i + 1}`);
    const run = playedRun(1, 60 - i * 2);
    // Submitted a second apart so the tie-break has something to order by.
    const { status } = await post(env, deps, player, run, NOW + i * 1000);
    assert.equal(status, 200);
    players.push({ ...player, run });
  }
  return players;
}

// --- the week ----------------------------------------------------------------

test('the week is the Sunday that opens it, on the server’s own clock', () => {
  assert.equal(weekStartKey(NOW), WEEK);
  assert.equal(weekStartKey(Date.parse('2026-09-06T00:00:00Z')), '2026-09-06');
  assert.equal(weekStartKey(Date.parse('2026-09-05T23:59:59.999Z')), WEEK);
  assert.equal(weekResetAt(NOW), Date.parse('2026-09-06T00:00:00Z'));
});

test('the server’s week matches core’s, so the client counts down to the same instant', async () => {
  // The client computes its own week so an offline player still has one to
  // score into. The two must agree by construction, not by trust.
  const core = await import('../../core/dist/src/week.js');
  for (const iso of [
    '2026-09-03T12:00:00Z',
    '2026-09-06T00:00:00Z',
    '2026-09-05T23:59:59.999Z',
    '2027-01-01T09:00:00Z',
    '2028-02-29T18:00:00Z',
  ]) {
    const at = Date.parse(iso);
    assert.equal(weekStartKey(at), core.weekStartKey(at), iso);
    assert.equal(weekResetAt(at), core.weekResetAt(at), iso);
  }
});

// --- validation --------------------------------------------------------------

test('a score outside what one run can produce is not a score', () => {
  const ok = validateSubmission({ score: MAX_RUN_SCORE, elapsedMs: 90_000 });
  assert.equal(ok.score, MAX_RUN_SCORE);
  assert.equal(validateSubmission({ score: MAX_RUN_SCORE + 1, elapsedMs: 90_000 }), 'bad_score');
  assert.equal(validateSubmission({ score: -1, elapsedMs: 90_000 }), 'bad_score');
  assert.equal(validateSubmission({ score: 1.5, elapsedMs: 90_000 }), 'bad_score');
  assert.equal(validateSubmission({ score: 100, elapsedMs: -1 }), 'invalid');
  assert.equal(validateSubmission(null), 'invalid');
});

test('a very long level is clamped, not dropped', () => {
  // A ladder level has no time limit and elapsedMs survives a resume, so a
  // player who leaves one open overnight legitimately passes a day. Rejecting
  // would silently lose the run — the submit is fire-and-forget, so the
  // profile would count the score and the board would not.
  const long = validateSubmission({ score: 4200, elapsedMs: 3 * 24 * 60 * 60 * 1000 });
  assert.equal(long.score, 4200);
  assert.equal(long.elapsedMs, 24 * 60 * 60 * 1000, 'clamped to the ceiling');
});

test('the run bound is core’s, not a second opinion', () => {
  // The Worker imports core since issue #187, so this is the same constant —
  // the test stays as the statement that it must be.
  assert.equal(MAX_RUN_SCORE, CORE_MAX_RUN_SCORE);
  assert.equal(playedRun(HARD_LEVEL, 72).score, MAX_RUN_SCORE, 'a flawless hard-band run is the ceiling');
});

test('a submission carries no week — the server decides which one it lands in', () => {
  // The Daily board took a date from the client and needed skew and age guards
  // to keep it honest. Anything a caller says about the week is ignored here,
  // which is what makes those guards unnecessary rather than merely absent.
  const claimed = validateSubmission({
    score: 100,
    elapsedMs: 90_000,
    week: '1999-01-03',
    weekStart: '1999-01-03',
    date: '1999-01-03',
  });
  assert.deepEqual(claimed, { score: 100, elapsedMs: 90_000, history: null, run: null });
});

test('the move history is kept whole for the row, bounded, and handed on for replay', () => {
  assert.equal(validateSubmission({ score: 1, elapsedMs: 90_000 }).history, null);
  const withHistory = validateSubmission({ score: 1, elapsedMs: 90_000, history: { moves: [1] } });
  assert.equal(withHistory.history, '{"moves":[1]}');
  assert.deepEqual(withHistory.run, { moves: [1] });
  const huge = validateSubmission({
    score: 1,
    elapsedMs: 90_000,
    history: Array(20000).fill({ a: 1, b: 2 }),
  });
  assert.equal(huge, 'invalid');
});

test('a run under a plausible length is not a run', () => {
  // 72 pairs in under 20 seconds is 3.6 matches a second sustained. The replay
  // checks the moves, not the pace — the timestamps are the client's — so the
  // floor stays.
  assert.equal(validateSubmission({ score: 40_000, elapsedMs: 0 }), 'invalid');
  assert.equal(validateSubmission({ score: 40_000, elapsedMs: 19_999 }), 'invalid');
  assert.ok(validateSubmission({ score: 40_000, elapsedMs: 20_000 }).score);
});

test('a deeply nested history is refused, not thrown', () => {
  // JSON.stringify recurses, so a nested-enough payload throws RangeError
  // before any length check. Nothing above the route catches it, so without a
  // guard this answers a platform exception instead of a 400.
  let nested = [];
  for (let i = 0; i < 60_000; i += 1) nested = [nested];
  assert.equal(validateSubmission({ score: 100, elapsedMs: 90_000, history: nested }), 'invalid');
});

// --- verification (issue #187) -----------------------------------------------

test('the ticket’s repro: a ceiling score with no history is refused, and nothing is written', async () => {
  // Steps to reproduce on issue #187 — this used to answer 200 and raise the
  // standing by the maximum single-run score.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const { status, body } = await post(env, deps, alex, { score: 52425, elapsedMs: 60_000 });
  assert.equal(status, 422);
  assert.deepEqual(body, { error: 'run_rejected', reason: 'history_missing' });
  assert.equal(count(env, 'weekly_scores'), 0);
  assert.equal(count(env, 'weekly_submissions'), 0);
  assert.equal((await board(env, deps, alex)).body.you, null);
});

test('a real run replays to its own score and is accepted', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 10);
  const { status, body } = await post(env, deps, alex, run);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.you.score, run.score);
});

test('the stored score is the replay’s, at the level’s own band multiplier', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const easy = playedRun(1, 0);
  const hard = playedRun(HARD_LEVEL, 0);
  assert.equal(easy.score, 7200, '72 pairs at ×1 with no combos');
  assert.equal(hard.score, 7200 * 2.5, 'the same play on a hard level pays the band');
  assert.equal((await post(env, deps, alex, easy)).status, 200);
  assert.equal((await post(env, deps, alex, hard, NOW + 1000)).status, 200);
  const rows = env.DB.raw.prepare('SELECT score FROM weekly_submissions ORDER BY id').all();
  assert.deepEqual(
    rows.map((r) => r.score),
    [7200, 18_000],
  );
});

test('a run whose claimed score is not what its moves earn is refused', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 0);
  const inflated = await post(env, deps, alex, { ...run, score: run.score + 100 });
  assert.equal(inflated.status, 422);
  assert.deepEqual(inflated.body, { error: 'run_rejected', reason: 'score_mismatch' });
  // Claiming *less* is refused too: the number is the replay's or nothing.
  const modest = await post(env, deps, alex, { ...run, score: run.score - 100 });
  assert.equal(modest.status, 422);
  assert.equal(count(env, 'weekly_submissions'), 0);
});

test('a history that does not replay is refused at the move that breaks it', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 0);
  const moves = [...run.history.moves];
  // Play the last pair first: those tiles are covered at the start.
  moves.unshift({ ...moves[moves.length - 1], atMs: 0 });
  const { status, body } = await post(env, deps, alex, { ...run, history: { ...run.history, moves } });
  assert.equal(status, 422);
  assert.deepEqual(body, { error: 'run_rejected', reason: 'illegal', index: 0 });
});

test('a deal that is not a ladder level cannot be scored', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 0);
  const offLadder = await post(env, deps, alex, {
    ...run,
    history: { ...run.history, seed: run.history.seed + 1 },
  });
  assert.deepEqual(offLadder.body, { error: 'run_rejected', reason: 'unknown_deal' });
  const noSuchLayout = await post(env, deps, alex, {
    ...run,
    history: { ...run.history, layoutId: 'castle' },
  });
  assert.deepEqual(noSuchLayout.body, { error: 'run_rejected', reason: 'unknown_deal' });
  const malformed = await post(env, deps, alex, { ...run, history: { moves: run.history.moves } });
  assert.deepEqual(malformed.body, { error: 'run_rejected', reason: 'history_malformed' });
  const notAnObject = await post(env, deps, alex, { ...run, history: [[1, 2]] });
  assert.deepEqual(notAnObject.body, { error: 'run_rejected', reason: 'history_malformed' });
});

test('a run that stopped short of clearing the board is not a clear', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const { deal, stack } = fresh(1);
  deal.solution.slice(0, 71).forEach(([a, b], i) => stack.play(a, b, (i + 1) * 10_000));
  const { status, body } = await post(env, deps, alex, submissionOf(1, stack, 710_000));
  assert.equal(status, 422);
  assert.deepEqual(body, { error: 'run_rejected', reason: 'not_cleared' });
});

test('a run cannot have ended before its last move', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 0); // last move at 720 s
  const { status, body } = await post(env, deps, alex, { ...run, elapsedMs: 600_000 });
  assert.equal(status, 422);
  assert.deepEqual(body, { error: 'run_rejected', reason: 'elapsed_before_last_move' });
  // A run whose last move is past the day clamp is still fine: the clamp is
  // what elapsedMs is held against, so an overnight level does not fail.
  const { deal, stack } = fresh(1);
  const day = 24 * 60 * 60 * 1000;
  deal.solution.forEach(([a, b], i) => stack.play(a, b, day + (i + 1) * 10_000));
  const overnight = await post(env, deps, alex, {
    ...submissionOf(1, stack, day + 720_000),
  });
  assert.equal(overnight.status, 200, JSON.stringify(overnight.body));
});

test('a run that shuffled replays from the recorded seed', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const { deal, board: b, stack } = fresh(1);
  deal.solution.slice(0, 20).forEach(([a, c], i) => stack.play(a, c, (i + 1) * 10_000));
  assert.equal(stack.shuffle(0x9e3779b1, 205_000), true);
  const end = finish(b, stack, 205_000);
  const run = submissionOf(1, stack, end);
  assert.equal(run.history.shuffles, 1);
  const { status, body } = await post(env, deps, alex, run);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.you.score, run.score);
  // The same moves with the seed changed land on different faces, so the
  // matches after the shuffle no longer pair up.
  const moves = run.history.moves.map((m) => (m.kind === 'shuffle' ? { ...m, seed: 7 } : m));
  const forged = await post(env, deps, alex, { ...run, history: { ...run.history, moves } }, NOW + 1000);
  assert.equal(forged.status, 422);
  assert.equal(forged.body.reason, 'illegal');
});

test('a run that parked, matched and undid replays too', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const { deal, board: b, stack } = fresh(1);
  const [a0, b0] = deal.solution[0];
  const [a1, b1] = deal.solution[1];
  stack.hold(a0, 10_000);
  stack.play(a1, b1, 20_000);
  assert.equal(stack.undo(30_000)?.tile, a0, 'the park comes back after a match was made');
  stack.hold(a0, 40_000);
  stack.play(a0, b0, 50_000); // cleared through the holder
  const end = finish(b, stack, 50_000);
  const run = submissionOf(1, stack, end);
  assert.deepEqual(
    run.history.moves.slice(0, 5).map((m) => m.kind),
    ['hold', 'match', 'return', 'hold', 'match'],
  );
  const { status, body } = await post(env, deps, alex, run);
  assert.equal(status, 200, JSON.stringify(body));
});

test('a history stuffed with shuffles is refused before it is replayed', () => {
  const run = playedRun(1, 0);
  const shuffles = Array.from({ length: MAX_SHUFFLES_PER_RUN + 1 }, () => ({ kind: 'shuffle', seed: 1, atMs: 0 }));
  const verdict = verifyRun({ ...run.history, moves: [...shuffles, ...run.history.moves] }, { score: run.score });
  assert.deepEqual(verdict, { ok: false, reason: 'too_many_shuffles' });
});

// --- submitting --------------------------------------------------------------

test('a submitted score takes a place on the board', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 20);
  const { status, body } = await post(env, deps, alex, run);
  assert.equal(status, 200);
  assert.equal(body.weekStart, WEEK);
  assert.equal(body.resetsAt, weekResetAt(NOW));
  assert.deepEqual(body.you, {
    rank: 1,
    playerId: alex.playerId,
    name: 'Alex',
    avatar: 'lantern',
    score: run.score,
    runs: 1,
  });
  assert.equal(body.top.length, 1);
  assert.equal(body.top[0].playerId, alex.playerId);
});

test('every clear adds to the standing — it accumulates, it does not replace', async () => {
  // The whole difference from the Daily board: there a resubmission was a
  // replay of the same deal, so the row only ever moved up. Here every clear is
  // a different level and all of them count.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const runs = [playedRun(1, 30), playedRun(1, 0), playedRun(2, 40)];
  await post(env, deps, alex, runs[0]);
  const second = await post(env, deps, alex, runs[1], NOW + 1000);
  assert.equal(second.body.you.score, runs[0].score + runs[1].score, 'a smaller second run must still add');
  const third = await post(env, deps, alex, runs[2], NOW + 2000);
  assert.equal(third.body.you.score, runs[0].score + runs[1].score + runs[2].score);
  assert.equal(third.body.you.runs, 3);
  // One standing, three runs kept with their histories.
  assert.equal(count(env, 'weekly_scores'), 1);
  assert.equal(count(env, 'weekly_submissions'), 3);
});

test('a standing may exceed what any single run can pay', async () => {
  // The bound applies to each score being added, never to the total — a week
  // of good runs is supposed to pass it.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const best = playedRun(HARD_LEVEL, 72);
  assert.equal(best.score, MAX_RUN_SCORE);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await post(env, deps, alex, best, NOW + i * 1000)).status, 200);
  }
  const { body } = await board(env, deps, alex);
  assert.equal(body.you.score, MAX_RUN_SCORE * 3);
  assert.ok(body.you.score > MAX_RUN_SCORE);
});

test('a new week starts empty and last week’s standing does not carry', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 10);
  await post(env, deps, alex, run, LAST_WEEK_NOW);
  assert.equal((await board(env, deps, alex, LAST_WEEK_NOW)).body.you.score, run.score);

  const now = await board(env, deps, alex, NOW);
  assert.deepEqual(now.body.top, [], 'the live week opens empty');
  assert.equal(now.body.you, null);
  assert.equal(now.body.weekStart, WEEK);

  // Scoring this week starts from this week's runs alone.
  const fresh1 = playedRun(1, 0);
  await post(env, deps, alex, fresh1);
  assert.equal((await board(env, deps, alex)).body.you.score, fresh1.score);
});

test('only the live week is browsable — there is no way to ask for an old one', async () => {
  // No date or week parameter exists to pass, and a query string is ignored
  // rather than honoured, so a past week cannot be addressed at all.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, playedRun(1, 0), LAST_WEEK_NOW);
  const response = await handleLeaderboard(
    request('GET', `/api/leaderboard/weekly?week=${weekStartKey(LAST_WEEK_NOW)}&date=2026-08-30`),
    env,
    deps,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.weekStart, WEEK, 'the live week, whatever the query said');
  assert.deepEqual(body.top, []);
});

test('an impossible score is refused before anything is replayed, and nothing is written', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 0);
  const cheated = await post(env, deps, alex, { ...run, score: MAX_RUN_SCORE + 1 });
  assert.equal(cheated.status, 422);
  assert.deepEqual(cheated.body, { error: 'score_out_of_range' });
  assert.equal(count(env, 'weekly_scores'), 0);
  assert.equal(count(env, 'weekly_submissions'), 0);
});

test('a score cannot be posted without a profile to hang it on', async () => {
  const env = { DB: createDb() };
  const response = await handleLeaderboard(
    request('POST', '/api/leaderboard/weekly', { body: playedRun(1, 0) }),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 401);
  assert.equal(count(env, 'weekly_scores'), 0);
});

test('the run is stored whole, with the history it was verified from', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(3, 12);
  await post(env, deps, alex, run);
  const row = env.DB.raw.prepare('SELECT * FROM weekly_submissions').get();
  assert.equal(row.week_start, WEEK);
  assert.equal(row.player_id, alex.playerId);
  assert.equal(row.score, run.score);
  assert.equal(row.elapsed_ms, run.elapsedMs);
  assert.deepEqual(JSON.parse(row.history), run.history);
});

// --- the per-week cap --------------------------------------------------------
//
// Accumulation removed the absolute ceiling a max() standing had. Without a cap
// in the database the only bound on a standing is an IP-keyed, per-isolate rate
// limiter, which is not where score integrity can live.

test('a player cannot bank more than the week’s run cap', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 0);
  let last;
  for (let i = 0; i < MAX_RUNS_PER_WEEK + 5; i += 1) {
    // A minute apart: the submit limiter (20 / 10 min) rolls over as the run
    // goes, so the database's run cap — not the limiter — is what stops this.
    // That is the whole point: a caller who slips the limiter must still stop
    // at the database.
    last = await post(env, deps, alex, run, NOW + i * 60_000);
  }
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'week_run_limit' });
  const { body } = await board(env, deps, alex);
  assert.equal(body.you.runs, MAX_RUNS_PER_WEEK, 'runs stop at the cap');
  assert.equal(body.you.score, run.score * MAX_RUNS_PER_WEEK);
  // And the refused submits wrote no history either — a capped player must not
  // still be able to fill weekly_submissions, which is never pruned.
  assert.equal(count(env, 'weekly_submissions'), MAX_RUNS_PER_WEEK);
});

test('the standing is ceilinged even if the run cap is somehow passed', async () => {
  // The pre-check and the write are two round trips, so concurrent submits can
  // both pass the check. The MIN in the ON CONFLICT clause is the only place
  // the ceiling holds atomically, so it is asserted directly.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const best = playedRun(HARD_LEVEL, 72);
  await post(env, deps, alex, best);
  env.DB.raw
    .prepare('UPDATE weekly_scores SET score = ? WHERE player_id = ?')
    .run(MAX_WEEK_SCORE, alex.playerId);
  await post(env, deps, alex, best, NOW + 1000);
  const { body } = await board(env, deps, alex);
  assert.equal(body.you.score, MAX_WEEK_SCORE, 'the standing cannot pass its ceiling');
});

test('the week ceiling follows from the run cap, so the two cannot disagree', () => {
  assert.equal(MAX_WEEK_SCORE, MAX_RUN_SCORE * MAX_RUNS_PER_WEEK);
});

// --- the board ---------------------------------------------------------------

test('the board is ordered by score, and among equal scores by who got there first', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const first = await addPlayer(env, deps, 'First');
  const second = await addPlayer(env, deps, 'Second');
  const high = await addPlayer(env, deps, 'High');
  const same = playedRun(1, 10);
  await post(env, deps, second, same, NOW + 2000);
  await post(env, deps, first, same, NOW + 1000);
  await post(env, deps, high, playedRun(1, 30), NOW + 3000);

  const { body } = await board(env, deps);
  assert.deepEqual(
    body.top.map((e) => [e.rank, e.name]),
    [
      [1, 'High'],
      [2, 'First'],
      [3, 'Second'],
    ],
  );
});

test('the board shows the top ten and no more', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const players = await fillBoard(env, deps, 14);
  const { body } = await board(env, deps);
  assert.equal(body.top.length, BOARD_TOP);
  assert.equal(body.top[9].rank, 10);
  assert.equal(body.top[9].score, players[9].run.score);
});

test('a player outside the top ten still sees their rank and their neighbours', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const players = await fillBoard(env, deps, 14);
  const twelfth = players[11];
  const { body } = await board(env, deps, twelfth);
  assert.equal(body.you.rank, 12);
  assert.equal(body.you.name, 'Player 12');
  // Three above, the player, three below — and the ranks are contiguous.
  assert.deepEqual(
    body.around.map((e) => e.rank),
    [9, 10, 11, 12, 13, 14],
  );
  assert.equal(body.around[3].playerId, twelfth.playerId);
  // Every neighbour's rank agrees with the score ordering it was built from.
  for (let i = 1; i < body.around.length; i += 1) {
    assert.ok(body.around[i - 1].score >= body.around[i].score);
  }
});

test('a player inside the top ten gets a rank but no repeated neighbour rows', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const players = await fillBoard(env, deps, 14);
  const { body } = await board(env, deps, players[2]);
  assert.equal(body.you.rank, 3);
  assert.deepEqual(body.around, []);
});

test('the last player on the board has neighbours above and none below', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const players = await fillBoard(env, deps, 14);
  const { body } = await board(env, deps, players[13]);
  assert.equal(body.you.rank, 14);
  assert.deepEqual(
    body.around.map((e) => e.rank),
    [11, 12, 13, 14],
  );
});

test('a standing built from many runs ranks above a single big one', async () => {
  // The point of the board: score earned over the week, not a best run.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const grinder = await addPlayer(env, deps, 'Grinder');
  const oneShot = await addPlayer(env, deps, 'OneShot');
  const big = playedRun(1, 60);
  const small = playedRun(1, 0);
  assert.ok(big.score < 4 * small.score && big.score > small.score);
  await post(env, deps, oneShot, big, NOW + 1000);
  for (let i = 0; i < 4; i += 1) {
    await post(env, deps, grinder, small, NOW + 2000 + i * 1000);
  }
  const { body } = await board(env, deps);
  assert.deepEqual(
    body.top.map((e) => [e.rank, e.name, e.score]),
    [
      [1, 'Grinder', 4 * small.score],
      [2, 'OneShot', big.score],
    ],
  );
});

test('reading a board is public; a caller with no code simply has no rank', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  await fillBoard(env, deps, 3);
  const { status, body } = await board(env, deps, null);
  assert.equal(status, 200);
  assert.equal(body.top.length, 3);
  assert.equal(body.you, null);
  assert.deepEqual(body.around, []);
});

test('a player who has not scored this week sees the board without a rank', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  await fillBoard(env, deps, 3);
  const watcher = await addPlayer(env, deps, 'Watcher');
  const { body } = await board(env, deps, watcher);
  assert.equal(body.top.length, 3);
  assert.equal(body.you, null);
});

test('the name on the board is the server-held one, so a rename reaches old entries', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, playedRun(1, 0));
  await handleProfile(
    request('POST', '/api/profile/name', { headers: bearer(alex.code), body: { name: 'Jamie' } }),
    env,
    deps,
  );
  const { body } = await board(env, deps);
  assert.equal(body.top[0].name, 'Jamie');
});

test('an empty board still says when the week ends', async () => {
  // A board with nobody on it yet is exactly when a player most wants to know
  // how long is left to get on it, so the countdown cannot depend on entries.
  const env = { DB: createDb() };
  const { status, body } = await board(env, makeDeps());
  assert.equal(status, 200);
  assert.deepEqual(body, {
    weekStart: WEEK,
    resetsAt: weekResetAt(NOW),
    top: [],
    you: null,
    around: [],
  });
});

// --- withdrawing -------------------------------------------------------------

test('withdrawing takes the player off every week, standings and runs alike', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const other = await addPlayer(env, deps, 'Other');
  const run = playedRun(1, 0);
  await post(env, deps, alex, run);
  await post(env, deps, alex, run, LAST_WEEK_NOW);
  await post(env, deps, other, run);

  const response = await handleLeaderboard(
    request('DELETE', '/api/leaderboard/weekly', { headers: bearer(alex.code) }),
    env,
    deps,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'withdrawn' });
  assert.equal((await board(env, deps, alex)).body.you, null);
  assert.equal((await board(env, deps, alex, LAST_WEEK_NOW)).body.top.length, 0);
  // The stored runs go too: leaving them would keep a record of exactly what
  // the player asked to have removed.
  assert.equal(
    env.DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_submissions WHERE player_id = ?').get(alex.playerId).n,
    0,
  );
  // Nobody else was swept up.
  assert.equal((await board(env, deps, other)).body.you.score, run.score);
  assert.equal(
    env.DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_submissions WHERE player_id = ?').get(other.playerId).n,
    1,
  );
});

test('withdrawing needs a code', async () => {
  const env = { DB: createDb() };
  const response = await handleLeaderboard(
    request('DELETE', '/api/leaderboard/weekly'),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 401);
});

// --- the envelope ------------------------------------------------------------

test('unknown paths 404, wrong methods 405, cross-site is 403, no database is 503', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  assert.equal(
    (await handleLeaderboard(request('GET', '/api/leaderboard/levels'), env, deps)).status,
    404,
  );
  // The Daily board's route is gone, not merely unused.
  assert.equal(
    (await handleLeaderboard(request('GET', '/api/leaderboard/daily?date=2026-09-02'), env, deps)).status,
    404,
  );
  assert.equal(
    (await handleLeaderboard(request('PUT', '/api/leaderboard/weekly'), env, deps)).status,
    405,
  );
  assert.equal(
    (
      await handleLeaderboard(
        request('GET', '/api/leaderboard/weekly', {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        }),
        env,
        deps,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handleLeaderboard(request('GET', '/api/leaderboard/weekly'), {}, deps)).status,
    503,
  );
});

test('submissions from one address are rate limited', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 0);
  let last;
  for (let i = 0; i < 21; i += 1) {
    last = await post(env, deps, alex, run);
  }
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
});

test('one player submitting from two addresses is metered as one player', async () => {
  // Issue #186: the address bucket alone lets a player exceed the allowance by
  // changing address. The player bucket, checked after the code is verified,
  // does not.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const run = playedRun(1, 0);
  let last;
  for (let i = 0; i < 21; i += 1) {
    const response = await handleLeaderboard(
      request('POST', '/api/leaderboard/weekly', {
        headers: { ...bearer(alex.code), 'CF-Connecting-IP': i % 2 ? '198.51.100.1' : '198.51.100.2' },
        body: run,
      }),
      env,
      deps,
    );
    last = { status: response.status, body: await response.json() };
  }
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
});

test('the submit count survives a fresh deps object — nothing is kept in memory', async () => {
  const env = { DB: createDb() };
  const alex = await addPlayer(env, makeDeps(), 'Alex');
  const run = playedRun(1, 0);
  let last;
  for (let i = 0; i < 21; i += 1) {
    last = await post(env, makeDeps(), alex, run);
  }
  assert.equal(last.status, 429);
});

test('withdrawing is metered per player', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await handleLeaderboard(
      request('DELETE', '/api/leaderboard/weekly', {
        headers: { ...bearer(alex.code), 'CF-Connecting-IP': `198.51.100.${i}` },
      }),
      env,
      deps,
    );
  }
  assert.equal(last.status, 429);
});

test('an anonymous read writes nothing to the limiter table, but is still limited per isolate', async () => {
  // Public data, no credential: the in-memory limiter stays for this one route
  // so a board read does not cost a database write.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const rows = () => count(env, 'rate_limits');
  const before = rows();
  for (let i = 0; i < 5; i += 1) assert.equal((await board(env, deps, null)).status, 200);
  assert.equal(rows(), before);
  // A signed read writes exactly its two buckets — address and player, both
  // in the signed scope — and not the public one as well.
  assert.equal((await board(env, deps, alex)).status, 200);
  assert.equal(rows(), before + 2);
  const keys = env.DB.raw.prepare("SELECT key FROM rate_limits WHERE key LIKE 'lb-read%' ORDER BY key").all();
  assert.deepEqual(
    keys.map((r) => r.key),
    ['lb-read-signed:ip:unknown', `lb-read-signed:player:${alex.playerId}`],
  );
  for (let i = 0; i < 55; i += 1) await board(env, deps, null);
  assert.equal((await board(env, deps, null)).status, 429);
});

test('the routes work through the Worker entry point, which injects nothing', async () => {
  // The suite calls `handleLeaderboard` directly with injected deps, so it
  // cannot see a dependency the real router never supplies. This one goes the
  // way a request actually does: index.mjs -> handleRequest -> the route.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, playedRun(1, 0));

  const response = await handleRequest(request('GET', '/api/leaderboard/weekly'), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.top.length, 1);
  assert.equal(body.top[0].name, 'Alex');
  // The real router supplies no clock, so this is the live week — proof the
  // route works without the injected `now` every other test hands it.
  assert.equal(body.weekStart, weekStartKey(Date.now()));

  const signed = await handleRequest(
    request('GET', '/api/leaderboard/weekly', { headers: bearer(alex.code) }),
    env,
  );
  assert.equal(signed.status, 200);

  // And a submit through the entry point replays like one through the route.
  const submit = await handleRequest(
    request('POST', '/api/leaderboard/weekly', { headers: bearer(alex.code), body: playedRun(2, 5) }),
    env,
  );
  assert.equal(submit.status, 200);
});

test('a database the code disagrees with fails closed as 503 unavailable, never a raw 500', async () => {
  // Issue #185. This is the live failure of 2026-09-04: the Worker expecting
  // the weekly tables was deployed before the migrations creating them ran, and
  // every board read answered a Cloudflare 500 page — an escaped exception,
  // costing a Worker invocation plus a failed query per hit and telling the
  // client nothing it understands. The tables are dropped here to reproduce
  // exactly that state; the fix is in the router, so the test goes through it.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  env.DB.raw.exec('DROP TABLE weekly_submissions; DROP TABLE weekly_scores');

  const read = await handleRequest(request('GET', '/api/leaderboard/weekly'), env);
  assert.equal(read.status, 503);
  assert.deepEqual(await read.json(), { error: 'unavailable' });

  // A run that verifies, so the failure reached is the database's.
  const submit = await handleRequest(
    request('POST', '/api/leaderboard/weekly', {
      headers: bearer(alex.code),
      body: playedRun(1, 0),
    }),
    env,
  );
  assert.equal(submit.status, 503);
  const text = await submit.text();
  assert.deepEqual(JSON.parse(text), { error: 'unavailable' });
  // The database's own message names tables and columns; none of it leaves.
  assert.doesNotMatch(text, /no such table|weekly_/);

  // The profile routes share the router and the database, so the same
  // schema drift fails the same way there.
  env.DB.raw.exec('DROP TABLE players');
  const profile = await handleRequest(
    request('GET', '/api/profile', { headers: bearer(alex.code) }),
    env,
  );
  assert.equal(profile.status, 503);
  assert.deepEqual(await profile.json(), { error: 'unavailable' });
});

test('an anonymous read never reaches the credential check', async () => {
  // The signed bucket is the tight one (10 / 10 min); a public board read must
  // not spend it, or an unauthenticated caller could exhaust every player's
  // ability to look themselves up.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, playedRun(1, 0));
  for (let i = 0; i < 30; i += 1) await board(env, deps, null);
  const mine = await board(env, deps, alex);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.you.rank, 1);
});

test('signed reads are metered more tightly than public ones', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  let last;
  for (let i = 0; i < 11; i += 1) last = await board(env, deps, alex);
  assert.equal(last.status, 429);
  // The public board is still readable — the two buckets are separate.
  assert.equal((await board(env, deps, null)).status, 200);
});

test('a malformed body is refused', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const response = await handleLeaderboard(
    new Request('https://lantern.example/api/leaderboard/weekly', {
      method: 'POST',
      headers: bearer(alex.code),
      body: '{',
    }),
    env,
    deps,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_json' });
});
