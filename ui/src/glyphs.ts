// Purchasable glyph sets (issue #229, decision 0038): whole-face bitmaps the
// renderer draws instead of the default Lantern faces it paints from pips.ts.
//
// A set is 38 PNGs — one per face id the game deals — under
// `glyphs/<dir>/<face>.png` in the static assets (Vite's publicDir is
// `data/`, so the files ship verbatim and are fetched, not bundled). They load
// lazily, only for the set in use or being previewed, and a loaded set stays
// cached for the session. Loading is all-or-nothing: a set missing one face
// would draw one Lantern tile among bitmap ones, which is exactly the kind of
// mixed board 0002/0023 forbid, so a failed face fails the set and the caller
// keeps the set it had.

import { Assets } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { STANDARD_144 } from '@mahjongsolitaire/core';

/** Face id → texture, the shape render.ts consumes. */
export type GlyphTextures = ReadonlyMap<string, Texture>;

/** Every distinct face id the game deals, in deal order — what a complete set
 *  has to cover. */
export const GLYPH_FACES: readonly string[] = Array.from(new Set(STANDARD_144));

/** Where a face's bitmap lives, relative to the app's base URL. */
export function glyphUrl(dir: string, face: string): string {
  return `glyphs/${dir}/${face}.png`;
}

export type TextureLoader = (url: string) => Promise<Texture>;

const pixiLoader: TextureLoader = (url) => Assets.load<Texture>(url);

/**
 * Loads sets on demand and remembers them. Concurrent requests for one set
 * share a single load; a set that failed is forgotten so the next request
 * tries again (a flaky network must not lock a bought set out for the
 * session). `load` is injectable so the tests never touch pixi's loader.
 */
export class GlyphSetLoader {
  private readonly loaded = new Map<string, GlyphTextures>();
  private readonly inFlight = new Map<string, Promise<GlyphTextures>>();

  constructor(private readonly load: TextureLoader = pixiLoader) {}

  /** The set's textures, once every face has arrived. Rejects if any did not. */
  get(dir: string): Promise<GlyphTextures> {
    const ready = this.loaded.get(dir);
    if (ready) return Promise.resolve(ready);
    const pending = this.inFlight.get(dir);
    if (pending) return pending;
    const loading = Promise.all(
      GLYPH_FACES.map(async (face) => [face, await this.load(glyphUrl(dir, face))] as const),
    )
      .then((entries) => {
        const textures: GlyphTextures = new Map(entries);
        this.loaded.set(dir, textures);
        return textures;
      })
      .finally(() => this.inFlight.delete(dir));
    this.inFlight.set(dir, loading);
    return loading;
  }

  /** Already loaded this session — the synchronous answer main.ts needs to
   *  redraw without waiting when a set is switched back to. */
  peek(dir: string): GlyphTextures | undefined {
    return this.loaded.get(dir);
  }
}
