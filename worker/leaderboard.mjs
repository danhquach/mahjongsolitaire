// Daily Challenge leaderboard (issue #70).
//
// The Daily is the one board where comparing scores is fair: a date key fixes
// the layout and the seed (core `dailyLayoutId` / `dailySeed`), so everyone
// who played 2026-09-02 played the same tiles in the same places. Ladder
// levels and an all-time board are deliberately not here — see
// docs/decisions/0022-daily-leaderboard-first.md.
//
// Identity comes from issue #138: an entry belongs to a `players` row, and the
// name shown on the board is the screened, server-held one, never a name the
// submitting client supplies.
//
// **Scores are not verified.** A submission is bounded, not checked: the
// server confirms the score is inside what the scoring rules can produce on a
// 144-tile board and that a date is real, and then believes it. Verifying a
// score means recomputing it from the move history against a regenerated
// board, which needs a change to core's move stack (shuffles are counted but
// their seeds are not recorded, so a run that shuffled cannot be replayed) —
// that is the follow-up ticket, and the reason every row already stores the
// history it was submitted with. Until then a determined player can post a
// score they did not play, and the board should not be treated as evidence of
// anything.

import { callerKey, createRateLimitStore, isCrossSite, json, rateLimited } from './http.mjs';

/** Every shipped layout is 144 tiles — 72 pairs. The Super Combo ladder
 *  (core `ScoreKeeper`) pays 100 for the first match, then 120, 150, 200, and
 *  300 for every match after that, so a flawless run is:
 *
 *      100 + 120 + 150 + 200 + 68 × 300 = 20970
 *
 *  Nothing in the game deducts points, so this is a hard ceiling rather than
 *  a heuristic. A layout with a different tile count would need this to be
 *  derived per layout instead of stated once. */
export const MAX_DAILY_SCORE = 20970;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** A day either side of the server's own date: the date key is the player's
 *  local calendar day, and local days run from UTC−12 to UTC+14. */
const DATE_SKEW_DAYS = 1;
/** Nothing older than this is accepted — a board nobody can still be playing
 *  has no business gaining entries. */
const MAX_DATE_AGE_DAYS = 30;
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;
/** The move history rides along for the verification follow-up. It is stored
 *  and never read, so the cap only has to keep a row from being abused as
 *  storage: a full 72-pair game is a few KB. Measured in UTF-16 units rather
 *  than bytes — the real byte ceiling is `MAX_BODY_BYTES`, checked on the
 *  request itself before anything is parsed. */
const MAX_HISTORY_CHARS = 64 * 1024;
const MAX_BODY_BYTES = 96 * 1024;

/** How many entries the board shows, and how many either side of the player. */
export const BOARD_TOP = 10;
export const BOARD_NEIGHBOURS = 3;

const RATE_LIMITS = {
  submit: { max: 20, windowMs: 10 * 60 * 1000 },
  // Reading is public and cheap, but an authenticated read is a credential
  // check, and this route must not be a roomier door to that check than the
  // profile's own read (10 / 10 min). So the *signed* reads get their own,
  // tighter bucket; an anonymous read never touches a code at all.
  read: { max: 60, windowMs: 10 * 60 * 1000 },
  'read-signed': { max: 10, windowMs: 10 * 60 * 1000 },
  withdraw: { max: 10, windowMs: 10 * 60 * 1000 },
};

/** Falls back to a per-isolate store, exactly like the profile routes: the
 *  entry point injects nothing, and a limiter that is only wired up in tests
 *  is not a limiter. */
const defaultRateLimitStore = createRateLimitStore();

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The server's own date key, for bounding a submitted one. */
function todayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** A date key that could plausibly be a board someone is playing right now. */
export function dateAcceptable(dateKey, now) {
  if (typeof dateKey !== 'string' || !DATE_KEY.test(dateKey)) return false;
  const gap = daysBetween(dateKey, todayKey(now));
  return Number.isFinite(gap) && gap >= -DATE_SKEW_DAYS && gap <= MAX_DATE_AGE_DAYS;
}

function integerInRange(value, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * A submission, bounded field by field. Returns the values to store, or a
 * string naming what was wrong — the caller turns that into a status, because
 * "your score is impossible" and "that date is not a board" deserve
 * different answers.
 */
export function validateSubmission(payload, now) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 'invalid';
  if (!dateAcceptable(payload.date, now)) return 'bad_date';
  if (!integerInRange(payload.score, MAX_DAILY_SCORE)) return 'bad_score';
  if (!integerInRange(payload.elapsedMs, MAX_ELAPSED_MS)) return 'invalid';
  let history = null;
  if (payload.history !== undefined && payload.history !== null) {
    history = JSON.stringify(payload.history);
    if (history.length > MAX_HISTORY_CHARS) return 'invalid';
  }
  return {
    date: payload.date,
    score: payload.score,
    elapsedMs: payload.elapsedMs,
    history,
  };
}

// --- queries -----------------------------------------------------------------

/** Board order: higher score first, and among equal scores the one that got
 *  there first. Ties are common — 72 pairs and a capped multiplier put a lot
 *  of good runs on the same number — so the tie-break has to be stable and
 *  has to reward the earlier submission rather than the later one. */
const ORDER = 'ORDER BY s.score DESC, s.updated_at ASC, s.player_id ASC';

const ENTRY_COLUMNS = `s.player_id AS playerId, p.name AS name, p.avatar AS avatar,
                       s.score AS score, s.elapsed_ms AS elapsedMs, s.updated_at AS at`;

function toEntry(row, rank) {
  return {
    rank,
    playerId: row.playerId,
    name: row.name,
    avatar: row.avatar,
    score: row.score,
    elapsedMs: row.elapsedMs,
  };
}

async function topEntries(db, date) {
  const { results } = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM daily_scores s JOIN players p ON p.id = s.player_id
        WHERE s.date = ? ${ORDER} LIMIT ?`,
    )
    .bind(date, BOARD_TOP)
    .all();
  return (results ?? []).map((row, i) => toEntry(row, i + 1));
}

/** One player's own row, or null when they have not submitted for this date. */
async function ownRow(db, date, playerId) {
  return await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM daily_scores s JOIN players p ON p.id = s.player_id
        WHERE s.date = ? AND s.player_id = ?`,
    )
    .bind(date, playerId)
    .first();
}

/** Where a row sits on the board: one more than the number of rows that beat
 *  it, under exactly the ordering `ORDER` applies. */
async function rankOf(db, date, row) {
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS ahead FROM daily_scores
        WHERE date = ?
          AND (score > ?
               OR (score = ? AND updated_at < ?)
               OR (score = ? AND updated_at = ? AND player_id < ?))`,
    )
    .bind(date, row.score, row.score, row.at, row.score, row.at, row.playerId)
    .first();
  return (result?.ahead ?? 0) + 1;
}

/** The entries immediately above and below a player — the issue's "own rank
 *  and nearby entries visible, not just the top N". */
async function neighbours(db, date, row, rank) {
  const above = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM daily_scores s JOIN players p ON p.id = s.player_id
        WHERE s.date = ?
          AND (s.score > ?
               OR (s.score = ? AND s.updated_at < ?)
               OR (s.score = ? AND s.updated_at = ? AND s.player_id < ?))
        ORDER BY s.score ASC, s.updated_at DESC, s.player_id DESC LIMIT ?`,
    )
    .bind(date, row.score, row.score, row.at, row.score, row.at, row.playerId, BOARD_NEIGHBOURS)
    .all();
  const below = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM daily_scores s JOIN players p ON p.id = s.player_id
        WHERE s.date = ?
          AND (s.score < ?
               OR (s.score = ? AND s.updated_at > ?)
               OR (s.score = ? AND s.updated_at = ? AND s.player_id > ?))
        ${ORDER} LIMIT ?`,
    )
    .bind(date, row.score, row.score, row.at, row.score, row.at, row.playerId, BOARD_NEIGHBOURS)
    .all();
  // `above` came back nearest-first (the ordering is reversed to make LIMIT
  // take the closest rows); the board reads top-down, so flip it back.
  const aboveRows = (above.results ?? []).reverse();
  return [
    ...aboveRows.map((r, i) => toEntry(r, rank - aboveRows.length + i)),
    toEntry(row, rank),
    ...(below.results ?? []).map((r, i) => toEntry(r, rank + i + 1)),
  ];
}

/** The whole board as the client renders it: the top N, plus where this
 *  player sits and who is around them (null when they have not played it). */
export async function boardFor(db, date, playerId) {
  const top = await topEntries(db, date);
  if (playerId === null) return { date, top, you: null, around: [] };
  const row = await ownRow(db, date, playerId);
  if (!row) return { date, top, you: null, around: [] };
  const rank = await rankOf(db, date, row);
  // Already visible in the top N — repeating those rows underneath it is
  // noise, so only the rank is worth sending.
  const around = rank <= BOARD_TOP ? [] : await neighbours(db, date, row, rank);
  return { date, top, you: toEntry(row, rank), around };
}

// --- routes ------------------------------------------------------------------

async function readBody(request) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return { error: json(413, { error: 'payload_too_large' }) };
  }
  // Without a trustworthy Content-Length the body is read before it is
  // measured; the platform's own request-size ceiling bounds that read.
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return { error: json(413, { error: 'payload_too_large' }) };
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: json(400, { error: 'invalid_json' }) };
  }
}

async function submit(request, env, deps, now) {
  const auth = await deps.authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const body = await readBody(request);
  if (body.error) return body.error;

  const submission = validateSubmission(body.value, now);
  if (submission === 'bad_date') return json(422, { error: 'date_not_open' });
  if (submission === 'bad_score') return json(422, { error: 'score_out_of_range' });
  if (submission === 'invalid') return json(400, { error: 'invalid_payload' });

  // One row per (date, player), and it only ever moves up: replaying a Daily
  // to a worse score must not cost the player the rank they earned. The
  // `excluded.score > score` guard is what makes a resubmission idempotent.
  await env.DB.prepare(
    `INSERT INTO daily_scores (date, player_id, score, elapsed_ms, history, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (date, player_id) DO UPDATE SET
          score = excluded.score,
          elapsed_ms = excluded.elapsed_ms,
          history = excluded.history,
          updated_at = excluded.updated_at
        WHERE excluded.score > daily_scores.score`,
  )
    .bind(
      submission.date,
      auth.row.id,
      submission.score,
      submission.elapsedMs,
      submission.history,
      now,
      now,
    )
    .run();

  return json(200, await boardFor(env.DB, submission.date, auth.row.id));
}

async function read(request, env, deps, now) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!DATE_KEY.test(date ?? '')) return json(400, { error: 'invalid_date' });
  // Reading a board is public — the entries on it are already public — so an
  // unauthenticated caller gets the top N and no "you" row, rather than a 401.
  // A caller that offers no credential is never put through the credential
  // check: that check is the expensive, guessable one, and running it for
  // everybody would make this route a cheaper guessing oracle than the
  // profile's own read.
  if (request.headers.get('Authorization') === null) {
    return json(200, await boardFor(env.DB, date, null));
  }
  if (
    rateLimited(callerKey(request, 'lb-read-signed'), deps.rateLimitStore, now, RATE_LIMITS['read-signed'])
  ) {
    return json(429, { error: 'rate_limited' });
  }
  const auth = await deps.authenticate(request, env.DB);
  const playerId = auth.error ? null : auth.row.id;
  return json(200, await boardFor(env.DB, date, playerId));
}

async function withdraw(request, env, deps) {
  const auth = await deps.authenticate(request, env.DB);
  if (auth.error) return auth.error;
  // Every date, not just today's: this is the "take me off the leaderboard"
  // path, and leaving last week's entry up would not be taking them off it.
  await env.DB.prepare('DELETE FROM daily_scores WHERE player_id = ?').bind(auth.row.id).run();
  return json(200, { status: 'withdrawn' });
}

/**
 * The `/api/leaderboard/*` router. `deps.authenticate` is the profile's own
 * bearer-code check, injected rather than imported so this module never has
 * its own idea of who a player is.
 */
export async function handleLeaderboard(request, env, deps) {
  const now = (deps.now ?? (() => Date.now()))();
  const resolved = { ...deps, rateLimitStore: deps.rateLimitStore ?? defaultRateLimitStore };

  if (isCrossSite(request)) return json(403, { error: 'cross_site' });
  if (!env.DB) return json(503, { error: 'not_configured' });

  const { pathname } = new URL(request.url);
  if (pathname !== '/api/leaderboard/daily') return json(404, { error: 'not_found' });

  const route =
    request.method === 'POST'
      ? { name: 'submit', handler: submit }
      : request.method === 'GET'
        ? { name: 'read', handler: read }
        : request.method === 'DELETE'
          ? { name: 'withdraw', handler: withdraw }
          : null;
  if (route === null) return json(405, { error: 'method_not_allowed' });

  // Before the handler, so a caller with no valid code is metered too.
  if (
    rateLimited(
      callerKey(request, `lb-${route.name}`),
      resolved.rateLimitStore,
      now,
      RATE_LIMITS[route.name],
    )
  ) {
    return json(429, { error: 'rate_limited' });
  }
  return route.handler(request, env, resolved, now);
}
