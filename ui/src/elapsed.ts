// Elapsed play time (issue #14). Two consumers: the spec §9 save state's
// `elapsedMs`, and the opt-in timed-mode readout (§6 "No timer by default.
// Timed mode is an opt-in setting"). Even opted in it counts *up* — spec §7
// forbids countdowns, so this is a stopwatch, never a deadline.
//
// The clock is injected, so tests drive time instead of waiting for it, and
// it pauses while the page is hidden: a player who backgrounds the game for an
// hour should not come back to an hour on the clock.

export class Elapsed {
  private accumulated: number;
  /** Clock reading when the current running span began; null while paused. */
  private since: number | null;

  constructor(
    private readonly now: () => number,
    accumulatedMs = 0,
  ) {
    this.accumulated = accumulatedMs;
    this.since = now();
  }

  /** Total running time so far, in ms. */
  get ms(): number {
    return this.accumulated + (this.since === null ? 0 : this.now() - this.since);
  }

  get running(): boolean {
    return this.since !== null;
  }

  /** Bank the current span and stop counting. Idempotent. */
  pause(): void {
    if (this.since === null) return;
    this.accumulated += this.now() - this.since;
    this.since = null;
  }

  /** Start counting again from now. Idempotent. */
  resume(): void {
    this.since ??= this.now();
  }

  /** Restart from a known total — a fresh deal (0) or a resumed save. */
  reset(accumulatedMs = 0): void {
    this.accumulated = accumulatedMs;
    this.since = this.now();
  }
}

/** `mm:ss` (or `h:mm:ss` past an hour) for the timed-mode readout. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = total >= 3600 ? String(Math.floor(total / 60) % 60).padStart(2, '0') : String(Math.floor(total / 60));
  return total >= 3600 ? `${Math.floor(total / 3600)}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
