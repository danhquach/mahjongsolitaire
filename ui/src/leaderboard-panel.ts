// The weekly leaderboard's browser wiring (issues #70, #176), moved out of
// main.ts by issue #244: the panel and its countdown, the opt-in row in the
// profile, and the post that follows a cleared level. Its elements, its state,
// its listeners and its Panel declaration live here; main.ts says where in
// the stack it sits and what it may reach — the announcer, the opt-in's
// storage, whether the player is synced, and the deal a finished run is
// scored against.
//
// Two routes in — the booster rail's button and the profile's "Open" — and
// it is the one panel allowed over the end-of-level dialog (issue #174), so
// a win screen's Leaderboard button works. The panel spec's `overBase` says
// that; the stack does the rest.
//
// The pure parts — the wire calls, the row layout with its gap marker, the
// countdown copy, the opt-in's storage — stay in leaderboard.ts, where their
// tests are.

import type { Announcer } from './a11y.js';
import { el } from './dom.js';
import { applyFrame } from './frames.js';
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
import type { PanelStack } from './panel.js';
import { avatarGlyph } from './profile.js';
import type { KeyValueStorage } from './storage.js';
import type { SyncCredentials, SyncFailure } from './sync.js';

/** The deal a finished run is scored against (decision 0030): everything the
 *  server needs to regenerate it and replay the moves. */
export interface RunDeal {
  readonly layoutId: string;
  readonly seed: number;
  readonly shuffles: number;
  /** The stack's move records, shuffle seeds and undo returns included. */
  readonly moves: readonly Record<string, unknown>[];
}

/** What the leaderboard is allowed to reach outside itself. */
export interface LeaderboardPanelDeps {
  /** The stack it registers with; the call's position is its stacking order. */
  readonly panels: PanelStack;
  readonly storage: KeyValueStorage | undefined;
  readonly announcer: Pick<Announcer, 'say'>;
  /** Where focus goes back to when nothing more specific opened it. */
  readonly settingsButton: HTMLElement;
  /** The synced profile, or null with sync off. Reading the board needs no
   *  profile — an entry does, and so does the opt-in. */
  readonly credentials: () => SyncCredentials | null;
  /** The deal on the table right now, for the post that follows a clear. */
  readonly deal: () => RunDeal;
}

/** What main.ts, and the sections it wires, may ask of the leaderboard. */
export interface LeaderboardPanel {
  /** Repaint the opt-in row in the profile: it follows the sync state. */
  renderSection(): void;
  /** Post a finished ladder level, if the player asked to be on the board.
   *  Silent and fire-and-forget: the win screen never waits on the network. */
  submitRun(score: number, elapsedMs: number): void;
}

/** Look up the leaderboard's elements, wire its controls, declare its panel
 *  on the stack, and hand back what the rest of the game may ask of it. */
export function mountLeaderboardPanel(deps: LeaderboardPanelDeps): LeaderboardPanel {
  const { panels, storage, announcer, settingsButton, credentials, deal } = deps;

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

  /** A second consent, separate from sync: syncing gives the profile a home,
   *  this puts the player's name in front of strangers. Off by default. */
  let boardOptIn = readOptIn(storage);
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

  /** The weekly board (issues #70, #176). The one panel that may open over
   *  the end-of-level dialog, and it paints above it (issue #174). */
  const leaderboardDialog = panels.add({
    name: 'leaderboard',
    element: leaderboardPanel,
    overBase: true,
    beforeOpen: () => {
      rolloverRetries = 0;
    },
    focusIn: () => leaderboardClose.focus(),
    opener: () => leaderboardOpener,
    // No line on open: it announces itself when the board has loaded, which
    // is a network round trip later (see loadBoard).
    beforeClose: () => {
      // Bumping the generation is what makes an in-flight response stale, so
      // a close-then-reopen cannot render the old week over the new one.
      loadGeneration += 1;
      stopResetTicker();
      boardResetsAt = null;
      boardWeekStart = null;
      rolloverRetries = 0;
    },
  });

  function setBoardStatus(text: string): void {
    boardStatus.textContent = text;
  }

  /** The opt-in only means anything once there is a profile to attach an
   *  entry to, so it follows the sync state rather than standing alone. */
  function renderBoardSection(): void {
    const synced = credentials() !== null;
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
      glyph.className = 'avatar';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = avatarGlyph(entry.avatar);
      // Another player's frame id (issue #229): resolved through the frame
      // table inside applyFrame, so an unknown or hostile string draws nothing.
      applyFrame(glyph, entry.frame);
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

  async function openLeaderboard(opener: HTMLElement): Promise<void> {
    leaderboardOpener = opener;
    if (!leaderboardDialog.open()) return;
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
    const result = await fetchWeeklyBoard(credentials());
    // Stale response: the panel was closed, or reloaded, while this was in
    // flight. Checking the generation rather than only the panel's `visible`
    // matters because close-then-reopen makes that flag true again — this
    // response would then render over the newer one and start a second ticker
    // whose handle immediately overwrites the live one.
    if (!leaderboardDialog.visible || generation !== loadGeneration) return;
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
      if (!leaderboardDialog.visible || generation !== loadGeneration) {
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
      if (!leaderboardDialog.visible) return;
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
    const synced = credentials();
    if (synced === null || !boardOptIn) return;
    const { layoutId, seed, shuffles, moves } = deal();
    void submitRunScore(synced, {
      score,
      // The game clock is `performance.now()`-based and fractional; the
      // server takes whole milliseconds and refuses anything else (found
      // while wiring #187 — every post since #176 had been failing on this).
      // Ceiling, not rounding, so the run never claims to have ended before
      // its own last move, which the server now checks.
      elapsedMs: Math.ceil(elapsedMs),
      history: {
        layoutId,
        seed,
        shuffles,
        moves: compactHistory(moves),
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
    const synced = credentials();
    if (synced === null) {
      setBoardStatus('');
      return;
    }
    setBoardStatus('Removing your scores…');
    void withdrawFromBoard(synced).then((result) => {
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

  leaderboardClose.addEventListener('click', () => leaderboardDialog.close());

  return {
    renderSection: renderBoardSection,
    submitRun: submitRunResult,
  };
}
