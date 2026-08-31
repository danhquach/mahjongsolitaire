// End-to-end acceptance check for issue #11: one full Turtle level playable
// in a real browser on phone + tablet viewports, portrait + landscape, at
// real device pixel ratios.
//
// Not part of `npm test` (needs a browser); run manually or from CI:
//   npm run build && node qa/e2e-slice.mjs
// Set CHROMIUM_PATH if Chromium is not at the default container location.
//
// Drives real pointer events at tile screen positions (via the window.__slice
// debug handle) through the same hit-test path a player's taps take, plays the
// generator's solution witness to completion, and asserts the win overlay.
// Also exercises the 8dp mis-tap forgiveness and asserts the board actually
// fills the viewport (guards HiDPI scaling regressions), and — for issue #13 —
// drives the three boosters through their real buttons, checking that a charge
// is spent per successful use and that the balances survive a page reload.
// For issue #14 it force-quits mid-level (a real page reload) and asserts the
// board, score, selection and settings all come back, and that a won level
// leaves no save behind.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const DIST = new URL('../dist-web', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

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

const browser = await chromium.launch({ executablePath: CHROMIUM });
let failures = 0;

/**
 * Deal and play naive greedy lines in the page until one deadlocks — how a real
 * player walks into a dead end — and report the stuck dialog's state. Returns
 * null if 12 deals all worked out. Runs entirely in the page (tile activation
 * through the a11y layer), so it costs no round-trips per move.
 */
function huntDeadlock() {
  const slice = window.__slice;
  const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
  const pairs = () => {
    const byFace = {};
    for (const c of slice.game.hitCandidates()) {
      if (c.free) (byFace[slice.game.board.get(c.id).face] ??= []).push(c.id);
    }
    return Object.values(byFace)
      .filter((ids) => ids.length > 1)
      .map((ids) => [ids[0], ids[1]]);
  };
  for (let deal = 0; deal < 12; deal++) {
    document.getElementById('btn-new').click();
    for (let move = 0; slice.game.status() === 'playing' && move < 200; move++) {
      const options = pairs();
      // Deterministic but unstrategic pick: the point is to lose sometimes.
      const [a, b] = options[(deal * 7 + move * 3) % options.length];
      click(a);
      click(b);
    }
    if (slice.game.status() === 'stuck') {
      return {
        deal,
        tilesLeft: slice.game.tilesLeft,
        title: document.getElementById('overlay-title').textContent,
        shuffleOffered: !document.getElementById('overlay-shuffle').hidden,
        undoOffered: !document.getElementById('overlay-undo').hidden,
        focus: document.activeElement?.id,
        charges: slice.boosterCharges(),
      };
    }
  }
  return null;
}

function check(ok, label, data) {
  if (ok) return;
  console.error(`  ${label} FAIL:`, data);
  failures++;
}

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    console.error(`  page error: ${e.message}`);
    failures++;
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__slice !== undefined);

  // Page coordinates of a tile's top-face center, via the app's own geometry.
  const tileCenter = (id) =>
    page.evaluate((tileId) => {
      const r = window.__slice.tileCssRect(tileId);
      const c = document.querySelector('#board canvas').getBoundingClientRect();
      return { x: c.x + r.x + r.w / 2, y: c.y + r.y + r.h / 2 };
    }, id);

  // 1. The board fills the viewport: the scaled board spans ≥ 90% of the
  //    canvas along its constraining axis (catches HiDPI 1/DPR-scale bugs).
  {
    const extent = await page.evaluate(() => {
      const { game, renderer } = window.__slice;
      const xs = game.hitCandidates().map((t) => window.__slice.tileCssRect(t.id));
      const maxX = Math.max(...xs.map((r) => r.x + r.w));
      const minX = Math.min(...xs.map((r) => r.x));
      const maxY = Math.max(...xs.map((r) => r.y + r.h));
      const minY = Math.min(...xs.map((r) => r.y));
      const canvas = document.querySelector('#board canvas');
      return {
        boardW: maxX - minX,
        boardH: maxY - minY,
        canvasW: canvas.clientWidth,
        canvasH: canvas.clientHeight,
        scale: renderer.scale,
      };
    });
    const fillW = extent.boardW / extent.canvasW;
    const fillH = extent.boardH / extent.canvasH;
    if (Math.max(fillW, fillH) < 0.9) {
      console.error(`  EXTENT FAIL (dpr ${vp.dpr}):`, extent);
      failures++;
    }
  }

  // 2. Mis-tap forgiveness: tap 6 CSS px outside a free tile's edge → selected.
  {
    const probe = await page.evaluate(() => {
      const { game } = window.__slice;
      // The leftmost free tile (the turtle's left wing) has open space to its left.
      const t = game
        .hitCandidates()
        .filter((c) => c.free)
        .sort((a, b) => a.slot.x - b.slot.x)[0];
      const r = window.__slice.tileCssRect(t.id);
      const c = document.querySelector('#board canvas').getBoundingClientRect();
      return { id: t.id, x: c.x + r.x - 6, y: c.y + r.y + r.h / 2 };
    });
    await page.mouse.click(probe.x, probe.y);
    const sel = await page.evaluate(() => window.__slice.game.selection);
    if (sel !== probe.id) {
      console.error(`  FORGIVENESS FAIL: expected selection ${probe.id}, got ${sel}`);
      failures++;
    }
    await page.mouse.click(probe.x, probe.y); // deselect via the same forgiven tap
  }

  // 3. Play the generator's solution witness end-to-end with real taps.
  const solution = await page.evaluate(() => window.__slice.game.level.solution);
  for (const [a, b] of solution) {
    for (const id of [a, b]) {
      const c = await tileCenter(id);
      await page.mouse.click(c.x, c.y);
    }
  }
  const result = await page.evaluate(() => ({
    tilesLeft: window.__slice.game.tilesLeft,
    status: window.__slice.game.status(),
    score: window.__slice.game.score,
    overlay: document.getElementById('overlay-title').textContent,
    overlayVisible: document.getElementById('overlay').classList.contains('visible'),
  }));
  const ok =
    result.tilesLeft === 0 &&
    result.status === 'won' &&
    result.overlayVisible &&
    result.overlay === 'Level complete!';
  if (!ok) {
    console.error(`  END-TO-END FAIL:`, result);
    failures++;
  }
  console.log(
    `${ok ? 'ok' : 'FAIL'} — ${vp.name} (${vp.width}×${vp.height} @${vp.dpr}x): level cleared, score ${result.score}`,
  );

  // 4. Boosters (issue #13) driven through their real buttons: each one does
  //    its job, a charge is spent only when it did something, and the balances
  //    outlive a reload (the acceptance criterion "charges persist across
  //    restarts"). Runs after the win on a restarted deal.
  {
    const before = failures;
    await page.click('#overlay-restart');
    const start = await page.evaluate(() => window.__slice.boosterCharges());
    check(
      start.hint === 5 && start.undo === 5 && start.shuffle === 5,
      'starting grant is 5 of each',
      start,
    );

    // Hint: highlights a playable pair, spends 1, announces where it is.
    await page.click('#btn-hint');
    const hint1 = await page.evaluate(() => {
      const g = window.__slice.game;
      const byFace = {};
      for (const c of g.hitCandidates()) {
        if (c.free) (byFace[g.board.get(c.id).face] ??= []).push(c.id);
      }
      return {
        pair: [...window.__slice.hintPair],
        charges: window.__slice.boosterCharges(),
        said: document.getElementById('a11y-status').textContent,
        freePairs: Object.values(byFace).reduce(
          (n, ids) => n + (ids.length * (ids.length - 1)) / 2,
          0,
        ),
      };
    });
    check(hint1.pair.length === 2, 'hint highlights a pair', hint1);
    check(hint1.charges.hint === 4, 'hint spent one charge', hint1.charges);
    check(
      /^Hint: two .+ tiles, row \d+ column \d+ and row \d+ column \d+\. 4 hints left\.$/.test(
        hint1.said.trim(),
      ),
      'hint is announced with both positions and the balance',
      hint1.said,
    );

    // A repeat press cycles to another pair (spec §5), when one exists.
    await page.click('#btn-hint');
    const hint2 = await page.evaluate(() => [...window.__slice.hintPair]);
    check(
      hint1.freePairs > 1
        ? String(hint2) !== String(hint1.pair)
        : String(hint2) === String(hint1.pair),
      'repeat hint cycles to a different pair',
      { hint1: hint1.pair, hint2, freePairs: hint1.freePairs },
    );

    // Play the hinted pair with real taps, then Undo it: board, score and
    // selection come back; Undo costs one charge, Hint is untouched.
    for (const id of hint2) {
      const c = await tileCenter(id);
      await page.mouse.click(c.x, c.y);
    }
    const matched = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
    }));
    check(matched.tilesLeft === 142 && matched.score > 0, 'hinted pair is matchable', matched);
    await page.click('#btn-undo');
    const undone = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(
      undone.tilesLeft === 144 && undone.score === 0,
      'undo restores the pair and the score',
      undone,
    );
    check(
      undone.charges.undo === 4 && undone.charges.hint === 3,
      'undo spent exactly one undo charge',
      undone.charges,
    );
    check(/4 undos left\.$/.test(undone.said.trim()), 'undo announces the balance', undone.said);

    // Undo with an empty stack: no charge, and it says why.
    await page.click('#btn-undo');
    const noUndo = await page.evaluate(() => ({
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(noUndo.charges.undo === 4, 'a no-op undo costs nothing', noUndo);
    check(/Nothing to undo yet\./.test(noUndo.said), 'a no-op undo explains itself', noUndo.said);

    // Shuffle: same tiles in the same slots, still playable, one charge spent.
    const beforeShuffle = await page.evaluate(() =>
      window.__slice.game.board
        .presentTiles()
        .map((t) => [t.id, t.face].join(':'))
        .join(','),
    );
    await page.click('#btn-shuffle');
    const shuffled = await page.evaluate(() => ({
      signature: window.__slice.game.board
        .presentTiles()
        .map((t) => [t.id, t.face].join(':'))
        .join(','),
      tilesLeft: window.__slice.game.tilesLeft,
      status: window.__slice.game.status(),
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(shuffled.tilesLeft === 144, 'shuffle keeps every tile in play', shuffled);
    check(shuffled.status === 'playing', 'shuffled board is playable', shuffled);
    check(shuffled.signature !== beforeShuffle, 'shuffle re-randomized the faces', {
      changed: shuffled.signature !== beforeShuffle,
    });
    check(shuffled.charges.shuffle === 4, 'shuffle spent one charge', shuffled.charges);

    // Exhaust Hint, then press once more: the balance floors at zero.
    for (let i = 0; i < 3; i++) await page.click('#btn-hint');
    await page.click('#btn-hint');
    const exhausted = await page.evaluate(() => ({
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
      dimmed: document.getElementById('btn-hint').classList.contains('spent'),
      name: document.getElementById('btn-hint').getAttribute('aria-label'),
    }));
    check(exhausted.charges.hint === 0, 'hint charges floor at zero', exhausted.charges);
    check(/No hints left\./.test(exhausted.said), 'an exhausted booster says so', exhausted.said);
    check(
      exhausted.dimmed && exhausted.name === 'Hint, no hints left',
      'an exhausted booster is dimmed and named accordingly',
      exhausted,
    );

    // Restart the app: the balances come back from storage.
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const resumed = await page.evaluate(() => ({
      charges: window.__slice.boosterCharges(),
      badges: ['hint', 'undo', 'shuffle'].map(
        (k) => document.getElementById(`charges-${k}`).textContent,
      ),
    }));
    check(
      resumed.charges.hint === 0 && resumed.charges.undo === 4 && resumed.charges.shuffle === 4,
      'charges persist across a restart',
      resumed.charges,
    );
    check(
      resumed.badges.join('/') === '0/4/4',
      'the restored balances are on the buttons',
      resumed.badges,
    );
    console.log(
      `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: boosters + charge persistence`,
    );
  }

  // 5. Deadlock way out (spec §4: never hard-fail the player): the dialog offers
  //    Shuffle, and taking it either hands back a playable board or refuses
  //    honestly and falls back to Undo.
  {
    const before = failures;
    const stuck = await page.evaluate(huntDeadlock);
    if (stuck === null) {
      console.log(`  note — ${vp.name}: no deadlock in 12 naive deals; stuck-dialog check skipped`);
    } else {
      check(stuck.title === 'No moves left', 'deadlock raises the stuck dialog', stuck);
      check(stuck.shuffleOffered, 'stuck dialog offers Shuffle', stuck);
      check(stuck.focus === 'overlay-shuffle', 'focus lands on the way out', stuck);
      // Spec §7 48dp, measured while the stuck dialog actually shows them
      // (the a11y audit can only measure the controls a win reveals).
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('#overlay-shuffle, #overlay-undo')]
          .filter((n) => n.offsetParent !== null)
          .map((n) => ({
            id: n.id,
            w: n.getBoundingClientRect().width,
            h: n.getBoundingClientRect().height,
          }))
          .filter((r) => r.w + 0.01 < 48 || r.h + 0.01 < 48),
      );
      check(small.length === 0, 'deadlock controls are ≥ 48dp', small);
      await page.click('#overlay-shuffle');
      const rescued = await page.evaluate(() => ({
        status: window.__slice.game.status(),
        overlayVisible: document.getElementById('overlay').classList.contains('visible'),
        charges: window.__slice.boosterCharges(),
        focusIsTile: document.activeElement?.classList.contains('tile-node') === true,
        said: document.getElementById('a11y-status').textContent,
      }));
      // Two honest outcomes: the shuffle rescues the deal, or it refuses because
      // this end position has no solvable face assignment (a pair stacked on
      // itself). Spec §4's "never hard-fail" then rests on Undo, which the
      // dialog must still be offering.
      if (rescued.status === 'playing') {
        check(!rescued.overlayVisible, 'a rescued deal closes the dialog', rescued);
        check(
          rescued.charges.shuffle === stuck.charges.shuffle - 1,
          'the rescue shuffle spent one charge',
          { before: stuck.charges, after: rescued.charges },
        );
        check(rescued.focusIsTile, 'focus returns to the board, not <body>', rescued);
        check(/Board shuffled\./.test(rescued.said), 'the rescue is announced', rescued.said);
        console.log(
          `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: deadlock rescued by Shuffle (deal ${stuck.deal + 1}, ${stuck.tilesLeft} tiles left)`,
        );
      } else {
        const refused = await page.evaluate(() => ({
          shuffleStillOffered: !document.getElementById('overlay-shuffle').hidden,
          undoOffered: !document.getElementById('overlay-undo').hidden,
          focus: document.activeElement?.id,
        }));
        check(
          rescued.charges.shuffle === stuck.charges.shuffle,
          'a refused shuffle costs nothing',
          { before: stuck.charges, after: rescued.charges },
        );
        check(
          /cannot be shuffled\./.test(rescued.said),
          'a refused shuffle explains itself',
          rescued.said,
        );
        check(!refused.shuffleStillOffered, 'a refused shuffle stops being offered', refused);
        check(
          refused.undoOffered && refused.focus === 'overlay-undo',
          'the dialog still offers Undo as the way out',
          refused,
        );
        console.log(
          `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: unshufflable deadlock degrades to Undo (deal ${stuck.deal + 1}, ${stuck.tilesLeft} tiles left)`,
        );
      }
    }
  }

  // 6. The same deadlock with no Shuffle left: Undo has to be the offered way
  //    out, and it has to be the control focus lands on. Forced rather than
  //    hoped for — section 5 only reaches this path when a deal happens to be
  //    unshufflable.
  {
    const before = failures;
    await page.evaluate(() =>
      localStorage.setItem('mahjong.boosters.v1', JSON.stringify({ hint: 0, undo: 5, shuffle: 0 })),
    );
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const stuck = await page.evaluate(huntDeadlock);
    if (stuck === null) {
      console.log(`  note — ${vp.name}: no deadlock in 12 naive deals; Undo-only check skipped`);
    } else {
      check(!stuck.shuffleOffered, 'a spent Shuffle is not offered', stuck);
      check(stuck.undoOffered, 'Undo is offered as the remaining way out', stuck);
      check(stuck.focus === 'overlay-undo', 'focus lands on Undo, not Restart', stuck);
      await page.click('#overlay-undo');
      const resumed = await page.evaluate(() => ({
        status: window.__slice.game.status(),
        overlayVisible: document.getElementById('overlay').classList.contains('visible'),
        charges: window.__slice.boosterCharges(),
        focusIsTile: document.activeElement?.classList.contains('tile-node') === true,
        said: document.getElementById('a11y-status').textContent,
      }));
      check(
        resumed.status === 'playing' && !resumed.overlayVisible,
        'undoing out of a deadlock resumes play',
        resumed,
      );
      check(resumed.charges.undo === 4, 'the rescue undo spent one charge', resumed.charges);
      check(resumed.focusIsTile, 'focus returns to the board, not <body>', resumed);
      check(/pair restored\./.test(resumed.said), 'the undo rescue is announced', resumed.said);
      console.log(
        `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: deadlock rescued by Undo when Shuffle is spent (deal ${stuck.deal + 1})`,
      );
    }
  }

  // 7. Auto-save + resume (issue #14, spec §7). A page reload is the closest a
  //    browser gets to a force-quit: the tab's JS heap is gone, so everything
  //    the board comes back with came out of storage.
  {
    const before = failures;
    // Refill the boosters section 6 spent, then deal fresh through the real
    // button. Note that clearing storage and reloading would NOT give a fresh
    // boot: the outgoing page's `pagehide` handler saves the board it is
    // leaving, which is exactly the force-quit protection under test here.
    await page.evaluate(() =>
      localStorage.setItem('mahjong.boosters.v1', JSON.stringify({ hint: 5, undo: 5, shuffle: 5 })),
    );
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    await page.click('#btn-new');

    // Play the generator's witness (naive greedy play can deadlock in a few
    // moves — that is what huntDeadlock above is for), then shuffle: shuffled
    // faces are the state a move-list replay could not reproduce. Then leave a
    // selection live mid-pair, which is state too.
    const played = await page.evaluate(() => {
      const s = window.__slice;
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      for (const [a, b] of s.game.level.solution.slice(0, 4)) {
        click(a);
        click(b);
      }
      document.getElementById('btn-shuffle').click();
      // A shuffled board is solver-validated solvable, so a free matching pair
      // exists; take one of its tiles as the live selection.
      const seen = new Map();
      for (const id of s.game.board.freeTileIds()) {
        const face = s.game.board.get(id).face;
        if (seen.has(face)) {
          click(seen.get(face));
          break;
        }
        seen.set(face, id);
      }
      return {
        hash: s.stateHash(),
        score: s.game.score,
        tilesLeft: s.game.tilesLeft,
        selection: s.game.selection,
        seed: s.game.level.seed,
        undoDepth: s.game.undoDepth,
        saved: s.savedState() !== null,
      };
    });
    check(played.tilesLeft === 136, 'four witness pairs were played', played);
    check(played.saved, 'a mid-level board is saved', played);
    check(played.selection !== null, 'the test left a live selection to restore', played);

    // Change two settings through the real controls before quitting.
    await page.click('#btn-settings');
    await page.click('#set-timed');
    await page.click('#set-size-m');
    await page.click('#settings-close');

    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const resumed = await page.evaluate(() => {
      const s = window.__slice;
      return {
        hash: s.stateHash(),
        score: s.game.score,
        tilesLeft: s.game.tilesLeft,
        selection: s.game.selection,
        seed: s.game.level.seed,
        undoDepth: s.game.undoDepth,
        settings: s.settings(),
        timerShown: !document.getElementById('time-stat').hidden,
        said: document.getElementById('a11y-status').textContent,
      };
    });
    check(
      resumed.hash === played.hash &&
        resumed.score === played.score &&
        resumed.tilesLeft === played.tilesLeft &&
        resumed.selection === played.selection &&
        resumed.seed === played.seed &&
        resumed.undoDepth === played.undoDepth,
      'a force-quit mid-level resumes the identical board, score and selection',
      { played, resumed },
    );
    check(/Game resumed\./.test(resumed.said), 'the resume is announced', resumed.said);
    check(
      resumed.settings.timedMode === true && resumed.settings.tileSize === 'm',
      'settings survive the force-quit',
      resumed.settings,
    );
    check(resumed.timerShown, 'opting into the timer shows the readout', resumed);

    // The resumed board is a live game, not a museum piece. This is the check
    // that caught the resume clock: performance.now() restarts at 0 on the new
    // page, so a combo ladder restored from the old one rejected every match.
    const kept = await page.evaluate(() => {
      const s = window.__slice;
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      const seen = new Map();
      for (const id of s.game.board.freeTileIds()) {
        const face = s.game.board.get(id).face;
        if (seen.has(face)) {
          // The restored selection may already be this pair's first tile —
          // tapping it again would just deselect it.
          const partner = seen.get(face);
          if (s.game.selection !== partner) click(partner);
          click(id);
          break;
        }
        seen.set(face, id);
      }
      return { tilesLeft: s.game.tilesLeft, score: s.game.score, status: s.game.status() };
    });
    check(
      kept.tilesLeft === played.tilesLeft - 2 && kept.score > played.score,
      'play continues normally on the resumed board',
      { played, kept },
    );

    // Finishing a level must leave nothing to resume into. Dealt fresh, because
    // the shuffle above invalidated this deal's witness.
    await page.click('#btn-new');
    const won = await page.evaluate(() => {
      const s = window.__slice;
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      for (const [a, b] of s.game.level.solution) {
        click(a);
        click(b);
      }
      return {
        status: s.game.status(),
        saved: s.savedState(),
        raw: localStorage.getItem('mahjong.save.v1'),
      };
    });
    check(won.status === 'won', 'the fresh deal plays to a win', won.status);
    check(won.saved === null && won.raw === null, 'a won level leaves no save behind', won);

    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const afterWin = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
    }));
    check(
      afterWin.tilesLeft === 144 && afterWin.score === 0,
      'the next boot after a win deals a fresh level',
      afterWin,
    );
    console.log(
      `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: auto-save + resume across a force-quit`,
    );
  }

  await ctx.close();
}

await browser.close();
server.close();
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all viewports passed');
