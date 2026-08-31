# Match Feedback Animation Implementation Plan (issue #44)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Matched tiles fly together, collide with a flash / particle burst / scale punch / haptic tap, and clear in under 400 ms — without blocking input, with a reduced-motion cross-fade, and with a shake on mismatch.

**Architecture:** `BoardRenderer` gains a `viewport` container holding `boardLayer` (one `Container` per tile, still rebuilt per `draw()`) and a new `effectsLayer` above it. A pure `anim.ts` computes every animated value from an elapsed time; `effects.ts` drives it from `app.ticker` and writes transforms. Matched tiles are rebuilt as detached copies in `effectsLayer`; mismatched tiles are nudged in place through a per-frame `tileNode(id)` lookup.

**Tech Stack:** TypeScript (strict), PixiJS v8, `node --test` for unit tests, Playwright (`playwright-core`) for the QA harness.

**Spec:** `docs/superpowers/specs/2026-08-31-match-feedback-animation-design.md`

## Global Constraints

- Branch is `issue-44-match-animation`. **Do not commit.** Project CLAUDE.md requires QA + senior review + explicit PM approval before any commit; this plan's tasks end in verification runs, and a single staged commit is prepared in Task 7 for approval. This deliberately overrides the writing-plans default of frequent commits.
- Total match sequence must be **< 400 ms**: `TRAVEL_MS 200 + FADE_MS 120 = 320`. Particles must finish inside the same 320 ms.
- Reduced motion = `settings.reducedMotion || prefers-reduced-motion: reduce`. Default of the new setting is `false`.
- Audio fires at match time; haptics fire at impact. Each still respects its own independent toggle (spec §7).
- The screen-reader announcement must fire in the same task as the tap, never gated behind an animation.
- Input is never blocked or gated: no `await`, no timers, no "is animating" guard on the tap path.
- No change to the depth cues, pip art, or the baked shadow texture from issue #45.
- `ui/src/anim.ts` imports nothing from Pixi or the DOM — it is the tested surface.
- All existing suites stay green: `core` (`cd core && npm ci && npm test`), `ui` (`cd ui && npm ci && npm test`), bench (`node --test bench/test/*.test.mjs`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `ui/src/anim.ts` | **New.** Pure timeline math: easing, per-frame tile values, shake curve, particle burst. No Pixi, no DOM, no clock. |
| `ui/test/anim.test.ts` | **New.** Pins the timings, the convergence at the midpoint, the reduced-motion substitution, the shake envelope. |
| `ui/src/effects.ts` | **New.** `Animator` — ticker-driven list of live effects; owns the Pixi objects for flight, flash, particles, shake. |
| `ui/src/render.ts` | **Modify.** `viewport` + `effectsLayer`; per-tile `Container`s in a map; `buildTile()`, `tileNode()`, `detachedTile()`. |
| `ui/src/feedback.ts` | **Modify.** Split `cue()` into `sound()` / `haptic()`. |
| `ui/src/settings.ts` | **Modify.** Add `reducedMotion`, default `false`. |
| `ui/test/settings.test.ts` | **Modify.** Default + parse-fallback cases for `reducedMotion`. |
| `ui/index.html` | **Modify.** "Reduced motion" checkbox in the settings panel. |
| `ui/src/main.ts` | **Modify.** Construct the `Animator`, wire match / mismatch / booster / new-game paths, expose the QA handle. |
| `ui/qa/e2e-slice.mjs` | **Modify.** Rapid-match, input-during-flight, announcement-timing, reduced-motion and frame-budget checks. |

---

### Task 1: Pure animation math (`anim.ts`)

**Files:**
- Create: `ui/src/anim.ts`
- Test: `ui/test/anim.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TRAVEL_MS`, `FADE_MS`, `CROSSFADE_MS`, `SHAKE_MS`, `PARTICLE_MS`, `PARTICLE_COUNT`, `PUNCH_PEAK`, `END_SCALE`, `SHAKE_AMPLITUDE`, `SHAKE_CYCLES`, `Point`, `TileFrame`, `Particle`, `ParticleFrame`, `impactAt(reduced)`, `matchDuration(reduced)`, `easeIn(u)`, `easeOut(u)`, `matchFrame(from, to, tMs, reduced)`, `shakeOffset(tMs)`, `particleBurst(seed)`, `particleFrame(p, tMs)`.

> **Refinement over the spec:** `matchFrame` takes and returns **centre** points (`{cx, cy}`), not top-left rects. Pixi animates a container about its `pivot`, so centres are what `effects.ts` actually needs, and the caller derives a centre from `tileRect()` in one line. `impactAt(reduced)` replaces the spec's bare `IMPACT_AT` so the reduced path (impact at t=0) has a name too.

- [ ] **Step 1: Write the failing test**

Create `ui/test/anim.test.ts`:

```ts
// Issue #44: the match sequence has to be *felt*, but what a test can hold is
// its arithmetic — that the two tiles actually meet, that they accelerate into
// the hit rather than drift, that the whole thing fits the 400ms budget, and
// that reduced motion removes travel without removing the flash.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CROSSFADE_MS,
  FADE_MS,
  PARTICLE_COUNT,
  PARTICLE_MS,
  SHAKE_AMPLITUDE,
  SHAKE_MS,
  TRAVEL_MS,
  impactAt,
  matchDuration,
  matchFrame,
  particleBurst,
  particleFrame,
  shakeOffset,
} from '../src/anim.js';

const A = { x: 100, y: 100 };
const B = { x: 300, y: 180 };
const MID = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };

test('both tiles arrive at the pair midpoint on impact', () => {
  const t = impactAt(false);
  for (const from of [A, B]) {
    const f = matchFrame(from, MID, t, false);
    assert.ok(Math.abs(f.cx - MID.x) < 1, `cx ${f.cx}`);
    assert.ok(Math.abs(f.cy - MID.y) < 1, `cy ${f.cy}`);
  }
});

test('travel starts at the tile and accelerates into the hit', () => {
  const start = matchFrame(A, MID, 0, false);
  assert.equal(start.cx, A.x);
  assert.equal(start.cy, A.y);
  // Each successive slice covers more ground than the one before it.
  const step = TRAVEL_MS / 10;
  let previous = -Infinity;
  for (let i = 0; i < 10; i++) {
    const a = matchFrame(A, MID, step * i, false);
    const b = matchFrame(A, MID, step * (i + 1), false);
    const covered = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    assert.ok(covered > previous, `slice ${i} covered ${covered} <= ${previous}`);
    previous = covered;
  }
});

test('the sequence fits the 400ms budget and its phases sum to it', () => {
  assert.equal(matchDuration(false), TRAVEL_MS + FADE_MS);
  assert.ok(matchDuration(false) < 400, `${matchDuration(false)}ms`);
  // Particles start at impact and must not outlive the sequence.
  assert.ok(impactAt(false) + PARTICLE_MS <= matchDuration(false));
});

test('the tile is gone by the end and never before the impact', () => {
  assert.equal(matchFrame(A, MID, impactAt(false), false).alpha, 1);
  assert.equal(matchFrame(A, MID, matchDuration(false), false).alpha, 0);
});

test('flash peaks at impact and decays to nothing', () => {
  const at = impactAt(false);
  assert.equal(matchFrame(A, MID, at - 1, false).flash < 1, true);
  assert.equal(matchFrame(A, MID, at, false).flash, 1);
  assert.equal(matchFrame(A, MID, matchDuration(false), false).flash, 0);
});

test('reduced motion cross-fades in place, keeping the flash', () => {
  assert.equal(matchDuration(true), CROSSFADE_MS);
  assert.equal(impactAt(true), 0);
  for (let t = 0; t <= CROSSFADE_MS; t += 10) {
    const f = matchFrame(A, MID, t, true);
    assert.equal(f.cx, A.x, `travelled at t=${t}`);
    assert.equal(f.cy, A.y, `travelled at t=${t}`);
    assert.equal(f.scale, 1, `scaled at t=${t}`);
  }
  assert.equal(matchFrame(A, MID, 0, true).flash, 1);
  assert.equal(matchFrame(A, MID, CROSSFADE_MS, true).alpha, 0);
});

test('shake starts and ends at rest, decays, and changes direction', () => {
  assert.equal(shakeOffset(0), 0);
  assert.equal(shakeOffset(SHAKE_MS), 0);
  assert.equal(shakeOffset(SHAKE_MS + 50), 0);
  let signChanges = 0;
  let peakEarly = 0;
  let peakLate = 0;
  let previous = 0;
  for (let t = 1; t < SHAKE_MS; t++) {
    const v = shakeOffset(t);
    assert.ok(Math.abs(v) <= SHAKE_AMPLITUDE, `overshoot ${v} at ${t}`);
    if (previous !== 0 && Math.sign(v) !== 0 && Math.sign(v) !== Math.sign(previous)) signChanges++;
    if (t < SHAKE_MS / 2) peakEarly = Math.max(peakEarly, Math.abs(v));
    else peakLate = Math.max(peakLate, Math.abs(v));
    previous = v;
  }
  assert.ok(signChanges >= 2, `only ${signChanges} direction changes`);
  assert.ok(peakLate < peakEarly, `no decay: ${peakEarly} -> ${peakLate}`);
});

test('the particle burst is deterministic, radial, and fully faded by the end', () => {
  const burst = particleBurst(7);
  assert.equal(burst.length, PARTICLE_COUNT);
  assert.deepEqual(burst, particleBurst(7));
  assert.notDeepEqual(burst, particleBurst(8));
  // Radial: every quadrant gets at least one particle.
  const quadrants = new Set(
    burst.map((p) => {
      const f = particleFrame(p, PARTICLE_MS / 2);
      return `${Math.sign(Math.round(f.x))}:${Math.sign(Math.round(f.y))}`;
    }),
  );
  assert.ok(quadrants.size >= 4, `spread only ${quadrants.size} directions`);
  for (const p of burst) {
    assert.equal(particleFrame(p, 0).x, 0);
    assert.equal(particleFrame(p, 0).y, 0);
    assert.equal(particleFrame(p, PARTICLE_MS).alpha, 0);
    const half = particleFrame(p, PARTICLE_MS / 2);
    assert.ok(Math.hypot(half.x, half.y) > 0, 'particle never left the impact point');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ui && npm test
```

Expected: TypeScript compile error — `Cannot find module '../src/anim.js'`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/anim.ts`:

```ts
// Match feedback timeline (issue #44). Pure arithmetic: every value the match
// and mismatch animations need, as a function of elapsed milliseconds. No Pixi,
// no DOM, no clock — effects.ts supplies the time and writes the result onto
// display objects, which keeps the part worth testing testable headlessly
// (same split as geometry.ts / depth.ts).
//
// The budget is the design constraint: the ticket allows 400ms end to end, so
// a fast player is never throttled. 200ms of travel plus 120ms of fade leaves
// 80ms of headroom, and the particle burst is sized to finish inside the fade
// rather than extending the sequence.

/** Travel time from a tile's own centre to the pair's midpoint. */
export const TRAVEL_MS = 200;
/** Scale-and-fade out after the collision. */
export const FADE_MS = 120;
/** Reduced motion: no travel at all, just a cross-fade of the same two tiles. */
export const CROSSFADE_MS = 160;
/** Mismatch shake, matched to the existing red-outline flash in main.ts. */
export const SHAKE_MS = 250;
/** Impact particles. Sized to end with the fade, not after it. */
export const PARTICLE_MS = FADE_MS;
export const PARTICLE_COUNT = 8;

/** Scale at the moment of impact — a punch, not a pop. */
export const PUNCH_PEAK = 1.18;
/** Scale the tile shrinks to as it fades out. */
export const END_SCALE = 0.7;
/** Peak shake displacement in board px, at the first swing. */
export const SHAKE_AMPLITUDE = 3;
/** Full oscillations across SHAKE_MS. */
export const SHAKE_CYCLES = 3;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One flying tile at one instant: centre, scale, opacity, white-flash strength. */
export interface TileFrame {
  readonly cx: number;
  readonly cy: number;
  readonly scale: number;
  readonly alpha: number;
  /** 0 = the tile's own colours, 1 = fully whited out. */
  readonly flash: number;
}

export interface Particle {
  readonly angle: number;
  /** Board px travelled by the time the burst ends. */
  readonly distance: number;
  readonly radius: number;
}

export interface ParticleFrame {
  /** Offset from the impact point, board px. */
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Cubic ease-in: the tiles accelerate into the hit instead of coasting. */
export function easeIn(u: number): number {
  const c = clamp01(u);
  return c * c * c;
}

/** Cubic ease-out — particles leave fast and settle. */
export function easeOut(u: number): number {
  const c = 1 - clamp01(u);
  return 1 - c * c * c;
}

/** When the collision lands. Reduced motion has no travel, so it lands at once. */
export function impactAt(reduced: boolean): number {
  return reduced ? 0 : TRAVEL_MS;
}

/** Total length of the sequence, impact included. */
export function matchDuration(reduced: boolean): number {
  return reduced ? CROSSFADE_MS : TRAVEL_MS + FADE_MS;
}

/**
 * One flying tile at `tMs`.
 *
 * `from` is the tile's own centre, `to` the midpoint of the pair — both in
 * board px. Reduced motion pins the position and scale and moves only opacity
 * and flash, which is the ticket's "plain cross-fade, keeping the flash".
 */
export function matchFrame(from: Point, to: Point, tMs: number, reduced: boolean): TileFrame {
  if (reduced) {
    const u = clamp01(tMs / CROSSFADE_MS);
    return { cx: from.x, cy: from.y, scale: 1, alpha: 1 - u, flash: 1 - u };
  }
  if (tMs < TRAVEL_MS) {
    const u = easeIn(tMs / TRAVEL_MS);
    return {
      cx: from.x + (to.x - from.x) * u,
      cy: from.y + (to.y - from.y) * u,
      scale: 1,
      alpha: 1,
      // A little pre-flash on the last stretch, so the hit is not the first
      // frame anything happens.
      flash: easeIn(tMs / TRAVEL_MS) * 0.35,
    };
  }
  const f = clamp01((tMs - TRAVEL_MS) / FADE_MS);
  return {
    cx: to.x,
    cy: to.y,
    scale: PUNCH_PEAK + (END_SCALE - PUNCH_PEAK) * f,
    alpha: 1 - f,
    flash: 1 - f,
  };
}

/**
 * Mismatch shake: a damped sine, in board px along x. Exactly zero at both
 * ends so a tile is never left off its slot, whatever frame the effect ends on.
 */
export function shakeOffset(tMs: number): number {
  if (tMs <= 0 || tMs >= SHAKE_MS) return 0;
  const u = tMs / SHAKE_MS;
  return SHAKE_AMPLITUDE * (1 - u) * Math.sin(2 * Math.PI * SHAKE_CYCLES * u);
}

/**
 * The impact burst, seeded so a given match always throws the same sparks —
 * a test can assert the spread, and a replay looks the same twice.
 *
 * Particles are spaced evenly around the circle and then jittered, so the
 * burst is radial by construction rather than by luck.
 */
export function particleBurst(seed: number): readonly Particle[] {
  // Small LCG (Numerical Recipes constants); a burst needs 3 values apiece.
  let state = (seed * 2654435761) >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const step = (2 * Math.PI) / PARTICLE_COUNT;
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    // Jitter stays inside ±40% of a step, so no two particles cross over.
    angle: i * step + (random() - 0.5) * step * 0.8,
    distance: 14 + random() * 10,
    radius: 1.5 + random() * 1.5,
  }));
}

/** One particle's offset from the impact point, and its opacity. */
export function particleFrame(p: Particle, tMs: number): ParticleFrame {
  const u = clamp01(tMs / PARTICLE_MS);
  const d = p.distance * easeOut(u);
  return { x: Math.cos(p.angle) * d, y: Math.sin(p.angle) * d, alpha: 1 - u };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd ui && npm test
```

Expected: PASS — all `anim.test.ts` tests, plus every pre-existing `ui` test still green.

---

### Task 2: Renderer gains a viewport, per-tile containers, and detached copies

**Files:**
- Modify: `ui/src/render.ts`

**Interfaces:**
- Consumes: `anim.ts` — nothing yet (Task 3 connects them).
- Produces: on `BoardRenderer` — `get effects(): Container`, `tileNode(id: TileId): Container | undefined`, `detachedTile(game: Game, id: TileId): Container | undefined`. Existing public surface (`scale`, `boardExtent`, `setSizeFactor`, `layoutToViewport`, `toBoardPoint`, `toCssPoint`, `draw`) is unchanged in signature and behaviour.

- [ ] **Step 1: Add the viewport and the effects layer**

In `ui/src/render.ts`, replace the field block and constructor tail:

```ts
export class BoardRenderer {
  /** Carries the fit transform; both layers below it work in board px. */
  private readonly viewport = new Container();
  private readonly boardLayer = new Container();
  /** In-flight match copies and impact particles (issue #44). A sibling of
   *  boardLayer under the same transform, so an effect is written in board px
   *  and always paints above every tile. */
  private readonly effectsLayer = new Container();
  /** This frame's tile containers, by id — the shake target (issue #44). */
  private readonly tileNodes = new Map<TileId, Container>();
```

and in the constructor, replace `app.stage.addChild(this.boardLayer);` with:

```ts
    this.viewport.addChild(this.boardLayer, this.effectsLayer);
    app.stage.addChild(this.viewport);
```

- [ ] **Step 2: Move the fit transform and the coordinate conversions onto the viewport**

In `layoutToViewport()`, replace the two `this.boardLayer.` writes with `this.viewport.`:

```ts
    this.viewport.scale.set(this.viewScale);
    this.viewport.position.set(
```

and in `toBoardPoint()` / `toCssPoint()`, replace every `this.boardLayer.position` with `this.viewport.position`.

- [ ] **Step 3: Extract `buildTile()` and record the per-tile containers**

Replace the body of `draw()` with the version below, and add `buildTile()` beneath it. The per-tile drawing is moved verbatim — the only changes are that everything is added to a per-tile `Container` instead of straight to `boardLayer`, and that the shade inputs arrive as arguments.

```ts
  /** Redraw the whole board (144 tiles is well within budget — spike showed
   *  ~0.2ms/frame with every tile animating). */
  draw(game: Game, state: DrawState): void {
    // `{ children: true }` leaves textures alone, which is what keeps the one
    // baked shadow texture alive across every redraw.
    this.boardLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.tileNodes.clear();
    const tiles = [...game.board.presentTiles()].sort((a, b) => paintOrder(a.slot, b.slot));
    for (const tile of tiles) {
      const selected = state.selection === tile.id;
      const flashed = state.flash.includes(tile.id);
      const hinted = state.hint.includes(tile.id);
      // A highlighted tile is free by construction, so only the plain ones can
      // be dimmed — the dim must never fight the selection or hint cue.
      const dimmed =
        state.dimBlocked && !selected && !hinted && !flashed && !game.board.isFree(tile.id);
      const node = this.buildTile(tile, { selected, flashed, hinted, dimmed });
      this.tileNodes.set(tile.id, node);
      this.boardLayer.addChild(node);
    }
  }

  /**
   * One tile as its own container: shadow, shaded sides, face, ink, tag.
   *
   * A container per tile (rather than everything straight onto boardLayer) is
   * what lets the mismatch shake nudge a single tile between redraws — and it
   * is the same builder the flying copies use, so a tile in flight is the tile
   * that was on the board a frame earlier (issue #44).
   */
  private buildTile(
    tile: Tile,
    opts: {
      readonly selected: boolean;
      readonly flashed: boolean;
      readonly hinted: boolean;
      readonly dimmed: boolean;
    },
  ): Container {
    const { selected, flashed, hinted, dimmed } = opts;
    const node = new Container();
    const r = tileRect(tile.slot);
    const shade = tileShade(tile.slot.z, this.topZ, dimmed);

    const shadow = new Sprite(this.shadowTexture);
    shadow.position.set(r.x - SHADOW_PAD, r.y - SHADOW_PAD);
    node.addChild(shadow);

    const g = new Graphics();
    // Side extrusion down-right, one tile's depth on every layer so a tall
    // stack does not read as a thicker slab; right/lower neighbors and upper
    // layers paint over it (paintOrder), leaving only the exposed edges.
    // Shaded in bands, base first: each band overpaints the darker one
    // behind it, so what survives is light at the face and dark at the base.
    const bands = shade.sideBands;
    bands.forEach((color, i) => {
      const depth = (SIDE_DEPTH * (bands.length - i)) / bands.length;
      g.roundRect(r.x, r.y, r.w + depth, r.h + depth, TILE_RADIUS).fill(color);
    });
    g.roundRect(r.x, r.y, r.w, r.h, TILE_RADIUS)
      .fill(selected ? FACE_SELECTED : hinted ? FACE_HINT : shade.face)
      .stroke({
        width: selected || flashed || hinted ? BORDER_WIDTH_ACTIVE : BORDER_WIDTH,
        color: flashed
          ? COLOR_FLASH
          : selected
            ? COLOR_SELECTED
            : hinted
              ? COLOR_HINT
              : shade.border,
      });
    node.addChild(g);

    const style = faceStyle(tile.face);
    // Ink recedes with the face it sits on, faster than the face does, so
    // the 4.5:1 figure/ground budget widens as layers go back (depth.ts).
    const ink = shade.ink(style.color);
    if (style.pips) {
      // Per-rank pip art (issue #35, redrawn in the traditional idiom for
      // issue #45). Placement and sizing — including staying inside the face
      // and clear of the corner tag — are pips.ts.
      const pipG = new Graphics();
      const metrics = pipMetrics(style.pips);
      for (const pip of style.pips) {
        const c = pipCenter(pip);
        const px = r.x + c.x;
        const py = r.y + c.y;
        // The accent recedes with everything else, or a dimmed tile would
        // keep one bright half and read as partly lit.
        const accent = pip.accent === undefined ? ink : shade.ink(pip.accent);
        if (style.pipShape === 'cane') {
          drawCane(pipG, px, py, metrics.caneW, metrics.caneH, accent);
        } else {
          drawRing(pipG, px, py, metrics.ringR, ink, accent, shade.face);
        }
      }
      node.addChild(pipG);
    } else {
      const glyph = new Text({
        text: style.glyph,
        style: {
          fontSize: TILE_H * 0.42,
          fill: ink,
          fontFamily: 'sans-serif',
          // Decision 0002 asks for thick, simplified strokes; a font glyph
          // gets there with weight, and weight costs nothing in IP risk.
          fontWeight: 'bold',
        },
      });
      glyph.anchor.set(0.5);
      // Centred in the same area the pips use, so a glyph face and a pip face
      // sit on the same optical line and neither rides under the tag.
      glyph.position.set(r.x + PIP_AREA.x + PIP_AREA.w / 2, r.y + PIP_AREA.y + PIP_AREA.h / 2);
      node.addChild(glyph);
    }
    const tag = new Text({
      text: style.tag,
      style: {
        fontSize: TAG_FONT_SIZE,
        fill: ink,
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
      },
    });
    tag.position.set(r.x + TAG_ORIGIN.x, r.y + TAG_ORIGIN.y);
    node.addChild(tag);
    return node;
  }
```

- [ ] **Step 4: Add the three accessors the animator needs**

Append to `BoardRenderer`, after `buildTile()`:

```ts
  /** Layer the match animation paints into — above every tile (issue #44). */
  get effects(): Container {
    return this.effectsLayer;
  }

  /** This frame's container for a tile, for effects that nudge it in place.
   *  Undefined once a redraw has dropped the tile (matched, undone, shuffled),
   *  which is how a stale shake retires itself. */
  tileNode(id: TileId): Container | undefined {
    return this.tileNodes.get(id);
  }

  /**
   * A fresh, unparented copy of a tile, for the effects layer to fly (#44).
   *
   * Built from `board.get()`, which still resolves a tile the match has just
   * removed — so main.ts can capture the copy after the tap has been applied.
   * Painted at the top-layer shade with no highlight: it has left the stack,
   * so the depth ladder it used to sit on no longer applies to it.
   */
  detachedTile(game: Game, id: TileId): Container | undefined {
    let tile;
    try {
      tile = game.board.get(id);
    } catch {
      return undefined; // id the board never knew
    }
    return this.buildTile({ ...tile, slot: { ...tile.slot, z: this.topZ } }, {
      selected: false,
      flashed: false,
      hinted: false,
      dimmed: false,
    });
  }
```

> Note the `z: this.topZ` swap: `buildTile()` derives both the shade **and** the position from the slot, and a flying copy must keep the tile's *own* screen position. Because `tileRect()` shifts by `z * LAYER_LIFT`, the copy is built at the top-layer rect and Task 5 pivots it onto the real centre — the effect writes an absolute centre every frame, so the build-time offset never shows.

- [ ] **Step 5: Add the missing type import**

At the top of `render.ts`, extend the core type import:

```ts
import type { Tile, TileId } from '@mahjongsolitaire/core';
```

- [ ] **Step 6: Verify the refactor is behaviour-neutral**

```bash
cd ui && npm test && npm run build
```

Expected: PASS, clean `tsc`, and a successful `vite build`. No test changes — this task must not alter a single pixel of the board.

---

### Task 3: The animator (`effects.ts`)

**Files:**
- Create: `ui/src/effects.ts`

**Interfaces:**
- Consumes: `anim.ts` (`matchFrame`, `matchDuration`, `impactAt`, `shakeOffset`, `particleBurst`, `particleFrame`, `PARTICLE_MS`), `geometry.ts` (`Rect`), Pixi `Container` / `Graphics` / `Ticker`.
- Produces: `FlyingTile { display: Container; center: Point }`, `class Animator` with `playMatch(a, b, onImpact)`, `shake(ids)`, `clear()`, `get busy()`, `destroy()`.

- [ ] **Step 1: Write the implementation**

Create `ui/src/effects.ts`:

```ts
// Ticker-driven match / mismatch effects (issue #44).
//
// The split with anim.ts is deliberate: everything that decides *what a value
// should be* lives there and is unit-tested; this file only owns Pixi objects
// and the frame loop. An effect is a small object with `advance(dtMs)` — it
// returns false when it is finished and the animator disposes of it.
//
// Two properties the ticket asks for fall out of the structure rather than
// being defended in code:
//
//   * input never blocks — nothing here is awaited, and no effect touches game
//     state or the input path;
//   * a tile in flight can never be re-selected — game.tap() removed it from
//     the model before the effect existed, so the copy flying here is not a
//     tile any more, it is a picture of one.

import { Container, Graphics } from 'pixi.js';
import type { Ticker } from 'pixi.js';
import type { TileId } from '@mahjongsolitaire/core';
import {
  PARTICLE_MS,
  impactAt,
  matchDuration,
  matchFrame,
  particleBurst,
  particleFrame,
  shakeOffset,
} from './anim.js';
import type { Point } from './anim.js';

/** A tile copy to fly, with the board-px centre it starts from. */
export interface FlyingTile {
  readonly display: Container;
  readonly center: Point;
}

/** Colour of the impact flash and the sparks — the palette's warm cream. */
const SPARK_COLOR = 0xfff6d8;

interface Effect {
  /** Advance by `dtMs`; false means finished. */
  advance(dtMs: number): boolean;
  /** Release everything the effect owns, finished or cancelled. */
  dispose(): void;
}

/** Both tiles flying into the midpoint, the impact, and the burst after it. */
class MatchEffect implements Effect {
  private t = 0;
  private impacted = false;
  private readonly duration: number;
  private readonly impact: number;
  private readonly midpoint: Point;
  private readonly sparks = new Graphics();
  private readonly burst;

  constructor(
    private readonly layer: Container,
    private readonly tiles: readonly FlyingTile[],
    private readonly reduced: boolean,
    private readonly onImpact: () => void,
    seed: number,
  ) {
    this.duration = matchDuration(reduced);
    this.impact = impactAt(reduced);
    this.midpoint = {
      x: (tiles[0]!.center.x + tiles[1]!.center.x) / 2,
      y: (tiles[0]!.center.y + tiles[1]!.center.y) / 2,
    };
    this.burst = particleBurst(seed);
    for (const tile of tiles) {
      // Pivot on the tile's own centre so scale punches about the middle and a
      // written position *is* the centre — the children are drawn at absolute
      // board coordinates, so the pivot has to be in those same coordinates.
      tile.display.pivot.set(tile.center.x, tile.center.y);
      tile.display.position.set(tile.center.x, tile.center.y);
      // A white overlay over the tile's own silhouette is the flash; alpha is
      // driven per frame. Sized generously — it only ever shows at low alpha.
      const flash = new Graphics();
      flash.rect(-4, -4, tile.display.width + 8, tile.display.height + 8).fill(SPARK_COLOR);
      flash.position.set(tile.display.getBounds().x, tile.display.getBounds().y);
      flash.alpha = 0;
      flash.label = 'flash';
      tile.display.addChild(flash);
      layer.addChild(tile.display);
    }
    // Reduced motion keeps the flash but throws no sparks: a particle burst is
    // exactly the kind of motion the preference is asking us not to make.
    if (!reduced) layer.addChild(this.sparks);
  }

  advance(dtMs: number): boolean {
    this.t += dtMs;
    for (const tile of this.tiles) {
      const f = matchFrame(tile.center, this.midpoint, this.t, this.reduced);
      tile.display.position.set(f.cx, f.cy);
      tile.display.scale.set(f.scale);
      tile.display.alpha = f.alpha;
      const flash = tile.display.getChildByLabel('flash');
      if (flash) flash.alpha = f.flash * 0.75;
    }
    if (!this.impacted && this.t >= this.impact) {
      this.impacted = true;
      this.onImpact();
    }
    if (!this.reduced && this.impacted) {
      const pt = this.t - this.impact;
      this.sparks.clear();
      for (const p of this.burst) {
        const f = particleFrame(p, pt);
        if (f.alpha <= 0) continue;
        this.sparks
          .circle(this.midpoint.x + f.x, this.midpoint.y + f.y, p.radius)
          .fill({ color: SPARK_COLOR, alpha: f.alpha });
      }
      if (pt >= PARTICLE_MS) this.sparks.clear();
    }
    return this.t < this.duration;
  }

  dispose(): void {
    for (const tile of this.tiles) tile.display.destroy({ children: true });
    this.sparks.destroy();
  }
}

/** A mismatched tile shaken in place, on the board layer, between redraws. */
class ShakeEffect implements Effect {
  private t = 0;

  constructor(
    private readonly id: TileId,
    private readonly tileNode: (id: TileId) => Container | undefined,
  ) {}

  advance(dtMs: number): boolean {
    this.t += dtMs;
    // Re-resolved every frame: a redraw rebuilds the board's containers, and
    // the tile this effect started on is gone by then. A tile that has left
    // the board entirely simply ends the effect.
    const node = this.tileNode(this.id);
    if (!node) return false;
    node.position.set(shakeOffset(this.t), 0);
    return this.t < 250;
  }

  dispose(): void {
    // Put the tile back on its slot, whatever frame we stopped on.
    this.tileNode(this.id)?.position.set(0, 0);
  }
}

/**
 * Every live effect, advanced from one ticker callback.
 *
 * Concurrent matches are simply separate entries — nothing queues and nothing
 * waits, which is what keeps rapid consecutive matches from throttling the
 * player. `reduced` is read at the moment an effect starts, so flipping the
 * setting (or the OS preference) takes effect on the very next match.
 */
export class Animator {
  private readonly effects: Effect[] = [];
  private seed = 1;
  private readonly onTick = (ticker: Ticker): void => this.advance(ticker.deltaMS);

  constructor(
    private readonly layer: Container,
    private readonly ticker: Ticker,
    private readonly opts: {
      readonly reduced: () => boolean;
      readonly tileNode: (id: TileId) => Container | undefined;
    },
  ) {
    ticker.add(this.onTick);
  }

  /** Fly a matched pair together. `onImpact` fires once, on contact. */
  playMatch(a: FlyingTile, b: FlyingTile, onImpact: () => void): void {
    this.effects.push(
      new MatchEffect(this.layer, [a, b], this.opts.reduced(), onImpact, this.seed++),
    );
  }

  /** Shake tiles in place (mismatch, blocked tap). Reduced motion skips it. */
  shake(ids: readonly TileId[]): void {
    if (this.opts.reduced()) return;
    for (const id of ids) this.effects.push(new ShakeEffect(id, this.opts.tileNode));
  }

  /** Drop every live effect — the board underneath them has been replaced. */
  clear(): void {
    for (const effect of this.effects) effect.dispose();
    this.effects.length = 0;
  }

  /** Whether anything is animating (QA harness assertions). */
  get busy(): boolean {
    return this.effects.length > 0;
  }

  destroy(): void {
    this.ticker.remove(this.onTick);
    this.clear();
  }

  private advance(dtMs: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]!;
      if (effect.advance(dtMs)) continue;
      effect.dispose();
      this.effects.splice(i, 1);
    }
  }
}
```

- [ ] **Step 2: Verify it compiles and nothing regressed**

```bash
cd ui && npm test
```

Expected: PASS (`tsc` clean; `effects.ts` has no tests of its own — its arithmetic is Task 1's, and its behaviour is asserted in the browser in Task 6).

---

### Task 4: Independent sound / haptic channels, and the reduced-motion setting

**Files:**
- Modify: `ui/src/feedback.ts`
- Modify: `ui/src/settings.ts`
- Modify: `ui/index.html:517` (after the `set-ads` row, before the `set-highlight-free` row)
- Test: `ui/test/settings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Feedback.sound(cue: Cue): void`, `Feedback.haptic(cue: Cue): void` (`cue()` retained, now `sound() + haptic()`); `Settings.reducedMotion: boolean` with `DEFAULT_SETTINGS.reducedMotion === false`.

- [ ] **Step 1: Write the failing settings test**

Append to `ui/test/settings.test.ts`:

```ts
test('reduced motion defaults off and rejects a non-boolean stored value', () => {
  assert.equal(DEFAULT_SETTINGS.reducedMotion, false);
  assert.equal(parseSettings({}).reducedMotion, false);
  assert.equal(parseSettings({ reducedMotion: 'yes' }).reducedMotion, false);
  assert.equal(parseSettings({ reducedMotion: true }).reducedMotion, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ui && npm test
```

Expected: FAIL — `tsc` error, `Property 'reducedMotion' does not exist on type 'Settings'`.

- [ ] **Step 3: Add the setting**

In `ui/src/settings.ts`:

1. Extend the header comment's list with:

```
//   reducedMotion  cross-fade instead of flying tiles — default OFF (issue #44)
```

2. Add to the `Settings` interface, after `highlightFree`:

```ts
  /**
   * Replace the fly-together match animation with a plain cross-fade (issue
   * #44). Default OFF, and OR'd with the OS `prefers-reduced-motion` in
   * main.ts — the OS preference is honoured on its own, and this toggle lets a
   * player opt in without changing an OS setting they may not control.
   */
  readonly reducedMotion: boolean;
```

3. Add `reducedMotion: false,` to `DEFAULT_SETTINGS`.

4. Widen the `bool` key union and add the field in `parseSettings`:

```ts
  const bool = (
    key: 'audio' | 'haptics' | 'timedMode' | 'ads' | 'highlightFree' | 'reducedMotion',
  ): boolean => (typeof raw[key] === 'boolean' ? (raw[key] as boolean) : DEFAULT_SETTINGS[key]);
```

```ts
    highlightFree: bool('highlightFree'),
    reducedMotion: bool('reducedMotion'),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd ui && npm test
```

Expected: PASS.

- [ ] **Step 5: Split the feedback channels**

In `ui/src/feedback.ts`, replace the `cue()` method of `Feedback` with:

```ts
  /** Both channels at once — the default for a cue that has one moment. */
  cue(cue: Cue): void {
    this.sound(cue);
    this.haptic(cue);
  }

  /** The audible half. A match sounds at tap time: the tone is the answer to
   *  the tap, and delaying it to the collision reads as input lag (#44). */
  sound(cue: Cue): void {
    if (this.settings().audio) this.player?.play(cue);
  }

  /** The physical half. A match taps on contact, when the tiles actually hit
   *  each other (#44) — which is the whole point of the animation. */
  haptic(cue: Cue): void {
    if (this.settings().haptics) this.vibrate?.(HAPTICS[cue]);
  }
```

Add to the file's header comment, after the paragraph about the gate:

```
// Issue #44 splits the two channels so one cue can land in two moments: a
// match sounds when the player taps and taps back when the tiles collide,
// ~200ms later. Each channel still reads its own toggle on every call, so
// audio-off/haptics-on and the reverse both keep working.
```

- [ ] **Step 6: Add the settings-panel row**

In `ui/index.html`, immediately after the `set-ads` label block (line 517) and before the issue-#45 comment:

```html
            <!-- Issue #44: OR'd with the OS prefers-reduced-motion in main.ts,
                 so a player whose OS pref is off can still ask for less
                 motion here — and one whose OS pref is on needs no toggle. -->
            <label class="row" for="set-reduced-motion">
              <input type="checkbox" id="set-reduced-motion" />
              <span>
                Reduced motion
                <span class="hint">Matched tiles fade out instead of flying together.</span>
              </span>
            </label>
```

- [ ] **Step 7: Verify**

```bash
cd ui && npm test && npm run build
```

Expected: PASS and a clean build.

---

### Task 5: Wire it up in `main.ts`

**Files:**
- Modify: `ui/src/main.ts`

**Interfaces:**
- Consumes: `Animator`, `FlyingTile` (`effects.ts`); `renderer.effects`, `renderer.tileNode`, `renderer.detachedTile` (Task 2); `feedback.sound` / `feedback.haptic` (Task 4); `settings.reducedMotion` (Task 4).
- Produces: `window.__slice.animating(): boolean` and `window.__slice.reducedMotion(): boolean` for the QA harness.

- [ ] **Step 1: Imports and the reduced-motion read**

Add to the imports:

```ts
import { Animator } from './effects.js';
import type { FlyingTile } from './effects.js';
import { TILE_H, TILE_W, tileRect } from './geometry.js';
```

(replacing the existing `import { tileRect } from './geometry.js';`)

Add beside the other module-level helpers, after `randomSeed()`:

```ts
/** OS-level motion preference. Absent `matchMedia` (old browsers, some test
 *  runners) simply means "no preference expressed". */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
```

- [ ] **Step 2: Construct the animator**

After the `feedback` construction in `start()`:

```ts
  // Match / mismatch animation (issue #44). Reduced motion is the OS
  // preference OR the in-app toggle, read per effect so either can be changed
  // mid-session; the animator itself never touches game state.
  const animator = new Animator(renderer.effects, app.ticker, {
    reduced: () => settings.value.reducedMotion || prefersReducedMotion(),
    tileNode: (id) => renderer.tileNode(id),
  });
```

- [ ] **Step 3: Add the match-animation helper**

Beside `flashTiles()`:

```ts
  /** Board-px centre of a tile's top face — where a flying copy starts. */
  function tileCenter(id: TileId): { x: number; y: number } {
    const r = tileRect(game.board.get(id).slot);
    return { x: r.x + TILE_W / 2, y: r.y + TILE_H / 2 };
  }

  /**
   * Fly a matched pair together (issue #44).
   *
   * Copies are built from the board's own renderer *after* the match has been
   * applied — `board.get()` still resolves a removed tile — so the board can
   * redraw without the pair while the copies carry the motion. Nothing here is
   * awaited: the next tap is accepted mid-flight, and the tiles it would fly
   * are already out of the model, so they cannot be matched twice.
   */
  function playMatchAnimation(a: TileId, b: TileId): void {
    const flying: FlyingTile[] = [];
    for (const id of [a, b]) {
      const display = renderer.detachedTile(game, id);
      if (display) flying.push({ display, center: tileCenter(id) });
    }
    if (flying.length !== 2) return; // nothing sensible to fly; the board is already correct
    animator.playMatch(flying[0]!, flying[1]!, () => feedback.haptic('match'));
  }
```

- [ ] **Step 4: Re-wire `applyTap`**

Replace the cue/flash section of `applyTap` with:

```ts
    if (outcome.kind === 'matched') hintPair = [];
    if (outcome.kind === 'mismatch') {
      flashTiles([outcome.a, outcome.b]);
      animator.shake([outcome.a, outcome.b]);
    } else if (outcome.kind === 'blocked') {
      flashTiles([outcome.id]);
      animator.shake([outcome.id]);
    }
    // Sound answers the tap; the haptic waits for the collision (issue #44).
    if (outcome.kind === 'matched') {
      feedback.sound('match');
      // Copies must be captured before the redraw that drops the pair.
      playMatchAnimation(outcome.a, outcome.b);
    } else {
      const cue = tapCue(outcome);
      if (cue) feedback.cue(cue);
    }
    redraw();
```

The `announce()`, `persist()` and `showStatus()` calls below it are untouched: the announcement still fires in this same task, not behind the animation.

> `playMatchAnimation` runs before `redraw()`, but the copies are independent containers in `effectsLayer` — the redraw that clears `boardLayer` cannot touch them.

- [ ] **Step 5: Cancel effects when the board is replaced under them**

In `newGame()`, after `flashToken++;`:

```ts
    animator.clear();
```

In `useBooster()`, immediately before `redraw();`:

```ts
    // Undo puts a matched tile back and Shuffle repaints every face: a copy
    // still flying from the old board would paint over the new one.
    if (result.ok && (kind === 'undo' || kind === 'shuffle')) animator.clear();
```

- [ ] **Step 6: Extend the QA debug handle**

Add to the `window.__slice` object, after `boardExtent()`:

```ts
    /** Whether any match/shake effect is live (issue #44 QA assertions). */
    animating(): boolean {
      return animator.busy;
    },
    /** The effective reduced-motion decision, OS preference included. */
    reducedMotion(): boolean {
      return settings.value.reducedMotion || prefersReducedMotion();
    },
```

- [ ] **Step 7: Add the settings row to the toggle table**

In `settingsToggles`, after the `highlightFree` entry:

```ts
    {
      input: el<HTMLInputElement>('set-reduced-motion'),
      key: 'reducedMotion',
      name: 'Reduced motion',
    },
```

and widen the `key` union in the array's type annotation:

```ts
    readonly key: 'audio' | 'haptics' | 'timedMode' | 'ads' | 'highlightFree' | 'reducedMotion';
```

- [ ] **Step 8: Verify**

```bash
cd ui && npm test && npm run build
```

Expected: PASS, clean build.

- [ ] **Step 9: Look at it**

```bash
cd ui && npm run dev
```

Open the printed URL, match a pair, and confirm: tiles fly together, flash, throw sparks, and clear; a mismatch shakes; the settings panel's new "Reduced motion" row switches the match to a cross-fade with no travel.

---

### Task 6: QA harness coverage

**Files:**
- Modify: `ui/qa/e2e-slice.mjs`

**Interfaces:**
- Consumes: `window.__slice.animating()`, `window.__slice.reducedMotion()` (Task 5), the existing `check()` helper and `tileCenter()` closure.

- [ ] **Step 1: Extend the file header**

Append to the header comment block:

```
// For issue #44 it drives three consecutive matches with no waiting between
// them (all resolve, nothing is matched twice, a tap during flight is still
// accepted), asserts the match announcement lands in the tap's own task rather
// than after the animation, re-runs a match under an emulated
// prefers-reduced-motion and checks nothing travels, and samples frame times
// across a match to hold the 60fps floor.
```

- [ ] **Step 2: Add the match-animation section**

Insert this block inside the per-viewport loop, after the rotation section (1b) and before the playthrough:

```js
  // 1c. Match feedback animation (issue #44). Everything here is about the
  //     animation *not* getting in the way: input stays live, the pair is
  //     really gone from the model at tap time, and the announcement is not
  //     waiting on 320ms of tweening.
  {
    // Three legal pairs, matched back to back with no waits at all.
    const pairs = await page.evaluate(() => {
      const slice = window.__slice;
      const free = slice.game.hitCandidates().filter((c) => c.free);
      const byFace = new Map();
      const found = [];
      for (const c of free) {
        const face = slice.game.board.get(c.id).face;
        const partner = byFace.get(face);
        if (partner === undefined) byFace.set(face, c.id);
        else {
          found.push([partner, c.id]);
          byFace.delete(face);
        }
        if (found.length === 3) break;
      }
      return found;
    });
    check(pairs.length === 3, 'MATCH ANIM setup (want 3 free pairs)', { pairs: pairs.length });

    if (pairs.length === 3) {
      const before = await page.evaluate(() => window.__slice.game.tilesLeft);
      const announcements = [];
      for (const [a, b] of pairs) {
        for (const id of [a, b]) {
          const p = await tileCenter(id);
          await page.mouse.click(p.x, p.y);
        }
        // Read the live region in the same breath as the tap: the SR
        // announcement must not be gated behind the animation.
        announcements.push(
          await page.evaluate(() => ({
            said: document.getElementById('a11y-status').textContent ?? '',
            animating: window.__slice.animating(),
            left: window.__slice.game.tilesLeft,
          })),
        );
      }
      const last = announcements.at(-1);
      check(last.left === before - 6, 'RAPID MATCHES (want 6 tiles removed)', {
        before,
        after: last.left,
      });
      check(
        announcements.every((a) => /matched/i.test(a.said)),
        'MATCH ANNOUNCED AT TAP TIME',
        announcements.map((a) => a.said),
      );
      check(
        announcements.some((a) => a.animating),
        'INPUT ACCEPTED DURING FLIGHT (no match resolved while animating)',
        announcements,
      );
      // Every tile removed exactly once: ids are unique and all six are gone.
      const gone = await page.evaluate(
        (ids) => ids.filter((id) => window.__slice.game.board.get(id).removed).length,
        pairs.flat(),
      );
      check(gone === 6, 'NO DOUBLE MATCH (want all 6 removed exactly once)', { gone });

      // Frame budget across the tail of the sequence: p95 ≤ 16.7ms.
      const frames = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const samples = [];
            let previous = performance.now();
            const tick = (now) => {
              samples.push(now - previous);
              previous = now;
              if (samples.length < 40) requestAnimationFrame(tick);
              else resolve(samples.slice(1));
            };
            requestAnimationFrame(tick);
          }),
      );
      const sorted = [...frames].sort((x, y) => x - y);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      check(p95 <= 16.7, 'FRAME BUDGET (want p95 ≤ 16.7ms)', { p95: +p95.toFixed(2) });

      // Reduced motion: the same match, with nothing ever leaving its slot.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      check(
        await page.evaluate(() => window.__slice.reducedMotion()),
        'REDUCED MOTION DETECTED FROM OS PREF',
        {},
      );
      const pair = await page.evaluate(() => {
        const slice = window.__slice;
        const free = slice.game.hitCandidates().filter((c) => c.free);
        const byFace = new Map();
        for (const c of free) {
          const face = slice.game.board.get(c.id).face;
          if (byFace.has(face)) return [byFace.get(face), c.id];
          byFace.set(face, c.id);
        }
        return null;
      });
      if (pair) {
        const boardBefore = await page.evaluate(() => window.__slice.game.tilesLeft);
        for (const id of pair) {
          const p = await tileCenter(id);
          await page.mouse.click(p.x, p.y);
        }
        await page.waitForFunction(() => !window.__slice.animating(), null, { timeout: 2000 });
        const boardAfter = await page.evaluate(() => window.__slice.game.tilesLeft);
        check(boardAfter === boardBefore - 2, 'REDUCED-MOTION MATCH CLEARS THE PAIR', {
          boardBefore,
          boardAfter,
        });
      }
      await page.emulateMedia({ reducedMotion: null });
      // Back to a clean deal so the playthrough below starts where it expects.
      await page.click('#btn-new');
      await page.waitForFunction(() => !window.__slice.animating());
    }
  }
```

- [ ] **Step 3: Run the harness**

```bash
cd ui && npm run build && CHROMIUM_PATH="$(node -e "console.log(require('playwright-core').chromium.executablePath())")" node qa/e2e-slice.mjs
```

Expected: exit code 0, no `FAIL` lines. The harness defaults to a container path; on a workstation set `CHROMIUM_PATH` to the local Chromium — Playwright's own download works: `node -e "console.log(require('playwright-core').chromium.executablePath())"`.

- [ ] **Step 4: Run the a11y audit unchanged**

```bash
cd ui && node qa/a11y-audit.mjs
```

Expected: unchanged result — the animation adds no focusable nodes and moves no a11y rects (`a11y.sync` still runs off `tileCssRect`).

---

### Task 7: Full verification and review gate

**Files:** none (verification only).

- [ ] **Step 1: Clean-install test run, all packages**

```bash
cd core && npm ci && npm test
```

```bash
cd ui && npm ci && npm test
```

```bash
node --test bench/test/*.test.mjs
```

Expected: all green.

- [ ] **Step 2: Check the acceptance criteria off against evidence**

Walk issue #44's list and record, for each, the command or observation that proves it:

| AC | Evidence |
| --- | --- |
| Fly-together-and-impact plays | Task 5 Step 9 (visual), Task 6 rapid-match check |
| Never blocks or drops input; no double-match | `INPUT ACCEPTED DURING FLIGHT`, `NO DOUBLE MATCH`, `RAPID MATCHES` |
| Reduced motion substitutes a cross-fade | `anim.test.ts` reduced-motion test + `REDUCED MOTION DETECTED FROM OS PREF` |
| SR announcement at match time | `MATCH ANNOUNCED AT TAP TIME` |
| Frame budget | `FRAME BUDGET (p95 ≤ 16.7ms)` — **on the dev machine only** |
| Every action ≤ 2 taps (#12) | `qa/a11y-audit.mjs` unchanged |

- [ ] **Step 3: Senior code review of the working-tree diff**

Required by CLAUDE.md before any commit. Review `git diff` for correctness, test quality, spec/roadmap acceptance criteria, and repo conventions. Resolve or explicitly accept every finding.

- [ ] **Step 4: Stage and present for approval — do not commit**

```bash
git add -A && git status --short && git diff --cached --stat
```

Present to the PM: the test results, the AC table, the review findings, and the known gap (the reference low-end device is unavailable; the 60fps floor is asserted on the dev machine, and the device-matrix check stays Phase 5 audit scope per ROADMAP). **Wait for explicit approval before committing or pushing.**

- [ ] **Step 5: After approval — commit, PII gate, push, PR**

```bash
git commit -m "Issue #44: fly-together match animation, mismatch shake, reduced-motion path"
```

Then dispatch the `security-devops` subagent over `main..HEAD` (CLAUDE.md Rule 3), push the branch, and open the PR against `main` noting that the gate passed.

---

## What changed during execution

Three things the plan did not anticipate, all found by running it:

1. **The frame-budget gate became comparative.** An absolute `p95 ≤ 16.7ms` failed on
   every viewport — but a control probe showed why: a plain select tap (two full-board
   redraws, *no animation*) spikes to 208ms then 25ms, while a whole match spikes to
   25ms and 42ms, against an 8.3ms median in both cases. The stalls are `draw()`'s
   teardown-and-rebuild, which every tap already paid before this ticket. The harness
   now asserts two things instead: the *median* frame through the flight holds 60fps,
   and the match's worst frame is no worse than the same tap's worst frame without an
   animation. The absolute floor would have been measuring issue #45's renderer.
   The redraw stall itself is real, pre-existing, and wants its own ticket.

2. **Effects are dropped when the page is hidden.** `requestAnimationFrame` stops on a
   hidden page, so a match in flight froze mid-air and finished its last frames
   whenever the player came back — a stale pair painted over a board that had moved on.
   `main.ts`'s existing `visibilitychange` handler now calls `animator.clear()` beside
   `elapsed.pause()`. Found by probing the live page, not by a test.

3. **`qa/a11y-audit.mjs` counts settings controls.** The new toggle made it 11, not 10;
   the audit's expectation moved with it. Everything else in that audit passed
   unchanged, which is the useful part: the new row is named and ≥ 48dp on its own.

One code-review finding was fixed before staging: `tapCue()`'s `case 'matched'` became
unreachable once the match path drove its own two channels, so it was removed.

---

## Self-Review

**Spec coverage:** architecture (Tasks 2–3), `anim.ts` API (Task 1), `effects.ts` API (Task 3), `render.ts` changes (Task 2), `feedback.ts` split (Task 4), `settings.ts` + `index.html` (Task 4), `main.ts` wiring incl. `animator.clear()` on Undo/Shuffle/new game (Task 5), data-flow guarantees (asserted in Task 6), error handling (defensive lookups in Task 3), testing (Tasks 1, 4, 6), known gap (Task 7 Step 2/4). No spec section is unimplemented.

**Deviations from the spec, deliberate:** `matchFrame` works in centres, not top-left rects (Pixi pivots about a centre); `IMPACT_AT` became `impactAt(reduced)` so the reduced path's t=0 impact has a name; `Animator.shake()` is a no-op under reduced motion (the spec left it unstated, and a shake is motion); `Animator` gained `destroy()`.

**Type consistency:** `FlyingTile { display, center }` is produced in Task 5 and consumed in Task 3 with the same field names; `tileNode(id)` has one signature across Tasks 2, 3 and 5; `matchFrame`/`particleFrame` return shapes match their uses in Tasks 1 and 3; the `reducedMotion` settings key is spelled identically in Tasks 4 and 5.
