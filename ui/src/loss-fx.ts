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

/** The deadlock's own wash (issue #122): a lighter slate rather than the
 *  loss's dark red, and gentler still — a deadlock is recoverable, so the
 *  presentation reads as "paused" rather than "lost". Passed to `wash()`
 *  rather than given its own layer or class, per the file's own reuse
 *  contract. */
export const STUCK_WASH_COLOR = '#334155';
export const STUCK_WASH_OPACITY = 0.45;
export const STUCK_WASH_OPACITY_REDUCED = 0.3;

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
   * The wash over the board — the loss's dark red (issue #121) by default, or
   * the deadlock's lighter slate (issue #122) via `color`/`opacity`/
   * `reducedOpacity`. Fades in over `durationMs` (LOSS_WASH_MS by default);
   * `instant` skips straight to the final opacity — used for reduced motion
   * (which also lowers that final opacity) and for a reload of an
   * already-ended save (full opacity, no fade: the fight already happened
   * before this page load, so there is nothing left to animate into).
   * `sweep` adds a left-to-right clip-path reveal alongside the fade — the
   * deadlock's grey-out sweeps that way (issue #122); the loss's own wash
   * settles everywhere at once and leaves it off.
   */
  wash(opts: {
    readonly reduced: boolean;
    readonly instant: boolean;
    readonly color?: string;
    readonly opacity?: number;
    readonly reducedOpacity?: number;
    readonly durationMs?: number;
    readonly sweep?: boolean;
  }): void {
    // One wash at a time: a second call replaces, never stacks.
    this.washNode?.remove();
    const node = document.createElement('div');
    node.className = 'fx-loss-wash';
    if (opts.color) node.style.background = opts.color;
    this.washLayer.appendChild(node);
    this.washNode = node;
    const target = opts.reduced
      ? (opts.reducedOpacity ?? WASH_OPACITY_REDUCED)
      : (opts.opacity ?? WASH_OPACITY);
    if (opts.instant) {
      node.style.opacity = String(target);
      return;
    }
    const keyframes: Keyframe[] = opts.sweep
      ? [
          { opacity: 0, clipPath: 'inset(0 100% 0 0)' },
          { opacity: target, clipPath: 'inset(0 0% 0 0)' },
        ]
      : [{ opacity: 0 }, { opacity: target }];
    const anim = node.animate(keyframes, {
      duration: opts.durationMs ?? LOSS_WASH_MS,
      easing: 'ease-in',
      fill: 'forwards',
    });
    this.track(anim);
  }
}
