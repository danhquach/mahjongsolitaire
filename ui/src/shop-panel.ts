// The cosmetics shop's browser wiring (issue #229, decision 0038), moved out
// of main.ts by issue #244: the rows for the four kinds of look and their
// previews, the Buy → Confirm arming, the purchase and the pick, the status
// line and the announcements, and the Panel declaration. main.ts says where
// in the stack the shop sits and what it may reach: the record that owns
// items and chooses a look, the renderer that bakes a preview the way it
// draws the board, the two bitmap loaders, and the apply functions that put
// a chosen look on the table — those stay in main.ts because they also run
// at boot, before any panel exists.
//
// The pure parts — prices and the derived balance (shop.ts), the record
// (profile.ts), the tables a look is read from (depth.ts, frames.ts) and the
// bitmaps a bought glyph set draws from (glyphs.ts) — stay where their tests
// are.

import type { Announcer } from './a11y.js';
import type { BackLoader } from './backs.js';
import { PALETTES, backFor, cssColor, feltFor, feltTextureUrl } from './depth.js';
import type { Felt, TileBack } from './depth.js';
import { el } from './dom.js';
import { applyFrame, frameFor } from './frames.js';
import type { AvatarFrame } from './frames.js';
import type { GlyphSetLoader } from './glyphs.js';
import type { PanelStack } from './panel.js';
import { DEFAULT_LOOKS, avatarGlyph } from './profile.js';
import type { LookKind, ProfileStore, RecordStore } from './profile.js';
import type { BackInUse, BoardRenderer, GlyphSetInUse } from './render.js';
import { SHOP_ITEMS, affordability, glyphSetFor, purchase, trophyBalance } from './shop.js';
import type { GlyphSet } from './shop.js';

/** What the shop is allowed to reach outside itself. */
export interface ShopPanelDeps {
  /** The stack it registers with; the call's position is its stacking order. */
  readonly panels: PanelStack;
  readonly announcer: Pick<Announcer, 'say'>;
  /** The player: the avatar a frame's preview is drawn on. */
  readonly profile: Pick<ProfileStore, 'value'>;
  /** The record owns the items and chooses a look; `purchase` writes it. */
  readonly record: RecordStore;
  /** The board renderer bakes the glyph and back previews from the same
   *  textures it draws with, so a preview is what the board would show. */
  readonly renderer: Pick<BoardRenderer, 'tileImageIn' | 'backImage'>;
  readonly glyphLoader: Pick<GlyphSetLoader, 'get' | 'peek'>;
  readonly backLoader: Pick<BackLoader, 'get' | 'peek'>;
  /** The renderer's view of a set / a back — main.ts's, since it needs them
   *  at boot too. */
  readonly glyphSetInUse: (set: GlyphSet) => GlyphSetInUse;
  readonly backInUse: (back: TileBack) => BackInUse;
  /** Put the record's pick on the board, per kind: a glyph set or a back
   *  loads its bitmaps first; a felt is the palette; a frame is the profile
   *  row. Each is what main.ts runs at boot for the same pick. */
  readonly applyGlyphSet: () => Promise<void>;
  readonly applyPalette: () => void;
  readonly applyBack: () => Promise<void>;
  readonly syncProfileRow: () => void;
  /** Publish a purchase or a pick, if sync is on. */
  readonly syncCosmetics: () => void;
}

/** What main.ts may ask of the shop. */
export interface ShopPanel {
  /** Write the shop's status line — the apply functions report a failed
   *  bitmap load here, so the player sees why the board did not change. */
  setStatus(text: string): void;
  /** The record was replaced from elsewhere (cloud sync adopting the
   *  server's): another device may have bought or picked a look, and the
   *  balance may have moved, so a Buy waiting for its Confirm is withdrawn
   *  and the open shop repaints. */
  recordAdopted(): void;
}

/** Look up the shop's elements, build its rows, declare it on the stack,
 *  wire its controls, and hand back what main.ts may ask of it. */
export function mountShopPanel(deps: ShopPanelDeps): ShopPanel {
  const {
    panels,
    announcer,
    profile,
    record,
    renderer,
    glyphLoader,
    backLoader,
    glyphSetInUse,
    backInUse,
    applyGlyphSet,
    applyPalette,
    applyBack,
    syncProfileRow,
    syncCosmetics,
  } = deps;

  const shopPanel = el<HTMLDivElement>('shop');
  const shopButton = el<HTMLButtonElement>('btn-shop');
  const shopBalance = el<HTMLElement>('shop-balance');
  const shopGlyphList = el<HTMLElement>('shop-glyphs');
  const shopFeltList = el<HTMLElement>('shop-felts');
  const shopBackList = el<HTMLElement>('shop-backs');
  const shopFrameList = el<HTMLElement>('shop-frames');
  const shopStatus = el<HTMLElement>('shop-status');
  const shopClose = el<HTMLButtonElement>('shop-close');

  function setShopStatus(text: string): void {
    shopStatus.textContent = text;
  }

  /** The Buy that is waiting for its Confirm tap, by item id. One at a time:
   *  arming another disarms it, and so does a record change from elsewhere
   *  (cloud sync adopting the server's record) — a Confirm must never outlive
   *  the balance it was offered on, so the render also re-checks affordability
   *  before showing it. */
  let shopArmed: string | null = null;

  /** The cosmetics shop (issue #229), a booster-rail action since #239. */
  const shopDialog = panels.add({
    name: 'shop',
    element: shopPanel,
    beforeOpen: () => {
      shopArmed = null;
      setShopStatus('');
      renderShop();
    },
    // Done is the focus target like every other panel, but the card is taller
    // than a phone: letting the focus scroll it would open the shop at its
    // foot, the first row out of view. preventScroll leaves the card where
    // the contract's own scroll reset put it — the top (issue #168).
    focusIn: () => shopClose.focus({ preventScroll: true }),
    // Back to the control that opened it — the rail's Shop button since issue
    // #239, not the gear.
    opener: () => shopButton,
    announce: () => {
      const balance = trophyBalance(record.value);
      return `Shop. ${balance} ${balance === 1 ? 'trophy' : 'trophies'} to spend.`;
    },
    beforeClose: () => {
      shopArmed = null;
    },
  });

  /** Four faces that show a set's range: a pip grid, canes, a numeral and a
   *  Dragon. Baked by the renderer from the set's own textures (render.ts
   *  `tileImageIn`), so the preview is what the board would draw. */
  const SHOP_PREVIEW_FACES = ['dots-5', 'bamboo-3', 'char-7', 'dragon-green'];

  /** One row of the shop, whatever kind of look it sells. `spoken` is how the
   *  row's buttons name it ("Calligraphy glyph set", "Forest felt"), so a
   *  screen reader hears the kind as well as the name. */
  interface ShopRow {
    readonly kind: LookKind;
    readonly id: string;
    readonly label: string;
    readonly spoken: string;
    readonly price: number;
    readonly description: string;
    /** What the row shows of the look; the free default has a price of 0. */
    readonly preview: (into: HTMLElement) => void;
    /** Put the look on the board once the record has taken the pick. */
    readonly apply: () => void;
  }

  function glyphPreview(set: GlyphSet): (into: HTMLElement) => void {
    return (into) => {
      if (set.dir === null || glyphLoader.peek(set.dir) !== undefined) {
        const view = glyphSetInUse(set);
        for (const face of SHOP_PREVIEW_FACES) {
          const img = document.createElement('img');
          img.alt = '';
          img.src = renderer.tileImageIn(face, view);
          into.append(img);
        }
      } else {
        into.textContent = 'Loading preview…';
        ensurePreview(set);
      }
    };
  }

  /** A felt's preview is the felt itself with a face-down Lantern back on it —
   *  the one pairing the felt has to hold (3:1, ui/test/depth.test.ts). */
  function feltPreview(felt: Felt): (into: HTMLElement) => void {
    return (into) => {
      const swatch = document.createElement('span');
      swatch.className = 'shop-swatch';
      swatch.style.backgroundColor = cssColor(felt.color);
      const texture = feltTextureUrl(felt);
      if (texture !== null) {
        swatch.style.backgroundImage = `url("${texture}")`;
        swatch.style.backgroundSize = `${felt.texture![0]}px ${felt.texture![1]}px`;
      }
      const back = document.createElement('span');
      back.className = 'shop-swatch-back';
      back.style.background = cssColor(PALETTES.lantern.back);
      back.style.borderColor = cssColor(PALETTES.lantern.backKeyline);
      swatch.append(back);
      into.append(swatch);
    };
  }

  /** A back's preview is a face-down tile wearing it, baked by the board
   *  renderer — the plain-keyline stand-in until its bitmap is in. */
  function backPreview(back: TileBack): (into: HTMLElement) => void {
    return (into) => {
      const img = document.createElement('img');
      img.alt = '';
      img.src = renderer.backImage(backInUse(back));
      into.append(img);
      if (back.id !== 'lantern' && backLoader.peek(back.id) === undefined) {
        void backLoader.get(back.id).then(
          () => {
            if (shopDialog.visible) renderShop();
          },
          () => setShopStatus(`Couldn't load the ${back.label} preview. Check your connection and try again.`),
        );
      }
    };
  }

  /** A frame's preview is the player's own avatar wearing it. */
  function framePreview(frame: AvatarFrame): (into: HTMLElement) => void {
    return (into) => {
      const badge = document.createElement('span');
      badge.className = 'avatar-glyph';
      badge.textContent = avatarGlyph(profile.value.avatar);
      applyFrame(badge, frame.id);
      into.append(badge);
    };
  }

  /** One shop list: its `<ul>`, its rows with the free default first, and
   *  which row the record has in use. Every kind builds the same way — the
   *  default resolved through the same `lookFor` the board uses (so an id this
   *  build does not ship lands on the default row too), then the kind's items
   *  in SHOP_ITEMS order. Only the lookup, the spoken suffix, the default's
   *  description, the preview and apply differ (issue #243). */
  function shopList<Look extends { readonly id: string; readonly label: string }>(
    list: HTMLElement,
    kind: LookKind,
    lookFor: (id: string) => Look,
    freeDescription: string,
    spokenKind: string,
    preview: (look: Look) => (into: HTMLElement) => void,
    apply: () => void,
  ): { list: HTMLElement; rows: readonly ShopRow[]; inUse: () => string } {
    const rows = [
      { look: lookFor(DEFAULT_LOOKS[kind]), price: 0, description: freeDescription },
      ...SHOP_ITEMS.filter((item) => item.kind === kind).map((item) => ({
        look: lookFor(item.id),
        price: item.price,
        description: item.description,
      })),
    ].map(({ look, price, description }) => ({
      kind,
      id: look.id,
      label: look.label,
      spoken: `${look.label} ${spokenKind}`,
      price,
      description,
      preview: preview(look),
      apply,
    }));
    return { list, rows, inUse: () => lookFor(record.value.looks[kind]).id };
  }

  const SHOP_LISTS = [
    shopList(
      shopGlyphList,
      'glyphs',
      glyphSetFor,
      'The drawn faces every board starts with.',
      'glyph set',
      glyphPreview,
      () => void applyGlyphSet(),
    ),
    shopList(shopFeltList, 'felt', feltFor, 'The green table every board starts on.', 'felt', feltPreview, applyPalette),
    shopList(
      shopBackList,
      'back',
      backFor,
      'The plain jade back every board starts with.',
      'tile back',
      backPreview,
      () => void applyBack(),
    ),
    shopList(shopFrameList, 'frame', frameFor, 'Your avatar on its own.', 'avatar frame', framePreview, syncProfileRow),
  ];

  function renderShop(): void {
    const balance = trophyBalance(record.value);
    // The spendable number is set apart (issue #239): it rides in the sticky
    // bar, and it is what every price on the way down is read against.
    const spend = document.createElement('span');
    spend.className = 'shop-spend';
    spend.textContent = String(balance);
    const rest = document.createTextNode(
      ` ${balance === 1 ? 'trophy' : 'trophies'} to spend` +
        (record.value.trophies === balance ? '' : ` · ${record.value.trophies} earned`),
    );
    shopBalance.replaceChildren(spend, rest);
    for (const { list, rows, inUse } of SHOP_LISTS) {
      const current = inUse();
      list.replaceChildren(...rows.map((row) => shopRow(row, row.id === current)));
    }
  }

  function trophies(n: number): string {
    return `${n} ${n === 1 ? 'trophy' : 'trophies'}`;
  }

  function shopRow(row: ShopRow, inUse: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'shop-item';
    const standing = row.price === 0 ? { state: 'owned' as const } : affordability(record.value, row.id);
    const state = inUse ? 'in-use' : standing.state;
    li.dataset['state'] = state;

    const head = document.createElement('div');
    head.className = 'shop-head';
    const name = document.createElement('strong');
    name.textContent = row.label;
    const priceEl = document.createElement('span');
    priceEl.className = 'shop-price';
    priceEl.textContent =
      state === 'in-use' || state === 'owned' ? (row.price === 0 ? 'Free' : 'Owned') : trophies(row.price);
    head.append(name, priceEl);
    const desc = document.createElement('span');
    desc.className = 'shop-desc';
    desc.textContent = row.description;

    const preview = document.createElement('div');
    preview.className = 'shop-preview';
    preview.setAttribute('aria-hidden', 'true');
    row.preview(preview);

    const actions = document.createElement('div');
    actions.className = 'shop-actions';
    if (state === 'in-use') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'In use';
      button.setAttribute('aria-pressed', 'true');
      button.setAttribute('aria-label', `${row.spoken}, in use`);
      actions.append(button);
    } else if (state === 'owned') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Use';
      button.setAttribute('aria-label', `Use the ${row.spoken}`);
      button.addEventListener('click', () => chooseLook(row));
      actions.append(button);
    } else if (shopArmed === row.id && standing.state === 'affordable') {
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.dataset['confirm'] = row.id;
      // Short labels in a card this narrow. The aria-label opens with the
      // visible text verbatim and then names the item, so the visible words
      // really are a prefix of the accessible name (WCAG 2.5.3) — voice
      // control users can say what they can see.
      confirm.textContent = `Confirm ${row.price}`;
      confirm.setAttribute('aria-label', `Confirm ${row.price} trophies for the ${row.spoken}`);
      confirm.addEventListener('click', () => buyLook(row));
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        shopArmed = null;
        renderShop();
        shopPanel.querySelector<HTMLButtonElement>(`[data-buy="${row.id}"]`)?.focus();
      });
      actions.append(confirm, cancel);
    } else {
      const buy = document.createElement('button');
      buy.type = 'button';
      buy.dataset['buy'] = row.id;
      buy.textContent = `Buy ${row.price}`;
      buy.setAttribute('aria-label', `Buy ${row.price} trophies for the ${row.spoken}`);
      if (standing.state === 'locked') {
        buy.disabled = true;
        const short = document.createElement('span');
        short.className = 'shop-short';
        short.textContent = `${standing.short} more needed`;
        actions.append(buy, short);
      } else {
        buy.addEventListener('click', () => {
          shopArmed = row.id;
          renderShop();
          shopPanel.querySelector<HTMLButtonElement>(`[data-confirm="${row.id}"]`)?.focus();
        });
        actions.append(buy);
      }
    }

    // Preview first (issue #239): the shop sells looks, so the card leads with
    // the look and the words underneath only name it.
    li.append(preview, head, desc, actions);
    return li;
  }

  /** Fetch a set's bitmaps for its preview and re-render once they are in.
   *  A failure is reported and the row keeps its placeholder; reopening the
   *  shop tries again (glyphs.ts does not cache failures). */
  function ensurePreview(set: GlyphSet): void {
    if (set.dir === null) return;
    void glyphLoader.get(set.dir).then(
      () => {
        if (shopDialog.visible) renderShop();
      },
      () => setShopStatus(`Couldn't load the ${set.label} preview. Check your connection and try again.`),
    );
  }

  function chooseLook(row: ShopRow): void {
    if (!record.setLook(row.kind, row.id, Date.now())) return;
    shopArmed = null;
    setShopStatus('');
    renderShop();
    row.apply();
    syncCosmetics();
    announcer.say(`${row.spoken} in use.`);
    shopPanel.querySelector<HTMLButtonElement>(`[aria-label="${row.spoken}, in use"]`)?.focus();
  }

  function buyLook(row: ShopRow): void {
    shopArmed = null;
    if (!purchase(record, row.id)) {
      // The balance moved under the confirm (a sync landed): say so, re-render.
      setShopStatus(`Not enough trophies for the ${row.spoken}.`);
      renderShop();
      return;
    }
    setShopStatus(`Bought the ${row.spoken}. Tap Use to put it on the board.`);
    renderShop();
    syncCosmetics();
    announcer.say(`Bought the ${row.spoken} for ${row.price} trophies. ${trophyBalance(record.value)} left to spend.`);
    shopPanel.querySelector<HTMLButtonElement>(`[aria-label="Use the ${row.spoken}"]`)?.focus();
  }

  function recordAdopted(): void {
    shopArmed = null;
    if (shopDialog.visible) renderShop();
  }

  shopButton.addEventListener('click', () => shopDialog.open());
  shopClose.addEventListener('click', () => shopDialog.close());

  return { setStatus: setShopStatus, recordAdopted };
}
