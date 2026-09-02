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
//
// Issue #130 adds optional attachments (screenshots / a short recording) to
// the same JSON body, base64-encoded by the client — not multipart. Resend
// takes attachments as base64 JSON anyway, so this way the Worker never
// re-encodes: it parses, checks sizes by arithmetic, and re-serialises, all
// native V8 work with no per-byte JavaScript loop (decision 0020 has the
// CPU-time reasoning). The caps below are the server-side backstop for the
// ones the client enforces in ui/src/feedback-form.ts — keep them in step.

/** Text-only body cap (issue #118); a body carrying attachments is allowed
 *  up to MAX_BODY_BYTES_WITH_ATTACHMENTS instead. */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_ATTACHMENTS = 3;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Resend caps a whole email at 40 MB *after* base64 (4/3 inflation), so a
 *  video can be at most ~25 MB — issue #130's "~50 MB" cannot ride an email. */
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** 25 MB of files is ~33.4 MB of base64, plus the text fields and JSON
 *  punctuation — anything past this is over the limits above regardless. */
const MAX_BODY_BYTES_WITH_ATTACHMENTS = 36 * 1024 * 1024;
const ATTACHMENT_NAME_MAX = 200;
/** What the client is allowed to send. HEIC never arrives: the client
 *  re-encodes every image through a canvas (metadata strip), which yields
 *  PNG or JPEG only. Video is passed through as picked. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
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

/** Decoded byte count of a base64 string, from its length alone — no decode,
 *  no scan. Anything that is not a plausible base64 length is -1. */
function base64DecodedSize(content) {
  if (typeof content !== 'string' || content.length === 0 || content.length % 4 !== 0) return -1;
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  return (content.length / 4) * 3 - padding;
}

/** A filename the mail client can show: no path separators or control
 *  characters, and never empty. */
function safeFilename(name) {
  const cleaned = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/** Validate the optional `attachments` array (issue #130). Returns the list
 *  (possibly empty), 'too_large' when a file or the total is over cap, or
 *  null when the shape is wrong. */
function validateAttachments(attachments) {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) return null;
  const out = [];
  let total = 0;
  for (const item of attachments) {
    if (item === null || typeof item !== 'object') return null;
    const { name, type, content } = item;
    if (!isNonEmptyString(name, ATTACHMENT_NAME_MAX)) return null;
    const isImage = IMAGE_TYPES.has(type);
    const isVideo = VIDEO_TYPES.has(type);
    if (!isImage && !isVideo) return null;
    const size = base64DecodedSize(content);
    if (size < 0) return null;
    if (size > (isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) return 'too_large';
    total += size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) return 'too_large';
    out.push({ name: safeFilename(name), type, content, size });
  }
  return out;
}

/** Validate the parsed JSON body against the issue #118 contract (plus issue
 *  #130's optional attachments). Returns the trimmed summary/body, the context
 *  fields and the attachment list; 'too_large' for an over-cap attachment;
 *  null if anything else is off. */
function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const { summary, body, context, attachments } = payload;
  if (!isNonEmptyString(summary, 100)) return null;
  if (!isNonEmptyString(body, 2000)) return null;
  if (context === null || typeof context !== 'object') return null;
  const { version, level, ua, date } = context;
  for (const field of [version, level, ua, date]) {
    if (typeof field !== 'string' || field.length > CONTEXT_FIELD_MAX) return null;
  }
  const validAttachments = validateAttachments(attachments);
  if (validAttachments === null || validAttachments === 'too_large') return validAttachments;
  return {
    summary: summary.trim(),
    body: body.trim(),
    context: { version, level, ua, date },
    attachments: validAttachments,
  };
}

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

/** One line, whatever was typed: a subject must never carry a line break,
 *  even though Resend takes it as a JSON string rather than raw SMTP. */
function feedbackSubject(summary) {
  return `[Lantern Tiles feedback] ${summary.replace(/[\r\n]+/g, ' ')}`;
}

function feedbackText({ summary, body, context, attachments }) {
  const lines = [
    body,
    '',
    '---',
    `Summary: ${summary}`,
    `Version: ${context.version}`,
    `Level: ${context.level}`,
    `Platform: ${context.ua}`,
    `Date: ${context.date}`,
  ];
  if (attachments.length > 0) {
    const list = attachments.map((a) => `${a.name} (${formatBytes(a.size)})`).join(', ');
    lines.push(`Attachments: ${attachments.length} — ${list}`);
  }
  return lines.join('\n');
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
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES_WITH_ATTACHMENTS) {
    return json(413, { error: 'payload_too_large' });
  }
  // Without a trustworthy Content-Length the body is read before it is
  // measured; the platform's own request-size ceiling bounds that read. It is
  // read as bytes (not text) so the size check costs nothing extra, and only
  // then decoded — one string, one parse.
  const rawBytes = await request.arrayBuffer();
  const rawLength = rawBytes.byteLength;
  if (rawLength > MAX_BODY_BYTES_WITH_ATTACHMENTS) {
    return json(413, { error: 'payload_too_large' });
  }

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const payload = validatePayload(parsed);
  if (payload === null) return json(400, { error: 'invalid_payload' });
  if (payload === 'too_large') return json(413, { error: 'attachment_too_large' });
  // A text-only report keeps issue #118's tight cap: the large allowance
  // above exists only for bodies that actually carry attachments.
  if (payload.attachments.length === 0 && rawLength > MAX_BODY_BYTES) {
    return json(413, { error: 'payload_too_large' });
  }

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
        // Resend's attachment shape: filename + base64 content, passed
        // through exactly as the client encoded it (issue #130).
        ...(payload.attachments.length > 0 && {
          attachments: payload.attachments.map((a) => ({ filename: a.name, content: a.content })),
        }),
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
