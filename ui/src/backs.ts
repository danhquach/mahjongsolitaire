// Purchasable tile backs (issue #229, decision 0040): one bitmap per back
// under `backs/<id>.png` in the static assets (Vite's publicDir is `data/`),
// drawn over a face-down tile in place of the palette's plain back and inset
// keyline. Like the glyph sets (glyphs.ts) a back loads lazily, only when in
// use or previewed, and stays cached for the session; a failed load is
// forgotten so the next request tries again.

import { Assets } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { TextureLoader } from './glyphs.js';

/** Where a back's bitmap lives, relative to the app's base URL. */
export function backUrl(id: string): string {
  return `backs/${id}.png`;
}

const pixiLoader: TextureLoader = (url) => Assets.load<Texture>(url);

/** Loads backs on demand and remembers them; concurrent requests for one
 *  back share a load. `load` is injectable so the tests never touch pixi's
 *  loader. */
export class BackLoader {
  private readonly loaded = new Map<string, Texture>();
  private readonly inFlight = new Map<string, Promise<Texture>>();

  constructor(private readonly load: TextureLoader = pixiLoader) {}

  get(id: string): Promise<Texture> {
    const ready = this.loaded.get(id);
    if (ready) return Promise.resolve(ready);
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const loading = this.load(backUrl(id))
      .then((texture) => {
        this.loaded.set(id, texture);
        return texture;
      })
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, loading);
    return loading;
  }

  /** Already loaded this session — the synchronous answer main.ts needs to
   *  redraw without waiting when a back is switched back to. */
  peek(id: string): Texture | undefined {
    return this.loaded.get(id);
  }
}
