// The weekly leaderboard (issue #176, superseding the Daily board of #70).
//
// The ranking is the part worth testing hard: it is SQL, it has a tie-break,
// and "your rank and the entries around you" is three separate queries that
// have to agree with each other. So the board is built by submitting through
// the real routes and then asserted on as a whole — a rank that disagrees with
// the row above it is exactly the bug these tests exist to catch.
//
// What is new here, and what most of the added tests are about: the standing
// **accumulates** rather than only moving up, and the week comes from the
// server's clock rather than from the request.

import assert from 'node:assert/strict';
import test from 'node:test';

// Reaches into core's *build output* to check the Worker's restated score
// ceiling against the real one. That means core must be built before this
// suite runs — `npm --prefix core run build`, which CLAUDE.md's command order
// and CI both already do before the worker tests.
import { MAX_RUN_SCORE as CORE_MAX_RUN_SCORE } from '../../core/dist/src/ladder.js';
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

/** A registered player, so an entry has an owner and a display name. Each
 *  registration gets its own limiter store: these are meant to be different
 *  people, and the profile route caps registrations per address. */
async function addPlayer(env, deps, name) {
  const response = await handleProfile(
    request('POST', '/api/profile/register', {
      body: { name, avatar: 'lantern', record: {} },
    }),
    env,
    { ...deps, rateLimitStore: createRateLimitStore() },
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

/** A board with `count` players on it, scoring 2000, 1900, 1800, … so rank
 *  and score tell the same story and an off-by-one is obvious. */
async function fillBoard(env, deps, count) {
  const players = [];
  for (let i = 0; i < count; i += 1) {
    const player = await addPlayer(env, deps, `Player ${i + 1}`);
    // Submitted a second apart so the tie-break has something to order by.
    await post(env, deps, player, { score: 2000 - i * 100, elapsedMs: 60_000 }, NOW + i * 1000);
    players.push(player);
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
  // The Worker cannot import core at runtime, so the ceiling is restated here.
  // If the band multipliers or the combo ladder move, this is what notices.
  assert.equal(MAX_RUN_SCORE, CORE_MAX_RUN_SCORE);
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
  assert.deepEqual(claimed, { score: 100, elapsedMs: 90_000, history: null });
});

test('the move history rides along, bounded, and is optional', () => {
  assert.equal(validateSubmission({ score: 1, elapsedMs: 90_000 }).history, null);
  const withHistory = validateSubmission({ score: 1, elapsedMs: 90_000, history: [{ a: 1, b: 2 }] });
  assert.equal(withHistory.history, '[{"a":1,"b":2}]');
  const huge = validateSubmission({
    score: 1,
    elapsedMs: 90_000,
    history: Array(20000).fill({ a: 1, b: 2 }),
  });
  assert.equal(huge, 'invalid');
});

// --- submitting --------------------------------------------------------------

test('a submitted score takes a place on the board', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const { status, body } = await post(env, deps, alex, { score: 4200, elapsedMs: 90_000 });
  assert.equal(status, 200);
  assert.equal(body.weekStart, WEEK);
  assert.equal(body.resetsAt, weekResetAt(NOW));
  assert.deepEqual(body.you, {
    rank: 1,
    playerId: alex.playerId,
    name: 'Alex',
    avatar: 'lantern',
    score: 4200,
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
  await post(env, deps, alex, { score: 4200, elapsedMs: 90_000 });
  const second = await post(env, deps, alex, { score: 900, elapsedMs: 30_000 }, NOW + 1000);
  assert.equal(second.body.you.score, 5100, 'a smaller second run must still add');
  const third = await post(env, deps, alex, { score: 5000, elapsedMs: 70_000 }, NOW + 2000);
  assert.equal(third.body.you.score, 10_100);
  assert.equal(third.body.you.runs, 3);
  // One standing, three runs kept for verification.
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_scores').get().n, 1);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_submissions').get().n, 3);
});

test('a standing may exceed what any single run can pay', async () => {
  // The bound applies to each score being added, never to the total — a week
  // of good runs is supposed to pass it.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  for (let i = 0; i < 3; i += 1) {
    await post(env, deps, alex, { score: MAX_RUN_SCORE, elapsedMs: 90_000 }, NOW + i * 1000);
  }
  const { body } = await board(env, deps, alex);
  assert.equal(body.you.score, MAX_RUN_SCORE * 3);
  assert.ok(body.you.score > MAX_RUN_SCORE);
});

test('a new week starts empty and last week’s standing does not carry', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, { score: 9000, elapsedMs: 90_000 }, LAST_WEEK_NOW);
  assert.equal((await board(env, deps, alex, LAST_WEEK_NOW)).body.you.score, 9000);

  const now = await board(env, deps, alex, NOW);
  assert.deepEqual(now.body.top, [], 'the live week opens empty');
  assert.equal(now.body.you, null);
  assert.equal(now.body.weekStart, WEEK);

  // Scoring this week starts from this week's runs alone.
  await post(env, deps, alex, { score: 120, elapsedMs: 90_000 });
  assert.equal((await board(env, deps, alex)).body.you.score, 120);
});

test('only the live week is browsable — there is no way to ask for an old one', async () => {
  // No date or week parameter exists to pass, and a query string is ignored
  // rather than honoured, so a past week cannot be addressed at all.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, { score: 9000, elapsedMs: 90_000 }, LAST_WEEK_NOW);
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

test('an impossible score is refused, and nothing is written', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const cheated = await post(env, deps, alex, { score: MAX_RUN_SCORE + 1, elapsedMs: 90_000 });
  assert.equal(cheated.status, 422);
  assert.deepEqual(cheated.body, { error: 'score_out_of_range' });
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_scores').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_submissions').get().n, 0);
});

test('a score cannot be posted without a profile to hang it on', async () => {
  const env = { DB: createDb() };
  const response = await handleLeaderboard(
    request('POST', '/api/leaderboard/weekly', { body: { score: 100, elapsedMs: 90_000 } }),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 401);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_scores').get().n, 0);
});

test('the run is stored whole, for the verification follow-up', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, {
    score: 4200,
    elapsedMs: 90_000,
    history: { layoutId: 'turtle_classic', seed: 7, moves: [[1, 2]] },
  });
  const row = env.DB.raw.prepare('SELECT * FROM weekly_submissions').get();
  assert.equal(row.week_start, WEEK);
  assert.equal(row.player_id, alex.playerId);
  assert.equal(row.score, 4200);
  assert.deepEqual(JSON.parse(row.history), {
    layoutId: 'turtle_classic',
    seed: 7,
    moves: [[1, 2]],
  });
});

// --- the per-week cap --------------------------------------------------------
//
// Accumulation removed the absolute ceiling a max() standing had. Without a cap
// in the database the only bound on a standing is an IP-keyed, per-isolate rate
// limiter, which is not where score integrity can live.

test('a run under a plausible length is not a run', () => {
  // 72 pairs in under 20 seconds is 3.6 matches a second sustained. The upper
  // bound was always there; this is the missing floor.
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

test('a player cannot bank more than the week’s run cap', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  let last;
  for (let i = 0; i < MAX_RUNS_PER_WEEK + 5; i += 1) {
    // A fresh limiter store per call, so the rate limiter is never what stops
    // this. That is the whole point: the limiter is IP-keyed, best-effort and
    // per-isolate, so a caller who evades it must still stop at the database.
    last = await post(
      env,
      { ...deps, rateLimitStore: createRateLimitStore() },
      alex,
      { score: 100, elapsedMs: 90_000 },
      NOW + i * 1000,
    );
  }
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'week_run_limit' });
  const { body } = await board(env, deps, alex);
  assert.equal(body.you.runs, MAX_RUNS_PER_WEEK, 'runs stop at the cap');
  assert.equal(body.you.score, 100 * MAX_RUNS_PER_WEEK);
  // And the refused submits wrote no history either — a capped player must not
  // still be able to fill weekly_submissions, which is never pruned.
  assert.equal(
    env.DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_submissions').get().n,
    MAX_RUNS_PER_WEEK,
  );
});

test('the standing is ceilinged even if the run cap is somehow passed', async () => {
  // The pre-check and the write are two round trips, so concurrent submits can
  // both pass the check. The MIN in the ON CONFLICT clause is the only place
  // the ceiling holds atomically, so it is asserted directly.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, { score: MAX_RUN_SCORE, elapsedMs: 90_000 });
  env.DB.raw
    .prepare('UPDATE weekly_scores SET score = ? WHERE player_id = ?')
    .run(MAX_WEEK_SCORE, alex.playerId);
  await post(env, deps, alex, { score: MAX_RUN_SCORE, elapsedMs: 90_000 }, NOW + 1000);
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
  await post(env, deps, second, { score: 1000, elapsedMs: 90_000 }, NOW + 2000);
  await post(env, deps, first, { score: 1000, elapsedMs: 90_000 }, NOW + 1000);
  await post(env, deps, high, { score: 2000, elapsedMs: 90_000 }, NOW + 3000);

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
  await fillBoard(env, deps, 14);
  const { body } = await board(env, deps);
  assert.equal(body.top.length, BOARD_TOP);
  assert.equal(body.top[9].rank, 10);
  assert.equal(body.top[9].score, 1100);
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
  await post(env, deps, oneShot, { score: 9000, elapsedMs: 90_000 }, NOW + 1000);
  for (let i = 0; i < 4; i += 1) {
    await post(env, deps, grinder, { score: 2500, elapsedMs: 90_000 }, NOW + 2000 + i * 1000);
  }
  const { body } = await board(env, deps);
  assert.deepEqual(
    body.top.map((e) => [e.rank, e.name, e.score]),
    [
      [1, 'Grinder', 10_000],
      [2, 'OneShot', 9000],
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
  await post(env, deps, alex, { score: 500, elapsedMs: 90_000 });
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
  await post(env, deps, alex, { score: 500, elapsedMs: 90_000 });
  await post(env, deps, alex, { score: 700, elapsedMs: 90_000 }, LAST_WEEK_NOW);
  await post(env, deps, other, { score: 400, elapsedMs: 90_000 });

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
  assert.equal((await board(env, deps, other)).body.you.score, 400);
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
  let last;
  for (let i = 0; i < 21; i += 1) {
    last = await post(env, deps, alex, { score: 100 + i, elapsedMs: 90_000 });
  }
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
});

test('the routes work through the Worker entry point, which injects nothing', async () => {
  // The suite calls `handleLeaderboard` directly with injected deps, so it
  // cannot see a dependency the real router never supplies. This one goes the
  // way a request actually does: index.mjs -> handleRequest -> the route.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, { score: 4200, elapsedMs: 90_000 });

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
});

test('an anonymous read never reaches the credential check', async () => {
  // The signed bucket is the tight one (10 / 10 min); a public board read must
  // not spend it, or an unauthenticated caller could exhaust every player's
  // ability to look themselves up.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, { score: 4200, elapsedMs: 90_000 });
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
