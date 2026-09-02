// Tray effects (issue #93): the DOM half of the match feedback.
//
// Every tapped tile travels to the holder strip, and pairs assemble and clear
// *there* — but the strip is HUD DOM above the board canvas, so a flight from
// board to slot leaves the canvas and cannot be a Pixi effect (the canvas
// clips at #board's edge). These effects are plain positioned elements in a
// fixed overlay instead, driven by the Web Animations API; the timeline
// arithmetic they share with the board effects lives in anim.ts.
//
// Same contract as effects.ts: nothing here is awaited by the input path, and
// nothing touches game state — the model already moved (or removed) the tile
// before an effect exists, so what flies is a picture, not a tile. The slot's
// real content is drawn by holder.ts on redraw; a flight covers the gap by
// marking the destination slot `.incoming` (CSS hides its tile picture) until
// the copy lands.
//
// Reduced motion (OS preference or in-app toggle, read per effect) substitutes
// the whole sequence with the redraw's own instant state change, keeping only
// the score popup as a static fade — no travel, no dwell, no particles.

import {
  END_SCALE,
  PAIR_CLEAR_MS,
  PAIR_SHOW_MS,
  SCORE_POP_MS,
  SLAM_MS,
  TRAY_FLY_MS,
  particleBurst,
  particleFrame,
  slamProgress,
  slamSquash,
} from './anim.js';

/** A page-coordinate box an effect starts from or lands on. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Colour of the pair-clear sparks — the palette's warm cream (see effects.ts
 *  before issue #93; the burst simply moved layers). */
const SPARK_COLOR = '#fff6d8';
/** Sparks scale with the tile so the burst reads the same at every Tile Size. */
const SPARK_DISTANCE_FACTOR = 1.6;

function tileImg(image: string, box: Box): HTMLElement {
  const node = document.createElement('div');
  node.className = 'fx-tile';
  node.style.left = `${box.x}px`;
  node.style.top = `${box.y}px`;
  node.style.width = `${box.w}px`;
  node.style.height = `${box.h}px`;
  node.style.backgroundImage = `url("${image}")`;
  return node;
}

export class TrayFx {
  /** Live effect count — the QA harness's `animating()` looks at it. */
  private live = 0;
  /** Bumped by clear(): a track started before it must not decrement `live`
   *  when its animations eventually settle, or it would steal the count from
   *  an effect started after — and `busy` would read false mid-flight. */
  private epoch = 0;
  private seed = 1;

  constructor(
    private readonly layer: HTMLElement,
    private readonly reduced: () => boolean,
  ) {}

  get busy(): boolean {
    return this.live > 0;
  }

  /** Drop every live effect — the board underneath has been replaced. */
  clear(): void {
    this.layer.replaceChildren();
    this.live = 0;
    this.epoch++;
    for (const slot of document.querySelectorAll('.slot.incoming')) {
      slot.classList.remove('incoming');
    }
  }

  private track(node: HTMLElement, animations: readonly Animation[], onDone?: () => void): void {
    this.live++;
    const epoch = this.epoch;
    void Promise.allSettled(animations.map((a) => a.finished)).then(() => {
      node.remove();
      // A track superseded by clear() must neither decrement a count that now
      // belongs to newer effects nor run its completion side effects — the
      // haptic for a match that was undone, the `.incoming` unmark on a slot a
      // newer flight may have re-marked (same rule MatchEffect.dispose had:
      // a cancelled effect never fires its onImpact).
      if (epoch !== this.epoch) return;
      this.live--;
      onDone?.();
    });
  }

  /**
   * A parked tile's travel: a copy flies from its board rect to its slot
   * (issue #93). The real slot is already filled by the redraw, so it is
   * marked `.incoming` — picture hidden — until the copy lands. `onArrive`
   * fires once, when it does (or at once under reduced motion).
   */
  flyToSlot(image: string, from: Box, slot: HTMLElement, onArrive: () => void): void {
    if (this.reduced()) {
      onArrive();
      return;
    }
    const to = slot.getBoundingClientRect();
    // Land where holder.ts draws the picture: centred in the slot button.
    const landing: Box = {
      x: to.x + (to.width - from.w) / 2,
      y: to.y + (to.height - from.h) / 2,
      w: from.w,
      h: from.h,
    };
    slot.classList.add('incoming');
    const copy = tileImg(image, from);
    this.layer.appendChild(copy);
    const flight = copy.animate(
      [
        { transform: 'translate(0, 0)' },
        { transform: `translate(${landing.x - from.x}px, ${landing.y - from.y}px)` },
      ],
      { duration: TRAY_FLY_MS, easing: 'ease-in', fill: 'forwards' },
    );
    this.track(copy, [flight], () => {
      slot.classList.remove('incoming');
      onArrive();
    });
  }

  /**
   * The fourth tile's landing when it fills the holder and ends the level
   * (issue #121) — heavier and faster than `flyToSlot`, with a squash on
   * impact, so it reads as a slam rather than a park. Same `.incoming`
   * cover-up and reduced-motion short-circuit as `flyToSlot`; the shake, wash
   * and dialog that follow are main.ts's `presentLossCelebration`, timed off
   * the same SLAM_MS so they land together without this method knowing about
   * them.
   */
  slamToSlot(image: string, from: Box, slot: HTMLElement, onArrive: () => void): void {
    if (this.reduced()) {
      onArrive();
      return;
    }
    const to = slot.getBoundingClientRect();
    const landing: Box = {
      x: to.x + (to.width - from.w) / 2,
      y: to.y + (to.height - from.h) / 2,
      w: from.w,
      h: from.h,
    };
    slot.classList.add('incoming');
    const copy = tileImg(image, from);
    this.layer.appendChild(copy);
    const dx = landing.x - from.x;
    const dy = landing.y - from.y;
    const steps = 12;
    const keyframes: Keyframe[] = Array.from({ length: steps + 1 }, (_, i) => {
      const t = (i / steps) * SLAM_MS;
      const p = slamProgress(t);
      const s = slamSquash(t);
      return { transform: `translate(${dx * p}px, ${dy * p}px) scale(${s})` };
    });
    const flight = copy.animate(keyframes, {
      duration: SLAM_MS,
      easing: 'linear',
      fill: 'forwards',
    });
    this.track(copy, [flight], () => {
      slot.classList.remove('incoming');
      onArrive();
    });
  }

  /**
   * A completed pair resolving in the tray (issue #93): the tapped tile flies
   * in from the board, lands beside its already-parked partner over the slot,
   * the two dwell side by side, then clear together — score popup and a
   * particle burst anchored at the slot. `onClear` fires at the moment the
   * pair starts to clear (the haptic's cue, as the collision was in #44).
   *
   * The model already removed both tiles and the redraw already emptied the
   * slot, so everything visible here is overlay copies painting over a slot
   * that is really vacant — which is also why nothing can be matched twice.
   */
  pairClear(
    images: { readonly incoming: string; readonly parked: string },
    from: Box,
    slot: HTMLElement,
    points: number,
    onClear: () => void,
  ): void {
    const to = slot.getBoundingClientRect();
    const anchor = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    if (this.reduced()) {
      onClear();
      this.scorePop(anchor, points, true);
      return;
    }
    // Side by side, centred on the slot: parked copy shifts half a tile left,
    // the incoming one lands half a tile right. Transient overflow over the
    // neighbouring slot is fine — the pair is cleared before it can mislead.
    const parkedBox: Box = {
      x: anchor.x - from.w,
      y: anchor.y - from.h / 2,
      w: from.w,
      h: from.h,
    };
    const incomingBox: Box = { ...parkedBox, x: anchor.x };
    const parked = tileImg(images.parked, parkedBox);
    const incoming = tileImg(images.incoming, incomingBox);
    this.layer.append(parked, incoming);

    // The parked copy covers the emptied slot while its partner is in flight,
    // sliding from the slot centre to its side-by-side seat as the pair forms.
    const makeRoom = parked.animate(
      [
        { transform: `translate(${anchor.x - from.w / 2 - parkedBox.x}px, 0)` },
        { transform: 'translate(0, 0)' },
      ],
      { duration: TRAY_FLY_MS, easing: 'ease-out', fill: 'forwards' },
    );
    const flight = incoming.animate(
      [
        { transform: `translate(${from.x - incomingBox.x}px, ${from.y - incomingBox.y}px)` },
        { transform: 'translate(0, 0)' },
      ],
      { duration: TRAY_FLY_MS, easing: 'ease-in', fill: 'forwards' },
    );
    // Dwell, then clear: both copies scale down and fade together.
    const clear = (node: HTMLElement): Animation =>
      node.animate(
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0 },
          {
            transform: 'translate(0, 0) scale(1)',
            opacity: 1,
            offset: PAIR_SHOW_MS / (PAIR_SHOW_MS + PAIR_CLEAR_MS),
          },
          { transform: `translate(0, 0) scale(${END_SCALE})`, opacity: 0, offset: 1 },
        ],
        {
          duration: PAIR_SHOW_MS + PAIR_CLEAR_MS,
          delay: TRAY_FLY_MS,
          easing: 'linear',
          fill: 'forwards',
        },
      );
    const clears = [clear(parked), clear(incoming)];
    // The clear moment — haptic, popup, sparks. Epoch-guarded like every
    // track: a clear() mid-dwell (undo, new deal, tab hidden) rescinds the
    // whole show, side effects included.
    const epoch = this.epoch;
    window.setTimeout(() => {
      if (epoch !== this.epoch) return;
      onClear();
      this.scorePop(anchor, points, false);
      this.burst(anchor, from.w);
    }, TRAY_FLY_MS + PAIR_SHOW_MS);
    this.track(parked, [makeRoom, clears[0]!]);
    this.track(incoming, [flight, clears[1]!]);
  }

  /** The "+points" popup, rising and fading from the slot (issue #93). Reduced
   *  motion keeps it — it is information, not motion — but only fades it. */
  private scorePop(anchor: { x: number; y: number }, points: number, still: boolean): void {
    const node = document.createElement('div');
    node.className = 'fx-score';
    node.textContent = `+${points}`;
    node.style.left = `${anchor.x}px`;
    node.style.top = `${anchor.y}px`;
    this.layer.appendChild(node);
    const anim = node.animate(
      still
        ? [{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }]
        : [
            { transform: 'translate(-50%, -50%)', opacity: 1 },
            { transform: 'translate(-50%, -160%)', opacity: 0 },
          ],
      { duration: SCORE_POP_MS, easing: 'ease-out', fill: 'forwards' },
    );
    this.track(node, [anim]);
  }

  /** The leaf-light particle burst at the pair clear — anim.ts geometry, DOM
   *  sparks. Never under reduced motion (pairClear short-circuits first). */
  private burst(anchor: { x: number; y: number }, tileW: number): void {
    const scale = (tileW / 64) * SPARK_DISTANCE_FACTOR;
    for (const p of particleBurst(this.seed++)) {
      const node = document.createElement('div');
      node.className = 'fx-spark';
      node.style.left = `${anchor.x}px`;
      node.style.top = `${anchor.y}px`;
      node.style.width = `${p.radius * 2 * scale}px`;
      node.style.height = `${p.radius * 2 * scale}px`;
      node.style.background = SPARK_COLOR;
      this.layer.appendChild(node);
      const end = particleFrame(p, Number.POSITIVE_INFINITY);
      const anim = node.animate(
        [
          { transform: 'translate(-50%, -50%)', opacity: 1 },
          {
            transform: `translate(calc(-50% + ${end.x * scale}px), calc(-50% + ${end.y * scale}px))`,
            opacity: 0,
          },
        ],
        { duration: PAIR_CLEAR_MS, easing: 'ease-out', fill: 'forwards' },
      );
      this.track(node, [anim]);
    }
  }
}
