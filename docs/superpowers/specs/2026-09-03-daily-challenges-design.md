# Daily challenges, not a Daily board — design

Date: 2026-09-03 · Status: approved by PM (2026-09-03)

## Problem

The Daily Challenge is a **separate board**: the HUD chip deals a map seeded
from the calendar date (one of ten layouts, its own night-indigo palette, a
fixed medium-plus difficulty), and clearing it locks the date until tomorrow.
Playing it means leaving the ladder — the player abandons the level they were
on to go and play a one-off board that pays no score and advances nothing.

The daily hook should ride *along with* the climb, not interrupt it.

## What we are building

The Daily stops dealing a board. A calendar date instead names **three
challenges** — goals like "finish a board", "match 40 pairs", "match 10 Dots
pairs" — that a player completes by playing the ladder normally. The HUD chip
opens a panel showing the three, their live progress, and which are done.

Decisions taken with the PM, 2026-09-03:

- **Three challenges a day**, the same three for everyone on that date.
- **All ladder play that day counts** — every match, win, loss, restart and
  abandoned board. Progress accumulates across boards and survives a loss.
- **Each completed challenge pays 1 trophy + 1 booster charge**; the day's
  first completion advances the streak and pays the streak bonus.
- **The date-seeded board is deleted**, not kept as an option.

Out of scope: score from the Daily (decision 0027 stands — the Daily banks
none), any server involvement, past-day catch-up, and per-challenge difficulty
payout scaling.

## Architecture

Three units, each usable and testable without the others.

### 1. `core/src/challenges.ts` — what a date asks for

A pure function of the date key, like `dailyLayoutId` today. No storage, no
clock, no DOM.

```ts
export type ChallengeKind = 'boards' | 'pairs' | 'suit' | 'clean-run';
export type ChallengeSuit = 'dots' | 'bamboo' | 'char';

export interface DailyChallenge {
  readonly kind: ChallengeKind;
  readonly target: number;
  /** Only on 'suit'. */
  readonly suit?: ChallengeSuit;
}

export function dailyChallenges(
  dateKey: string,
): readonly [DailyChallenge, DailyChallenge, DailyChallenge];
```

- The four kinds are hash-shuffled by the date (`hashString('daily-challenges:' + key)`),
  and the first three are taken — so a day never serves two challenges of the
  same kind, and no day is "match 20 pairs / match 40 pairs / match 60 pairs".
- Slot order is light → medium → heavy. Targets come from a pinned table:

  | kind        | light | medium | heavy |
  | ----------- | ----- | ------ | ----- |
  | `boards`    | 1     | 2      | 2     |
  | `pairs`     | 20    | 40     | 60    |
  | `suit`      | 6     | 10     | 16    |
  | `clean-run` | 5     | 8      | 12    |

  A full board is 72 pairs, so every target is reachable — the heavy `pairs`
  goal inside a single clear, the rest across the day. `boards` caps at 2 even
  in the heavy slot (PM, 2026-09-03): a finished board is the longest unit of
  play there is, and three of them on a slow level is a whole evening.
- `suit` draws from Dots, Bamboo and Characters only (18 pairs each on a full
  board). Winds, Dragons and Seasons top out at 8, 6 and 4 pairs, so no
  sensible target fits them.
- Invalid date keys throw, matching `dailySeed`'s contract.

`core/src/faces.ts` gains `faceSuit(face): 'dots' | 'bamboo' | 'char' | 'wind' |
'dragon' | 'season'`, reading the id prefix — the one place that knows how a
face id is spelled.

### 2. `ui/src/daily.ts` — what the player has done today

A store on its own key, `mahjong.daily.v1`:

```ts
interface DailyProgress {
  readonly date: string | null;
  readonly counts: readonly [number, number, number];
  readonly done: readonly [boolean, boolean, boolean];
}
```

- A stored date that is not today reads as zeros — the `weekScoreNow` pattern.
  No midnight timer has to fire for the panel to be right, and the day rolls
  over the moment `dailyDateKey()` says so.
- Malformed fields fall back per-field, like `parseSettings` and
  `parsePlayerRecord`.

Three events, each returning the slot indices that completed on that call so
the caller can pay and announce:

| event              | called from                        | feeds                          |
| ------------------ | ---------------------------------- | ------------------------------ |
| `onMatch(suit)`    | every `matched` tap outcome        | `pairs`, `suit`, `clean-run`   |
| `onBoardCleared()` | the win transition                 | `boards`                       |
| `onAssist()`       | a charged Hint or Shuffle          | resets `clean-run` to 0        |

- Counts clamp at target; a `done` slot stops counting and cannot be un-done.
- Undo does not reset `clean-run`: it undoes a hold, never a match, and the
  goal text names hints and shuffles.
- The suit for `onMatch` comes from the matched pair's face —
  `faceSuit(game.board.get(outcome.a).face)`. A removed tile still resolves
  through `board.get`, so this reads correctly after the match.

### 3. Payout — `ui/src/profile.ts` and `ui/src/boosters.ts`

`recordDailyWin` becomes `creditDailyChallenge(dateKey)`, same `DailyCredit`
shape:

- a date *before* `lastDaily` credits nothing — today's clock-back guard, kept
  verbatim;
- `lastDaily === dateKey` (the day's second and third completion) pays 1
  trophy and leaves the streak alone;
- a date strictly after `lastDaily` (the day's first completion) extends the
  streak when the gap is one day, restarts it at 1 otherwise, and pays
  `dailyTrophies(streak)`.

So a day with all three done pays 3 trophies, or 4 on a 7-day streak and 5 on
a 30-day one. The per-day ceiling of three payouts is the `done` flags, which
are per-date.

Each completion also grants **one random booster charge** via the existing
`charges.grantSplit(1, random)` — one channel, injectable random, already
capped at 99.

The record schema does not change. No score is banked, so the weekly
leaderboard and decision 0027 are untouched.

## UI

### The chip

`#btn-daily` keeps its indigo/gold palette and its place in the HUD, and
stops dealing a board. Its value reads `0/3` → `3/3`. It pulses only while
nothing is done, is never disabled (the panel stays readable when the day is
finished), and its accessible name reads "Daily challenges, 2 of 3 complete".

### The panel

A new dialog, `#daily-panel`, opened by the chip and stacked by the existing
dialog rules. Heading "Daily challenges", then the date and "2 of 3 complete",
then one row per challenge, then streak, trophies, and a line naming what a
completion pays.

| state       | row treatment                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| in progress | goal text at normal weight; hollow marker; track `#d1fae5` with a `#166534` fill; count `7 / 12` in tabular numerals                                                |
| completed   | goal text bold in `#14532d`; green check in `#166534` at the row start; bar full; count `10 / 10`; row gets a `#dcfce7` wash and a 3px `#166534` left border, square |

- Distinguished by weight, colour, check and a full bar — not a second font
  family (the app ships one stack) and not strikethrough, which would make the
  goal harder to read while it still labels the row.
- Contrast against the panel's own greens: `#14532d` on `#dcfce7` ≈ 10:1,
  `#166534` ≈ 7:1 — both clear of the spec §7 4.5:1 floor.
- Goal text is formatted in the UI, not core: "Finish 1 board", "Match 40
  pairs", "Match 10 Dots pairs", "Match 12 pairs in a row without a hint or
  shuffle".
- Each row is a group whose accessible name ends in "completed" when done. The
  bar is `role="progressbar"` with `aria-valuenow`/`aria-valuemax` and
  `aria-valuetext` "7 of 12". Opening the panel announces the summary line.
- The fill transitions briefly, and instantly under `data-motion='reduced'`.
- The panel is live: a completion while it is open updates that row in place.

### Completion feedback on the board

The existing status line plus the announcer — "Daily challenge complete: match
10 Dots pairs. 1 trophy, 1 booster charge." No new toast and no new motion to
gate.

## Deletions

The separate board and everything that existed only to serve it:

- `main.ts`: `startDaily`, the `daily` variable and every branch off it — the
  Level chip's date, the palette override, the score multiplier and
  concealment overrides, the win dialog's Daily title and "Back to the ladder"
  secondary, the Restart lock, the leaderboard label's `Daily <date>`.
- `core`: `DAILY_LAYOUTS`, `dailyLayoutId`, `dailySeed`.
- `main.ts`: `DAILY_BAND`, `DAILY_CONCEAL_RATIO`.
- `depth.ts`: `PALETTES.daily`.
- `profile.ts`: `dailyLockedFor`.
- `save.ts`: the `daily` field.

Kept: `dailyDateKey`, `daysBetween`, `isDateKey`, `dailyTrophies`,
`STREAK_TIERS`, and the chip's own indigo/gold styling.

Two knock-on decisions:

- **A save captured mid-Daily-board** resumes as an ordinary ladder board. The
  deal is stored as `(layoutId, seed)`, so it reopens fine; `parseSave` ignores
  the `daily` field, and a save that carried one reopens at its ladder level's
  concealment ratio and score multiplier so it cannot pay the retired
  medium-plus ×2.0 on an easy level. No save-version bump, no lost board.
- **The win dialog's Leaderboard button** was Daily-win-only. With no Daily win
  it moves to every ladder win — the ladder is what the weekly board ranks.

## Testing

**core** (`core/test/challenges.test.ts`): same date → same three challenges;
three distinct kinds; targets match the table by slot; `suit` only ever names
Dots, Bamboo or Characters; a malformed date key throws. Plus `faceSuit` over
every face in `STANDARD_144`.

**ui** (`ui/test/daily.test.ts`): progress accumulates across boards; a loss
keeps it; a stored yesterday reads as zeros; `clean-run` resets on a charged
hint or shuffle and not on undo; a `done` slot stops counting; malformed
storage falls back.

**ui** (`ui/test/record-daily.test.ts`, rewritten): `creditDailyChallenge`
pays the streak bonus once on the day's first completion, 1 trophy each on the
second and third, nothing for a date before `lastDaily`; the streak breaks on a
skipped day.

**ui**: save tests covering the dropped `daily` field and the level-multiplier
reopen; a panel test that the chip opens it and rows carry the completed
marking; the e2e slice's Daily steps rewritten to open the panel instead of
dealing a board.

## Docs

- `mahjong-solitaire-spec.md` §6: rewrite the Daily Challenge paragraph — three
  challenges a date, what counts, what it pays, no separate board.
- `docs/decisions/0028-daily-challenges-not-a-daily-board.md`: supersedes
  0016's board contract and 0026's replay lock; records why the board went and
  why progress counts across losses.
- `CHANGELOG.md`: one short line, per issue #181.
- `ROADMAP.md`: update any Daily-board wording.
