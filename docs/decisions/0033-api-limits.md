# 0033 — API limits are one table, held to the code by a test; attachments need the build header

**Date:** 2026-09-04 · **Status:** accepted · **Ticket:** issue #191
**Amends:** [0020](0020-feedback-attachments-inline-base64.md) (the attachment
allowance is now conditional) · **Collects:** the numbers set in
[0019](0019-feedback-worker-endpoint.md), [0021](0021-profile-sync-own-backend.md),
[0027](0027-one-weekly-score.md), [0029](0029-shared-rate-limiter-in-d1.md) and
[0032](0032-per-identity-daily-quotas.md).

## Context

Every route caps its body before parsing, meters the calling address before it
checks a code, meters the player after, and (since #189) counts a day's quota.
The numbers lived only in three source files, so the external review of
2026-09-04 (issue #191) could not see them from outside and asked for two
things: a single place that states them, kept honest by a test rather than by
memory; and a tighter door on the one cap that matters — the 36 MB feedback
body, an unauthenticated write that anything with a socket could send, held
back only by the address limiter.

## Decision

### 1. The API limits table

| Route | Body cap | Per address | Per player | Per day |
| --- | --- | --- | --- | --- |
| `POST /api/feedback` | 8 KB text, 36 MB with the build header | 5 / 10 min | — | — |
| `POST /api/profile/register` | 16 KB | 5 / 1 h | — | 10 per address, 1,000 global |
| `GET /api/profile` | — | 10 / 10 min | 10 / 10 min | — |
| `POST /api/profile/sync` | 16 KB | 60 / 10 min | 60 / 10 min | 200 |
| `POST /api/profile/name` | 16 KB | 20 / 10 min | 20 / 10 min | 20 |
| `POST /api/profile/reset` | — | 5 / 10 min | 5 / 10 min | 5 |
| `DELETE /api/profile` | — | 5 / 10 min | 5 / 10 min | 5 |
| `POST /api/leaderboard/weekly` | 96 KB | 20 / 10 min | 20 / 10 min | — (300 runs a week, 0027) |
| `GET /api/leaderboard/weekly` | — | 60 / 10 min anonymous, 10 / 10 min signed | — | — |
| `DELETE /api/leaderboard/weekly` | — | 10 / 10 min | 10 / 10 min | 10 |

How to read it:

- **Body cap** is checked on `Content-Length` before the body is read, and
  again on the bytes actually received; over it is `413 payload_too_large`.
  Feedback attachments have their own caps inside the body (3 files, 10 MB an
  image, 25 MB a video, 25 MB in all → `413 attachment_too_large`, 0020).
- **Per address** is a fixed window keyed by `CF-Connecting-IP`, checked before
  any code is looked at (0029). An IPv4 caller keys on its address; an IPv6
  caller keys on its /64 prefix, because every IPv6 connection owns at least
  a /64 and the full address would give one caller 2^64 buckets (#209). **Per player** is the same window keyed by the
  authenticated player, checked after. **Per day** is the identity's quota
  (0032): the player's where there is one, the address's and everyone's for
  registration. All three answer `429 rate_limited`.
- Everything counts in D1, with one exception: the anonymous leaderboard read
  is metered per isolate in memory (public data, no credential, and a database
  write per read would double the cost of the cheapest route — 0029).
- The feedback route is the only unauthenticated write and so has no player
  and no quota; its address bucket is the whole limiter.

`worker/test/api-limits.test.mjs` reads this table and compares every cell to
the constants the three route modules export (`FEEDBACK_LIMITS` in
worker/index.mjs, `MAX_BODY_BYTES` and `RATE_LIMITS` in worker/profile.mjs and
worker/leaderboard.mjs). Change a number in the code and this file goes red
until the table says the same; edit the table and the test says which cell no
longer matches.

### 2. Attachments require the game's build header

The feedback form sends `X-Lantern-Tiles-Build: <build label>` (the same label
the report carries in `context.version`, reduced to printable ASCII). The
Worker decides the body cap from that header *before reading the body*: with
it, 36 MB; without it, the 8 KB text cap. A body that arrives under 8 KB and
still carries an attachment without the header is `400 invalid_payload` — the
header is the rule, not just the size switch. Text-only reports need no
header, so nothing that worked before stops working.

This is not authentication. The header is in the client source and anyone can
send it. What it does is make the 36 MB read *opt-in to the contract*: a
scanner, a stray form post, a `curl` that found the route in the README, or a
replay of the old client all get the text route's cost. Whoever wants the large
read has to have read the client — and then meets the shared address limiter
from #186, which is the real bound.

## Rejected

- **A signed header** (HMAC of the body with a key in the bundle). A key in the
  bundle is not a secret, so this is the same gate with more code.
- **Requiring the header to equal `context.version`.** Binds two copies of a
  string the sender controls; buys nothing the presence check does not, and
  the label's middle dot would have to be squared with header byte rules on
  both sides for the comparison to hold.
- **Dropping the attachment allowance** (the issue's fallback, "until #186
  lands"). #186 had landed; the allowance is what the feedback form's
  screenshot/recording flow exists for.
- **Generating the table from the code** at build time. A generated file is
  one more artifact to keep committed and reviewed; a test that diffs a
  hand-written table against the code is the same guarantee with the prose
  left to a person.
- **Putting the table in the README.** The README points here; the numbers
  change with tickets, and a decision record is where the reasoning for each
  already lives.

## Consequences

- Clients other than the game's feedback form (none exist) would need to send
  the header to attach files.
- The UI test asserts the header goes out; the Worker tests cover both sides of
  the gate and the pre-read `Content-Length` refusal.
- Any future route, or any change to a cap, limit or quota, has to touch the
  table — the test makes forgetting impossible rather than unlikely.
