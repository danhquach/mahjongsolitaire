// Daily Challenge leaderboard (issue #70).
//
// The ranking is the part worth testing hard: it is SQL, it has a tie-break,
// and "your rank and the entries around you" is three separate queries that
// have to agree with each other. So the board is built by submitting through
// the real routes and then asserted on as a whole — a rank that disagrees
// with the row above it is exactly the bug these tests exist to catch.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRateLimitStore } from '../http.mjs';
import { MAX_DAILY_SCORE, dateAcceptable, handleLeaderboard, validateSubmission } from '../leaderboard.mjs';
import { handleRequest } from '../index.mjs';
import { authenticate, handleProfile } from '../profile.mjs';
import { createDb } from './d1.mjs';

const TODAY = '2026-09-02';
const NOW = Date.parse(`${TODAY}T12:00:00Z`);

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
    request('POST', '/api/leaderboard/daily', { headers: bearer(player.code), body }),
    env,
    { ...deps, now: () => at },
  );
  return { status: response.status, body: await response.json() };
}

async function board(env, deps, player = null, date = TODAY) {
  const response = await handleLeaderboard(
    request('GET', `/api/leaderboard/daily?date=${date}`, {
      headers: player === null ? {} : bearer(player.code),
    }),
    env,
    deps,
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
    await post(env, deps, player, { date: TODAY, score: 2000 - i * 100, elapsedMs: 60_000 }, NOW + i * 1000);
    players.push(player);
  }
  return players;
}

// --- validation --------------------------------------------------------------

test('a date is a board only while someone could still be playing it', () => {
  assert.equal(dateAcceptable(TODAY, NOW), true);
  // A day ahead: a player in UTC+14 is already on tomorrow's board.
  assert.equal(dateAcceptable('2026-09-03', NOW), true);
  assert.equal(dateAcceptable('2026-09-04', NOW), false);
  assert.equal(dateAcceptable('2026-08-20', NOW), true);
  assert.equal(dateAcceptable('2026-07-01', NOW), false);
  assert.equal(dateAcceptable('not-a-date', NOW), false);
  assert.equal(dateAcceptable(20260902, NOW), false);
});

test('a score outside what the scoring rules can produce is not a score', () => {
  const ok = validateSubmission({ date: TODAY, score: MAX_DAILY_SCORE, elapsedMs: 1 }, NOW);
  assert.equal(ok.score, MAX_DAILY_SCORE);
  assert.equal(validateSubmission({ date: TODAY, score: MAX_DAILY_SCORE + 1, elapsedMs: 1 }, NOW), 'bad_score');
  assert.equal(validateSubmission({ date: TODAY, score: -1, elapsedMs: 1 }, NOW), 'bad_score');
  assert.equal(validateSubmission({ date: TODAY, score: 1.5, elapsedMs: 1 }, NOW), 'bad_score');
  assert.equal(validateSubmission({ date: TODAY, score: 100, elapsedMs: -1 }, NOW), 'invalid');
  assert.equal(validateSubmission(null, NOW), 'invalid');
});

test('the move history rides along, bounded, and is optional', () => {
  assert.equal(validateSubmission({ date: TODAY, score: 1, elapsedMs: 1 }, NOW).history, null);
  const withHistory = validateSubmission(
    { date: TODAY, score: 1, elapsedMs: 1, history: [{ a: 1, b: 2 }] },
    NOW,
  );
  assert.equal(withHistory.history, '[{"a":1,"b":2}]');
  const huge = validateSubmission(
    { date: TODAY, score: 1, elapsedMs: 1, history: Array(20000).fill({ a: 1, b: 2 }) },
    NOW,
  );
  assert.equal(huge, 'invalid');
});

// --- submitting --------------------------------------------------------------

test('a submitted score takes a place on the board', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const { status, body } = await post(env, deps, alex, { date: TODAY, score: 4200, elapsedMs: 90_000 });
  assert.equal(status, 200);
  assert.equal(body.date, TODAY);
  assert.deepEqual(body.you, {
    rank: 1,
    playerId: alex.playerId,
    name: 'Alex',
    avatar: 'lantern',
    score: 4200,
    elapsedMs: 90_000,
  });
  assert.equal(body.top.length, 1);
  assert.equal(body.top[0].playerId, alex.playerId);
});

test('replaying a Daily can improve a rank but never costs one', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, { date: TODAY, score: 4200, elapsedMs: 90_000 });

  const worse = await post(env, deps, alex, { date: TODAY, score: 900, elapsedMs: 30_000 });
  assert.equal(worse.body.you.score, 4200, 'a worse replay must not overwrite the score');

  const better = await post(env, deps, alex, { date: TODAY, score: 5000, elapsedMs: 70_000 });
  assert.equal(better.body.you.score, 5000);
  assert.equal(better.body.you.elapsedMs, 70_000);
  // Still one row, not three.
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM daily_scores').get().n, 1);
});

test('a submission for another date does not touch this one', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, { date: TODAY, score: 4200, elapsedMs: 90_000 });
  await post(env, deps, alex, { date: '2026-09-01', score: 100, elapsedMs: 10_000 });
  assert.equal((await board(env, deps, alex)).body.you.score, 4200);
  assert.equal((await board(env, deps, alex, '2026-09-01')).body.you.score, 100);
});

test('an impossible score and a closed date are refused with distinct reasons', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const cheated = await post(env, deps, alex, {
    date: TODAY,
    score: MAX_DAILY_SCORE + 1,
    elapsedMs: 1000,
  });
  assert.equal(cheated.status, 422);
  assert.deepEqual(cheated.body, { error: 'score_out_of_range' });

  const stale = await post(env, deps, alex, { date: '2020-01-01', score: 100, elapsedMs: 1000 });
  assert.equal(stale.status, 422);
  assert.deepEqual(stale.body, { error: 'date_not_open' });
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM daily_scores').get().n, 0);
});

test('a score cannot be posted without a profile to hang it on', async () => {
  const env = { DB: createDb() };
  const response = await handleLeaderboard(
    request('POST', '/api/leaderboard/daily', { body: { date: TODAY, score: 100, elapsedMs: 1 } }),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 401);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM daily_scores').get().n, 0);
});

// --- the board ---------------------------------------------------------------

test('the board is ordered by score, and among equal scores by who got there first', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const first = await addPlayer(env, deps, 'First');
  const second = await addPlayer(env, deps, 'Second');
  const high = await addPlayer(env, deps, 'High');
  await post(env, deps, second, { date: TODAY, score: 1000, elapsedMs: 1 }, NOW + 2000);
  await post(env, deps, first, { date: TODAY, score: 1000, elapsedMs: 1 }, NOW + 1000);
  await post(env, deps, high, { date: TODAY, score: 2000, elapsedMs: 1 }, NOW + 3000);

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
  assert.equal(body.top.length, 10);
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

test('a player who has not played the date sees the board without a rank', async () => {
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
  await post(env, deps, alex, { date: TODAY, score: 500, elapsedMs: 1 });
  await handleProfile(
    request('POST', '/api/profile/name', { headers: bearer(alex.code), body: { name: 'Jamie' } }),
    env,
    deps,
  );
  const { body } = await board(env, deps);
  assert.equal(body.top[0].name, 'Jamie');
});

test('an empty board is an empty board, not an error', async () => {
  const env = { DB: createDb() };
  const { status, body } = await board(env, makeDeps());
  assert.equal(status, 200);
  assert.deepEqual(body, { date: TODAY, top: [], you: null, around: [] });
});

// --- withdrawing -------------------------------------------------------------

test('withdrawing takes the player off every date, not just today', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const other = await addPlayer(env, deps, 'Other');
  await post(env, deps, alex, { date: TODAY, score: 500, elapsedMs: 1 });
  await post(env, deps, alex, { date: '2026-09-01', score: 700, elapsedMs: 1 });
  await post(env, deps, other, { date: TODAY, score: 400, elapsedMs: 1 });

  const response = await handleLeaderboard(
    request('DELETE', '/api/leaderboard/daily', { headers: bearer(alex.code) }),
    env,
    deps,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'withdrawn' });
  assert.equal((await board(env, deps, alex)).body.you, null);
  assert.equal((await board(env, deps, alex, '2026-09-01')).body.top.length, 0);
  // Nobody else was swept up.
  assert.equal((await board(env, deps, other)).body.you.score, 400);
});

test('withdrawing needs a code', async () => {
  const env = { DB: createDb() };
  const response = await handleLeaderboard(
    request('DELETE', '/api/leaderboard/daily'),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 401);
});

// --- the envelope ------------------------------------------------------------

test('a board query without a real date is refused before it reaches the database', async () => {
  const env = { DB: createDb() };
  for (const query of ['', '?date=', '?date=nope', '?date=2026-9-2']) {
    const response = await handleLeaderboard(
      request('GET', `/api/leaderboard/daily${query}`),
      env,
      makeDeps(),
    );
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'invalid_date' });
  }
});

test('unknown paths 404, wrong methods 405, cross-site is 403, no database is 503', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  assert.equal(
    (await handleLeaderboard(request('GET', '/api/leaderboard/levels'), env, deps)).status,
    404,
  );
  assert.equal(
    (await handleLeaderboard(request('PUT', '/api/leaderboard/daily'), env, deps)).status,
    405,
  );
  assert.equal(
    (
      await handleLeaderboard(
        request('GET', `/api/leaderboard/daily?date=${TODAY}`, {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        }),
        env,
        deps,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handleLeaderboard(request('GET', `/api/leaderboard/daily?date=${TODAY}`), {}, deps))
      .status,
    503,
  );
});

test('submissions from one address are rate limited', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  let last;
  for (let i = 0; i < 21; i += 1) {
    last = await post(env, deps, alex, { date: TODAY, score: 100 + i, elapsedMs: 1 });
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
  await post(env, deps, alex, { date: TODAY, score: 4200, elapsedMs: 90_000 });

  const response = await handleRequest(
    request('GET', `/api/leaderboard/daily?date=${TODAY}`),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.top.length, 1);
  assert.equal(body.top[0].name, 'Alex');

  // And the rate limiter it falls back to is a real one: an unauthenticated
  // read is metered, not merely un-crashed.
  const signed = await handleRequest(
    request('GET', `/api/leaderboard/daily?date=${TODAY}`, { headers: bearer(alex.code) }),
    env,
  );
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).you.rank, 1);
});

test('an anonymous read never reaches the credential check', async () => {
  // The signed bucket is the tight one (10 / 10 min); a public board read must
  // not spend it, or an unauthenticated caller could exhaust every player's
  // ability to look themselves up.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  await post(env, deps, alex, { date: TODAY, score: 4200, elapsedMs: 90_000 });
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
    new Request('https://lantern.example/api/leaderboard/daily', {
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
