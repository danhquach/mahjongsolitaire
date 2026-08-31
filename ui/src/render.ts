// PixiJS board renderer (issue #11, placeholder art). Decision 0001: canvas
// rendering via PixiJS v8; the DOM/ARIA overlay arrives with issue #12 and
// will mirror the same geometry module.

import { Container, Graphics, Text } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { TileId } from '@mahjongsolitaire/core';
import { faceStyle } from './faces.js';
import type { Game } from './game.js';
import { SIDE_DEPTH, TILE_H, TILE_W, boardBounds, paintOrder, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';

const COLOR_TILE_FACE = 0xfdf6e3;
const COLOR_TILE_SIDE = 0xcbb891;
const COLOR_TILE_BORDER = 0x8a7a55;
const COLOR_SELECTED = 0xf59e0b;
const COLOR_FLASH = 0xdc2626;
const COLOR_HINT = 0x2563eb;

export interface DrawState {
  readonly selection: TileId | null;
  /** Tiles to outline in red this frame (mismatch / blocked-tap feedback). */
  readonly flash: readonly TileId[];
  /** Tiles the Hint booster is pointing at (issue #13); outlined in blue
   *  until the board changes — spec §7 wants no timing pressure. */
  readonly hint: readonly TileId[];
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
      // Side extrusion down-right, one tile's depth on every layer so a tall
      // stack does not read as a thicker slab; right/lower neighbors and upper
      // layers paint over it (paintOrder), leaving only the exposed edges.
      g.roundRect(r.x, r.y, r.w + SIDE_DEPTH, r.h + SIDE_DEPTH, 6).fill(COLOR_TILE_SIDE);
      const selected = state.selection === tile.id;
      const flashed = state.flash.includes(tile.id);
      const hinted = state.hint.includes(tile.id);
      g.roundRect(r.x, r.y, r.w, r.h, 6)
        .fill(selected ? 0xfff0c2 : hinted ? 0xdbeafe : COLOR_TILE_FACE)
        .stroke({
          width: selected || flashed || hinted ? 4 : 1.5,
          color: flashed
            ? COLOR_FLASH
            : selected
              ? COLOR_SELECTED
              : hinted
                ? COLOR_HINT
                : COLOR_TILE_BORDER,
        });
      this.boardLayer.addChild(g);

      const style = faceStyle(tile.face);
      if (style.pips) {
        // Per-rank pip art (issue #35): dots/bamboo draw their actual count.
        // Pip area sits below the corner tag, inset from the tile edges.
        const inset = TILE_W * 0.16;
        const areaX = r.x + inset;
        const areaY = r.y + TILE_H * 0.26;
        const areaW = TILE_W - 2 * inset;
        const areaH = TILE_H - TILE_H * 0.26 - inset * 0.6;
        const pipG = new Graphics();
        for (const pip of style.pips) {
          const px = areaX + pip.x * areaW;
          const py = areaY + pip.y * areaH;
          if (style.pipShape === 'stick') {
            const sw = TILE_W * 0.07;
            const sh = TILE_H * 0.16;
            pipG.roundRect(px - sw / 2, py - sh / 2, sw, sh, sw / 2).fill(style.color);
          } else {
            pipG.circle(px, py, TILE_W * 0.065).fill(style.color);
          }
        }
        this.boardLayer.addChild(pipG);
      } else {
        const glyph = new Text({
          text: style.glyph,
          style: { fontSize: TILE_H * 0.42, fill: style.color, fontFamily: 'sans-serif' },
        });
        glyph.anchor.set(0.5);
        glyph.position.set(r.x + TILE_W / 2, r.y + TILE_H * 0.58);
        this.boardLayer.addChild(glyph);
      }
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
      this.boardLayer.addChild(tag);
    }
  }
}
