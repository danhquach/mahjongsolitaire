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
//   4. a pair can be matched with the keyboard alone, outcomes are announced,
//      and focus survives the tiles being removed;
//   5. the end-of-level dialog is modal and takes focus.
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
const TILE_LABEL = /^.+, (available|blocked), row \d+, column \d+$/;

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
      nodes.every((n) => n.pressed === 'false'),
      'no tile starts selected',
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
        ...document.querySelectorAll('header button, #a11y-layer .tile-node, #overlay button'),
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
      const canvas = document.querySelector('#board canvas').getBoundingClientRect();
      return g.board
        .presentTiles()
        .filter((t) => g.board.isFree(t.id))
        .slice(0, 5)
        .map((t) => {
          const box = document
            .querySelector(`#a11y-layer [data-tile-id="${t.id}"]`)
            .getBoundingClientRect();
          return { id: t.id, x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
    });
    for (const s of sample) {
      await page.mouse.click(s.x, s.y);
      const hit = await page.evaluate(() => window.__slice.game.selection);
      check(hit === s.id, 'pointer tap at a focus proxy centre hits that tile', { want: s.id, hit });
      await page.mouse.click(s.x, s.y); // deselect, leave the board untouched
    }
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
        .filter((n) => !n.classList.contains('tile-node') && n.offsetParent !== null)
        .map((n) => {
          const r = n.getBoundingClientRect();
          const name = n.textContent.trim();
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
      controls.map((c) => c.name).join('|') === 'New game|Restart',
      'board screen exposes the complete slice action set',
      controls,
    );
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
      await page.keyboard.press('Enter');
    }
    const after = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      status: document.getElementById('a11y-status').textContent,
      focusInLayer: document.activeElement?.closest('#a11y-layer') !== null,
      focusIsTile: document.activeElement?.classList.contains('tile-node') === true,
    }));
    check(after.tilesLeft === tilesBefore - 2, 'keyboard match removed the pair', after);
    check(/pair matched\./.test(after.status), 'match is announced politely', after.status);
    check(
      after.focusInLayer && after.focusIsTile,
      'focus stays on the board after the matched tiles are removed',
      after,
    );

    // aria-pressed carries selection state for the first tap of a pair.
    const [c] = await page.evaluate(() => window.__slice.game.level.solution[1]);
    await page.evaluate((tileId) => {
      document.querySelector(`#a11y-layer [data-tile-id="${tileId}"]`).focus();
    }, c);
    await page.keyboard.press('Enter');
    const pressed = await page.evaluate(
      (tileId) =>
        document
          .querySelector(`#a11y-layer [data-tile-id="${tileId}"]`)
          .getAttribute('aria-pressed'),
      c,
    );
    check(pressed === 'true', 'selected tile reports aria-pressed=true', pressed);
    await page.keyboard.press('Enter'); // deselect, leave the board clean

    // A face mismatch is announced too — otherwise nothing tells a screen
    // reader user why the board did not change.
    const pair = await page.evaluate(() => {
      const g = window.__slice.game;
      const free = g.board.presentTiles().filter((t) => g.board.isFree(t.id));
      for (const a of free) {
        const b = free.find((x) => x.id !== a.id && x.face !== a.face);
        if (b) return [a.id, b.id];
      }
      return null;
    });
    if (pair) {
      for (const id of pair) {
        await page.evaluate((tileId) => {
          document.querySelector(`#a11y-layer [data-tile-id="${tileId}"]`).focus();
        }, id);
        await page.keyboard.press('Enter');
      }
      const said = await page.evaluate(() => document.getElementById('a11y-status').textContent);
      check(/ do not match\./.test(said), 'face mismatch is announced', said);
      // The mismatch leaves the second tile selected (spec §6); clear it.
      await page.keyboard.press('Enter');
    }

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
      // Replay the remaining witness pairs; already-removed pairs are no-ops.
      for (const [a, b] of game.level.solution) {
        if (game.board.get(a).removed || game.board.get(b).removed) continue;
        click(a);
        click(b);
      }
    });
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
    check(end.focus === 'overlay-restart', 'focus moves into the dialog', end);

    // aria-modal only silences the background for AT; Tab still walks into it
    // unless the background is inert. Shift+Tab out of the dialog must stay
    // inside the dialog, never reach the header controls behind it.
    await page.keyboard.press('Shift+Tab');
    const back1 = await page.evaluate(() => document.activeElement?.id);
    await page.keyboard.press('Shift+Tab');
    const back2 = await page.evaluate(() => document.activeElement?.id);
    check(
      !['btn-new', 'btn-restart'].includes(back1) && !['btn-new', 'btn-restart'].includes(back2),
      'dialog traps focus: Tab never reaches the controls behind it',
      { back1, back2 },
    );
    check(/Level complete\./.test(end.announced), 'win is announced', end.announced);

    // Dialog buttons are 1 tap and meet the 48dp minimum while visible.
    const smallInDialog = await page.evaluate((min) => {
      return [...document.querySelectorAll('#overlay button')]
        .map((n) => ({ id: n.id, ...n.getBoundingClientRect().toJSON() }))
        .filter((r) => r.width + 0.01 < min || r.height + 0.01 < min);
    }, MIN_TOUCH_TARGET);
    check(smallInDialog.length === 0, 'dialog controls ≥ 48dp', smallInDialog);

    // Restarting hands the board back to assistive technology.
    await page.click('#overlay-restart');
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

  await ctx.close();
}

await browser.close();
server.close();
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nall ${VIEWPORTS.length} viewports passed the accessibility audit (${passed} checks)`);
