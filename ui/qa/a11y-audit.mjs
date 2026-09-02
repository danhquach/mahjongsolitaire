// Accessibility acceptance check for issue #12 (ROADMAP Phase 2 exit criteria:
// "VoiceOver/TalkBack can traverse and match a pair on the slice board;
// touch-target audit ≥ 48dp").
//
// Not part of `npm test` (needs a browser); run manually or from CI:
//   npm run build && node qa/a11y-audit.mjs
// Set CHROMIUM_PATH if Chromium is not at the default container location.
//
// What it proves, using the browser's real accessibility tree — the same tree
// VoiceOver and TalkBack consume:
//   1. every tile is a named, traversable node in reading order;
//   2. every interactive target is ≥ 48×48 dp on every shipped viewport;
//   3. every action is ≤ 2 taps from the board;
//  3b. the holder strip (issue #43/#93) is a named group of named slots, and
//      the whole park + pair-clear loop works by keyboard;
//   4. a pair can be matched with the keyboard alone, outcomes are announced,
//      and focus survives the tiles being removed;
//   5. the end-of-level dialog is modal and takes focus;
//   6. the settings screen (issue #14, plus issue #45's Highlight free tiles
//      and issue #44's Reduced motion) is a labelled modal, reachable in one
//      tap, every control named and ≥ 48dp, and Escape returns focus to it.
//   7. the feedback form (issue #118) is a labelled modal reachable from
//      Settings, its fields are labelled and ≥ 48dp, Send starts disabled,
//      and Escape returns focus to the row that opened it; its attachment
//      controls (issue #130) are named and ≥ 48dp too.
//
// Real VoiceOver/TalkBack device passes remain a Phase 5 manual item; this
// audit is the automated gate that keeps the semantics from regressing.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
// The shipped implementation, not a parallel copy: this asserts the DOM is
// wired to traversalOrder. Its semantics are pinned by ui/test/a11y.test.ts.
import { traversalOrder } from '../dist/src/a11y.js';

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const DIST = new URL('../dist-web', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

/** Spec §7: minimum touch target, in dp (≈ CSS px on the web). */
const MIN_TOUCH_TARGET = 48;
/** Spec §7: "every action reachable within 2 taps from the board". */
const MAX_TAPS_TO_ACTION = 2;
// A free tile names its action after the position (issue #93); a face-down one
// offers the peek instead (issue #64); a blocked one offers nothing.
const TILE_LABEL =
  /^.+, (available|blocked), row \d+, column \d+(, activate to (peek at it|send it to the holder|send it to the last holder slot, which ends the level|clear it with its match in the holder))?$/;
/** Controls behind the modal dialog: the header and the booster rail. */
const BACKGROUND_CONTROLS = ['btn-new', 'btn-restart', 'btn-hint', 'btn-undo', 'btn-shuffle'];

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  let body;
  try {
    body = await readFile(join(DIST, path));
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const VIEWPORTS = [
  { name: 'phone portrait', width: 390, height: 844, dpr: 3 },
  { name: 'phone landscape', width: 844, height: 390, dpr: 3 },
  { name: 'tablet portrait', width: 810, height: 1080, dpr: 2 },
  { name: 'tablet landscape', width: 1080, height: 810, dpr: 2 },
];

let failures = 0;
const fail = (msg, detail) => {
  console.error(`  FAIL — ${msg}`, detail ?? '');
  failures++;
};
let passed = 0;
const check = (ok, msg, detail) => {
  if (ok) {
    passed++;
    if (process.env.A11Y_VERBOSE) console.log(`  ok — ${msg}`);
  } else {
    fail(msg, detail);
  }
  return ok;
};

const browser = await chromium.launch({ executablePath: CHROMIUM });

for (const vp of VIEWPORTS) {
  console.log(`\n${vp.name} (${vp.width}×${vp.height} @${vp.dpr}x)`);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  // Issue #105: a never-asked player gets the welcome gate over the board,
  // which inerts everything the audit walks. Answer it as a guest up front.
  await ctx.addInitScript(() => {
    localStorage.setItem('mahjong.profile.v1', JSON.stringify({ choice: 'guest' }));
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__slice !== undefined);

  // --- 1. Traversal: every tile is a named node, in board reading order. ----
  {
    const nodes = await page.evaluate(() =>
      [...document.querySelectorAll('#a11y-layer .tile-node')].map((n) => ({
        id: Number(n.dataset.tileId),
        label: n.getAttribute('aria-label'),
        pressed: n.getAttribute('aria-pressed'),
        disabled: n.getAttribute('aria-disabled'),
        role: n.tagName.toLowerCase(),
      })),
    );
    const tiles = await page.evaluate(() =>
      window.__slice.game.board
        .presentTiles()
        .map((t) => ({ id: t.id, ...t.slot, free: window.__slice.game.board.isFree(t.id) })),
    );
    check(nodes.length === tiles.length, 'tile node count', `${nodes.length} vs ${tiles.length}`);
    check(
      nodes.every((n) => n.role === 'button' && TILE_LABEL.test(n.label ?? '')),
      'every tile node is a named button',
      nodes.find((n) => !TILE_LABEL.test(n.label ?? ''))?.label,
    );
    const expectedOrder = traversalOrder(
      tiles.map((t) => ({ id: t.id, slot: { x: t.x, y: t.y, z: t.z }, face: '', free: t.free })),
    );
    check(
      nodes.every((n, i) => n.id === expectedOrder[i].id),
      'DOM order is board reading order (row, then column, then layer)',
    );
    const byId = new Map(tiles.map((t) => [t.id, t]));
    check(
      nodes.every((n) => n.disabled === String(!byId.get(n.id).free)),
      'blocked tiles are announced as unavailable (aria-disabled)',
    );
    check(
      nodes.every((n) => n.pressed === null),
      'tiles carry no pressed state — selection is gone (issue #93)',
    );

    // The board group carries a name, and the canvas is not double-announced.
    const group = await page.evaluate(() => ({
      role: document.getElementById('a11y-layer').getAttribute('role'),
      label: document.getElementById('a11y-layer').getAttribute('aria-label'),
      canvasHidden: document.querySelector('#board canvas').getAttribute('aria-hidden'),
    }));
    check(group.role === 'group' && !!group.label, 'board layer is a named group', group);
    check(group.canvasHidden === 'true', 'decorative canvas is hidden from AT', group);

    // The computed ARIA tree — resolved role + accessible name per node, the
    // same computation VoiceOver/TalkBack drive their announcements from.
    const axTiles = await page.getByRole('button', { name: TILE_LABEL }).count();
    check(
      axTiles === tiles.length,
      'all tiles exposed in the ARIA tree with a computed accessible name',
      `${axTiles} of ${tiles.length}`,
    );
    const snapshot = await page.locator('#a11y-layer').ariaSnapshot();
    check(
      /^- group "Game board":/m.test(snapshot),
      'ARIA snapshot roots the tiles under a named group',
      snapshot.slice(0, 120),
    );
  }

  // --- 2. Touch-target audit: every interactive target ≥ 48×48 dp. ---------
  {
    const small = await page.evaluate((min) => {
      // Visible targets only; the end-of-level dialog is audited while it is
      // actually open (it is display:none the rest of the time).
      const targets = [
        ...document.querySelectorAll(
          'header button, #booster-rail button, #a11y-layer .tile-node, #overlay button',
        ),
      ].filter((n) => n.offsetParent !== null);
      return targets
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { what: n.id || n.getAttribute('aria-label'), w: r.width, h: r.height };
        })
        .filter((t) => t.w + 0.01 < min || t.h + 0.01 < min);
    }, MIN_TOUCH_TARGET);
    check(small.length === 0, `all touch targets ≥ ${MIN_TOUCH_TARGET}dp`, small.slice(0, 3));

    // Size alone is not enough: a target grown to 48dp must stay centred on
    // the tile it names, or touch-exploration points at the wrong tile.
    const offset = await page.evaluate(() => {
      const canvas = document.querySelector('#board canvas').getBoundingClientRect();
      let worst = { id: null, dx: 0, dy: 0 };
      for (const n of document.querySelectorAll('#a11y-layer .tile-node')) {
        const id = Number(n.dataset.tileId);
        const tile = window.__slice.tileCssRect(id);
        const box = n.getBoundingClientRect();
        const dx = Math.abs(box.x - canvas.x + box.width / 2 - (tile.x + tile.w / 2));
        const dy = Math.abs(box.y - canvas.y + box.height / 2 - (tile.y + tile.h / 2));
        if (dx + dy > worst.dx + worst.dy) worst = { id, dx, dy };
      }
      return worst;
    });
    check(offset.dx < 0.5 && offset.dy < 0.5, 'every focus target is centred on its tile', offset);

    // The check above compares against tileCssRect — the same function that
    // positions the node — so it cannot catch a board-wide offset. This one
    // can: a real pointer tap at a proxy's centre goes through the renderer's
    // *inverse* transform and hitTest, and must land on the tile it names.
    const sample = await page.evaluate(() => {
      const g = window.__slice.game;
      const slice = window.__slice;
      // A centre a player could actually aim at: the #99 stacks are 4–5 deep,
      // and a taller neighbour projects over a lower tile's centre — a tap
      // there hits the neighbour by design. This probe is about the inverse
      // transform, so it samples tiles whose centres are truly visible.
      const centreClear = (id) => {
        const r = slice.tileCssRect(id);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const z = g.board.get(id).slot.z;
        return !g.board.presentTiles().some((t) => {
          if (t.slot.z <= z) return false;
          const h = slice.tileCssRect(t.id);
          return cx >= h.x && cx < h.x + h.w && cy >= h.y && cy < h.y + h.h;
        });
      };
      return g.board
        .presentTiles()
        // Face-up only (issue #64): the tap below must select, not peek.
        .filter((t) => g.board.isFree(t.id) && !g.isFaceHidden(t.id) && centreClear(t.id))
        // Three, not five: each tap parks now (issue #93), and the fourth
        // park would end the level under decision 0009.
        .slice(0, 3)
        .map((t) => {
          const box = document
            .querySelector(`#a11y-layer [data-tile-id="${t.id}"]`)
            .getBoundingClientRect();
          return { id: t.id, x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
    });
    for (const s of sample) {
      await page.mouse.click(s.x, s.y);
      // The tap acts (issue #93): the tile leaves the board — to the holder,
      // or straight out with its match.
      const acted = await page.evaluate(
        (i) => !window.__slice.game.board.presentTiles().some((t) => t.id === i),
        s.id,
      );
      check(acted, 'pointer tap at a focus proxy centre hits that tile', { want: s.id, acted });
    }
    // A fresh deal: the taps above parked tiles the sections below must not
    // inherit (and five parks would sit one short of the loss).
    await page.evaluate(() => document.getElementById('btn-restart').click());
  }

  // --- 3. Every action ≤ 2 taps from the board. ----------------------------
  {
    // Measured, not assumed: an action costs 1 tap only if it is on screen,
    // enabled, and the topmost thing at its own centre. Anything occluded
    // needs at least one extra tap to reveal — which is what a future menu or
    // drawer would look like here. Off-screen controls (the closed dialog)
    // are not actions of this screen and are audited when it opens.
    const UNREACHABLE = 99;
    const controls = await page.evaluate((unreachable) => {
      return [...document.querySelectorAll('button')]
        // Tiles are not HUD actions, and neither are the holder's slots
        // (issue #43): a slot is a tile-shaped target like a board tile, and an
        // empty one is a placeholder with nothing to do. Section 3b audits them.
        .filter(
          (n) =>
            !n.classList.contains('tile-node') &&
            !n.classList.contains('slot') &&
            n.offsetParent !== null,
        )
        .map((n) => {
          const r = n.getBoundingClientRect();
          // Booster labels carry a charge count, so the stable name is the
          // action, declared as data-action (issue #13).
          const name = n.dataset.action ?? n.textContent.trim();
          if (n.disabled) return { name, taps: unreachable, why: 'disabled' };
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!n.contains(top)) {
            return { name, taps: unreachable, why: `occluded by ${top?.id || top?.tagName}` };
          }
          return { name, taps: 1, why: 'direct' };
        });
    }, UNREACHABLE);
    check(
      controls.every((c) => c.taps <= MAX_TAPS_TO_ACTION),
      `every action ≤ ${MAX_TAPS_TO_ACTION} taps from the board`,
      controls,
    );
    check(
      controls.map((c) => c.name).join('|') ===
        'New game|Restart|Hint|Undo|Shuffle|Settings',
      'board screen exposes the complete slice action set',
      controls,
    );
  }

  // --- 3b. The holder strip (issue #43) as assistive technology sees it. ----
  {
    // The strip is the one part of the board that is real DOM rather than a
    // mirror of the canvas, so its semantics are audited here directly: the
    // group is named and counted, an empty slot is out of the tab order (there
    // is nothing to activate), and a parked tile is a named, reachable target
    // at the same 48dp floor every other control has to clear.
    const empty = await page.evaluate(() => {
      const slots = [...document.querySelectorAll('#holder .slot')];
      return {
        group: document.getElementById('holder').getAttribute('aria-label'),
        role: document.getElementById('holder').getAttribute('role'),
        count: slots.length,
        allDisabled: slots.every((n) => n.disabled),
        named: slots.map((n) => n.getAttribute('aria-label')),
        small: slots.filter((n) => {
          const r = n.getBoundingClientRect();
          return r.width < 48 || r.height < 48;
        }).length,
      };
    });
    check(empty.role === 'group' && /0 of 4 slots used/.test(empty.group ?? ''),
      'the holder is a named group that reports its state', empty);
    check(empty.count === 4, 'the holder exposes one node per slot', empty);
    check(empty.allDisabled, 'an empty slot is not a tab stop', empty);
    check(
      empty.named.every((n, i) => n === `Holder slot ${i + 1}, empty`),
      'every empty slot names itself',
      empty,
    );
    check(empty.small === 0, `every holder slot is ≥ ${MIN_TOUCH_TARGET}dp`, empty);

    // Park a tile with the keyboard alone (issue #93): focus its node, one
    // Enter is the whole gesture. Real key presses, not synthesised clicks —
    // the point is that the browser's own key-to-activation step reaches the
    // gesture, because parking has no rail control to fall back on any more.
    const chosen = await page.evaluate(() => {
      const b = window.__slice.game.board;
      // Face-up tiles only (issue #64): Enter on a face-down tile peeks, and
      // this flow is about the two-Enter park gesture.
      const free = b.freeTileIds().filter((id) => !window.__slice.game.isFaceHidden(id));
      const byFace = {};
      for (const id of free) (byFace[b.get(id).face] ??= []).push(id);
      for (const id of free) {
        const partner = (byFace[b.get(id).face] ?? []).find((x) => x !== id);
        if (partner !== undefined) return { id, partner };
      }
      return null;
    });
    check(chosen !== null, 'the deal has a free pair to park from', chosen);
    check(
      await page.evaluate(() => document.getElementById('btn-hold') === null),
      'the rail carries no Hold control (issue #62)',
      null,
    );

    const focused = await page.evaluate((t) => {
      const node = document.querySelector(`#a11y-layer [data-tile-id="${t.id}"]`);
      node.focus();
      return {
        focusedTile: document.activeElement === node,
        label: node.getAttribute('aria-label'),
      };
    }, chosen);
    check(focused.focusedTile, 'a tile node takes keyboard focus', focused);
    check(
      /activate to send it to the holder/i.test(focused.label ?? ''),
      'its name spells out the park action — the explicit a11y path',
      focused,
    );

    await page.keyboard.press('Enter');
    const parked = await page.evaluate((t) => {
      const slot = document.querySelector(`#holder [data-tile-id="${t.id}"]`);
      const r = slot?.getBoundingClientRect();
      return {
        group: document.getElementById('holder').getAttribute('aria-label'),
        label: slot?.getAttribute('aria-label') ?? null,
        disabled: slot?.disabled,
        big: r ? r.width >= 48 && r.height >= 48 : false,
        said: document.getElementById('a11y-status').textContent,
        slots: window.__slice.holder().slots,
      };
    }, chosen);
    check(parked.slots[0] === chosen.id, 'one Enter parks it', parked);
    check(/1 of 4 slots used/.test(parked.group ?? ''), 'the group recounts', parked);
    check(
      parked.label !== null &&
        /, in holder slot 1 — tap its matching tile on the board to clear the pair$/.test(
          parked.label,
        ),
      'a parked tile is named by face, slot, and the way it leaves',
      parked,
    );
    check(parked.disabled === true, 'and is information, not a control (issue #93)', parked);
    check(parked.big, `and is ≥ ${MIN_TOUCH_TARGET}dp`, parked);
    check(/sent to holder slot 1/.test(parked.said ?? ''), 'the hold is announced', parked.said);

    // The one-tap clear, by keyboard: Enter on the partner takes the pair.
    const cleared = await page.evaluate((t) => {
      const node = document.querySelector(`#a11y-layer [data-tile-id="${t.partner}"]`);
      node.focus();
      return document.activeElement === node;
    }, chosen);
    check(cleared, 'the partner takes focus', { cleared });
    await page.keyboard.press('Enter');
    const afterClear = await page.evaluate(() => ({
      slots: window.__slice.holder().slots,
      filled: [...document.querySelectorAll('#holder .slot.filled')].length,
      said: document.getElementById('a11y-status').textContent,
    }));
    check(afterClear.slots[0] === null, 'one Enter clears the pair against the holder', afterClear);
    check(afterClear.filled === 0, 'and the strip empties', afterClear);
    check(/pair matched/i.test(afterClear.said ?? ''), 'and it is announced', afterClear);

    // Undo puts ids the board layer has not seen back into traversal order,
    // which rebuilds every tile node. The board's single tab stop has to
    // survive that — it is the player's place on a 144-tile board.
    const afterUndo = await page.evaluate(() => {
      const board = document.querySelector('#a11y-layer .tile-node[tabindex="0"]');
      board.focus();
      const before = board.dataset.tileId;
      document.getElementById('btn-undo').click();
      const stops = [...document.querySelectorAll('#a11y-layer .tile-node[tabindex="0"]')];
      return { before, after: stops[0]?.dataset.tileId ?? null, stopCount: stops.length };
    });
    check(afterUndo.stopCount === 1, 'the board keeps exactly one tab stop', afterUndo);
    check(
      afterUndo.after === afterUndo.before,
      'and it stays on the tile it was on across an undo',
      afterUndo,
    );

    // Leave the board as it was found.
    await page.evaluate(() => document.getElementById('btn-new').click());
    // Issue #99: New game rotates the layout, so the deal is async while the
    // file fetches; input is dropped until it lands, so wait it out.
    await page.waitForFunction(() => !window.__slice.dealing);
  }

  // --- 3c. The one-way holder's warning and its loss (issue #63). ----------
  //
  // Decision 0009 makes a full holder end the level, which is the one hard-fail
  // in v1. A hard-fail a player can walk into blind is an accessibility defect
  // whatever the rules say, so what is audited here is the *warning*: does the
  // last empty slot say what it is, and does the tile about to be parked say
  // what activating it again would cost — before the activation, not after.
  {
    // Park by keyboard, three times, skipping any face already in the holder
    // (that activation would clear the pair instead — issue #93). The tile's
    // name is read *before* the Enter: the cue must precede the step. Only
    // faces with another free copy on the board are parked, so a takeable
    // board–held pair keeps the level 'playing' up to the fatal park —
    // deal-independent, which matters now that New game re-rolls (issue #94).
    const parkByKeyboard = async () => {
      const target = await page.evaluate(() => {
        const b = window.__slice.game.board;
        const parked = new Set(
          window.__slice
            .holder()
            .slots.filter((id) => id !== null)
            .map((id) => b.get(id).face),
        );
        const free = b.freeTileIds();
        // Face-up only (issue #64): the Enter below must park, not peek.
        const id = free.find(
          (x) =>
            !parked.has(b.get(x).face) &&
            !window.__slice.game.isFaceHidden(x) &&
            free.some((other) => other !== x && b.get(other).face === b.get(x).face),
        );
        if (id === undefined) return null;
        document.querySelector(`#a11y-layer [data-tile-id="${id}"]`).focus();
        return id;
      });
      if (target === null) return null;
      const label = await page.evaluate(
        (id) =>
          document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.getAttribute('aria-label'),
        target,
      );
      await page.keyboard.press('Enter');
      return { target, label };
    };

    let third = null;
    for (let i = 0; i < 3; i++) {
      const step = await parkByKeyboard();
      check(step !== null, `park ${i + 1} found a tile`, step);
      if (step === null) break;
      third = step;
    }
    check(
      /activate to send it to the holder$/.test(third?.label ?? ''),
      'a park with room left offers the action with no warning attached',
      third?.label,
    );

    const warned = await page.evaluate(() => {
      const last = document.querySelector('#holder .slot.last');
      return {
        vacancies: window.__slice.holder().vacancies,
        group: document.getElementById('holder').getAttribute('aria-label'),
        lastCount: document.querySelectorAll('#holder .slot.last').length,
        lastLabel: last?.getAttribute('aria-label'),
        said: document.getElementById('a11y-status').textContent,
      };
    });
    check(warned.vacancies === 1, 'three parks leave one slot', warned);
    check(warned.lastCount === 1, 'exactly one slot is marked as the last', warned);
    check(
      /one slot left/i.test(warned.group ?? '') && /ends the level/i.test(warned.group ?? ''),
      'the holder group names the cost of filling it',
      warned,
    );
    check(
      /empty — the last one; a tile with no match in the holder ends the level/.test(
        warned.lastLabel ?? '',
      ),
      'and the slot itself is not just "empty"',
      warned,
    );
    check(
      /one holder slot left/i.test(warned.said ?? ''),
      'the park that leaves one slot is announced with the warning',
      warned.said,
    );

    // The cue that actually matters: it reaches the tile the player is on,
    // before the activation that ends the level.
    const fatal = await parkByKeyboard();
    check(fatal !== null, 'a fourth tile is available to park', fatal);
    check(
      /activate to send it to the last holder slot, which ends the level/.test(
        fatal?.label ?? '',
      ),
      'the focused tile warns before the activation that loses',
      fatal?.label,
    );

    // The announcement itself is synchronous with the fatal tap — showStatus
    // sets it before presentLossCelebration ever runs (issue #121 delays only
    // the dialog's own appearance, never the announcement) — so it has to be
    // read now, not after the wait below. Waiting first risks a genuinely
    // unrelated announcer.say() landing in between and overwriting the live
    // region: main.ts also schedules a one-off "Daily bonus" announcement
    // 1500ms after boot (the login grant), which is close enough to
    // LOSS_DIALOG_DELAY_MS (~1.4s) that the two can otherwise race.
    const saidImmediately = await page.evaluate(
      () => document.getElementById('a11y-status').textContent,
    );
    check(
      /Holder full\. The level is over\./.test(saidImmediately ?? ''),
      'the loss is announced immediately, with its reason',
      saidImmediately,
    );

    // …and the dialog that follows is a modal that takes focus, offering only
    // the ways out that exist. Keyboard activation focuses the node itself, so
    // the focus set inside showStatus sticks with no repair needed — but issue
    // #121 now plays the slam/shake/wash theatre first and holds the dialog
    // itself back for LOSS_DIALOG_DELAY_MS (~1.4s), so (like the #120 win
    // dialog above) the harness has to wait the sequence out before it can see
    // the dialog's own state. `animating()` already folds the pending timer
    // in.
    await page.waitForFunction(() => !window.__slice.animating(), { timeout: 3000 });
    const lost = await page.evaluate(() => ({
      status: window.__slice.game.status(),
      role: document.getElementById('overlay').getAttribute('role'),
      modal: document.getElementById('overlay').getAttribute('aria-modal'),
      boardInert: document.getElementById('a11y-layer').hasAttribute('inert'),
      holderInert: document.getElementById('holder').hasAttribute('inert'),
      railInert: document.getElementById('booster-rail').hasAttribute('inert'),
      focus: document.activeElement?.id,
      shuffleOffered: !document.getElementById('overlay-shuffle').hidden,
      undoOffered: !document.getElementById('overlay-undo').hidden,
    }));
    check(lost.status === 'lost', 'the fourth park ends the level', lost);
    check(lost.role === 'dialog' && lost.modal === 'true', 'the loss is a modal dialog', lost);
    check(
      lost.boardInert && lost.holderInert && lost.railInert,
      'and everything behind it is inert',
      lost,
    );
    check(lost.focus === 'overlay-restart', 'focus moves to the only way out', lost);
    check(!lost.shuffleOffered && !lost.undoOffered, 'no Shuffle, no Undo — it is final', lost);

    // Leave the board as it was found.
    await page.click('#overlay-restart');
    await page.evaluate(() => document.getElementById('btn-new').click());
    // Issue #99: New game rotates the layout, so the deal is async while the
    // file fetches; input is dropped until it lands, so wait it out.
    await page.waitForFunction(() => !window.__slice.dealing);
  }

  // --- 4. Keyboard-only play: traverse, match, hear the outcome. -----------
  {
    // Reload for a clean sequential-focus starting point: clicking the canvas
    // above moved it past the header, so a fixed Tab count would be
    // order-dependent. The property under test is not "3 tabs" anyway.
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const inLayer = () =>
      page.evaluate(() => document.activeElement?.closest('#a11y-layer') !== null);
    let stops = 0;
    while (stops < 10 && !(await inLayer())) {
      await page.keyboard.press('Tab');
      stops++;
    }
    check(await inLayer(), 'keyboard reaches the board', { stops });
    // The decisive property: 144 tiles are ONE tab stop, not 144 — asserted on
    // the roving tabindex directly rather than by tabbing off the end of the
    // document (which hands focus to browser chrome, not to the page).
    const roving = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#a11y-layer .tile-node')];
      return {
        total: nodes.length,
        tabbable: nodes.filter((n) => n.tabIndex === 0).length,
        rest: nodes.filter((n) => n.tabIndex === -1).length,
        focusedIsTabbable: document.activeElement?.tabIndex === 0,
      };
    });
    check(
      roving.tabbable === 1 && roving.rest === roving.total - 1 && roving.focusedIsTabbable,
      'the whole board is a single tab stop (roving tabindex)',
      roving,
    );

    // Arrow keys walk the board; the focused node must change and stay a tile.
    const before = await page.evaluate(() => document.activeElement.dataset.tileId);
    await page.keyboard.press('ArrowRight');
    const afterRight = await page.evaluate(() => document.activeElement.dataset.tileId);
    check(afterRight !== undefined && afterRight !== before, 'ArrowRight moves focus', {
      before,
      afterRight,
    });
    await page.keyboard.press('End');
    const atEnd = await page.evaluate(() => document.activeElement.dataset.tileId);
    await page.keyboard.press('Home');
    const atHome = await page.evaluate(() => document.activeElement.dataset.tileId);
    check(atEnd !== atHome, 'Home/End jump to the ends of the board', { atHome, atEnd });

    // Match the first pair of the generator's solution witness with the
    // keyboard alone: focus the node (what AT focus does) and press Enter.
    const [a, b] = await page.evaluate(() => window.__slice.game.level.solution[0]);
    const tilesBefore = await page.evaluate(() => window.__slice.game.tilesLeft);
    for (const id of [a, b]) {
      await page.evaluate((tileId) => {
        document.querySelector(`#a11y-layer [data-tile-id="${tileId}"]`).focus();
      }, id);
      const pressedFocus = await page.evaluate(() => document.activeElement.dataset.tileId);
      check(Number(pressedFocus) === id, 'focus lands on the intended tile', { id, pressedFocus });
      // A face-down tile takes an extra Enter — the peek (issue #64).
      if (await page.evaluate((i) => window.__slice.game.isFaceHidden(i), id)) {
        await page.keyboard.press('Enter');
      }
      await page.keyboard.press('Enter');
    }
    const after = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      status: document.getElementById('a11y-status').textContent,
      focusInLayer: document.activeElement?.closest('#a11y-layer') !== null,
      focusIsTile: document.activeElement?.classList.contains('tile-node') === true,
    }));
    check(after.tilesLeft === tilesBefore - 2, 'keyboard match removed the pair', after);
    check(
      /pair matched in the holder\./.test(after.status),
      'match is announced politely',
      after.status,
    );
    check(
      after.focusInLayer && after.focusIsTile,
      'focus stays on the board after the matched tiles are removed',
      after,
    );

    // The park itself is announced — the first half of every pair transits
    // the holder now (issue #93), and a screen-reader player has to hear
    // where their tile went.
    const [c] = await page.evaluate(() => window.__slice.game.level.solution[1]);
    await page.evaluate((tileId) => {
      document.querySelector(`#a11y-layer [data-tile-id="${tileId}"]`).focus();
    }, c);
    // Extra Enter to peek first if the tile is face-down (issue #64).
    if (await page.evaluate((i) => window.__slice.game.isFaceHidden(i), c)) {
      await page.keyboard.press('Enter');
    }
    await page.keyboard.press('Enter');
    const parkSaid = await page.evaluate(
      () => document.getElementById('a11y-status').textContent,
    );
    check(/sent to holder slot \d/.test(parkSaid ?? ''), 'a park is announced', parkSaid);

    // A blocked tile is announced, never silently ignored.
    const blockedId = await page.evaluate(() => {
      const g = window.__slice.game;
      return g.board.presentTiles().find((t) => !g.board.isFree(t.id))?.id ?? null;
    });
    if (blockedId !== null) {
      await page.evaluate((tileId) => {
        document.querySelector(`#a11y-layer [data-tile-id="${tileId}"]`).focus();
      }, blockedId);
      await page.keyboard.press('Enter');
      const said = await page.evaluate(() => document.getElementById('a11y-status').textContent);
      check(/is blocked by another tile/.test(said), 'blocked tap is announced', said);
    }
  }

  // --- 5. End-of-level dialog is modal and takes focus. --------------------
  {
    // Finish the level through the a11y layer only.
    await page.evaluate(() => {
      const { game } = window.__slice;
      const click = (id) =>
        document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      // Issue #64: the first activation of a face-down tile only peeks.
      const act = (id) => {
        if (game.isFaceHidden(id)) click(id);
        click(id);
      };
      // Replay the remaining witness pairs; already-removed pairs are no-ops.
      for (const [a, b] of game.level.solution) {
        if (game.board.get(a).removed || game.board.get(b).removed) continue;
        act(a);
        act(b);
      }
    });
    // Issue #120: the win dialog waits out the celebration's
    // WIN_DIALOG_DELAY_MS (~600ms) before it opens and takes focus —
    // `animating()` folds that pending delay in, so the harness's usual
    // settle-wait covers it here too.
    await page.waitForFunction(() => !window.__slice.animating(), { timeout: 2000 });
    const end = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      status: window.__slice.game.status(),
      dialogRole: document.getElementById('overlay').getAttribute('role'),
      modal: document.getElementById('overlay').getAttribute('aria-modal'),
      labelled: document.getElementById('overlay').getAttribute('aria-labelledby'),
      boardInert: document.getElementById('a11y-layer').hasAttribute('inert'),
      focus: document.activeElement?.id,
      announced: document.getElementById('a11y-status').textContent,
    }));
    check(end.tilesLeft === 0 && end.status === 'won', 'level cleared via the a11y layer', end);
    check(
      end.dialogRole === 'dialog' && end.modal === 'true' && end.labelled === 'overlay-title',
      'end-of-level overlay is a labelled modal dialog',
      end,
    );
    check(end.boardInert, 'board is inert while the dialog is open', end);
    // The won dialog hides Restart and offers Next level (issue #79).
    check(end.focus === 'overlay-new', 'focus moves into the dialog', end);

    // aria-modal only silences the background for AT; Tab still walks into it
    // unless the background is inert. Shift+Tab out of the dialog must stay
    // inside the dialog, never reach the header controls behind it.
    await page.keyboard.press('Shift+Tab');
    const back1 = await page.evaluate(() => document.activeElement?.id);
    await page.keyboard.press('Shift+Tab');
    const back2 = await page.evaluate(() => document.activeElement?.id);
    check(
      !BACKGROUND_CONTROLS.includes(back1) && !BACKGROUND_CONTROLS.includes(back2),
      'dialog traps focus: Tab never reaches the controls behind it',
      { back1, back2 },
    );
    check(/Level \d+ complete\./.test(end.announced), 'win is announced', end.announced);

    // Dialog buttons are 1 tap and meet the 48dp minimum while visible.
    const smallInDialog = await page.evaluate((min) => {
      // The deadlock-only controls (issue #13) are hidden on a win, and a
      // display:none control has no size to audit; they are measured while the
      // stuck dialog shows them — see qa/e2e-slice.mjs.
      return [...document.querySelectorAll('#overlay button')]
        .filter((n) => n.offsetParent !== null)
        .map((n) => ({ id: n.id, ...n.getBoundingClientRect().toJSON() }))
        .filter((r) => r.width + 0.01 < min || r.height + 0.01 < min);
    }, MIN_TOUCH_TARGET);
    check(smallInDialog.length === 0, 'dialog controls ≥ 48dp', smallInDialog);

    // Advancing to the next level hands the board back to assistive
    // technology (issue #79: the won dialog's action is Next level, and the
    // deal is async when the next level's layout differs).
    await page.click('#overlay-new');
    await page.waitForFunction(() => !window.__slice.dealing);
    const back = await page.evaluate(() => ({
      inert: document.getElementById('a11y-layer').hasAttribute('inert'),
      tiles: document.querySelectorAll('#a11y-layer .tile-node').length,
      focusIsTile: document.activeElement?.classList.contains('tile-node') === true,
      announced: document.getElementById('a11y-status').textContent,
    }));
    check(!back.inert && back.tiles === 144, 'restart restores a traversable board', back);
    check(
      back.focusIsTile,
      'restarting from the dialog hands focus back to the board, not <body>',
      back,
    );
    check(/New game dealt\./.test(back.announced), 'new deal is announced', back.announced);
  }

  // --- 6. Settings screen is a modal, named, 48dp, and keyboard-escapable. --
  {
    await page.click('#btn-settings');
    const open = await page.evaluate(() => {
      const panel = document.getElementById('settings');
      return {
        role: panel.getAttribute('role'),
        modal: panel.getAttribute('aria-modal'),
        labelled: panel.getAttribute('aria-labelledby'),
        focus: document.activeElement?.id,
        boardInert: document.getElementById('a11y-layer').hasAttribute('inert'),
        entryInert: document.getElementById('btn-settings').hasAttribute('inert'),
        announced: document.getElementById('a11y-status').textContent,
      };
    });
    check(
      open.role === 'dialog' && open.modal === 'true' && open.labelled === 'settings-title',
      'settings screen is a labelled modal dialog',
      open,
    );
    check(open.focus === 'set-audio', 'focus moves into the settings screen', open);
    check(
      open.boardInert && open.entryInert,
      'board and the settings entry point are inert while it is open',
      open,
    );

    // Every control named (a label element or aria-label) and ≥ 48dp. The
    // checkbox itself is smaller than 48dp on purpose: the whole label row is
    // the target, which is what a finger actually hits.
    const settingsControls = await page.evaluate((min) => {
      const rows = [...document.querySelectorAll('#settings .row, #settings button')];
      return rows.map((n) => {
        const r = n.getBoundingClientRect();
        const name = (n.textContent ?? '').trim() || n.getAttribute('aria-label') || '';
        return { name, w: Math.round(r.width), h: Math.round(r.height), small: r.height + 0.01 < min };
      });
    }, MIN_TOUCH_TARGET);
    check(
      settingsControls.every((c) => c.name.length > 0),
      'every settings control has an accessible name',
      settingsControls.filter((c) => c.name.length === 0),
    );
    check(
      settingsControls.every((c) => !c.small),
      'settings rows and buttons are ≥ 48dp tall',
      settingsControls.filter((c) => c.small),
    );

    // Fourteen controls: the profile row (issue #69), the Daily Challenge row
    // (issue #19), five toggles (issue #45 added Highlight free tiles, issue
    // #44 added Reduced motion; the timer toggle was retired 2026-09-01), four
    // tile sizes, the Send feedback row (issue #118), the version row
    // (issue #81), and Done.
    check(settingsControls.length === 14, 'settings screen exposes all fourteen controls', {
      count: settingsControls.length,
    });

    // Escape is the keyboard way out, and focus must come back to the control
    // that opened it — not <body>, which would strand a keyboard player.
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => ({
      visible: document.getElementById('settings').classList.contains('visible'),
      focus: document.activeElement?.id,
      boardInert: document.getElementById('a11y-layer').hasAttribute('inert'),
    }));
    check(!closed.visible, 'Escape closes the settings screen', closed);
    check(closed.focus === 'btn-settings', 'focus returns to the settings button', closed);
    check(!closed.boardInert, 'closing settings gives the board back', closed);
  }

  // --- 7. Feedback form is a labelled modal, its fields are named and ------
  //        48dp, Send starts disabled, and Escape returns focus (issue #118).
  {
    await page.click('#btn-settings');
    await page.click('#btn-feedback');
    const open = await page.evaluate(() => {
      const panel = document.getElementById('feedback');
      const summary = document.getElementById('feedback-summary');
      const body = document.getElementById('feedback-body');
      const summaryLabel = document.querySelector('label[for="feedback-summary"]');
      const bodyLabel = document.querySelector('label[for="feedback-body"]');
      const send = document.getElementById('feedback-send');
      return {
        role: panel.getAttribute('role'),
        modal: panel.getAttribute('aria-modal'),
        labelled: panel.getAttribute('aria-labelledby'),
        focus: document.activeElement?.id,
        boardInert: document.getElementById('a11y-layer').hasAttribute('inert'),
        settingsInert: document.getElementById('btn-settings').hasAttribute('inert'),
        hasSummaryLabel: summaryLabel !== null && summaryLabel.textContent.trim().length > 0,
        hasBodyLabel: bodyLabel !== null && bodyLabel.textContent.trim().length > 0,
        sendDisabled: send.disabled,
        summaryH: Math.round(summary.getBoundingClientRect().height),
        bodyH: Math.round(body.getBoundingClientRect().height),
        sendH: Math.round(send.getBoundingClientRect().height),
      };
    });
    check(
      open.role === 'dialog' && open.modal === 'true' && open.labelled === 'feedback-title',
      'feedback form is a labelled modal dialog',
      open,
    );
    check(open.focus === 'feedback-summary', 'focus moves into the Summary field', open);
    check(
      open.boardInert && open.settingsInert,
      'board and Settings are inert while the feedback form is open',
      open,
    );
    check(open.hasSummaryLabel && open.hasBodyLabel, 'Summary and Body are both labelled', open);
    check(open.sendDisabled, 'Send starts disabled with both fields empty', open);
    check(
      open.summaryH >= MIN_TOUCH_TARGET && open.bodyH >= MIN_TOUCH_TARGET && open.sendH >= MIN_TOUCH_TARGET,
      `Summary, Body and Send are all ≥ ${MIN_TOUCH_TARGET}dp`,
      open,
    );

    // Filling both fields enables Send; the value is read from the DOM
    // (`input` events), matching how a real keyboard or IME would type.
    await page.fill('#feedback-summary', 'Tiles overlap');
    await page.fill('#feedback-body', 'The bamboo tile clips the dot tile.');
    const filled = await page.evaluate(() => document.getElementById('feedback-send').disabled);
    check(!filled, 'Send enables once both fields have content', { disabled: filled });

    // Attachments (issue #130): the Add control is a named ≥ 48dp button,
    // the strip is a labelled list, and each thumbnail's Remove is a named
    // ≥ 48dp button that hands focus back to Add when it goes.
    const attachOpen = await page.evaluate(() => {
      const add = document.getElementById('feedback-attach');
      const list = document.getElementById('feedback-attachments');
      return {
        addName: add.textContent.trim(),
        addH: Math.round(add.getBoundingClientRect().height),
        addW: Math.round(add.getBoundingClientRect().width),
        listLabel: list.getAttribute('aria-label'),
        listHidden: list.hidden,
        inputHidden: document.getElementById('feedback-file').hidden,
      };
    });
    check(attachOpen.addName.length > 0, 'the attach control is named', attachOpen);
    check(
      attachOpen.addH >= MIN_TOUCH_TARGET && attachOpen.addW >= MIN_TOUCH_TARGET,
      `the attach control is ≥ ${MIN_TOUCH_TARGET}dp`,
      attachOpen,
    );
    check(attachOpen.listLabel === 'Attachments', 'the thumbnail strip is a labelled list', attachOpen);
    check(attachOpen.listHidden && attachOpen.inputHidden, 'strip and native input start hidden', attachOpen);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 40, height: 40 } });
    await page.setInputFiles('#feedback-file', { name: 'shot.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => document.querySelectorAll('#feedback-attachments li').length === 1);
    const attached = await page.evaluate(() => {
      const remove = document.querySelector('#feedback-attachments .remove');
      return {
        removeLabel: remove.getAttribute('aria-label'),
        removeH: Math.round(remove.getBoundingClientRect().height),
        removeW: Math.round(remove.getBoundingClientRect().width),
        imgAlt: document.querySelector('#feedback-attachments img')?.getAttribute('alt'),
        listHidden: document.getElementById('feedback-attachments').hidden,
      };
    });
    check(attached.removeLabel === 'Remove shot.png', 'each thumbnail has a named Remove control', attached);
    check(
      attached.removeH >= MIN_TOUCH_TARGET && attached.removeW >= MIN_TOUCH_TARGET,
      `Remove is ≥ ${MIN_TOUCH_TARGET}dp`,
      attached,
    );
    check(attached.imgAlt === '', 'the thumbnail is decorative (the name is the text)', attached);
    await page.click('#feedback-attachments .remove');
    const removed = await page.evaluate(() => ({
      count: document.querySelectorAll('#feedback-attachments li').length,
      listHidden: document.getElementById('feedback-attachments').hidden,
      focus: document.activeElement?.id,
    }));
    check(removed.count === 0 && removed.listHidden, 'Remove takes the thumbnail away', removed);
    check(removed.focus === 'feedback-attach', 'focus lands on Add after a Remove', removed);

    // Issue #135: after a failed send, Copy report is a named ≥ 48dp button,
    // the inbox address is readable text, and "Copied" lands in a status
    // region so screen readers hear it.
    await page.route('**/api/feedback', (route) => route.fulfill({ status: 503, body: '{}' }));
    await page.click('#feedback-send');
    await page.waitForFunction(() => !document.getElementById('feedback-copy').hidden);
    const copyOffered = await page.evaluate(() => {
      const copy = document.getElementById('feedback-copy');
      const status = document.getElementById('feedback-copy-status');
      const inbox = document.getElementById('feedback-inbox');
      return {
        copyName: copy.textContent.trim(),
        copyH: Math.round(copy.getBoundingClientRect().height),
        copyW: Math.round(copy.getBoundingClientRect().width),
        statusLive: status.getAttribute('aria-live'),
        inboxVisible: !inbox.hidden && getComputedStyle(inbox).display !== 'none',
        inboxText: inbox.textContent,
      };
    });
    check(copyOffered.copyName === 'Copy report', 'the copy control is named', copyOffered);
    check(
      copyOffered.copyH >= MIN_TOUCH_TARGET && copyOffered.copyW >= MIN_TOUCH_TARGET,
      `Copy report is ≥ ${MIN_TOUCH_TARGET}dp`,
      copyOffered,
    );
    check(copyOffered.statusLive === 'polite', 'the Copied confirmation is a polite live region', copyOffered);
    check(
      copyOffered.inboxVisible && /@/.test(copyOffered.inboxText),
      'the inbox address is shown as plain text',
      copyOffered,
    );
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
    await page.click('#feedback-copy');
    await page.waitForFunction(() => document.getElementById('feedback-copy-status').textContent !== '');
    const copiedStatus = await page.evaluate(() => document.getElementById('feedback-copy-status').textContent);
    check(copiedStatus === 'Copied', 'Copy report confirms with "Copied"', { copiedStatus });
    await page.unroute('**/api/feedback');

    // Escape is the keyboard way out, and focus must land back on the
    // Settings button that Send feedback led away from — not <body>.
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => ({
      visible: document.getElementById('feedback').classList.contains('visible'),
      focus: document.activeElement?.id,
      summaryValue: document.getElementById('feedback-summary').value,
    }));
    check(!closed.visible, 'Escape closes the feedback form', closed);
    check(closed.focus === 'btn-settings', 'focus returns to the settings button', closed);
    check(closed.summaryValue === 'Tiles overlap', 'Escape keeps the typed text, not just discards it', closed);
  }

  await ctx.close();
}

await browser.close();
server.close();
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nall ${VIEWPORTS.length} viewports passed the accessibility audit (${passed} checks)`);
