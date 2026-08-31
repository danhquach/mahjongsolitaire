// App bootstrap for the vertical slice (issue #11): one Turtle level,
// tap-only input, playable end-to-end in any browser, portrait or landscape.

import { Application } from 'pixi.js';
import { generateValidatedLevel } from '@mahjongsolitaire/core';
import { Game } from './game.js';
import { tileRect } from './geometry.js';
import { hitTest } from './hit-test.js';
import { parseLayout } from './layout-loader.js';
import { BoardRenderer } from './render.js';
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
  boardDiv.insertBefore(app.canvas, overlay);

  const renderer = new BoardRenderer(app, layout.slots);

  let seed = randomSeed();
  let game = new Game(generateValidatedLevel(layout, seed));
  let flash: readonly number[] = [];
  let flashToken = 0;

  function redraw(): void {
    renderer.draw(game, { selection: game.selection, flash });
    scoreEl.textContent = String(game.score);
    tilesLeftEl.textContent = String(game.tilesLeft);
  }

  function showStatus(): void {
    const status = game.status();
    if (status === 'playing') {
      overlay.classList.remove('visible');
      return;
    }
    if (status === 'won') {
      overlayTitle.textContent = 'Level complete!';
      overlayText.textContent = `Final score: ${game.score}`;
    } else {
      overlayTitle.textContent = 'No moves left';
      overlayText.textContent =
        'This deal has no matching free pair remaining. Shuffle arrives with the boosters — for now, restart or start a new game.';
    }
    overlay.classList.add('visible');
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

  function newGame(nextSeed: number): void {
    seed = nextSeed;
    game = new Game(generateValidatedLevel(layout, seed));
    flash = [];
    flashToken++;
    overlay.classList.remove('visible');
    redraw();
  }

  app.canvas.addEventListener('pointerdown', (ev) => {
    if (game.status() !== 'playing') return;
    const p = renderer.toBoardPoint(ev.offsetX, ev.offsetY);
    const hit = hitTest(game.hitCandidates(), p.x, p.y, FORGIVENESS_DP / renderer.scale);
    const outcome: TapOutcome = game.tap(hit, performance.now());
    if (outcome.kind === 'mismatch') flashTiles([outcome.a, outcome.b]);
    else if (outcome.kind === 'blocked') flashTiles([outcome.id]);
    redraw();
    showStatus();
  });

  app.renderer.on('resize', () => {
    renderer.layoutToViewport();
    redraw();
  });

  el<HTMLButtonElement>('btn-new').addEventListener('click', () => newGame(randomSeed()));
  el<HTMLButtonElement>('btn-restart').addEventListener('click', () => newGame(seed));
  el<HTMLButtonElement>('overlay-new').addEventListener('click', () => newGame(randomSeed()));
  el<HTMLButtonElement>('overlay-restart').addEventListener('click', () => newGame(seed));

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
    tileCssRect(id: number): { x: number; y: number; w: number; h: number } {
      const r = tileRect(game.board.get(id).slot);
      const p = renderer.toCssPoint(r.x, r.y);
      return { x: p.x, y: p.y, w: r.w * renderer.scale, h: r.h * renderer.scale };
    },
  };
}

start().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = `Failed to start: ${String(err)}`;
});
