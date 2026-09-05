// Profile sync, device side (issue #138). The endpoint is a stub `fetch`, so
// what is under test is the whole client contract: the request each call
// makes, the credential handling, and — most of the surface — what happens
// when the endpoint is missing, slow, or answering something unexpected. The
// invariant every one of those cases has to keep is that the local profile is
// left exactly as it was.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_RECORD } from '../src/profile.js';
import type { PlayerRecord } from '../src/profile.js';
import {
  SYNC_STORAGE_KEY,
  closeAccount,
  fetchProfile,
  forgetCredentials,
  formatCode,
  formatPlayerTag,
  normalizeCode,
  mergeRecords,
  pushName,
  pushRecord,
  readCredentials,
  registerProfile,
  resetAccount,
  writeCredentials,
} from '../src/sync.js';
import type { KeyValueStorage } from '../src/storage.js';

function fakeStorage(seed: Record<string, string> = {}): KeyValueStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that records what it was asked and answers with `reply`. */
function stubFetch(reply: { status: number; body?: unknown } | Error): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CREDENTIALS = { playerId: '7K3MQ2R9WD', code: 'ABCD-1234-EFGH-5678-JKMN-9PQR' };

const REMOTE = {
  playerId: '7K3MQ2R9WD',
  name: 'Alex',
  avatar: 'crane',
  record: { ...EMPTY_RECORD, weekScore: 900, weekStart: '2026-08-30', cleared: [1, 2], trophies: 4 },
};

// --- credentials ---------------------------------------------------------------

test('sync is off until credentials are stored, and off again once forgotten', () => {
  const storage = fakeStorage();
  assert.equal(readCredentials(storage), null);
  writeCredentials(storage, CREDENTIALS);
  assert.deepEqual(readCredentials(storage), CREDENTIALS);
  forgetCredentials(storage);
  assert.equal(readCredentials(storage), null);
  assert.equal(storage.data.has(SYNC_STORAGE_KEY), false);
});

test('an unreadable or half-written credential record reads as sync off', () => {
  assert.equal(readCredentials(fakeStorage({ [SYNC_STORAGE_KEY]: 'not json' })), null);
  assert.equal(
    readCredentials(fakeStorage({ [SYNC_STORAGE_KEY]: JSON.stringify({ playerId: 'x' }) })),
    null,
  );
  // No storage at all (Safari private mode) is the same answer, not a throw.
  assert.equal(readCredentials(undefined), null);
});

test('the public tag is the id the leaderboard will show', () => {
  assert.equal(formatPlayerTag('7K3MQ2R9WD'), '#7K3MQ2R9WD');
});

test('a typed code is canonicalized before it is stored and shown', () => {
  // However it was transcribed, the panel ends up holding one form of it.
  for (const typed of [
    'abcd1234efgh5678jkmn9pqr',
    'ABCD-1234-EFGH-5678-JKMN-9PQR',
    'abcd 1234 efgh 5678 jkmn 9pqr',
  ]) {
    assert.equal(formatCode(normalizeCode(typed)!), 'ABCD-1234-EFGH-5678-JKMN-9PQR');
  }
  // The letters Crockford omits are read as the digits they look like.
  assert.equal(normalizeCode('ILCD1234EFGH5678JKMN9PQO'), '11CD1234EFGH5678JKMN9PQ0');
});

test('something that is not a code is refused without a round trip', () => {
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode('ABCD'), null);
  assert.equal(normalizeCode('ABCD1234EFGH5678JKMN9PQ!'), null);
  // 25 symbols, not 24.
  assert.equal(normalizeCode('ABCD1234EFGH5678JKMN9PQRS'), null);
});

// --- registering ---------------------------------------------------------------

test('turning sync on sends the local profile and takes back id and code', async () => {
  const { fetchImpl, calls } = stubFetch({
    status: 201,
    body: { playerId: REMOTE.playerId, code: CREDENTIALS.code, profile: REMOTE },
  });
  const result = await registerProfile(
    { name: 'Alex', avatar: 'crane', record: EMPTY_RECORD },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.deepEqual(result.value.credentials, CREDENTIALS);
  assert.equal(result.value.profile.name, 'Alex');
  assert.equal(calls[0]!.url, '/api/profile/register');
  assert.equal(calls[0]!.method, 'POST');
  assert.deepEqual(calls[0]!.body, { name: 'Alex', avatar: 'crane', record: EMPTY_RECORD });
  // Registering carries no credential — it is what mints one.
  assert.equal(calls[0]!.headers['Authorization'], undefined);
});

test('a registration that answers without a code is not a registration', async () => {
  const { fetchImpl } = stubFetch({ status: 201, body: { profile: REMOTE } });
  const result = await registerProfile(
    { name: 'Alex', avatar: 'crane', record: EMPTY_RECORD },
    { fetchImpl },
  );
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
});

test('a screened name is reported as such, not as a generic failure', async () => {
  const { fetchImpl } = stubFetch({ status: 422, body: { error: 'name_rejected' } });
  const result = await registerProfile(
    { name: 'nope', avatar: 'crane', record: EMPTY_RECORD },
    { fetchImpl },
  );
  assert.deepEqual(result, { ok: false, reason: 'name_rejected' });
});

test('every way the endpoint can be missing reads as offline or unavailable', async () => {
  const cases: Array<[{ status: number; body?: unknown } | Error, string]> = [
    [new Error('network'), 'offline'],
    [{ status: 503, body: { error: 'not_configured' } }, 'unavailable'],
    [{ status: 500 }, 'unavailable'],
    [{ status: 404, body: { error: 'not_found' } }, 'unavailable'],
    [{ status: 429, body: { error: 'rate_limited' } }, 'rate_limited'],
    // 200 with a body that is not JSON at all.
    [{ status: 200 }, 'unavailable'],
  ];
  for (const [reply, reason] of cases) {
    const { fetchImpl } = stubFetch(reply);
    const result = await registerProfile(
      { name: 'Alex', avatar: 'crane', record: EMPTY_RECORD },
      { fetchImpl },
    );
    assert.deepEqual(result, { ok: false, reason }, `${reason} case`);
  }
});

// --- syncing -------------------------------------------------------------------

test('a push carries the code as a bearer token and no name', async () => {
  const { fetchImpl, calls } = stubFetch({ status: 200, body: { profile: REMOTE } });
  const result = await pushRecord(
    CREDENTIALS,
    { avatar: 'crane', record: EMPTY_RECORD },
    { fetchImpl },
  );
  assert.ok(result.ok);
  assert.equal(result.value.record.weekScore, 900);
  assert.equal(calls[0]!.url, '/api/profile/sync');
  assert.equal(calls[0]!.headers['Authorization'], `Bearer ${CREDENTIALS.code}`);
  assert.deepEqual(Object.keys(calls[0]!.body as object), ['avatar', 'record']);
});

test('a code the server no longer knows is unauthorized, not offline', async () => {
  const { fetchImpl } = stubFetch({ status: 401, body: { error: 'unauthorized' } });
  const result = await pushRecord(
    CREDENTIALS,
    { avatar: 'crane', record: EMPTY_RECORD },
    { fetchImpl },
  );
  assert.deepEqual(result, { ok: false, reason: 'unauthorized' });
});

test('renaming posts just the name to its own route', async () => {
  const { fetchImpl, calls } = stubFetch({ status: 200, body: { profile: REMOTE } });
  const result = await pushName(CREDENTIALS, 'Alex', { fetchImpl });
  assert.ok(result.ok);
  assert.equal(calls[0]!.url, '/api/profile/name');
  assert.deepEqual(calls[0]!.body, { name: 'Alex' });
});

test('restoring reads the profile with the code alone', async () => {
  const { fetchImpl, calls } = stubFetch({ status: 200, body: { profile: REMOTE } });
  const result = await fetchProfile(CREDENTIALS.code, { fetchImpl });
  assert.ok(result.ok);
  assert.deepEqual(result.value.record.cleared, [1, 2]);
  assert.equal(calls[0]!.url, '/api/profile');
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.headers['Authorization'], `Bearer ${CREDENTIALS.code}`);
});

test('a profile the server answers malformed is refused rather than adopted', async () => {
  for (const body of [
    {},
    { profile: null },
    { profile: { name: 'Alex', avatar: 'crane' } },
    { profile: { playerId: '', name: 'Alex', avatar: 'crane' } },
    { profile: { playerId: 'X', name: 7, avatar: 'crane' } },
  ]) {
    const { fetchImpl } = stubFetch({ status: 200, body });
    const result = await fetchProfile(CREDENTIALS.code, { fetchImpl });
    assert.deepEqual(result, { ok: false, reason: 'unavailable' }, JSON.stringify(body));
  }
});

test('a record the server answers with junk fields is parsed, not trusted', async () => {
  const { fetchImpl } = stubFetch({
    status: 200,
    body: {
      profile: {
        ...REMOTE,
        record: { bestScore: -5, cleared: ['x', 3], trophies: 2.5, lastDaily: 'soon' },
      },
    },
  });
  const result = await fetchProfile(CREDENTIALS.code, { fetchImpl });
  assert.ok(result.ok);
  assert.deepEqual(result.value.record, { ...EMPTY_RECORD, cleared: [3] });
});

// --- merging -------------------------------------------------------------------

const WEEK = '2026-08-30';
const withRecord = (fields: Partial<PlayerRecord>): PlayerRecord => ({ ...EMPTY_RECORD, ...fields });

test('merging keeps the best of both and loses nothing', () => {
  const merged = mergeRecords(
    withRecord({ levelsCleared: 10, weekScore: 5000, weekStart: WEEK, cleared: [1, 2], trophies: 7 }),
    withRecord({ levelsCleared: 3, weekScore: 400, weekStart: WEEK, cleared: [2, 5], trophies: 1 }),
  );
  assert.deepEqual(merged, {
    levelsCleared: 10,
    weekScore: 5000,
    weekStart: WEEK,
    cleared: [1, 2, 5],
    dailyStreak: 0,
    lastDaily: null,
    trophies: 7,
  });
});

// --- the week score is the one field that may go down -----------------------
//
// Every other counter here only grows, so Math.max is the whole merge rule for
// them. A weekly score resets (issue #176): taking the larger of two weeks
// would resurrect last week's total at the rollover and then keep winning
// every merge after it, so the reset could never stick on any device.

test('a later week beats a bigger score from an earlier one', () => {
  const lastWeek = withRecord({ weekScore: 90000, weekStart: '2026-08-30' });
  const thisWeek = withRecord({ weekScore: 120, weekStart: '2026-09-06' });
  assert.equal(mergeRecords(lastWeek, thisWeek).weekScore, 120);
  assert.equal(mergeRecords(lastWeek, thisWeek).weekStart, '2026-09-06');
  assert.deepEqual(mergeRecords(thisWeek, lastWeek), mergeRecords(lastWeek, thisWeek));
});

test('within one week the larger score wins, as before', () => {
  const a = withRecord({ weekScore: 400, weekStart: WEEK });
  const b = withRecord({ weekScore: 5000, weekStart: WEEK });
  assert.equal(mergeRecords(a, b).weekScore, 5000);
  assert.equal(mergeRecords(a, b).weekStart, WEEK);
});

test('a side that has never scored contributes no week', () => {
  const scored = withRecord({ weekScore: 700, weekStart: WEEK });
  assert.deepEqual(mergeRecords(scored, EMPTY_RECORD), scored);
  assert.deepEqual(mergeRecords(EMPTY_RECORD, scored), scored);
});

test('a reinstalled device that clears today keeps the streak it never saw', () => {
  const merged = mergeRecords(
    withRecord({ dailyStreak: 1, lastDaily: '2026-09-02' }),
    withRecord({ dailyStreak: 30, lastDaily: '2026-09-01' }),
  );
  assert.equal(merged.dailyStreak, 30);
  assert.equal(merged.lastDaily, '2026-09-02');
});

test('a streak already broken by a gap is not resurrected by a merge', () => {
  const merged = mergeRecords(
    withRecord({ dailyStreak: 2, lastDaily: '2026-09-02' }),
    withRecord({ dailyStreak: 30, lastDaily: '2026-08-01' }),
  );
  assert.equal(merged.dailyStreak, 2);
  assert.equal(merged.lastDaily, '2026-09-02');
});

test('merging is symmetric, and a side with no Daily history contributes none', () => {
  const a = withRecord({ weekScore: 10, weekStart: WEEK, cleared: [1], dailyStreak: 4, lastDaily: '2026-09-01' });
  const b = withRecord({ weekScore: 20, weekStart: WEEK, cleared: [2], dailyStreak: 1, lastDaily: '2026-09-02' });
  assert.deepEqual(mergeRecords(a, b), mergeRecords(b, a));
  const played = withRecord({ dailyStreak: 5, lastDaily: '2026-09-02' });
  assert.deepEqual(mergeRecords(played, EMPTY_RECORD), played);
  assert.deepEqual(mergeRecords(EMPTY_RECORD, played), played);
});

// --- reset and close (issue #201) ---------------------------------------------

test('resetting posts to its own route with the code and no body, and takes the empty record back', async () => {
  const { fetchImpl, calls } = stubFetch({ status: 200, body: { profile: { ...REMOTE, record: EMPTY_RECORD } } });
  const result = await resetAccount(CREDENTIALS, { fetchImpl });
  assert.ok(result.ok);
  assert.deepEqual(result.value.record, EMPTY_RECORD);
  assert.equal(calls[0]!.url, '/api/profile/reset');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers['Authorization'], `Bearer ${CREDENTIALS.code}`);
  assert.equal(calls[0]!.body, undefined);
});

test('closing sends DELETE to the profile route with the code', async () => {
  const { fetchImpl, calls } = stubFetch({ status: 200, body: { status: 'closed' } });
  const result = await closeAccount(CREDENTIALS, { fetchImpl });
  assert.ok(result.ok);
  assert.equal(calls[0]!.url, '/api/profile');
  assert.equal(calls[0]!.method, 'DELETE');
  assert.equal(calls[0]!.headers['Authorization'], `Bearer ${CREDENTIALS.code}`);
});

test('a refused reset or close is the usual taxonomy, so the device is left alone', async () => {
  const offline = await resetAccount(CREDENTIALS, { fetchImpl: stubFetch(new Error('down')).fetchImpl });
  assert.deepEqual(offline, { ok: false, reason: 'offline' });
  const gone = await closeAccount(CREDENTIALS, { fetchImpl: stubFetch({ status: 401 }).fetchImpl });
  assert.deepEqual(gone, { ok: false, reason: 'unauthorized' });
  const limited = await closeAccount(CREDENTIALS, { fetchImpl: stubFetch({ status: 429 }).fetchImpl });
  assert.deepEqual(limited, { ok: false, reason: 'rate_limited' });
});
