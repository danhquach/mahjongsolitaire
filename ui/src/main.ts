// App bootstrap for the vertical slice (issue #11): one Turtle level,
// tap-only input, playable end-to-end in any browser, portrait or landscape.
// Issue #12 adds the accessibility foundation: a DOM/ARIA mirror of the board
// (see a11y.ts), spoken outcomes, and 48dp focus targets.

import { Application } from 'pixi.js';
import { generateValidatedLevel } from '@mahjongsolitaire/core';
import type { Slot, TileId } from '@mahjongsolitaire/core';
import { A11yLayer, Announcer } from './a11y.js';
import type { A11yTile } from './a11y.js';
import { faceStyle } from './faces.js';
import { Game } from './game.js';
import { tileRect } from './geometry.js';
import type { Rect } from './geometry.js';
import { hitTest } from './hit-test.js';
import { parseLayout } from './layout-loader.js';
import { BoardRenderer } from './render.js';
import type { Hit } from './hit-test.js';
import type { TapOutcome } from './game.js';

/** Spec §7: mis-tap forgiveness radius, in dp (≈ CSS px on the web). */
const FORGIVENESS_DP = 8;
const FLASH_MS = 250;

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
  const a11yRoot = el<HTMLDivElement>('a11y-layer');
  const header = el<HTMLElement>('app-header');

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

  let seed = randomSeed();
  let game = new Game(generateValidatedLevel(layout, seed));
  let flash: readonly number[] = [];
  let flashToken = 0;
  let overlayVisible = false;

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
    renderer.draw(game, { selection: game.selection, flash });
    scoreEl.textContent = String(game.score);
    tilesLeftEl.textContent = String(game.tilesLeft);
    a11y.sync(a11yTiles(), game.selection, (t) => tileCssRect(t.slot));
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
    if (status === 'won') {
      overlayTitle.textContent = 'Level complete!';
      overlayText.textContent = `Final score: ${game.score}`;
      announcer.say(`Level complete. Final score ${game.score}.`);
    } else {
      overlayTitle.textContent = 'No moves left';
      overlayText.textContent =
        'This deal has no matching free pair remaining. Shuffle arrives with the boosters — for now, restart or start a new game.';
      announcer.say('No moves left. Restart the level, or start a new game.');
    }
    overlayVisible = true;
    overlay.classList.add('visible');
    setBackgroundInert(true);
    overlayRestart.focus();
  }

  /**
   * `aria-modal` only tells assistive technology to ignore the background — it
   * does not stop Tab from walking into it. Inert every region outside the
   * dialog so keyboard and AT agree on what is reachable.
   */
  function setBackgroundInert(inert: boolean): void {
    a11y.setInert(inert);
    if (inert) header.setAttribute('inert', '');
    else header.removeAttribute('inert');
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

  function applyTap(hit: Hit): void {
    const outcome: TapOutcome = game.tap(hit, performance.now());
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
    applyTap(game.board.isFree(id) ? { kind: 'free', id, forgiven: false } : { kind: 'blocked', id });
  }

  function newGame(nextSeed: number): void {
    seed = nextSeed;
    game = new Game(generateValidatedLevel(layout, seed));
    flash = [];
    flashToken++;
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
  };
}

start().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = `Failed to start: ${String(err)}`;
});
