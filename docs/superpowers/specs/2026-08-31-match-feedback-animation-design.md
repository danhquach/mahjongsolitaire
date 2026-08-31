# Match feedback animation — design (issue #44)

Date: 2026-08-31 · Branch: `issue-44-match-animation` · Roadmap: Phase 3 (game feel)

## Problem

A matched pair vanishes. No motion, no impact, no physical cue — the match does
not read as an event, it reads as two tiles going missing. Super Combo (a 5s
scoring window) lands in the same phase and is unreadable without it.

The renderer cannot express this today: `BoardRenderer.draw()` tears down and
rebuilds every tile on each redraw, drawing is event-driven only, and there is
no per-frame logic anywhere in the UI.

## Goal

Matched tiles fly toward each other, collide with a flash / particle burst /
scale punch / haptic tap, then clear — the whole sequence under 400 ms, never
blocking input, with a reduced-motion cross-fade alternative and a shake on
mismatch.

## Decisions taken (PM, 2026-08-31)

1. **Overlay layer + per-tile containers**, not a retained-mode renderer
   rewrite. `draw()` keeps its teardown-rebuild; it just emits one `Container`
   per tile so the ticker can nudge individual tiles without a rebuild.
2. **Sound at match time, haptic at impact.** Audio answers the tap
   immediately (no perceived input lag); the physical tap lands on the
   collision. Both channels keep their independent toggles (spec §7).
3. **New "Reduced motion" setting, default OFF, OR'd with the OS preference.**
   Motion is reduced when `prefers-reduced-motion: reduce` *or* the toggle is
   on. A player can opt in without touching OS settings, and the OS preference
   still works on its own.

## Architecture

```
app.stage
└── viewport            (fit transform: scale + centering — was on boardLayer)
    ├── boardLayer      one Container per tile, rebuilt by draw()
    └── effectsLayer    in-flight match copies + particles, above the board
```

Board-space coordinates throughout: because `effectsLayer` is a sibling of
`boardLayer` under the same transform, an animation is written in the same
units as `tileRect()` and needs no scale conversion. Tile Size, HUD placement
and orientation changes keep working untouched — they move `viewport`.

### New module: `ui/src/anim.ts` (pure)

No Pixi imports, no DOM, no clock — takes `elapsedMs` and returns numbers. This
is the tested surface, in the style of `depth.ts` / `geometry.ts`.

| Export | Purpose |
| --- | --- |
| `TRAVEL_MS = 200`, `FADE_MS = 120`, `CROSSFADE_MS = 160`, `SHAKE_MS = 250` | timings |
| `matchFrame(from: Rect, to: Point, t: number, reduced: boolean): TileFrame` | position, scale, alpha, flash strength for one flying tile at time `t` |
| `matchDuration(reduced: boolean): number` | 320 (motion) / 160 (reduced) |
| `IMPACT_AT` | `TRAVEL_MS` — the instant the haptic and burst fire |
| `shakeOffset(t: number): number` | damped sine, exactly 0 at `t = 0` and `t ≥ SHAKE_MS` |
| `particleBurst(seed: number): readonly Particle[]` | deterministic radial spread (8 dots), so tests can assert it |
| `particleFrame(p, t)` | position + alpha of one particle |

`TileFrame = { x, y, scale, alpha, flash }`. Travel eases *in* (cubic) so tiles
accelerate into the hit; the impact punch is a short scale overshoot decaying
across the fade. Reduced motion returns `x, y` fixed at the tile's own origin
and `scale = 1` for all `t` — only `alpha` and `flash` move.

### New module: `ui/src/effects.ts` (Pixi glue)

```ts
class Animator {
  constructor(layer: Container, ticker: Ticker, opts: {
    reduced: () => boolean;
    tileNode: (id: TileId) => Container | undefined;
  });
  playMatch(a: FlyingTile, b: FlyingTile, onImpact: () => void): void;
  shake(ids: readonly TileId[]): void;
  clear(): void;                // drop every live effect (Undo / Shuffle / new game)
  get busy(): boolean;          // QA/debug handle only
}
```

- `FlyingTile = { display: Container; from: Rect }` — the display object is
  built by the renderer (below) so a flying copy is pixel-identical to the tile
  that was on the board a frame earlier.
- One entry per live effect in a list; the ticker walks the list each frame,
  evaluates `anim.ts`, writes transforms, and drops finished entries
  (destroying their containers). Concurrent matches are independent entries —
  nothing queues, nothing awaits.
- `shake` entries resolve their target through `tileNode(id)` **every frame**,
  so a redraw that rebuilds the board mid-shake does not break the effect; a
  lookup that returns `undefined` (tile gone) drops the entry silently.
- `reduced` is read per effect at start time, so flipping the setting takes
  effect on the next match with nothing to rewire (same pattern as `Feedback`).

### Changes to `ui/src/render.ts`

- Extract the per-tile body of `draw()` into
  `private buildTile(tile, state): Container` — shadow sprite, side
  bands, face, ink, tag, exactly as today, parented to one container.
- `draw()` adds each to `boardLayer` and records `Map<TileId, Container>`.
- `tileNode(id): Container | undefined` — the shake target.
- `detachedTile(id, game): Container | undefined` — builds a *fresh* container
  for a tile by id (`board.get()` still resolves removed tiles), used for the
  flying copies. Always painted at full brightness, top-layer shade: it has
  left the stack.
- `effects: Container` accessor for the `Animator`.
- `layoutToViewport()` / `toBoardPoint()` / `toCssPoint()` move to `viewport`.

No change to depth cues, pip art, or the baked shadow texture (issue #45).

### Changes to `ui/src/feedback.ts`

Split `cue()` into `sound(cue)` and `haptic(cue)`, each gated on its own
setting; `cue()` stays as `sound() + haptic()` for select / mismatch / blocked.
Only the match path calls the two separately.

### Changes to `ui/src/settings.ts`

Add `reducedMotion: boolean`, default `false`, parsed with the existing
per-field fallback. New checkbox in the settings panel (`index.html`), wired in
`main.ts` like the other toggles, announced like the others.

### Changes to `ui/src/main.ts`

- Construct the `Animator` after the renderer; `reduced` reads
  `settings.value.reducedMotion || prefersReducedMotion()`, where
  `prefersReducedMotion()` is a `matchMedia` read guarded for absence.
- In `applyTap`, on `matched`:
  1. build the two flying copies (`renderer.detachedTile`) **before** `redraw()`;
  2. `feedback.sound('match')`;
  3. `redraw()` — board is already without them;
  4. `animator.playMatch(a, b, () => feedback.haptic('match'))`.
  The existing `announce()` and `persist()` calls do not move: the screen-reader
  announcement stays at match time, not gated behind the animation.
- On `mismatch` / `blocked`: keep `flashTiles()`, add `animator.shake(ids)`.
- `newGame()` and `useBooster('undo' | 'shuffle')` cancel live effects
  (`animator.clear()`) — a flying copy of a tile that Undo just put back would
  otherwise paint over the restored board.
- Debug handle gains `animator.busy` for the QA harness.

## Data flow / correctness

- **No double-match in flight.** `game.tap()` removes both tiles from the model
  before any animation starts, so hit-testing, the a11y layer and the solver
  never see them again. The property falls out of the existing design; the QA
  harness asserts it rather than code defending it.
- **Input never blocks.** No `await`, no input gating, no timers on the tap
  path. The pointer handler and the a11y buttons behave exactly as today.
- **Rapid matches** overlap as separate list entries; each owns its own copies.
- **Frame loop.** Pixi's `Application` already runs its ticker every frame
  (autoStart); this adds per-frame work only while effects are live, and that
  work is transform writes on ≤ 6 containers plus ≤ 16 particle dots.

## Error handling

Every effect resolves its targets defensively: a missing tile node, a destroyed
container, or a tile id the board no longer knows drops that entry. Nothing on
the ticker throws; nothing on the ticker touches game state.

## Testing

**`ui/test/anim.test.ts`** (new, headless, `node --test` like the rest):
- travel converges: both tiles' `matchFrame` centres meet at the pair midpoint
  at `t = IMPACT_AT`, within a pixel;
- ease is monotone and accelerating (each successive 20 ms slice covers more
  ground than the last);
- `matchDuration(false) < 400`, and the sequence's phases sum to it;
- reduced motion: zero travel at every `t`, `scale` constant 1, flash still
  peaks at impact, `matchDuration(true) = CROSSFADE_MS`;
- `shakeOffset(0) === 0`, `shakeOffset(SHAKE_MS) === 0`, decaying envelope,
  at least two direction changes (it reads as a shake, not a lean);
- `particleBurst` is deterministic per seed, radially spread, and every
  particle's alpha reaches 0 by the end of the fade.

**`ui/qa/e2e-slice.mjs`** (extended, Playwright):
- three consecutive matches driven with no waits: all three resolve, tile count
  drops by six, no tile matched twice;
- a tap issued while `animator.busy` is true is still accepted;
- the live region carries the match announcement in the same task as the tap
  (not after 320 ms);
- reduced-motion run (emulate `prefers-reduced-motion: reduce`): the board
  clears with no tile ever painted outside its own slot rect;
- frame-time sample across a full-board match: p95 ≤ 16.7 ms.

**Existing suites** (`core`, `ui`, bench) stay green; `ui/test/settings.test.ts`
gains the `reducedMotion` default + parse-fallback cases.

## Known gap

The acceptance criterion "60fps on the reference low-end device" cannot be
verified here — no such device is available. This work asserts the frame budget
in the headless harness on the dev machine; the device-matrix check stays
Phase 5 audit scope, where the roadmap already places the #44 audit.

## Out of scope

Falling / settling tiles after a removal, combo visuals (Super Combo is its own
ticket), audio changes beyond the sound/haptic split, and any change to the
depth cues shipped in #45.
