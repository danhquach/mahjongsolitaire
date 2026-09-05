// Pieces every Worker route needs (issue #138 split them out of index.mjs).
//
// The feedback endpoint (issue #118) was the only route, so its JSON helper,
// its same-origin check and its rate limiter lived inline. The profile routes
// need all three with identical semantics, and two copies of a security check
// is how the copies drift — so they live here and both routers import them.

export function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Same-origin check (issue #118 design): reject a request that names itself
 *  cross-site, allow everything else — a direct API client sends neither
 *  header, and these endpoints have no cookie/session to protect from CSRF
 *  (the profile routes authenticate with a bearer code a browser never
 *  attaches on its own), so the check only needs to stop a *browser* on
 *  another origin. */
export function isCrossSite(request) {
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite !== null) return secFetchSite === 'cross-site';
  const origin = request.headers.get('Origin');
  if (origin === null) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

/** Per-isolate best-effort limiter. Since issue #186 it serves exactly one
 *  route — the anonymous weekly-board GET — where the data is public, no
 *  credential is checked, and a database write per read would double the
 *  cost of the cheapest route. Every other route uses `rateLimitedShared`.
 *  Not shared across isolates or deploys: it slows an obvious flood, it is
 *  not a cap. */
export function createRateLimitStore() {
  return new Map();
}

/**
 * Best-effort fixed-window limiter over an in-memory `store` (see
 * `createRateLimitStore`). `store` and `now` are passed in so tests get a
 * fresh, deterministic clock and map.
 */
export function rateLimited(key, store, now, { max, windowMs }) {
  // Opportunistic eviction: a long-lived isolate must not keep one entry per
  // address it ever saw. Expired windows go on every call — the map only ever
  // holds addresses seen within the current window.
  //
  // Each entry is evicted against *its own* window, not the calling route's.
  // One store serves routes with different window lengths, and evicting a
  // 1-hour bucket after 10 minutes because a 10-minute route happened to run
  // would silently hand back the longer route's allowance.
  for (const [k, e] of store) {
    if (now - e.windowStart >= e.windowMs) store.delete(k);
  }
  const entry = store.get(key);
  if (entry === undefined || now - entry.windowStart >= windowMs) {
    store.set(key, { windowStart: now, windowMs, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

/**
 * The shared limiter (issue #186): a fixed window per key in the `rate_limits`
 * table (schema-0005), so every isolate and colo meters the same count.
 *
 * One statement does the whole check. The upsert either opens a window for a
 * new key, resets an expired one, or increments the live one, and hands back
 * the count it settled on — so two isolates hitting the same key at the same
 * instant cannot both read "4" and both write "5". Fixed windows keep the
 * semantics (and the numbers) of the in-memory limiter this replaced.
 *
 * Throws whatever D1 throws. The routers let that reach `handleRequest`,
 * which answers 503 (issue #185): a limiter that cannot count fails closed.
 */
export async function rateLimitedShared(db, key, now, { max, windowMs }) {
  const row = await db
    .prepare(
      'INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) ' +
        'ON CONFLICT(key) DO UPDATE SET ' +
        'count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END, ' +
        'window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END ' +
        'RETURNING count',
    )
    .bind(key, now, windowMs)
    .first();
  return row.count > max;
}

/** The address a limiter keys on, namespaced by `scope` (the route) so routes
 *  get independent buckets, and by `ip` so an address bucket can never collide
 *  with a player bucket. Unknown callers share one bucket per scope, which is
 *  the conservative choice: better to throttle an unidentifiable caller than
 *  to hand every one of them its own allowance.
 *
 *  An IPv6 caller keys on its /64 prefix (issue #209). Every IPv6 connection
 *  owns at least a /64, so the full address would hand one caller 2^64
 *  buckets and turn every address-only limit into no limit at all. The prefix
 *  is what one connection is, the way one IPv4 address is. */
export function callerKey(request, scope) {
  const ip = request.headers.get('CF-Connecting-IP');
  return `${scope}:ip:${ip == null ? 'unknown' : addressBucket(ip)}`;
}

/** An IPv4 address as written; an IPv6 address as its canonical /64 prefix
 *  (`2001:db8:85a3:1::/64`), so the two spellings of one address land in one
 *  bucket. An IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) is that IPv4
 *  address. Anything unparseable is kept as written: an odd header value still
 *  gets a bucket, just not a shared one. */
function addressBucket(ip) {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const groups = expandIpv6(ip);
  if (groups == null) return ip;
  const prefix = groups.slice(0, 4);
  // Canonical form: no leading zeros, and the `::` that stands for the four
  // host groups also swallows any zero groups just before it.
  let end = 4;
  while (end > 0 && prefix[end - 1] === 0) end -= 1;
  return `${prefix.slice(0, end).map((g) => g.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or `null` if it is not one.
 *  A trailing dotted quad (`64:ff9b::203.0.113.9`, the NAT64 spelling) is the
 *  two groups it stands for. */
function expandIpv6(ip) {
  const quad = /:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    ip = `${ip.slice(0, quad.index + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

/** The player a limiter keys on once a request has authenticated (issue
 *  #186): the same allowance as the address bucket, so a player cannot exceed
 *  it by changing address. */
export function playerKey(scope, playerId) {
  return `${scope}:player:${playerId}`;
}

/** The window a quota counts over (issue #189). A day, and no longer: the
 *  nightly sweep in index.mjs deletes rows whose window opened more than a day
 *  ago, so a longer window here would be reset by the sweep mid-count. */
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A quota (issue #189) is the shared limiter over a day: the same upsert and
 *  the same table as the minutes-long bucket, with a longer window and its own
 *  `-day` scope so the two never share a row. The minutes bucket answers
 *  "slow down"; this one answers "enough for today" and is what bounds a
 *  credential's writes when the pace is patient. */
export function quotaExceeded(db, key, now, max) {
  return rateLimitedShared(db, key, now, { max, windowMs: QUOTA_WINDOW_MS });
}
