# Lantern Tiles — Mahjong Solitaire

A cross-platform mahjong solitaire (tile-matching) game — accessibility-first, ad-free in v1, playable in any browser on mobile or desktop, with store builds for iOS and Android planned.

> "Mahjong" here refers to tile visual style only — this is solitaire tile-matching, not 4-player mahjong.

**Play the current build:** https://lantern-tiles.dqtgametesting.workers.dev — redeployed by CI on every merge to `main`. Nothing to install.

## Status

🎮 **Playable, in active playtest.** Phases 1–3 of the [roadmap](ROADMAP.md) (core engine, vertical slice, content & progression) have shipped; Phase 4 services (ads, IAP, analytics) and Phase 5–6 (store compliance, soft launch) are open. Work is tracked as GitHub issues; every change lands through a reviewed pull request.

What is in the game today (see [CHANGELOG.md](CHANGELOG.md) for the day-by-day record):

- **10 layouts** (Turtle, Pyramid, Fortress, Spider, Butterfly, Bridge, Cat, Moon Gate, Terrace, Windmill) as data files, every deal provably solvable
- **150-level ladder** with difficulty bands, plus a **Daily Challenge** with stars and a global **daily leaderboard**
- **Boosters:** Hint, Shuffle, Undo; a four-slot **holder** for parking free tiles
- **Save/resume**, six-step **tutorial** for new players, board palettes, win/loss effects
- **Player profiles** synced across devices via a recovery code (own backend, no third-party sign-in)
- **Accessibility:** screen-reader traversal and matching (VoiceOver/TalkBack), 48 dp touch targets, reduced-motion support
- **In-game feedback** form with optional screenshot/recording attachment

## Key documents

- **[Product & technical spec](mahjong-solitaire-spec.md)** — rules, level generation, monetization, QA strategy
- **[Roadmap](ROADMAP.md)** — phases, exit criteria, playtest checkpoints
- **[Decision records](docs/decisions/)** — 23 ADRs from tech stack (0001) to tile-face art (0023)
- **[Layouts](docs/layouts.md)** — the layout JSON format
- **[Playtest kit](docs/playtest/)** — facilitator script and tester instructions

## Tech stack

- **Core** (`/core`): pure TypeScript — board lattice, generator, solver, rules, scoring, daily seeds, ladder. Deterministic, zero platform deps, fully unit-tested. [Decision 0001](docs/decisions/0001-tech-stack.md).
- **UI** (`/ui`): Vite + TypeScript, Canvas rendering with a DOM/ARIA overlay for screen readers.
- **Backend** (`/worker`): a Cloudflare Worker serving the static bundle plus `/api/feedback`, `/api/profile/*` and `/api/leaderboard/weekly`, backed by D1 (SQLite). [Decisions 0019](docs/decisions/0019-feedback-worker-endpoint.md), [0021](docs/decisions/0021-profile-sync-own-backend.md), [0022](docs/decisions/0022-daily-leaderboard-first.md).
- **Distribution:** web build for playtesting; Capacitor wrappers for the App Store / Play Store are planned (Phase 4–6).

## Repository layout

```
/core          game engine: board, generator, solver, moves, scoring, daily, ladder (+ soak & bench scripts)
/ui            web app: rendering, input, a11y, boosters, holder, tutorial, save, profile, leaderboard, feedback
/worker        Cloudflare Worker: static assets, feedback endpoint, profile sync, daily leaderboard; D1 schema
/data          layouts/*.json, ladder.json (the 150-level plateau ladder) and its report
/bench         on-device benchmark harness for the core generate+validate gate
/docs          decisions/ (ADRs), layouts.md, playtest/
/spike         tech-stack spike (historical)
wrangler.jsonc Worker + D1 config; CHANGELOG.md is shown in-game with the running build's commit
```

## Development

Node 22. Each package installs on its own.

- **Core engine:** `cd core && npm ci && npm test` (typecheck + unit tests)
- **Layout soak** (spec §11.1 release gate): `cd core && npm run soak` — 10,000 seeds × all 10 layouts must generate provably solvable deals; `npm run soak -- --layout <id> --seeds 500` for a quick single-layout check
- **Ladder build:** `cd core && npm run build:ladder` regenerates `data/ladder.json` and `data/ladder-report.md`
- **Web UI:** `cd ui && npm ci && npm run dev`; `npm test` for the headless suite; `npm run build && node qa/e2e-slice.mjs` for the scripted browser playthrough (phone + tablet, both orientations); `node qa/a11y-audit.mjs` for the screen-reader / touch-target check
- **Worker:** `node --test worker/test/*.test.mjs`. To run it locally alongside `npm run dev`, run `npx wrangler dev` from the repo root — `ui/vite.config.ts` proxies `/api` to its default port (8787)
- **Bench harness:** `node --test bench/test/*.test.mjs`; see [bench/README.md](bench/README.md)
- **Layouts:** `/data/layouts/*.json`, validated by `core/test/layout-files.test.ts`

## CI and deploy

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request: core/bench/worker tests, the UI suite and browser playthrough, and the layout soak sharded one job per layout. Only pushes to `main` deploy; PRs build and test but never publish. A Worker deploy replaces the live version. Setup details: [decision 0006](docs/decisions/0006-web-deploy-cloudflare-pages.md).

## Contributing

The repository is public. `main` is protected: all changes go through a pull request that must pass CI and be approved by the maintainer before merging. Please open an issue first for anything beyond a small fix. Security concerns can be reported privately through GitHub's private vulnerability reporting on this repository.

## License

[MIT](LICENSE) © 2026 Daniel Quach. Tile artwork is free/open-licensed ([decision 0003](docs/decisions/0003-free-artwork.md)).
