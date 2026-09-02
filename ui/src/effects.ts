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

import type { Container, Ticker } from 'pixi.js';
import type { TileId } from '@mahjongsolitaire/core';
import {
  FLIP_MS,
  LOSS_WASH_MS,
  SHAKE_MS,
  cascadeDurationMs,
  cascadeFrame,
  flipScaleX,
  shakeOffset,
  slumpFrame,
  slumpLayout,
} from './anim.js';
import type { Point } from './anim.js';

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
