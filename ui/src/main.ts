// App bootstrap for the vertical slice (issue #11): one Turtle level,
// tap-only input, playable end-to-end in any browser, portrait or landscape.
// Issue #12 adds the accessibility foundation: a DOM/ARIA mirror of the board
// (see a11y.ts), spoken outcomes, and 48dp focus targets.
// Issue #13 wires the three boosters — Hint / Undo / Shuffle — to the core
// primitives via game.ts, with charges persisted by boosters.ts.

import { Application } from 'pixi.js';
import { generateValidatedLevel } from '@mahjongsolitaire/core';
import type { Slot, TileId } from '@mahjongsolitaire/core';
import { A11yLayer, Announcer, slotPosition } from './a11y.js';
import type { A11yTile } from './a11y.js';
import { BoosterCharges } from './boosters.js';
import type { BoosterKind, ChargeStorage } from './boosters.js';
import { faceStyle } from './faces.js';
import { Game } from './game.js';
import { tileRect } from './geometry.js';
import type { Rect } from './geometry.js';
import { hitTest } from './hit-test.js';
import { parseLayout } from './layout-loader.js';
import { BoardRenderer } from './render.js';
import type { Hit } from './hit-test.js';
import type { HintPair, TapOutcome } from './game.js';

/** Spec §7: mis-tap forgiveness radius, in dp (≈ CSS px on the web). */
const FORGIVENESS_DP = 8;
const FLASH_MS = 250;

/** Visible booster labels, and the plural used when announcing the balance. */
const BOOSTER_LABEL: Record<BoosterKind, string> = {
  hint: 'Hint',
  undo: 'Undo',
  shuffle: 'Shuffle',
};
const BOOSTER_PLURAL: Record<BoosterKind, string> = {
  hint: 'hints',
  undo: 'undos',
  shuffle: 'shuffles',
};

/** localStorage throws outright when site data is blocked; charges then live
 *  in memory for the session (boosters.ts treats storage as best-effort). */
function chargeStorage(): ChargeStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

async function start(): Promise<void> {
  const boardDiv = el<HTMLDivElement>('board');
  const scoreEl = el<HTMLElement>('score');
  const tilesLeftEl = el<HTMLElement>('tiles-left');
  const overlay = el<HTMLDivElement>('overlay');
  const overlayTitle = el<HTMLElement>('overlay-title');
  const overlayText = el<HTMLElement>('overlay-text');
  const overlayRestart = el<HTMLButtonElement>('overlay-restart');
  const overlayShuffle = el<HTMLButtonElement>('overlay-shuffle');
  const overlayUndo = el<HTMLButtonElement>('overlay-undo');
  const a11yRoot = el<HTMLDivElement>('a11y-layer');
  const header = el<HTMLElement>('app-header');
  const boosterRail = el<HTMLDivElement>('booster-rail');

  const layoutRes = await fetch('layouts/turtle_classic.json');
  if (!layoutRes.ok) throw new Error(`layout fetch failed: ${layoutRes.status}`);
  const layout = parseLayout(await layoutRes.json());

  const app = new Application();
  await app.init({
    resizeTo: boardDiv,
    background: 0x14532d,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    antialias: true,
  });
  // The canvas is decorative: every tile it paints also exists as a button in
  // #a11y-layer, so exposing it twice would double every announcement.
  app.canvas.setAttribute('aria-hidden', 'true');
  // Below the a11y layer in paint order, so tile focus rings stay visible.
  boardDiv.insertBefore(app.canvas, a11yRoot);

  const renderer = new BoardRenderer(app, layout.slots);
  const announcer = new Announcer(el<HTMLElement>('a11y-status'));

  const charges = new BoosterCharges(chargeStorage());
  const boosterUi: Record<BoosterKind, { button: HTMLButtonElement; badge: HTMLElement }> = {
    hint: { button: el<HTMLButtonElement>('btn-hint'), badge: el<HTMLElement>('charges-hint') },
    undo: { button: el<HTMLButtonElement>('btn-undo'), badge: el<HTMLElement>('charges-undo') },
    shuffle: {
      button: el<HTMLButtonElement>('btn-shuffle'),
      badge: el<HTMLElement>('charges-shuffle'),
    },
  };

  let seed = randomSeed();
  let game = new Game(generateValidatedLevel(layout, seed));
  let flash: readonly number[] = [];
  let flashToken = 0;
  let overlayVisible = false;
  /** Tiles the last Hint pointed at — highlighted until the board changes. */
  let hintPair: readonly TileId[] = [];
  /** Shuffles taken on this deal; feeds the shuffle seed so a given
   *  (level seed, shuffle index) always produces the same board. */
  let shuffleCount = 0;

  /** Canvas-relative CSS-px rect of a tile's top face (a11y nodes + QA). */
  function tileCssRect(slot: Slot): Rect {
    const r = tileRect(slot);
    const p = renderer.toCssPoint(r.x, r.y);
    return { x: p.x, y: p.y, w: r.w * renderer.scale, h: r.h * renderer.scale };
  }

  function a11yTiles(): A11yTile[] {
    return game.board
      .presentTiles()
      .map((t) => ({ id: t.id, slot: t.slot, face: t.face, free: game.board.isFree(t.id) }));
  }

  const a11y = new A11yLayer(a11yRoot, (id) => activateTile(id));

  function label(id: TileId): string {
    return faceStyle(game.board.get(id).face).label;
  }

  function redraw(): void {
    renderer.draw(game, { selection: game.selection, flash, hint: hintPair });
    scoreEl.textContent = String(game.score);
    tilesLeftEl.textContent = String(game.tilesLeft);
    syncBoosterButtons();
    a11y.sync(a11yTiles(), game.selection, (t) => tileCssRect(t.slot));
  }

  /** Charge badges + accessible names. Buttons stay enabled at zero charges so
   *  a press can explain itself (see index.html) — `.spent` is the visual cue,
   *  and the balance is spelled out in the accessible name either way. */
  function syncBoosterButtons(): void {
    for (const kind of ['hint', 'undo', 'shuffle'] as const) {
      const left = charges.remaining(kind);
      const { button, badge } = boosterUi[kind];
      badge.textContent = String(left);
      button.classList.toggle('spent', left === 0);
      button.setAttribute(
        'aria-label',
        left === 0
          ? `${BOOSTER_LABEL[kind]}, no ${BOOSTER_PLURAL[kind]} left`
          : `${BOOSTER_LABEL[kind]}, ${left} ${left === 1 ? 'charge' : 'charges'} left`,
      );
    }
    overlayShuffle.textContent = `Shuffle (${charges.remaining('shuffle')})`;
    overlayUndo.textContent = `Undo (${charges.remaining('undo')})`;
  }

  function showStatus(): void {
    const status = game.status();
    if (status === 'playing') {
      hideOverlay();
      return;
    }
    // Everything below is the once-per-level transition into the end dialog:
    // re-running it would re-announce the result and re-steal focus.
    if (overlayVisible) return;
    // Spec §4: a deadlock never hard-fails the player — the dialog offers the
    // boosters that can lift it before it offers a restart.
    const canShuffle = status === 'stuck' && charges.has('shuffle');
    const canUndo = status === 'stuck' && charges.has('undo') && game.undoDepth > 0;
    overlayShuffle.hidden = !canShuffle;
    overlayUndo.hidden = !canUndo;
    if (status === 'won') {
      overlayTitle.textContent = 'Level complete!';
      overlayText.textContent = `Final score: ${game.score}`;
      announcer.say(`Level complete. Final score ${game.score}.`);
    } else {
      const ways = [
        canShuffle ? 'Shuffle re-randomizes the tiles still on the board' : null,
        canUndo ? 'Undo takes back your last match' : null,
      ].filter((w) => w !== null);
      overlayTitle.textContent = 'No moves left';
      overlayText.textContent = `This deal has no matching free pair remaining.${
        ways.length > 0 ? ` ${ways.join('; ')}.` : ''
      }`;
      announcer.say(
        `No moves left. ${ways.length > 0 ? `${ways.join('; ')}; ` : ''}restart the level, or start a new game.`,
      );
    }
    overlayVisible = true;
    overlay.classList.add('visible');
    setBackgroundInert(true);
    // Focus the way out, not the way back: Shuffle if it can help, else Undo,
    // and only then the restart the player loses progress to.
    (canShuffle ? overlayShuffle : canUndo ? overlayUndo : overlayRestart).focus();
  }

  /**
   * `aria-modal` only tells assistive technology to ignore the background — it
   * does not stop Tab from walking into it. Inert every region outside the
   * dialog so keyboard and AT agree on what is reachable.
   */
  function setBackgroundInert(inert: boolean): void {
    a11y.setInert(inert);
    for (const region of [header, boosterRail]) {
      if (inert) region.setAttribute('inert', '');
      else region.removeAttribute('inert');
    }
  }

  /** Close the end-of-level dialog. Returns whether it had been open. */
  function hideOverlay(): boolean {
    if (!overlayVisible) return false;
    overlayVisible = false;
    overlay.classList.remove('visible');
    setBackgroundInert(false);
    return true;
  }

  function flashTiles(ids: readonly number[]): void {
    flash = ids;
    const token = ++flashToken;
    setTimeout(() => {
      if (token !== flashToken) return;
      flash = [];
      redraw();
    }, FLASH_MS);
  }

  /** Speak what a tap did — the canvas shows it, but only visually. */
  function announce(outcome: TapOutcome): void {
    switch (outcome.kind) {
      case 'matched':
        announcer.say(
          `${label(outcome.a)} pair matched. ${game.tilesLeft} tiles left. Score ${game.score}.`,
        );
        break;
      case 'mismatch':
        announcer.say(`${label(outcome.a)} and ${label(outcome.b)} do not match.`);
        break;
      case 'blocked':
        announcer.say(`${label(outcome.id)} is blocked by another tile.`);
        break;
      case 'selection-cleared':
        announcer.say('Selection cleared.');
        break;
      default:
        // select / deselect are carried by the button's aria-pressed state.
        break;
    }
  }

  /** Where a hinted tile is, in the same words the a11y layer uses. */
  function describePair(pair: HintPair): string {
    const at = (id: TileId): string => {
      const { row, col } = slotPosition(game.board.get(id).slot);
      return `row ${row} column ${col}`;
    };
    return `two ${label(pair[0])} tiles, ${at(pair[0])} and ${at(pair[1])}`;
  }

  /**
   * Run one booster. `ok` is the charge decision: false means the board is
   * unchanged (no legal pair to hint, empty move stack, unshufflable board) and
   * the press must cost the player nothing (spec §5 charge accounting).
   */
  function runBooster(kind: BoosterKind): { readonly ok: boolean; readonly message: string } {
    switch (kind) {
      case 'hint': {
        const pair = game.hint();
        if (pair === null) return { ok: false, message: 'No matching pair is free. Try Shuffle.' };
        hintPair = pair;
        return { ok: true, message: `Hint: ${describePair(pair)}.` };
      }
      case 'undo': {
        const pair = game.undo();
        if (pair === null) return { ok: false, message: 'Nothing to undo yet.' };
        hintPair = [];
        return {
          ok: true,
          message: `Undo: ${label(pair[0])} pair restored. ${game.tilesLeft} tiles left. Score ${game.score}.`,
        };
      }
      case 'shuffle': {
        // Deterministic per (level seed, shuffle index) so a replay of the same
        // deal reproduces the same shuffled boards.
        const shuffleSeed = (seed + 0x9e3779b1 * (shuffleCount + 1)) >>> 0;
        if (!game.shuffle(shuffleSeed)) {
          return { ok: false, message: 'This board cannot be shuffled.' };
        }
        shuffleCount++;
        hintPair = [];
        return { ok: true, message: `Board shuffled. ${game.tilesLeft} tiles rearranged.` };
      }
    }
  }

  /** One booster press: run it, charge only a successful use, then speak the
   *  outcome and the remaining balance. */
  function useBooster(kind: BoosterKind): void {
    // Only the rail can reach this branch: the dialog hides a booster it has no
    // charge for, and the rail is inert while the dialog is open.
    if (!charges.has(kind)) {
      announcer.say(`No ${BOOSTER_PLURAL[kind]} left.`);
      return;
    }
    const fromDialog = overlayVisible;
    const result = runBooster(kind);
    if (result.ok) charges.spend(kind);
    redraw();
    // Undo and Shuffle can lift a deadlock: showStatus closes the dialog once
    // the board is playable again.
    showStatus();
    // A refused shuffle is deterministic for this board (some end positions —
    // a pair stacked on itself — have no solvable face assignment at all), so
    // stop offering it and point at the way out that still works.
    if (!result.ok && kind === 'shuffle' && overlayVisible) {
      overlayShuffle.hidden = true;
      (overlayUndo.hidden ? overlayRestart : overlayUndo).focus();
    }
    const left = charges.remaining(kind);
    announcer.say(
      result.ok ? `${result.message} ${left} ${BOOSTER_PLURAL[kind]} left.` : result.message,
    );
    // Closing the dialog drops focus to <body>; put it back on the board.
    if (fromDialog && !overlayVisible) a11y.focusActive();
  }

  function applyTap(hit: Hit): void {
    const outcome: TapOutcome = game.tap(hit, performance.now());
    // A match changes the board, so the highlighted hint is stale. Any other
    // tap keeps it: selecting one hinted tile must not hide its partner.
    if (outcome.kind === 'matched') hintPair = [];
    if (outcome.kind === 'mismatch') flashTiles([outcome.a, outcome.b]);
    else if (outcome.kind === 'blocked') flashTiles([outcome.id]);
    redraw();
    // A level-ending move is announced once, by showStatus: two live-region
    // writes in the same tick coalesce and the first is never spoken.
    if (game.status() === 'playing') announce(outcome);
    showStatus();
  }

  /**
   * Keyboard / assistive-technology activation of a tile node. Bypasses the
   * mis-tap forgiveness deliberately: the intent is already unambiguous.
   */
  function activateTile(id: TileId): void {
    if (game.status() !== 'playing') return;
    applyTap(
      game.board.isFree(id) ? { kind: 'free', id, forgiven: false } : { kind: 'blocked', id },
    );
  }

  function newGame(nextSeed: number): void {
    seed = nextSeed;
    game = new Game(generateValidatedLevel(layout, seed));
    flash = [];
    flashToken++;
    hintPair = [];
    shuffleCount = 0;
    const fromDialog = hideOverlay();
    redraw();
    // Hiding the dialog drops focus to <body>; put it back on the board. Only
    // when the dialog was the source — a header tap should keep its own focus.
    if (fromDialog) a11y.focusActive();
    announcer.say(`New game dealt. ${game.tilesLeft} tiles.`);
  }

  app.canvas.addEventListener('pointerdown', (ev) => {
    if (game.status() !== 'playing') return;
    const p = renderer.toBoardPoint(ev.offsetX, ev.offsetY);
    const hit = hitTest(game.hitCandidates(), p.x, p.y, FORGIVENESS_DP / renderer.scale);
    applyTap(hit);
  });

  app.renderer.on('resize', () => {
    renderer.layoutToViewport();
    redraw();
  });

  boosterUi.hint.button.addEventListener('click', () => useBooster('hint'));
  boosterUi.undo.button.addEventListener('click', () => useBooster('undo'));
  boosterUi.shuffle.button.addEventListener('click', () => useBooster('shuffle'));
  overlayShuffle.addEventListener('click', () => useBooster('shuffle'));
  overlayUndo.addEventListener('click', () => useBooster('undo'));
  el<HTMLButtonElement>('btn-new').addEventListener('click', () => newGame(randomSeed()));
  el<HTMLButtonElement>('btn-restart').addEventListener('click', () => newGame(seed));
  el<HTMLButtonElement>('overlay-new').addEventListener('click', () => newGame(randomSeed()));
  overlayRestart.addEventListener('click', () => newGame(seed));

  renderer.layoutToViewport();
  redraw();

  // Debug handle for scripted end-to-end QA (Playwright drives real pointer
  // events through it — see ui/qa/). Read-only accessors; harmless in a
  // playtest build.
  (window as unknown as Record<string, unknown>)['__slice'] = {
    get game() {
      return game;
    },
    renderer,
    /** Canvas-relative CSS-px rect of a tile's top face (QA taps + audits). */
    tileCssRect(id: number): Rect {
      return tileCssRect(game.board.get(id).slot);
    },
    /** Booster balances + the highlighted hint (issue #13 QA assertions). */
    boosterCharges(): Record<BoosterKind, number> {
      return {
        hint: charges.remaining('hint'),
        undo: charges.remaining('undo'),
        shuffle: charges.remaining('shuffle'),
      };
    },
    get hintPair() {
      return hintPair;
    },
  };
}

start().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = `Failed to start: ${String(err)}`;
});
