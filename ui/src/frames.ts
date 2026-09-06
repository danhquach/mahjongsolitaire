// Purchasable avatar frames (issue #229 slice 3, decision 0041): a ring drawn
// around the avatar emoji on the profile row and on every leaderboard row.
//
// A frame is one bitmap under `frames/<id>.png` (Vite's publicDir is `data/`),
// shown as the CSS background of the avatar badge, fitted to it. This table is
// the only path from a frame *id* to anything the page shows: an id arrives
// from the record, and on the leaderboard from other players' records, so it
// is looked up here and never interpolated into a URL, class or attribute.
// An id this build does not know draws no frame.

/** The free frame every record starts with: none. */
export const DEFAULT_FRAME = 'lantern';

export interface AvatarFrame {
  readonly id: string;
  readonly label: string;
}

export const FRAMES: Readonly<Record<string, AvatarFrame>> = {
  [DEFAULT_FRAME]: { id: DEFAULT_FRAME, label: 'None' },
  'frame-gold-ring': { id: 'frame-gold-ring', label: 'Gold Ring' },
  'frame-jade-square': { id: 'frame-jade-square', label: 'Jade Square' },
  'frame-vermilion-double': { id: 'frame-vermilion-double', label: 'Vermilion Double' },
  'frame-wave': { id: 'frame-wave', label: 'Wave' },
  'frame-lantern': { id: 'frame-lantern', label: 'Lantern' },
  'frame-plum': { id: 'frame-plum', label: 'Plum' },
  'frame-dragon': { id: 'frame-dragon', label: 'Dragon' },
};

/** The frame a look names — none for an id this build does not ship. */
export function frameFor(id: string): AvatarFrame {
  return FRAMES[id] ?? FRAMES[DEFAULT_FRAME]!;
}

/** Where a frame's bitmap lives, relative to the app's base URL; null for the
 *  default, which draws nothing. Only ever called with an id from FRAMES. */
export function frameUrl(frame: AvatarFrame): string | null {
  return frame.id === DEFAULT_FRAME ? null : `frames/${frame.id}.png`;
}

/**
 * Dress an avatar badge: the emoji stays its text, the frame (if any) is its
 * background. `frameId` may come from another player's record, so it goes
 * through the table and nothing else reaches the DOM.
 */
export function applyFrame(badge: HTMLElement, frameId: string): void {
  const url = frameUrl(frameFor(frameId));
  badge.classList.toggle('framed', url !== null);
  badge.style.backgroundImage = url === null ? '' : `url("${url}")`;
}
