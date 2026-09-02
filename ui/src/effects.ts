// Ticker-driven board effects (issue #44; the match flight moved to the DOM
// tray layer in issue #93 — see tray-fx.ts).
//
// The split with anim.ts is deliberate: everything that decides *what a value
// should be* lives there and is unit-tested; this file only owns Pixi objects
// and the frame loop. An effect is a small object with `advance(dtMs)` — it
// returns false when it is finished and the animator disposes of it.
//
// Input never blocks: nothing here is awaited, and no effect touches game
// state or the input path.

import { Graphics } from 'pixi.js';
import type { Container, Ticker } from 'pixi.js';
import type { TileId } from '@mahjongsolitaire/core';
import {
  FLIP_MS,
  LOSS_WASH_MS,
  SHAKE_MS,
  STUCK_PULSE_MS,
  STUCK_PULSE_STAGGER_MS,
  STUCK_PULSE_START_MS,
  STUCK_WASH_MS,
  cascadeDurationMs,
  cascadeFrame,
  flipScaleX,
  shakeOffset,
  stuckGreyOut,
  stuckPulseAlpha,
  slumpFrame,
  slumpLayout,
} from './anim.js';
import type { Point } from './anim.js';
import type { Rect } from './geometry.js';

/** The deadlock pulse outline's stroke width (issue #122). */
const PULSE_OUTLINE_WIDTH = 3;
/** The near-pair pulse is amber (issue #122) — the holder's last-slot warning
 *  colour, not the Hint booster's blue: a hint says "tap this", this says
 *  "these are why you are stuck". */
const PULSE_COLOR = 0xf59e0b;

interface Effect {
  /** Advance by `dtMs`; false means finished. */
  advance(dtMs: number): boolean;
  /** Release everything the effect owns, finished or cancelled. */
  dispose(): void;
}

/** A tile shaken in place (blocked tap), on the board layer, between redraws. */
class ShakeEffect implements Effect {
  private t = 0;

  constructor(
    private readonly id: TileId,
    private readonly tileNode: (id: TileId) => Container | undefined,
  ) {}

  advance(dtMs: number): boolean {
    this.t += dtMs;
    // Re-resolved every frame: a redraw rebuilds the board's containers, so the
    // one this effect started on is already gone by the next frame. A tile that
    // has left the board entirely simply ends the effect.
    const node = this.tileNode(this.id);
    if (!node) return false;
    node.position.set(shakeOffset(this.t), 0);
    return this.t < SHAKE_MS;
  }

  dispose(): void {
    // Put the tile back on its slot, whatever frame we stopped on.
    this.tileNode(this.id)?.position.set(0, 0);
  }
}

/**
 * A tile unfolding about its own vertical centreline — the reveal / re-conceal
 * flip (issue #64). Like ShakeEffect it drives the live board node between
 * redraws: the redraw at tap time already swapped the art (face or back), so
 * what animates here is only the unfold, and the effect works unchanged in
 * both directions. The node is re-resolved every frame, and a tile that has
 * left the board simply ends the effect.
 */
class FlipEffect implements Effect {
  private t = 0;

  constructor(
    private readonly id: TileId,
    /** The tile's own centre in board px — the unfold's fixed line. */
    private readonly center: Point,
    private readonly tileNode: (id: TileId) => Container | undefined,
  ) {}

  advance(dtMs: number): boolean {
    this.t += dtMs;
    const node = this.tileNode(this.id);
    if (!node) return false;
    // The children are drawn at absolute board coordinates (see MatchEffect),
    // so scaling about the centre means pivoting there and standing back on it.
    node.pivot.set(this.center.x, this.center.y);
    node.position.set(this.center.x, this.center.y);
    node.scale.set(flipScaleX(this.t), 1);
    return this.t < FLIP_MS;
  }

  dispose(): void {
    // Whatever frame we stopped on, leave the tile full-width on its slot.
    const node = this.tileNode(this.id);
    if (!node) return;
    node.scale.set(1, 1);
    node.pivot.set(0, 0);
    node.position.set(0, 0);
  }
}

/**
 * The remaining tile pictures lifting and sweeping off the board, column by
 * column (issue #120's cascade). Decision 0013 means the board is usually
 * already empty at the moment of a win — every pair clears in the holder —
 * so this is generic over whatever `tileNode`s the renderer still has,
 * including none: an empty tile list finishes on its first frame and disposes
 * cleanly. Like ShakeEffect/FlipEffect, nodes are re-resolved every frame and
 * a tile that has left the board simply drops out of the effect.
 */
class CascadeEffect implements Effect {
  private t = 0;
  private readonly total: number;

  constructor(
    private readonly tiles: ReadonlyArray<{ readonly id: TileId; readonly column: number }>,
    private readonly tileNode: (id: TileId) => Container | undefined,
  ) {
    this.total =
      tiles.length === 0 ? 0 : cascadeDurationMs(Math.max(...tiles.map((t) => t.column)) + 1);
  }

  advance(dtMs: number): boolean {
    this.t += dtMs;
    for (const { id, column } of this.tiles) {
      const node = this.tileNode(id);
      if (!node) continue;
      const frame = cascadeFrame(this.t, column);
      node.position.set(frame.dx, frame.dy);
      node.alpha = frame.alpha;
    }
    return this.t < this.total;
  }

  dispose(): void {
    for (const { id } of this.tiles) {
      const node = this.tileNode(id);
      if (!node) continue;
      node.position.set(0, 0);
      node.alpha = 1;
    }
  }
}

/**
 * The remaining board tiles slumping, tilting and losing colour while the
 * holder-full loss's red wash plays over them (issue #121) — deliberately
 * harsher than the win cascade's graceful sweep-off, since a full holder is
 * a hard fail rather than a reward. Desaturation is one filter on the whole
 * board layer (`setDesaturation`) rather than per tile: cheaper, and every
 * slumping tile fades at the same rate regardless, so one shared amount is
 * exactly right. Like the other live-node effects, tiles are re-resolved
 * every frame and one that has left the board simply drops out.
 */
class SlumpEffect implements Effect {
  private t = 0;
  private readonly specs: ReadonlyMap<TileId, ReturnType<typeof slumpLayout>>;

  constructor(
    private readonly tiles: readonly TileId[],
    private readonly tileNode: (id: TileId) => Container | undefined,
    private readonly setDesaturation: (amount: number) => void,
  ) {
    this.specs = new Map(tiles.map((id) => [id, slumpLayout(id)]));
  }

  advance(dtMs: number): boolean {
    this.t += dtMs;
    let saturation = 1;
    for (const id of this.tiles) {
      const spec = this.specs.get(id)!;
      const frame = slumpFrame(spec, this.t);
      saturation = frame.saturation;
      const node = this.tileNode(id);
      if (!node) continue;
      node.position.set(0, frame.dy);
      node.rotation = frame.rotationRad;
    }
    this.setDesaturation(1 - saturation);
    return this.t < LOSS_WASH_MS;
  }

  dispose(): void {
    for (const id of this.tiles) {
      const node = this.tileNode(id);
      if (!node) continue;
      node.position.set(0, 0);
      node.rotation = 0;
    }
    this.setDesaturation(0);
  }
}

/**
 * The deadlock's board-wide grey-out (issue #122): the whole board layer
 * desaturates over STUCK_WASH_MS, same one-filter approach as the loss's own
 * SlumpEffect. Unlike SlumpEffect, this still runs under reduced motion (as
 * an `instant` jump straight to fully grey) — the wash. rather than motion,
 * is the point of the effect, so reduced motion collapses it rather than
 * skipping it. `instant` also covers a reload of an already-stuck save.
 */
class GreyOutEffect implements Effect {
  private t: number;

  constructor(
    private readonly setDesaturation: (amount: number) => void,
    instant: boolean,
  ) {
    this.t = instant ? STUCK_WASH_MS : 0;
    this.setDesaturation(stuckGreyOut(this.t));
  }

  advance(dtMs: number): boolean {
    this.t += dtMs;
    this.setDesaturation(stuckGreyOut(this.t));
    return this.t < STUCK_WASH_MS;
  }

  dispose(): void {
    this.setDesaturation(0);
  }
}

/**
 * The deadlock's amber near-pair pulse (issue #122): up to a handful of pairs
 * (game.ts's `nearPairs`), each drawn as an outline `Graphics` child added to
 * both tile nodes and faded 0 → 1 → 0 once, staggered pair to pair. Like the
 * other live-node effects, nodes are re-resolved every frame and a tile that
 * has left the board simply stops getting its outline updated (the outline
 * itself is destroyed on dispose regardless). An empty pair list finishes on
 * its first frame and disposes cleanly — a deadlock with no near-pair at all
 * is not an error, just nothing to point at.
 */
class PulseEffect implements Effect {
  private t = 0;
  private readonly total: number;
  private readonly outlines = new Map<TileId, Graphics>();

  constructor(
    private readonly pairs: ReadonlyArray<readonly [TileId, TileId]>,
    private readonly tileNode: (id: TileId) => Container | undefined,
    private readonly tileRect: (id: TileId) => Rect | undefined,
  ) {
    this.total =
      pairs.length === 0
        ? 0
        : STUCK_PULSE_START_MS + (pairs.length - 1) * STUCK_PULSE_STAGGER_MS + STUCK_PULSE_MS;
  }

  advance(dtMs: number): boolean {
    this.t += dtMs;
    this.pairs.forEach((pair, index) => {
      const alpha = stuckPulseAlpha(this.t, index);
      for (const id of pair) {
        const node = this.tileNode(id);
        if (!node) continue;
        let outline = this.outlines.get(id);
        // A resize redraw destroys every tile container with
        // `destroy({children:true})`, which takes the outline down with it —
        // `outline.destroyed` catches that. The node itself is also a fresh
        // instance at that point (`tileNode(id)` now resolves to the new
        // container), so re-adding a *live* outline to it would be wrong too;
        // simplest correct fix is to always rebuild when either has changed.
        if (outline && (outline.destroyed || outline.parent !== node)) {
          if (!outline.destroyed) outline.destroy();
          outline = undefined;
        }
        if (!outline) {
          const r = this.tileRect(id);
          if (!r) continue;
          outline = new Graphics()
            .rect(r.x, r.y, r.w, r.h)
            .stroke({ width: PULSE_OUTLINE_WIDTH, color: PULSE_COLOR });
          this.outlines.set(id, outline);
          node.addChild(outline);
        }
        outline.alpha = alpha;
      }
    });
    return this.t < this.total;
  }

  dispose(): void {
    for (const outline of this.outlines.values()) {
      if (!outline.destroyed) outline.destroy();
    }
    this.outlines.clear();
  }
}

/**
 * Every live effect, advanced from one ticker callback.
 *
 * Concurrent effects are simply separate entries — nothing queues and nothing
 * waits. `reduced` is read at the moment an effect starts, so flipping the
 * setting (or the OS preference) takes effect on the very next tap.
 */
export class Animator {
  private readonly effects: Effect[] = [];
  private readonly onTick = (ticker: Ticker): void => this.advance(ticker.deltaMS);

  constructor(
    private readonly ticker: Ticker,
    private readonly opts: {
      readonly reduced: () => boolean;
      readonly tileNode: (id: TileId) => Container | undefined;
      readonly setDesaturation: (amount: number) => void;
      /** A tile's top-face rect in board px (issue #122's pulse outline). */
      readonly tileRect: (id: TileId) => Rect | undefined;
    },
  ) {
    ticker.add(this.onTick);
  }

  /** Unfold a tile whose face just flipped — reveal or re-conceal (issue #64).
   *  Reduced motion skips it: the redraw already swapped the art, so skipping
   *  degrades to an instant flip, never a missing one. */
  flip(id: TileId, center: Point): void {
    if (this.opts.reduced()) return;
    this.effects.push(new FlipEffect(id, center, this.opts.tileNode));
  }

  /** Shake tiles in place (blocked tap). Reduced motion skips it. */
  shake(ids: readonly TileId[]): void {
    if (this.opts.reduced()) return;
    for (const id of ids) this.effects.push(new ShakeEffect(id, this.opts.tileNode));
  }

  /** The win cascade (issue #120): whatever tile pictures are still on the
   *  board lift and sweep off, column by column. Reduced motion skips it —
   *  the board is already the final, empty-of-fanfare state. */
  cascade(tiles: ReadonlyArray<{ readonly id: TileId; readonly column: number }>): void {
    if (this.opts.reduced()) return;
    this.effects.push(new CascadeEffect(tiles, this.opts.tileNode));
  }

  /** The holder-full loss slump (issue #121): whatever tile pictures are
   *  still on the board sag, tilt and desaturate while the red wash plays.
   *  Reduced motion skips it — the wash appears at once instead. */
  slump(ids: readonly TileId[]): void {
    if (this.opts.reduced()) return;
    this.effects.push(new SlumpEffect(ids, this.opts.tileNode, this.opts.setDesaturation));
  }

  /** The deadlock's grey-out (issue #122): the whole board layer desaturates.
   *  Unlike the other effects here this still runs under reduced motion —
   *  `instant` is what the caller passes for that (and for a reload of an
   *  already-stuck save): the grey itself is the point, only the fade is cut. */
  greyOut(instant: boolean): void {
    this.effects.push(new GreyOutEffect(this.opts.setDesaturation, instant));
  }

  /** The deadlock's near-pair hint (issue #122): up to a few pairs pulse an
   *  amber outline once, staggered. Reduced motion skips it outright — the
   *  grey-out above already reads as "paused" without it. */
  pulse(pairs: ReadonlyArray<readonly [TileId, TileId]>): void {
    if (this.opts.reduced()) return;
    this.effects.push(new PulseEffect(pairs, this.opts.tileNode, this.opts.tileRect));
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
