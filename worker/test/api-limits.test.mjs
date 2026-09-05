// Issue #191: the API limits table in docs/decisions/0033-api-limits.md is
// checked cell by cell against the constants the route modules export, so the
// documented numbers cannot drift from the enforced ones in either direction.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FEEDBACK_LIMITS } from '../index.mjs';
import { MAX_BODY_BYTES as PROFILE_BODY, RATE_LIMITS as PROFILE } from '../profile.mjs';
import { MAX_BODY_BYTES as BOARD_BODY, MAX_RUNS_PER_WEEK, RATE_LIMITS as BOARD } from '../leaderboard.mjs';

const DOC = new URL('../../docs/decisions/0033-api-limits.md', import.meta.url);

/** The table's rows keyed by route: `{ body, address, player, day }`. */
function readTable() {
  const rows = new Map();
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const m = /^\| `([A-Z]+ \/api\/[^`]+)` \| (.+) \|$/.exec(line);
    if (!m) continue;
    const [body, address, player, day] = m[2].split(' | ');
    rows.set(m[1], { body, address, player, day });
  }
  return rows;
}

function bytes(n) {
  return n >= 1024 * 1024 ? `${n / (1024 * 1024)} MB` : `${n / 1024} KB`;
}

function rate({ max, windowMs }) {
  const window = windowMs === 60 * 60 * 1000 ? '1 h' : `${windowMs / 60_000} min`;
  return `${max} / ${window}`;
}

const NONE = '—';

test('the API limits table states exactly what the code enforces', () => {
  const table = readTable();
  const expected = {
    'POST /api/feedback': {
      body: `${bytes(FEEDBACK_LIMITS.MAX_BODY_BYTES)} text, ${bytes(FEEDBACK_LIMITS.MAX_BODY_BYTES_WITH_ATTACHMENTS)} with the build header`,
      address: rate({ max: FEEDBACK_LIMITS.RATE_LIMIT_MAX, windowMs: FEEDBACK_LIMITS.RATE_LIMIT_WINDOW_MS }),
      player: NONE,
      day: `${FEEDBACK_LIMITS.DAILY_MAX} per address, ${FEEDBACK_LIMITS.DAILY_GLOBAL_MAX} global`,
    },
    'POST /api/profile/register': {
      body: bytes(PROFILE_BODY),
      address: rate(PROFILE.register),
      player: NONE,
      day: `${PROFILE.register.perDay} per address, ${PROFILE.register.perDayGlobal.toLocaleString('en-US')} global`,
    },
    'GET /api/profile': { body: NONE, address: rate(PROFILE.read), player: rate(PROFILE.read), day: NONE },
    'POST /api/profile/sync': {
      body: bytes(PROFILE_BODY),
      address: rate(PROFILE.sync),
      player: rate(PROFILE.sync),
      day: String(PROFILE.sync.perDay),
    },
    'POST /api/profile/name': {
      body: bytes(PROFILE_BODY),
      address: rate(PROFILE.name),
      player: rate(PROFILE.name),
      day: String(PROFILE.name.perDay),
    },
    'POST /api/profile/reset': {
      body: NONE,
      address: rate(PROFILE.reset),
      player: rate(PROFILE.reset),
      day: String(PROFILE.reset.perDay),
    },
    'DELETE /api/profile': {
      body: NONE,
      address: rate(PROFILE.close),
      player: rate(PROFILE.close),
      day: String(PROFILE.close.perDay),
    },
    'POST /api/leaderboard/weekly': {
      body: bytes(BOARD_BODY),
      address: rate(BOARD.submit),
      player: rate(BOARD.submit),
      day: `${NONE} (${MAX_RUNS_PER_WEEK} runs a week, 0027)`,
    },
    'GET /api/leaderboard/weekly': {
      body: NONE,
      address: `${rate(BOARD.read)} anonymous, ${rate(BOARD['read-signed'])} signed`,
      player: NONE,
      day: NONE,
    },
    'DELETE /api/leaderboard/weekly': {
      body: NONE,
      address: rate(BOARD.withdraw),
      player: rate(BOARD.withdraw),
      day: String(BOARD.withdraw.perDay),
    },
  };
  assert.deepEqual([...table.keys()], Object.keys(expected), 'the table lists every route once, in this order');
  for (const [route, cells] of Object.entries(expected)) {
    assert.deepEqual(table.get(route), cells, route);
  }
});

test('the code has no route or limit the table does not list', () => {
  // A new `perDay` (or a new route) in RATE_LIMITS without a table row is the
  // drift this file exists to catch; the row check above covers the values,
  // this covers the keys.
  assert.deepEqual(Object.keys(PROFILE).sort(), ['close', 'name', 'read', 'register', 'reset', 'sync']);
  assert.deepEqual(Object.keys(BOARD).sort(), ['read', 'read-signed', 'submit', 'withdraw']);
  assert.deepEqual(Object.keys(FEEDBACK_LIMITS).sort(), [
    'DAILY_GLOBAL_MAX',
    'DAILY_MAX',
    'MAX_BODY_BYTES',
    'MAX_BODY_BYTES_WITH_ATTACHMENTS',
    'RATE_LIMIT_MAX',
    'RATE_LIMIT_WINDOW_MS',
  ]);
});
