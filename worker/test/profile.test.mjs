// Tests for the synced player profile (issue #138).
//
// The database is a real SQLite one behind a D1-shaped adapter running the
// real schema files — see ./d1.mjs for why.

import assert from 'node:assert/strict';
import test from 'node:test';

/** The Sunday opening the week these fixtures score into. */
const WEEK = '2026-08-30';

import { createDb } from './d1.mjs';
import {
  EMPTY_RECORD,
  dedupRuns,
  foldName,
  formatCode,
  handleProfile,
  mergeRecords,
  nameAllowed,
  normalizeCode,
  sanitizeName,
  validateRecord,
} from '../profile.mjs';

/** Deterministic "randomness": a counter stepped by an odd multiplier, so
 *  every byte in a run differs (period 256) and every test run produces the
 *  same codes and ids. */
function seededRandomBytes() {
  let n = 0;
  return (count) => Uint8Array.from({ length: count }, () => ((n += 1) * 97 + 41) & 0xff);
}

function makeDeps(overrides = {}) {
  return {
    now: () => 1_700_000_000_000,
    randomBytes: seededRandomBytes(),
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

async function registerPlayer(env, deps, body = {}) {
  const response = await handleProfile(
    request('POST', '/api/profile/register', {
      body: { name: 'Alex', avatar: 'lantern', record: EMPTY_RECORD, ...body },
    }),
    env,
    deps,
  );
  return { response, json: await response.json() };
}

function bearer(code) {
  return { Authorization: `Bearer ${code}` };
}

// --- codes -------------------------------------------------------------------

test('a minted code round-trips through the formatting the player sees', () => {
  const code = 'ABCD1234EFGH5678JKMN9PQR';
  assert.equal(formatCode(code), 'ABCD-1234-EFGH-5678-JKMN-9PQR');
  assert.equal(normalizeCode(formatCode(code)), code);
});

test('a transcribed code tolerates case, spacing and Crockford substitutions', () => {
  assert.equal(normalizeCode('abcd 1234 efgh 5678 jkmn 9pqr'), 'ABCD1234EFGH5678JKMN9PQR');
  // I and L are read back as 1, O as 0 — the letters the alphabet omits.
  assert.equal(normalizeCode('ILCD1234EFGH5678JKMN9PQO'), '11CD1234EFGH5678JKMN9PQ0');
});

test('a code of the wrong length or alphabet is not a code', () => {
  assert.equal(normalizeCode('ABCD'), null);
  assert.equal(normalizeCode('ABCD1234EFGH5678JKMN9PQ!'), null);
  assert.equal(normalizeCode(42), null);
});

// --- names -------------------------------------------------------------------

test('a name is one trimmed line, clamped, never empty', () => {
  assert.equal(sanitizeName('  Alex   the  Great  '), 'Alex the Great');
  assert.equal(sanitizeName('a'.repeat(50)), 'a'.repeat(20));
  assert.equal(sanitizeName('   '), 'Player');
  assert.equal(sanitizeName(7), null);
});

test('the screen sees through spacing, repeats and leetspeak', () => {
  assert.equal(nameAllowed('Alex'), true);
  assert.equal(nameAllowed('Lantern Fan'), true);
  assert.equal(nameAllowed('shit'), false);
  assert.equal(nameAllowed('S H 1 T'), false);
  assert.equal(nameAllowed('sshhiitt'), false);
  assert.equal(nameAllowed('xXf_u_c_kXx'), false);
  assert.equal(nameAllowed('sh!t'), false);
});

test('folding strips and maps; collapsing runs is a separate, name-only step', () => {
  assert.equal(foldName('N i g g 3 r'), 'nigger');
  assert.equal(dedupRuns(foldName('sshhiitt')), 'shit');
});

test('a name that merely contains a blocked word as a run is not refused', () => {
  // Collapsing the blocklist too would turn 'coon' into the needle 'con'.
  for (const name of ['Falcon', 'Connie', 'Constance', 'Scout', 'Bamboo Fan']) {
    assert.equal(nameAllowed(name), true, name);
  }
  assert.equal(nameAllowed('coon'), false);
});

// --- records -----------------------------------------------------------------

test('a client record is sanitized field by field, not rejected', () => {
  const record = validateRecord({
    levelsCleared: 4,
    weekScore: 'nope',
    weekStart: WEEK,
    cleared: [3, 3, 1, 0, 99999, 'x'],
    dailyStreak: 9,
    lastDaily: '2026-09-01',
    trophies: 2,
  });
  assert.deepEqual(record, {
    levelsCleared: 4,
    weekScore: 0,
    weekStart: WEEK,
    cleared: [1, 3],
    dailyStreak: 9,
    lastDaily: '2026-09-01',
    trophies: 2,
  });
});

test('a week score with no week it belongs to is not a score', () => {
  // Issue #176. This is also the migration: a pre-#176 record carries a
  // lifetime `totalScore` and no `weekStart`, so it starts the first weekly
  // board at zero instead of at a lifetime total nobody earned this week.
  assert.equal(validateRecord({ weekScore: 5000 }).weekScore, 0);
  assert.equal(validateRecord({ weekScore: 5000, weekStart: 'someday' }).weekScore, 0);
  assert.equal(validateRecord({ weekScore: 5000, weekStart: WEEK }).weekScore, 5000);
  const legacy = validateRecord({ levelsCleared: 400, bestScore: 20970, totalScore: 1250000 });
  assert.equal(legacy.weekScore, 0);
  assert.equal(legacy.weekStart, null);
  assert.equal(legacy.levelsCleared, 400, 'a clear count is not a score and survives');
});

test('a streak with no anchoring date is dropped, and a non-object is not a record', () => {
  assert.equal(validateRecord({ dailyStreak: 30, lastDaily: 'yesterday' }).dailyStreak, 0);
  assert.equal(validateRecord(null), null);
  assert.equal(validateRecord([]), null);
});

test('merging takes the max of every counter and the union of cleared levels', () => {
  const merged = mergeRecords(
    { ...EMPTY_RECORD, levelsCleared: 10, weekScore: 5000, weekStart: WEEK, cleared: [1, 2], trophies: 7 },
    { ...EMPTY_RECORD, levelsCleared: 3, weekScore: 400, weekStart: WEEK, cleared: [2, 5], trophies: 1 },
  );
  assert.equal(merged.levelsCleared, 10);
  assert.equal(merged.weekScore, 5000);
  assert.equal(merged.weekStart, WEEK);
  assert.deepEqual(merged.cleared, [1, 2, 5]);
  assert.equal(merged.trophies, 7);
});

test('the week score is the one field a merge may lower', () => {
  // Every other counter here only grows, so "take max, never regress" is the
  // whole rule. A weekly score resets (issue #176): taking the larger of two
  // weeks would resurrect last week's total at the rollover and then keep
  // winning every merge after it, so the reset could never stick.
  const lastWeek = { ...EMPTY_RECORD, weekScore: 90000, weekStart: '2026-08-30' };
  const thisWeek = { ...EMPTY_RECORD, weekScore: 120, weekStart: '2026-09-06' };
  assert.equal(mergeRecords(lastWeek, thisWeek).weekScore, 120);
  assert.equal(mergeRecords(lastWeek, thisWeek).weekStart, '2026-09-06');
  assert.deepEqual(mergeRecords(thisWeek, lastWeek), mergeRecords(lastWeek, thisWeek));
  // A side that has never scored contributes no week.
  const scored = { ...EMPTY_RECORD, weekScore: 700, weekStart: WEEK };
  assert.deepEqual(mergeRecords(scored, EMPTY_RECORD), scored);
  assert.deepEqual(mergeRecords(EMPTY_RECORD, scored), scored);
});

test('a fresh install that clears today continues the long streak it never saw', () => {
  const server = { ...EMPTY_RECORD, dailyStreak: 30, lastDaily: '2026-09-01' };
  const client = { ...EMPTY_RECORD, dailyStreak: 1, lastDaily: '2026-09-02' };
  assert.deepEqual(mergeRecords(server, client), {
    ...EMPTY_RECORD,
    dailyStreak: 30,
    lastDaily: '2026-09-02',
  });
});

test('a streak broken by a gap does not resurrect the older, longer one', () => {
  const server = { ...EMPTY_RECORD, dailyStreak: 30, lastDaily: '2026-08-01' };
  const client = { ...EMPTY_RECORD, dailyStreak: 2, lastDaily: '2026-09-02' };
  const merged = mergeRecords(server, client);
  assert.equal(merged.dailyStreak, 2);
  assert.equal(merged.lastDaily, '2026-09-02');
});

test('merging is symmetric — neither side is privileged', () => {
  const a = { ...EMPTY_RECORD, weekScore: 10, weekStart: WEEK, cleared: [1], dailyStreak: 4, lastDaily: '2026-09-01' };
  const b = { ...EMPTY_RECORD, weekScore: 20, weekStart: WEEK, cleared: [2], dailyStreak: 1, lastDaily: '2026-09-02' };
  assert.deepEqual(mergeRecords(a, b), mergeRecords(b, a));
});

test('a side with no Daily history contributes no streak', () => {
  const played = { ...EMPTY_RECORD, dailyStreak: 5, lastDaily: '2026-09-02' };
  assert.deepEqual(mergeRecords(played, EMPTY_RECORD), played);
  assert.deepEqual(mergeRecords(EMPTY_RECORD, played), played);
});

// --- routes ------------------------------------------------------------------

test('registering mints a profile, a public id and a one-time recovery code', async () => {
  const env = { DB: createDb() };
  const { response, json } = await registerPlayer(env, makeDeps());
  assert.equal(response.status, 201);
  assert.equal(json.profile.name, 'Alex');
  assert.equal(json.profile.avatar, 'lantern');
  assert.deepEqual(json.profile.record, EMPTY_RECORD);
  assert.equal(json.playerId.length, 10);
  assert.equal(json.playerId, json.profile.playerId);
  assert.match(json.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
  // The plaintext code must never be what the database holds.
  const stored = env.DB.raw.prepare('SELECT code_hash FROM players').get();
  assert.match(stored.code_hash, /^[0-9a-f]{64}$/);
  assert.equal(stored.code_hash.includes(json.code.replace(/-/g, '')), false);
});

test('the recovery code reads the profile back — from any device', async () => {
  const env = { DB: createDb() };
  const { json: created } = await registerPlayer(env, makeDeps(), {
    record: { ...EMPTY_RECORD, trophies: 3, cleared: [1, 2, 3] },
  });
  const response = await handleProfile(
    request('GET', '/api/profile', { headers: bearer(created.code) }),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 200);
  const { profile } = await response.json();
  assert.equal(profile.playerId, created.playerId);
  assert.equal(profile.name, 'Alex');
  assert.deepEqual(profile.record.cleared, [1, 2, 3]);
  assert.equal(profile.record.trophies, 3);
});

test('a wrong, malformed or missing code is the same 401', async () => {
  const env = { DB: createDb() };
  await registerPlayer(env, makeDeps());
  for (const headers of [
    {},
    bearer('nope'),
    bearer('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ'),
    { Authorization: 'Basic abc' },
  ]) {
    const response = await handleProfile(request('GET', '/api/profile', { headers }), env, makeDeps());
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
});

test('sync merges the device into the server and persists the result', async () => {
  const env = { DB: createDb() };
  const { json: created } = await registerPlayer(env, makeDeps(), {
    record: { ...EMPTY_RECORD, weekScore: 900, weekStart: WEEK, cleared: [1, 2], trophies: 4 },
  });
  const response = await handleProfile(
    request('POST', '/api/profile/sync', {
      headers: bearer(created.code),
      body: {
        avatar: 'crane',
        record: { ...EMPTY_RECORD, weekScore: 400, weekStart: WEEK, cleared: [2, 7], trophies: 1 },
      },
    }),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 200);
  const { profile } = await response.json();
  assert.equal(profile.avatar, 'crane');
  assert.equal(profile.record.weekScore, 900, 'same week: the larger score wins');
  assert.equal(profile.record.weekStart, WEEK);
  assert.deepEqual(profile.record.cleared, [1, 2, 7]);
  assert.equal(profile.record.trophies, 4);

  // And the merge is what a later read sees, not just what this call returned.
  const reread = await handleProfile(
    request('GET', '/api/profile', { headers: bearer(created.code) }),
    env,
    makeDeps(),
  );
  assert.deepEqual((await reread.json()).profile, profile);
});

test('sync leaves the name alone — renaming is its own, screened route', async () => {
  const env = { DB: createDb() };
  const { json: created } = await registerPlayer(env, makeDeps());
  const response = await handleProfile(
    request('POST', '/api/profile/sync', {
      headers: bearer(created.code),
      body: { name: 'shit', record: EMPTY_RECORD },
    }),
    env,
    makeDeps(),
  );
  assert.equal((await response.json()).profile.name, 'Alex');
});

test('renaming stores the sanitized name; a screened one is refused', async () => {
  const env = { DB: createDb() };
  const { json: created } = await registerPlayer(env, makeDeps());
  const ok = await handleProfile(
    request('POST', '/api/profile/name', {
      headers: bearer(created.code),
      body: { name: '  Jamie  Q  ' },
    }),
    env,
    makeDeps(),
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).profile.name, 'Jamie Q');

  const rejected = await handleProfile(
    request('POST', '/api/profile/name', {
      headers: bearer(created.code),
      body: { name: 'fuckery' },
    }),
    env,
    makeDeps(),
  );
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), { error: 'name_rejected' });

  // The refusal changed nothing.
  const reread = await handleProfile(
    request('GET', '/api/profile', { headers: bearer(created.code) }),
    env,
    makeDeps(),
  );
  assert.equal((await reread.json()).profile.name, 'Jamie Q');
});

test('registering under a screened name is refused before a row exists', async () => {
  const env = { DB: createDb() };
  const response = await handleProfile(
    request('POST', '/api/profile/register', {
      body: { name: 'cuntface', avatar: 'lantern', record: EMPTY_RECORD },
    }),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 422);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
});

test('two players may share a display name; their public ids differ', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const first = await registerPlayer(env, deps);
  // Same deps, so the second registration draws the *next* values rather than
  // repeating the first — two players, not one registered twice.
  const second = await registerPlayer(env, deps);
  assert.equal(second.response.status, 201);
  assert.equal(first.json.profile.name, second.json.profile.name);
  assert.notEqual(first.json.playerId, second.json.playerId);
});

test('a cross-site browser caller is refused before it reaches the database', async () => {
  const env = { DB: createDb() };
  const response = await handleProfile(
    request('POST', '/api/profile/register', {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      body: { name: 'Alex', avatar: 'lantern' },
    }),
    env,
    makeDeps(),
  );
  assert.equal(response.status, 403);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
});

test('with no database bound the routes say so rather than throwing', async () => {
  const response = await handleProfile(request('GET', '/api/profile'), {}, makeDeps());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'not_configured' });
});

test('unknown paths 404 and wrong methods 405', async () => {
  const env = { DB: createDb() };
  const missing = await handleProfile(request('GET', '/api/profile/nope'), env, makeDeps());
  assert.equal(missing.status, 404);
  const wrongMethod = await handleProfile(request('GET', '/api/profile/register'), env, makeDeps());
  assert.equal(wrongMethod.status, 405);
  const wrongRead = await handleProfile(request('POST', '/api/profile', { body: {} }), env, makeDeps());
  assert.equal(wrongRead.status, 405);
});

test('malformed and oversized bodies are refused', async () => {
  const env = { DB: createDb() };
  const badJson = await handleProfile(
    new Request('https://lantern.example/api/profile/register', { method: 'POST', body: '{' }),
    env,
    makeDeps(),
  );
  assert.equal(badJson.status, 400);
  assert.deepEqual(await badJson.json(), { error: 'invalid_json' });

  const huge = await handleProfile(
    request('POST', '/api/profile/register', {
      body: { name: 'Alex', avatar: 'lantern', record: { cleared: Array(20000).fill(1) } },
    }),
    env,
    makeDeps(),
  );
  assert.equal(huge.status, 413);
});

test('an unknown avatar id is refused; a future one the server never shipped is not', async () => {
  const env = { DB: createDb() };
  const bad = await registerPlayer(env, makeDeps(), { avatar: 'Not An Id!' });
  assert.equal(bad.response.status, 400);
  const future = await registerPlayer(env, makeDeps(), { avatar: 'phoenix' });
  assert.equal(future.response.status, 201);
  assert.equal(future.json.profile.avatar, 'phoenix');
});

test('code guesses are rate limited even though none of them authenticate', async () => {
  // The limiter has to run *before* the code is checked: a wrong code that
  // never reaches a post-auth limiter is exactly the request worth metering.
  const env = { DB: createDb() };
  const deps = makeDeps();
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await handleProfile(
      request('GET', '/api/profile', { headers: bearer('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ') }),
      env,
      deps,
    );
  }
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: 'rate_limited' });
});

test('each route has its own bucket — reading does not spend the sync allowance', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const { json: created } = await registerPlayer(env, deps);
  for (let i = 0; i < 10; i += 1) {
    await handleProfile(request('GET', '/api/profile', { headers: bearer(created.code) }), env, deps);
  }
  const synced = await handleProfile(
    request('POST', '/api/profile/sync', {
      headers: bearer(created.code),
      body: { record: EMPTY_RECORD },
    }),
    env,
    deps,
  );
  assert.equal(synced.status, 200);
});

test("a short-window route's traffic cannot expire the hour-long register window", async () => {
  // Every key has its own row and its own window (issue #186); a route with a
  // short window running in between must not hand back the register allowance.
  const env = { DB: createDb() };
  let clock = 1_700_000_000_000;
  const deps = makeDeps({ now: () => clock });
  let last;
  for (let i = 0; i < 6; i += 1) last = await registerPlayer(env, deps);
  assert.equal(last.response.status, 429);

  // Eleven minutes later: the 10-minute sync window has rolled over, the
  // 1-hour register window has not.
  clock += 11 * 60 * 1000;
  await handleProfile(
    request('GET', '/api/profile', { headers: bearer(last.json.code ?? 'x') }),
    env,
    deps,
  );
  const after = await registerPlayer(env, deps);
  assert.equal(after.response.status, 429);
});

test('registrations from one address are rate limited', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  let last;
  for (let i = 0; i < 6; i += 1) last = await registerPlayer(env, deps);
  assert.equal(last.response.status, 429);
  assert.deepEqual(last.json, { error: 'rate_limited' });
  // The sixth attempt wrote nothing.
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM players').get().n, 5);
});

function from(ip) {
  return { 'CF-Connecting-IP': ip };
}

test('one player syncing from two addresses is metered as one player', async () => {
  // Issue #186: the address bucket alone lets a player exceed the allowance by
  // changing address. The player bucket, checked after the code is verified,
  // does not.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const { json: created } = await registerPlayer(env, deps);
  let last;
  for (let i = 0; i < 61; i += 1) {
    last = await handleProfile(
      request('POST', '/api/profile/sync', {
        headers: { ...bearer(created.code), ...from(i % 2 ? '203.0.113.1' : '203.0.113.2') },
        body: { record: EMPTY_RECORD },
      }),
      env,
      deps,
    );
  }
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: 'rate_limited' });
});

test('two players behind one address share the address bucket', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const a = await registerPlayer(env, deps);
  const b = await registerPlayer(env, deps, { name: 'Bea' });
  const sync = (code) =>
    handleProfile(
      request('POST', '/api/profile/sync', { headers: bearer(code), body: { record: EMPTY_RECORD } }),
      env,
      deps,
    );
  for (let i = 0; i < 30; i += 1) await sync(a.json.code);
  for (let i = 0; i < 30; i += 1) await sync(b.json.code);
  assert.equal((await sync(a.json.code)).status, 429);
  // From another address, neither player has spent their own allowance.
  const elsewhere = await handleProfile(
    request('POST', '/api/profile/sync', {
      headers: { ...bearer(a.json.code), ...from('198.51.100.7') },
      body: { record: EMPTY_RECORD },
    }),
    env,
    deps,
  );
  assert.equal(elsewhere.status, 200);
});

test('registrations from two addresses are independent', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  for (let i = 0; i < 5; i += 1) {
    await handleProfile(
      request('POST', '/api/profile/register', {
        headers: from('203.0.113.1'),
        body: { name: 'Alex', avatar: 'lantern', record: EMPTY_RECORD },
      }),
      env,
      deps,
    );
  }
  const other = await handleProfile(
    request('POST', '/api/profile/register', {
      headers: from('203.0.113.2'),
      body: { name: 'Alex', avatar: 'lantern', record: EMPTY_RECORD },
    }),
    env,
    deps,
  );
  assert.equal(other.status, 201);
});

test('the count survives a fresh deps object — nothing is kept in memory', async () => {
  const env = { DB: createDb() };
  let last;
  for (let i = 0; i < 6; i += 1) last = await registerPlayer(env, makeDeps());
  assert.equal(last.response.status, 429);
});
