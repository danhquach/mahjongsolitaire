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
// and a Hold control in the rail that acts on the selection — park a free tile,
// or take a parked one back. It is always available, so it has no charge badge;
// a full holder disables the control instead of ending the level.
// Issue #44 gives the match its feedback: the pair flies together and collides
// (effects.ts / anim.ts) while the board redraws without it, the sound answers
// the tap and the haptic waits for the impact, and reduced motion — OS
// preference or in-app toggle — substitutes a cross-fade.

import { Application } from 'pixi.js';
import { HOLDER_SLOTS, generateValidatedLevel, parseLayout } from '@mahjongsolitaire/core';
import type { MoveRecord, Slot, TileId } from '@mahjongsolitaire/core';
import { A11yLayer, Announcer, slotPosition } from './a11y.js';
import type { A11yTile } from './a11y.js';
import { BoosterCharges } from './boosters.js';
import type { BoosterKind } from './boosters.js';
import { Elapsed, formatElapsed } from './elapsed.js';
import { Animator } from './effects.js';
import type { FlyingTile } from './effects.js';
import { Feedback, navigatorVibrate, webAudioPlayer } from './feedback.js';
import type { Cue } from './feedback.js';
import { faceStyle } from './faces.js';
import { Game } from './game.js';
import { HolderStrip } from './holder.js';
import { TILE_H, TILE_W, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';
import { hitTest } from './hit-test.js';
import { HUD_PLACEMENTS, chooseHudPlacement } from './hud-fit.js';
import type { HudCandidate, HudPlacement } from './hud-fit.js';
import { BoardRenderer } from './render.js';
import { SaveStore, captureSave, reopen } from './save.js';
import { SettingsStore, TILE_SIZE_FACTOR, TILE_SIZE_LABEL, TILE_SIZES } from './settings.js';
import type { TileSize } from './settings.js';
import { localKeyValueStorage } from './storage.js';
import type { Hit } from './hit-test.js';
import type { HintPair, HolderAction, TapOutcome } from './game.js';

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

function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
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
  const overlayShuffle = el<HTMLButtonElement>('overlay-shuffle');
  const overlayUndo = el<HTMLButtonElement>('overlay-undo');
  const a11yRoot = el<HTMLDivElement>('a11y-layer');
  const header = el<HTMLElement>('app-header');
  const boosterRail = el<HTMLDivElement>('booster-rail');
  const holderRoot = el<HTMLDivElement>('holder');
  const holdButton = el<HTMLButtonElement>('btn-hold');
  const settingsPanel = el<HTMLDivElement>('settings');
  const settingsButton = el<HTMLButtonElement>('btn-settings');
  const timeStat = el<HTMLElement>('time-stat');
  const elapsedEl = el<HTMLElement>('elapsed');

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

  // One storage handle for every persisted concern (charges, settings, save).
  const storage = localKeyValueStorage();
  const settings = new SettingsStore(storage);
  const saves = new SaveStore(storage);
  const feedback = new Feedback(() => settings.value, webAudioPlayer(), navigatorVibrate());

  // Match / mismatch animation (issue #44). Reduced motion is the OS preference
  // OR the in-app toggle, read per effect so either can be changed mid-session;
  // the animator itself never touches game state or the input path.
  const animator = new Animator(renderer.effects, app.ticker, {
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

  // Spec §7: resume mid-level after a force-quit. A save that cannot be
  // trusted (older build, changed layout, hand-edited record) reads as absent
  // and the player gets a fresh deal instead of an error.
  const saved = saves.load();
  const resumed = saved === null ? null : reopen(layout, saved);
  let game = resumed ?? new Game(generateValidatedLevel(layout, randomSeed()));
  let flash: readonly number[] = [];
  let flashToken = 0;
  let overlayVisible = false;
  let settingsVisible = false;
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
  const holder = new HolderStrip(holderRoot, HOLDER_SLOTS, (id) => activateHeld(id));

  /** Accessible name and label of the Hold control, per what it would do now. */
  const HOLD_LABEL: Record<HolderAction, { title: string; label: string }> = {
    hold: { title: 'Hold', label: 'Hold, park the selected tile' },
    return: { title: 'Return', label: 'Return the held tile to the board' },
    full: { title: 'Hold', label: 'Hold, the holder is full' },
    none: { title: 'Hold', label: 'Hold, select a tile first' },
  };

  function label(id: TileId): string {
    return faceStyle(game.board.get(id).face).label;
  }

  function redraw(): void {
    renderer.draw(game, {
      selection: game.selection,
      flash,
      hint: hintPair,
      dimBlocked: settings.value.highlightFree,
    });
    scoreEl.textContent = String(game.score);
    tilesLeftEl.textContent = String(game.tilesLeft);
    syncBoosterButtons();
    syncHoldButton();
    holder.sync({
      slots: game.holderSlots(),
      faceOf: (id) => game.board.get(id).face,
      selection: game.selection,
      hint: hintPair,
      flash,
    });
    drawClock();
    a11y.sync(a11yTiles(), game.selection, (t) => tileCssRect(t.slot));
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
   * the board, the score, or the selection.
   *
   * A *won* level has nothing to resume into, so its save is dropped —
   * otherwise the next boot would reopen a cleared board. A *stuck* one is
   * still saved: spec §4 never hard-fails a deadlock, and the way out is Undo
   * or Shuffle on that exact board. Force-quitting at the deadlock dialog must
   * not throw the undo stack away.
   */
  function persist(): void {
    if (game.status() === 'won') saves.clear();
    else saves.write(captureSave(game, { shuffles: shuffleCount, elapsedMs: elapsed.ms }));
  }

  /**
   * The Hold control (issue #43). Always available, so there is no balance to
   * show — what changes is what it *does*: `.spent` and an aria-disabled state
   * are the "full holder" cue (rule 5 disables Hold; it never ends the level),
   * and the label flips to Return when the selected tile is already parked.
   *
   * Like the boosters, the button stays clickable at its dead end so a press
   * can explain itself — a `disabled` control cannot, and some assistive
   * technology skips one entirely.
   */
  function syncHoldButton(): void {
    const action = game.holderAction();
    const { title, label } = HOLD_LABEL[action];
    holdButton.classList.toggle('spent', action === 'full');
    holdButton.setAttribute('aria-disabled', String(action === 'full'));
    holdButton.setAttribute('aria-label', label);
    holdButton.title = title;
    holdButton.dataset['action'] = title;
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
    (canShuffle ? overlayShuffle : canUndo ? overlayUndo : overlayRestart).focus();
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
    if (settingsVisible || overlayVisible) return;
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
    });
  }

  /** Board-px centre of a tile's top face — where a flying copy starts. */
  function tileCenter(id: TileId): { x: number; y: number } {
    const r = tileRect(game.board.get(id).slot);
    return { x: r.x + TILE_W / 2, y: r.y + TILE_H / 2 };
  }

  /**
   * Fly a matched pair together (issue #44).
   *
   * Copies are built from the board's own renderer *after* the match has been
   * applied — `board.get()` still resolves a removed tile — so the board can
   * redraw without the pair while the copies carry the motion. Nothing here is
   * awaited: the next tap is accepted mid-flight, and the tiles it would fly
   * are already out of the model, so they cannot be matched twice.
   */
  function playMatchAnimation(a: TileId, b: TileId, heldBefore: ReadonlySet<TileId>): void {
    // A tile matched out of the holder has no board position to fly from — the
    // strip is HUD, not board space — so a holder match is not flown at all.
    // The slot emptying is its own feedback; the impact haptic still fires here
    // rather than waiting for a collision that never happens (issue #43).
    if (heldBefore.has(a) || heldBefore.has(b)) {
      feedback.haptic('match');
      return;
    }
    const flying: FlyingTile[] = [];
    for (const id of [a, b]) {
      const display = renderer.detachedTile(game, id);
      if (display) flying.push({ display, center: tileCenter(id) });
    }
    // Nothing sensible to fly; the board itself is already correct.
    if (flying.length !== 2) return;
    animator.playMatch(flying[0]!, flying[1]!, () => feedback.haptic('match'));
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
      // A held tile is not on the board any more: naming the slot it came from
      // would send a screen-reader player to an empty space (issue #43).
      if (game.board.isHeld(id)) return 'in the holder';
      const { row, col } = slotPosition(game.board.get(id).slot);
      return `row ${row} column ${col}`;
    };
    return `two ${label(pair[0])} tiles, ${at(pair[0])} and ${at(pair[1])}`;
  }

  /** What an undone move gives back — a pair, a parked tile, or a returned one
   *  (issue #43 makes all three undoable). */
  function describeUndo(move: MoveRecord): string {
    switch (move.kind) {
      case 'match':
        return `${label(move.a)} pair restored. ${game.tilesLeft} tiles left. Score ${game.score}.`;
      case 'hold':
        return `${label(move.tile)} taken back out of the holder.`;
      case 'unhold':
        return `${label(move.tile)} put back in the holder.`;
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
    if (result.ok && (kind === 'undo' || kind === 'shuffle')) animator.clear();
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
      case 'mismatch':
      case 'blocked':
        return 'mismatch';
      case 'selected':
      case 'deselected':
        return 'select';
      default:
        return null;
    }
  }

  /** Ids sitting in the holder right now — captured before a tap, because after
   *  a match the tiles are removed and no longer say where they came from. */
  function heldIds(): ReadonlySet<TileId> {
    return new Set(game.holderSlots().filter((id): id is TileId => id !== null));
  }

  function applyTap(hit: Hit): void {
    // Elapsed *play* time, not performance.now(): a resumed page restarts
    // performance.now() at 0 while the restored combo ladder still holds the
    // previous session's timestamps, and the ScoreKeeper rejects a clock that
    // goes backwards. Elapsed time is saved with the game, so it is the one
    // clock that stays monotonic across a force-quit (core's own contract:
    // "monotonic within a game — e.g. elapsed game time").
    const before = heldIds();
    finishTap(game.tap(hit, elapsed.ms), before);
  }

  /** Tap on a tile in the holder (issue #43): same select / match semantics as
   *  a free board tile, reached through the strip's own button. */
  function activateHeld(id: TileId): void {
    if (game.status() !== 'playing') return;
    const before = heldIds();
    finishTap(game.tapHeld(id, elapsed.ms), before);
  }

  /** Everything a resolved tap owes the player: feedback, save, announcement. */
  function finishTap(outcome: TapOutcome, heldBefore: ReadonlySet<TileId>): void {
    // A match changes the board, so the highlighted hint is stale. Any other
    // tap keeps it: selecting one hinted tile must not hide its partner.
    if (outcome.kind === 'matched') hintPair = [];
    if (outcome.kind === 'mismatch') {
      flashTiles([outcome.a, outcome.b]);
      animator.shake([outcome.a, outcome.b]);
    } else if (outcome.kind === 'blocked') {
      flashTiles([outcome.id]);
      animator.shake([outcome.id]);
    }
    if (outcome.kind === 'matched') {
      // Sound answers the tap; the haptic waits for the collision (issue #44).
      feedback.sound('match');
      // The copies have to be captured before the redraw that drops the pair —
      // they live in the effects layer, which the redraw does not touch.
      playMatchAnimation(outcome.a, outcome.b, heldBefore);
    } else {
      const cue = tapCue(outcome);
      if (cue) feedback.cue(cue);
    }
    redraw();
    // Spec §7: auto-save on every move. The selection counts as state too — a
    // force-quit between the two taps of a pair resumes with it intact. A tap
    // that changed nothing (a miss with no selection, a buried tile) has
    // nothing to save.
    if (outcome.kind !== 'none' && outcome.kind !== 'blocked') persist();
    // A level-ending move is announced once, by showStatus: two live-region
    // writes in the same tick coalesce and the first is never spoken.
    if (game.status() === 'playing') announce(outcome);
    showStatus();
  }

  /**
   * One press of the Hold control (issue #43). Nothing is charged — the holder
   * is always available — so the only outcomes are "it moved" and a spoken
   * reason why it did not.
   */
  function useHold(): void {
    if (game.status() !== 'playing') return;
    const outcome = game.useHolder(elapsed.ms);
    switch (outcome.kind) {
      case 'held':
        hintPair = [];
        feedback.cue('select');
        redraw();
        persist();
        announcer.say(
          `${label(outcome.id)} held in slot ${outcome.slot + 1}. ${
            game.holderFull ? 'Holder full.' : `${game.tilesLeft} tiles left.`
          }`,
        );
        // Parking a tile changes what is free, which can *lift* a deadlock —
        // that is the only reason this is here. A hold can never end the level:
        // it removes nothing, and a held tile still counts as in play
        // (spec §3.5 as amended by decision 0008).
        showStatus();
        return;
      case 'returned':
        hintPair = [];
        feedback.cue('select');
        redraw();
        persist();
        announcer.say(`${label(outcome.id)} returned to the board.`);
        showStatus();
        return;
      case 'full':
        feedback.cue('mismatch');
        announcer.say('The holder is full. Match a held tile to free a slot.');
        return;
      case 'none':
        announcer.say('Select a free tile first, then press Hold.');
        return;
    }
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
    game = new Game(generateValidatedLevel(layout, nextSeed));
    flash = [];
    flashToken++;
    animator.clear();
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

  holdButton.addEventListener('click', () => useHold());
  boosterUi.hint.button.addEventListener('click', () => useBooster('hint'));
  boosterUi.undo.button.addEventListener('click', () => useBooster('undo'));
  boosterUi.shuffle.button.addEventListener('click', () => useBooster('shuffle'));
  overlayShuffle.addEventListener('click', () => useBooster('shuffle'));
  overlayUndo.addEventListener('click', () => useBooster('undo'));
  el<HTMLButtonElement>('btn-new').addEventListener('click', () => newGame(randomSeed()));
  el<HTMLButtonElement>('btn-restart').addEventListener('click', () => newGame(game.level.seed));
  el<HTMLButtonElement>('overlay-new').addEventListener('click', () => newGame(randomSeed()));
  overlayRestart.addEventListener('click', () => newGame(game.level.seed));

  wireSettings();
  syncSettingsControls();

  // A hidden page is the last moment the browser reliably gives us before the
  // OS kills the tab, so it is where the force-quit save has to happen — and
  // where the clock stops, so backgrounding does not inflate the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      elapsed.pause();
      // requestAnimationFrame stops on a hidden page, so a match in flight
      // would freeze here and finish its last 100ms whenever the player comes
      // back — a stale pair painted over a board that has moved on. The board
      // underneath is already correct without them, so drop them (issue #44).
      animator.clear();
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
    /** Holder state + what the Hold control would do (issue #43 QA). */
    holder(): {
      slots: readonly (TileId | null)[];
      full: boolean;
      holdsUsed: number;
      action: HolderAction;
    } {
      return {
        slots: game.holderSlots(),
        full: game.holderFull,
        holdsUsed: game.holdsUsed,
        action: game.holderAction(),
      };
    },
    useHold() {
      useHold();
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
    /** Whether any match/shake effect is live (issue #44 QA assertions). */
    animating(): boolean {
      return animator.busy;
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
