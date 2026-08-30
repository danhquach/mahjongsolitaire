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

Playtest builds deploy automatically on push (see the "Web deploy pipeline" issue). URL will be added here once the pipeline lands.

## Planned repository layout

```
/core         pure game logic (board, generator, solver, rules)
/data         layouts/*.json, progression.json
/persistence  local store + optional cloud sync
/ui           rendering, input, accessibility
/services     ads, IAP, analytics, remote config
```

## Development

Toolchain lands with Phase 1 (see milestones). This section will gain build/test instructions once the first code merges.
