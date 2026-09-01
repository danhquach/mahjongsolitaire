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
  FLIP_MS,
  SHAKE_MS,
  flipScaleX,
  impactAt,
  matchDuration,
  matchFrame,
  particleBurst,
  particleFrame,
  shakeOffset,
} from './anim.js';
import type { Particle, Point } from './anim.js';
import { SHADOW_PAD } from './depth.js';
import { SIDE_DEPTH, TILE_H, TILE_W } from './geometry.js';

/** A tile copy to fly, with the board-px centre it starts from. */
export interface FlyingTile {
  readonly display: Container;
  readonly center: Point;
}

/** Colour of the impact flash and the sparks — the palette's warm cream. */
const SPARK_COLOR = 0xfff6d8;
/** Corner radius of the tile silhouette the flash overlays (see render.ts). */
const FLASH_RADIUS = 6;
/** The flash never goes fully opaque: at 1.0 the tile stops being a tile. */
const FLASH_MAX = 0.75;

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
  private readonly burst: readonly Particle[];
  /** The white overlay on each flying tile, in the same order as `tiles`. */
  private readonly flashes: Graphics[] = [];

  constructor(
    layer: Container,
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
      // Pivot on the tile's own centre so the punch scales about the middle and
      // a written position *is* the centre — the children are drawn at absolute
      // board coordinates, so the pivot has to be in those same coordinates.
      tile.display.pivot.set(tile.center.x, tile.center.y);
      tile.display.position.set(tile.center.x, tile.center.y);
      // A white overlay on the tile's own silhouette is the flash; its alpha is
      // driven per frame. The copy's local bounds start at the shadow's padded
      // corner, so stepping in by SHADOW_PAD lands exactly on the tile.
      const bounds = tile.display.getLocalBounds();
      const flash = new Graphics();
      flash
        .roundRect(
          bounds.x + SHADOW_PAD,
          bounds.y + SHADOW_PAD,
          TILE_W + SIDE_DEPTH,
          TILE_H + SIDE_DEPTH,
          FLASH_RADIUS,
        )
        .fill(SPARK_COLOR);
      flash.alpha = 0;
      tile.display.addChild(flash);
      this.flashes.push(flash);
      layer.addChild(tile.display);
    }
    // Reduced motion keeps the flash but throws no sparks: a particle burst is
    // exactly the kind of motion the preference is asking us not to make.
    if (!reduced) layer.addChild(this.sparks);
  }

  advance(dtMs: number): boolean {
    this.t += dtMs;
    this.tiles.forEach((tile, i) => {
      const f = matchFrame(tile.center, this.midpoint, this.t, this.reduced);
      tile.display.position.set(f.cx, f.cy);
      tile.display.scale.set(f.scale);
      tile.display.alpha = f.alpha;
      this.flashes[i]!.alpha = f.flash * FLASH_MAX;
    });
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

  /** Unfold a tile whose face just flipped — reveal or re-conceal (issue #64).
   *  Reduced motion skips it: the redraw already swapped the art, so skipping
   *  degrades to an instant flip, never a missing one. */
  flip(id: TileId, center: Point): void {
    if (this.opts.reduced()) return;
    this.effects.push(new FlipEffect(id, center, this.opts.tileNode));
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
