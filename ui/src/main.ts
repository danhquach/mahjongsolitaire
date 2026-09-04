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
// streak/trophy counters that move as daily challenges are completed.
// Issue #63 makes the holder one-way and a full one final (decision 0009), so
// the HUD gains the two things a hard-fail owes the player: a warning before
// the fatal park (the last empty slot is marked, and — since issue #93 — every
// free tile with no match in the holder says that activating it sends it to
// the last slot and ends the level) and a loss dialog that offers only a
// restart, because there is nothing else left to offer.
// Issue #121 gives that loss the presentation its finality deserves — the one
// hard fail in the game — deliberately harsher than the deadlock treatment
// (#122): the fourth tile slams into its slot instead of parking, the holder
// strip shakes and reddens, a dark wash settles over the board while whatever
// tiles are left slump and lose their colour, and only then does the dialog
// appear (LOSS_DIALOG_DELAY_MS, longer than the win's own delay). Reduced
// motion collapses all of it to an instant, lower-opacity wash; a reload of an
// already-lost save (spec §3.5: reloading is not an escape hatch) shows the
// same instant wash at full opacity with no delay — the fight already
// happened, so there is nothing left to replay.

import { Application } from 'pixi.js';
import {
  HOLDER_SLOTS,
  bandForLevel,
  CONCEAL_RATIO,
  concealBucketForBand,
  concealRatioForLevel,
  scoreMultiplierForLevel,
  BAND_SCORE_MULTIPLIER,
  DAILY_CHALLENGE_COUNT,
  dailyDateKey,
  faceSuit,
  nextPoolLayout,
  concealedTileIds,
  generateValidatedLevel,
  parseLadder,
  parseLayout,
} from '@mahjongsolitaire/core';
import type {
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
import { LossFx, STUCK_WASH_COLOR, STUCK_WASH_OPACITY, STUCK_WASH_OPACITY_REDUCED } from './loss-fx.js';
import {
  SLAM_MS,
  STUCK_WASH_MS,
  lossSchedule,
  scheduleDialogDelay,
  scoreCountUp,
  stuckSchedule,
} from './anim.js';
import { Feedback, navigatorVibrate, webAudioPlayer } from './feedback.js';
import type { Cue } from './feedback.js';
import { faceStyle } from './faces.js';
import { Game, nearPairs } from './game.js';
import { HolderStrip } from './holder.js';
import { BOARD_FELT, PALETTES, cssColor } from './depth.js';
import type { BoardPalette } from './depth.js';
import { SIDE_DEPTH, TILE_H, TILE_W, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';
import { hitTest } from './hit-test.js';
import { HUD_PLACEMENTS, chooseHudPlacement } from './hud-fit.js';
import type { HudCandidate, HudPlacement } from './hud-fit.js';
import { BoardRenderer } from './render.js';
import { briefChangelog, versionLabel } from './changelog.js';
import changelogMd from '../../CHANGELOG.md?raw';
import {
  ATTACHMENT_ACCEPT,
  FEEDBACK_INBOX,
  MAX_ATTACHMENTS,
  buildFeedbackPayload,
  canSend as canSendFeedback,
  checkAttachment,
  copyText,
  encodeAttachments,
  feedbackSubject,
  feedbackText,
  reencodedName,
  refusalMessage,
  mailtoUrl,
  reportText,
  sendFeedback,
} from './feedback-form.js';
import { DailyStore, describeChallenge } from './daily.js';
import { ProgressStore } from './progress.js';
import {
  AVATARS,
  ProfileStore,
  RecordStore,
  avatarGlyph,
  clearedLevelCount,
  hasCleared,
  liveStreak,
  weekScoreNow,
} from './profile.js';
import { SaveStore, captureSave, reopen } from './save.js';
import {
  fetchProfile,
  forgetCredentials,
  formatCode,
  formatPlayerTag,
  normalizeCode,
  mergeRecords,
  pushName,
  pushRecord,
  readCredentials,
  registerProfile,
  writeCredentials,
} from './sync.js';
import type { RemoteProfile, SyncCredentials, SyncFailure } from './sync.js';
import {
  boardRows,
  compactHistory,
  fetchWeeklyBoard,
  formatResetCountdown,
  readOptIn,
  speakResetCountdown,
  submitRunScore,
  withdrawFromBoard,
  writeOptIn,
} from './leaderboard.js';
import type { WeeklyBoard } from './leaderboard.js';
import { DEFAULT_SETTINGS, SettingsStore, TILE_SIZE_FACTOR, TILE_SIZE_LABEL, TILE_SIZES } from './settings.js';
import type { BooleanSetting, TileSize } from './settings.js';
import { localKeyValueStorage } from './storage.js';
import { Tutorial } from './tutorial.js';
import {
  cardCoversHole,
  cardSide,
  layoutTags,
  panelHole,
  pickFreeBlocked,
  pickVisiblePair,
  scrimPath,
  tileHole,
} from './spotlight.js';
import type { Hole, SpotTile } from './spotlight.js';
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

function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  // getElementById types as HTMLElement even for an inline <svg>; widen
  // through Element so an SVG root can be asked for without a double cast.
  return node as Element as T;
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
  const levelButton = el<HTMLButtonElement>('btn-level');
  const overlayShuffle = el<HTMLButtonElement>('overlay-shuffle');
  const overlayUndo = el<HTMLButtonElement>('overlay-undo');
  const a11yRoot = el<HTMLDivElement>('a11y-layer');
  const header = el<HTMLElement>('app-header');
  const boosterRail = el<HTMLDivElement>('booster-rail');
  const holderRoot = el<HTMLDivElement>('holder');
  const settingsPanel = el<HTMLDivElement>('settings');
  const settingsButton = el<HTMLButtonElement>('btn-settings');
  const changelogPanel = el<HTMLDivElement>('changelog');
  const changelogCard = changelogPanel.querySelector<HTMLDivElement>('.card')!;
  const changelogTitle = el<HTMLHeadingElement>('changelog-title');
  const changelogBody = el<HTMLDivElement>('changelog-body');
  const changelogClose = el<HTMLButtonElement>('changelog-close');
  const welcomePanel = el<HTMLDivElement>('welcome');
  // First-run tutorial card (issue #59).
  const tutorialPanel = el<HTMLDivElement>('tutorial');
  const tutorialCard = el<HTMLDivElement>('tutorial-card');
  const tutorialStepEl = el<HTMLElement>('tutorial-step');
  const tutorialTitle = el<HTMLElement>('tutorial-title');
  const tutorialText = el<HTMLElement>('tutorial-text');
  const tutorialNext = el<HTMLButtonElement>('tutorial-next');
  const tutorialSkip = el<HTMLButtonElement>('tutorial-skip');
  // Tutorial spotlight scrim (issue #150).
  const spotlightSvg = el<SVGSVGElement>('spotlight');
  const holderDiv = el<HTMLDivElement>('holder');
  const boostersGroup = boosterRail.querySelector<HTMLElement>('.boosters');
  const scoreChip = el<HTMLElement>('score').parentElement;
  const profilePanel = el<HTMLDivElement>('profile');
  const profileButton = el<HTMLButtonElement>('btn-profile');
  const profileClose = el<HTMLButtonElement>('profile-close');
  const profileNameInput = el<HTMLInputElement>('profile-name');
  const avatarGrid = el<HTMLDivElement>('avatar-grid');
  const profileRowGlyph = el<HTMLElement>('profile-row-glyph');
  const profileRowName = el<HTMLElement>('profile-row-name');
  const syncOffBlock = el<HTMLDivElement>('sync-off');
  const syncOnBlock = el<HTMLDivElement>('sync-on');
  const syncRestoreForm = el<HTMLDivElement>('sync-restore-form');
  const syncCodeInput = el<HTMLInputElement>('sync-code-input');
  const syncEnableButton = el<HTMLButtonElement>('sync-enable');
  const syncRestoreButton = el<HTMLButtonElement>('sync-restore');
  const syncRestoreConfirm = el<HTMLButtonElement>('sync-restore-confirm');
  const syncRestoreCancel = el<HTMLButtonElement>('sync-restore-cancel');
  const syncRevealButton = el<HTMLButtonElement>('sync-reveal');
  const syncCopyButton = el<HTMLButtonElement>('sync-copy');
  const syncDisableButton = el<HTMLButtonElement>('sync-disable');
  const syncTag = el<HTMLElement>('sync-tag');
  const syncCodeValue = el<HTMLElement>('sync-code');
  const syncStatus = el<HTMLElement>('sync-status');
  const boardOptInInput = el<HTMLInputElement>('board-opt-in');
  const boardOptInHint = el<HTMLElement>('board-opt-in-hint');
  const boardOpenButton = el<HTMLButtonElement>('board-open');
  const boardStatus = el<HTMLElement>('board-status');
  const leaderboardButton = el<HTMLButtonElement>('btn-leaderboard');
  const leaderboardPanel = el<HTMLDivElement>('leaderboard');
  const leaderboardList = el<HTMLOListElement>('leaderboard-list');
  const leaderboardResetLine = el<HTMLElement>('leaderboard-resets');
  const leaderboardEmpty = el<HTMLElement>('leaderboard-empty');
  const leaderboardStatus = el<HTMLElement>('leaderboard-status');
  const leaderboardClose = el<HTMLButtonElement>('leaderboard-close');
  const overlayGrant = el<HTMLElement>('overlay-grant');
  const lossWashLayer = el<HTMLDivElement>('loss-wash-layer');
  const dailyButton = el<HTMLButtonElement>('btn-daily');
  const dailyValue = el<HTMLElement>('daily-value');
  const dailyPanel = el<HTMLDivElement>('daily-panel');
  const dailyPanelSummary = el<HTMLElement>('daily-panel-summary');
  const dailyPanelList = el<HTMLElement>('daily-panel-list');
  const dailyPanelStreak = el<HTMLElement>('daily-panel-streak');
  const dailyPanelTrophies = el<HTMLElement>('daily-panel-trophies');
  const dailyPanelClose = el<HTMLButtonElement>('daily-panel-close');
  const feedbackPanel = el<HTMLDivElement>('feedback');
  const feedbackButton = el<HTMLButtonElement>('btn-feedback');
  const feedbackSummaryInput = el<HTMLInputElement>('feedback-summary');
  const feedbackBodyInput = el<HTMLTextAreaElement>('feedback-body');
  const feedbackStatus = el<HTMLElement>('feedback-status');
  const feedbackSend = el<HTMLButtonElement>('feedback-send');
  const feedbackCancel = el<HTMLButtonElement>('feedback-cancel');
  const feedbackMailto = el<HTMLAnchorElement>('feedback-mailto');
  const feedbackMailtoNote = el<HTMLElement>('feedback-mailto-note');
  const feedbackInbox = el<HTMLParagraphElement>('feedback-inbox');
  const feedbackInboxAddress = el<HTMLElement>('feedback-inbox-address');
  const feedbackCopy = el<HTMLButtonElement>('feedback-copy');
  const feedbackCopyStatus = el<HTMLElement>('feedback-copy-status');
  const feedbackReportLabel = el<HTMLLabelElement>('feedback-report-label');
  const feedbackReport = el<HTMLTextAreaElement>('feedback-report');
  const feedbackAttachButton = el<HTMLButtonElement>('feedback-attach');
  const feedbackFileInput = el<HTMLInputElement>('feedback-file');
  const feedbackAttachmentList = el<HTMLUListElement>('feedback-attachments');
  const feedbackAttachStatus = el<HTMLElement>('feedback-attach-status');

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
    return new Game(
      level,
      undefined,
      concealedTileIds(level, concealRatioInPlay()),
      scoreMultiplierInPlay(),
    );
  }

  /** The score multiplier the deal on the table plays at (issue #176): the
   *  ladder level's band. Every deal is a ladder deal since issue #183. */
  function scoreMultiplierInPlay(): number {
    return scoreMultiplierForLevel(progress.level);
  }

  /** The concealment ratio the deal on the table plays at: the level ramp
   *  (issue #175). */
  function concealRatioInPlay(): number {
    return concealRatioForLevel(progress.level);
  }

  /** The palette the deal on the table wears (issue #67): the decade
   *  milestone's (decision 0011's spike levels), else the default. */
  function paletteInPlay(): BoardPalette {
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
  // and the player gets a fresh deal instead of an error.
  //
  // A ladder save's concealment ratio is re-derived from its (layoutId, seed),
  // which normally names a ladder entry. A re-rolled deal (issue #94) does not
  // name one, but it is always the *current* level's, so the ladder position
  // answers for it either way — which is why this never passes undefined and
  // so never takes reopen's difficulty-derived fallback. Since issue #175 the
  // ratio comes from the level, not the band, so a teaching level resumes at 0
  // and must stay face-up.
  //
  // The score multiplier (issue #176) is re-derived the same way and for the
  // same reason. It is not stored either, and getting it wrong here would be
  // silent: the resumed deal would keep the points already earned and then pay
  // a different rate for every match after the reload.
  const savedEntry = saved === null ? undefined : ladderEntryFor(saved.layoutId, saved.seed);
  const savedLevel = savedEntry?.level ?? progress.level;
  const resumed =
    saved === null
      ? null
      : reopen(
          layout,
          saved,
          concealRatioForLevel(savedLevel),
          scoreMultiplierForLevel(savedLevel),
        );
  // A failed resume can leave the save's layout loaded; the fresh deal is the
  // current ladder level's, so re-point at its layout first.
  if (resumed === null && layout.id !== entry.layoutId) layout = await fetchLayout(entry.layoutId);
  let game = resumed ?? dealCurrentLevel(entry.seed);

  const renderer = new BoardRenderer(app, layout.slots);
  const announcer = new Announcer(el<HTMLElement>('a11y-status'));
  // The booted deal's palette (issue #67) — a milestone level boots into its
  // own colours, not the default's.
  applyPalette();

  const settings = new SettingsStore(storage);
  const feedback = new Feedback(() => settings.value, webAudioPlayer(), navigatorVibrate());

  // The player (issue #69): identity and record, both local-first — the game
  // never needs a network or an account for either.
  const profile = new ProfileStore(storage);
  const record = new RecordStore(storage);

  /** Today's progress against today's three challenges (issue #183). Fed by
   *  play, not by a mode: there is nowhere else to play. */
  const dailyProgress = new DailyStore(storage);
  let dailyPanelVisible = false;

  // Match / mismatch animation (issue #44). Reduced motion is the OS preference
  // OR the in-app toggle, read per effect so either can be changed mid-session;
  // the animator itself never touches game state or the input path.
  const animator = new Animator(app.ticker, {
    reduced: () => settings.value.reducedMotion || prefersReducedMotion(),
    tileNode: (id) => renderer.tileNode(id),
    setDesaturation: (amount) => renderer.setDesaturation(amount),
    tileRect: (id) => tileRect(game.board.get(id).slot),
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
  let feedbackVisible = false;
  /** The success state's auto-close (issue #118); held so a Cancel-and-reopen
   *  inside that second cannot have a stale timer close the new dialog. */
  let feedbackCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let welcomeVisible = false;
  /** The tutorial card (issue #59) is up over the board. */
  let tutorialVisible = false;
  /** A tutorial that wanted to start while another panel (the welcome gate,
   *  the profile it may open) was up; it starts when that panel closes. */
  let tutorialPending = false;
  /** True while a submit is in flight — Send stays disabled regardless of
   *  field content so a slow request cannot be fired twice (issue #118). */
  let feedbackSending = false;
  /** The report "Copy report" puts on the clipboard (issue #135): set by the
   *  failure path from the payload that was actually sent, cleared with the
   *  rest of the failure state. */
  let feedbackReportText: string | null = null;
  /** Files picked for the current report (issue #130), in pick order. Images
   *  are already re-encoded (metadata stripped); `previewUrl` is an object
   *  URL revoked when the entry goes away. */
  interface PendingAttachment {
    readonly id: number;
    readonly name: string;
    readonly type: string;
    readonly kind: 'image' | 'video';
    readonly blob: Blob;
    readonly size: number;
    readonly previewUrl: string;
  }
  let feedbackAttachments: PendingAttachment[] = [];
  let nextAttachmentId = 1;
  /** True while a picked batch is being checked and re-encoded: Add and Send
   *  wait for it, so a second pick cannot interleave with the first and a
   *  Send cannot go out missing the file still on the canvas. */
  let feedbackPicking = false;
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
      // Never true for a hidden face (issue #165): the tap would clear it,
      // but the label must not say so — that names the face by implication.
      pairsWithHeld: game.pairsWithHeld(t.id),
      // Issue #169: a tile matching the current peek clears too — same label,
      // same hidden-face guard as pairsWithHeld.
      pairsWithPeek: game.pairsWithPeek(t.id),
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
  // The holder-full loss's DOM half (issue #121): the strip shake and the red
  // wash, on their own layer like winFx's.
  const lossFx = new LossFx(lossWashLayer, holderRoot, () =>
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
    // draw() resets the board-wide desaturation. While the "No moves left"
    // dialog is up the board is at its resting grey (issue #159) — the
    // grey-out's fade is over by the time the dialog reveals, and a redraw
    // underneath it (a resize, a still-stuck rescue) must not hand the
    // board back in colour. Before the reveal the live GreyOutEffect owns
    // the amount and reapplies it on its next tick.
    if (game.status() === 'stuck' && overlay.classList.contains('visible')) {
      renderer.setDesaturation(1);
    }
    levelEl.textContent = String(progress.level);
    syncHudIdentity();
    syncDailyChip();
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

  function showStatus(opts: { readonly fromResume?: boolean } = {}): void {
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
    overlayGrant.hidden = true;
    // The red-tinted card (issue #121) — only the holder-full loss gets it;
    // every other dialog (won, stuck) keeps the default green.
    overlay.classList.toggle('lost', status === 'lost');
    if (status === 'won') {
      overlayRestart.hidden = true;
      // Advance the ladder exactly once per win: this branch is inside the
      // once-per-level transition (the overlayVisible guard above). The
      // player's record counts the same moment (issue #69).
      const cleared = progress.level;
      const atEnd = progress.advance() === cleared;
      // Booster grants (issue #51, #117) key off the record *before* this
      // win is written: only a first clear can pay, a replay never does.
      const firstClear = !hasCleared(record.value, cleared);
      record.recordWin(game.score, { level: cleared }, Date.now());
      // Issue #176: the weekly board ranks the ladder, so this is the win
      // with somewhere to go. Every clear counts, replays included — the
      // band score multiplier is what stops grinding an easy level from
      // being the fastest way up, rather than a once-per-week rule.
      submitRunResult(game.score, elapsed.ms);
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
      // Issue #183: a finished board may complete one of today's challenges.
      // Paid before the announcement so the payout rides on that same line.
      payDailyChallenges(dailyProgress.onBoardCleared(dailyDateKey()));
      announcer.say(
        `Level ${cleared} complete. Final score ${game.score}. ${grantLines.join(' ')}`.trim() +
          takeDailyPayout(),
      );
      // The record just moved; push it up if sync is on (issue #138). Nothing
      // here waits on it.
      syncAfterWin();
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
    } else if (status === 'lost') {
      presentLossCelebration(wayOut, opts.fromResume ?? false);
    } else {
      presentStuckCelebration(wayOut, opts.fromResume ?? false);
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
    const reduced = settings.value.reducedMotion || prefersReducedMotion();
    const skipTheatre = reduced || instant;
    if (!instant) feedback.cue('fail');
    holder.setLost(true);
    const startEffects = (): void => {
      if (skipTheatre) {
        lossFx.wash({ reduced, instant: true });
      } else {
        lossFx.shake();
        animator.slump(game.board.presentTiles().map((t) => t.id));
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
    const reduced = settings.value.reducedMotion || prefersReducedMotion();
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
    if (!skipTheatre) animator.pulse(nearPairs(game.board));
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
    return game.board.presentTiles().map((t) => ({ id: t.id, column: t.slot.x }));
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
    readonly key: BooleanSetting;
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
    {
      input: el<HTMLInputElement>('set-show-tutorial'),
      key: 'showTutorial',
      name: 'Show tutorial',
    },
  ];
  // Tile size is a slider over TILE_SIZES (issue #139): value = stop index.
  const sizeSlider = el<HTMLInputElement>('set-size');
  const sizeValueEl = el<HTMLElement>('set-size-value');

  /** Point the slider at the stored stop and name it, for eyes and for
   *  screen readers (aria-valuetext: "Tile size, Large", not "2"). */
  function syncSizeSlider(): void {
    const size = settings.value.tileSize;
    sizeSlider.max = String(TILE_SIZES.length - 1);
    sizeSlider.value = String(TILE_SIZES.indexOf(size));
    sizeSlider.setAttribute('aria-valuetext', TILE_SIZE_LABEL[size]);
    sizeValueEl.textContent = TILE_SIZE_LABEL[size];
  }

  /** Push the stored settings into the controls (open, and on boot). */
  function syncSettingsControls(): void {
    const current = settings.value;
    for (const { input, key } of settingsToggles) input.checked = current[key];
    syncSizeSlider();
    syncProfileRow();
  }

  /** The HUD's Daily chip (issue #136; issue #183 turned it from a board deal
   *  into the challenge panel): how many of today's three are complete. It
   *  pulses only while none are, and never disables — the panel stays
   *  readable when the day is finished. */
  function syncDailyChip(): void {
    const done = dailyProgress.completedCount(dailyDateKey());
    dailyButton.dataset['state'] = done === 0 ? 'pending' : done === DAILY_CHALLENGE_COUNT ? 'done' : 'partial';
    dailyValue.textContent = `${done}/${DAILY_CHALLENGE_COUNT}`;
    const name = `Daily challenges, ${done} of ${DAILY_CHALLENGE_COUNT} complete`;
    dailyButton.setAttribute('aria-label', name);
    dailyButton.title = name;
  }

  /** Paint the panel from the store. Called on open and after every
   *  completion, so a challenge that lands while the panel is up updates in
   *  place rather than going stale behind the player. */
  function renderDailyPanel(): void {
    const today = dailyDateKey();
    const standing = dailyProgress.standing(today);
    const done = dailyProgress.completedCount(today);
    dailyPanelSummary.textContent = `${formatDateKey(today, 'long')} — ${done} of ${standing.length} complete`;
    dailyPanelList.replaceChildren(
      ...standing.map((slot) => {
        const goal = describeChallenge(slot.challenge);
        const row = document.createElement('li');
        row.className = 'daily-row';
        row.dataset['done'] = String(slot.done);
        row.setAttribute('role', 'group');
        // The check and the bold weight are visual; the word is what a screen
        // reader has to hear.
        row.setAttribute('aria-label', slot.done ? `${goal}, completed` : goal);

        const line = document.createElement('div');
        line.className = 'daily-goal';
        const mark = document.createElement('span');
        mark.className = 'daily-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = slot.done ? '✓' : '○';
        const text = document.createElement('span');
        text.className = 'daily-text';
        text.textContent = goal;
        const count = document.createElement('span');
        count.className = 'daily-count';
        count.textContent = `${slot.count} / ${slot.challenge.target}`;
        line.append(mark, text, count);

        const track = document.createElement('div');
        track.className = 'daily-track';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', String(slot.challenge.target));
        track.setAttribute('aria-valuenow', String(slot.count));
        track.setAttribute('aria-valuetext', `${slot.count} of ${slot.challenge.target}`);
        const fill = document.createElement('div');
        fill.className = 'daily-fill';
        fill.style.width = `${Math.round((slot.count / slot.challenge.target) * 100)}%`;
        track.append(fill);

        row.append(line, track);
        return row;
      }),
    );
    dailyPanelStreak.textContent = String(liveStreak(record.value, today));
    dailyPanelTrophies.textContent = String(record.value.trophies);
  }

  /** The chip's tap (issue #183): today's challenges, not a board. Opens the
   *  way every other dialog does — the `visible` class, the background inert,
   *  focus in and back to the chip on the way out. */
  function openDailyPanel(): void {
    // The chip lives in the HUD, which goes inert behind any dialog — but the
    // guard is cheap and does not rely on that staying true. Same list as
    // openSettings, so the two read alike.
    if (
      dailyPanelVisible ||
      settingsVisible ||
      overlayVisible ||
      changelogVisible ||
      profileVisible ||
      feedbackVisible ||
      welcomeVisible ||
      tutorialVisible
    )
      return;
    renderDailyPanel();
    dailyPanelVisible = true;
    dailyPanel.classList.add('visible');
    setBackgroundInert(true);
    dailyPanelClose.focus();
    announcer.say(
      `Daily challenges. ${dailyProgress.completedCount(dailyDateKey())} of ${DAILY_CHALLENGE_COUNT} complete.`,
    );
  }

  function closeDailyPanel(): void {
    if (!dailyPanelVisible) return;
    dailyPanelVisible = false;
    dailyPanel.classList.remove('visible');
    setBackgroundInert(false);
    dailyButton.focus();
  }

  /** What a completed challenge has to say, waiting for the next live-region
   *  write to carry it. Never spoken on its own from inside a tap: two writes
   *  in the same tick coalesce and the first is never heard (see finishTap),
   *  and the match that completed the challenge is announced too. */
  let pendingDailyPayout = '';

  /** Take the waiting payout text, ready to append to another line. */
  function takeDailyPayout(): string {
    const line = pendingDailyPayout;
    pendingDailyPayout = '';
    return line === '' ? '' : ` ${line}`;
  }

  /** Pay for every challenge that just completed (issue #183): a trophy each,
   *  a booster charge each, and the day's first completion also moving the
   *  streak. The payout is queued for the announcer, not spoken here. */
  function payDailyChallenges(completed: readonly number[]): void {
    if (completed.length === 0) return;
    const today = dailyDateKey();
    const standing = dailyProgress.standing(today);
    const lines: string[] = [];
    for (const slot of completed) {
      const credit = record.creditDailyChallenge(today);
      const got = charges.grantSplit(1, Math.random);
      const goal = describeChallenge(standing[slot]!.challenge);
      lines.push(
        `Daily challenge complete: ${goal.toLowerCase()}. ${
          credit.trophies === 1 ? '1 trophy' : `${credit.trophies} trophies`
        }, ${describeGrant(got)}.`,
      );
    }
    pendingDailyPayout = [pendingDailyPayout, ...lines].filter((l) => l !== '').join(' ');
    syncBoosterButtons();
    syncDailyChip();
    if (dailyPanelVisible) renderDailyPanel();
    // The record just moved; push it up if sync is on (issue #138).
    syncAfterWin();
  }

  /** The Settings row that opens the profile shows who the player is. */
  function syncProfileRow(): void {
    profileRowGlyph.textContent = avatarGlyph(profile.value.avatar);
    profileRowName.textContent = profile.value.name;
    syncHudIdentity();
  }

  /** The Level chip carries the player's name (issue #106). Issue #153: for a
   *  named player on an ordinary level the visible label is the name alone —
   *  the big number under it is self-evidently the level, and the word cost
   *  the one-row phone header its width. A guest (no name) keeps "Level"; a
   *  Milestone board keeps its word after the name, since that word goes with
   *  the palette (colour never carries it alone). */
  function syncHudIdentity(): void {
    // On a decade milestone the chip is "Milestone" over the number (#67).
    const what = bandForLevel(progress.level).spike ? 'Milestone' : 'Level';
    const named = profile.value.choice === 'named';
    const spoken = named ? `${profile.value.name} · ${what}` : what;
    const shown = named && what === 'Level' ? profile.value.name : spoken;
    el<HTMLElement>('level-label').textContent = shown;
    // The chip is a button into the profile (issue #137): its name is the
    // full form — name, word and number — plus where it goes, so a
    // screen-reader user loses nothing when the visible word goes.
    levelButton.setAttribute('aria-label', `${spoken} ${levelEl.textContent}, opens your profile`);
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
   * Fit the canvas to #board and the board to the canvas, and keep going until
   * the two agree (issue #125). The holder strip is sized off the fitted
   * on-screen tile size (issue #66), so a fit changes the holder's height,
   * which changes #board's box, which Pixi has already read: one pass can
   * leave the canvas taller than #board — tiles then bleed into the band the
   * booster rail (and, since #125, the settings gear) reserves under it — or
   * shorter, wasting board. The explicit app.resize() also cancels the frame
   * Pixi's own resize plugin queues on a window resize, so nothing else will
   * re-read #board for us. The loop converges in two passes in practice; the
   * cap is only a guard against a layout that oscillates.
   */
  function settleBoardFit(): void {
    applyHudPlacement();
    for (let pass = 0; pass < 4; pass++) {
      app.resize();
      applyTileSize(); // fits the board for the stored tile size, then redraws
      if (app.renderer.width === boardDiv.clientWidth && app.renderer.height === boardDiv.clientHeight) {
        return;
      }
    }
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
    if (
      settingsVisible ||
      overlayVisible ||
      changelogVisible ||
      profileVisible ||
      feedbackVisible ||
      welcomeVisible ||
      tutorialVisible ||
      dailyPanelVisible
    )
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

  // --- first-run tutorial (issue #59) -------------------------------------------

  /** Both ends write the toggle OFF: a skipped tutorial is not re-offered on
   *  the next level any more than a completed one is. */
  const tutorial = new Tutorial((how) => {
    settings.set('showTutorial', false);
    syncSettingsControls();
    closeTutorialCard();
    announcer.say(how === 'done' ? 'Tutorial finished. The board is yours.' : 'Tutorial skipped. The board is yours.');
  });

  /**
   * Open the card on step 1 over the dealt board. While another panel is up —
   * the welcome gate on a fresh install, or the profile screen it opens — the
   * start is deferred, and `startPendingTutorial` runs it as that panel closes.
   */
  function startTutorial(): void {
    if (
      welcomeVisible ||
      profileVisible ||
      settingsVisible ||
      changelogVisible ||
      feedbackVisible ||
      leaderboardVisible ||
      overlayVisible
    ) {
      tutorialPending = true;
      return;
    }
    tutorialPending = false;
    tutorial.start();
    tutorialVisible = true;
    tutorialPanel.classList.add('visible');
    setBackgroundInert(true);
    renderTutorialStep();
    // The card itself takes focus (not a button) so the dialog's name and
    // description are read first; Tab reaches Skip and Next from there.
    tutorialCard.focus();
  }

  function startPendingTutorial(): void {
    if (tutorialPending) startTutorial();
  }

  /** The tiles the current step points at (issue #150), chosen once per
   *  step so a resize moves the rings with the tiles rather than re-picking. */
  let spotlightTiles: { readonly free?: TileId; readonly blocked?: TileId; readonly pair?: readonly TileId[] } = {};
  /** The holes as last drawn, page CSS px (QA reads them back). */
  let spotlightHoles: readonly Hole[] = [];

  /** Every present tile with its on-screen face rect, for the picker. */
  function spotTiles(): SpotTile[] {
    const canvas = app.canvas.getBoundingClientRect();
    return game.board.presentTiles().map((t) => {
      const r = tileCssRect(t.slot);
      return {
        id: t.id,
        z: t.slot.z,
        free: game.board.isFree(t.id),
        face: t.face,
        rect: { x: canvas.x + r.x, y: canvas.y + r.y, w: r.w, h: r.h },
      };
    });
  }

  function boardMidY(): number {
    const b = boardDiv.getBoundingClientRect();
    return b.y + b.height / 2;
  }

  /** Pick the step's actors on the board in play. Step 3 keeps the ordinary
   *  hint highlight on the same pair; the solver's own hint is the fallback
   *  when no fully visible pair exists (peekHint: the demonstration must not
   *  advance Hint's cycle). */
  function pickSpotlightTiles(): void {
    spotlightTiles = {};
    const step = tutorial.step;
    if (step === null) return;
    if (step.actor === 'free-blocked') {
      const pick = pickFreeBlocked(spotTiles(), boardMidY());
      if (pick) spotlightTiles = { free: pick.free.id, blocked: pick.blocked.id };
    } else if (step.actor === 'pair') {
      const pick = pickVisiblePair(spotTiles(), boardMidY());
      if (pick) {
        spotlightTiles = { pair: [pick[0].id, pick[1].id] };
        hintPair = spotlightTiles.pair!;
      } else {
        // No fully visible pair on this board: the solver's hint is still
        // highlighted and announced, but not ringed — a ring around a
        // half-covered tile would break the "fully visible" rule.
        hintPair = game.peekHint() ?? [];
      }
    }
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgNode<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number>,
    className = '',
  ): SVGElementTagNameMap[K] {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (className) node.setAttribute('class', className);
    return node;
  }

  /**
   * Draw the scrim, rings and tags for the current step around wherever the
   * actors are *now*, and put the card in the half of the board they are not
   * in. Called on every step and on every resize while the tutorial is up.
   */
  function layoutSpotlight(): void {
    const step = tutorial.step;
    if (step === null || !tutorialVisible) return;
    const holes: Hole[] = [];
    const pageRect = (elm: HTMLElement | null): Hole | null => {
      if (!elm) return null;
      const r = elm.getBoundingClientRect();
      return panelHole({ x: r.x, y: r.y, w: r.width, h: r.height });
    };
    const tileRectOnPage = (id: TileId): { x: number; y: number; w: number; h: number } => {
      const canvas = app.canvas.getBoundingClientRect();
      const r = tileCssRect(game.board.get(id).slot);
      return { x: canvas.x + r.x, y: canvas.y + r.y, w: r.w, h: r.h };
    };
    if (spotlightTiles.free !== undefined) holes.push(tileHole(tileRectOnPage(spotlightTiles.free), 'free'));
    if (spotlightTiles.blocked !== undefined) holes.push(tileHole(tileRectOnPage(spotlightTiles.blocked), 'blocked'));
    for (const id of spotlightTiles.pair ?? []) holes.push(tileHole(tileRectOnPage(id), 'pair'));
    const panel =
      step.actor === 'boosters'
        ? pageRect(boostersGroup)
        : step.actor === 'holder'
          ? pageRect(holderDiv)
          : step.actor === 'score'
            ? pageRect(scoreChip)
            : null;
    if (panel) holes.push(panel);
    spotlightHoles = holes;

    // Card first: which half it takes decides nothing about the holes, but
    // the fallback below needs its final rect.
    const mid = boardMidY();
    tutorialPanel.classList.toggle('card-top', cardSide(holes, mid) === 'top');
    tutorialPanel.classList.remove('compact');
    const card = tutorialCard.getBoundingClientRect();
    if (cardCoversHole({ x: card.x, y: card.y, w: card.width, h: card.height }, holes)) {
      tutorialPanel.classList.add('compact');
    }

    // The scrim only when there is something to spotlight: step 1 lights the
    // whole board, so it shows none.
    spotlightSvg.replaceChildren();
    if (holes.length === 0) {
      spotlightSvg.classList.remove('visible');
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    spotlightSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    spotlightSvg.append(svgNode('path', { d: scrimPath(W, H, holes) }, 'scrim'));
    for (const h of holes) {
      spotlightSvg.append(svgNode('rect', { x: h.x, y: h.y, width: h.w, height: h.h, rx: h.r }, `ring ${h.kind}`));
    }
    const tags = layoutTags(holes, 0);
    if (tags.length > 0) {
      const defs = svgNode('defs', {});
      const marker = svgNode('marker', {
        id: 'spotlight-arrow',
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: 'auto-start-reverse',
      });
      marker.append(svgNode('path', { d: 'M0,0L10,5L0,10z' }, 'arrow'));
      defs.append(marker);
      spotlightSvg.append(defs);
      for (const t of tags) {
        spotlightSvg.append(
          svgNode(
            'line',
            { x1: t.from.x, y1: t.from.y, x2: t.to.x, y2: t.to.y, 'marker-end': 'url(#spotlight-arrow)' },
            'leader',
          ),
        );
        spotlightSvg.append(svgNode('rect', { x: t.x, y: t.y, width: t.w, height: t.h, rx: t.h / 2 }, `pill ${t.kind}`));
        const text = svgNode('text', { x: t.x + t.w / 2, y: t.y + 16 }, 'pill-text');
        text.textContent = t.text;
        spotlightSvg.append(text);
      }
    }
    spotlightSvg.classList.add('visible');
  }

  /** Where a tile is, in the a11y layer's words: "row 3 column 7". */
  function whereIs(id: TileId): string {
    const { row, col } = slotPosition(game.board.get(id).slot);
    return `row ${row} column ${col}`;
  }

  /** Paint the current step and speak it. Step 2 rings a free and a blocked
   *  tile; step 3 rings one genuinely matchable pair and highlights it the
   *  way Hint does — no charge is spent, and both leave with the step. */
  function renderTutorialStep(): void {
    const step = tutorial.step;
    if (step === null) return;
    const n = tutorial.stepIndex + 1;
    tutorialStepEl.textContent = `Step ${n} of ${tutorial.stepCount}`;
    tutorialTitle.textContent = step.title;
    tutorialText.textContent = step.body;
    tutorialNext.textContent = tutorial.isLast ? 'Done' : 'Next';
    hintPair = [];
    pickSpotlightTiles();
    redraw();
    layoutSpotlight();
    // The scrim is visual only: the announcement names what it points at.
    let where = '';
    if (spotlightTiles.free !== undefined && spotlightTiles.blocked !== undefined) {
      where =
        ` ${label(spotlightTiles.free)} at ${whereIs(spotlightTiles.free)} is free;` +
        ` ${label(spotlightTiles.blocked)} at ${whereIs(spotlightTiles.blocked)} is blocked.`;
    } else if (step.actor === 'pair' && hintPair.length === 2) {
      where = ` Highlighted: ${describePair([hintPair[0]!, hintPair[1]!])}.`;
    }
    announcer.say(`Tutorial, step ${n} of ${tutorial.stepCount}. ${step.title}. ${step.body}${where}`);
  }

  /** Take the card down and hand the board back: highlight and scrim cleared,
   *  background live again, focus on the board's current tile. */
  function closeTutorialCard(): void {
    if (!tutorialVisible) return;
    tutorialVisible = false;
    tutorialPanel.classList.remove('visible', 'card-top', 'compact');
    spotlightSvg.classList.remove('visible');
    spotlightSvg.replaceChildren();
    spotlightTiles = {};
    spotlightHoles = [];
    hintPair = [];
    redraw();
    setBackgroundInert(false);
    a11y.focusActive();
  }

  function wireTutorial(): void {
    tutorialNext.addEventListener('click', () => {
      tutorial.next();
      if (tutorial.active) renderTutorialStep();
    });
    tutorialSkip.addEventListener('click', () => tutorial.skip());
  }

  // --- version + changelog (issue #81) ----------------------------------------

  /** Render the bundled CHANGELOG.md into the dialog: release headings become
   *  sub-headings, and each entry becomes its lead sentence as a list item
   *  (issue #181 — the full prose stays in the repo's CHANGELOG.md). */
  function fillChangelog(): void {
    changelogBody.textContent = '';
    let list: HTMLUListElement | null = null;
    for (const block of briefChangelog(changelogMd)) {
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
      const heading = document.createElement('h3');
      heading.textContent = block.text;
      changelogBody.append(heading);
    }
  }

  function openChangelog(): void {
    if (changelogVisible) return;
    // Opened from inside Settings: that panel steps aside rather than stacking.
    closeSettings();
    changelogVisible = true;
    changelogPanel.classList.add('visible');
    setBackgroundInert(true);
    // Focus goes to the heading, not the Done button at the end of the card
    // (issue #168) — landing focus there dragged the scrollable card down to
    // it, burying the newest release. preventScroll plus an explicit
    // scrollTop reset guarantee the top of the list is what's on screen,
    // on every open including a reopen.
    changelogCard.scrollTop = 0;
    changelogTitle.focus({ preventScroll: true });
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
        // The avatar is part of the synced profile (issue #138): publish it
        // now rather than letting it wait for the next win.
        syncAvatar();
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
    // One score, and it is this week's (issue #176). Read through
    // weekScoreNow so a record left over from last week shows 0 rather than a
    // number the board it is ranked on has already forgotten.
    el<HTMLElement>('record-week').textContent = String(weekScoreNow(record.value, Date.now()));
    // The streak as it stands today, not as it was last written: a missed
    // day has already ended it (issue #19).
    el<HTMLElement>('record-streak').textContent = String(liveStreak(record.value, dailyDateKey()));
    el<HTMLElement>('record-trophies').textContent = String(record.value.trophies);
    renderSyncSection();
    renderBoardSection();
  }

  /** Where focus goes back to when the profile closes: the control that
   *  opened it — the Settings gear (the Settings row's route) or the HUD's
   *  Level chip (issue #137). */
  let profileOpener: HTMLElement = settingsButton;

  function openProfile(opener: HTMLElement = settingsButton): void {
    if (profileVisible) return;
    profileOpener = opener;
    // Every open starts with the recovery code masked again (issue #138).
    syncCodeShown = false;
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
    const name = profile.setName(profileNameInput.value);
    profileNameInput.value = name;
    // Republished on every close, not only on a change: an earlier publish may
    // have failed offline, and this is the cheap place to catch up.
    void publishName(name);
    profileVisible = false;
    profilePanel.classList.remove('visible');
    setBackgroundInert(false);
    profileOpener.focus();
    // "Create profile" on the welcome gate opens this screen; a first install's
    // tutorial (issue #59) waits behind it too.
    startPendingTutorial();
  }

  // --- cloud sync (issue #138) -------------------------------------------------

  /** Null until the player turns sync on (or restores a profile with a code).
   *  Everything below is inert while it is null — that is the default, and the
   *  game never waits on any of it. */
  let syncCredentials: SyncCredentials | null = readCredentials(storage);
  /** One request at a time from the panel: the controls disable while a call
   *  is in flight, so a double tap cannot register twice. */
  let syncBusy = false;
  /** The recovery code is masked until the player asks for it, and masked
   *  again every time the panel is reopened — it is the whole credential, and
   *  a profile screen is the kind of screen people screenshot. */
  let syncCodeShown = false;

  /** What each failure means to the player. Every one of them ends the same
   *  way — the local profile is untouched and the game plays on — so the
   *  wording never suggests progress was lost. */
  const SYNC_FAILURE_TEXT: Readonly<Record<SyncFailure, string>> = {
    offline: 'No connection. Your progress is safe on this device — try again later.',
    unavailable: 'Sync is unavailable right now. Your progress is safe on this device.',
    unauthorized: "That code doesn't match a profile. Check it and try again.",
    name_rejected: "That name can't be shown to other players — pick another one.",
    rate_limited: 'Too many attempts. Try again in a few minutes.',
  };

  function setSyncStatus(text: string): void {
    syncStatus.textContent = text;
  }

  /** Show the on/off half of the section and reflect the busy state. */
  function renderSyncSection(): void {
    const on = syncCredentials !== null;
    syncOffBlock.hidden = on;
    syncOnBlock.hidden = !on;
    if (on) {
      syncRestoreForm.hidden = true;
      syncTag.textContent = formatPlayerTag(syncCredentials!.playerId);
      syncCodeValue.textContent = syncCodeShown
        ? syncCredentials!.code
        : '•'.repeat(syncCredentials!.code.length);
      syncRevealButton.textContent = syncCodeShown ? 'Hide code' : 'Show code';
      syncRevealButton.setAttribute('aria-pressed', String(syncCodeShown));
    }
    for (const control of [
      syncEnableButton,
      syncRestoreButton,
      syncRestoreConfirm,
      syncRevealButton,
      syncCopyButton,
      syncDisableButton,
    ]) {
      control.disabled = syncBusy;
    }
  }

  /** Run one sync call with the panel's controls disabled around it. */
  async function withSyncBusy<T>(work: () => Promise<T>): Promise<T> {
    syncBusy = true;
    renderSyncSection();
    try {
      return await work();
    } finally {
      syncBusy = false;
      renderSyncSection();
    }
  }

  /** Take the server's record without ever losing what this device holds —
   *  the same never-regress merge the server just applied. The name and
   *  avatar are *not* adopted here: a background sync must never overwrite a
   *  rename made on this device (only a restore does, below). */
  function adoptRemoteRecord(remote: RemoteProfile): void {
    record.adopt(mergeRecords(record.value, remote.record));
    if (profileVisible) syncProfileControls();
  }

  /** Push the record up after a win, if sync is on. Fire-and-forget by
   *  design: nothing in the win flow waits on the network, and a failure is
   *  simply the next sync's problem. */
  function syncAfterWin(): void {
    if (syncCredentials === null) return;
    void pushRecord(syncCredentials, {
      avatar: profile.value.avatar,
      record: record.value,
    }).then((result) => {
      if (result.ok) adoptRemoteRecord(result.value);
    });
  }

  /** Publish the avatar the player just picked. Same fire-and-forget shape as
   *  the post-win push — it rides the sync route, which carries the avatar. */
  function syncAvatar(): void {
    if (syncCredentials === null) return;
    void pushRecord(syncCredentials, {
      avatar: profile.value.avatar,
      record: record.value,
    }).then((result) => {
      if (result.ok) adoptRemoteRecord(result.value);
    });
  }

  /** Publish a name the player just committed. Only ever called from the
   *  profile panel, so a screening refusal has somewhere to be shown. */
  async function publishName(name: string): Promise<void> {
    if (syncCredentials === null) return;
    const result = await pushName(syncCredentials, name);
    if (!result.ok) {
      setSyncStatus(SYNC_FAILURE_TEXT[result.reason]);
      return;
    }
    setSyncStatus('');
  }

  syncEnableButton.addEventListener('click', () => {
    void withSyncBusy(async () => {
      setSyncStatus('Turning on sync…');
      const result = await registerProfile({
        name: profile.value.name,
        avatar: profile.value.avatar,
        record: record.value,
      });
      if (!result.ok) {
        setSyncStatus(SYNC_FAILURE_TEXT[result.reason]);
        return;
      }
      syncCredentials = result.value.credentials;
      writeCredentials(storage, syncCredentials);
      // Shown straight away this once: the player has to be able to write it
      // down, and this is the moment they are being told to.
      syncCodeShown = true;
      renderSyncSection();
      // The leaderboard opt-in is gated on sync being on, so it has to be
      // re-rendered here too — the panel is already open.
      renderBoardSection();
      setSyncStatus('Sync is on. Write your recovery code down — it is the only way back.');
      announcer.say('Sync is on. Your recovery code is shown in your profile.');
    });
  });

  syncRestoreButton.addEventListener('click', () => {
    syncRestoreForm.hidden = false;
    setSyncStatus('');
    syncCodeInput.value = '';
    syncCodeInput.focus();
  });

  syncRestoreCancel.addEventListener('click', () => {
    syncRestoreForm.hidden = true;
    setSyncStatus('');
    syncRestoreButton.focus();
  });

  syncRestoreConfirm.addEventListener('click', () => {
    void withSyncBusy(async () => {
      setSyncStatus('Looking up your profile…');
      // Canonicalize before anything else: the server would normalize a typed
      // code anyway, but this is the form the panel stores and shows from now
      // on, and a code that is not a code is worth saying so without a round
      // trip.
      const normalized = normalizeCode(syncCodeInput.value);
      if (normalized === null) {
        setSyncStatus("That doesn't look like a recovery code — check it and try again.");
        return;
      }
      const code = formatCode(normalized);
      const found = await fetchProfile(code);
      if (!found.ok) {
        setSyncStatus(SYNC_FAILURE_TEXT[found.reason]);
        return;
      }
      // A restore *is* the case where the server's identity wins: this device
      // is being told who it is. The record still merges rather than
      // overwrites, so progress made here before restoring is not thrown away.
      const remote = found.value;
      syncCredentials = { playerId: remote.playerId, code };
      writeCredentials(storage, syncCredentials);
      profileNameInput.value = profile.setName(remote.name);
      // A no-op if the server holds an avatar this build does not ship (the
      // server stores the id opaquely, so a newer build's pick can come back
      // here). Keeping the local one is the right fallback — there is nothing
      // to draw for an id we do not know.
      profile.setAvatar(remote.avatar);
      record.adopt(mergeRecords(record.value, remote.record));
      syncProfileControls();
      syncProfileRow();
      setSyncStatus(`Profile restored — welcome back, ${remote.name}.`);
      announcer.say(`Profile restored. Welcome back, ${remote.name}.`);
      // Send this device's side up so the server holds the merge too.
      const pushed = await pushRecord(syncCredentials, {
        avatar: profile.value.avatar,
        record: record.value,
      });
      if (pushed.ok) adoptRemoteRecord(pushed.value);
    });
  });

  syncRevealButton.addEventListener('click', () => {
    syncCodeShown = !syncCodeShown;
    renderSyncSection();
    announcer.say(syncCodeShown ? 'Recovery code shown.' : 'Recovery code hidden.');
  });

  syncCopyButton.addEventListener('click', () => {
    if (syncCredentials === null) return;
    const code = syncCredentials.code;
    // The code is also selectable in place (`user-select: all`), which is the
    // fallback when the clipboard is unavailable — so say that rather than
    // leaving the player with nothing.
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      setSyncStatus('Copying is unavailable here — select the code above to copy it.');
      return;
    }
    void clipboard
      .writeText(code)
      .then(() => setSyncStatus('Recovery code copied.'))
      .catch(() => setSyncStatus('Copying failed — select the code above to copy it.'));
  });

  syncDisableButton.addEventListener('click', () => {
    forgetCredentials(storage);
    syncCredentials = null;
    renderSyncSection();
    renderBoardSection();
    setSyncStatus('Sync is off here. Your profile is still saved — enter your code to reconnect.');
    announcer.say('Sync turned off on this device.');
    syncEnableButton.focus();
  });

  // --- Weekly leaderboard (issues #70, #176) -----------------------------------

  /** A second consent, separate from sync: syncing gives the profile a home,
   *  this puts the player's name in front of strangers. Off by default. */
  let boardOptIn = readOptIn(storage);
  let leaderboardVisible = false;
  /** Where focus returns to — the Settings route, or the win screen's own
   *  Leaderboard button. */
  let leaderboardOpener: HTMLElement = settingsButton;

  /** The same failures as sync, said in the leaderboard's own terms: the
   *  reassurance a failed profile sync needs ("your progress is safe on this
   *  device") is meaningless next to a board that would not load. */
  const BOARD_FAILURE_TEXT: Readonly<Record<SyncFailure, string>> = {
    offline: 'No connection — the leaderboard needs one. Your game is unaffected.',
    unavailable: 'The leaderboard is unavailable right now. Your game is unaffected.',
    unauthorized: 'Your profile could not be verified — check Cloud sync above.',
    name_rejected: "That name can't be shown to other players — pick another one.",
    rate_limited: 'Too many requests. Try again in a few minutes.',
  };

  function setBoardStatus(text: string): void {
    boardStatus.textContent = text;
  }

  /** The opt-in only means anything once there is a profile to attach an
   *  entry to, so it follows the sync state rather than standing alone. */
  function renderBoardSection(): void {
    const synced = syncCredentials !== null;
    boardOptInInput.checked = boardOptIn && synced;
    boardOptInInput.disabled = !synced;
    boardOptInHint.textContent = synced
      ? 'Your name and avatar appear next to your score for the week. Turning this off removes every score you have posted.'
      : 'Turn on Cloud sync first — a score on the board needs a profile to belong to.';
  }

  /** One row per entry, plus the break marker when the player's neighbourhood
   *  does not touch the top of the board. */
  function renderLeaderboard(board: WeeklyBoard): void {
    const rows = boardRows(board);
    leaderboardList.replaceChildren();
    leaderboardEmpty.hidden = rows.length > 0;
    for (const row of rows) {
      const li = document.createElement('li');
      if (row.kind === 'gap') {
        li.className = 'gap';
        li.textContent = '···';
        // A visual break carries no information for a screen reader, and
        // announcing it as a row would imply an entry that is not there.
        li.setAttribute('aria-hidden', 'true');
        leaderboardList.append(li);
        continue;
      }
      const { entry } = row;
      const mine = board.you !== null && entry.playerId === board.you.playerId;
      if (mine) li.className = 'you';
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = `${entry.rank}.`;
      const glyph = document.createElement('span');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = avatarGlyph(entry.avatar);
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = entry.name;
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = String(entry.score);
      // A weekly standing is a sum of runs, so there is no single elapsed time
      // to put here; how many clears went into it is the number that explains
      // the score next to it (issue #176).
      const runs = document.createElement('span');
      runs.className = 'time';
      runs.textContent = entry.runs === 1 ? '1 level' : `${entry.runs} levels`;
      // One label per row: a screen reader reading five loose spans in a list
      // gives no sense of a table.
      li.setAttribute(
        'aria-label',
        `${mine ? 'You, ' : ''}rank ${entry.rank}, ${entry.name}, ${entry.score} points from ${
          entry.runs === 1 ? '1 level' : `${entry.runs} levels`
        }`,
      );
      li.append(rank, glyph, who, score, runs);
      leaderboardList.append(li);
    }
    // The player's own rank is the reason they opened this, and on a phone a
    // full board puts it below the fold. Instant, not smooth: this is the
    // starting position of the list, not an animation.
    leaderboardList.querySelector('.you')?.scrollIntoView({ block: 'center' });
  }

  /** The ticking countdown by the heading, and the reload it triggers at zero
   *  (issue #176). Cleared whenever the panel closes: a timer that outlives
   *  the panel would keep waking a backgrounded tab to write to a hidden node. */
  let resetTicker: ReturnType<typeof setInterval> | null = null;
  /** The instant the open board resets, from the server. Null when no board is
   *  loaded — the countdown has nothing to count to until one arrives. */
  let boardResetsAt: number | null = null;
  /** The week the open board is for. The rollover reload compares against it:
   *  a reload that comes back on the *same* week has not rolled over yet. */
  let boardWeekStart: string | null = null;
  /** Bumped on every open and every load. A response whose generation is stale
   *  belongs to a panel that has since been closed or reloaded, and must not
   *  render or start a ticker — otherwise a close-and-reopen during an
   *  in-flight fetch leaves two tickers, and `stopResetTicker` then clears the
   *  live one while the orphan keeps painting. */
  let loadGeneration = 0;
  /** Retries of the rollover reload, so a client clock that runs ahead of the
   *  server cannot spin `loadBoard` as fast as the network allows. */
  let rolloverRetries = 0;
  const MAX_ROLLOVER_RETRIES = 10;
  const ROLLOVER_RETRY_MS = 2000;
  let rolloverTimer: ReturnType<typeof setTimeout> | null = null;

  function stopResetTicker(): void {
    if (resetTicker !== null) {
      clearInterval(resetTicker);
      resetTicker = null;
    }
    if (rolloverTimer !== null) {
      clearTimeout(rolloverTimer);
      rolloverTimer = null;
    }
  }

  /** Paint the countdown once. Returns false when the week is over, which is
   *  the caller's cue to reload rather than keep counting. */
  function paintCountdown(): boolean {
    if (boardResetsAt === null) return true;
    const left = boardResetsAt - Date.now();
    if (left <= 0) return false;
    leaderboardResetLine.textContent = `Resets in ${formatResetCountdown(left)}`;
    return true;
  }

  function closeLeaderboard(): void {
    if (!leaderboardVisible) return;
    leaderboardVisible = false;
    loadGeneration += 1;
    stopResetTicker();
    boardResetsAt = null;
    boardWeekStart = null;
    rolloverRetries = 0;
    leaderboardPanel.classList.remove('visible');
    setBackgroundInert(overlayVisible);
    leaderboardOpener.focus();
  }

  async function openLeaderboard(opener: HTMLElement): Promise<void> {
    if (leaderboardVisible) return;
    leaderboardOpener = opener;
    leaderboardVisible = true;
    rolloverRetries = 0;
    leaderboardPanel.classList.add('visible');
    setBackgroundInert(true);
    leaderboardClose.focus();
    await loadBoard(true);
  }

  /**
   * Fetch and render the live week. `announce` is false on the reload that
   * follows a rollover: the panel is already open and the player is already
   * looking at it, so it re-reads only the new state, not the whole board.
   */
  async function loadBoard(announce: boolean): Promise<void> {
    const generation = (loadGeneration += 1);
    stopResetTicker();
    boardResetsAt = null;
    leaderboardResetLine.textContent = '';
    leaderboardList.replaceChildren();
    leaderboardEmpty.hidden = true;
    leaderboardStatus.textContent = 'Loading the board…';
    if (announce) announcer.say('Weekly leaderboard.');
    // Reading a board needs no profile — an entry does. A player with sync
    // off still sees the top of the board, just not a rank of their own.
    const result = await fetchWeeklyBoard(syncCredentials);
    // Stale response: the panel was closed, or reloaded, while this was in
    // flight. Checking the generation rather than only `leaderboardVisible`
    // matters because close-then-reopen makes that flag true again — this
    // response would then render over the newer one and start a second ticker
    // whose handle immediately overwrites the live one.
    if (!leaderboardVisible || generation !== loadGeneration) return;
    if (!result.ok) {
      leaderboardStatus.textContent = BOARD_FAILURE_TEXT[result.reason];
      return;
    }
    leaderboardStatus.textContent =
      result.value.you === null && boardOptIn
        ? 'Clear a level to take a place on this board.'
        : '';
    renderLeaderboard(result.value);

    // The countdown runs off the server's boundary, not a locally computed
    // one, so every player watches the same instant tick down.
    const expiredWeek = boardWeekStart;
    boardResetsAt = result.value.resetsAt;
    boardWeekStart = result.value.weekStart;
    if (!paintCountdown()) {
      // Already expired on arrival. This is normal for a second or two around
      // the boundary — the device's clock crosses before the server's, and the
      // round trip adds to it — so retry on a timer instead of re-entering
      // immediately. Re-entering would spin as fast as the network allows and
      // burn the signed-read allowance in ten requests, breaking the panel for
      // ten minutes at exactly the moment this feature exists to serve.
      scheduleRolloverRetry(expiredWeek);
      return;
    }
    rolloverRetries = 0;
    // Said once, with the board. The line itself is not aria-live: announcing
    // every tick would talk over the entries the player opened this to read.
    announcer.say(
      `Weekly leaderboard. Resets in ${speakResetCountdown(boardResetsAt - Date.now())}.`,
    );
    resetTicker = setInterval(() => {
      if (!leaderboardVisible || generation !== loadGeneration) {
        stopResetTicker();
        return;
      }
      // Reaching zero with the panel open reloads it into the fresh, empty
      // week rather than leaving stale standings on screen.
      if (!paintCountdown()) {
        stopResetTicker();
        void loadBoard(false);
      }
    }, 1000);
  }

  /**
   * Re-fetch after the countdown has run out, on a delay and a bounded number
   * of times.
   *
   * The server decides when the week turns over, so a client whose clock runs
   * ahead can reach zero while the server is still serving the old week. The
   * board that comes back then carries the *same* `weekStart`, which is the
   * signal to wait rather than to keep asking. A device minutes fast would
   * otherwise loop on every open.
   */
  function scheduleRolloverRetry(expiredWeek: string | null): void {
    const sameWeek = expiredWeek !== null && expiredWeek === boardWeekStart;
    if (sameWeek && rolloverRetries >= MAX_ROLLOVER_RETRIES) {
      // Given up: the clock difference is bigger than a rollover lag, so show
      // the board that exists rather than a countdown that cannot finish.
      leaderboardResetLine.textContent = 'Resetting…';
      return;
    }
    rolloverRetries = sameWeek ? rolloverRetries + 1 : 0;
    leaderboardResetLine.textContent = 'Resetting…';
    rolloverTimer = setTimeout(() => {
      rolloverTimer = null;
      if (!leaderboardVisible) return;
      void loadBoard(false);
    }, ROLLOVER_RETRY_MS);
  }

  /** Post a finished ladder level, if the player asked to be on the board.
   *  Silent and fire-and-forget like the profile push: the win screen never
   *  waits on the network, and a failed post is the next level's problem.
   *
   *  No week goes with it — the server decides which one the run lands in,
   *  from the moment it arrives, so a device with a wrong clock cannot post
   *  into a week that is not open.
   *
   *  The move history goes with it, and since issue #187 (decision 0030) it
   *  is what the server scores: the deal is regenerated from layout and seed,
   *  the moves are replayed, and `score` is only checked against the result.
   *  A run whose history does not replay is refused and never reaches the
   *  board — silently, like every other failed post here. The history is the
   *  *whole* deal — layout, seed, and the move records with the shuffle seeds
   *  and undo returns the stack keeps — so a replay has everything the client
   *  knows. `shuffles` stays for the row's own record; the replay reads the
   *  shuffle moves, not the count. */
  function submitRunResult(score: number, elapsedMs: number): void {
    if (syncCredentials === null || !boardOptIn) return;
    void submitRunScore(syncCredentials, {
      score,
      // The game clock is `performance.now()`-based and fractional; the
      // server takes whole milliseconds and refuses anything else (found
      // while wiring #187 — every post since #176 had been failing on this).
      // Ceiling, not rounding, so the run never claims to have ended before
      // its own last move, which the server now checks.
      elapsedMs: Math.ceil(elapsedMs),
      history: {
        layoutId: game.level.layoutId,
        seed: game.level.seed,
        shuffles: shuffleCount,
        moves: compactHistory(game.snapshot().stack.moves as unknown as Record<string, unknown>[]),
      },
    });
  }

  boardOptInInput.addEventListener('change', () => {
    boardOptIn = boardOptInInput.checked;
    writeOptIn(storage, boardOptIn);
    if (boardOptIn) {
      setBoardStatus('You will appear on the board next time you clear a level.');
      announcer.say('Leaderboard on.');
      return;
    }
    announcer.say('Leaderboard off.');
    // Off means removed, not hidden — anything less would be a lie about what
    // the checkbox does.
    if (syncCredentials === null) {
      setBoardStatus('');
      return;
    }
    setBoardStatus('Removing your scores…');
    void withdrawFromBoard(syncCredentials).then((result) => {
      setBoardStatus(
        result.ok
          ? 'Your scores have been removed from the leaderboard.'
          : BOARD_FAILURE_TEXT[result.reason],
      );
    });
  });

  boardOpenButton.addEventListener('click', () => {
    void openLeaderboard(boardOpenButton);
  });

  leaderboardButton.addEventListener('click', () => {
    // There is one board and one live week, so there is nothing to choose:
    // since issue #176 this is the only route in.
    void openLeaderboard(leaderboardButton);
  });

  leaderboardClose.addEventListener('click', closeLeaderboard);

  dailyPanelClose.addEventListener('click', closeDailyPanel);

  // --- feedback form (issue #118) ----------------------------------------------

  /** The current level string sent as feedback context: the ladder level —
   *  never the profile name (no player-identifying data beyond what the
   *  player typed). */
  function currentLevelLabel(): string {
    return `Level ${progress.level}`;
  }

  /** Send is enabled once both fields have content, and only when nothing is
   *  already in flight (issue #118: no double-submit on a slow request). */
  function updateFeedbackSendEnabled(): void {
    feedbackSend.disabled =
      feedbackSending ||
      feedbackPicking ||
      !canSendFeedback(feedbackSummaryInput.value, feedbackBodyInput.value);
  }

  /** Clear the status line and hide the mailto fallback — the start of every
   *  open and every fresh submit attempt. */
  function resetFeedbackStatus(): void {
    feedbackStatus.textContent = '';
    feedbackStatus.className = '';
    feedbackMailto.hidden = true;
    feedbackMailtoNote.hidden = true;
    feedbackInbox.hidden = true;
    feedbackCopy.hidden = true;
    feedbackCopyStatus.textContent = '';
    feedbackReportLabel.hidden = true;
    feedbackReport.hidden = true;
    feedbackReport.value = '';
    feedbackReportText = null;
    feedbackAttachStatus.textContent = '';
  }

  /** Copy report (issue #135): the subject line plus the full email text, for
   *  a player whose mail handler silently does nothing. When the clipboard is
   *  missing or refuses, the same text is shown selected in a read-only field
   *  so it can still be copied by hand — never a "Copied" that didn't happen. */
  async function copyFeedbackReport(): Promise<void> {
    if (feedbackReportText === null) return;
    const text = feedbackReportText;
    const copied = await copyText(text, navigator.clipboard);
    if (copied) {
      feedbackCopyStatus.textContent = 'Copied';
      announcer.say('Copied.');
      return;
    }
    feedbackCopyStatus.textContent = "Couldn't copy — select the text below";
    feedbackReport.value = text;
    feedbackReportLabel.hidden = false;
    feedbackReport.hidden = false;
    feedbackReport.focus();
    // select() alone is unreliable on iOS WebKit; the explicit range is the
    // belt-and-braces version of the same thing.
    feedbackReport.select();
    feedbackReport.setSelectionRange(0, text.length);
    announcer.say("Couldn't copy. The report text is selected below.");
  }

  // --- attachments (issue #130) ------------------------------------------------

  /** Re-encode an image through a canvas so EXIF/location metadata never
   *  leaves the device — the pixels are redrawn, nothing else is carried over.
   *  `imageOrientation: 'from-image'` bakes the EXIF rotation into the pixels
   *  first, so the upright photo survives losing its orientation tag. PNG
   *  stays PNG (screenshots keep crisp UI text); everything else — JPEG, WebP,
   *  HEIC — becomes JPEG, which is also what makes HEIC deliverable to any
   *  mail client. Very large photos are scaled to fit 4096 px on the long
   *  edge: well under every browser's canvas limit and plenty for a bug. */
  async function stripImageMetadata(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
      if (blob === null) throw new Error('encode failed');
      return blob;
    } finally {
      bitmap.close();
    }
  }

  function setAttachStatus(message: string): void {
    feedbackAttachStatus.textContent = message;
    if (message !== '') announcer.say(message);
  }

  function updateAttachButton(): void {
    feedbackAttachButton.disabled =
      feedbackSending || feedbackPicking || feedbackAttachments.length >= MAX_ATTACHMENTS;
  }

  /** Rebuild the thumbnail strip from the list: one <li> per file with its
   *  preview, name, and a named Remove control (≥ 48dp, spec §7). */
  function renderAttachments(): void {
    feedbackAttachmentList.replaceChildren();
    for (const item of feedbackAttachments) {
      const li = document.createElement('li');
      const preview =
        item.kind === 'image'
          ? Object.assign(document.createElement('img'), { src: item.previewUrl, alt: '' })
          : Object.assign(document.createElement('video'), {
              src: item.previewUrl,
              muted: true,
              playsInline: true,
              preload: 'metadata',
            });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.setAttribute('aria-label', `Remove ${item.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => removeAttachment(item.id));
      li.append(preview, name, remove);
      feedbackAttachmentList.append(li);
    }
    feedbackAttachmentList.hidden = feedbackAttachments.length === 0;
    updateAttachButton();
  }

  function removeAttachment(id: number): void {
    const item = feedbackAttachments.find((a) => a.id === id);
    if (item === undefined) return;
    URL.revokeObjectURL(item.previewUrl);
    feedbackAttachments = feedbackAttachments.filter((a) => a.id !== id);
    renderAttachments();
    announcer.say(`Removed ${item.name}.`);
    feedbackAttachButton.focus();
  }

  function clearAttachments(): void {
    for (const item of feedbackAttachments) URL.revokeObjectURL(item.previewUrl);
    feedbackAttachments = [];
    renderAttachments();
  }

  /** The picker returned: check each file against the caps (issue #130 — an
   *  over-limit file is refused with a short message, the rest of the form
   *  is untouched), strip image metadata, and add what survives. */
  async function addPickedFiles(files: readonly File[]): Promise<void> {
    if (feedbackPicking) return;
    feedbackPicking = true;
    updateAttachButton();
    updateFeedbackSendEnabled();
    try {
      await addPickedFilesInner(files);
    } finally {
      feedbackPicking = false;
      renderAttachments();
      updateFeedbackSendEnabled();
    }
  }

  async function addPickedFilesInner(files: readonly File[]): Promise<void> {
    setAttachStatus('');
    for (const file of files) {
      // Cheap check on the picked file first, so a huge file is refused
      // before anything tries to decode it.
      const pre = checkAttachment(feedbackAttachments, file);
      if (!pre.ok) {
        setAttachStatus(refusalMessage(pre.reason));
        continue;
      }
      let blob: Blob = file;
      let name = file.name;
      let type = file.type;
      if (pre.kind === 'image') {
        try {
          blob = await stripImageMetadata(file);
        } catch {
          setAttachStatus(`Couldn't read ${file.name}`);
          continue;
        }
        type = blob.type;
        name = reencodedName(file.name, type);
      }
      // The re-encoded size is the one that ships — check it again.
      const post = checkAttachment(feedbackAttachments, { name, type, size: blob.size });
      if (!post.ok) {
        setAttachStatus(refusalMessage(post.reason));
        continue;
      }
      feedbackAttachments = [
        ...feedbackAttachments,
        {
          id: nextAttachmentId++,
          name,
          type,
          kind: post.kind,
          blob,
          size: blob.size,
          previewUrl: URL.createObjectURL(blob),
        },
      ];
      announcer.say(`Attached ${name}.`);
    }
  }

  function clearFeedbackCloseTimer(): void {
    if (feedbackCloseTimer !== null) {
      clearTimeout(feedbackCloseTimer);
      feedbackCloseTimer = null;
    }
  }

  function openFeedback(): void {
    if (feedbackVisible) return;
    clearFeedbackCloseTimer();
    // Opened from inside Settings: that panel steps aside rather than stacking.
    closeSettings();
    resetFeedbackStatus();
    updateFeedbackSendEnabled();
    feedbackVisible = true;
    feedbackPanel.classList.add('visible');
    setBackgroundInert(true);
    feedbackSummaryInput.focus();
    announcer.say('Send feedback.');
  }

  /** Fields are deliberately left as they are on close — Cancel/Escape keeps
   *  whatever the player typed for the rest of the session (issue #118); only
   *  a successful send clears them. */
  function closeFeedback(): void {
    if (!feedbackVisible) return;
    clearFeedbackCloseTimer();
    feedbackVisible = false;
    feedbackPanel.classList.remove('visible');
    setBackgroundInert(false);
    settingsButton.focus();
  }

  /** POST to the Worker endpoint (worker/index.mjs); on failure — network
   *  error or non-2xx — offer the mailto fallback so the feedback is never
   *  lost, with the typed text kept in the fields either way. */
  async function submitFeedback(): Promise<void> {
    if (feedbackSend.disabled) return;
    feedbackSending = true;
    updateFeedbackSendEnabled();
    updateAttachButton();
    resetFeedbackStatus();
    const payload = buildFeedbackPayload({
      summary: feedbackSummaryInput.value,
      body: feedbackBodyInput.value,
      version: versionLabel(__APP_VERSION__, __BUILD_COMMIT__, __BUILD_TIME__),
      level: currentLevelLabel(),
      ua: navigator.userAgent,
      date: new Date().toISOString(),
      attachments: await encodeAttachments(feedbackAttachments),
    });
    const result = await sendFeedback(payload, (input, init) => fetch(input, init));
    feedbackSending = false;
    updateAttachButton();
    if (result === 'sent') {
      feedbackStatus.textContent = 'Thanks, your feedback was sent';
      feedbackStatus.className = 'success';
      announcer.say('Thanks, your feedback was sent.');
      feedbackSummaryInput.value = '';
      feedbackBodyInput.value = '';
      clearAttachments();
      updateFeedbackSendEnabled();
      // Leave the confirmation up for a beat before closing, so it is
      // perceivable rather than an instant swap back to Settings.
      feedbackCloseTimer = setTimeout(() => {
        feedbackCloseTimer = null;
        closeFeedback();
      }, 1000);
    } else {
      feedbackStatus.textContent = "Couldn't send, try again";
      feedbackStatus.className = 'error';
      announcer.say("Couldn't send. Try again, or email it instead.");
      feedbackMailto.href = mailtoUrl(
        FEEDBACK_INBOX,
        feedbackSubject(payload.summary),
        feedbackText(payload),
      );
      feedbackMailto.hidden = false;
      // Issue #135: the mailto handoff can be a silent no-op, so the address
      // is also shown as text and the report can be copied instead.
      feedbackInbox.hidden = false;
      feedbackCopy.hidden = false;
      feedbackReportText = reportText(feedbackSubject(payload.summary), feedbackText(payload));
      // A mailto: link cannot carry files (issue #130): the attachments stay
      // in the form, and the player is told to add them to the email.
      feedbackMailtoNote.hidden = feedbackAttachments.length === 0;
      updateFeedbackSendEnabled();
    }
  }

  function wireFeedback(): void {
    feedbackButton.addEventListener('click', () => openFeedback());
    feedbackCancel.addEventListener('click', () => closeFeedback());
    feedbackSend.addEventListener('click', () => void submitFeedback());
    // Issue #135: the inbox address is filled from the one constant so the
    // markup never carries a second copy of it.
    feedbackInboxAddress.textContent = FEEDBACK_INBOX;
    feedbackCopy.addEventListener('click', () => void copyFeedbackReport());
    // Attachments (issue #130): the visible button opens the (hidden) native
    // picker; the input is reset after each pick so choosing the same file
    // again still fires `change`.
    feedbackFileInput.accept = ATTACHMENT_ACCEPT;
    feedbackAttachButton.addEventListener('click', () => feedbackFileInput.click());
    feedbackFileInput.addEventListener('change', () => {
      const files = Array.from(feedbackFileInput.files ?? []);
      feedbackFileInput.value = '';
      void addPickedFiles(files);
    });
    feedbackSummaryInput.addEventListener('input', () => updateFeedbackSendEnabled());
    feedbackBodyInput.addEventListener('input', () => updateFeedbackSendEnabled());
    // Tapping the dimmed backdrop dismisses the panel, same as Settings
    // (issue #107) — text is kept, same as Cancel.
    feedbackPanel.addEventListener('click', (ev) => {
      if (ev.target === feedbackPanel) closeFeedback();
    });
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
      // A first install's tutorial (issue #59) waited behind the gate.
      startPendingTutorial();
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
    // Every stop the thumb lands on applies at once (issue #139) — by drag,
    // tap on the track, or arrow key. The slider announces its own
    // aria-valuetext, so no live-region line on top of it.
    sizeSlider.addEventListener('input', () => {
      const size: TileSize = TILE_SIZES[Number(sizeSlider.value)] ?? DEFAULT_SETTINGS.tileSize;
      if (!settings.set('tileSize', size)) return;
      syncSizeSlider();
      applyTileSize();
    });
    el<HTMLButtonElement>('settings-close').addEventListener('click', () => closeSettings());
    // Tapping the dimmed backdrop dismisses the panel (issue #107). Settings
    // persist per change, so dismissal loses nothing; the target check keeps
    // taps on the card itself from closing it.
    settingsPanel.addEventListener('click', (ev) => {
      if (ev.target === settingsPanel) closeSettings();
    });
    settingsButton.addEventListener('click', () => openSettings());
    // What's new should close on a backdrop tap same as every other dialog
    // (issue #168) — the target check keeps taps on the card itself from
    // closing it.
    changelogPanel.addEventListener('click', (ev) => {
      if (ev.target === changelogPanel) closeChangelog();
    });
    // The HUD's Daily chip (issue #183) opens today's challenges in one tap.
    dailyButton.addEventListener('click', () => openDailyPanel());
    // The Level chip opens the profile (issue #137); focus comes back to it.
    levelButton.addEventListener('click', () => openProfile(levelButton));
    // Escape is the expected way out of a modal, and the only one for a
    // keyboard player who tabbed past the Done button. Listened for on the
    // document, not the panel: clicking the card's own text blurs focus to
    // <body>, and a panel-scoped handler would never see the key.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      // Topmost first, and only one: the leaderboard (issue #70) opens *over*
      // the profile and over the win screen, so a flat list of ifs would
      // close the panel underneath it in the same keystroke.
      // The tutorial card (issue #59) is only ever up over the bare board —
      // every other panel is guarded against it — so Escape there is Skip.
      if (tutorialVisible) tutorial.skip();
      else if (leaderboardVisible) closeLeaderboard();
      else if (feedbackVisible) closeFeedback();
      else if (changelogVisible) closeChangelog();
      else if (dailyPanelVisible) closeDailyPanel();
      else if (profileVisible) closeProfile();
      else if (settingsVisible) closeSettings();
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
        // `a` is always the held half (issue #93; the board-side peek-pair of
        // #124 is gone since #165). Naming the pair by `a` never leaks a
        // hidden face: `b` may have been face-down, but its face is `a`'s.
        announcer.say(
          `${label(outcome.a)} pair matched in the holder. ${game.tilesLeft} tiles left. Score ${game.score}.${takeDailyPayout()}`,
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
        const move = game.undo(elapsed.ms);
        if (move === null) return { ok: false, message: 'Nothing to undo — the holder is empty.' };
        hintPair = [];
        return { ok: true, message: `Undo: ${describeUndo(move)}` };
      }
      case 'shuffle': {
        // Deterministic per (level seed, shuffle index) so a replay of the same
        // deal reproduces the same shuffled boards. The seed also goes into the
        // move history (issue #187), which is what the server replays from.
        const shuffleSeed = (game.level.seed + 0x9e3779b1 * (shuffleCount + 1)) >>> 0;
        if (!game.shuffle(shuffleSeed, elapsed.ms)) {
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
      // Issue #183: a charged hint or shuffle starts the clean run again.
      // Undo does not — it undoes a hold, never a match.
      if (kind === 'hint' || kind === 'shuffle') dailyProgress.onAssist(dailyDateKey());
      if (dailyPanelVisible) renderDailyPanel();
    }
    // A rescue attempt (Undo/Shuffle) that leaves the board still 'stuck'
    // (issue #122 follow-up): the "No moves left" dialog stays open, so the
    // full end-of-level teardown (which would drop the grey wash and reveal
    // the board back in full colour underneath it) must not run. Only the
    // pulses are dropped — the near-pairs they pointed at may no longer be
    // accurate — and the instant wash is reapplied below; redraw() itself
    // restores the grey-out under an open stuck dialog (issue #159).
    const stillStuck = fromDialog && (kind === 'undo' || kind === 'shuffle') && game.status() === 'stuck';
    // Undo puts a parked tile back on the board and Shuffle repaints every
    // face: a copy still flying from the old board would paint over the new
    // one (issue #44).
    if (result.ok && (kind === 'undo' || kind === 'shuffle')) {
      trayFx.clear();
      // cancelEndCelebration() already calls animator.clear(); a direct call
      // here too would be redundant. The still-stuck branch skips
      // cancelEndCelebration (it would drop the wash), so it clears the
      // animator itself.
      if (stillStuck) animator.clear();
      else cancelEndCelebration();
    }
    redraw();
    if (result.ok) persist();
    if (stillStuck) {
      // No cue, no re-announcement: the dialog never closed, this only
      // restores the wash the rescue's teardown dropped. wash() replaces
      // its own node rather than stacking, so this does not re-fade
      // anything — it lands straight on the same final opacity.
      const reduced = settings.value.reducedMotion || prefersReducedMotion();
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
    const shownBefore = shownConcealed();
    finishTap(game.tap(hit, elapsed.ms), shownBefore);
  }

  /** Everything a resolved tap owes the player: feedback, save, announcement. */
  function finishTap(
    outcome: TapOutcome,
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
      // Issue #183: the pair may finish one of today's challenges. `a` is the
      // held half and both halves share a face, so either reads the suit.
      payDailyChallenges(
        dailyProgress.onMatch(dailyDateKey(), faceSuit(game.board.get(outcome.a).face)),
      );
      // Sound answers the tap; the haptic waits for the pair clear (the same
      // split issue #44 used for the collision).
      feedback.sound('match');
      // `a` is always a held tile (issue #93; issue #165 retired the
      // board-side peek-pair), so the slot it left is where the pair shows.
      // `outcome.slot` (issue #169), not a before/after holder diff: a
      // peek-match gives `a` that slot in this same tap, so it never shows up
      // in a snapshot taken before the tap landed.
      const slotNode = holder.slotNode(outcome.slot);
      if (slotNode) {
        // Issue #165: a face-down tile tapped from memory flips in flight —
        // the board never showed its face, so the copy starts as the back
        // and turns over on the way to the slot.
        const pictures = { incoming: tilePicture(outcome.b), parked: tilePicture(outcome.a) };
        trayFx.pairClear(
          outcome.revealed ? { ...pictures, incomingBack: renderer.tileBackImage() } : pictures,
          tileFlightBox(outcome.b),
          slotNode,
          outcome.score.points,
          () => feedback.haptic('match'),
        );
      }
    } else if (outcome.kind === 'held') {
      // A park that fills the last slot ends the level right here (decision
      // 0009) — game.status() is computed live off the board, so it already
      // reads 'lost' the moment game.tap() returned outcome. That park gets
      // the slam instead of the ordinary flight, and no 'select' cue: the
      // 'fail' cue and everything after it is presentLossCelebration's job,
      // fired from showStatus below (issue #121).
      const lost = game.status() === 'lost';
      const slotNode = holder.slotNode(outcome.slot);
      if (slotNode) {
        const box = tileFlightBox(outcome.id);
        const picture = tilePicture(outcome.id);
        if (lost) trayFx.slamToSlot(picture, box, slotNode, () => {});
        else trayFx.flyToSlot(picture, box, slotNode, () => {});
      }
      if (!lost) feedback.cue(tapCue(outcome)!);
    } else {
      const cue = tapCue(outcome);
      if (cue) feedback.cue(cue);
    }
    redraw();
    // Spec §7: auto-save on every move. A tap that changed nothing (a miss, a
    // buried tile) has nothing to save.
    // A refused park (issue #43 rule 5) changed nothing either, and a peek is
    // deliberately not saved (issue #64): a reload re-conceals.
    if (!['none', 'blocked', 'holder-full', 'peeked'].includes(outcome.kind)) {
      persist();
    }
    // A level-ending move is announced once, by showStatus: two live-region
    // writes in the same tick coalesce and the first is never spoken.
    if (game.status() === 'playing') announce(outcome);
    showStatus();
    // A level-ending tap skips `announce`, and showStatus has already written
    // the live region; a payout still waiting goes out on its own beat rather
    // than coalescing with that line and being lost.
    if (pendingDailyPayout !== '') {
      const payout = takeDailyPayout().trim();
      window.setTimeout(() => announcer.say(payout), 1200);
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
        ? `Level ${progress.level} restarted. ${game.tilesLeft} tiles.`
        : `New game dealt. Level ${progress.level}${milestoneNote()}. ${game.tilesLeft} tiles.`,
    );
    startTutorialIfArmed();
  }

  /** ", a milestone level" on a decade spike (issue #67) — the spoken half
   *  of the palette swap — and nothing otherwise. */
  function milestoneNote(): string {
    return bandForLevel(progress.level).spike ? ', a milestone level' : '';
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
    cancelEndCelebration();
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

  /** The toggle arms the tutorial for the next level start (issue #59) — ON
   *  for a fresh install, or turned back on in Settings for a refresher. Called
   *  by the deal paths *after* their own announcement, so the step-1 line is
   *  the last thing written to the live region, not the one overwritten. */
  function startTutorialIfArmed(): void {
    if (settings.value.showTutorial) startTutorial();
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
  // Not only when the edge moved (issue #125): a size-only change can leave
  // the canvas and #board disagreeing too — see settleBoardFit.
  window.addEventListener('resize', () => {
    settleBoardFit();
    // The tiles have moved; the tutorial's rings and tags follow them (#150).
    layoutSpotlight();
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
  wireFeedback();
  wireWelcome();
  wireTutorial();
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
      // Not cancelEndCelebration(): a pending end-of-level dialog (win or
      // loss) must still open when the player comes back (a hidden setTimeout
      // keeps running, just possibly throttled), so only the decorative
      // pieces — the lanterns/confetti, and the loss's own shake/wash, which
      // would otherwise sit frozen mid-flight like the tray flights above —
      // are dropped here (issue #120 / #121). The holder's red border is left
      // alone: it is a static class, not an animation, so there is nothing
      // frozen about it.
      winFx.clear();
      lossFx.clear();
      persist();
    } else {
      elapsed.resume();
      // Issue #166: the Daily's lock (and its pending/streak wording) keys
      // off the local calendar date — a page left open across midnight, or
      // reopened the next day, must not keep showing yesterday's chip until
      // the next move re-draws the board.
      syncDailyChip();
    }
  });
  window.addEventListener('focus', () => syncDailyChip());
  window.addEventListener('pagehide', () => {
    persist();
  });

  // Pixi sized itself to #board during init, before any placement existed, so
  // the canvas has to be re-read once there is one — this is also the call that
  // reveals #app (see the `:not([data-hud])` rule in index.html).
  settleBoardFit();
  if (resumed !== null) {
    announcer.say(`Game resumed. ${game.tilesLeft} tiles left. Score ${game.score}.`);
    // A deadlocked or lost board can be resumed (see persist): re-offer the
    // way out. `fromResume` skips the loss theatre (issue #121) — the fight
    // already happened before this load, so only its result is shown.
    showStatus({ fromResume: true });
  } else {
    persist(); // a fresh deal is savable from its first frame
  }

  // Never asked who's playing (issue #105): ask now, over the dealt board.
  // The stored answer — named or guest — means this shows at most once.
  if (profile.value.choice === null) openWelcome();

  // First-run tutorial (issue #59): on a fresh deal only — resuming a saved
  // game never starts it. Behind the welcome gate it waits until that closes.
  if (resumed === null && settings.value.showTutorial) startTutorial();

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
    /** Today's challenge standing (issue #183 QA). */
    get dailyStanding() {
      return dailyProgress.standing(dailyDateKey());
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
      return (
        animator.busy || trayFx.busy || winFx.busy || lossFx.busy || pendingDialogTimer !== null
      );
    },
    /** The effective reduced-motion decision, OS preference included. */
    reducedMotion(): boolean {
      return settings.value.reducedMotion || prefersReducedMotion();
    },
    /** Tutorial card state (issue #59 QA): shown, and which step (1-based). */
    tutorial(): { visible: boolean; step: number; count: number } {
      return { visible: tutorialVisible, step: tutorial.stepIndex + 1, count: tutorial.stepCount };
    },
    /** Spotlight state (issue #150 QA): the chosen tiles and the holes as
     *  drawn, page CSS px. */
    spotlight(): {
      tiles: { free?: TileId; blocked?: TileId; pair?: readonly TileId[] };
      holes: readonly Hole[];
      visible: boolean;
    } {
      return { tiles: spotlightTiles, holes: spotlightHoles, visible: spotlightSvg.classList.contains('visible') };
    },
  };
}

start().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = `Failed to start: ${String(err)}`;
});
