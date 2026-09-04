# 0019 — Feedback delivered by a Worker endpoint, with a mailto fallback

**Date:** 2026-09-02 · **Status:** accepted · **Ticket:** issue #118

## Context

Issue #118 wants an in-game "Send feedback" form (Summary + Body) that reaches
the QA inbox (`dqtgametesting@gmail.com`) as an email, with the build version,
current level, platform, and date attached automatically. The playtest deploy
(decision 0006) was assets-only — `wrangler.jsonc` had no `main`, so every
request just served a static file from `ui/dist-web/`. An email API key can
never live in that bundle (it ships to every browser that opens the playtest
URL), so sending the email needs a server-side hop the client cannot make on
its own.

## Decision

- Add a minimal Worker script (`worker/index.mjs`, plain ESM, no dependencies,
  no build step) alongside the existing static assets, and point
  `wrangler.jsonc`'s new `main` field at it. With both `main` and `assets`
  set, a request that matches a file under `assets.directory` is served as
  that static asset; only a request with no matching asset — `POST
  /api/feedback` is the only one that exists — reaches the script.
  `run_worker_first` is deliberately left unset (and never set globally): that
  option would route every request, including plain page loads, through the
  Worker first, which this endpoint does not need.
- The script validates the request (JSON shape, field lengths, a same-origin
  check via `Origin`/`Sec-Fetch-Site`, an 8 KB body cap, and a best-effort
  per-isolate rate limit of 5 requests / 10 minutes per `CF-Connecting-IP`),
  then forwards the email via the [Resend](https://resend.com) REST API using
  `env.RESEND_API_KEY` — a Worker secret, never a bundled value or a `vars`
  entry.
- `handleFeedback(request, env, deps)` is exported as a pure-ish function with
  an injectable `fetch`, `now`, and rate-limit store, so `worker/test/
  feedback.test.mjs` runs the whole contract under `node --test` (Node 22's
  global `Request`/`Response`/`fetch`) with no real network or Cloudflare
  runtime involved.
- The client (`ui/src/feedback-form.ts`) POSTs to `/api/feedback` and falls
  back to a pre-filled `mailto:dqtgametesting@gmail.com` link on any failure —
  network error, the endpoint being unreachable, or the key not being
  configured (503) — so a submission is never silently lost. The inbox
  address is kept in one exported constant (`FEEDBACK_INBOX`) and only ever
  appears in that fallback link; the issue accepts this as the one address
  that necessarily ships in the bundle.

## Consequences

- One-time setup the PM must do before real emails flow (none of this runs
  automatically from CI):
  1. Create a Resend account. Its free/shared sender
     (`onboarding@resend.dev`, set as `FEEDBACK_FROM` in `wrangler.jsonc`)
     can only deliver to **the Resend account's own address** — so the
     account must be created with `dqtgametesting@gmail.com` (the QA inbox,
     also `FEEDBACK_TO`), or a verified sending domain used instead of the
     shared sender.
  2. Run `npx wrangler secret put RESEND_API_KEY` against the `lantern-tiles`
     Worker and paste the Resend API key when prompted. This never touches
     git or CI config.
  3. No change needed to the CI deploy token: decision 0006's
     `CLOUDFLARE_API_TOKEN` already carries **Workers Scripts Edit**, which is
     enough to deploy a script alongside `vars` — a script deploy is not a
     different permission than an assets-only deploy.
- Local testing: `npx wrangler dev` (from the repo root) serves the Worker on
  `http://127.0.0.1:8787`; `ui/vite.config.ts` proxies `/api` there so `npm
  run dev` and a local `wrangler dev` can run side by side.
- The rate limiter is per-isolate, in-memory state — it resets on every cold
  start and is not shared across simultaneous isolates. That is accepted as
  "slow down obvious abuse," not a hard cap; a determined abuser could still
  exceed it across isolates. Revisit with Durable Objects or KV if this ever
  needs to be a real guarantee.
  **Superseded by [0029](0029-shared-rate-limiter-in-d1.md) (issue #186):** the
  count now lives in D1 and is checked before the body is read.
- `FEEDBACK_TO`/`FEEDBACK_FROM` are plain `vars` in `wrangler.jsonc`, not
  secrets — neither is sensitive on its own (the QA inbox address already
  ships in the mailto fallback, and the shared Resend sender is public), so
  there is no reason to route them through `wrangler secret put`.
