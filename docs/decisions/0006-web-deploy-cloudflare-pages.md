# Decision 0006 — Playtest web deploys go to Cloudflare

**Status:** APPROVED (PM, 2026-08-30) · **Date:** 2026-08-30 · **Issue:** #15 ·
**Retargeted to Workers:** 2026-08-31 (#40)

## Decision

Playtest builds deploy to a **Cloudflare Worker serving static assets**, driven by the existing
`CI` workflow.

- Push to `main` → deploy → **https://lantern-tiles.\<subdomain\>.workers.dev**
- Nothing else deploys. A Worker deploy replaces the live version, so running it from pull
  requests would let any PR overwrite the playtest URL.
- The deploy job `needs: [test, ui]`, and publishes the *artifact the `ui` job built* — a red
  suite can never reach the playtest URL, and the deployed bytes are the tested bytes.
- `wrangler.jsonc` at the repo root holds the Worker name and the asset directory, so the same
  `wrangler deploy` works from CI and from a laptop.

### Why Workers and not Pages

This decision originally specified Cloudflare **Pages**, and the workflow ran
`wrangler pages deploy`. In practice the Cloudflare dashboard now steers you to create a
**Worker** — the project created for this repo is at `/workers/services/`, not `/pages/`, and
never had the Pages build fields the setup steps described. Cloudflare is folding Pages into
Workers static assets, so rather than delete and recreate as a Pages project, this follows where
the platform is going. Everything below is Workers-shaped; the Pages-era instructions were wrong
in this repo's context and are gone rather than kept as an alternative.

Consequence worth naming: **per-PR preview URLs are dropped.** They were a stated benefit of
choosing Cloudflare, and Workers does offer preview versions, but wiring that up is more
machinery than the wk-5 checkpoint needs. Revisit if playtesting several PRs at once becomes
real.

## Why not GitHub Pages

The repo is private and the account is on the free plan, where GitHub Pages requires a **public**
repo. The alternatives were (a) make the repo public, (b) pay for GitHub Pro, or (c) a host that
serves private repos for free. Cloudflare was chosen because it keeps the repo private at no
cost. (Per-PR preview URLs were part of the original case for it; see "Why Workers and not
Pages" above for why that benefit was dropped.) Netlify/Vercel would also
work; Cloudflare wins on free-tier bandwidth and no seat/build-minute ceiling for this size of
project.

Revisit if the repo ever goes public: GitHub Pages would then remove the third-party dependency.

## One-time setup (PM, in the Cloudflare dashboard + repo settings)

Until these exist the deploy step **skips** with a notice and CI stays green.

A Worker named `lantern-tiles` already exists in the account, created from the dashboard. Nothing
further is needed there — `wrangler deploy` creates or updates the Worker from `wrangler.jsonc`,
so no build command, output directory, or branch setting has to be configured in the UI. Two
values are all that is missing:

1. Create an API token at **https://dash.cloudflare.com/profile/api-tokens** → Create Token →
   **Create Custom Token**, with the permission **Account → Workers Scripts → Edit**, and
   **Account Resources** limited to the one account holding the Worker.

   Workers Scripts Edit is what `wrangler deploy` needs; a Cloudflare Pages token does not work
   here. Keep it to that one permission — the stock "Edit Cloudflare Workers" template also
   carries KV and zone-route access this pipeline never uses, so a leak would reach further than
   overwriting a static playtest site.
2. Copy the **Account ID** — the identifier segment of any dashboard URL
   (`dash.cloudflare.com/<account-id>/...`).
3. In this repo: **Settings → Secrets and variables → Actions** →
   - secret `CLOUDFLARE_API_TOKEN` = the token from step 1
   - secret `CLOUDFLARE_ACCOUNT_ID` = the ID from step 2

This token is the only credential in the repo and it is long-lived. Roll it (step 1, then update
the secret) if it is ever pasted outside the secret store, if CI logs are shared with anyone
outside the project, or on any suspected compromise; revoke the old one in the same screen.

If the dashboard's own Git integration was connected while creating the Worker, it may also try
to build on push and fail, since it has no build configuration. That is noisy but harmless: a
failed build publishes nothing, so the last deploy from CI stays live. Disconnecting it in the
Worker's settings silences it, and does not affect `wrangler deploy`.

## Why nothing is interpolated into the deploy command

An earlier draft read the target name from a repo variable, and passed the branch on the command
line. `wrangler-action` runs its `command` input through a shell, so both were shell-interpolated
— and unlike the workflow file, repo variables and branch names are not code-reviewed. The deploy
command is now the bare word `deploy`: the Worker name and asset directory come from
`wrangler.jsonc`, and nothing from outside the repo reaches that shell at all.

To rename the Worker, change `wrangler.jsonc` — the workflow does not mention the name.

## Consequences

- The playtest URL is a third-party dependency; a Cloudflare outage blocks playtesting, not the build.
- Bundle output stays `ui/dist-web` with Vite `base: './'`, so the same artifact works from a
  sub-path if the host ever changes.
- Only `main` deploys, so there is no per-PR playtest link. Fork PRs receive no secrets in any
  case — a fork PR must never get a deploy credential.
- The deploy is an unauthenticated public URL. Nothing secret ships in the bundle, but treat the
  link as public when sharing.
- One live version at a time. A deploy replaces what is there, so rolling back means redeploying
  an older commit (or promoting a previous version in the Cloudflare dashboard) rather than
  flipping to a preserved preview.
- The Cloudflare GitHub App keeps read access to this private repo for as long as the project is
  Git-connected, even though deployment no longer flows through it. Removing the connection is
  the way to revoke that; it does not affect the CLI-driven deploys.
