// PixiJS board renderer (issue #11, placeholder art). Decision 0001: canvas
// rendering via PixiJS v8; the DOM/ARIA overlay arrives with issue #12 and
// will mirror the same geometry module.

import { Container, Graphics, Text } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { TileId } from '@mahjongsolitaire/core';
import { faceStyle } from './faces.js';
import type { Game } from './game.js';
import { LAYER_LIFT, TILE_H, TILE_W, boardBounds, paintOrder, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';

const COLOR_TILE_FACE = 0xfdf6e3;
const COLOR_TILE_SIDE = 0xcbb891;
const COLOR_TILE_BORDER = 0x8a7a55;
const COLOR_SELECTED = 0xf59e0b;
const COLOR_FLASH = 0xdc2626;

export interface DrawState {
  readonly selection: TileId | null;
  /** Tiles to outline in red this frame (mismatch / blocked-tap feedback). */
  readonly flash: readonly TileId[];
}

export class BoardRenderer {
  private readonly boardLayer = new Container();
  private readonly bounds: Rect;
  private viewScale = 1;

  constructor(
    private readonly app: Application,
    layoutSlots: readonly { x: number; y: number; z: number }[],
  ) {
    this.bounds = boardBounds(layoutSlots);
    app.stage.addChild(this.boardLayer);
  }

  get scale(): number {
    return this.viewScale;
  }

  /** Fit the board into the current renderer size, centered, with a margin. */
  layoutToViewport(): void {
    const margin = 12;
    // Pixi v8: renderer.width/height are logical CSS px (resizeTo passes
    // clientWidth; TextureSource stores pixelWidth / resolution) — do NOT
    // divide by resolution again or HiDPI screens get a 1/DPR-scale board.
    const availW = this.app.renderer.width - 2 * margin;
    const availH = this.app.renderer.height - 2 * margin;
    this.viewScale = Math.min(availW / this.bounds.w, availH / this.bounds.h, 2);
    this.boardLayer.scale.set(this.viewScale);
    this.boardLayer.position.set(
      (availW - this.bounds.w * this.viewScale) / 2 + margin - this.bounds.x * this.viewScale,
      (availH - this.bounds.h * this.viewScale) / 2 + margin - this.bounds.y * this.viewScale,
    );
  }

  /** Convert a pointer event position (CSS px, canvas-relative) to board px. */
  toBoardPoint(cssX: number, cssY: number): { x: number; y: number } {
    return {
      x: (cssX - this.boardLayer.position.x) / this.viewScale,
      y: (cssY - this.boardLayer.position.y) / this.viewScale,
    };
  }

  /** Inverse of toBoardPoint — board px to canvas-relative CSS px. */
  toCssPoint(boardX: number, boardY: number): { x: number; y: number } {
    return {
      x: boardX * this.viewScale + this.boardLayer.position.x,
      y: boardY * this.viewScale + this.boardLayer.position.y,
    };
  }

  /** Redraw the whole board (144 tiles is well within budget — spike showed
   *  ~0.2ms/frame with every tile animating). */
  draw(game: Game, state: DrawState): void {
    this.boardLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    const tiles = [...game.board.presentTiles()].sort((a, b) => paintOrder(a.slot, b.slot));
    for (const tile of tiles) {
      const r = tileRect(tile.slot);
      const g = new Graphics();
      const lift = tile.slot.z * LAYER_LIFT;
      if (lift > 0) {
        // Side extrusion down-right to the tile's lattice base; right/lower
        // neighbors and upper layers paint over it (paintOrder).
        g.roundRect(r.x, r.y, r.w + lift, r.h + lift, 6).fill(COLOR_TILE_SIDE);
      }
      const selected = state.selection === tile.id;
      const flashed = state.flash.includes(tile.id);
      g.roundRect(r.x, r.y, r.w, r.h, 6)
        .fill(selected ? 0xfff0c2 : COLOR_TILE_FACE)
        .stroke({
          width: selected || flashed ? 4 : 1.5,
          color: flashed ? COLOR_FLASH : selected ? COLOR_SELECTED : COLOR_TILE_BORDER,
        });
      this.boardLayer.addChild(g);

      const style = faceStyle(tile.face);
      const glyph = new Text({
        text: style.glyph,
        style: { fontSize: TILE_H * 0.42, fill: style.color, fontFamily: 'sans-serif' },
      });
      glyph.anchor.set(0.5);
      glyph.position.set(r.x + TILE_W / 2, r.y + TILE_H * 0.58);
      const tag = new Text({
        text: style.tag,
        style: {
          fontSize: TILE_H * 0.22,
          fill: style.color,
          fontFamily: 'sans-serif',
          fontWeight: 'bold',
        },
      });
      tag.position.set(r.x + 5, r.y + 3);
      this.boardLayer.addChild(glyph, tag);
    }
  }
}
