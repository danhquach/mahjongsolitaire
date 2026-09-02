// The holder-full loss's DOM effects (issue #121): the holder-strip shake and
// the dark red wash over the board. A separate file from win-fx.ts rather
// than folding in — a different terminal state with its own visuals — but
// the same small WAA/track()/epoch bookkeeping pattern, which is cheap enough
// to repeat rather than force the two into one abstraction.
//
// Same contract as every other effect file in the app: nothing here is
// awaited by the input path (already blocked once the holder is full — the
// canvas ignores taps once `status()` leaves 'playing') and nothing touches
// game state, only pictures and a CSS class. Reduced motion (read once per
// call, from main.ts) skips the shake outright and collapses the wash to an
// instant appearance rather than a fade — see `wash`'s `instant` option,
// which a reload of an already-lost save also uses (spec §3.5: resuming into
// a fight that already happened replays its result, not the fight).

import { LOSS_WASH_MS, SHAKE_MS, holderShakeOffset } from './anim.js';

/** Full-strength wash colour — dark red, not opaque, so the board's shapes
 *  still read faintly underneath it. */
const WASH_OPACITY = 0.6;
/** Reduced-motion wash: present, but lighter — motion is what's cut, not the
 *  result itself. */
const WASH_OPACITY_REDUCED = 0.35;

/** Samples a pure `(t) => value` curve into Web Animations keyframes — same
 *  trick win-fx.ts's `sample` uses for its own non-linear curves. */
function sample(durationMs: number, valueAt: (t: number) => number, steps = 20): readonly number[] {
  return Array.from({ length: steps + 1 }, (_, i) => valueAt((i / steps) * durationMs));
}

export class LossFx {
  private live = 0;
  private epoch = 0;
  private washNode: HTMLElement | null = null;

  constructor(
    /** The dedicated layer the wash div is mounted into (its own stacking
     *  context over the board, under the dialog — see index.html). */
    private readonly washLayer: HTMLElement,
    /** The holder strip's own root — shaken directly, not through a layer. */
    private readonly holderRoot: HTMLElement,
    private readonly reduced: () => boolean,
  ) {}

  /** Live effect count — folds into the QA harness's `animating()`. */
  get busy(): boolean {
    return this.live > 0;
  }

  /** Drop every live effect: a new deal, or the page going hidden mid-loss. */
  clear(): void {
    this.epoch++;
    this.live = 0;
    for (const anim of this.holderRoot.getAnimations()) anim.cancel();
    if (this.washNode) {
      this.washNode.remove();
      this.washNode = null;
    }
  }

  private track(animation: Animation): void {
    this.live++;
    const epoch = this.epoch;
    void animation.finished
      .catch(() => {
        // A cancelled animation (clear() mid-flight) rejects.
      })
      .then(() => {
        if (epoch !== this.epoch) return;
        this.live--;
      });
  }

  /** Two swings of the holder strip (issue #121), reusing the blocked-tap
   *  shake's own duration. Never called under reduced motion. */
  shake(): void {
    const keyframes = sample(SHAKE_MS, holderShakeOffset).map((x) => ({
      transform: `translateX(${x}px)`,
    }));
    const anim = this.holderRoot.animate(keyframes, {
      duration: SHAKE_MS,
      easing: 'linear',
    });
    this.track(anim);
  }

  /**
   * The dark red wash over the board (issue #121). Fades in over
   * LOSS_WASH_MS by default; `instant` skips straight to the final opacity —
   * used for reduced motion (which also lowers that final opacity) and for a
   * reload of an already-lost save (full opacity, no fade: the level ended
   * before this page load, so there is nothing left to animate into).
   */
  wash(opts: { readonly reduced: boolean; readonly instant: boolean }): void {
    // One wash at a time: a second call replaces, never stacks.
    this.washNode?.remove();
    const node = document.createElement('div');
    node.className = 'fx-loss-wash';
    this.washLayer.appendChild(node);
    this.washNode = node;
    const target = opts.reduced ? WASH_OPACITY_REDUCED : WASH_OPACITY;
    if (opts.instant) {
      node.style.opacity = String(target);
      return;
    }
    const anim = node.animate([{ opacity: 0 }, { opacity: target }], {
      duration: LOSS_WASH_MS,
      easing: 'ease-in',
      fill: 'forwards',
    });
    this.track(anim);
  }
}
