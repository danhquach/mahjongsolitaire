# Decision 0006 — Playtest web deploys go to Cloudflare Pages

**Status:** APPROVED (PM, 2026-08-30) · **Date:** 2026-08-30 · **Issue:** #15

## Decision

Playtest builds deploy to **Cloudflare Pages**, driven by the existing `CI` workflow.

- Push to `main` → production deploy → **https://lantern-tiles.pages.dev**
- Open a pull request → its own Cloudflare **preview URL** (printed by the run's deploy step)
- A branch with no PR open does **not** deploy — CI only triggers on `main` pushes and pull
  requests, so pushing a branch alone runs nothing. Open the PR to get a preview URL.
- The deploy job `needs: [test, ui]`, and publishes the *artifact the `ui` job built* — a red
  suite can never reach the playtest URL, and the deployed bytes are the tested bytes.

## Why not GitHub Pages

The repo is private and the account is on the free plan, where GitHub Pages requires a **public**
repo. The alternatives were (a) make the repo public, (b) pay for GitHub Pro, or (c) a host that
serves private repos for free. Cloudflare Pages was chosen because it keeps the repo private at no
cost *and* gives per-PR preview URLs, which the wk-5 and wk-9 playtest checkpoints benefit from
(reviewers open a link per PR instead of racing over one shared URL). Netlify/Vercel would also
work; Cloudflare wins on free-tier bandwidth and no seat/build-minute ceiling for this size of
project.

Revisit if the repo ever goes public: GitHub Pages would then remove the third-party dependency.

## One-time setup (PM, in the Cloudflare dashboard + repo settings)

Until these exist the deploy step **skips** with a notice and CI stays green.

1. Create a free Cloudflare account (if none) → **Workers & Pages → Create → Pages → Direct Upload**.
2. Name the project exactly **`lantern-tiles`** and set its **production branch** to `main`.
   The name is hardcoded in the workflow — see "Why the project name is not configurable" below.
3. Create an API token: **My Profile → API Tokens → Create Token → Create Custom Token**, with
   the single permission **Account → Cloudflare Pages → Edit**, and **Account Resources** limited
   to the one account used in step 1.

   Do *not* use the "Edit Cloudflare Workers" template. It grants Workers Scripts Edit, Workers KV
   Edit, and Zone → Workers Routes Edit, none of which `pages deploy` needs — a leaked token would
   then deploy arbitrary Workers and attach routes to zones, rather than merely overwrite a static
   playtest site. (It may not even carry Pages Edit.)
4. Copy the **Account ID** from the Workers & Pages sidebar.
5. In this repo: **Settings → Secrets and variables → Actions** →
   - secret `CLOUDFLARE_API_TOKEN` = the token from step 3
   - secret `CLOUDFLARE_ACCOUNT_ID` = the ID from step 4

This token is the only credential in the repo and it is long-lived. Roll it (step 3, then update
the secret) if it is ever pasted outside the secret store, if CI logs are shared with anyone
outside the project, or on any suspected compromise; revoke the old one in the same screen.

## Why the project name is not configurable

An earlier draft read the name from a repo variable so the Cloudflare project could be called
anything. `wrangler-action` runs its `command` input through a shell, so that variable was
interpolated into a shell command — and unlike the workflow file, repo variables are not
code-reviewed. The name is now a literal in the workflow, and nothing outside the file reaches
that command. One project name, pinned in two places, is cheaper than validating an escape hatch
nobody asked for. If the project ever needs renaming, change it here and in the workflow together.

## Consequences

- The playtest URL is a third-party dependency; a Cloudflare outage blocks playtesting, not the build.
- Bundle output stays `ui/dist-web` with Vite `base: './'`, so the same artifact works from a
  sub-path if the host ever changes.
- Preview deploys run on PRs from this repo. Fork PRs receive no secrets, so their deploy step
  skips — expected, and safe (a fork PR must never get a deploy credential).
- Deploys are unauthenticated public URLs. Nothing secret ships in the bundle, but treat any
  preview link as public when sharing.
