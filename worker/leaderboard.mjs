// The weekly leaderboard (issue #176, superseding the Daily board of #70).
//
// One board, and it ranks the ladder. Every ladder clear adds its final score
// to the player's standing for the current week; the Daily Challenge pays
// trophies and a streak and contributes nothing here. The week starts Sunday
// 00:00 UTC on this server's clock and only the live week is browsable — there
// is no archive and no per-date board, so there is nothing to address by date
// and no date to accept from a client.
//
// **The week comes from the server, never the request** (PM, 2026-09-03). The
// Daily board took a date key from the client and needed skew and age guards
// to keep it honest; a client-supplied week would be worse, splitting one
// board into overlapping buckets across the ~27 hours of local boundaries. So
// no route here reads a week from the caller: `weekStartKey(now)` is the only
// source, which also deletes a whole class of validation.
//
// Two tables, because the standing accumulates:
//
//   * `weekly_scores` — one row per (week, player), score summed over the
//     week. This is what is ranked.
//   * `weekly_submissions` — one row per run, with the move history it was
//     verified from (issue #176 kept it from day one so that the first weeks
//     could be checked once the verifier existed; issue #187 is that verifier).
//
// Identity comes from issue #138: an entry belongs to a `players` row, and the
// name shown on the board is the screened, server-held one, never a name the
// submitting client supplies.
//
// **Scores are verified by replay** (issue #187, decision 0030). A submission
// names the deal it played — `(layoutId, seed)`, which must be a ladder level
// — and the moves it made. The server regenerates the deal with core's own
// generator, plays the moves through core's own move stack (worker/replay.mjs),
// and the score it stores is the one that replay earns. The client's `score`
// is a cross-check: a run that does not regenerate, does not replay legally,
// does not clear the board, or does not arrive at the claimed score is refused
// as 422 `run_rejected` and never touches the standing.
//
// What replay does *not* prove is who was at the keyboard, or that the
// timestamps were honest: the moves' clock is the client's. The elapsed-time
// floor below and the per-week run cap stay for that reason, and the token
// still only proves who is posting. The bound on a single run's score is now a
// cheap pre-check ahead of the replay, not the thing standing between a
// fabricated score and the board.

import { MAX_RUN_SCORE } from '../core/dist/src/index.js';
import {
  callerKey,
  createRateLimitStore,
  isCrossSite,
  json,
  playerKey,
  rateLimited,
  rateLimitedShared,
} from './http.mjs';
import { verifyRun } from './replay.mjs';

/**
 * The most a single run can pay: core's own figure — a flawless 144-tile
 * board on the highest band multiplier (`100 + 120 + 150 + 200 + 68 × 300`,
 * times ×2.5). Imported rather than restated since the Worker started
 * building against core (issue #187), so it cannot drift.
 *
 * It bounds **each score being added**, not the standing it accumulates into —
 * a week of good runs is supposed to exceed it. Since the replay recomputes the
 * score anyway this is a pre-check that refuses the absurd before paying for a
 * regeneration, and the ceiling the `ON CONFLICT` clause below is derived from.
 */
export { MAX_RUN_SCORE };

/**
 * How many runs one player may bank into a single week, and the score ceiling
 * that follows from it.
 *
 * This is score integrity, not politeness, and it is enforced in the database
 * rather than by the rate limiter. Under the Daily board's `max()` semantics
 * `MAX_RUN_SCORE` was an *absolute* ceiling on any standing, so the limiter was
 * pure defence in depth. Accumulation removes that ceiling: every accepted
 * submit adds permanently, so without a cap here the only bound on a standing
 * is `RATE_LIMITS.submit` — an IP-keyed, best-effort, per-isolate Map that
 * Cloudflare recycles across colos, and that anyone can sidestep by rotating
 * addresses. That would put the worst case around a billion points against an
 * honest week of 10^5-10^6, which is not the bounded risk decision 0022
 * accepted.
 *
 * 300 clears a week is ~43 a day, far above honest play and still a number a
 * moderator can reason about. The score ceiling is derived from it rather than
 * chosen separately, so the two can never disagree.
 */
export const MAX_RUNS_PER_WEEK = 300;
export const MAX_WEEK_SCORE = MAX_RUN_SCORE * MAX_RUNS_PER_WEEK;

/**
 * `elapsedMs` is clamped, not rejected, at the top end.
 *
 * A ladder level has no time limit and `elapsedMs` survives a resume, so a
 * player who leaves a level open overnight legitimately arrives with more than
 * a day on the clock. The Daily board could reject that — its deals were
 * locked to a date — but rejecting a ladder run would silently drop it: the
 * submit is fire-and-forget, so the profile would count the score and the
 * board would not, and the two would disagree with nothing on screen to say
 * why. The field is not even shown on the board any more, so clamping loses
 * nothing that is read.
 */
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;
/** A 144-tile board is 72 pairs. Under this a run is not a fast player, it is
 *  a fabricated one — 72 matches in 20 seconds is 3.6 a second sustained. The
 *  replay (issue #187) proves the moves were legal on that deal, not that a
 *  person made them at that pace: the timestamps are the client's. So this
 *  brake stays. */
const MIN_ELAPSED_MS = 20_000;
/** The move history is what gets replayed (issue #187) and what the row keeps.
 *  A full 72-pair game with holds is a few KB; the cap keeps a row from being
 *  abused as storage and bounds what the replay is asked to walk. Measured in
 *  UTF-16 units rather than bytes — the real byte ceiling is `MAX_BODY_BYTES`,
 *  checked on the request itself before anything is parsed. */
const MAX_HISTORY_CHARS = 64 * 1024;
const MAX_BODY_BYTES = 96 * 1024;

/** How many entries the board shows, and how many either side of the player. */
export const BOARD_TOP = 10;
export const BOARD_NEIGHBOURS = 3;

const RATE_LIMITS = {
  submit: { max: 20, windowMs: 10 * 60 * 1000 },
  // Reading is public and cheap, but an authenticated read is a credential
  // check, and this must not be a roomier door to that check than the
  // profile's own read. So the *signed* reads get their own bucket, matching
  // that route's 10 / 10 min rather than sitting inside the roomier public
  // one; an anonymous read never touches a code at all.
  read: { max: 60, windowMs: 10 * 60 * 1000 },
  'read-signed': { max: 10, windowMs: 10 * 60 * 1000 },
  withdraw: { max: 10, windowMs: 10 * 60 * 1000 },
};

/** For the anonymous board read only (issue #186): public data, no credential,
 *  and a database write per read would double the cost of the cheapest route.
 *  Every other route is metered in D1 by `rateLimitedShared`. Falls back to a
 *  per-isolate store, exactly like before: the entry point injects nothing,
 *  and a limiter that is only wired up in tests is not a limiter. */
const defaultRateLimitStore = createRateLimitStore();

/** The post-auth half of the limiter (issue #186): the player's own bucket for
 *  `scope`, with the same allowance as the address bucket the router already
 *  checked. `null` when within it; the 429 to return when not. */
async function playerLimited(db, scope, playerId, now, limit) {
  if (await rateLimitedShared(db, playerKey(scope, playerId), now, limit)) {
    return json(429, { error: 'rate_limited' });
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** The instant the week containing `now` opened: Sunday 00:00:00.000 UTC.
 *  Mirrors core's `weekStartMs`; the client computes the same boundary so an
 *  offline player still has a week to score into, but this copy is the one
 *  that decides what gets stored. */
export function weekStartMs(now) {
  const at = new Date(now);
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  // getUTCDay: 0 is Sunday, so this is already "days since the week opened".
  return midnight - at.getUTCDay() * DAY_MS;
}

/** `YYYY-MM-DD` of the Sunday that opens the current week. */
export function weekStartKey(now) {
  return new Date(weekStartMs(now)).toISOString().slice(0, 10);
}

/** When the board resets. Sent with every board so the client can run the
 *  countdown off the server's boundary rather than its own idea of the week. */
export function weekResetAt(now) {
  return weekStartMs(now) + WEEK_MS;
}

function integerInRange(value, max, min = 0) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * A submission, bounded field by field. Returns the values to store — plus
 * `run`, the parsed history for the replay to verify — or a string naming what
 * was wrong. Shape only: whether the history *replays* is `verifyRun`'s call,
 * made by the route after the credential and the cheap bounds have passed.
 *
 * No date and no week: the server decides which week a run lands in, from the
 * moment it arrives. A run posted seconds before the rollover counts for the
 * week that was live when it arrived, which is the only rule that does not
 * need the client's clock to be honest.
 */
export function validateSubmission(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 'invalid';
  if (!integerInRange(payload.score, MAX_RUN_SCORE)) return 'bad_score';
  // The floor stays a rejection: it is an integrity signal, not a display
  // value — a run under it did not happen. The ceiling is only a sanity bound.
  if (
    typeof payload.elapsedMs !== 'number' ||
    !Number.isInteger(payload.elapsedMs) ||
    payload.elapsedMs < MIN_ELAPSED_MS
  ) {
    return 'invalid';
  }
  const elapsedMs = Math.min(payload.elapsedMs, MAX_ELAPSED_MS);
  // Required since issue #187: without a history there is nothing to verify,
  // and an unverified run is not a run. Its absence is not refused here but
  // by `verifyRun`, as 422 `history_missing` — a client of the previous build
  // posting without one gets the reason, not a bare 400.
  const run = payload.history === undefined ? null : payload.history;
  let history = null;
  if (run !== null) {
    try {
      history = JSON.stringify(run);
    } catch {
      // V8's stringify recurses, so a deeply nested body throws RangeError
      // before the length check below ever runs. Nothing above this catches it,
      // so without this the route answers a platform exception instead of a
      // 400 for what is simply a bad payload.
      return 'invalid';
    }
    if (history.length > MAX_HISTORY_CHARS) return 'invalid';
  }
  return { score: payload.score, elapsedMs, history, run };
}

// --- queries -----------------------------------------------------------------

/** Board order: higher score first, and among equal scores the one that got
 *  there first. Ties are common, so the tie-break has to be stable and has to
 *  reward the earlier standing rather than the later one. */
const ORDER = 'ORDER BY s.score DESC, s.updated_at ASC, s.player_id ASC';

const ENTRY_COLUMNS = `s.player_id AS playerId, p.name AS name, p.avatar AS avatar,
                       s.score AS score, s.runs AS runs, s.updated_at AS at`;

function toEntry(row, rank) {
  return {
    rank,
    playerId: row.playerId,
    name: row.name,
    avatar: row.avatar,
    score: row.score,
    runs: row.runs,
  };
}

async function topEntries(db, week) {
  const { results } = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM weekly_scores s JOIN players p ON p.id = s.player_id
        WHERE s.week_start = ? ${ORDER} LIMIT ?`,
    )
    .bind(week, BOARD_TOP)
    .all();
  return (results ?? []).map((row, i) => toEntry(row, i + 1));
}

/** One player's own standing, or null when they have not scored this week. */
async function ownRow(db, week, playerId) {
  return await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM weekly_scores s JOIN players p ON p.id = s.player_id
        WHERE s.week_start = ? AND s.player_id = ?`,
    )
    .bind(week, playerId)
    .first();
}

/** Where a standing sits on the board: one more than the number of rows that
 *  beat it, under exactly the ordering `ORDER` applies. */
async function rankOf(db, week, row) {
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS ahead FROM weekly_scores
        WHERE week_start = ?
          AND (score > ?
               OR (score = ? AND updated_at < ?)
               OR (score = ? AND updated_at = ? AND player_id < ?))`,
    )
    .bind(week, row.score, row.score, row.at, row.score, row.at, row.playerId)
    .first();
  return (result?.ahead ?? 0) + 1;
}

/** The entries immediately above and below a player — "own rank and nearby
 *  entries visible, not just the top N". */
async function neighbours(db, week, row, rank) {
  const above = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM weekly_scores s JOIN players p ON p.id = s.player_id
        WHERE s.week_start = ?
          AND (s.score > ?
               OR (s.score = ? AND s.updated_at < ?)
               OR (s.score = ? AND s.updated_at = ? AND s.player_id < ?))
        ORDER BY s.score ASC, s.updated_at DESC, s.player_id DESC LIMIT ?`,
    )
    .bind(week, row.score, row.score, row.at, row.score, row.at, row.playerId, BOARD_NEIGHBOURS)
    .all();
  const below = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM weekly_scores s JOIN players p ON p.id = s.player_id
        WHERE s.week_start = ?
          AND (s.score < ?
               OR (s.score = ? AND s.updated_at > ?)
               OR (s.score = ? AND s.updated_at = ? AND s.player_id > ?))
        ${ORDER} LIMIT ?`,
    )
    .bind(week, row.score, row.score, row.at, row.score, row.at, row.playerId, BOARD_NEIGHBOURS)
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

/**
 * The whole board as the client renders it: the top N, where this player sits
 * and who is around them, and when the week ends.
 *
 * `resetsAt` is always present, even on an empty board — it is what the panel
 * counts down to, and a board with no entries yet is exactly when a player
 * most wants to know how long is left to get on it.
 */
export async function boardFor(db, week, playerId, now) {
  const resetsAt = weekResetAt(now);
  const top = await topEntries(db, week);
  const empty = { weekStart: week, resetsAt, top, you: null, around: [] };
  if (playerId === null) return empty;
  const row = await ownRow(db, week, playerId);
  if (!row) return empty;
  const rank = await rankOf(db, week, row);
  // Already visible in the top N — repeating those rows underneath it is
  // noise, so only the rank is worth sending.
  const around = rank <= BOARD_TOP ? [] : await neighbours(db, week, row, rank);
  return { weekStart: week, resetsAt, top, you: toEntry(row, rank), around };
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
  const limited = await playerLimited(env.DB, 'lb-submit', auth.row.id, now, RATE_LIMITS.submit);
  if (limited) return limited;
  const body = await readBody(request);
  if (body.error) return body.error;

  const submission = validateSubmission(body.value);
  if (submission === 'bad_score') return json(422, { error: 'score_out_of_range' });
  if (submission === 'invalid') return json(400, { error: 'invalid_payload' });

  // The record is the server's (issue #187): regenerate the deal, replay the
  // moves, and refuse anything that does not come out as claimed. Before the
  // run cap and before any write, so a refused run leaves nothing behind.
  const verdict = verifyRun(submission.run, { score: submission.score });
  if (!verdict.ok) {
    return json(422, {
      error: 'run_rejected',
      reason: verdict.reason,
      ...(verdict.index === undefined ? {} : { index: verdict.index }),
    });
  }
  // The run cannot have ended before its last move. `elapsedMs` was clamped
  // to a day above (an overnight level is legitimate), so a run whose last
  // move is past the clamp compares against the clamp rather than failing.
  if (submission.elapsedMs < Math.min(verdict.lastMs, MAX_ELAPSED_MS)) {
    return json(422, { error: 'run_rejected', reason: 'elapsed_before_last_move' });
  }

  const week = weekStartKey(now);

  // The per-week cap, checked before anything is written (issue #176). It
  // bounds two things the rate limiter cannot: the standing, which now only
  // ever grows, and `weekly_submissions`, whose move history is kept and never
  // pruned (issue #188 is the retention rule). Refusing here rather than after
  // the insert is what keeps a capped player from still filling the table.
  const standing = await env.DB.prepare(
    'SELECT runs FROM weekly_scores WHERE week_start = ? AND player_id = ?',
  )
    .bind(week, auth.row.id)
    .first();
  if ((standing?.runs ?? 0) >= MAX_RUNS_PER_WEEK) {
    return json(429, { error: 'week_run_limit' });
  }

  // The run itself, kept whole with the history it was verified from. Written
  // before the standing moves: a crash between the two leaves a run that is on
  // record but not yet counted, which is recoverable, where the reverse would
  // leave a counted score nobody can ever check. The score stored is the
  // replay's — equal to the claim by now, but the replay is the authority.
  await env.DB.prepare(
    `INSERT INTO weekly_submissions (week_start, player_id, score, elapsed_ms, history, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(week, auth.row.id, verdict.score, submission.elapsedMs, submission.history, now)
    .run();

  // One standing per (week, player), and it *accumulates* — the Daily board's
  // row only ever moved up, because there a resubmission was a replay of the
  // same deal. Here every clear is a different level and all of them count, so
  // the conflict case adds rather than compares.
  //
  // The MIN and the WHERE restate the cap the pre-check above already applied.
  // That is deliberate, not redundant: the check and the write are two round
  // trips, so concurrent submits can both pass the check, and this is the only
  // place the ceiling holds atomically.
  await env.DB.prepare(
    `INSERT INTO weekly_scores (week_start, player_id, score, runs, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (week_start, player_id) DO UPDATE SET
          score = MIN(weekly_scores.score + excluded.score, ?),
          runs = weekly_scores.runs + 1,
          updated_at = excluded.updated_at
        WHERE weekly_scores.runs < ?`,
  )
    .bind(week, auth.row.id, verdict.score, now, now, MAX_WEEK_SCORE, MAX_RUNS_PER_WEEK)
    .run();

  return json(200, await boardFor(env.DB, week, auth.row.id, now));
}

async function read(request, env, deps, now) {
  const week = weekStartKey(now);
  // Reading a board is public — the entries on it are already public — so an
  // unauthenticated caller gets the top N and no "you" row, rather than a 401.
  // A caller that offers no credential is never put through the credential
  // check: that check is the expensive, guessable one, and running it for
  // everybody would make this route a cheaper guessing oracle than the
  // profile's own read.
  if (request.headers.get('Authorization') === null) {
    return json(200, await boardFor(env.DB, week, null, now));
  }
  const signed = RATE_LIMITS['read-signed'];
  if (await rateLimitedShared(env.DB, callerKey(request, 'lb-read-signed'), now, signed)) {
    return json(429, { error: 'rate_limited' });
  }
  const auth = await deps.authenticate(request, env.DB);
  if (!auth.error) {
    const limited = await playerLimited(env.DB, 'lb-read-signed', auth.row.id, now, signed);
    if (limited) return limited;
  }
  const playerId = auth.error ? null : auth.row.id;
  return json(200, await boardFor(env.DB, week, playerId, now));
}

async function withdraw(request, env, deps, now) {
  const auth = await deps.authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'lb-withdraw', auth.row.id, now, RATE_LIMITS.withdraw);
  if (limited) return limited;
  // Every week and every run, not just the live one: this is the "take me off
  // the leaderboard" path, and leaving the submissions behind would keep a
  // record of exactly what the player asked to have removed.
  //
  // `players.week_score` is deliberately *not* cleared. It looks like a
  // survivor of the withdraw, but nothing rebuilds a board row from it — only
  // `submit` writes `weekly_scores`, and that needs a fresh clear with the
  // opt-in back on. It is the player's own profile number, synced to their own
  // row, not a public entry; zeroing it would erase their private score as a
  // side effect of leaving a public board.
  await env.DB.prepare('DELETE FROM weekly_scores WHERE player_id = ?').bind(auth.row.id).run();
  await env.DB.prepare('DELETE FROM weekly_submissions WHERE player_id = ?').bind(auth.row.id).run();
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
  if (pathname !== '/api/leaderboard/weekly') return json(404, { error: 'not_found' });

  const route =
    request.method === 'POST'
      ? { name: 'submit', handler: submit }
      : request.method === 'GET'
        ? { name: 'read', handler: read }
        : request.method === 'DELETE'
          ? { name: 'withdraw', handler: withdraw }
          : null;
  if (route === null) return json(405, { error: 'method_not_allowed' });

  // Before the handler, so a caller with no valid code is metered too. The
  // anonymous read is the one route still on the in-memory limiter (see
  // `defaultRateLimitStore`); a signed read is metered by `read` itself,
  // against the tighter signed bucket, so it is not counted here as well —
  // that would be a D1 write per read that nothing ever refuses on. Every
  // other route counts in D1, and its handler adds the player's own bucket
  // once the code has been checked (issue #186).
  const limit = RATE_LIMITS[route.name];
  const key = callerKey(request, `lb-${route.name}`);
  if (route.name === 'read') {
    if (
      request.headers.get('Authorization') === null &&
      rateLimited(key, resolved.rateLimitStore, now, limit)
    ) {
      return json(429, { error: 'rate_limited' });
    }
  } else if (await rateLimitedShared(env.DB, key, now, limit)) {
    return json(429, { error: 'rate_limited' });
  }
  return route.handler(request, env, resolved, now);
}
