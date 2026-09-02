// Cloudflare Worker for the playtest deploy (issue #118 — feedback endpoint).
//
// The deploy was assets-only (decision 0006): `wrangler.jsonc` had no `main`,
// so every request just served a static file. Adding `main` here alongside
// `assets` keeps that behaviour — Cloudflare serves any request that matches
// a file under `ui/dist-web/` as a static asset first, and only a request
// with no matching asset (like `POST /api/feedback`) reaches this script.
// `run_worker_first` is deliberately left unset (and not set globally): if it
// were on, every request — including the ones that just want `index.html` —
// would pay for a Worker invocation first.
//
// One route: `POST /api/feedback`. It forwards to Resend
// (https://resend.com) so the shipped bundle never carries an email API key —
// only this server-side script holds `env.RESEND_API_KEY`, set with
// `wrangler secret put` (see docs/decisions/0019-feedback-worker-endpoint.md).

const MAX_BODY_BYTES = 8 * 1024;
/** Upper bound on the provider call; past it the client gets its 502. */
const PROVIDER_TIMEOUT_MS = 5000;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const CONTEXT_FIELD_MAX = 300;

/** Per-isolate best-effort rate limiter — not shared across isolates or
 *  deploys, which is fine for "slow down obvious abuse", not a hard cap. */
const defaultRateLimitStore = new Map();

function isNonEmptyString(value, maxLen) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

/** Validate the parsed JSON body against the issue #118 contract. Returns the
 *  trimmed summary/body plus the context fields, or null if anything is off. */
function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const { summary, body, context } = payload;
  if (!isNonEmptyString(summary, 100)) return null;
  if (!isNonEmptyString(body, 2000)) return null;
  if (context === null || typeof context !== 'object') return null;
  const { version, level, ua, date } = context;
  for (const field of [version, level, ua, date]) {
    if (typeof field !== 'string' || field.length > CONTEXT_FIELD_MAX) return null;
  }
  return {
    summary: summary.trim(),
    body: body.trim(),
    context: { version, level, ua, date },
  };
}

/** One line, whatever was typed: a subject must never carry a line break,
 *  even though Resend takes it as a JSON string rather than raw SMTP. */
function feedbackSubject(summary) {
  return `[Lantern Tiles feedback] ${summary.replace(/[\r\n]+/g, ' ')}`;
}

function feedbackText({ summary, body, context }) {
  return [
    body,
    '',
    '---',
    `Summary: ${summary}`,
    `Version: ${context.version}`,
    `Level: ${context.level}`,
    `Platform: ${context.ua}`,
    `Date: ${context.date}`,
  ].join('\n');
}

/** Same-origin check (issue #118 design): reject a request that names itself
 *  cross-site, allow everything else — a direct API client sends neither
 *  header, and this endpoint has no cookie/session to protect from CSRF, so
 *  the check only needs to stop a *browser* on another origin. */
function isCrossSite(request) {
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

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Best-effort fixed-window limiter keyed by `CF-Connecting-IP`. `store` and
 *  `now` are injectable so tests get a fresh, deterministic clock/map. */
function rateLimited(ip, store, now) {
  // Opportunistic eviction: a long-lived isolate must not keep one entry per
  // address it ever saw. Expired windows go on every call — the map only ever
  // holds addresses seen within the current window.
  for (const [key, e] of store) {
    if (now - e.windowStart >= RATE_LIMIT_WINDOW_MS) store.delete(key);
  }
  const entry = store.get(ip);
  if (entry === undefined || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    store.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

/**
 * Pure-ish request handler: everything reachable from the outside world
 * (fetch, the clock, the rate-limit store) comes in through `deps` so tests
 * never touch the network or real time.
 */
export async function handleFeedback(request, env, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const rateLimitStore = deps.rateLimitStore ?? defaultRateLimitStore;

  const url = new URL(request.url);
  if (url.pathname !== '/api/feedback') return json(404, { error: 'not_found' });
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (isCrossSite(request)) return json(403, { error: 'cross_site' });

  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return json(413, { error: 'payload_too_large' });
  }
  // Without a trustworthy Content-Length the body is read before it is
  // measured; the platform's own request-size ceiling bounds that read, and
  // the cap below still rejects anything over 8 KB before it is parsed.
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return json(413, { error: 'payload_too_large' });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const payload = validatePayload(parsed);
  if (payload === null) return json(400, { error: 'invalid_payload' });

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (rateLimited(ip, rateLimitStore, now())) return json(429, { error: 'rate_limited' });

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return json(503, { error: 'not_configured' });

  let resendResponse;
  try {
    resendResponse = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.FEEDBACK_FROM,
        to: env.FEEDBACK_TO,
        subject: feedbackSubject(payload.summary),
        text: feedbackText(payload),
      }),
      // A hung provider fails fast to a 502 the client can act on (mailto).
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    // Never log the body or the key — only that the provider call failed.
    return json(502, { error: 'provider_unreachable' });
  }
  if (!resendResponse.ok) return json(502, { error: 'provider_error' });

  return json(202, { status: 'sent' });
}

export default {
  fetch: (request, env) => handleFeedback(request, env),
};
