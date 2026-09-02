# 0021 — Profile sync on our own Worker + D1, identified by a recovery code

**Date:** 2026-09-02 · **Status:** accepted · **Ticket:** issue #138

## Context

The player profile (issue #69) lives only in `localStorage`: a display name,
an avatar, and the record behind them — levels cleared, best and total score,
the Daily Challenge streak, trophies. Reinstalling the app erases all of it,
and nothing links two devices to the same person. Leaderboards (issue #70)
cannot start without an owner a score can belong to, which is what makes this
a blocker rather than a nice-to-have.

Three questions had to be answered together, because the answer to each
constrains the others: **where** the profile lives, **who** the player is to
the server, and **how** two copies of a record reconcile.

Issue #138 left the backend open between our own service and the platform
services (Game Center / Play Games).

## Decision

**Our own backend, on the Worker that already exists.** The game ships as a
web build first (decision 0001) and the store builds wrap it (Capacitor);
Game Center would give iOS a free identity and leave the web build — the one
every playtest runs on — with none, so the identity would have to be built
anyway. The feedback endpoint (decision 0019) already put a Worker in front of
the static assets, so this is a second route on an existing deploy rather than
a new piece of infrastructure.

**Cloudflare D1 for storage.** The profile is a row per player, and issue #70
needs ordered queries over scores (rank, and the entries around yours) — which
KV cannot do at all and Durable Objects would do by hand. `worker/schema.sql`
holds the schema; a schema *change* gets a new numbered file rather than an
edit to that one.

**A recovery code, not an account.** Registering mints 120 bits of Crockford
base32 (`ABCD-1234-…`, no I/L/O/U so it can be transcribed) and the server
stores only its SHA-256 — it is a password hash, and the plaintext is returned
exactly once. The code is the whole credential: entering it on another device
is what makes that device the same player. No email, no password, no
third-party sign-in, nothing to verify, and nothing to leak beyond the code
itself. The honest cost is that losing the code loses the profile, which is
why the profile panel shows it with "write this down" rather than burying it.

**The code is masked in the panel.** It is shown in full once, at the moment
it is minted and the player is told to write it down, and behind a "Show code"
toggle after that — masked again on every reopen. The same build can attach a
screenshot to a feedback report (issue #130), and a profile screen is the kind
of screen people screenshot.

**Rate limits are applied before authentication.** Every profile route is
metered by address before the code is checked. Limiting after authentication
would be no limit on the thing worth limiting: a wrong code never reaches a
post-auth check, so an unauthenticated caller could spend unbounded SHA-256
work and indexed row reads for free. 120 bits is not guessable either way —
this is about the meter, not the lock.

**A separate public id.** `playerId` (10 symbols) is what a leaderboard will
show beside the name — `Alex #7K3MQ2R9WD`. It is random rather than
sequential, so it leaks neither signup order nor how many players exist, and
it is never the credential, so it is safe to display.

**Names are screened but not unique.** The uniqueness the issue asks for is
handled by the id above: a casual game that refuses "Alex" because a stranger
took it is a worse game, and a discriminator appended to the name silently
changes the player's identity behind their back. Screening is a small
substring blocklist over a folded form of the name (lower-cased, leet-mapped,
non-letters stripped) — it lives in the Worker, so improving it is a Worker
deploy rather than an app update. The name is also checked with repeated
letters collapsed (`sshhiitt`), but the blocklist itself is never collapsed:
doing that to both sides turns `coon` into the needle `con` and refuses
Falcon, Connie and Constance. It will still have false positives;
the recovery is "pick another name", which is a survivable ask. Rename is its
own route (`/api/profile/name`) for exactly this reason: a rejection has to
reach the player, and it must never fail a background sync.

**Merges take the max and never regress.** Counters (levels cleared, best
score, total score, trophies) merge by maximum; cleared levels merge by union.
The Daily streak is the one field where the larger number can be the stale
one — it is a count anchored to `lastDaily` — so the more recent anchor wins,
and the larger streak is kept when the two anchors are within a day of each
other. That last rule is what lets a reinstalled device clear today's Daily,
report a streak of 1, and still come back with the 30-day streak the server
was holding. The rule is implemented on both sides (`worker/profile.mjs`
`mergeRecords` and `ui/src/sync.ts` `mergeRecords`) because both need the
answer: the server to store it, the device to show it without waiting for a
round trip it may never get.

**Sync is opt-in and never on the play path.** Off by default. Nothing in
starting, saving, or finishing a level waits on the network: the post-win push
is fire-and-forget, and every failure — offline, endpoint down, database not
bound — leaves the local profile exactly as it was and says so in the panel.

## Consequences

- The routes ship inert. `wrangler.jsonc` carries the D1 binding **commented
  out**, because `wrangler deploy` fails outright on a `database_id` that does
  not exist and that would take the playtest deploy down. Until someone runs
  `wrangler d1 create lantern-tiles` and applies `worker/schema.sql`,
  `/api/profile*` answers `503 not_configured`, which the client already
  treats as "unavailable, try later". This is the same pending-setup shape as
  the feedback endpoint's `RESEND_API_KEY`.
- The recovery code sits in `localStorage` under `mahjong.sync.v1`. Anyone
  with access to the device's storage has the profile — acceptable for a
  profile holding a name, an avatar and some counters, and stated plainly in
  the panel ("anyone who has it can use your profile"). It would not be
  acceptable for anything with real value attached, which is a constraint on
  what may be attached later.
- Worker tests run the real schema against real SQLite (`node:sqlite`) behind
  a D1-shaped adapter. A hand-written fake would pass while the SQL was wrong,
  and wrong SQL is most of what can break here.
- Store data-safety labels now have something to declare: a display name, an
  avatar id, and gameplay counters, tied to a random id, with no email, no
  device identifier, and no advertising id. That belongs in the Phase 4
  compliance workstream.
- Issue #70 inherits an owner for a score, a public tag to show beside it, and
  a screened name. What it still has to solve on its own is score integrity —
  a public board makes a forged score everyone's problem, and nothing here
  validates that a claimed score was actually played.
