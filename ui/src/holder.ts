// Holder strip (issue #43): the four slots a tapped free tile travels to, drawn
// above the board.
//
// This is DOM, not canvas, and deliberately so. The strip is HUD furniture, not
// board geometry: as a flex sibling of #board it takes its own height out of the
// fit, so the board re-sizes around it with no change to the fit maths — and
// each slot is a real <button>, which is the whole accessibility story for free
// rather than a second mirror layer over a second canvas (compare a11y.ts,
// which exists only because the board *is* a canvas).
//
// A parked tile *is* the tile (issue #66): the slot shows the renderer's own
// picture of it — face, border, side depth, pips or glyph, corner tag — at the
// board's current on-screen tile size, supplied per redraw as `tileImage` /
// `tileSize` in the view. Parking moves a tile; it must not shrink or flatten
// it. The slot buttons themselves stay at the spec §7 48dp minimum in both
// axes (CSS min-width/min-height), with the tile picture centred inside when
// the board's tiles are smaller than that.
//
// Issue #63 gives the strip a second job. The holder is one-way and filling it
// ends the level (decision 0009), so the last empty slot is marked `.last` and
// the group says so — a hard-fail the player can walk into needs to be visible
// before they take the step, not explained afterwards in a dialog.
//
// Issue #93 makes the strip where pairs resolve — and takes its buttons out of
// the action. A held tile is no longer tappable: it can only leave by its
// partner being tapped on the board, so every slot stays disabled and the
// buttons are pure information (face, position, the last-slot warning), which
// assistive technology still reads in place.

import type { TileId } from '@mahjongsolitaire/core';
import { faceStyle } from './faces.js';

export interface HolderView {
  /** Slot occupancy, one entry per slot and null where empty. */
  readonly slots: readonly (TileId | null)[];
  /** FaceId of a held tile. */
  readonly faceOf: (id: TileId) => string;
  /** The renderer's picture of a face's tile, as a data URL (issue #66). */
  readonly tileImage: (face: string) => string;
  /** On-screen size of a board tile, side depth included, CSS px (issue #66).
   *  Slots track it so a parked tile and a board tile always read the same. */
  readonly tileSize: { readonly w: number; readonly h: number };
  /** Tiles the Hint booster is pointing at — a hinted held tile is half of a
   *  playable pair, so it has to be findable here too. */
  readonly hint: readonly TileId[];
}

/**
 * The holder's slots as buttons. Rebuilt in place on every redraw: four nodes
 * is nothing, and updating attributes rather than replacing elements is what
 * keeps the DOM stable under the strip's own animations (issue #93).
 */
export class HolderStrip {
  private readonly slotNodes: HTMLButtonElement[] = [];

  constructor(
    private readonly root: HTMLElement,
    capacity: number,
  ) {
    root.setAttribute('role', 'group');
    for (let i = 0; i < capacity; i++) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'slot';
      node.dataset['slot'] = String(i);
      // Nothing to activate (issue #93: a held tile leaves only by its partner
      // being tapped on the board) — the buttons are information, not controls.
      node.disabled = true;
      // The tile picture (issue #66) — a child rather than the button's own
      // background, so the 48dp button box and the tile-sized visual can
      // differ when the board's tiles are smaller than the touch target.
      node.appendChild(Object.assign(document.createElement('span'), { className: 'tile' }));
      this.slotNodes.push(node);
      root.appendChild(node);
    }
  }

  /** The slot buttons, in slot order — where the fly-in / pair-clear effects
   *  anchor themselves (issue #93). */
  slotNode(index: number): HTMLElement | undefined {
    return this.slotNodes[index];
  }

  sync(view: HolderView): void {
    const held = [...this.slotNodes.keys()].map((i) => view.slots[i] ?? null);
    const used = held.filter((id) => id !== null).length;
    const lastFree = this.slotNodes.length - used === 1 ? held.indexOf(null) : -1;
    this.root.setAttribute(
      'aria-label',
      `Holder, ${used} of ${this.slotNodes.length} slots used${
        lastFree === -1
          ? ''
          : ', one slot left — a tile with no match in the holder ends the level'
      }`,
    );
    // Whole CSS px: the strip's height feeds back into the board's fit, so a
    // fractional size that re-rounds differently every pass would never settle.
    const w = Math.max(1, Math.round(view.tileSize.w));
    const h = Math.max(1, Math.round(view.tileSize.h));
    this.slotNodes.forEach((node, i) => {
      const id = held[i] ?? null;
      // The warning cue: only ever on the one empty slot that would be filled.
      node.classList.toggle('last', i === lastFree);
      const tile = node.querySelector<HTMLElement>('.tile')!;
      // Written only on change (both branches share the box), so the resize →
      // fit → resize feedback closes after one pass instead of thrashing.
      if (tile.style.width !== `${w}px`) tile.style.width = `${w}px`;
      if (tile.style.height !== `${h}px`) tile.style.height = `${h}px`;
      if (id === null) {
        node.classList.remove('filled', 'hinted');
        node.setAttribute(
          'aria-label',
          i === lastFree
            ? `Holder slot ${i + 1}, empty — the last one; a tile with no match in the holder ends the level`
            : `Holder slot ${i + 1}, empty`,
        );
        delete node.dataset['tileId'];
        // Back to the dashed-outline placeholder from the stylesheet.
        tile.style.backgroundImage = '';
        return;
      }
      const style = faceStyle(view.faceOf(id));
      node.classList.add('filled');
      node.classList.toggle('hinted', view.hint.includes(id));
      node.setAttribute(
        'aria-label',
        `${style.label}, in holder slot ${i + 1} — tap its matching tile on the board to clear the pair`,
      );
      // Same hook the board's a11y nodes carry, so scripted QA can reach a tile
      // by id without caring which layer it is currently in.
      node.dataset['tileId'] = String(id);
      // The renderer's own picture of this tile (issue #66) — same material,
      // same size as it had on the board a moment ago.
      const image = `url("${view.tileImage(view.faceOf(id))}")`;
      if (tile.style.backgroundImage !== image) tile.style.backgroundImage = image;
    });
  }

  /** Take the strip out of the a11y tree (modal dialogs). */
  setInert(inert: boolean): void {
    if (inert) this.root.setAttribute('inert', '');
    else this.root.removeAttribute('inert');
  }

  /** Mark the strip as the reason the level ended (issue #121: the holder-full
   *  loss). Filled slots carry no border by default (`.filled .tile`), so the
   *  red one has to be set explicitly here rather than riding on `.last`'s
   *  amber, which only ever marks a single *empty* slot. Cleared on restart
   *  or a new deal, same as every other end-of-level effect. */
  setLost(lost: boolean): void {
    this.root.classList.toggle('lost', lost);
  }
}
