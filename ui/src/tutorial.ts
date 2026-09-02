// First-run tutorial (issue #59): six short steps over the dealt board, with
// Next / Skip on every one. This is the step machine only — pure, no DOM — so
// the flow (advance, skip, end) can be unit-tested; main.ts owns the card,
// the announcements and the step-3 pair highlight.
//
// The tutorial never gates play: it explains, then hands the board back. The
// player is never required to perform the demonstrated match to move on, and
// Skip ends it from any step (PM decision 2026-08-31, issue #59 comment).
//
// Whether it runs is the `showTutorial` setting (settings.ts): ON on a fresh
// install, flipped OFF the moment it is completed *or* skipped — the same
// outcome either way, so a player who skipped is not nagged on the next
// level. Turning the toggle back on in Settings arms it for the next deal.

export interface TutorialStep {
  readonly title: string;
  readonly body: string;
  /** Step 3: main.ts highlights one genuinely matchable pair on the board in
   *  front of the player while this step shows. */
  readonly showPair?: boolean;
}

/** The six PM-approved steps, in order (issue #59 body). Step 6 speaks of
 *  the score only: stars were retired by issue #119. */
export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    title: 'Clear the board',
    body: 'Match identical tiles in pairs until none are left.',
  },
  {
    title: 'Free tiles',
    body:
      'A tile is free when nothing covers it and one long side is open. Blocked tiles are dimmed and will not select.',
  },
  {
    title: 'Make a match',
    body:
      'The two highlighted tiles are a free pair. Tap one, then the other, to clear them — or carry on and find your own.',
    showPair: true,
  },
  {
    title: 'Boosters',
    body: 'Hint shows a pair, Undo takes back a parked tile, Shuffle rearranges the board. Each costs one charge.',
  },
  {
    title: 'The holder',
    body: 'Park a free tile in a holder slot to reach what is under it. It is free to use and always available.',
  },
  {
    title: 'That’s it',
    body: 'Quick matches in a row score more. The board is yours.',
  },
];

export type TutorialEnd = 'done' | 'skipped';

/**
 * The step cursor. `start()` opens on step 0; `next()` advances and, on the
 * last step, ends as 'done'; `skip()` ends as 'skipped' from anywhere. Ending
 * fires `onEnd` exactly once per run and makes the machine inactive again, so
 * a stray second Next/Skip (a double tap, a keyboard repeat) is a no-op.
 */
export class Tutorial {
  private index = -1;

  constructor(
    private readonly onEnd: (how: TutorialEnd) => void,
    private readonly steps: readonly TutorialStep[] = TUTORIAL_STEPS,
  ) {}

  get active(): boolean {
    return this.index >= 0;
  }

  /** Zero-based step index; -1 while inactive. */
  get stepIndex(): number {
    return this.index;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  /** The current step, or null while inactive. */
  get step(): TutorialStep | null {
    return this.active ? this.steps[this.index]! : null;
  }

  get isLast(): boolean {
    return this.active && this.index === this.steps.length - 1;
  }

  /** Open on the first step. A second start while active restarts from step 0. */
  start(): void {
    this.index = 0;
  }

  /** Advance one step; on the last step, finish. */
  next(): void {
    if (!this.active) return;
    if (this.isLast) {
      this.end('done');
      return;
    }
    this.index++;
  }

  /** End now, from any step. */
  skip(): void {
    if (!this.active) return;
    this.end('skipped');
  }

  private end(how: TutorialEnd): void {
    this.index = -1;
    this.onEnd(how);
  }
}
