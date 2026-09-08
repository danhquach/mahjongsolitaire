// The modal contract (issue #241), asserted on the contract and not on the
// instances.
//
// Nine dialogs used to re-derive the same eight-part contract by hand, and the
// thing that went wrong (issue #239 dropping the Shop's mutual-exclusion
// guard) was invisible to every per-panel test: each one asserted what its own
// panel did, so a missing part of the list read as "not tested here". These
// tests instead take a stack of panels — every shape the game actually
// declares, including each quirk — and assert the whole list holds for each of
// them. A tenth dialog added tomorrow inherits the tests with the contract.
//
// The DOM is stood in for by the smallest object Panel touches (the same
// approach as frames.test.ts): a class set, a scrollable card, a click
// listener, and a focus() that records. The real panels' real markup is
// covered end-to-end in a browser by ui/qa/a11y-audit.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Panel, PanelStack } from '../src/panel.js';
import type { PanelSpec } from '../src/panel.js';

/** Where focus is, as far as the stand-ins are concerned. */
let focused: string | null = null;

/** A focusable stand-in — a Done button, a Settings gear, a HUD chip. */
function control(name: string): HTMLElement {
  return { focus: () => (focused = name) } as unknown as HTMLElement;
}

interface FakeElement {
  readonly el: HTMLElement;
  readonly classes: Set<string>;
  readonly card: { scrollTop: number };
  /** A tap on the backdrop itself. */
  tapBackdrop(): void;
  /** A tap on the card inside it. */
  tapCard(): void;
}

function element(): FakeElement {
  const classes = new Set<string>();
  const card = { scrollTop: 0 };
  const listeners: Array<(ev: { target: unknown }) => void> = [];
  const self = {
    classList: {
      add: (c: string) => classes.add(c),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    querySelector: (sel: string) => (sel === '.card' ? card : null),
    addEventListener: (_type: string, fn: (ev: { target: unknown }) => void) => listeners.push(fn),
  };
  return {
    el: self as unknown as HTMLElement,
    classes,
    card,
    tapBackdrop: () => listeners.forEach((fn) => fn({ target: self })),
    tapCard: () => listeners.forEach((fn) => fn({ target: card })),
  };
}

interface Harness {
  readonly stack: PanelStack;
  readonly panels: readonly { readonly panel: Panel; readonly dom: FakeElement; readonly opener: string }[];
  /** Whether the background is inert, as the host was last told. */
  inert(): boolean;
  /** Everything said to the live region since the last read. */
  spoken(): string[];
  /** The end-of-level dialog: not a panel, a hold on the background. */
  setBaseHeld(held: boolean): void;
}

/**
 * A stack shaped like the game's: a required gate, a plain panel, one opened
 * from another panel's row, one that goes back into it, one that opens over
 * the end-of-level dialog, and one that answers Escape with something else.
 * The confirmation dialog's two-minds `replaces`/`returnsTo` (issue #248) has
 * a test of its own below.
 */
function harness(): Harness {
  let inert = false;
  let baseHeld = false;
  const said: string[] = [];
  const stack = new PanelStack({
    setBackgroundInert: (on) => (inert = on),
    baseHeld: () => baseHeld,
    say: (line) => said.push(line),
  });

  const made: { panel: Panel; dom: FakeElement; opener: string }[] = [];
  const add = (name: string, extra: Partial<PanelSpec> = {}): Panel => {
    const dom = element();
    const opener = `${name}-opener`;
    const panel = stack.add({
      name,
      element: dom.el,
      focusIn: () => (focused = `inside-${name}`),
      opener: () => control(opener),
      announce: () => `${name} open.`,
      ...extra,
    } as PanelSpec);
    made.push({ panel, dom, opener });
    return panel;
  };

  // Declared bottom first, exactly as main.ts declares the real ones.
  add('gate', { backdrop: false, escape: null, opener: () => null });
  const settings = add('settings');
  add('profile', { replaces: () => settings });
  add('board', { overBase: true });
  add('confirm', { replaces: () => settings, returnsTo: () => settings });
  add('coach', { backdrop: false, escape: () => (focused = 'skipped') });

  return {
    stack,
    panels: made,
    inert: () => inert,
    spoken: () => said.splice(0, said.length),
    setBaseHeld: (held) => (baseHeld = held),
  };
}

/** The names of every panel the harness declares, to run a contract test once
 *  per shape against a stack of its own. */
const SHAPES = harness().panels.map((p) => p.panel.name);

/** The harness, and the one panel this iteration is about. */
function one(name: string): { h: Harness; it: Harness['panels'][number] } {
  const h = harness();
  return { h, it: h.panels.find((p) => p.panel.name === name)! };
}

/** Put every panel in a stack down, however it insists on going. */
function closeAll(h: Harness): void {
  for (const { panel } of [...h.panels].reverse()) panel.close();
  for (const { panel } of [...h.panels].reverse()) panel.close();
}

test('every panel opens the same way: visible, focus inside, card at its top', () => {
  for (const name of SHAPES) {
    const { it } = one(name);
    focused = 'somewhere-else';
    it.dom.card.scrollTop = 400;
    assert.equal(it.panel.open(), true, name);
    assert.ok(it.dom.classes.has('visible'), `${name} is not visible`);
    assert.equal(it.panel.visible, true, name);
    assert.equal(it.dom.card.scrollTop, 0, `${name} kept its scroll`);
    assert.equal(focused, `inside-${name}`, `${name} did not take focus`);
  }
});

test('every panel inerts the background on open and hands it back on close', () => {
  for (const name of SHAPES) {
    const { h, it } = one(name);
    assert.equal(h.inert(), false);
    it.panel.open();
    assert.equal(h.inert(), true, `${name} left the background live`);
    it.panel.close();
    // `returnsTo` legitimately keeps it inert: another panel is up now.
    assert.equal(h.inert(), h.stack.anyOpen, `${name} left the background wrong`);
  }
});

test('every panel refuses to open while another one is open', () => {
  for (const name of SHAPES) {
    for (const otherName of SHAPES) {
      if (otherName === name) continue;
      const { h, it } = one(name);
      const other = h.panels.find((p) => p.panel.name === otherName)!;
      // A panel that replaces another is allowed over exactly that one.
      const allowed = it.panel.replaces === other.panel;
      assert.equal(other.panel.open(), true, otherName);
      assert.equal(
        it.panel.open(),
        allowed,
        `${name} ${allowed ? 'refused' : 'opened'} over ${otherName}`,
      );
      closeAll(h);
    }
  }
});

test('Escape and a backdrop tap both close a panel and put focus back on its opener', () => {
  for (const route of ['escape', 'backdrop'] as const) {
    for (const name of SHAPES) {
      // The gate and the coach card declare their own answers to both routes;
      // they get their own tests below.
      if (name === 'gate' || name === 'coach') continue;
      const { h, it } = one(name);
      assert.equal(it.panel.open(), true, name);
      focused = 'inside';
      if (route === 'escape') h.stack.escape();
      else it.dom.tapBackdrop();
      assert.equal(it.panel.visible, false, `${route} did not close ${name}`);
      assert.ok(!it.dom.classes.has('visible'), name);
      assert.equal(focused, it.opener, `${route} on ${name} lost the opener`);
    }
  }
});

test('a tap on the card itself is not a dismissal', () => {
  const h = harness();
  const settings = h.panels.find((p) => p.panel.name === 'settings')!;
  settings.panel.open();
  settings.dom.tapCard();
  assert.equal(settings.panel.visible, true);
});

test('every panel says its line on open, and nothing of its own on close', () => {
  for (const name of SHAPES) {
    const { h, it } = one(name);
    h.spoken();
    it.panel.open();
    assert.deepEqual(h.spoken(), [`${name} open.`], name);
    it.panel.close();
    // The only line a close may produce is the one the panel it returns to
    // says as it comes back up.
    const expected = it.panel.name === 'confirm' ? ['settings open.'] : [];
    assert.deepEqual(h.spoken(), expected, `${name} spoke on the way out`);
  }
});

test('a panel with nothing to announce says nothing', () => {
  let said = 0;
  const stack = new PanelStack({
    setBackgroundInert: () => {},
    baseHeld: () => false,
    say: () => (said += 1),
  });
  const quiet = stack.add({
    name: 'quiet',
    element: element().el,
    focusIn: () => {},
    opener: () => null,
  });
  quiet.open();
  assert.equal(said, 0);
});

test('Escape closes only the topmost panel, in the declared order', () => {
  const h = harness();
  const settings = h.panels.find((p) => p.panel.name === 'settings')!;
  const confirm = h.panels.find((p) => p.panel.name === 'confirm')!;
  settings.panel.open();
  // The confirmation dialog replaces Settings, which is the only stacking the
  // game has; put both up by hand to prove the order is what answers.
  confirm.panel.open();
  settings.panel.open();
  assert.equal(h.stack.top?.name, 'confirm');
  h.stack.escape();
  assert.equal(confirm.panel.visible, false);
  // `returnsTo` brought Settings back, and it is what the next Escape gets.
  assert.equal(h.stack.top?.name, 'settings');
  h.stack.escape();
  assert.equal(h.stack.top, null);
});

test('Escape with nothing open does nothing', () => {
  const h = harness();
  assert.equal(h.stack.escape(), false);
});

test('a required gate swallows Escape and has no backdrop route out', () => {
  const h = harness();
  const gate = h.panels.find((p) => p.panel.name === 'gate')!;
  gate.panel.open();
  h.stack.escape();
  assert.equal(gate.panel.visible, true, 'Escape dismissed a required gate');
  gate.dom.tapBackdrop();
  assert.equal(gate.panel.visible, true, 'a backdrop tap dismissed a required gate');
  assert.equal(gate.panel.close(), true, 'its own control still closes it');
});

test("a panel's own Escape answer replaces closing it", () => {
  const h = harness();
  const coach = h.panels.find((p) => p.panel.name === 'coach')!;
  coach.panel.open();
  focused = 'inside';
  h.stack.escape();
  assert.equal(focused, 'skipped');
  // Skipping is what closes it, through whatever the panel's own answer does —
  // Escape itself did not.
  assert.equal(coach.panel.visible, true);
});

test('a panel that replaces another steps it aside rather than stacking', () => {
  const h = harness();
  const settings = h.panels.find((p) => p.panel.name === 'settings')!;
  const profile = h.panels.find((p) => p.panel.name === 'profile')!;
  settings.panel.open();
  assert.equal(profile.panel.open(), true);
  assert.equal(settings.panel.visible, false, 'Settings stacked instead of stepping aside');
  assert.equal(h.inert(), true, 'the background went live between the two');
});

test('a panel that returns to another puts it back up on the way out', () => {
  const h = harness();
  const confirm = h.panels.find((p) => p.panel.name === 'confirm')!;
  const settings = h.panels.find((p) => p.panel.name === 'settings')!;
  confirm.panel.open();
  confirm.panel.close();
  assert.equal(settings.panel.visible, true);
  // Focus is the confirmation's own opener — the row it was opened from — not
  // wherever Settings would have put it.
  assert.equal(focused, confirm.opener);
  assert.equal(h.inert(), true);
});

test('the end-of-level dialog blocks every panel but the one declared over it', () => {
  const h = harness();
  h.setBaseHeld(true);
  for (const { panel } of h.panels) {
    assert.equal(panel.open(), panel.overBase, `${panel.name} over the base hold`);
    panel.close();
  }
});

test('a panel over the end-of-level dialog leaves the background inert behind it', () => {
  const h = harness();
  h.setBaseHeld(true);
  const board = h.panels.find((p) => p.panel.name === 'board')!;
  assert.equal(board.panel.open(), true);
  assert.equal(h.inert(), true);
  board.panel.close();
  assert.equal(h.inert(), true, 'the win screen was left live behind itself');
  h.setBaseHeld(false);
  h.stack.settleInert();
  assert.equal(h.inert(), false);
});

test('a panel that refuses to close refuses on every route', () => {
  let allowed = false;
  let inert = false;
  const dom = element();
  const stack = new PanelStack({
    setBackgroundInert: (on) => (inert = on),
    baseHeld: () => false,
    say: () => {},
  });
  const busy = stack.add({
    name: 'busy',
    element: dom.el,
    focusIn: () => {},
    opener: () => null,
    canClose: () => allowed,
  });
  busy.open();
  assert.equal(busy.close(), false);
  stack.escape();
  dom.tapBackdrop();
  assert.equal(busy.visible, true);
  assert.equal(inert, true);
  allowed = true;
  assert.equal(busy.close(), true);
  assert.equal(inert, false);
});

test('a close may leave focus alone for a caller that is about to move it', () => {
  const h = harness();
  const settings = h.panels.find((p) => p.panel.name === 'settings')!;
  settings.panel.open();
  focused = 'inside';
  assert.equal(settings.panel.close({ returnFocus: false }), true);
  assert.equal(focused, 'inside', 'the opener took focus back anyway');
  // Everything else about the close still happened.
  assert.equal(settings.panel.visible, false);
  assert.equal(h.inert(), false);
});

test('a replaces / returnsTo that answers null blocks instead, and brings nothing back', () => {
  // The confirmation dialog's shape (issue #248): Settings steps aside for an
  // account action, and is a plain blocker for a deal action.
  let account = true;
  let inert = false;
  const dom = element();
  const stack = new PanelStack({
    setBackgroundInert: (on) => (inert = on),
    baseHeld: () => false,
    say: () => {},
  });
  const settings = stack.add({
    name: 'settings',
    element: element().el,
    focusIn: () => (focused = 'inside-settings'),
    opener: () => control('gear'),
  });
  const confirm = stack.add({
    name: 'confirm',
    element: dom.el,
    replaces: () => (account ? settings : null),
    returnsTo: () => (account ? settings : null),
    focusIn: () => (focused = 'inside-confirm'),
    opener: () => control('row'),
  });

  settings.open();
  assert.equal(confirm.open(), true, 'an account action must step Settings aside');
  assert.equal(settings.visible, false);
  confirm.close();
  assert.equal(settings.visible, true, 'Cancel must put Settings back up');
  assert.equal(focused, 'row');
  settings.close();

  account = false;
  settings.open();
  assert.equal(confirm.open(), false, 'a deal action must refuse while Settings is up');
  settings.close();
  assert.equal(confirm.open(), true);
  confirm.close();
  assert.equal(settings.visible, false, 'a deal action brought Settings back');
  assert.equal(inert, false);
});

test('the hooks run in the one order, around the parts the contract owns', () => {
  const log: string[] = [];
  const dom = element();
  const stack = new PanelStack({
    setBackgroundInert: (on) => log.push(`inert:${String(on)}`),
    baseHeld: () => false,
    say: (line) => log.push(`say:${line}`),
  });
  const panel = stack.add({
    name: 'hooked',
    element: dom.el,
    beforeOpen: () => log.push('beforeOpen'),
    afterOpen: () => log.push('afterOpen'),
    focusIn: () => log.push('focusIn'),
    opener: () => control('back') && (log.push('opener'), control('back')),
    announce: () => 'hi',
    beforeClose: () => log.push('beforeClose'),
    afterClose: () => log.push('afterClose'),
  });
  panel.open();
  panel.close();
  assert.deepEqual(log, [
    'beforeOpen',
    'inert:true',
    'afterOpen',
    'focusIn',
    'say:hi',
    'beforeClose',
    'inert:false',
    'opener',
    'afterClose',
  ]);
});

test('a second open, or a close of something already down, changes nothing', () => {
  const h = harness();
  const settings = h.panels.find((p) => p.panel.name === 'settings')!;
  assert.equal(settings.panel.open(), true);
  h.spoken();
  assert.equal(settings.panel.open(), false, 'a second open re-ran the contract');
  assert.deepEqual(h.spoken(), []);
  assert.equal(settings.panel.close(), true);
  assert.equal(settings.panel.close(), false);
});

// --- and the panels main.ts actually declares -----------------------------------
//
// The contract above is only worth as much as the set of panels that adopt it,
// and that set lives in main.ts. These two read the source: they are what would
// have caught issue #239's dropped guard, and what stops a tenth dialog from
// quietly shipping its own hand-written copy of the contract.

const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');

/** The dialogs main.ts is not asked to make panels of, and why. */
const NOT_PANELS: Readonly<Record<string, string>> = {
  // The level's result, not a dialog the player opened: no opener to hand
  // focus back to, three different bodies, its own focus keeper (the "way
  // out" button), no Escape or backdrop route out — it must be answered — and
  // real panels open above it (issue #174). It reaches the stack as
  // `baseHeld`, a hold on the background.
  overlay: 'the end-of-level dialog',
};

test('every modal in the page is a registered panel, or is named as not one', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const ids: string[] = [];
  for (const match of html.matchAll(/role="(?:alert)?dialog"/g)) {
    const opening = html.lastIndexOf('<div', match.index);
    const id = /id="([a-z0-9-]+)"/.exec(html.slice(opening, match.index));
    assert.notEqual(id, null, `a modal with no id at ${String(match.index)}`);
    ids.push(id![1]!);
  }
  // The spotlight SVG is not a modal; everything else with the role is.
  assert.ok(ids.length >= 10, `only found ${ids.length} modals`);
  for (const id of ids) {
    if (id in NOT_PANELS) continue;
    assert.ok(
      new RegExp(`name:\\s*'${id}'`).test(main),
      `#${id} is not registered with the panel stack, and is not named in NOT_PANELS`,
    );
  }
});

/** The loose booleans the hand-written guard lists were built out of. */
const RETIRED_FLAGS = [
  'settingsVisible',
  'profileVisible',
  'shopVisible',
  'dailyPanelVisible',
  'changelogVisible',
  'feedbackVisible',
  'confirmVisible',
  'welcomeVisible',
  'tutorialVisible',
  'leaderboardVisible',
];

test('no panel opener carries a hand-written list of the other panels', () => {
  // The shape issue #239 broke was an `xVisible ||` chain per opener, each of
  // which had to name every other panel. Asserting on the flags rather than
  // on the chain's formatting catches a reintroduced guard however it is
  // written: it cannot be written at all without them. `overlayVisible` stays
  // — the end-of-level dialog is not a panel (see NOT_PANELS).
  for (const flag of RETIRED_FLAGS) {
    assert.ok(
      !new RegExp(`\\b${flag}\\b`).test(main),
      `${flag} is back: that panel's state belongs to its Panel, not to a loose boolean`,
    );
  }
});
