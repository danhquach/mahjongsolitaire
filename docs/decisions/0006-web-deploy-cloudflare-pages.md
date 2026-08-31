# Decision 0006 — Playtest web deploys go to Cloudflare Pages

**Status:** APPROVED (PM, 2026-08-30) · **Date:** 2026-08-30 · **Issue:** #15

## Decision

Playtest builds deploy to **Cloudflare Pages**, driven by the existing `CI` workflow.

- Push to `main` → production deploy → **https://lantern-tiles.pages.dev**
- Every other branch / PR → its own Cloudflare **preview URL** (posted on the run's deploy step)
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
2. Name the project **`lantern-tiles`** and set its **production branch** to `main`.
   (Using a different name is fine — set the repo variable `CLOUDFLARE_PROJECT_NAME` to match.)
3. Create an API token: **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"**
   template, or a custom token with the **Account → Cloudflare Pages → Edit** permission only.
4. Copy the **Account ID** from the Workers & Pages sidebar.
5. In this repo: **Settings → Secrets and variables → Actions** →
   - secret `CLOUDFLARE_API_TOKEN` = the token from step 3
   - secret `CLOUDFLARE_ACCOUNT_ID` = the ID from step 4
   - *(optional)* variable `CLOUDFLARE_PROJECT_NAME` if the project isn't named `lantern-tiles`

Scope the token to Pages edit only — it is the sole credential in this repo, and nothing in the
pipeline needs broader account access.

## Consequences

- The playtest URL is a third-party dependency; a Cloudflare outage blocks playtesting, not the build.
- Bundle output stays `ui/dist-web` with Vite `base: './'`, so the same artifact works from a
  sub-path if the host ever changes.
- Preview deploys run on PRs from this repo. Fork PRs receive no secrets, so their deploy step
  skips — expected, and safe (a fork PR must never get a deploy credential).
- Deploys are unauthenticated public URLs. Nothing secret ships in the bundle, but treat any
  preview link as public when sharing.
