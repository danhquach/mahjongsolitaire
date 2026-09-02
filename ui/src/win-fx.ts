// The win celebration's DOM effects (issue #120): lanterns rising from the
// felt and a light confetti fall, both behind the dialog. Separate from
// tray-fx.ts (its own fixed overlay, `#win-fx-layer`) rather than folding in —
// tray-fx.ts is already a full match-feedback file, and these two effects
// share nothing with a tray flight beyond the WAA/track()/epoch bookkeeping
// pattern, which is small enough to repeat here.
//
// Same contract as every other effect in the app: nothing here is awaited by
// the input path (the dialog is already live), and nothing touches game
// state — only pictures move. Reduced motion (OS preference or the in-app
// toggle, read once at the start of the celebration) skips both effects
// entirely; the dialog's own fade-in is what reduced motion keeps.

import {
  CONFETTI_MS,
  LANTERN_MS,
  confettiFrame,
  confettiLayout,
  lanternFrame,
  lanternLayout,
} from './anim.js';
import type { ConfettiSpec, LanternSpec } from './anim.js';

/** Gold / cream / green — the palette the issue names for confetti. */
const CONFETTI_COLORS = ['#d4b96a', '#fff6d8', '#62c98a'];

/** Samples a pure `(t) => frame` curve into Web Animations keyframes — the
 *  same trick tray-fx.ts's `clear()` keyframe list uses at a coarser grain,
 *  just with more stops since these curves are not piecewise-linear. */
function sample<T>(durationMs: number, frameAt: (t: number) => T, steps = 24): readonly T[] {
  return Array.from({ length: steps + 1 }, (_, i) => frameAt((i / steps) * durationMs));
}

export class WinFx {
  private live = 0;
  private epoch = 0;
  private seed = 1;

  constructor(
    private readonly layer: HTMLElement,
    private readonly reduced: () => boolean,
  ) {}

  /** Live effect count — folds into the QA harness's `animating()` alongside
   *  the board Animator and the tray's TrayFx. */
  get busy(): boolean {
    return this.live > 0;
  }

  /** Drop every live effect — a new deal, or the page going hidden. */
  clear(): void {
    this.layer.replaceChildren();
    this.live = 0;
    this.epoch++;
  }

  private track(node: HTMLElement, animation: Animation): void {
    this.live++;
    const epoch = this.epoch;
    void animation.finished
      .catch(() => {
        // A cancelled animation (clear() mid-flight) rejects; the node is
        // already gone from the layer either way.
      })
      .then(() => {
        node.remove();
        if (epoch !== this.epoch) return;
        this.live--;
      });
  }

  /**
   * Lanterns rising from the felt and a light confetti fall behind the
   * dialog (issue #120). `tint` is a CSS colour drawn from the board's own
   * palette (main.ts), so a Daily or milestone board's lanterns read
   * differently from an ordinary level's. No-op under reduced motion.
   */
  celebrate(tint: string): void {
    if (this.reduced()) return;
    for (const spec of lanternLayout(this.seed++)) this.lantern(spec, tint);
    for (const spec of confettiLayout(this.seed++)) this.confetti(spec);
  }

  private lantern(spec: LanternSpec, tint: string): void {
    const node = document.createElement('div');
    node.className = 'fx-lantern';
    node.style.left = `${spec.x0 * 100}%`;
    node.style.background = tint;
    this.layer.appendChild(node);
    const keyframes = sample(LANTERN_MS, (t) => lanternFrame(spec, t)).map((f) => ({
      transform: `translate(${f.x}px, ${f.y}px)`,
      opacity: f.alpha,
    }));
    const anim = node.animate(keyframes, {
      duration: LANTERN_MS,
      easing: 'linear',
      fill: 'forwards',
    });
    this.track(node, anim);
  }

  private confetti(spec: ConfettiSpec): void {
    const node = document.createElement('div');
    node.className = 'fx-confetti';
    node.style.left = `${spec.x0 * 100}%`;
    node.style.background = CONFETTI_COLORS[spec.colorIndex] ?? CONFETTI_COLORS[0]!;
    this.layer.appendChild(node);
    const total = CONFETTI_MS + spec.delayMs;
    const keyframes = sample(total, (t) => confettiFrame(spec, t)).map((f) => ({
      transform: `translate(${f.x}px, ${f.y}px) rotate(${f.rotationDeg}deg)`,
      opacity: f.alpha,
    }));
    const anim = node.animate(keyframes, { duration: total, easing: 'linear', fill: 'forwards' });
    this.track(node, anim);
  }
}
