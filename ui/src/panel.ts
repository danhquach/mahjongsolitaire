// The modal contract, in one place (issue #241).
//
// Every dialog in the game — Settings, Profile, Shop, What's new, Send
// feedback, Daily challenges, the Leaderboard, the confirmation dialog, the
// welcome gate, the tutorial card — does the same eight things:
//
//   1. flip the `visible` class, and a `visible` flag the rest of the page
//      can read;
//   2. refuse to open while another dialog is up;
//   3. inert the background on open, and hand it back on close;
//   4. put focus somewhere sensible on open, and back on the control that
//      opened it on close;
//   5. open the card at its top, never wherever it was last scrolled to;
//   6. dismiss on a backdrop tap, but not on a tap on the card itself;
//   7. take its turn in the Escape chain, topmost first;
//   8. announce itself to the live region.
//
// Until this module every panel re-derived that list by hand, and the
// mutual-exclusion guards in particular were written out panel by panel — a
// new dialog was correct only if whoever added it remembered all eight and
// edited every existing guard. Issue #239 moved the Shop between two of those
// idioms and silently lost its guard; review caught it, no test did.
//
// So: a `Panel` owns the whole list, and a `PanelStack` owns the set of them —
// exclusion ("nothing else is up") and the Escape order are properties of the
// stack, not of nine hand-written `else if` chains. What is genuinely per
// panel stays per panel, declared as hooks on the spec rather than flattened
// away: the profile commits a typed name on the way out, the feedback form
// keeps its fields, the changelog focuses its heading, the confirmation dialog
// goes back into Settings, the leaderboard opens above the win screen.
//
// Two things in the page are deliberately NOT panels:
//
//   * the end-of-level dialog (`#overlay`). It is not opened by a control that
//     focus can return to, it must be answered rather than dismissed (no
//     Escape, no backdrop tap), it has three different bodies, it keeps its
//     own focus (the "way out" button), and real panels open *above* it
//     (issue #174). main.ts keeps it, and reports it to the stack through
//     `PanelHost.baseHeld` — a hold on the background that survives a panel
//     close and blocks an open.
//   * nothing else: the tutorial card *is* a panel here, even though Escape
//     skips it rather than closing it and it has no opener to give focus back
//     to. Those are two declarations (`escape`, `opener`), which is cheaper
//     than leaving it out of the Escape order it has to be first in.

/** What a panel needs from the page around it. */
export interface PanelHost {
  /** Inert every region outside an open dialog, or make them live again. */
  setBackgroundInert(inert: boolean): void;
  /**
   * Whether something that is not a registered panel is holding the screen —
   * the end-of-level dialog. A hold blocks an open (unless the panel declares
   * `overBase`) and keeps the background inert after a panel closes.
   */
  baseHeld(): boolean;
  /** Write a line to the live region. */
  say(line: string): void;
}

/**
 * What one dialog declares. Everything not listed here it gets for free.
 *
 * The hooks run around the moment the panel's own `visible` flips, so a hook
 * must not open or close *another* panel from `beforeOpen` or `beforeClose`:
 * this one is not yet counted as open, or is still counted as open, and the
 * other panel's exclusion check would read the wrong answer. `replaces`,
 * `returnsTo` and `afterClose` are the declared places for that, and they run
 * on the right side of the flip.
 */
export interface PanelSpec {
  /** The panel's element id, for the stack's own reporting and for tests. */
  readonly name: string;
  /** The full-screen element the `visible` class goes on, and whose own
   *  surface is the dismissable backdrop. */
  readonly element: HTMLElement;
  /** Where focus lands on open. */
  readonly focusIn: () => void;
  /** The control focus returns to on close — whatever opened it. A function
   *  because a panel with more than one route in answers per open; null for
   *  one that puts focus back itself (the tutorial card) or never took it. */
  readonly opener: () => HTMLElement | null;
  /** The line the live region hears on open. A function because most of them
   *  carry a live number; omitted, or empty, says nothing. */
  readonly announce?: () => string;
  /** A panel this one replaces rather than stacks on: the dialogs opened from
   *  a Settings row step Settings aside. It is not counted as a blocker, so
   *  the exclusion check has already passed by the time it is closed. A
   *  function, and may answer null: the confirmation dialog replaces Settings
   *  for an account action and nothing for a deal action (issue #248). */
  readonly replaces?: () => Panel | null;
  /** A panel that comes back up as this one closes: Cancel on the
   *  confirmation dialog goes back into Settings — but only for the account
   *  actions it opened from there. */
  readonly returnsTo?: () => Panel | null;
  /** True for a panel allowed to open while `PanelHost.baseHeld()` — the
   *  leaderboard opens over the win screen (issue #174). */
  readonly overBase?: boolean;
  /** A backdrop tap dismisses, unless this says false (the welcome gate and
   *  the tutorial card have no backdrop route out). */
  readonly backdrop?: boolean;
  /** What Escape does while this is the topmost open panel: close it by
   *  default, `null` to swallow the key (a required choice), or something of
   *  the panel's own (the tutorial card skips). */
  readonly escape?: (() => void) | null;
  /** Refuse to close while this says false — the confirmation dialog is not
   *  dismissable while its action is in flight. */
  readonly canClose?: () => boolean;
  /** Render the contents before the panel is shown, so nothing stale is ever
   *  on screen for a frame. */
  readonly beforeOpen?: () => void;
  /** Run once it is up and the background is inert, before focus moves in. */
  readonly afterOpen?: () => void;
  /** Run while it is still open, on the way out. */
  readonly beforeClose?: () => void;
  /** Run once it is down, the background is live and focus is back on the
   *  opener — the last word. */
  readonly afterClose?: () => void;
}

/**
 * One dialog. Built through `PanelStack.add`, which is what puts it in the
 * exclusion set and the Escape order.
 */
export class Panel {
  private shown = false;
  /** The scrollable card inside the panel, if it has one. */
  private readonly card: HTMLElement | null;

  constructor(
    private readonly spec: PanelSpec,
    private readonly stack: PanelStack,
  ) {
    this.card = spec.element.querySelector<HTMLElement>('.card') ?? null;
    if (spec.backdrop !== false) {
      // The target check is the whole point: a tap on the card itself, or on
      // anything in it, is not a dismissal.
      spec.element.addEventListener('click', (ev) => {
        if (ev.target === spec.element) this.close();
      });
    }
  }

  get name(): string {
    return this.spec.name;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** The control focus goes back to, as it stands right now. */
  get opener(): HTMLElement | null {
    return this.spec.opener();
  }

  /** The panel this one steps aside rather than stacking on, as it stands
   *  right now, if any. */
  get replaces(): Panel | null {
    return this.spec.replaces?.() ?? null;
  }

  /** Whether this one may open over a base hold (the win screen). */
  get overBase(): boolean {
    return this.spec.overBase === true;
  }

  /**
   * Put the panel up: contents rendered, `visible` on, the background inert,
   * the card at its top, focus inside it, and the live region told.
   *
   * Returns false without touching anything when it is already up, when
   * another panel is open, or when the base hold blocks it — so a caller with
   * somewhere else to put the request (the tutorial defers) can see that.
   */
  open(): boolean {
    if (this.shown) return false;
    if (this.stack.blocked(this)) return false;
    this.replaces?.close();
    this.spec.beforeOpen?.();
    this.shown = true;
    this.spec.element.classList.add('visible');
    this.stack.settleInert();
    // A reopened card opens at its top, not wherever it was left (issue #168).
    if (this.card !== null) this.card.scrollTop = 0;
    this.spec.afterOpen?.();
    this.spec.focusIn();
    const line = this.spec.announce?.() ?? '';
    if (line !== '') this.stack.say(line);
    return true;
  }

  /**
   * Take it down: hidden, the background back to whatever still holds it,
   * focus back on the opener. Returns whether it had been open — and false
   * when `canClose` refuses.
   *
   * `returnFocus: false` leaves focus alone, for the one caller that is about
   * to put it somewhere else itself: a confirmed deal (issue #248) re-deals
   * the board and focuses the board's current tile, not the header button
   * that asked.
   */
  close({ returnFocus = true }: { readonly returnFocus?: boolean } = {}): boolean {
    if (!this.shown) return false;
    if (this.spec.canClose?.() === false) return false;
    this.spec.beforeClose?.();
    this.shown = false;
    this.spec.element.classList.remove('visible');
    this.stack.settleInert();
    this.spec.returnsTo?.()?.open();
    if (returnFocus) this.spec.opener()?.focus();
    this.spec.afterClose?.();
    return true;
  }

  /** Escape, while this is the topmost open panel. */
  dismissByKey(): void {
    const escape = this.spec.escape;
    if (escape === null) return;
    if (escape === undefined) {
      this.close();
      return;
    }
    escape();
  }
}

/**
 * The live panels, declared bottom of the stack first. Owns the two things no
 * single panel can know on its own: that nothing else is open, and which one
 * Escape belongs to.
 */
export class PanelStack {
  private readonly panels: Panel[] = [];

  constructor(private readonly host: PanelHost) {}

  /** Declare a panel. Call order is stacking order, lowest first. */
  add(spec: PanelSpec): Panel {
    const panel = new Panel(spec, this);
    this.panels.push(panel);
    return panel;
  }

  /** The topmost open panel, or null. */
  get top(): Panel | null {
    for (let i = this.panels.length - 1; i >= 0; i--) {
      const panel = this.panels[i]!;
      if (panel.visible) return panel;
    }
    return null;
  }

  /** Whether any panel is open. */
  get anyOpen(): boolean {
    return this.top !== null;
  }

  /** Whether `panel` must refuse to open: something else has the screen. */
  blocked(panel: Panel): boolean {
    for (const other of this.panels) {
      if (other === panel || other === panel.replaces) continue;
      if (other.visible) return true;
    }
    return !panel.overBase && this.host.baseHeld();
  }

  /**
   * Escape belongs to the topmost open panel and to no other — a flat list of
   * ifs would close the one underneath in the same keystroke (issue #174).
   * Returns whether a panel was there to answer.
   */
  escape(): boolean {
    const top = this.top;
    if (top === null) return false;
    top.dismissByKey();
    return true;
  }

  /** Set the background inert to whatever is actually holding it now. */
  settleInert(): void {
    this.host.setBackgroundInert(this.anyOpen || this.host.baseHeld());
  }

  /** Write a line to the live region. */
  say(line: string): void {
    this.host.say(line);
  }
}
