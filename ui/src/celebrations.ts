// The end-of-level celebrations' browser wiring (issues #120, #121, #122),
// moved out of main.ts by issue #244: the win's cascade, lanterns and score
// count-up, the holder-full loss's slam beat with its shake, wash and slump,
// the deadlock's slate wash, grey-out and near-pair pulse, and the delayed
// dialog reveal each one ends in, with the timers that hold it. main.ts
// decides *that* a level ended and how the dialog reads (showStatus writes
// the title, the text, the buttons, and inerts the background before any of
// this starts); this decides how the moment is played and when the dialog
// itself becomes visible and takes focus.
//
// Not a panel: the dialog is the level's result, deliberately outside the
// PanelStack (issue #241), so nothing here registers with it.
//
// The pure parts — the curves and schedules (anim.ts), the DOM effects
// (win-fx.ts, loss-fx.ts) and the canvas effects (effects.ts) — stay where
// their tests are.

import type { Slot, TileId } from '@mahjongsolitaire/core';
import {
  SLAM_MS,
  STUCK_WASH_MS,
  lossSchedule,
  scheduleDialogDelay,
  scoreCountUp,
  stuckSchedule,
} from './anim.js';
import { cssColor } from './depth.js';
import type { BoardPalette } from './depth.js';
import { el } from './dom.js';
import type { Animator } from './effects.js';
import type { Feedback } from './feedback.js';
import type { HolderStrip } from './holder.js';
import { LossFx, STUCK_WASH_COLOR, STUCK_WASH_OPACITY, STUCK_WASH_OPACITY_REDUCED } from './loss-fx.js';
import type { BoardRenderer } from './render.js';
import { WinFx } from './win-fx.js';

/** The board as the celebrations see it: the score to show, the tiles left
 *  to sweep or slump, and the near-pairs a deadlock points at. */
export interface CelebrationBoard {
  /** The finished level's score, as the dialog shows it. */
  score(): number;
  /** Every tile still on the board with its slot: the cascade orders by the
   *  slot's column, the slump takes the ids. */
  presentTiles(): ReadonlyArray<{ readonly id: TileId; readonly slot: Slot }>;
  /** Up to three near-pairs for the deadlock's pulse (game.ts's `nearPairs`). */
  nearPairs(): ReadonlyArray<readonly [TileId, TileId]>;
}

/** What the celebrations are allowed to reach outside themselves. */
export interface CelebrationsDeps {
  /** The effective reduced-motion decision, OS preference included — read
   *  per celebration, so either source can change mid-session. */
  readonly reducedMotion: () => boolean;
  readonly board: CelebrationBoard;
  readonly feedback: Pick<Feedback, 'cue'>;
  readonly animator: Pick<Animator, 'cascade' | 'slump' | 'greyOut' | 'pulse' | 'clear'>;
  readonly holder: Pick<HolderStrip, 'setLost'>;
  readonly renderer: Pick<BoardRenderer, 'setDesaturation'>;
  /** The palette in play, for the lanterns' tint. */
  readonly paletteInPlay: () => BoardPalette;
  /** Whether the end-of-level dialog is up — the focus keeper's guard. */
  readonly overlayVisible: () => boolean;
  /** Whatever showStatus appended after "Final score: N", for the count-up. */
  readonly winScoreSuffix: () => string;
}

/** What main.ts may ask of the celebrations. */
export interface Celebrations {
  /** The win (issue #120), after showStatus has written the dialog. */
  presentWin(wayOut: HTMLButtonElement): void;
  /** The holder-full loss (issue #121); `instant` for a resumed one. */
  presentLoss(wayOut: HTMLButtonElement, instant: boolean): void;
  /** The deadlock (issue #122); `instant` for a resumed one. */
  presentStuck(wayOut: HTMLButtonElement, instant: boolean): void;
  /** Drop everything in flight — timers, effects, the holder's red border. */
  cancel(): void;
  /** Drop only the decorative DOM effects, keeping a pending dialog: the
   *  page-hide path. */
  clearFx(): void;
  /** Put the deadlock's resting wash back after a rescue that left the board
   *  still stuck. */
  restoreStuckWash(): void;
  /** Whether a DOM effect is live or a dialog is still waiting on its delay. */
  readonly busy: boolean;
}

/** Look up the dialog and effect layers, build the two DOM effects, and hand
 *  back what main.ts may ask of the celebrations. */
export function mountCelebrations(deps: CelebrationsDeps): Celebrations {
  const {
    reducedMotion,
    board,
    feedback,
    animator,
    holder,
    renderer,
    paletteInPlay,
    overlayVisible,
    winScoreSuffix,
  } = deps;

  // The end-of-level dialog and the line the score count-up rewrites.
  const overlay = el<HTMLDivElement>('overlay');
  const overlayText = el<HTMLElement>('overlay-text');
  // The loss's wash layer, and the holder strip its shake moves.
  const lossWashLayer = el<HTMLDivElement>('loss-wash-layer');
  const holderRoot = el<HTMLDivElement>('holder');

  /** An end-of-level dialog waiting out its own delay while the win
   *  celebration (issue #120) or the loss theatre (issue #121) plays —
   *  cancelled if a new level starts first. Only one is ever pending at a
   *  time, since 'won' and 'lost' are mutually exclusive statuses. */
  let pendingDialogTimer: ReturnType<typeof setTimeout> | null = null;
  /** The loss theatre's slam-landing timer (issue #121): shake/wash/slump start
   *  when the fourth tile lands. Held so cancelEndCelebration can drop it. */
  let pendingLossEffects: ReturnType<typeof setTimeout> | null = null;
  /** The score dialog's count-up (issue #120), driven independently of the
   *  timer above so it can be cancelled on its own once the dialog is
   *  already showing. */
  let scoreCountRaf: number | null = null;

  // The win celebration's DOM half (issue #120): lanterns + confetti, on
  // their own layer so clearing the tray mid-flight never touches them.
  const winFx = new WinFx(el<HTMLDivElement>('win-fx-layer'), reducedMotion);
  // The holder-full loss's DOM half (issue #121): the strip shake and the red
  // wash, on their own layer like winFx's.
  const lossFx = new LossFx(lossWashLayer, holderRoot, reducedMotion);

  /** Focus the dialog's way out, and again on the next task — issue #63's
   *  fix for a dialog opened from a tap: the canvas `pointerdown` handler is
   *  followed by the browser's own `mousedown` default action, which moves
   *  focus to <body> right after the focus above lands. Only repaired if it
   *  was actually lost, and only while the dialog is still open: an Undo that
   *  lifts a deadlock closes it and hands focus back to the board, which this
   *  must not steal. */
  function focusWayOut(wayOut: HTMLButtonElement): void {
    wayOut.focus();
    setTimeout(() => {
      if (overlayVisible() && !overlay.contains(document.activeElement)) wayOut.focus();
    }, 0);
  }

  /**
   * The win celebration (issue #120): a cascade of whatever tile pictures are
   * still on the board, lanterns and confetti behind the dialog, and the
   * win cue — all fired at once, none of it awaited. The dialog itself
   * (classList, focus, and the score count-up) follows after
   * `scheduleDialogDelay`, or immediately under reduced motion, which also
   * cancels the three visual effects and shows the final score at once.
   * `overlayVisible`/`setBackgroundInert` are already set by the caller, so a
   * tap or a booster press during the delay is already blocked.
   */
  function presentWinCelebration(wayOut: HTMLButtonElement): void {
    const reduced = reducedMotion();
    const finalScore = board.score();
    const suffix = winScoreSuffix();
    feedback.cue('win');
    if (!reduced) {
      animator.cascade(cascadeTiles());
      winFx.celebrate(cssColor(paletteInPlay().back));
    }
    const reveal = (): void => {
      pendingDialogTimer = null;
      overlay.classList.add('visible');
      if (reduced) {
        overlayText.textContent = `Final score: ${finalScore}${suffix}`;
      } else {
        animateScoreCountUp(finalScore, suffix);
      }
      focusWayOut(wayOut);
    };
    const delay = scheduleDialogDelay(reduced);
    if (delay <= 0) reveal();
    else pendingDialogTimer = setTimeout(reveal, delay);
  }

  /**
   * The holder-full loss (issue #121) — deliberately harsher than the win
   * above, and than the deadlock dialog (#122): the fourth tile's flight into
   * its slot is already a slam (finishTap uses `trayFx.slamToSlot`, timed to
   * SLAM_MS); this schedules everything that follows it on that same beat —
   * the strip's shake, its slots reddening, the board's red wash, and the
   * remaining tiles slumping — then the dialog itself after
   * `LOSS_DIALOG_DELAY_MS`, measured from the tap that filled the holder, not
   * from the slam's landing (SLAM_MS is small next to it, so the two clocks
   * agree closely enough not to need a real handoff between trayFx and here).
   *
   * `instant` skips the whole theatre and shows its resting state at once —
   * used for a reload of an already-lost save (`fromResume`, showStatus's
   * caller at boot): the fight already happened, so there is nothing to
   * replay, only the result to show. Reduced motion does the same but at a
   * lower wash opacity, and unlike `instant` still gets its own 'fail' cue —
   * motion is what reduced motion cuts, not sound or haptics, and only an
   * actual live loss (never a resume) earns either.
   * `overlayVisible`/`setBackgroundInert` are already set by the caller.
   */
  function presentLossCelebration(wayOut: HTMLButtonElement, instant: boolean): void {
    const reduced = reducedMotion();
    const skipTheatre = reduced || instant;
    if (!instant) feedback.cue('fail');
    holder.setLost(true);
    const startEffects = (): void => {
      if (skipTheatre) {
        lossFx.wash({ reduced, instant: true });
      } else {
        lossFx.shake();
        animator.slump(board.presentTiles().map((t) => t.id));
        lossFx.wash({ reduced: false, instant: false });
      }
    };
    if (skipTheatre) startEffects();
    else {
      pendingLossEffects = setTimeout(() => {
        pendingLossEffects = null;
        startEffects();
      }, SLAM_MS);
    }
    const reveal = (): void => {
      pendingDialogTimer = null;
      overlay.classList.add('visible');
      focusWayOut(wayOut);
    };
    const { dialogAtMs } = lossSchedule(skipTheatre);
    if (dialogAtMs <= 0) reveal();
    else pendingDialogTimer = setTimeout(reveal, dialogAtMs);
  }

  /**
   * The deadlock's presentation (issue #122) — deliberately gentler than the
   * holder-full loss above: Shuffle or Undo can lift a deadlock, so it reads
   * as "paused" rather than "lost", and there is no slam to wait out, so the
   * wash/grey-out/pulse start right away rather than on a delayed beat.
   * The slate wash and the board-wide grey-out fade in together over
   * STUCK_WASH_MS, up to three near-pairs (`nearPairs`) each pulse an amber
   * outline once, staggered, and the dialog itself follows after
   * STUCK_DIALOG_DELAY_MS.
   *
   * `instant` (a reload of an already-stuck save) and reduced motion both
   * collapse straight to the resting grey wash with no pulse and reveal the
   * dialog at once; reduced motion still fires the 'stuck' cue (motion is
   * what it cuts, not sound/haptics) but `instant` fires neither — the
   * deadlock already happened before this load, so only its result is shown.
   * `overlayVisible`/`setBackgroundInert` are already set by the caller.
   */
  function presentStuckCelebration(wayOut: HTMLButtonElement, instant: boolean): void {
    const reduced = reducedMotion();
    const skipTheatre = reduced || instant;
    if (!instant) feedback.cue('stuck');
    lossFx.wash({
      reduced,
      instant: skipTheatre,
      color: STUCK_WASH_COLOR,
      opacity: STUCK_WASH_OPACITY,
      reducedOpacity: STUCK_WASH_OPACITY_REDUCED,
      durationMs: STUCK_WASH_MS,
      sweep: true,
    });
    animator.greyOut(skipTheatre);
    if (!skipTheatre) animator.pulse(board.nearPairs());
    const reveal = (): void => {
      pendingDialogTimer = null;
      overlay.classList.add('visible');
      // From here redraw() holds the resting grey itself (issue #159); pin
      // it now too, in case a redraw between the fade's end and this reveal
      // (a rotation mid-theatre) reset it with no live effect left to reapply.
      renderer.setDesaturation(1);
      focusWayOut(wayOut);
    };
    const { dialogAtMs } = stuckSchedule(skipTheatre);
    if (dialogAtMs <= 0) reveal();
    else pendingDialogTimer = setTimeout(reveal, dialogAtMs);
  }

  /** The tile pictures the cascade sweeps off — whatever is left on the board
   *  at the moment of a win. Decision 0013 means this is usually empty (every
   *  pair clears in the holder), so the effect is generic over zero tiles as
   *  much as any number. `column` is the tile's own slot.x: any ordering
   *  works, and it keeps tiles that share a column moving together. */
  function cascadeTiles(): ReadonlyArray<{ readonly id: TileId; readonly column: number }> {
    return board.presentTiles().map((t) => ({ id: t.id, column: t.slot.x }));
  }

  /** Count the dialog's score line from 0 to `final` (issue #120), rebuilding
   *  "Final score: N<suffix>" every frame so the Daily payout line rides
   *  along unchanged. Cancelled by `cancelEndCelebration` on a new deal. */
  function animateScoreCountUp(final: number, suffix: string): void {
    const start = performance.now();
    const step = (now: number): void => {
      const value = scoreCountUp(now - start, final);
      overlayText.textContent = `Final score: ${value}${suffix}`;
      scoreCountRaf = value < final ? requestAnimationFrame(step) : null;
    };
    scoreCountRaf = requestAnimationFrame(step);
  }

  /** Cancel an end-of-level celebration in flight — a new deal, a booster that
   *  lifted a deadlock, or a page-hide before the delayed dialog opened
   *  (issues #120 / #121). Safe to call unconditionally: every piece is a
   *  no-op when nothing is pending. */
  function cancelEndCelebration(): void {
    if (pendingDialogTimer !== null) {
      clearTimeout(pendingDialogTimer);
      pendingDialogTimer = null;
    }
    if (pendingLossEffects !== null) {
      clearTimeout(pendingLossEffects);
      pendingLossEffects = null;
    }
    if (scoreCountRaf !== null) {
      cancelAnimationFrame(scoreCountRaf);
      scoreCountRaf = null;
    }
    winFx.clear();
    lossFx.clear();
    animator.clear();
    holder.setLost(false);
  }

  /** Put the deadlock's resting wash back after an Undo or Shuffle that
   *  left the board still stuck (issue #159). No cue, no re-announcement:
   *  the dialog never closed, this only restores the wash the rescue's
   *  teardown dropped. wash() replaces its own node rather than stacking, so
   *  this does not re-fade anything — it lands straight on the same final
   *  opacity. */
  function restoreStuckWash(): void {
    const reduced = reducedMotion();
    lossFx.wash({
      reduced,
      instant: true,
      color: STUCK_WASH_COLOR,
      opacity: STUCK_WASH_OPACITY,
      reducedOpacity: STUCK_WASH_OPACITY_REDUCED,
      durationMs: STUCK_WASH_MS,
      sweep: true,
    });
  }

  return {
    presentWin: presentWinCelebration,
    presentLoss: presentLossCelebration,
    presentStuck: presentStuckCelebration,
    cancel: cancelEndCelebration,
    clearFx: () => {
      winFx.clear();
      lossFx.clear();
    },
    restoreStuckWash,
    get busy(): boolean {
      return winFx.busy || lossFx.busy || pendingDialogTimer !== null;
    },
  };
}
