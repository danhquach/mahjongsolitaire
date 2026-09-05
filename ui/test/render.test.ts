// The board renderer redraws incrementally (issue #58): a tile whose picture
// would come out the same keeps the container it already has, so the render
// pass after a tap re-uploads one or two tiles, not the whole board. Driven
// against a stub Application — no WebGL, no DOM: what is observable is which
// containers survive a draw, and in what order they sit on the board layer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Container, Sprite, Texture } from 'pixi.js';
import type { Application } from 'pixi.js';
import { SEED_LAYOUTS, generateLevel } from '@mahjongsolitaire/core';
import type { TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import type { Hit } from '../src/hit-test.js';
import { drawOrder } from '../src/geometry.js';
import { BoardRenderer } from '../src/render.js';
import type { DrawState } from '../src/render.js';

const ROWS = SEED_LAYOUTS.find((l) => l.id === 'seed-rows')!;
const PLAIN: DrawState = { flash: [], hint: [], dimBlocked: false };
const free = (id: TileId): Hit => ({ kind: 'free', id, forgiven: false });

function harness(seed = 1) {
  const stage = new Container();
  const app = {
    stage,
    renderer: {
      width: 800,
      height: 600,
      resolution: 1,
      background: { color: 0 },
      generateTexture: () => Texture.EMPTY,
    },
  } as unknown as Application;
  const game = new Game(generateLevel(ROWS, seed));
  const renderer = new BoardRenderer(app, ROWS.slots);
  // stage → viewport → boardLayer (render.ts wires exactly these two).
  const boardLayer = (stage.children[0] as Container).children[0] as Container;
  const ids = () => [...game.board.presentTiles()].map((t) => t.id);
  const nodes = () => new Map(ids().map((id) => [id, renderer.tileNode(id)!]));
  /** The tile ids on the board layer, in child order. */
  const layerIds = () => {
    const byNode = new Map([...nodes()].map(([id, node]) => [node, id]));
    return boardLayer.children.map((c) => byNode.get(c));
  };
  const expectedOrder = () =>
    [...game.board.presentTiles()].sort((a, b) => drawOrder(a.slot, b.slot)).map((t) => t.id);
  return { app, game, renderer, boardLayer, ids, nodes, layerIds, expectedOrder };
}

test('a redraw with nothing changed keeps every tile node', () => {
  const h = harness();
  h.renderer.draw(h.game, PLAIN);
  const before = h.nodes();
  assert.equal(before.size, h.game.level.tiles.length, 'one node per present tile');
  h.renderer.draw(h.game, PLAIN);
  for (const [id, node] of h.nodes()) {
    assert.equal(node, before.get(id), `tile ${id} kept its container`);
    assert.equal(node.destroyed, false);
  }
  assert.deepEqual(h.layerIds(), h.expectedOrder(), 'board layer is in drawOrder');
});

test('flashing one tile rebuilds that tile and no other', () => {
  const h = harness();
  h.renderer.draw(h.game, PLAIN);
  const before = h.nodes();
  const [target] = h.ids();
  h.renderer.draw(h.game, { ...PLAIN, flash: [target!] });
  const after = h.nodes();
  assert.notEqual(after.get(target!), before.get(target!), 'the flashed tile was rebuilt');
  assert.equal(before.get(target!)!.destroyed, true, 'its old container was destroyed');
  for (const [id, node] of after) {
    if (id !== target) assert.equal(node, before.get(id), `tile ${id} untouched`);
  }
  assert.deepEqual(h.layerIds(), h.expectedOrder(), 'a rebuilt node sits at its drawOrder place');

  // And back: the flash ending is itself a change to that one tile.
  h.renderer.draw(h.game, PLAIN);
  const plainAgain = h.nodes();
  assert.notEqual(plainAgain.get(target!), after.get(target!));
  for (const [id, node] of plainAgain) {
    if (id !== target) assert.equal(node, before.get(id));
  }
});

test('a cleared pair leaves the layer; the rest stay put, in draw order', () => {
  const h = harness();
  h.renderer.draw(h.game, PLAIN);
  const before = h.nodes();
  const [a, b] = h.game.level.solution[0]!;
  h.game.tap(free(a), 0);
  h.game.tap(free(b), 1);
  assert.equal(h.game.board.get(a).removed, true);
  h.renderer.draw(h.game, PLAIN);
  assert.equal(h.renderer.tileNode(a), undefined, 'a matched tile has no node');
  assert.equal(before.get(a)!.destroyed, true, 'and its container was destroyed');
  assert.equal(before.get(b)!.destroyed, true);
  assert.equal(h.boardLayer.children.length, h.game.level.tiles.length - 2);
  const after = h.nodes();
  // Removing a pair may free the tiles under it, and only those may change:
  // a tile's `dimmed` input is off here, so nothing else has any reason to.
  for (const [id, node] of after) assert.equal(node, before.get(id), `tile ${id} kept`);
  assert.deepEqual(h.layerIds(), h.expectedOrder());
});

test('a new deal rebuilds exactly the tiles whose slot or face changed', () => {
  const h = harness(1);
  h.renderer.draw(h.game, PLAIN);
  const before = h.nodes();
  const firstDeal = new Map(h.game.level.tiles.map((t) => [t.id, t]));
  const second = new Game(generateLevel(ROWS, 2));
  h.renderer.draw(second, PLAIN);
  let rebuilt = 0;
  for (const tile of second.level.tiles) {
    const was = firstDeal.get(tile.id)!;
    const same =
      was.slot.x === tile.slot.x &&
      was.slot.y === tile.slot.y &&
      was.slot.z === tile.slot.z &&
      was.face === tile.face;
    const node = h.renderer.tileNode(tile.id)!;
    if (same) assert.equal(node, before.get(tile.id), `tile ${tile.id} identical, kept`);
    else {
      assert.notEqual(node, before.get(tile.id), `tile ${tile.id} changed, rebuilt`);
      rebuilt++;
    }
  }
  assert.ok(rebuilt > 0, 'the two deals differ somewhere');
  assert.equal(h.boardLayer.children.length, second.level.tiles.length);
});

test('a board played to empty leaves an empty layer', () => {
  const h = harness();
  h.renderer.draw(h.game, PLAIN);
  let t = 0;
  for (const [a, b] of h.game.level.solution) {
    h.game.tap(free(a), t++);
    h.game.tap(free(b), t++);
  }
  assert.equal(h.game.tilesLeft, 0);
  h.renderer.draw(h.game, PLAIN);
  assert.equal(h.boardLayer.children.length, 0);
  assert.equal(h.ids().length, 0);
});

test('a live effect transform survives a redraw that does not touch the tile', () => {
  // ShakeEffect and friends nudge a node's position between redraws and reset
  // it on dispose; a redraw must not snap a kept node back mid-swing (it used
  // to, by rebuilding every container).
  const h = harness();
  h.renderer.draw(h.game, PLAIN);
  const [id] = h.ids();
  const node = h.renderer.tileNode(id!)!;
  node.position.set(3, 0);
  h.renderer.draw(h.game, PLAIN);
  assert.equal(h.renderer.tileNode(id!), node);
  assert.equal(node.position.x, 3);
});

test('a layout change drops every kept node before the redraw that follows', () => {
  const h = harness();
  h.renderer.draw(h.game, PLAIN);
  const before = h.nodes();
  const pyramid = SEED_LAYOUTS.find((l) => l.id === 'seed-pyramid')!;
  h.renderer.setLayout(pyramid.slots);
  for (const [id, node] of before) {
    assert.equal(h.renderer.tileNode(id), undefined, `tile ${id} no longer resolves`);
    assert.equal(node.destroyed, true);
  }
  assert.equal(h.boardLayer.children.length, 0);
  const next = new Game(generateLevel(pyramid, 3));
  h.renderer.draw(next, PLAIN);
  assert.equal(h.boardLayer.children.length, next.level.tiles.length);
});

// --- bitmap glyph sets (issue #229) -------------------------------------------

/** One texture for every face on the board, so the whole deal is bitmap. */
function texturesFor(game: Game) {
  return new Map([...game.board.presentTiles()].map((t) => [t.face, Texture.EMPTY]));
}

test('handing over a glyph set rebuilds every face-up tile as a sprite; the default restores the drawn art', () => {
  const h = harness();
  h.renderer.draw(h.game, PLAIN);
  const drawn = h.nodes();
  const spritesIn = (node: Container) => node.children.filter((c) => c instanceof Sprite).length;
  // Drawn faces: the only sprite in a tile is its shadow.
  for (const node of drawn.values()) assert.equal(spritesIn(node), 1);

  h.renderer.setGlyphSet({ id: 'glyphs-fantasy', textures: texturesFor(h.game) });
  assert.equal(h.renderer.glyphSetId, 'glyphs-fantasy');
  h.renderer.draw(h.game, PLAIN);
  const bitmap = h.nodes();
  let faceUp = 0;
  for (const [id, node] of bitmap) {
    assert.notEqual(node, drawn.get(id), `tile ${id} was rebuilt for the set`);
    // A face-down tile shows its back whatever the set (issue #64).
    if (h.game.isFaceHidden(id)) assert.equal(spritesIn(node), 1, `tile ${id} keeps its back`);
    else {
      assert.equal(spritesIn(node), 2, `tile ${id} carries the face sprite`);
      faceUp += 1;
    }
  }
  assert.ok(faceUp > 0, 'the deal has face-up tiles to prove the sprite on');
  assert.deepEqual(h.layerIds(), h.expectedOrder());

  // The same set again is not a change: nothing is rebuilt.
  h.renderer.draw(h.game, PLAIN);
  for (const [id, node] of h.nodes()) assert.equal(node, bitmap.get(id));

  h.renderer.setGlyphSet({ id: 'lantern', textures: null });
  h.renderer.draw(h.game, PLAIN);
  for (const [id, node] of h.nodes()) {
    assert.notEqual(node, bitmap.get(id), `tile ${id} went back to drawn art`);
    assert.equal(spritesIn(node), 1);
  }
});

test('a face the set has no bitmap for falls back to its drawn art', () => {
  const h = harness();
  const [first] = [...h.game.board.presentTiles()];
  const partial = new Map([[first!.face, Texture.EMPTY]]);
  h.renderer.setGlyphSet({ id: 'glyphs-partial', textures: partial });
  h.renderer.draw(h.game, PLAIN);
  for (const tile of h.game.board.presentTiles()) {
    const sprites = h.renderer.tileNode(tile.id)!.children.filter((c) => c instanceof Sprite).length;
    const expectBitmap = tile.face === first!.face && !h.game.isFaceHidden(tile.id);
    assert.equal(sprites, expectBitmap ? 2 : 1, tile.face);
  }
});
