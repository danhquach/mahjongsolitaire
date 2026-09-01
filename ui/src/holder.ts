// Holder strip (issue #43): the four slots a free tile can be parked in, drawn
// above the board.
//
// This is DOM, not canvas, and deliberately so. The strip is HUD furniture, not
// board geometry: as a flex sibling of #board it takes its own height out of the
// fit, so the board re-sizes around it with no change to the fit maths — and
// each slot is a real <button>, which is the whole accessibility story for free
// rather than a second mirror layer over a second canvas (compare a11y.ts,
// which exists only because the board *is* a canvas).
//
// A parked tile is painted from the same palette the renderer uses (depth.ts's
// top-layer face, border and the suit ink from faces.ts), so it reads as the
// same material as the tile that was just on the board — the same glyph and the
// same corner tag, which is what makes it matchable at a glance.
//
// Issue #63 gives the strip a second job. The holder is one-way and filling it
// ends the level (decision 0009), so the last empty slot is marked `.last` and
// the group says so — a hard-fail the player can walk into needs to be visible
// before they take the step, not explained afterwards in a dialog.

import type { TileId } from '@mahjongsolitaire/core';
import { BASE_BORDER, BASE_FACE } from './depth.js';
import { faceStyle } from './faces.js';

/** CSS hex for a Pixi-style 0xRRGGBB colour. */
function css(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export interface HolderView {
  /** Slot occupancy, one entry per slot and null where empty. */
  readonly slots: readonly (TileId | null)[];
  /** FaceId of a held tile. */
  readonly faceOf: (id: TileId) => string;
  readonly selection: TileId | null;
  /** Tiles to outline in red this frame (mismatch feedback), as on the board. */
  readonly flash: readonly TileId[];
  /** Tiles the Hint booster is pointing at — a hinted held tile is half of a
   *  playable pair, so it has to be findable here too. */
  readonly hint: readonly TileId[];
}

/**
 * The holder's slots as buttons. Rebuilt in place on every redraw: four nodes
 * is nothing, and updating attributes rather than replacing elements is what
 * keeps focus where the player left it.
 */
export class HolderStrip {
  private readonly slotNodes: HTMLButtonElement[] = [];
  /** Last synced occupancy — what a slot's click resolves to. */
  private held: (TileId | null)[] = [];

  constructor(
    private readonly root: HTMLElement,
    capacity: number,
    onActivate: (id: TileId) => void,
  ) {
    root.setAttribute('role', 'group');
    for (let i = 0; i < capacity; i++) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'slot';
      node.dataset['slot'] = String(i);
      node.appendChild(Object.assign(document.createElement('span'), { className: 'glyph' }));
      node.appendChild(Object.assign(document.createElement('span'), { className: 'tag' }));
      node.addEventListener('click', () => {
        const id = this.heldIn(i);
        if (id !== null) onActivate(id);
      });
      this.slotNodes.push(node);
      root.appendChild(node);
    }
    this.held = new Array<TileId | null>(capacity).fill(null);
  }

  private heldIn(index: number): TileId | null {
    return this.held[index] ?? null;
  }

  sync(view: HolderView): void {
    this.held = [...this.slotNodes.keys()].map((i) => view.slots[i] ?? null);
    const used = this.held.filter((id) => id !== null).length;
    const lastFree = this.slotNodes.length - used === 1 ? this.held.indexOf(null) : -1;
    this.root.setAttribute(
      'aria-label',
      `Holder, ${used} of ${this.slotNodes.length} slots used${
        lastFree === -1 ? '' : ', one slot left — parking another tile ends the level'
      }`,
    );
    this.slotNodes.forEach((node, i) => {
      const id = this.held[i] ?? null;
      // The warning cue: only ever on the one empty slot that would be filled.
      node.classList.toggle('last', i === lastFree);
      const glyph = node.querySelector<HTMLElement>('.glyph')!;
      const tag = node.querySelector<HTMLElement>('.tag')!;
      if (id === null) {
        node.classList.remove('filled', 'selected', 'hinted', 'flashed');
        node.setAttribute(
          'aria-label',
          i === lastFree
            ? `Holder slot ${i + 1}, empty — the last one; filling it ends the level`
            : `Holder slot ${i + 1}, empty`,
        );
        // Nothing to activate and nothing to explain — unlike a spent booster,
        // an empty slot has no message, so it stays out of the tab order.
        node.disabled = true;
        node.removeAttribute('aria-pressed');
        delete node.dataset['tileId'];
        glyph.textContent = '';
        tag.textContent = '';
        // Back to the dashed-outline look in the stylesheet: an inline colour
        // from the tile that used to sit here would outlive it.
        node.removeAttribute('style');
        return;
      }
      const style = faceStyle(view.faceOf(id));
      node.disabled = false;
      node.classList.add('filled');
      node.classList.toggle('selected', view.selection === id);
      node.classList.toggle('hinted', view.hint.includes(id));
      node.classList.toggle('flashed', view.flash.includes(id));
      node.setAttribute('aria-pressed', String(view.selection === id));
      node.setAttribute('aria-label', `${style.label}, in holder slot ${i + 1}`);
      // Same hook the board's a11y nodes carry, so scripted QA can reach a tile
      // by id without caring which layer it is currently in.
      node.dataset['tileId'] = String(id);
      glyph.textContent = style.glyph;
      tag.textContent = style.tag;
      node.style.color = css(style.color);
      node.style.background = css(BASE_FACE);
      node.style.borderColor = css(BASE_BORDER);
    });
  }

  /** Take the strip out of the tab order and the a11y tree (modal dialogs). */
  setInert(inert: boolean): void {
    if (inert) this.root.setAttribute('inert', '');
    else this.root.removeAttribute('inert');
  }
}
