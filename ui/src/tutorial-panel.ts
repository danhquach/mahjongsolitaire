// The first-run tutorial's browser wiring (issue #59) and its spotlight
// (issue #150), moved out of main.ts by issue #244: the card, the scrim with
// its rings and tags, the step render and its announcement, and the Panel
// declaration. main.ts says where in the stack the card sits — first, so
// Escape reaches it first — and what it may reach: the board's tiles and
// their on-screen rects, the hint highlight it borrows for step 3, a redraw,
// and focus back to the board when the card comes down.
//
// The pure parts — the step script (tutorial.ts) and the spotlight geometry
// (spotlight.ts: which tiles to ring, where the card goes, the scrim path) —
// stay where their tests are.

import type { Announcer } from './a11y.js';
import { el } from './dom.js';
import type { PanelStack } from './panel.js';
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
import { Tutorial } from './tutorial.js';
import type { TileId } from '@mahjongsolitaire/core';

/** A rectangle in page CSS px. */
interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The board as the tutorial sees it: what is on it and where, in the words
 *  the live region uses for it. */
export interface TutorialBoard {
  /** Every present tile with its on-screen face rect, for the picker. */
  spotTiles(): SpotTile[];
  /** One tile's face rect on the page, as it stands right now. */
  tileRectOnPage(id: TileId): PageRect;
  /** Where a tile is, in the a11y layer's words: "row 3 column 7". */
  whereIs(id: TileId): string;
  /** A tile's spoken name. */
  label(id: TileId): string;
  /** A pair's spoken description, as Hint says it. */
  describePair(pair: readonly [TileId, TileId]): string;
  /** The solver's hint without advancing Hint's cycle. */
  peekHint(): readonly TileId[] | null;
}

/** What the tutorial is allowed to reach outside itself. */
export interface TutorialPanelDeps {
  /** The stack it registers with; the call's position is its stacking order. */
  readonly panels: PanelStack;
  readonly announcer: Pick<Announcer, 'say'>;
  readonly board: TutorialBoard;
  /** Step 3 borrows Hint's highlight for the pair it rings; the empty list
   *  takes it back. */
  readonly setHighlight: (pair: readonly TileId[]) => void;
  /** Repaint the board — the highlight changed. */
  readonly redraw: () => void;
  /** Focus the board's current tile: nothing opened the card, so nothing
   *  else gets focus back. */
  readonly focusBoard: () => void;
  /** The tutorial ended, by Done or by Skip: both write the toggle OFF. */
  readonly onEnded: () => void;
}

/** What main.ts may ask of the tutorial. */
export interface TutorialPanel {
  /** Open the card on step 1 over the dealt board, or defer if another panel
   *  holds the screen. */
  start(): void;
  /** Run a deferred start, if there is one — as the panel in the way closes. */
  startPending(): void;
  /** The tiles have moved (a resize): re-lay the rings and tags. */
  layout(): void;
  /** QA handles (issues #59, #150): the card's state and the spotlight's. */
  readonly inspect: {
    tutorial(): { visible: boolean; step: number; count: number };
    spotlight(): {
      tiles: { free?: TileId; blocked?: TileId; pair?: readonly TileId[] };
      holes: readonly Hole[];
      visible: boolean;
    };
  };
}

/** Look up the card's elements, wire its controls, declare it on the stack,
 *  and hand back what main.ts may ask of it. */
export function mountTutorialPanel(deps: TutorialPanelDeps): TutorialPanel {
  const { panels, announcer, board, setHighlight, redraw, focusBoard, onEnded } = deps;

  // First-run tutorial card (issue #59).
  const tutorialPanel = el<HTMLDivElement>('tutorial');
  const tutorialCard = el<HTMLDivElement>('tutorial-card');
  const tutorialStepEl = el<HTMLElement>('tutorial-step');
  const tutorialTitle = el<HTMLElement>('tutorial-title');
  const tutorialText = el<HTMLElement>('tutorial-text');
  const tutorialNext = el<HTMLButtonElement>('tutorial-next');
  const tutorialSkip = el<HTMLButtonElement>('tutorial-skip');
  // Tutorial spotlight scrim (issue #150), and the regions its steps point at.
  const spotlightSvg = el<SVGSVGElement>('spotlight');
  const boardDiv = el<HTMLDivElement>('board');
  const holderDiv = el<HTMLDivElement>('holder');
  const boostersGroup = el<HTMLDivElement>('booster-rail').querySelector<HTMLElement>('.boosters');
  const scoreChip = el<HTMLElement>('score').parentElement;

  /** A tutorial that wanted to start while another panel (the welcome gate,
   *  the profile it may open) was up; it starts when that panel closes. */
  let tutorialPending = false;
  /** The pair step 3 has Hint highlight — what `setHighlight` was last told. */
  let hintPair: readonly TileId[] = [];

  /** Both ends write the toggle OFF: a skipped tutorial is not re-offered on
   *  the next level any more than a completed one is. */
  const tutorial = new Tutorial((how) => {
    onEnded();
    tutorialDialog.close();
    announcer.say(how === 'done' ? 'Tutorial finished. The board is yours.' : 'Tutorial skipped. The board is yours.');
  });

  /** The first-run tutorial's card (issue #59). Escape skips rather than
   *  closes — a skipped tutorial is not re-offered, same as a finished one —
   *  and focus goes back to the board's current tile: nothing opened this. */
  const tutorialDialog = panels.add({
    name: 'tutorial',
    element: tutorialPanel,
    backdrop: false,
    escape: () => tutorial.skip(),
    beforeOpen: () => tutorial.start(),
    // The rings, tags and scrim are drawn once the card is up, and the step's
    // own line is what the live region hears — so no `announce` here.
    afterOpen: () => renderTutorialStep(),
    // The card itself takes focus (not a button) so the dialog's name and
    // description are read first; Tab reaches Skip and Next from there.
    focusIn: () => tutorialCard.focus(),
    opener: () => null,
    // Highlight and scrim cleared, the board repainted without the hint pair,
    // and focus handed back to the board's current tile.
    afterClose: () => {
      tutorialPanel.classList.remove('card-top', 'compact');
      spotlightSvg.classList.remove('visible');
      spotlightSvg.replaceChildren();
      spotlightTiles = {};
      spotlightHoles = [];
      hintPair = [];
      setHighlight(hintPair);
      redraw();
      focusBoard();
    },
  });

  /**
   * Open the card on step 1 over the dealt board. A card already up is a
   * fresh deal restarting it, so it comes down first. While another panel or
   * the end-of-level dialog holds the screen — the welcome gate on a fresh
   * install, or the profile screen it opens — the panel refuses and the start
   * is deferred; `startPendingTutorial` runs it as that panel closes.
   */
  function startTutorial(): void {
    if (tutorialDialog.visible) tutorialDialog.close();
    if (!tutorialDialog.open()) {
      tutorialPending = true;
      return;
    }
    tutorialPending = false;
  }

  function startPendingTutorial(): void {
    if (tutorialPending) startTutorial();
  }

  /** The tiles the current step points at (issue #150), chosen once per
   *  step so a resize moves the rings with the tiles rather than re-picking. */
  let spotlightTiles: { readonly free?: TileId; readonly blocked?: TileId; readonly pair?: readonly TileId[] } = {};
  /** The holes as last drawn, page CSS px (QA reads them back). */
  let spotlightHoles: readonly Hole[] = [];

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
      const pick = pickFreeBlocked(board.spotTiles(), boardMidY());
      if (pick) spotlightTiles = { free: pick.free.id, blocked: pick.blocked.id };
    } else if (step.actor === 'pair') {
      const pick = pickVisiblePair(board.spotTiles(), boardMidY());
      if (pick) {
        spotlightTiles = { pair: [pick[0].id, pick[1].id] };
        hintPair = spotlightTiles.pair!;
      } else {
        // No fully visible pair in one half of this board: the solver's hint
        // is still highlighted and announced, but not ringed — a ring around
        // a half-covered tile would break the "fully visible" rule, and a
        // ring around a straddling pair would put the card on a tile (#199).
        hintPair = board.peekHint() ?? [];
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
    if (step === null || !tutorialDialog.visible) return;
    const holes: Hole[] = [];
    const pageRect = (elm: HTMLElement | null): Hole | null => {
      if (!elm) return null;
      const r = elm.getBoundingClientRect();
      return panelHole({ x: r.x, y: r.y, w: r.width, h: r.height });
    };
    if (spotlightTiles.free !== undefined) holes.push(tileHole(board.tileRectOnPage(spotlightTiles.free), 'free'));
    if (spotlightTiles.blocked !== undefined) holes.push(tileHole(board.tileRectOnPage(spotlightTiles.blocked), 'blocked'));
    for (const id of spotlightTiles.pair ?? []) holes.push(tileHole(board.tileRectOnPage(id), 'pair'));
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
    setHighlight(hintPair);
    redraw();
    layoutSpotlight();
    // The scrim is visual only: the announcement names what it points at.
    let where = '';
    if (spotlightTiles.free !== undefined && spotlightTiles.blocked !== undefined) {
      where =
        ` ${board.label(spotlightTiles.free)} at ${board.whereIs(spotlightTiles.free)} is free;` +
        ` ${board.label(spotlightTiles.blocked)} at ${board.whereIs(spotlightTiles.blocked)} is blocked.`;
    } else if (step.actor === 'pair' && hintPair.length === 2) {
      where = ` Highlighted: ${board.describePair([hintPair[0]!, hintPair[1]!])}.`;
    }
    announcer.say(`Tutorial, step ${n} of ${tutorial.stepCount}. ${step.title}. ${step.body}${where}`);
  }

  tutorialNext.addEventListener('click', () => {
    tutorial.next();
    if (tutorial.active) renderTutorialStep();
  });
  tutorialSkip.addEventListener('click', () => tutorial.skip());

  return {
    start: startTutorial,
    startPending: startPendingTutorial,
    layout: layoutSpotlight,
    inspect: {
      tutorial: () => ({ visible: tutorialDialog.visible, step: tutorial.stepIndex + 1, count: tutorial.stepCount }),
      spotlight: () => ({
        tiles: spotlightTiles,
        holes: spotlightHoles,
        visible: spotlightSvg.classList.contains('visible'),
      }),
    },
  };
}
