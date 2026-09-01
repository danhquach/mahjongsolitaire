// App bootstrap for the vertical slice (issue #11): one Turtle level,
// tap-only input, playable end-to-end in any browser, portrait or landscape.
// Issue #12 adds the accessibility foundation: a DOM/ARIA mirror of the board
// (see a11y.ts), spoken outcomes, and 48dp focus targets.
// Issue #13 wires the three boosters — Hint / Undo / Shuffle — to the core
// primitives via game.ts, with charges persisted by boosters.ts.
// Issue #14 adds auto-save + resume (save.ts) and the settings screen
// (settings.ts): audio and haptics via feedback.ts, tile size through the
// renderer's fit, and an opt-in count-up clock via elapsed.ts.
// Issue #37 makes the HUD edge itself part of the fit: applyHudPlacement()
// measures the board area each candidate placement would leave and keeps the
// one that fits the board larger (hud-fit.ts).
// Issue #43 adds the holder: a strip of four slots above the board (holder.ts)
// a free tile can be parked in. It is always available, so it has no charge.
// Issue #44 gives the match its feedback: the pair flies together and collides
// (effects.ts / anim.ts) while the board redraws without it, the sound answers
// the tap and the haptic waits for the impact, and reduced motion — OS
// preference or in-app toggle — substitutes a cross-fade.
// Issue #93 reworks the gesture around the holder (decision 0013): one tap on
// any revealed free tile sends it to the holder, pairs assemble and clear in
// the strip (fly-in, side-by-side dwell, score popup, particle burst — DOM
// effects in tray-fx.ts, because the strip lives outside the canvas), and
// selection stops existing as an input concept — no select, deselect or
// mismatch, and no Escape handling.
// Issue #63 makes the holder one-way and a full one final (decision 0009), so
// the HUD gains the two things a hard-fail owes the player: a warning before
// the fatal park (the last empty slot is marked, and — since issue #93 — every
// free tile with no match in the holder says that activating it sends it to
// the last slot and ends the level) and a loss dialog that offers only a
// restart, because there is nothing else left to offer.

import { Application } from 'pixi.js';
import {
  HOLDER_SLOTS,
  bandForLevel,
  concealBucketForBand,
  concealedTileIds,
  generateValidatedLevel,
  parseLadder,
  parseLayout,
} from '@mahjongsolitaire/core';
import type {
  DifficultyBucket,
  LadderEntry,
  Layout,
  MoveRecord,
  Slot,
  TileId,
} from '@mahjongsolitaire/core';
import { A11yLayer, Announcer, slotPosition } from './a11y.js';
import type { A11yTile } from './a11y.js';
import { BoosterCharges } from './boosters.js';
import type { BoosterKind } from './boosters.js';
import { Elapsed, formatElapsed } from './elapsed.js';
import { Animator } from './effects.js';
import { TrayFx } from './tray-fx.js';
import type { Box } from './tray-fx.js';
import { Feedback, navigatorVibrate, webAudioPlayer } from './feedback.js';
import type { Cue } from './feedback.js';
import { faceStyle } from './faces.js';
import { Game } from './game.js';
import { HolderStrip } from './holder.js';
import { BOARD_FELT } from './depth.js';
import { SIDE_DEPTH, TILE_H, TILE_W, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';
import { hitTest } from './hit-test.js';
import { HUD_PLACEMENTS, chooseHudPlacement } from './hud-fit.js';
import type { HudCandidate, HudPlacement } from './hud-fit.js';
import { BoardRenderer } from './render.js';
import { parseChangelog, versionLabel } from './changelog.js';
import changelogMd from '../../CHANGELOG.md?raw';
import { ProgressStore } from './progress.js';
import { SaveStore, captureSave, reopen } from './save.js';
import { SettingsStore, TILE_SIZE_FACTOR, TILE_SIZE_LABEL, TILE_SIZES } from './settings.js';
import type { TileSize } from './settings.js';
import { localKeyValueStorage } from './storage.js';
import type { Hit } from './hit-test.js';
import type { HintPair, TapOutcome } from './game.js';

/** Spec §7: mis-tap forgiveness radius, in dp (≈ CSS px on the web). */
const FORGIVENESS_DP = 8;
const FLASH_MS = 250;
/** Repaint cadence of the opt-in timed-mode readout (spec §6). */
const CLOCK_TICK_MS = 500;

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

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

/** Fetch and parse a shipped layout file (issue #79: any of the ten). */
async function fetchLayout(id: string): Promise<Layout> {
  // The id can come from a stored save record; never let it shape a path.
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`unsafe layout id: ${id}`);
  const res = await fetch(`layouts/${id}.json`);
  if (!res.ok) throw new Error(`layout fetch failed: ${res.status}`);
  return parseLayout(await res.json());
}

/** OS-level motion preference (issue #44). Absent `matchMedia` (old browsers,
 *  some test runners) simply means "no preference expressed". */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function start(): Promise<void> {
  const appRoot = el<HTMLDivElement>('app');
  const boardDiv = el<HTMLDivElement>('board');
  const scoreEl = el<HTMLElement>('score');
  const tilesLeftEl = el<HTMLElement>('tiles-left');
  const overlay = el<HTMLDivElement>('overlay');
  const overlayTitle = el<HTMLElement>('overlay-title');
  const overlayText = el<HTMLElement>('overlay-text');
  const overlayRestart = el<HTMLButtonElement>('overlay-restart');
  const overlayNew = el<HTMLButtonElement>('overlay-new');
  const levelEl = el<HTMLElement>('level');
  const overlayShuffle = el<HTMLButtonElement>('overlay-shuffle');
  const overlayUndo = el<HTMLButtonElement>('overlay-undo');
  const a11yRoot = el<HTMLDivElement>('a11y-layer');
  const header = el<HTMLElement>('app-header');
  const boosterRail = el<HTMLDivElement>('booster-rail');
  const holderRoot = el<HTMLDivElement>('holder');
  const settingsPanel = el<HTMLDivElement>('settings');
  const settingsButton = el<HTMLButtonElement>('btn-settings');
  const changelogPanel = el<HTMLDivElement>('changelog');
  const changelogBody = el<HTMLDivElement>('changelog-body');
  const changelogClose = el<HTMLButtonElement>('changelog-close');
  const timeStat = el<HTMLElement>('time-stat');
  const elapsedEl = el<HTMLElement>('elapsed');

  // One storage handle for every persisted concern (charges, settings, save,
  // ladder progress). Created before the layout is chosen: the save and the
  // ladder position are what decide which layout to boot into (issue #79).
  const storage = localKeyValueStorage();
  const progress = new ProgressStore(storage);
  const saves = new SaveStore(storage);

  // The ladder is the level sequence (decision 0011): 150 entries, each naming
  // a layout and the seed that deals it.
  const ladderRes = await fetch('ladder.json');
  if (!ladderRes.ok) throw new Error(`ladder fetch failed: ${ladderRes.status}`);
  const ladder = parseLadder(await ladderRes.json());

  /** The ladder entry a (layoutId, seed) pair belongs to — how a save record,
   *  which stores neither level number nor band, is placed back on the ladder. */
  function ladderEntryFor(layoutId: string, seed: number): LadderEntry | undefined {
    return ladder.find((e) => e.layoutId === layoutId && e.seed === seed);
  }

  /** The concealment bucket a ladder level deals at (decision 0011). */
  function concealBucketFor(level: number): DifficultyBucket {
    return concealBucketForBand(bandForLevel(level).band);
  }

  // Boot into the saved game's layout when there is a save, else the current
  // ladder level's. A save whose layout cannot be fetched (renamed id, older
  // build) reads as absent, like every other untrusted record.
  const saved = saves.load();
  let entry = ladder[progress.level - 1]!;
  let bootLayout: Layout | null = null;
  if (saved !== null) {
    try {
      bootLayout = await fetchLayout(saved.layoutId);
    } catch {
      bootLayout = null;
    }
  }
  let layout: Layout = bootLayout ?? (await fetchLayout(entry.layoutId));

  const app = new Application();
  await app.init({
    resizeTo: boardDiv,
    background: BOARD_FELT,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    antialias: true,
  });
  // The canvas is decorative: every tile it paints also exists as a button in
  // #a11y-layer, so exposing it twice would double every announcement.
  app.canvas.setAttribute('aria-hidden', 'true');
  // Below the a11y layer in paint order, so tile focus rings stay visible.
  boardDiv.insertBefore(app.canvas, a11yRoot);

  /** Deal the current ladder level on `layout` (which must already be its
   *  layout), from `seed` — the ladder's fixed seed by default, or a re-rolled
   *  one (issue #94). Concealment follows the ladder band (decision 0011). */
  function dealCurrentLevel(seed: number): Game {
    const level = generateValidatedLevel(layout, seed);
    return new Game(level, undefined, concealedTileIds(level, concealBucketFor(progress.level)));
  }

  /** A fresh seed for the same level (issue #94): New game must visibly
   *  re-deal, so never the seed already on the table. Randomness is fine here
   *  — determinism only matters *within* a deal, and the save carries whatever
   *  seed was dealt. */
  function rerollSeed(current: number): number {
    let seed = current;
    while (seed === current) seed = Math.floor(Math.random() * 0x100000000);
    return seed;
  }

  // Spec §7: resume mid-level after a force-quit. A save that cannot be
  // trusted (older build, changed layout, hand-edited record) reads as absent
  // and the player gets a fresh deal instead of an error. A ladder save's
  // concealment band is re-derived from its (layoutId, seed); a save from
  // outside the ladder (an older build's random deal) falls back to the
  // difficulty-derived default, as before.
  // A save's (layoutId, seed) normally names a ladder entry; a re-rolled deal
  // (issue #94) does not, but it is always the *current* level's, so its band
  // — and with it the concealment bucket — comes from the ladder position.
  const savedEntry = saved === null ? undefined : ladderEntryFor(saved.layoutId, saved.seed);
  const resumed =
    saved === null
      ? null
      : reopen(layout, saved, concealBucketFor(savedEntry?.level ?? progress.level));
  // A failed resume can leave the save's layout loaded; the fresh deal is the
  // current ladder level's, so re-point at its layout first.
  if (resumed === null && layout.id !== entry.layoutId) layout = await fetchLayout(entry.layoutId);
  let game = resumed ?? dealCurrentLevel(entry.seed);

  const renderer = new BoardRenderer(app, layout.slots);
  const announcer = new Announcer(el<HTMLElement>('a11y-status'));

  const settings = new SettingsStore(storage);
  const feedback = new Feedback(() => settings.value, webAudioPlayer(), navigatorVibrate());

  // Match / mismatch animation (issue #44). Reduced motion is the OS preference
  // OR the in-app toggle, read per effect so either can be changed mid-session;
  // the animator itself never touches game state or the input path.
  const animator = new Animator(app.ticker, {
    reduced: () => settings.value.reducedMotion || prefersReducedMotion(),
    tileNode: (id) => renderer.tileNode(id),
  });

  const charges = new BoosterCharges(storage);
  const boosterUi: Record<BoosterKind, { button: HTMLButtonElement; badge: HTMLElement }> = {
    hint: { button: el<HTMLButtonElement>('btn-hint'), badge: el<HTMLElement>('charges-hint') },
    undo: { button: el<HTMLButtonElement>('btn-undo'), badge: el<HTMLElement>('charges-undo') },
    shuffle: {
      button: el<HTMLButtonElement>('btn-shuffle'),
      badge: el<HTMLElement>('charges-shuffle'),
    },
  };

  let flash: readonly number[] = [];
  let flashToken = 0;
  let overlayVisible = false;
  /** A cross-layout level transition is in flight (issue #79): input on the
   *  outgoing board is dropped until the new deal is in. */
  let dealing = false;
  let settingsVisible = false;
  let changelogVisible = false;
  /** Tiles the last Hint pointed at — highlighted until the board changes. */
  let hintPair: readonly TileId[] = [];
  /** Shuffles taken on this deal; feeds the shuffle seed so a given
   *  (level seed, shuffle index) always produces the same board. Restored with
   *  the save so a resumed deal shuffles the way it would have. */
  let shuffleCount = resumed === null ? 0 : saved!.shuffles;
  const elapsed = new Elapsed(
    () => performance.now(),
    resumed === null ? 0 : saved!.elapsedMs,
  );

  /** On-screen size of a tile's picture, side depth included, CSS px — what
   *  the holder slots draw and what a tray flight carries (issue #66/#93). */
  function tileCssSize(): { w: number; h: number } {
    return {
      w: (TILE_W + SIDE_DEPTH) * renderer.scale,
      h: (TILE_H + SIDE_DEPTH) * renderer.scale,
    };
  }

  /** Canvas-relative CSS-px rect of a tile's top face (a11y nodes + QA). */
  function tileCssRect(slot: Slot): Rect {
    const r = tileRect(slot);
    const p = renderer.toCssPoint(r.x, r.y);
    return { x: p.x, y: p.y, w: r.w * renderer.scale, h: r.h * renderer.scale };
  }

  function a11yTiles(): A11yTile[] {
    return game.board.presentTiles().map((t) => ({
      id: t.id,
      slot: t.slot,
      face: t.face,
      free: game.board.isFree(t.id),
      // Visibility this frame, not deal-time concealment (issue #64): a peeked
      // tile announces its face like any other.
      concealed: game.isFaceHidden(t.id),
      // The game's own match rule (issue #93): a tile whose match is in the
      // holder announces "clear the pair" rather than "send to the holder".
      pairsWithHeld: game.pairsWithHeld(t.id),
    }));
  }

  const a11y = new A11yLayer(a11yRoot, (id) => activateTile(id));
  const holder = new HolderStrip(holderRoot, HOLDER_SLOTS);
  // The tray effects layer (issue #93): fixed overlay, page coordinates.
  const trayFx = new TrayFx(el<HTMLDivElement>('fx-layer'), () =>
    settings.value.reducedMotion || prefersReducedMotion(),
  );

  function label(id: TileId): string {
    return faceStyle(game.board.get(id).face).label;
  }

  function redraw(): void {
    renderer.draw(game, {
      flash,
      hint: hintPair,
      dimBlocked: settings.value.highlightFree,
    });
    levelEl.textContent = String(progress.level);
    scoreEl.textContent = String(game.score);
    tilesLeftEl.textContent = String(game.tilesLeft);
    syncBoosterButtons();
    holder.sync({
      slots: game.holderSlots(),
      faceOf: (id) => game.board.get(id).face,
      // A parked tile is the tile (issue #66): the renderer's own picture of
      // it, at the board's current on-screen tile size (side depth included).
      tileImage: (face) => renderer.tileImage(face),
      tileSize: tileCssSize(),
      hint: hintPair,
    });
    drawClock();
    // The last argument is the issue #63 warning: with one slot left, parking
    // an unmatched tile ends the level, so a free tile's accessible name has
    // to say so.
    a11y.sync(a11yTiles(), (t) => tileCssRect(t.slot), game.holderVacancies === 1);
  }

  /** Opt-in count-up readout (spec §6). Hidden entirely while timed mode is
   *  off, so the default board shows no clock at all. */
  function drawClock(): void {
    const { timedMode } = settings.value;
    timeStat.hidden = !timedMode;
    if (timedMode) elapsedEl.textContent = formatElapsed(elapsed.ms);
  }

  /**
   * Auto-save (spec §7: "on every move"). Called after anything that changes
   * the board or the score.
   *
   * A *won* level has nothing to resume into, so its save is dropped —
   * otherwise the next boot would reopen a cleared board. A *stuck* one is
   * still saved: spec §4 never hard-fails a deadlock, and the way out is Undo
   * or Shuffle on that exact board. Force-quitting at the deadlock dialog must
   * not throw the undo stack away.
   *
   * A *lost* one is saved too, and that is the point (issue #63): reloading a
   * nearly-full holder must not be an escape hatch, so the loss comes back with
   * the board and `showStatus` re-opens the dialog on the first frame.
   */
  function persist(): void {
    if (game.status() === 'won') saves.clear();
    else saves.write(captureSave(game, { shuffles: shuffleCount, elapsedMs: elapsed.ms }));
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
    // Spec §4: a *deadlock* never hard-fails the player — the dialog offers the
    // boosters that can lift it before it offers a restart. A full holder is
    // the exception decision 0009 introduced, and it is offered nothing: the PM
    // call is that a full holder is final, so Shuffle and Undo stay hidden
    // there. Both flags key on 'stuck' alone, which is what does that.
    const canShuffle = status === 'stuck' && charges.has('shuffle');
    const canUndo = status === 'stuck' && charges.has('undo') && game.undoDepth > 0;
    overlayShuffle.hidden = !canShuffle;
    overlayUndo.hidden = !canUndo;
    // Won overlays retitle these; every other dialog gets the defaults back.
    overlayRestart.hidden = false;
    overlayNew.textContent = 'New game';
    if (status === 'won') {
      // Advance the ladder exactly once per win: this branch is inside the
      // once-per-level transition (the overlayVisible guard above).
      const cleared = progress.level;
      const atEnd = progress.advance() === cleared;
      overlayTitle.textContent = `Level ${cleared} complete!`;
      overlayText.textContent = `Final score: ${game.score}`;
      overlayNew.textContent = atEnd ? 'Play again' : 'Next level';
      overlayRestart.hidden = true;
      announcer.say(`Level ${cleared} complete. Final score ${game.score}.`);
    } else if (status === 'lost') {
      overlayTitle.textContent = 'Holder full';
      overlayText.textContent =
        'All four holder slots hold unmatched tiles, and a tile can only leave the holder by being matched. The level is over — restart it, or start a new game.';
      announcer.say(
        `Holder full. The level is over. Score ${game.score}. Restart the level, or start a new game.`,
      );
    } else {
      const ways = [
        canShuffle ? 'Shuffle re-randomizes the tiles still on the board' : null,
        canUndo ? 'Undo takes back your last move' : null,
      ].filter((w) => w !== null);
      overlayTitle.textContent = 'No moves left';
      // "…or in the holder" is not padding: the stuck check looks through every
      // hold the holder still has room for (issue #43), so a player staring at
      // an empty slot needs telling that parking a tile has been considered.
      overlayText.textContent = `No matching pair is left within reach, on the board or in the holder.${
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
    //
    const wayOut = canShuffle
      ? overlayShuffle
      : canUndo
        ? overlayUndo
        : overlayRestart.hidden
          ? overlayNew
          : overlayRestart;
    wayOut.focus();
    // …and again on the next task, which issue #63 is what surfaced. A dialog
    // opened from a tap on the board is opened inside the canvas `pointerdown`
    // handler, and the browser's own `mousedown` follows it and moves focus to
    // <body> as its default action — so the focus above is taken straight back
    // off for exactly the player who tapped their way into the dialog. Only
    // repaired if it was actually lost, and only while the dialog is still open:
    // an Undo that lifts a deadlock closes it and hands focus back to the board,
    // which this must not steal.
    setTimeout(() => {
      if (overlayVisible && !overlay.contains(document.activeElement)) wayOut.focus();
    }, 0);
  }

  /**
   * `aria-modal` only tells assistive technology to ignore the background — it
   * does not stop Tab from walking into it. Inert every region outside the
   * dialog so keyboard and AT agree on what is reachable.
   */
  function setBackgroundInert(inert: boolean): void {
    a11y.setInert(inert);
    holder.setInert(inert);
    for (const region of [header, boosterRail, settingsButton]) {
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

  /**
   * Settings screen (spec §7): one tap from the board to open, one tap to
   * change anything — inside the "every action within 2 taps" budget. Each
   * control writes through immediately (settings.ts persists per change), so
   * there is no Save button to forget.
   */
  const settingsToggles: ReadonlyArray<{
    readonly input: HTMLInputElement;
    readonly key: 'audio' | 'haptics' | 'timedMode' | 'ads' | 'highlightFree' | 'reducedMotion';
    readonly name: string;
  }> = [
    { input: el<HTMLInputElement>('set-audio'), key: 'audio', name: 'Sound effects' },
    { input: el<HTMLInputElement>('set-haptics'), key: 'haptics', name: 'Vibration' },
    { input: el<HTMLInputElement>('set-timed'), key: 'timedMode', name: 'Timer' },
    { input: el<HTMLInputElement>('set-ads'), key: 'ads', name: 'Ads' },
    {
      input: el<HTMLInputElement>('set-highlight-free'),
      key: 'highlightFree',
      name: 'Highlight free tiles',
    },
    {
      input: el<HTMLInputElement>('set-reduced-motion'),
      key: 'reducedMotion',
      name: 'Reduced motion',
    },
  ];
  const sizeInputs: ReadonlyArray<{ readonly input: HTMLInputElement; readonly size: TileSize }> =
    TILE_SIZES.map((size) => ({ input: el<HTMLInputElement>(`set-size-${size}`), size }));

  /** Push the stored settings into the controls (open, and on boot). */
  function syncSettingsControls(): void {
    const current = settings.value;
    for (const { input, key } of settingsToggles) input.checked = current[key];
    for (const { input, size } of sizeInputs) input.checked = current.tileSize === size;
  }

  /** Tile size is a fraction of the viewport fit (settings.ts) — re-fit and
   *  redraw, which also re-places every a11y node over its new rect. */
  function applyTileSize(): void {
    renderer.setSizeFactor(TILE_SIZE_FACTOR[settings.value.tileSize]);
    redraw();
  }

  /**
   * Put the HUD on whichever edge leaves the board the larger fit (issue #37).
   *
   * The HUD's own footprint is measured, not modelled: each candidate is
   * applied and #board is read back, so a wrapped button row, a longer locale
   * or Dynamic Type all feed into the decision for free. Both reads happen in
   * one synchronous task, so no intermediate placement is ever painted.
   *
   * Tile Size is deliberately not part of this: it multiplies both candidates
   * by the same factor, so it cannot change which one is larger — a player on
   * Small would otherwise get a different HUD than one on XL.
   *
   * Returns true if the placement changed, so the caller knows whether a re-fit
   * is already coming from the resulting resize.
   */
  function applyHudPlacement(): boolean {
    const previous = appRoot.dataset['hud'];
    const candidates: HudCandidate[] = HUD_PLACEMENTS.map((placement) => {
      appRoot.dataset['hud'] = placement;
      // Read after each write: forces the two reflows that make this honest.
      return { placement, availW: boardDiv.clientWidth, availH: boardDiv.clientHeight };
    });
    const best: HudPlacement = chooseHudPlacement(renderer.boardExtent, candidates);
    appRoot.dataset['hud'] = best;
    return best !== previous;
  }

  function openSettings(): void {
    if (settingsVisible || overlayVisible || changelogVisible) return;
    syncSettingsControls();
    settingsVisible = true;
    settingsPanel.classList.add('visible');
    setBackgroundInert(true);
    settingsToggles[0]!.input.focus();
    announcer.say('Settings.');
  }

  function closeSettings(): void {
    if (!settingsVisible) return;
    settingsVisible = false;
    settingsPanel.classList.remove('visible');
    setBackgroundInert(false);
    settingsButton.focus();
  }

  // --- version + changelog (issue #81) ----------------------------------------

  /** Render the bundled CHANGELOG.md into the dialog: release headings become
   *  sub-headings, bullets become list items, prose becomes paragraphs. */
  function fillChangelog(): void {
    changelogBody.textContent = '';
    let list: HTMLUListElement | null = null;
    for (const block of parseChangelog(changelogMd)) {
      if (block.kind === 'item') {
        if (!list) {
          list = document.createElement('ul');
          changelogBody.append(list);
        }
        const li = document.createElement('li');
        li.textContent = block.text;
        list.append(li);
        continue;
      }
      list = null;
      const node = document.createElement(block.kind === 'heading' ? 'h3' : 'p');
      node.textContent = block.text;
      changelogBody.append(node);
    }
  }

  function openChangelog(): void {
    if (changelogVisible) return;
    // Opened from inside Settings: that panel steps aside rather than stacking.
    closeSettings();
    changelogVisible = true;
    changelogPanel.classList.add('visible');
    setBackgroundInert(true);
    changelogClose.focus();
    announcer.say('What’s new.');
  }

  function closeChangelog(): void {
    if (!changelogVisible) return;
    changelogVisible = false;
    changelogPanel.classList.remove('visible');
    setBackgroundInert(false);
    settingsButton.focus();
  }

  function wireSettings(): void {
    for (const { input, key, name } of settingsToggles) {
      input.addEventListener('change', () => {
        settings.set(key, input.checked);
        if (key === 'timedMode') drawClock();
        // The only toggle the board itself reads — repaint so the change is
        // visible while the settings screen is still open (issue #45).
        if (key === 'highlightFree') redraw();
        // Tick the box audibly/physically when its own channel is switched on,
        // so "gentle" is something the player can check on the spot (§7).
        if ((key === 'audio' || key === 'haptics') && input.checked) feedback.cue('select');
        announcer.say(`${name} ${input.checked ? 'on' : 'off'}.`);
      });
    }
    for (const { input, size } of sizeInputs) {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        settings.set('tileSize', size);
        applyTileSize();
        announcer.say(`Tile size ${TILE_SIZE_LABEL[size]}.`);
      });
    }
    el<HTMLButtonElement>('settings-close').addEventListener('click', () => closeSettings());
    settingsButton.addEventListener('click', () => openSettings());
    // Escape is the expected way out of a modal, and the only one for a
    // keyboard player who tabbed past the Done button. Listened for on the
    // document, not the panel: clicking the card's own text blurs focus to
    // <body>, and a panel-scoped handler would never see the key.
    document.addEventListener('keydown', (ev) => {
      if (settingsVisible && ev.key === 'Escape') closeSettings();
      if (changelogVisible && ev.key === 'Escape') closeChangelog();
    });
  }

  /** Board-px centre of a tile's top face — the flip effect's fixed line. */
  function tileCenter(id: TileId): { x: number; y: number } {
    const r = tileRect(game.board.get(id).slot);
    return { x: r.x + TILE_W / 2, y: r.y + TILE_H / 2 };
  }

  /** Page-coordinate box of a tile's picture on the board (side depth
   *  included, matching the strip's slot pictures) — where a tray flight
   *  starts. `board.get()` still resolves a removed or held tile, so this
   *  works after the model has already moved it (issue #93). */
  function tileFlightBox(id: TileId): Box {
    const r = tileCssRect(game.board.get(id).slot);
    const canvas = app.canvas.getBoundingClientRect();
    return { x: canvas.x + r.x, y: canvas.y + r.y, ...tileCssSize() };
  }

  /** The renderer's picture of a tile, as the strip draws it (issue #66). */
  function tilePicture(id: TileId): string {
    return renderer.tileImage(game.board.get(id).face);
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
          `${label(outcome.a)} pair matched in the holder. ${game.tilesLeft} tiles left. Score ${game.score}.`,
        );
        break;
      case 'blocked':
        announcer.say(`${label(outcome.id)} is blocked by another tile.`);
        break;
      case 'held':
        // Never reached on the park that fills the last slot — that one is a
        // loss, and showStatus announces it instead (see finishTap). One slot
        // left is the moment to warn, because the next park is the fatal one.
        announcer.say(
          `${label(outcome.id)} sent to holder slot ${outcome.slot + 1}. ${
            game.holderVacancies === 1
              ? 'One holder slot left. A tile with no match in the holder ends the level.'
              : `${game.tilesLeft} tiles left.`
          }`,
        );
        break;
      case 'holder-full':
        announcer.say(
          'The holder is full. Tap a board tile that matches a held tile to free a slot.',
        );
        break;
      case 'peeked':
        // The reveal is the entire outcome (issue #64): a sighted player sees
        // the face flip up, so the face name is exactly what is spoken.
        announcer.say(`${label(outcome.id)} revealed.`);
        break;
      default:
        break;
    }
  }

  /** Where a hinted tile is, in the same words the a11y layer uses. */
  function describePair(pair: HintPair): string {
    const at = (id: TileId): string => {
      // A held tile is not on the board any more: naming the slot it came from
      // would send a screen-reader player to an empty space (issue #43).
      if (game.board.isHeld(id)) return 'in the holder';
      const { row, col } = slotPosition(game.board.get(id).slot);
      return `row ${row} column ${col}`;
    };
    return `two ${label(pair[0])} tiles, ${at(pair[0])} and ${at(pair[1])}`;
  }

  /** What an undone move gives back — a pair or a parked tile (issue #43 makes
   *  both undoable; decision 0009 leaves no third kind). */
  function describeUndo(move: MoveRecord): string {
    switch (move.kind) {
      case 'match':
        return `${label(move.a)} pair restored. ${game.tilesLeft} tiles left. Score ${game.score}.`;
      case 'hold':
        return `${label(move.tile)} taken back out of the holder.`;
    }
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
        const move = game.undo();
        if (move === null) return { ok: false, message: 'Nothing to undo yet.' };
        hintPair = [];
        return { ok: true, message: `Undo: ${describeUndo(move)}` };
      }
      case 'shuffle': {
        // Deterministic per (level seed, shuffle index) so a replay of the same
        // deal reproduces the same shuffled boards.
        const shuffleSeed = (game.level.seed + 0x9e3779b1 * (shuffleCount + 1)) >>> 0;
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
    if (dealing) return;
    // Only the rail can reach this branch: the dialog hides a booster it has no
    // charge for, and the rail is inert while the dialog is open.
    if (!charges.has(kind)) {
      announcer.say(`No ${BOOSTER_PLURAL[kind]} left.`);
      return;
    }
    const fromDialog = overlayVisible;
    const result = runBooster(kind);
    if (result.ok) charges.spend(kind);
    // Undo puts a matched tile back and Shuffle repaints every face: a copy
    // still flying from the old board would paint over the new one (issue #44).
    if (result.ok && (kind === 'undo' || kind === 'shuffle')) {
      animator.clear();
      trayFx.clear();
    }
    redraw();
    if (result.ok) persist();
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

  /**
   * The cue a tap earns, or null for the ones the board answers silently.
   *
   * A match is not in here: issue #44 splits its two channels across two
   * moments (sound at the tap, haptic at the collision), so applyTap drives
   * those itself and never asks for a single cue.
   */
  function tapCue(outcome: TapOutcome): Cue | null {
    switch (outcome.kind) {
      case 'blocked':
      case 'holder-full':
        return 'mismatch';
      case 'held':
      case 'peeked':
        return 'select';
      default:
        return null;
    }
  }

  /** Concealed tiles currently showing their face on the board (issue #64) —
   *  the peek. Captured before a tap and diffed after it, so every reveal and
   *  re-conceal gets its flip, whichever rule caused it (peek, second peek,
   *  a board change dropping the peek). */
  function shownConcealed(): ReadonlySet<TileId> {
    const shown = new Set<TileId>();
    for (const t of game.board.presentTiles()) {
      if (game.isConcealed(t.id) && !game.isFaceHidden(t.id)) shown.add(t.id);
    }
    return shown;
  }

  /** Start the reveal / re-conceal flips a tap earned; returns the flipped ids
   *  so the mismatch shake can leave those tiles alone (both effects drive the
   *  same node transform). A tile that left the board — matched, or parked into
   *  the holder — departs instead of re-concealing, so it does not flip. */
  function playFlips(shownBefore: ReadonlySet<TileId>): ReadonlySet<TileId> {
    const after = shownConcealed();
    const flipped = new Set<TileId>();
    for (const id of after) {
      if (shownBefore.has(id)) continue;
      animator.flip(id, tileCenter(id));
      flipped.add(id);
    }
    for (const id of shownBefore) {
      if (after.has(id) || game.board.get(id).removed || game.board.isHeld(id)) continue;
      animator.flip(id, tileCenter(id));
      flipped.add(id);
    }
    return flipped;
  }

  function applyTap(hit: Hit): void {
    if (dealing) return;
    // Elapsed *play* time, not performance.now(): a resumed page restarts
    // performance.now() at 0 while the restored combo ladder still holds the
    // previous session's timestamps, and the ScoreKeeper rejects a clock that
    // goes backwards. Elapsed time is saved with the game, so it is the one
    // clock that stays monotonic across a force-quit (core's own contract:
    // "monotonic within a game — e.g. elapsed game time").
    const before = game.holderSlots();
    const shownBefore = shownConcealed();
    finishTap(game.tap(hit, elapsed.ms), before, shownBefore);
  }

  /** Everything a resolved tap owes the player: feedback, save, announcement.
   *  `heldBefore` is the holder as it was when the tap landed — a match empties
   *  the partner's slot, and the pair-clear effect has to know which one. */
  function finishTap(
    outcome: TapOutcome,
    heldBefore: readonly (TileId | null)[],
    shownBefore: ReadonlySet<TileId>,
  ): void {
    // Reveal / re-conceal flips (issue #64).
    playFlips(shownBefore);
    // A match or a park changes the board, so the highlighted hint is stale.
    // Any other tap keeps it: peeking near one hinted tile must not hide it.
    if (outcome.kind === 'matched' || outcome.kind === 'held') hintPair = [];
    if (outcome.kind === 'blocked') {
      flashTiles([outcome.id]);
      animator.shake([outcome.id]);
    }
    // The tray effects (issue #93): captured before the redraw empties the
    // slot / drops the board tile — board.get() still resolves either, and
    // the pictures come from the renderer's own bake (issue #66).
    if (outcome.kind === 'matched') {
      // Sound answers the tap; the haptic waits for the pair clear (the same
      // split issue #44 used for the collision).
      feedback.sound('match');
      const slotIndex = heldBefore.indexOf(outcome.a);
      const slotNode = slotIndex === -1 ? undefined : holder.slotNode(slotIndex);
      if (slotNode) {
        trayFx.pairClear(
          { incoming: tilePicture(outcome.b), parked: tilePicture(outcome.a) },
          tileFlightBox(outcome.b),
          slotNode,
          outcome.score.points,
          () => feedback.haptic('match'),
        );
      } else {
        // No slot to anchor on (never in play; belt-and-braces): the redraw is
        // the feedback, so fire the haptic now rather than never.
        feedback.haptic('match');
      }
    } else if (outcome.kind === 'held') {
      const slotNode = holder.slotNode(outcome.slot);
      if (slotNode) {
        trayFx.flyToSlot(tilePicture(outcome.id), tileFlightBox(outcome.id), slotNode, () => {});
      }
      feedback.cue(tapCue(outcome)!);
    } else {
      const cue = tapCue(outcome);
      if (cue) feedback.cue(cue);
    }
    redraw();
    // Spec §7: auto-save on every move. A tap that changed nothing (a miss, a
    // buried tile) has nothing to save.
    // A refused park (issue #43 rule 5) changed nothing either, and a peek is
    // deliberately not saved (issue #64): a reload re-conceals.
    if (!['none', 'blocked', 'holder-full', 'peeked'].includes(outcome.kind)) persist();
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

  /**
   * Deal the current ladder level (issue #79, amended by issue #94). The three
   * buttons now do three different things:
   *
   *   * `replay` (Restart): the deal being played, seed and all — a re-rolled
   *     deal restarts as itself, not as the ladder's;
   *   * `reroll` (New game): a fresh seed for the same level, so the button
   *     visibly re-deals instead of silently doing nothing (issue #94 — the
   *     ladder's fixed seed made New game and Restart the same deal);
   *   * `ladder` (Next level / Play again after a win): the ladder's own seed
   *     for the level the win advanced to — level variety still comes from
   *     the ladder, re-rolling is for the level you are on.
   *
   * When the level's layout differs from the loaded one (a win advanced the
   * ladder), it is fetched and the renderer re-pointed first.
   */
  async function startLevel(mode: 'replay' | 'reroll' | 'ladder'): Promise<void> {
    if (dealing) return;
    const next = ladder[progress.level - 1]!;
    if (next.layoutId !== layout.id) {
      // The fetch yields the event loop: block input until the new deal is in,
      // or a tap lands on the outgoing board and mutates a game about to be
      // discarded (its save clobbered by the new deal's).
      dealing = true;
      try {
        layout = await fetchLayout(next.layoutId);
      } catch {
        // Offline mid-session: keep the loaded board rather than a blank one.
        announcer.say('Could not load the next level. Check your connection and try again.');
        return;
      } finally {
        dealing = false;
      }
      renderer.setLayout(layout.slots);
      if (applyHudPlacement()) app.resize();
    }
    entry = next;
    game = dealCurrentLevel(
      mode === 'replay'
        ? game.level.seed
        : mode === 'reroll'
          ? rerollSeed(game.level.seed)
          : entry.seed,
    );
    flash = [];
    flashToken++;
    animator.clear();
    trayFx.clear();
    hintPair = [];
    shuffleCount = 0;
    elapsed.reset();
    const fromDialog = hideOverlay();
    redraw();
    // Save the new deal at once: a force-quit before the first move should
    // resume this board, not the one it replaced.
    persist();
    // Hiding the dialog drops focus to <body>; put it back on the board. Only
    // when the dialog was the source — a header tap should keep its own focus.
    if (fromDialog) a11y.focusActive();
    announcer.say(
      mode === 'replay'
        ? `Level ${progress.level} restarted. ${game.tilesLeft} tiles.`
        : `New game dealt. Level ${progress.level}. ${game.tilesLeft} tiles.`,
    );
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

  // Re-decide the HUD edge on every viewport change — an orientation flip is a
  // resize, so there is nothing orientation-specific to listen for (issue #37).
  //
  // Only re-size Pixi when the edge actually moved. Pixi's own resize plugin
  // listens on this same event and re-reads #board on the next frame, which
  // already covers the case where the placement stayed put; when it moved,
  // app.resize() re-reads #board now and cancels that queued frame, so the
  // board is re-fit exactly once either way.
  window.addEventListener('resize', () => {
    if (applyHudPlacement()) app.resize();
  });

  boosterUi.hint.button.addEventListener('click', () => useBooster('hint'));
  boosterUi.undo.button.addEventListener('click', () => useBooster('undo'));
  boosterUi.shuffle.button.addEventListener('click', () => useBooster('shuffle'));
  overlayShuffle.addEventListener('click', () => useBooster('shuffle'));
  overlayUndo.addEventListener('click', () => useBooster('undo'));
  el<HTMLButtonElement>('btn-new').addEventListener('click', () => void startLevel('reroll'));
  el<HTMLButtonElement>('btn-restart').addEventListener('click', () => void startLevel('replay'));
  // The dialog's primary is "Next level" after a win (the ladder's own deal)
  // and "New game" everywhere else (a re-roll, issue #94).
  overlayNew.addEventListener('click', () =>
    void startLevel(game.status() === 'won' ? 'ladder' : 'reroll'),
  );
  overlayRestart.addEventListener('click', () => void startLevel('replay'));

  wireSettings();
  el<HTMLElement>('version').textContent = versionLabel(
    __APP_VERSION__,
    __BUILD_COMMIT__,
    __BUILD_TIME__,
  );
  fillChangelog();
  el<HTMLButtonElement>('btn-version').addEventListener('click', () => openChangelog());
  changelogClose.addEventListener('click', () => closeChangelog());
  syncSettingsControls();

  // A hidden page is the last moment the browser reliably gives us before the
  // OS kills the tab, so it is where the force-quit save has to happen — and
  // where the clock stops, so backgrounding does not inflate the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      elapsed.pause();
      // requestAnimationFrame stops on a hidden page, so a flight or a shake
      // would freeze here and finish whenever the player comes back — stale
      // copies painted over a board that has moved on. The board underneath is
      // already correct without them, so drop them (issue #44 / #93).
      animator.clear();
      trayFx.clear();
      persist();
    } else {
      elapsed.resume();
      drawClock();
    }
  });
  window.addEventListener('pagehide', () => persist());

  window.setInterval(() => {
    if (settings.value.timedMode && !document.hidden) drawClock();
  }, CLOCK_TICK_MS);

  // Pixi sized itself to #board during init, before any placement existed, so
  // the canvas has to be re-read once there is one — this is also the call that
  // reveals #app (see the `:not([data-hud])` rule in index.html).
  if (applyHudPlacement()) app.resize();
  applyTileSize(); // fits the board for the stored tile size, then redraws
  if (resumed !== null) {
    announcer.say(`Game resumed. ${game.tilesLeft} tiles left. Score ${game.score}.`);
    // A deadlocked board can be resumed (see persist): re-offer the way out.
    showStatus();
  } else {
    persist(); // a fresh deal is savable from its first frame
  }

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
    /** Ladder position + loaded layout (issue #79 QA). */
    get ladderLevel() {
      return progress.level;
    },
    get dealing() {
      return dealing;
    },
    get layoutId() {
      return layout.id;
    },
    /** Holder state (issues #43 / #62 / #63 QA). */
    holder(): {
      slots: readonly (TileId | null)[];
      full: boolean;
      vacancies: number;
      holdsUsed: number;
    } {
      return {
        slots: game.holderSlots(),
        full: game.holderFull,
        vacancies: game.holderVacancies,
        holdsUsed: game.holdsUsed,
      };
    },
    /** Legacy selection (issue #93 retired the gesture; a pre-#93 save can
     *  still restore one, and the QA harness asserts it stays null in play). */
    get selection() {
      return game.selection;
    },
    /** Settings + save-slot state (issue #14 QA assertions). */
    settings() {
      return settings.value;
    },
    /** The save as it would be reopened — null once the level has ended. */
    savedState() {
      return saves.load();
    },
    elapsedMs() {
      return elapsed.ms;
    },
    stateHash() {
      return game.stateHash();
    },
    /** Chosen HUD edge and the board extent it was chosen against (#37 QA). */
    hudPlacement(): HudPlacement {
      return appRoot.dataset['hud'] as HudPlacement;
    },
    boardExtent(): { w: number; h: number } {
      return { w: renderer.boardExtent.w, h: renderer.boardExtent.h };
    },
    /** Whether any board or tray effect is live (issue #44 / #93 QA). */
    animating(): boolean {
      return animator.busy || trayFx.busy;
    },
    /** The effective reduced-motion decision, OS preference included. */
    reducedMotion(): boolean {
      return settings.value.reducedMotion || prefersReducedMotion();
    },
  };
}

start().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = `Failed to start: ${String(err)}`;
});
