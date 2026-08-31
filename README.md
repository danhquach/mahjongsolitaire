# Mahjong Solitaire

A cross-platform mahjong solitaire (tile-matching) game — accessibility-first, ad-restrained, playable in any browser on mobile or desktop, with store builds for iOS and Android.

> "Mahjong" here refers to tile visual style only — this is solitaire tile-matching, not 4-player mahjong.

## Status

📋 Planning complete — implementation not started. Work is tracked as GitHub issues, organized into per-phase milestones.

## Key documents

- **[Product & technical spec](mahjong-solitaire-spec.md)** — rules, level generation, monetization, QA strategy
- **[Roadmap](ROADMAP.md)** — phases, exit criteria, timeline, playtest checkpoints (v0.2.1, approved by independent senior review)

## Tech stack (proposed — see issue "Choose tech stack")

- **Core:** pure TypeScript package (`/core`) — board lattice, generator, solver, rules; deterministic, zero platform deps, fully unit-testable
- **Rendering:** Canvas via PixiJS, with a DOM/ARIA overlay for screen-reader accessibility
- **Distribution:** web build for playtesting (open a URL on any device), Capacitor wrappers for App Store / Play Store (ads + IAP live in the wrapper)

## Playtest checkpoints

| When | What |
|---|---|
| End of week 5 | Vertical slice: one full level, boosters, save/resume — in the browser |
| End of week 9 | Feature-complete MVP: 500 levels, Daily Challenge, ads/IAP |
| Week 12 | Release-quality build → soft launch |

### Playtest URL

**https://lantern-tiles.pages.dev** — the current `main` build, redeployed automatically by CI on every push once tests are green. Open it on any phone, tablet, or desktop browser; nothing to install.

Open a pull request and it gets its own Cloudflare preview URL, printed by the CI run's *Deploy to Cloudflare Pages* step — so a change can be playtested before it lands. Pushing a branch without a PR deploys nothing; CI only runs on `main` pushes and pull requests.

> The URL goes live once the one-time Cloudflare setup in [decision 0006](docs/decisions/0006-web-deploy-cloudflare-pages.md) is done (two repo secrets). Until then CI builds the bundle and skips the deploy step with a notice.

## Planned repository layout

```
/core         pure game logic (board, generator, solver, rules)
/data         layouts/*.json, progression.json
/persistence  local store + optional cloud sync
/ui           rendering, input, accessibility
/services     ads, IAP, analytics, remote config
```

## Development

- **Core engine** (`/core`): `cd core && npm ci && npm test`
- **Benchmark harness** (`/bench`): `node --test bench/test/*.test.mjs`
- **Web UI — vertical slice** (`/ui`): `cd ui && npm ci && npm run dev` (opens the Turtle level in the browser); `npm test` for the headless suite; `npm run build && node qa/e2e-slice.mjs` for the scripted browser playthrough (phone + tablet, both orientations)
- **Layouts** (`/data/layouts/*.json`): layout geometry as data; validated by the ui test suite
