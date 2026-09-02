// App bootstrap for the vertical slice (issue #11): one Turtle level,
// tap-only input, playable end-to-end in any browser, portrait or landscape.
// Issue #12 adds the accessibility foundation: a DOM/ARIA mirror of the board
// (see a11y.ts), spoken outcomes, and 48dp focus targets.
// Issue #13 wires the three boosters — Hint / Undo / Shuffle — to the core
// primitives via game.ts, with charges persisted by boosters.ts.
// Issue #14 adds auto-save + resume (save.ts) and the settings screen
// (settings.ts): audio and haptics via feedback.ts, tile size through the
// renderer's fit; elapsed.ts keeps a silent clock for the save (the on-screen
// timer was removed by issue #114).
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
// Issue #69 gives the game a player: a local profile (display name + avatar,
// profile.ts) editable from Settings, and a profile screen showing the
// player's own record — current level, levels cleared, best score, and the
// streak/trophy counters that start moving when the Daily Challenge lands.
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
  dailyDateKey,
  dailyLayoutId,
  dailySeed,
  nextPoolLayout,
  concealedTileIds,
  generateValidatedLevel,
  parseLadder,
  parseLayout,
} from '@mahjongsolitaire/core';
import type {
  DifficultyBucket,
  HoldMove,
  LadderBand,
  LadderEntry,
  Layout,
  Slot,
  TileId,
} from '@mahjongsolitaire/core';
import { A11yLayer, Announcer, slotPosition } from './a11y.js';
import type { A11yTile } from './a11y.js';
import {
  BOOSTER_KINDS,
  BoosterCharges,
  MILESTONE_LEVEL_GRANT,
  THIRD_CLEAR_GRANT,
  thirdClearDue,
} from './boosters.js';
import type { BoosterKind, Counts } from './boosters.js';
import { Elapsed } from './elapsed.js';
import { Animator } from './effects.js';
import { TrayFx } from './tray-fx.js';
import type { Box } from './tray-fx.js';
import { WinFx } from './win-fx.js';
import { scheduleDialogDelay, scoreCountUp } from './anim.js';
import { Feedback, navigatorVibrate, webAudioPlayer } from './feedback.js';
import type { Cue } from './feedback.js';
import { faceStyle } from './faces.js';
import { Game } from './game.js';
import { HolderStrip } from './holder.js';
import { BOARD_FELT, PALETTES, cssColor } from './depth.js';
import type { BoardPalette } from './depth.js';
import { SIDE_DEPTH, TILE_H, TILE_W, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';
import { hitTest } from './hit-test.js';
import { HUD_PLACEMENTS, chooseHudPlacement } from './hud-fit.js';
import type { HudCandidate, HudPlacement } from './hud-fit.js';
import { BoardRenderer } from './render.js';
import { parseChangelog, versionLabel } from './changelog.js';
import changelogMd from '../../CHANGELOG.md?raw';
import { ProgressStore } from './progress.js';
import {
  AVATARS,
  ProfileStore,
  RecordStore,
  avatarGlyph,
  clearedLevelCount,
  hasCleared,
  liveStreak,
} from './profile.js';
import { SaveStore, captureSave, reopen } from './save.js';
import { SettingsStore, TILE_SIZE_FACTOR, TILE_SIZE_LABEL, TILE_SIZES } from './settings.js';
import type { TileSize } from './settings.js';
import { localKeyValueStorage } from './storage.js';
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

/** The band a Daily Challenge board plays at (issue #19, decision 0016): its
 *  concealment bucket. The Daily draws from all ten layouts, hard-pool ones
 *  included, so it sits one band up from the ladder's middle rather than at
 *  easy. */
const DAILY_BAND: LadderBand = 'medium-plus';

/** A date key as the HUD chip shows it ("Sep 1") and as it is read out
 *  ("September 1, 2026"). Formatted in UTC from the key's own digits so the
 *  device zone cannot shift the date it names. */
function formatDateKey(key: string, style: 'short' | 'long'): string {
  const at = new Date(`${key}T00:00:00Z`);
  return new Intl.DateTimeFormat(
    undefined,
    style === 'short'
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' },
  ).format(at);
}

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
  const welcomePanel = el<HTMLDivElement>('welcome');
  const profilePanel = el<HTMLDivElement>('profile');
  const profileButton = el<HTMLButtonElement>('btn-profile');
  const profileClose = el<HTMLButtonElement>('profile-close');
  const profileNameInput = el<HTMLInputElement>('profile-name');
  const avatarGrid = el<HTMLDivElement>('avatar-grid');
  const profileRowGlyph = el<HTMLElement>('profile-row-glyph');
  const profileRowName = el<HTMLElement>('profile-row-name');
  const overlayGrant = el<HTMLElement>('overlay-grant');
  const dailyButton = el<HTMLButtonElement>('btn-daily');
  const dailyDateEl = el<HTMLElement>('daily-date');
  const dailyStatusEl = el<HTMLElement>('daily-status');

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
  /** The Daily Challenge on the table, as its date key — null on the ladder
   *  (issue #19). A saved Daily resumes as one, whatever today's date is: a
   *  board dealt before midnight is still that date's board. */
  let daily: string | null = saved?.daily ?? null;
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
    return new Game(level, undefined, concealedTileIds(level, concealBucketForBand(bandInPlay())));
  }

  /** The band the deal on the table plays at: the ladder level's, or the
   *  Daily's fixed band (issue #19). Drives concealment. */
  function bandInPlay(): LadderBand {
    return daily === null ? bandForLevel(progress.level).band : DAILY_BAND;
  }

  /** The palette the deal on the table wears (issue #67): the Daily's, the
   *  decade milestone's (decision 0011's spike levels), else the default. */
  function paletteInPlay(): BoardPalette {
    if (daily !== null) return PALETTES.daily;
    return bandForLevel(progress.level).spike ? PALETTES.milestone : PALETTES.lantern;
  }

  /** Hand the renderer the palette in force and paint the play column's felt
   *  to match (the canvas is only part of it — see #play-area in index.html).
   *  Colour never carries the meaning alone (spec §7): the Level chip's label
   *  names the level kind too (syncHudIdentity). */
  function applyPalette(): void {
    const palette = paletteInPlay();
    renderer.setPalette(palette);
    appRoot.style.setProperty('--felt', cssColor(palette.felt));
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
      : reopen(
          layout,
          saved,
          saved.daily !== null
            ? concealBucketForBand(DAILY_BAND)
            : concealBucketFor(savedEntry?.level ?? progress.level),
        );
  // A failed resume can leave the save's layout loaded; the fresh deal is the
  // current ladder level's, so re-point at its layout first — and it is a
  // ladder deal, whatever the rejected save claimed to be.
  if (resumed === null) daily = null;
  if (resumed === null && layout.id !== entry.layoutId) layout = await fetchLayout(entry.layoutId);
  let game = resumed ?? dealCurrentLevel(entry.seed);

  const renderer = new BoardRenderer(app, layout.slots);
  const announcer = new Announcer(el<HTMLElement>('a11y-status'));
  // The booted deal's palette (issue #67) — a resumed Daily or a milestone
  // level boots into its own colours, not the default's.
  applyPalette();

  const settings = new SettingsStore(storage);
  const feedback = new Feedback(() => settings.value, webAudioPlayer(), navigatorVibrate());

  // The player (issue #69): identity and record, both local-first — the game
  // never needs a network or an account for either.
  const profile = new ProfileStore(storage);
  const record = new RecordStore(storage);

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
  /** A win dialog waiting out WIN_DIALOG_DELAY_MS while the celebration plays
   *  (issue #120) — cancelled if a new level starts first. */
  let pendingWinTimer: ReturnType<typeof setTimeout> | null = null;
  /** The score dialog's count-up (issue #120), driven independently of the
   *  win timer above so it can be cancelled on its own once the dialog is
   *  already showing. */
  let scoreCountRaf: number | null = null;
  /** Whatever `showStatus` appends after "Final score: N" on a win (the Daily
   *  payout line) — captured so the count-up can rebuild the same text at
   *  every value without re-deriving it. */
  let winScoreSuffix = '';
  /** A cross-layout level transition is in flight (issue #79): input on the
   *  outgoing board is dropped until the new deal is in. */
  let dealing = false;
  let settingsVisible = false;
  let changelogVisible = false;
  let profileVisible = false;
  let welcomeVisible = false;
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
  // The win celebration's DOM half (issue #120): lanterns + confetti, on
  // their own layer so clearing the tray mid-flight never touches them.
  const winFx = new WinFx(el<HTMLDivElement>('win-fx-layer'), () =>
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
    // The Level chip shows the date on a Daily board (issue #19).
    levelEl.textContent = daily === null ? String(progress.level) : formatDateKey(daily, 'short');
    syncHudIdentity();
    drawScore();
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
    // The last argument is the issue #63 warning: with one slot left, parking
    // an unmatched tile ends the level, so a free tile's accessible name has
    // to say so.
    a11y.sync(a11yTiles(), (t) => tileCssRect(t.slot), game.holderVacancies === 1);
  }

  /** The score the chip currently shows; -1 until the first paint so a resumed
   *  score does not pop on boot. */
  let shownScore = -1;

  /** The score chip: the number, plus a pop on every gain (HUD rework). A new
   *  deal drops the score back to 0, which updates without the fanfare; the
   *  pop's reduced-motion opt-outs are pure CSS (see index.html). */
  function drawScore(): void {
    scoreEl.textContent = String(game.score);
    if (game.score > shownScore && shownScore >= 0) {
      scoreEl.classList.remove('bump');
      // Restart the animation even when a pop is still playing: without the
      // reflow the class swap in one task is a no-op to the animator.
      void scoreEl.offsetWidth;
      scoreEl.classList.add('bump');
    }
    shownScore = game.score;
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
    else
      saves.write(
        captureSave(game, {
          shuffles: shuffleCount,
          // hints/undos (issue #19) existed only for the star rating, removed
          // by #119. The save format keeps the fields rather than bump the
          // version for a migration; nothing reads them any more.
          hints: 0,
          undos: 0,
          elapsedMs: elapsed.ms,
          daily,
        }),
      );
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
    // On a Daily board the secondary action leaves for the ladder (issue #19).
    overlayRestart.hidden = false;
    overlayNew.textContent = daily === null ? 'New game' : 'Back to the ladder';
    overlayGrant.hidden = true;
    if (status === 'won') {
      overlayRestart.hidden = true;
      if (daily === null) {
        // Advance the ladder exactly once per win: this branch is inside the
        // once-per-level transition (the overlayVisible guard above). The
        // player's record counts the same moment (issue #69).
        const cleared = progress.level;
        const atEnd = progress.advance() === cleared;
        // Booster grants (issue #51, #117) key off the record *before* this
        // win is written: only a first clear can pay, a replay never does.
        const firstClear = !hasCleared(record.value, cleared);
        record.recordWin(game.score, { level: cleared });
        overlayTitle.textContent = `Level ${cleared} complete!`;
        overlayText.textContent = `Final score: ${game.score}`;
        winScoreSuffix = '';
        overlayNew.textContent = atEnd ? 'Play again' : 'Next level';
        const grantLines: string[] = [];
        if (firstClear) {
          // Every third distinct level first-cleared pays one at random; the
          // dialog says which (issue #117: no pick, no per-level grant).
          const distinct = clearedLevelCount(record.value);
          if (thirdClearDue(distinct)) {
            const got = charges.grantSplit(THIRD_CLEAR_GRANT, Math.random);
            grantLines.push(`${distinct} levels cleared: ${describeGrant(got)}.`);
          }
          // The decade spike (a milestone level, issue #67) pays one of each.
          if (bandForLevel(cleared).spike) {
            grantLines.push(`Milestone level: ${describeGrant(charges.grantEach(MILESTONE_LEVEL_GRANT))}.`);
          }
          syncBoosterButtons();
        }
        if (grantLines.length > 0) {
          overlayGrant.textContent = grantLines.join(' ');
          overlayGrant.hidden = false;
        }
        announcer.say(
          `Level ${cleared} complete. Final score ${game.score}. ${grantLines.join(' ')}`.trim(),
        );
      } else {
        // A Daily clear banks the score like any win and pays in trophies,
        // once per date — a replay of a cleared board earns nothing twice.
        record.recordWin(game.score);
        const credit = record.recordDailyWin(daily);
        const payout = credit.credited
          ? `${credit.trophies === 1 ? 'Trophy earned' : `${credit.trophies} trophies earned`} — ${
              credit.streak === 1 ? 'a 1-day streak' : `${credit.streak}-day streak`
            }.`
          : 'Already cleared — no extra trophy for a replay.';
        overlayTitle.textContent = 'Daily Challenge complete!';
        winScoreSuffix = `. ${payout}`;
        overlayText.textContent = `Final score: ${game.score}${winScoreSuffix}`;
        overlayNew.textContent = 'Back to the ladder';
        announcer.say(`Daily Challenge complete. Final score ${game.score}. ${payout}`);
      }
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
        canUndo ? 'Undo returns the last parked tile to the board' : null,
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
    // The once-per-level guard (a) and the background inert-ing both happen
    // synchronously and unconditionally, whatever comes next — a win's
    // celebration only ever delays the dialog's own classList/focus, never
    // this: the booster rail must already be inert before a fast player could
    // reach it in the gap (issue #120).
    overlayVisible = true;
    setBackgroundInert(true);
    // Focus the way out, not the way back: Shuffle if it can help, else Undo,
    // and only then the restart the player loses progress to.
    const wayOut = canShuffle
      ? overlayShuffle
      : canUndo
        ? overlayUndo
        : overlayRestart.hidden
          ? overlayNew
          : overlayRestart;
    if (status === 'won') {
      presentWinCelebration(wayOut);
    } else {
      overlay.classList.add('visible');
      focusWayOut(wayOut);
    }
  }

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
      if (overlayVisible && !overlay.contains(document.activeElement)) wayOut.focus();
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
    const reduced = settings.value.reducedMotion || prefersReducedMotion();
    const finalScore = game.score;
    const suffix = winScoreSuffix;
    feedback.cue('win');
    if (!reduced) {
      animator.cascade(cascadeTiles());
      winFx.celebrate(cssColor(paletteInPlay().back));
    }
    const reveal = (): void => {
      pendingWinTimer = null;
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
    else pendingWinTimer = setTimeout(reveal, delay);
  }

  /** The tile pictures the cascade sweeps off — whatever is left on the board
   *  at the moment of a win. Decision 0013 means this is usually empty (every
   *  pair clears in the holder), so the effect is generic over zero tiles as
   *  much as any number. `column` is the tile's own slot.x: any ordering
   *  works, and it keeps tiles that share a column moving together. */
  function cascadeTiles(): ReadonlyArray<{ readonly id: TileId; readonly column: number }> {
    return game.board.presentTiles().map((t) => ({ id: t.id, column: t.slot.x }));
  }

  /** Count the dialog's score line from 0 to `final` (issue #120), rebuilding
   *  "Final score: N<suffix>" every frame so the Daily payout line rides
   *  along unchanged. Cancelled by `cancelWinCelebration` on a new deal. */
  function animateScoreCountUp(final: number, suffix: string): void {
    const start = performance.now();
    const step = (now: number): void => {
      const value = scoreCountUp(now - start, final);
      overlayText.textContent = `Final score: ${value}${suffix}`;
      scoreCountRaf = value < final ? requestAnimationFrame(step) : null;
    };
    scoreCountRaf = requestAnimationFrame(step);
  }

  /** Cancel a win celebration in flight — a new deal or a page-hide before the
   *  delayed dialog opened (issue #120). Safe to call unconditionally: every
   *  piece is a no-op when nothing is pending. */
  function cancelWinCelebration(): void {
    if (pendingWinTimer !== null) {
      clearTimeout(pendingWinTimer);
      pendingWinTimer = null;
    }
    if (scoreCountRaf !== null) {
      cancelAnimationFrame(scoreCountRaf);
      scoreCountRaf = null;
    }
    winFx.clear();
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

  /** "+2 Hint, +1 Shuffle" — the non-zero parts of a grant, in rail order;
   *  "nothing (all full)" when every type was at the cap. */
  function describeGrant(got: Counts): string {
    const parts = BOOSTER_KINDS.filter((k) => got[k] > 0).map((k) => `+${got[k]} ${BOOSTER_LABEL[k]}`);
    return parts.length > 0 ? parts.join(', ') : 'nothing — every booster is full';
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
    readonly key: 'audio' | 'haptics' | 'ads' | 'highlightFree' | 'reducedMotion';
    readonly name: string;
  }> = [
    { input: el<HTMLInputElement>('set-audio'), key: 'audio', name: 'Sound effects' },
    { input: el<HTMLInputElement>('set-haptics'), key: 'haptics', name: 'Vibration' },
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
    syncProfileRow();
    syncDailyRow();
  }

  /** The Settings row into the Daily Challenge (issue #19): today's date, and
   *  where the player stands — cleared today, a streak to keep alive, or the
   *  standing invitation. */
  function syncDailyRow(): void {
    const today = dailyDateKey();
    const streak = liveStreak(record.value, today);
    dailyDateEl.textContent = `· ${formatDateKey(today, 'short')}`;
    if (daily === today) {
      dailyStatusEl.textContent = 'On the table now.';
    } else if (record.value.lastDaily === today) {
      dailyStatusEl.textContent = `Cleared today ✓ ${streak}-day streak. Tap to play it again.`;
    } else if (streak > 0) {
      dailyStatusEl.textContent = `${streak}-day streak — clear today’s board to keep it going.`;
    } else {
      dailyStatusEl.textContent = 'One board a day, the same for everyone.';
    }
  }

  /** The Settings row that opens the profile shows who the player is. */
  function syncProfileRow(): void {
    profileRowGlyph.textContent = avatarGlyph(profile.value.avatar);
    profileRowName.textContent = profile.value.name;
    syncHudIdentity();
  }

  /** The Level chip carries the player's name (issue #106): "Dan · Level" for
   *  a named player, plain "Level" for a guest or before the welcome gate is
   *  answered — a guest chose to stay anonymous. */
  function syncHudIdentity(): void {
    // On a Daily board the chip is "Daily" over the date (issue #19); on a
    // decade milestone it is "Milestone" over the number (issue #67) — the
    // words that go with the palette, so colour never carries it alone.
    const what = daily !== null ? 'Daily' : bandForLevel(progress.level).spike ? 'Milestone' : 'Level';
    el<HTMLElement>('level-label').textContent =
      profile.value.choice === 'named' ? `${profile.value.name} · ${what}` : what;
  }

  /** Mirror the in-app Reduced motion toggle onto the DOM (issue #95): the
   *  pressed-state transition is pure CSS, and CSS cannot read settings.ts —
   *  the OS preference has its own media query. */
  function applyMotionPreference(): void {
    if (settings.value.reducedMotion) appRoot.dataset['motion'] = 'reduced';
    else delete appRoot.dataset['motion'];
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
    if (settingsVisible || overlayVisible || changelogVisible || profileVisible || welcomeVisible)
      return;
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

  // --- player profile (issue #69) ----------------------------------------------

  /** One radio per shipped avatar, so profile.ts is the single source of the
   *  list. Built once; syncProfileControls checks the stored pick. */
  function buildAvatarGrid(): void {
    for (const avatar of AVATARS) {
      const label = document.createElement('label');
      const glyph = document.createElement('span');
      glyph.className = 'avatar-glyph';
      glyph.textContent = avatar.glyph;
      glyph.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'avatar';
      input.value = avatar.id;
      input.setAttribute('aria-label', avatar.label);
      input.addEventListener('change', () => {
        if (!input.checked) return;
        profile.setAvatar(avatar.id);
        syncProfileRow();
        announcer.say(`Avatar ${avatar.label}.`);
      });
      label.append(glyph, input);
      avatarGrid.append(label);
    }
  }

  /** Push the stored profile and record into the screen (on open). */
  function syncProfileControls(): void {
    profileNameInput.value = profile.value.name;
    for (const input of avatarGrid.querySelectorAll('input')) {
      input.checked = input.value === profile.value.avatar;
    }
    el<HTMLElement>('record-level').textContent = String(progress.level);
    el<HTMLElement>('record-cleared').textContent = String(record.value.levelsCleared);
    el<HTMLElement>('record-best').textContent = String(record.value.bestScore);
    el<HTMLElement>('record-total').textContent = String(record.value.totalScore);
    // The streak as it stands today, not as it was last written: a missed
    // day has already ended it (issue #19).
    el<HTMLElement>('record-streak').textContent = String(liveStreak(record.value, dailyDateKey()));
    el<HTMLElement>('record-trophies').textContent = String(record.value.trophies);
  }

  function openProfile(): void {
    if (profileVisible) return;
    // Opened from inside Settings: that panel steps aside rather than stacking.
    closeSettings();
    syncProfileControls();
    profileVisible = true;
    profilePanel.classList.add('visible');
    setBackgroundInert(true);
    profileClose.focus();
    announcer.say('Profile.');
  }

  function closeProfile(): void {
    if (!profileVisible) return;
    // A name still sitting in the field commits on the way out: change events
    // fire on blur, but Escape closes the screen without one.
    profileNameInput.value = profile.setName(profileNameInput.value);
    profileVisible = false;
    profilePanel.classList.remove('visible');
    setBackgroundInert(false);
    settingsButton.focus();
  }

  // --- welcome gate (issue #105) -------------------------------------------------

  /** First launch only: the player picks an identity before playing. Required
   *  — no Escape, no backdrop dismiss — so it never re-opens once answered. */
  function openWelcome(): void {
    welcomeVisible = true;
    welcomePanel.classList.add('visible');
    setBackgroundInert(true);
    el<HTMLButtonElement>('welcome-create').focus();
    announcer.say('Welcome. Create a profile, or play as a guest.');
  }

  function closeWelcome(): void {
    if (!welcomeVisible) return;
    welcomeVisible = false;
    welcomePanel.classList.remove('visible');
    setBackgroundInert(false);
  }

  function wireWelcome(): void {
    el<HTMLButtonElement>('welcome-create').addEventListener('click', () => {
      profile.setChoice('named');
      syncHudIdentity();
      closeWelcome();
      openProfile();
    });
    el<HTMLButtonElement>('welcome-guest').addEventListener('click', () => {
      profile.setChoice('guest');
      closeWelcome();
      settingsButton.focus();
      announcer.say('Playing as guest.');
    });
  }

  function wireProfile(): void {
    buildAvatarGrid();
    profileButton.addEventListener('click', () => openProfile());
    profileClose.addEventListener('click', () => closeProfile());
    profileNameInput.addEventListener('change', () => {
      const name = profile.setName(profileNameInput.value);
      // The field shows the name as stored — trimmed, clamped, never empty.
      profileNameInput.value = name;
      syncProfileRow();
      announcer.say(`Name set to ${name}.`);
    });
    // Enter is "done typing" on a one-field form; commit and drop the keyboard.
    profileNameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') profileNameInput.blur();
    });
  }

  function wireSettings(): void {
    for (const { input, key, name } of settingsToggles) {
      input.addEventListener('change', () => {
        settings.set(key, input.checked);
        // The pressed-state CSS reads the toggle from the DOM (issue #95).
        if (key === 'reducedMotion') applyMotionPreference();
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
    // Daily Challenge (issue #19): Settings steps aside and the board deals.
    dailyButton.addEventListener('click', () => {
      closeSettings();
      void startDaily();
    });
    el<HTMLButtonElement>('settings-close').addEventListener('click', () => closeSettings());
    // Tapping the dimmed backdrop dismisses the panel (issue #107). Settings
    // persist per change, so dismissal loses nothing; the target check keeps
    // taps on the card itself from closing it.
    settingsPanel.addEventListener('click', (ev) => {
      if (ev.target === settingsPanel) closeSettings();
    });
    settingsButton.addEventListener('click', () => openSettings());
    // Escape is the expected way out of a modal, and the only one for a
    // keyboard player who tabbed past the Done button. Listened for on the
    // document, not the panel: clicking the card's own text blurs focus to
    // <body>, and a panel-scoped handler would never see the key.
    document.addEventListener('keydown', (ev) => {
      if (settingsVisible && ev.key === 'Escape') closeSettings();
      if (changelogVisible && ev.key === 'Escape') closeChangelog();
      if (profileVisible && ev.key === 'Escape') closeProfile();
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

  /** What Undo gives back — always a parked tile since issue #100: matches
   *  are permanent, so "pair restored" is gone from the vocabulary. */
  function describeUndo(move: HoldMove): string {
    return `${label(move.tile)} taken back out of the holder.`;
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
        if (move === null) return { ok: false, message: 'Nothing to undo — the holder is empty.' };
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
    if (result.ok) {
      charges.spend(kind);
    }
    // Undo puts a parked tile back on the board and Shuffle repaints every
    // face: a copy still flying from the old board would paint over the new
    // one (issue #44).
    if (result.ok && (kind === 'undo' || kind === 'shuffle')) {
      animator.clear();
      trayFx.clear();
      cancelWinCelebration();
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
    // An Undo that returned a tile without lifting the deadlock leaves the
    // dialog up (issue #100: the return may not open a pair). Withdraw the
    // button once the holder has nothing more to give back.
    if (result.ok && kind === 'undo' && overlayVisible) {
      overlayUndo.hidden = !(charges.has('undo') && game.undoDepth > 0);
      if (overlayUndo.hidden) {
        (overlayShuffle.hidden ? overlayRestart : overlayShuffle).focus();
      }
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
   *   * `reroll` (New game): the next layout from the current band's pool
   *     with a fresh seed (issue #99, amending decision 0014's same-layout
   *     re-roll) — the button visibly re-deals a fresh arrangement;
   *   * `ladder` (Next level / Play again after a win): the ladder's own
   *     pinned (layoutId, seed) for the level the win advanced to — level
   *     variety still comes from the ladder.
   *
   * When the wanted layout differs from the loaded one (a win advanced the
   * ladder, or the pool rotated), it is fetched and the renderer re-pointed
   * first. `replay` keeps the layout on the table, rotated or not.
   */
  async function startLevel(mode: 'replay' | 'reroll' | 'ladder'): Promise<void> {
    if (dealing) return;
    // On a Daily board (issue #19) Restart replays the Daily; the other two
    // both mean "back to the ladder", which deals the ladder's own pinned
    // level — a re-roll of a Daily would be a board nobody else has.
    const leavingDaily = daily !== null && mode !== 'replay';
    if (leavingDaily) {
      daily = null;
      mode = 'ladder';
    }
    const next = ladder[progress.level - 1]!;
    const wantedLayoutId =
      mode === 'ladder'
        ? next.layoutId
        : mode === 'reroll'
          ? nextPoolLayout(bandForLevel(progress.level).band, layout.id)
          : layout.id;
    if (!(await switchLayout(wantedLayoutId))) return;
    entry = next;
    beginDeal(
      mode === 'replay'
        ? game.level.seed
        : mode === 'reroll'
          ? rerollSeed(game.level.seed)
          : entry.seed,
    );
    announcer.say(
      mode === 'replay'
        ? daily === null
          ? `Level ${progress.level} restarted. ${game.tilesLeft} tiles.`
          : `Daily Challenge restarted. ${game.tilesLeft} tiles.`
        : leavingDaily
          ? `Back to the ladder. Level ${progress.level}${milestoneNote()}. ${game.tilesLeft} tiles.`
          : `New game dealt. Level ${progress.level}${milestoneNote()}. ${game.tilesLeft} tiles.`,
    );
  }

  /** ", a milestone level" on a decade spike (issue #67) — the spoken half
   *  of the palette swap — and nothing otherwise. */
  function milestoneNote(): string {
    return bandForLevel(progress.level).spike ? ', a milestone level' : '';
  }

  /**
   * Deal today's Daily Challenge (issue #19, spec §6): the board every player
   * gets for this calendar date — layout and seed are both hashes of the
   * date. The current ladder deal is dropped (its save is overwritten by the
   * Daily's; the ladder position keeps), and Back to the ladder re-deals the
   * ladder level from its pinned seed.
   */
  async function startDaily(): Promise<void> {
    if (dealing) return;
    const key = dailyDateKey();
    if (daily === key) {
      announcer.say(`Already on the Daily Challenge for ${formatDateKey(key, 'long')}.`);
      return;
    }
    if (!(await switchLayout(dailyLayoutId(key)))) return;
    daily = key;
    beginDeal(dailySeed(key));
    announcer.say(
      `Daily Challenge for ${formatDateKey(key, 'long')}. ${game.tilesLeft} tiles. Everyone gets this board today.`,
    );
  }

  /** Load `wantedLayoutId` if it is not on the table. False when the fetch
   *  failed — the caller keeps the loaded board rather than a blank one. */
  async function switchLayout(wantedLayoutId: string): Promise<boolean> {
    if (wantedLayoutId === layout.id) return true;
    // The fetch yields the event loop: block input until the new deal is in,
    // or a tap lands on the outgoing board and mutates a game about to be
    // discarded (its save clobbered by the new deal's).
    dealing = true;
    try {
      layout = await fetchLayout(wantedLayoutId);
    } catch {
      // Offline mid-session: keep the loaded board rather than a blank one.
      announcer.say('Could not load the next level. Check your connection and try again.');
      return false;
    } finally {
      dealing = false;
    }
    renderer.setLayout(layout.slots);
    if (applyHudPlacement()) app.resize();
    return true;
  }

  /** Put a fresh deal from `seed` on the (already loaded) layout and reset
   *  everything per-deal: effects, hint, assist counts, clock, dialog. */
  function beginDeal(seed: number): void {
    game = dealCurrentLevel(seed);
    applyPalette();
    flash = [];
    flashToken++;
    animator.clear();
    trayFx.clear();
    cancelWinCelebration();
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
  wireProfile();
  wireWelcome();
  applyMotionPreference();
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
      // Not cancelWinCelebration(): a pending win dialog must still open when
      // the player comes back (a hidden setTimeout keeps running, just
      // possibly throttled), so only the decorative lanterns/confetti — which
      // would otherwise sit frozen mid-flight, like the tray flights above —
      // are dropped here (issue #120).
      winFx.clear();
      persist();
    } else {
      elapsed.resume();
    }
  });
  window.addEventListener('pagehide', () => {
    persist();
  });

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

  // Never asked who's playing (issue #105): ask now, over the dealt board.
  // The stored answer — named or guest — means this shows at most once.
  if (profile.value.choice === null) openWelcome();

  // Daily first-launch grant (issue #51): +1 of each, once per local calendar
  // day. The badges already show it (syncBoosterButtons ran in the redraw
  // above); say it too, a beat after the boot announcement so the two
  // live-region writes do not coalesce into one.
  const loginGrant = charges.grantDailyLogin(dailyDateKey());
  if (loginGrant !== null) {
    syncBoosterButtons();
    window.setTimeout(() => announcer.say(`Daily bonus: ${describeGrant(loginGrant)}.`), 1500);
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
    /** The Daily Challenge on the table as its date key, or null (issue #19). */
    get daily() {
      return daily;
    },
    /** The booster grant line on the win dialog, null while hidden (issue #51 QA). */
    grantText(): string | null {
      return overlayGrant.hidden ? null : overlayGrant.textContent;
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
    /** Player identity + record (issue #69 QA assertions). */
    profile() {
      return profile.value;
    },
    playerRecord() {
      return record.value;
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
      return animator.busy || trayFx.busy || winFx.busy || pendingWinTimer !== null;
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
