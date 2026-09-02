// Daily Challenge leaderboard, device side (issue #70).
//
// Two things are worth pinning here. One: the opt-in is a real consent, so it
// has to default to off and stay off when the stored record is anything other
// than an explicit yes. Two: `boardRows` merges the top of the board with the
// player's own neighbourhood, and those two lists can overlap, touch, or sit
// far apart — the overlap case is the one that silently renders a player
// twice.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEADERBOARD_STORAGE_KEY,
  boardRows,
  compactHistory,
  fetchDailyBoard,
  formatBoardTime,
  readOptIn,
  submitDailyScore,
  withdrawFromBoard,
  writeOptIn,
} from '../src/leaderboard.js';
import type { BoardEntry, DailyBoard } from '../src/leaderboard.js';
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

function stubFetch(reply: { status: number; body?: unknown } | Error): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers as Record<string, string> | undefined) ?? {},
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

const entry = (rank: number, over: Partial<BoardEntry> = {}): BoardEntry => ({
  rank,
  playerId: `P${rank}`,
  name: `Player ${rank}`,
  avatar: 'lantern',
  score: 2000 - rank * 100,
  elapsedMs: 90_000,
  ...over,
});

const BOARD = {
  date: '2026-09-02',
  top: [entry(1), entry(2)],
  you: entry(2),
  around: [],
};

// --- the opt-in ----------------------------------------------------------------

test('appearing on a public board is off until it is explicitly turned on', () => {
  assert.equal(readOptIn(fakeStorage()), false);
  assert.equal(readOptIn(undefined), false);
  // Anything that is not an explicit `true` is not consent.
  for (const stored of ['not json', '{}', '{"optIn":"yes"}', '{"optIn":1}', 'null']) {
    assert.equal(readOptIn(fakeStorage({ [LEADERBOARD_STORAGE_KEY]: stored })), false, stored);
  }
});

test('the choice persists both ways', () => {
  const storage = fakeStorage();
  writeOptIn(storage, true);
  assert.equal(readOptIn(storage), true);
  writeOptIn(storage, false);
  assert.equal(readOptIn(storage), false);
});

// --- the endpoint ----------------------------------------------------------------

test('a finished Daily posts its date, score and time under the player code', async () => {
  const { fetchImpl, calls } = stubFetch({ status: 200, body: BOARD });
  const result = await submitDailyScore(
    CREDENTIALS,
    { date: '2026-09-02', score: 4200, elapsedMs: 90_000 },
    { fetchImpl },
  );
  assert.ok(result.ok);
  assert.equal(result.value.you?.rank, 2);
  assert.equal(calls[0]!.url, '/api/leaderboard/daily');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers['Authorization'], `Bearer ${CREDENTIALS.code}`);
  assert.deepEqual(calls[0]!.body, { date: '2026-09-02', score: 4200, elapsedMs: 90_000 });
});

test('reading a board carries a code only when there is one', async () => {
  const signed = stubFetch({ status: 200, body: BOARD });
  await fetchDailyBoard('2026-09-02', CREDENTIALS, { fetchImpl: signed.fetchImpl });
  assert.equal(signed.calls[0]!.url, '/api/leaderboard/daily?date=2026-09-02');
  assert.equal(signed.calls[0]!.headers['Authorization'], `Bearer ${CREDENTIALS.code}`);

  const anonymous = stubFetch({ status: 200, body: { ...BOARD, you: null } });
  const result = await fetchDailyBoard('2026-09-02', null, { fetchImpl: anonymous.fetchImpl });
  assert.ok(result.ok);
  assert.equal(result.value.you, null);
  assert.equal(anonymous.calls[0]!.headers['Authorization'], undefined);
});

test('withdrawing deletes, and reports the same failures everything else does', async () => {
  const { fetchImpl, calls } = stubFetch({ status: 200, body: { status: 'withdrawn' } });
  assert.deepEqual(await withdrawFromBoard(CREDENTIALS, { fetchImpl }), { ok: true, value: null });
  assert.equal(calls[0]!.method, 'DELETE');

  const offline = stubFetch(new Error('network'));
  assert.deepEqual(await withdrawFromBoard(CREDENTIALS, { fetchImpl: offline.fetchImpl }), {
    ok: false,
    reason: 'offline',
  });
});

test('a board the server answers malformed never reaches the renderer', async () => {
  for (const body of [
    {},
    { date: 5, top: [], around: [] },
    { date: '2026-09-02', top: 'nope', around: [] },
    { date: '2026-09-02', top: [{ rank: 1 }], around: [] },
    { date: '2026-09-02', top: [], around: [], you: { rank: 'first' } },
  ]) {
    const { fetchImpl } = stubFetch({ status: 200, body });
    const result = await fetchDailyBoard('2026-09-02', null, { fetchImpl });
    assert.deepEqual(result, { ok: false, reason: 'unavailable' }, JSON.stringify(body));
  }
});

test('an unreachable board is offline, a broken one is unavailable', async () => {
  const cases: Array<[{ status: number; body?: unknown } | Error, string]> = [
    [new Error('network'), 'offline'],
    [{ status: 503, body: { error: 'not_configured' } }, 'unavailable'],
    [{ status: 401, body: { error: 'unauthorized' } }, 'unauthorized'],
    [{ status: 429, body: { error: 'rate_limited' } }, 'rate_limited'],
  ];
  for (const [reply, reason] of cases) {
    const { fetchImpl } = stubFetch(reply);
    assert.deepEqual(await fetchDailyBoard('2026-09-02', null, { fetchImpl }), {
      ok: false,
      reason,
    });
  }
});

test('the submitted history keeps what a replay needs and drops the rest', () => {
  const moves = [
    {
      kind: 'match',
      a: 12,
      b: 88,
      heldA: null,
      heldB: 0,
      atMs: 1200,
      prevSelection: 12,
      prevScores: { score: 0, streak: 0, lastMatchMs: null },
    },
    { kind: 'hold', tile: 2, slotIndex: 0, atMs: 25, prevSelection: null, prevScores: {} },
  ];
  assert.deepEqual(compactHistory(moves), [
    { kind: 'match', a: 12, b: 88, heldA: null, heldB: 0, atMs: 1200 },
    { kind: 'hold', tile: 2, slotIndex: 0, atMs: 25 },
  ]);
});

// --- rendering -------------------------------------------------------------------

test('times read like the in-game clock', () => {
  assert.equal(formatBoardTime(0), '0:00');
  assert.equal(formatBoardTime(9_000), '0:09');
  assert.equal(formatBoardTime(247_000), '4:07');
  assert.equal(formatBoardTime(-5), '0:00');
});

const board = (over: Partial<DailyBoard>): DailyBoard => ({
  date: '2026-09-02',
  top: [],
  you: null,
  around: [],
  ...over,
});

test('with nobody outside the top, the board is just the top', () => {
  const rows = boardRows(board({ top: [entry(1), entry(2), entry(3)], you: entry(2) }));
  assert.deepEqual(
    rows.map((r) => (r.kind === 'entry' ? r.entry.rank : 'gap')),
    [1, 2, 3],
  );
});

test('a distant player is shown after a break marker', () => {
  const top = Array.from({ length: 10 }, (_, i) => entry(i + 1));
  const rows = boardRows(
    board({ top, you: entry(41), around: [entry(38), entry(39), entry(40), entry(41), entry(42)] }),
  );
  const shape = rows.map((r) => (r.kind === 'entry' ? r.entry.rank : 'gap'));
  assert.deepEqual(shape, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'gap', 38, 39, 40, 41, 42]);
});

test('a player just below the top is not shown twice, and needs no break', () => {
  // Rank 11's neighbourhood starts at 8 — three rows that are already in the
  // top ten. Repeating them is the bug; so is a break marker between rank 10
  // and rank 11.
  const top = Array.from({ length: 10 }, (_, i) => entry(i + 1));
  const rows = boardRows(
    board({ top, you: entry(11), around: [entry(8), entry(9), entry(10), entry(11), entry(12)] }),
  );
  assert.deepEqual(
    rows.map((r) => (r.kind === 'entry' ? r.entry.rank : 'gap')),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
});

test('a neighbourhood entirely inside the top adds nothing at all', () => {
  const top = Array.from({ length: 10 }, (_, i) => entry(i + 1));
  const rows = boardRows(board({ top, you: entry(4), around: [entry(3), entry(4), entry(5)] }));
  assert.equal(rows.length, 10);
});

test('an empty board has no rows and no break marker', () => {
  assert.deepEqual(boardRows(board({})), []);
});
