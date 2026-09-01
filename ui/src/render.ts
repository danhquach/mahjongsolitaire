// PixiJS board renderer (issue #11, placeholder art). Decision 0001: canvas
// rendering via PixiJS v8; the DOM/ARIA overlay arrives with issue #12 and
// will mirror the same geometry module.
//
// Depth cues (issue #45) live in depth.ts — this file only paints them, in the
// order that makes painter's order do the occlusion work:
//
//   shadow sprite → side bands (base outward → inward) → top face → ink
//
// per tile, tiles themselves in paintOrder. A tile's shadow therefore lands on
// the already-painted lower layers down-right of it and is overpainted by its
// own right/lower same-layer neighbours, which is exactly right: neighbours at
// equal height cast nothing on each other (the darker outline separates those),
// while an upper layer detaches from the stack below it.

import { Container, Graphics, Rectangle, Sprite, Text } from 'pixi.js';
import type { Application, Texture } from 'pixi.js';
import type { Tile, TileId } from '@mahjongsolitaire/core';
import {
  BORDER_WIDTH,
  BORDER_WIDTH_ACTIVE,
  LAYER_FACE_STEP,
  SHADOW_DX,
  SHADOW_DY,
  SHADOW_PAD,
  SHADOW_RINGS,
  SHADOW_UP_LEFT_RATIO,
  depthSteps,
  scaleColor,
  tileShade,
} from './depth.js';
import { faceStyle } from './faces.js';
import { PIP_AREA, TAG_FONT_SIZE, TAG_ORIGIN, pipCenter, pipMetrics } from './pips.js';
import type { Game } from './game.js';
import { SIDE_DEPTH, TILE_H, TILE_W, boardBounds, paintOrder, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';
import { BOARD_MARGIN, fitScale } from './hud-fit.js';
import type { BoardExtent } from './hud-fit.js';

const COLOR_SELECTED = 0xf59e0b;
const COLOR_FLASH = 0xdc2626;
const COLOR_HINT = 0x2563eb;
/** Highlight faces stay at full value on every layer — they are the cue. */
const FACE_SELECTED = 0xfff0c2;
const FACE_HINT = 0xdbeafe;
/** Corner radius of the tile silhouette, shared by face, sides, and shadow. */
const TILE_RADIUS = 6;

// --- face-down back (issue #64) ----------------------------------------------
//
// A concealed tile is the same tile — same silhouette, sides, shadow, border,
// highlight outlines — with the face painted as a card back instead of a suit:
// a deep felt green with a lighter inset keyline, no glyph, no pips, no tag.
// Both colours run through the same per-layer darkening as a face does
// (LAYER_FACE_STEP via depthSteps), so a face-down tile recedes with its layer
// exactly like its neighbours.
const BACK_FACE = 0x2e6b4f;
const BACK_KEYLINE = 0x9fc4ae;
/** Inset of the keyline from the face edge, board px. */
const BACK_INSET = 7;
const BACK_KEYLINE_WIDTH = 2;

// --- suited-rank pip art (issue #45) ----------------------------------------
//
// Both shapes are drawn from proportions rather than asset files: they have to
// hold up from tile size S to XL and re-tint per layer, which a flat bitmap
// cannot do. Where each pip goes and how big it may be is pips.ts; this is only
// how one is drawn.

/** The ring's open centre, as a fraction of its outer radius. */
const RING_HOLE = 0.38;
/** End caps: the flat band at each end of a cane segment, and the widest part
 *  of it — as a fraction of the cane's height. */
const CANE_CAP_H = 0.14;
/** Half-widths of the body at its widest (mid-bulge) and narrowest (a pinch),
 *  as fractions of the cane's overall width. Keep the ratio near 2:3 — a
 *  deeper waist on a narrow cane stops reading as bamboo and starts reading as
 *  screw thread. */
const CANE_BULGE = 0.44;
const CANE_PINCH = 0.3;
/** Bulges per cane — three, separated by two pinches, as a segmented cane
 *  reads. */
const CANE_BULGES = 3;

/**
 * A Dots pip: a ring, split two-tone along the traditional taijitu boundary.
 *
 * Built from discs rather than an S-curve path: the left half plus the lower
 * lobe belong to the base ink, the right half plus the upper lobe to the
 * accent, and the two lobes are what turn a straight diameter into the curve.
 * The centre is punched with the face colour, so the hole tracks the layer
 * shade instead of being a hard-coded white.
 */
function drawRing(
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  base: number,
  accent: number,
  face: number,
): void {
  const lobe = r / 2;
  g.circle(cx, cy, r).fill(accent);
  // Left half-disc: the arc runs from the top round through 180° to the bottom,
  // and fill() closes it on the diameter.
  g.moveTo(cx, cy - r)
    .arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, true)
    .fill(base);
  g.circle(cx, cy + lobe, lobe).fill(base);
  g.circle(cx, cy - lobe, lobe).fill(accent);
  g.circle(cx, cy, r * RING_HOLE).fill(face);
}

/**
 * A Bamboo pip: one cane segment — a flat cap at each end and a waisted body
 * of three bulges between them.
 *
 * The body is a closed path whose sides are quadratic curves pinned at the
 * pinches and bowed out at each bulge's midpoint. A quadratic only reaches
 * halfway to its control point, so the control offset is solved back from the
 * bulge we actually want, not set to it.
 */
function drawCane(
  g: Graphics,
  cx: number,
  cy: number,
  w: number,
  h: number,
  color: number,
): void {
  const capH = h * CANE_CAP_H;
  const top = cy - h / 2;
  const bottom = cy + h / 2;
  const bodyTop = top + capH;
  const step = (bottom - capH - bodyTop) / CANE_BULGES;
  const pinch = w * CANE_PINCH;
  // x(0.5) of a quadratic is (p0 + 2c + p2) / 4, so c = 2·bulge − pinch.
  const control = 2 * (w * CANE_BULGE) - pinch;

  g.moveTo(cx - pinch, bodyTop);
  for (let i = 0; i < CANE_BULGES; i++) {
    const y = bodyTop + step * i;
    g.quadraticCurveTo(cx - control, y + step / 2, cx - pinch, y + step);
  }
  g.lineTo(cx + pinch, bodyTop + step * CANE_BULGES);
  for (let i = CANE_BULGES; i > 0; i--) {
    const y = bodyTop + step * i;
    g.quadraticCurveTo(cx + control, y - step / 2, cx + pinch, y - step);
  }
  g.closePath().fill(color);

  const capR = capH * 0.45;
  g.roundRect(cx - w / 2, top, w, capH, capR).fill(color);
  g.roundRect(cx - w / 2, bottom - capH, w, capH, capR).fill(color);
}

export interface DrawState {
  readonly selection: TileId | null;
  /** Tiles to outline in red this frame (mismatch / blocked-tap feedback). */
  readonly flash: readonly TileId[];
  /** Tiles the Hint booster is pointing at (issue #13); outlined in blue
   *  until the board changes — spec §7 wants no timing pressure. */
  readonly hint: readonly TileId[];
  /** "Highlight free tiles" (issue #45): shade blocked tiles one step further
   *  back so the playable ones are the bright tiles. Off by default. */
  readonly dimBlocked: boolean;
}

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
  private readonly bounds: Rect;
  /** Topmost layer of the loaded layout — the depth ladder's bright end. */
  private readonly topZ: number;
  private readonly shadowTexture: Texture;
  private viewScale = 1;
  /** Tile Size setting (issue #14): a fraction of the fit-to-viewport scale. */
  private sizeFactor = 1;

  constructor(
    private readonly app: Application,
    layoutSlots: readonly { x: number; y: number; z: number }[],
  ) {
    this.bounds = boardBounds(layoutSlots);
    this.topZ = Math.max(...layoutSlots.map((s) => s.z));
    this.shadowTexture = this.bakeShadow();
    this.viewport.addChild(this.boardLayer, this.effectsLayer);
    app.stage.addChild(this.viewport);
  }

  get scale(): number {
    return this.viewScale;
  }

  /** The loaded layout's board-space bounds — what HUD placement fits against
   *  (issue #37). Read-only; the layout does not change under a renderer. */
  get boardExtent(): BoardExtent {
    return this.bounds;
  }

  /**
   * Bake the soft drop shadow once, at construction, into a texture reused as
   * one sprite per tile (issue #45). Every tile has the same silhouette, so
   * one texture covers the whole board; 144 sprites of it batch into a single
   * draw call. The ticket rules out a per-frame filter on a full board, and
   * rebuilding the ring stack as geometry per tile would be ~1000 rounded
   * rects per redraw for a result that never changes.
   */
  private bakeShadow(): Texture {
    const g = new Graphics();
    // Largest and faintest first: the rings accumulate toward the silhouette,
    // so the darkest point is the contact edge and it fades outward.
    for (const ring of SHADOW_RINGS) {
      const back = ring.grow * SHADOW_UP_LEFT_RATIO;
      g.roundRect(
        SHADOW_PAD + SHADOW_DX - back,
        SHADOW_PAD + SHADOW_DY - back,
        TILE_W + SIDE_DEPTH + back + ring.grow,
        TILE_H + SIDE_DEPTH + back + ring.grow,
        TILE_RADIUS + ring.grow,
      ).fill({ color: 0x000000, alpha: ring.alpha });
    }
    const texture = this.app.renderer.generateTexture({
      target: g,
      // The board layer scales up to ~3× on a tablet; bake at the device's own
      // resolution and let the scale soften it further — it is a shadow.
      resolution: this.app.renderer.resolution,
      // Explicit frame, not the graphics' own bounds: the rings start inside
      // the padding (the offset exceeds their up-left reach), so bounds would
      // put the texture origin somewhere the sprite placement cannot predict.
      frame: new Rectangle(
        0,
        0,
        TILE_W + SIDE_DEPTH + 2 * SHADOW_PAD,
        TILE_H + SIDE_DEPTH + 2 * SHADOW_PAD,
      ),
    });
    g.destroy();
    return texture;
  }

  /**
   * Tile Size (spec §7 S–XL, issue #14). The board already fits the viewport,
   * so the factor scales *down* from that fit — 1 is the largest the screen
   * allows. Re-fits immediately; the caller redraws.
   */
  setSizeFactor(factor: number): void {
    this.sizeFactor = factor;
    this.layoutToViewport();
  }

  /** Fit the board into the current renderer size, centered, with a margin. */
  layoutToViewport(): void {
    // Pixi v8: renderer.width/height are logical CSS px (resizeTo passes
    // clientWidth; TextureSource stores pixelWidth / resolution) — do NOT
    // divide by resolution again or HiDPI screens get a 1/DPR-scale board.
    // Same fitScale() the HUD placement was chosen with (issue #37), so the
    // placement can never be picked against a fit the renderer then changes.
    const fit = fitScale(this.bounds, this.app.renderer.width, this.app.renderer.height);
    const availW = this.app.renderer.width - 2 * BOARD_MARGIN;
    const availH = this.app.renderer.height - 2 * BOARD_MARGIN;
    this.viewScale = fit * this.sizeFactor;
    this.viewport.scale.set(this.viewScale);
    this.viewport.position.set(
      (availW - this.bounds.w * this.viewScale) / 2 + BOARD_MARGIN - this.bounds.x * this.viewScale,
      (availH - this.bounds.h * this.viewScale) / 2 + BOARD_MARGIN - this.bounds.y * this.viewScale,
    );
  }

  /** Convert a pointer event position (CSS px, canvas-relative) to board px. */
  toBoardPoint(cssX: number, cssY: number): { x: number; y: number } {
    return {
      x: (cssX - this.viewport.position.x) / this.viewScale,
      y: (cssY - this.viewport.position.y) / this.viewScale,
    };
  }

  /** Inverse of toBoardPoint — board px to canvas-relative CSS px. */
  toCssPoint(boardX: number, boardY: number): { x: number; y: number } {
    return {
      x: boardX * this.viewScale + this.viewport.position.x,
      y: boardY * this.viewScale + this.viewport.position.y,
    };
  }

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
      const hidden = game.isFaceHidden(tile.id);
      const node = this.buildTile(tile, { selected, flashed, hinted, dimmed, hidden });
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
      /** Face-down this frame (issue #64): back art instead of the face. */
      readonly hidden?: boolean;
    },
  ): Container {
    const { selected, flashed, hinted, dimmed, hidden = false } = opts;
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
    // A hidden face keeps the back colour even under a hint (the outline is the
    // cue; recolouring the face would make the back read as a fourth suit).
    // `hidden && selected` cannot happen: a selection pins its reveal (#64).
    const backFactor = 1 - LAYER_FACE_STEP * depthSteps(tile.slot.z, this.topZ, dimmed);
    g.roundRect(r.x, r.y, r.w, r.h, TILE_RADIUS)
      .fill(
        hidden
          ? scaleColor(BACK_FACE, backFactor)
          : selected
            ? FACE_SELECTED
            : hinted
              ? FACE_HINT
              : shade.face,
      )
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

    if (hidden) {
      // The back's only ornament: an inset keyline, so a face-down tile reads
      // as a deliberate card back rather than a rendering failure.
      g.roundRect(
        r.x + BACK_INSET,
        r.y + BACK_INSET,
        r.w - 2 * BACK_INSET,
        r.h - 2 * BACK_INSET,
        Math.max(2, TILE_RADIUS - 2),
      ).stroke({ width: BACK_KEYLINE_WIDTH, color: scaleColor(BACK_KEYLINE, backFactor) });
      return node; // no glyph, no pips, no tag — that is the point
    }

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
   *
   * The slot's z is swapped to the top layer for the same reason, which also
   * moves the copy by the layer lift; the caller pivots it onto the tile's real
   * centre and writes an absolute position every frame, so the build-time
   * offset never reaches the screen.
   */
  detachedTile(game: Game, id: TileId): Container | undefined {
    let tile: Tile;
    try {
      tile = game.board.get(id);
    } catch {
      return undefined; // id the board never knew
    }
    return this.buildTile(
      { ...tile, slot: { ...tile.slot, z: this.topZ } },
      { selected: false, flashed: false, hinted: false, dimmed: false },
    );
  }
}
