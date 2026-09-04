// Server-side player profile (issue #138).
//
// The profile (#69) lived only in `localStorage`, so a reinstall erased the
// player and nothing could say that two devices were the same person. A
// leaderboard entry (#70) needs an owner that outlives a device, so this is
// the identity layer underneath it — see
// docs/decisions/0021-profile-sync-own-backend.md for why it is our own
// Cloudflare Worker + D1 rather than Game Center / Play Games.
//
// Shape of the thing:
//
//   * Sync is opt-in. The game is unchanged offline — the local profile stays
//     the source of truth on the device, and syncing copies it up and merges
//     what comes back. Nothing here is on the path to playing a level.
//   * There is no account and no password. Registering mints a random
//     recovery code; the server stores only its SHA-256, exactly like a
//     password hash, and the code is the sole credential. Losing it loses the
//     profile, which is the honest trade for "no sign-up".
//   * Merges never regress: counters take the max, cleared levels take the
//     union, and the Daily streak follows whichever side played most recently
//     (with the max when the two are within a day of each other, so a fresh
//     install that plays today cannot truncate a long streak).
//   * The public identity is `name` + `playerId`. Names are screened but not
//     unique — a casual game that refuses "Alex" because someone took it is a
//     worse game — so the id is what disambiguates two players with the same
//     name on a board (`Alex #7K3MQ2R9WD`).
//
// Routes (all JSON, all rejecting a cross-site browser caller):
//
//   POST /api/profile/register  {name, avatar, record}  -> {playerId, code, profile}
//   POST /api/profile/sync      {avatar, record}        -> {profile}      (Bearer code)
//   POST /api/profile/name      {name}                  -> {profile}      (Bearer code)
//   GET  /api/profile                                   -> {profile}      (Bearer code)
//
// `authenticate` is exported for the leaderboard routes (issue #70), which
// hang off the same bearer code.

import { callerKey, isCrossSite, json, playerKey, rateLimitedShared } from './http.mjs';

const MAX_BODY_BYTES = 16 * 1024;
/** Mirrors ui/src/profile.ts NAME_MAX_LENGTH — the client clamps, the server
 *  is the backstop for a caller that is not the client. */
const NAME_MAX_LENGTH = 20;
const DEFAULT_NAME = 'Player';
/** The server does not mirror the ladder's length: it stores whatever level
 *  ids the client claims and only bounds them, so shipping level 151 needs no
 *  deploy here. The bounds exist to stop a caller stuffing the row, not to
 *  police game rules. */
const MAX_LEVEL_ID = 1000;
const MAX_CLEARED_ENTRIES = 1000;
/** A counter no honest client can exceed (a level pays well under 10^6, and
 *  10^12 is past any plausible lifetime total) — past it the value is junk. */
const MAX_COUNTER = 1e12;

/**
 * Per-route limits, all keyed by address and all applied *before* the code is
 * checked. Limiting after authentication would be no limit at all on the
 * thing worth limiting: a request with a wrong code never reaches a
 * post-auth check, so an attacker could spend an unbounded number of SHA-256
 * hashes and indexed row reads — billed to this account — for free. 120 bits
 * is not guessable either way; this is about the meter, not the lock.
 *
 * The numbers are set by how often a *player* does each thing: registering
 * and restoring happen once per device, syncing happens per win.
 *
 * Each number is enforced twice (issue #186): once per calling address before
 * the code is checked, and once per player after it is — the same allowance
 * from either side, so a player cannot exceed it by changing address and an
 * address cannot exceed it by rotating codes. Both counts live in D1, not in
 * one isolate's memory (decision 0029).
 */
const RATE_LIMITS = {
  register: { max: 5, windowMs: 60 * 60 * 1000 },
  read: { max: 10, windowMs: 10 * 60 * 1000 },
  sync: { max: 60, windowMs: 10 * 60 * 1000 },
  name: { max: 20, windowMs: 10 * 60 * 1000 },
};

// --- recovery codes ----------------------------------------------------------

/** Crockford base32: no I, L, O or U, so a code read off a screen and typed
 *  back cannot be ambiguous (and never spells the obvious four-letter words). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 24 symbols ≈ 120 bits. Guessing one is not a threat model; this is only
 *  short enough to be written on paper. */
const CODE_LENGTH = 24;
/** 10 symbols ≈ 50 bits — the public tag next to a display name. Random
 *  rather than sequential so the id leaks no signup order or player count. */
const PLAYER_ID_LENGTH = 10;

/** `bytes` mapped onto the alphabet. Each byte contributes one symbol via
 *  `% 32`; 256 is a multiple of 32, so the mapping stays uniform. */
function encodeSymbols(bytes) {
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function randomSymbols(length, randomBytes) {
  return encodeSymbols(randomBytes(length));
}

function defaultRandomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A code as the player sees it: groups of four, so it can be read aloud and
 *  copied without losing your place. */
export function formatCode(code) {
  return (code.match(/.{1,4}/g) ?? []).join('-');
}

/** A typed-back code as the server compares it: upper-cased, separators
 *  dropped, and the Crockford substitutions applied (I/L → 1, O → 0) so a
 *  player who transcribed a 1 as an l still gets in. Returns null when what is
 *  left is not a code. */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function generateCode(randomBytes = defaultRandomBytes) {
  return randomSymbols(CODE_LENGTH, randomBytes);
}

export function generatePlayerId(randomBytes = defaultRandomBytes) {
  return randomSymbols(PLAYER_ID_LENGTH, randomBytes);
}

/** SHA-256 of the code, hex. The plaintext code exists in a request body and
 *  in the player's own storage — never in the database. */
export async function hashCode(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// --- names -------------------------------------------------------------------

/** Same rule as ui/src/profile.ts `sanitizeName`: one line, trimmed, clamped.
 *  Anything that trims to nothing becomes the default rather than an empty
 *  public identity. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LENGTH).trim();
  return name === '' ? DEFAULT_NAME : name;
}

/** A first-pass screen, not a moderation system: the name is about to be
 *  shown to strangers on a leaderboard, and shipping *no* filter is worse
 *  than shipping a short one. Comparison happens on a folded form, so
 *  `f_u_c_k`, `sshhiitt` and `s h 1 t` do not walk straight through.
 *
 *  Deliberately small and deliberately substring-based: it will have false
 *  positives ("Scunthorpe"), and the client's response to a rejection is
 *  "pick another name", which is recoverable. A report-and-rename path for
 *  what slips through belongs with the leaderboard UI (#70). */
const BLOCKED = [
  'anal',
  'anus',
  'bastard',
  'bitch',
  'chink',
  'cock',
  'coon',
  'cunt',
  'dick',
  'dyke',
  'fag',
  'fuck',
  'jizz',
  'kike',
  'nigg',
  'niger',
  'paki',
  'penis',
  'porn',
  'pussy',
  'rape',
  'retard',
  'semen',
  'shit',
  'slut',
  'spic',
  'tits',
  'twat',
  'vagina',
  'whore',
];

/** Lower-cased, leet-folded, stripped to letters — `x_X_s_h_1_t_X_x` and
 *  `SH!T` fold to the same thing. Runs are *not* collapsed here: see
 *  `dedupRuns`. */
export function foldName(name) {
  return name
    .toLowerCase()
    .replace(/[4@]/g, 'a')
    .replace(/[3€]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^a-z]/g, '');
}

/** Repeated letters collapsed, so `sshhiitt` reads as `shit`. Applied to the
 *  name only, never to the blocklist: collapsing both would turn `coon` into
 *  the needle `con` and refuse Falcon, Connie and Constance. */
export function dedupRuns(folded) {
  return folded.replace(/(.)\1+/g, '$1');
}

/** Whether a sanitized name may be shown publicly. Both the folded name and
 *  its run-collapsed form are checked against the blocklist as written. */
export function nameAllowed(name) {
  const folded = foldName(name);
  const collapsed = dedupRuns(folded);
  return !BLOCKED.some((word) => folded.includes(word) || collapsed.includes(word));
}

// --- the record --------------------------------------------------------------

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Date keys are plain
 *  calendar days with no zone, so UTC arithmetic on them is exact — the same
 *  reason core's `daysBetween` is DST-immune. */
function daysBetween(from, to) {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / day);
}

function counter(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNTER
    ? value
    : 0;
}

export const EMPTY_RECORD = {
  levelsCleared: 0,
  weekScore: 0,
  weekStart: null,
  cleared: [],
  dailyStreak: 0,
  lastDaily: null,
  trophies: 0,
};

/**
 * A client-supplied record, sanitized field by field — the same tolerance
 * `parsePlayerRecord` applies on the device, for the same reason: a record
 * from an older build must sync, not 400. Returns null only when the value is
 * not an object at all.
 */
export function validateRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cleared = new Set();
  if (Array.isArray(raw.cleared)) {
    for (const v of raw.cleared.slice(0, MAX_CLEARED_ENTRIES)) {
      if (Number.isInteger(v) && v >= 1 && v <= MAX_LEVEL_ID) cleared.add(v);
    }
  }
  const lastDaily =
    typeof raw.lastDaily === 'string' && DATE_KEY.test(raw.lastDaily) ? raw.lastDaily : null;
  // A week score is only meaningful next to the week it was earned in (issue
  // #176). Without one it is not a score but a number of unknown age, which is
  // also what keeps a pre-#176 record's lifetime total off the first board.
  const weekStart =
    typeof raw.weekStart === 'string' && DATE_KEY.test(raw.weekStart) ? raw.weekStart : null;
  return {
    levelsCleared: counter(raw.levelsCleared),
    weekScore: weekStart === null ? 0 : counter(raw.weekScore),
    weekStart,
    cleared: Array.from(cleared).sort((a, b) => a - b),
    dailyStreak: lastDaily === null ? 0 : counter(raw.dailyStreak),
    lastDaily,
    trophies: counter(raw.trophies),
  };
}

/**
 * Merge two records without losing progress (#138: "take max, never regress").
 *
 * Counters and the cleared set are monotonic, so max and union are exactly
 * right. The streak is not — it is a count anchored to `lastDaily`, and the
 * larger number can be the stale one. So the side that played most recently
 * wins the anchor, and its streak is taken *unless* the two anchors are
 * within a day of each other, in which case the larger streak is the live one
 * (a reinstalled device that clears today's Daily reports streak 1; the
 * server's 30-day streak ending yesterday is the truth, continued).
 */
export function mergeRecords(a, b) {
  const streak = (() => {
    if (a.lastDaily === null) return { dailyStreak: b.dailyStreak, lastDaily: b.lastDaily };
    if (b.lastDaily === null) return { dailyStreak: a.dailyStreak, lastDaily: a.lastDaily };
    const gap = Math.abs(daysBetween(a.lastDaily, b.lastDaily));
    const later = a.lastDaily >= b.lastDaily ? a : b;
    return {
      dailyStreak: gap <= 1 ? Math.max(a.dailyStreak, b.dailyStreak) : later.dailyStreak,
      lastDaily: later.lastDaily,
    };
  })();
  // The week score is the one field here that can legitimately go *down*, so
  // it is the one field "take max" would break (issue #176). Taking the larger
  // of two weeks' scores would resurrect last week's total at the rollover and
  // then keep winning every merge after it, so the reset could never stick.
  // The later week wins outright; only within one shared week is the larger
  // score the better record of what was earned.
  const week = (() => {
    if (a.weekStart === b.weekStart) {
      // The larger score, not a sum: sync runs repeatedly, so summing two
      // already-merged records would double the total every time. Without a
      // per-run identity to deduplicate on, summing is unsafe in a way
      // under-counting is not. `weekly_scores` is the authoritative standing
      // and accumulates each submission independently.
      return { weekScore: Math.max(a.weekScore, b.weekScore), weekStart: a.weekStart };
    }
    if (a.weekStart === null) return { weekScore: b.weekScore, weekStart: b.weekStart };
    if (b.weekStart === null) return { weekScore: a.weekScore, weekStart: a.weekStart };
    return a.weekStart > b.weekStart
      ? { weekScore: a.weekScore, weekStart: a.weekStart }
      : { weekScore: b.weekScore, weekStart: b.weekStart };
  })();
  return {
    levelsCleared: Math.max(a.levelsCleared, b.levelsCleared),
    ...week,
    cleared: Array.from(new Set([...a.cleared, ...b.cleared])).sort((x, y) => x - y),
    ...streak,
    trophies: Math.max(a.trophies, b.trophies),
  };
}

// --- storage -----------------------------------------------------------------

const AVATAR_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The avatar list lives in ui/src/profile.ts; the server stores the id
 *  opaquely (a build that adds an avatar must not need a Worker deploy) and
 *  only checks that it is a plausible id. An id this server has never heard
 *  of still renders — `avatarGlyph` falls back on the device. */
function validateAvatar(raw) {
  return typeof raw === 'string' && AVATAR_ID.test(raw) ? raw : null;
}

function rowToProfile(row) {
  return {
    playerId: row.id,
    name: row.name,
    avatar: row.avatar,
    record: {
      levelsCleared: row.levels_cleared,
      // Zeroed without a week, exactly as validateRecord and the client's
      // parsePlayerRecord do. Nothing writes that combination today; this is
      // the one place the invariant would otherwise not be enforced.
      weekScore: row.week_start ? (row.week_score ?? 0) : 0,
      weekStart: row.week_start ?? null,
      cleared: JSON.parse(row.cleared),
      dailyStreak: row.daily_streak,
      lastDaily: row.last_daily,
      trophies: row.trophies,
    },
  };
}

async function findByCodeHash(db, codeHash) {
  return await db.prepare('SELECT * FROM players WHERE code_hash = ?').bind(codeHash).first();
}

// --- routes ------------------------------------------------------------------

/** Reads and parses the body under a hard cap. Returns the parsed value, or a
 *  Response to send back instead. */
async function readBody(request) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return { error: json(413, { error: 'payload_too_large' }) };
  }
  // Without a trustworthy Content-Length the body is read before it is
  // measured; the platform's own request-size ceiling bounds that read, the
  // same way it does for the feedback route.
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

/** The authenticated player, or a Response explaining why there isn't one.
 *  Exported because the leaderboard (issue #70) has to answer the same
 *  question and must not grow a second idea of who a player is. */
export async function authenticate(request, db) {
  const header = request.headers.get('Authorization') ?? '';
  const code = normalizeCode(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (code === null) return { error: json(401, { error: 'unauthorized' }) };
  const row = await findByCodeHash(db, await hashCode(code));
  // Same 401 for a well-formed code that matches nothing: the endpoint must
  // not confirm which codes exist.
  if (!row) return { error: json(401, { error: 'unauthorized' }) };
  return { row };
}

/** The post-auth half of the limiter (issue #186): the player's own bucket for
 *  `scope`, with the same allowance as the address bucket the router already
 *  checked. `null` when within it; the 429 to return when not. */
async function playerLimited(db, scope, playerId, now, limit) {
  if (await rateLimitedShared(db, playerKey(scope, playerId), now, limit)) {
    return json(429, { error: 'rate_limited' });
  }
  return null;
}

async function register(request, env, deps, now) {
  const body = await readBody(request);
  if (body.error) return body.error;
  const payload = body.value;
  if (payload === null || typeof payload !== 'object') return json(400, { error: 'invalid_payload' });

  const name = sanitizeName(payload.name ?? DEFAULT_NAME);
  if (name === null) return json(400, { error: 'invalid_payload' });
  if (!nameAllowed(name)) return json(422, { error: 'name_rejected' });
  const avatar = validateAvatar(payload.avatar);
  if (avatar === null) return json(400, { error: 'invalid_payload' });
  const record = validateRecord(payload.record ?? EMPTY_RECORD);
  if (record === null) return json(400, { error: 'invalid_payload' });

  // The id and the code are both random, and both UNIQUE in the schema. A
  // collision is not a realistic event (2^50 and 2^120), but the failure mode
  // if one ever happened is a 500 on someone's first launch — so draw again
  // instead. Anything still failing after three draws is not a collision.
  let playerId = null;
  let code = null;
  for (let attempt = 0; attempt < 3 && playerId === null; attempt += 1) {
    const candidateId = generatePlayerId(deps.randomBytes);
    const candidateCode = generateCode(deps.randomBytes);
    try {
      await env.DB.prepare(
        `INSERT INTO players
           (id, code_hash, name, avatar, levels_cleared, week_score, week_start,
            cleared, daily_streak, last_daily, trophies, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          candidateId,
          await hashCode(candidateCode),
          name,
          avatar,
          record.levelsCleared,
          record.weekScore,
          record.weekStart,
          JSON.stringify(record.cleared),
          record.dailyStreak,
          record.lastDaily,
          record.trophies,
          now,
          now,
        )
        .run();
      playerId = candidateId;
      code = candidateCode;
    } catch {
      // Never surface the database's own message: it would say which column
      // collided, and one of them is the credential.
    }
  }
  if (playerId === null) return json(503, { error: 'register_failed' });

  return json(201, {
    playerId,
    // The only time the plaintext code is ever sent: the client stores it and
    // shows it to the player as the one way back to this profile.
    code: formatCode(code),
    profile: { playerId, name, avatar, record },
  });
}

async function sync(request, env, deps, now, limit) {
  const auth = await authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'sync', auth.row.id, now, limit);
  if (limited) return limited;
  const body = await readBody(request);
  if (body.error) return body.error;
  const payload = body.value;
  if (payload === null || typeof payload !== 'object') return json(400, { error: 'invalid_payload' });

  const clientRecord = validateRecord(payload.record);
  if (clientRecord === null) return json(400, { error: 'invalid_payload' });
  // The avatar is the player's latest pick and simply wins; the name does not
  // ride this route (it is screened, and a rejection must reach the player
  // rather than fail a background sync) — /api/profile/name owns it.
  const avatar = payload.avatar === undefined ? auth.row.avatar : validateAvatar(payload.avatar);
  if (avatar === null) return json(400, { error: 'invalid_payload' });

  const merged = mergeRecords(rowToProfile(auth.row).record, clientRecord);
  await env.DB.prepare(
    `UPDATE players
        SET avatar = ?, levels_cleared = ?, week_score = ?, week_start = ?,
            cleared = ?, daily_streak = ?, last_daily = ?, trophies = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      avatar,
      merged.levelsCleared,
      merged.weekScore,
      merged.weekStart,
      JSON.stringify(merged.cleared),
      merged.dailyStreak,
      merged.lastDaily,
      merged.trophies,
      now,
      auth.row.id,
    )
    .run();

  return json(200, {
    profile: { playerId: auth.row.id, name: auth.row.name, avatar, record: merged },
  });
}

async function rename(request, env, deps, now, limit) {
  const auth = await authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'name', auth.row.id, now, limit);
  if (limited) return limited;
  const body = await readBody(request);
  if (body.error) return body.error;
  const payload = body.value;
  if (payload === null || typeof payload !== 'object') return json(400, { error: 'invalid_payload' });

  const name = sanitizeName(payload.name);
  if (name === null) return json(400, { error: 'invalid_payload' });
  if (!nameAllowed(name)) return json(422, { error: 'name_rejected' });

  await env.DB.prepare('UPDATE players SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, now, auth.row.id)
    .run();
  return json(200, { profile: { ...rowToProfile(auth.row), name } });
}

async function read(request, env, deps, now, limit) {
  const auth = await authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'read', auth.row.id, now, limit);
  if (limited) return limited;
  return json(200, { profile: rowToProfile(auth.row) });
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A registration that never synced afterwards is a profile nobody uses: an
 *  abandoned first launch, or a throwaway. A month is long enough for a real
 *  player's first sync. */
export const UNSYNCED_PLAYER_TTL_MS = 30 * DAY_MS;
/** A profile that has synced before, but not for this long, is idle. Six
 *  months: a player returning after a summer away still finds their profile. */
export const IDLE_PLAYER_TTL_MS = 180 * DAY_MS;

/**
 * Issue #188: `register` inserts a row per call and nothing ever removed one.
 * Every write to a player's row sets `updated_at` (sync, rename), so a row
 * whose `updated_at` still equals its `created_at` never synced, and one whose
 * `updated_at` is old enough has gone idle. Either goes — unless the player
 * has a standing on any week's board, whose name and avatar are read off this
 * row; that player stays however idle. A run row without a standing cannot
 * exist (submit writes both, withdraw deletes both), but the `REFERENCES`
 * clause would fail the whole sweep if one did, so it is checked too. Runs
 * from the daily cron in worker/index.mjs; exported for the test.
 */
export async function reapPlayers(db, now) {
  await db
    .prepare(
      `DELETE FROM players
        WHERE ((updated_at = created_at AND created_at < ?) OR updated_at < ?)
          AND NOT EXISTS (SELECT 1 FROM weekly_scores      WHERE player_id = players.id)
          AND NOT EXISTS (SELECT 1 FROM weekly_submissions WHERE player_id = players.id)`,
    )
    .bind(now - UNSYNCED_PLAYER_TTL_MS, now - IDLE_PLAYER_TTL_MS)
    .run();
}

/**
 * The `/api/profile*` router. Everything reachable from the outside world
 * (the clock, randomness) arrives through `deps` so tests are deterministic;
 * the database — rows and the rate limiter's counts alike — arrives as
 * `env.DB`, D1's binding.
 */
export async function handleProfile(request, env, deps = {}) {
  const now = (deps.now ?? (() => Date.now()))();
  const resolved = { randomBytes: deps.randomBytes ?? defaultRandomBytes };

  if (isCrossSite(request)) return json(403, { error: 'cross_site' });
  if (!env.DB) return json(503, { error: 'not_configured' });

  const { pathname } = new URL(request.url);
  const post = request.method === 'POST';
  const route =
    pathname === '/api/profile/register'
      ? { name: 'register', handler: register, allowed: post }
      : pathname === '/api/profile/sync'
        ? { name: 'sync', handler: sync, allowed: post }
        : pathname === '/api/profile/name'
          ? { name: 'name', handler: rename, allowed: post }
          : pathname === '/api/profile'
            ? { name: 'read', handler: read, allowed: request.method === 'GET' }
            : null;
  if (route === null) return json(404, { error: 'not_found' });
  if (!route.allowed) return json(405, { error: 'method_not_allowed' });

  // The address bucket, before the handler — and so before any code is
  // checked or any row is read. The handler checks the player bucket once it
  // knows who the player is (issue #186).
  const limit = RATE_LIMITS[route.name];
  if (await rateLimitedShared(env.DB, callerKey(request, route.name), now, limit)) {
    return json(429, { error: 'rate_limited' });
  }
  return route.handler(request, env, resolved, now, limit);
}
