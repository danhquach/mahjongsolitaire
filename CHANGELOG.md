# Changelog

Playtest builds deploy from `main` on every merge; entries are grouped by
deploy day. The in-game Settings screen shows this file with the exact
commit and build time of the running bundle.

## 2026-09-01

- Daily Challenge: Settings has a new row that deals the day's board — the
  same layout and arrangement for every player on that calendar date. Clear
  it for a trophy; clear it on consecutive days to build a streak, and the
  streak pays more (two trophies a clear from 7 days, three from 30). Every
  cleared level is now rated 1–3 stars — one for finishing without a Hint,
  Undo or Shuffle, one for finishing inside the level's time baseline — and
  the profile screen shows your stars, total score, live streak and
  trophies. In-flight saves restart the level once, progress kept (#19).
- A cleaner HUD: Level and Score are stat chips — a small label over a
  big number, the score in gold with a little pop on every gain — and
  New game / Restart became icon buttons. The Tiles counter is gone
  (the board shows what is left; screen-reader announcements still
  speak the count). On phones the old header wrapped to two rows; the
  new one holds one, so the board gets the height back.
- The game now has a player: Settings opens a profile screen with a
  display name and a pickable avatar, plus your own record — current
  level, levels cleared, and best score (streaks and trophies start
  counting when the Daily Challenge arrives). Everything is stored on
  the device; no account or sign-in exists, and the game stays fully
  playable offline (#69).
- All 10 board layouts reworked to a compact portrait shape — at most 9
  tiles wide, stacked 4–5 layers deep — so tiles stay big and readable
  on a phone. New game now deals the next layout from the current
  difficulty band's pool with a fresh arrangement; Restart still replays
  the board on the table. The 150-level ladder was rebuilt and
  re-validated on the new shapes; in-flight saves from the old shapes
  restart the level, progress kept. The booster buttons moved into their
  own band beside the board — below it in portrait, to its right in
  landscape — so no tile ever sits under them (#99).
- Undo now returns the most recently parked tile from the holder to its
  spot on the board — matched pairs are permanent, and score and combo
  are untouched. With nothing parked, Undo costs nothing and says so;
  the deadlock dialog offers it only when the holder has a tile to give
  back (#100).
- Buttons press: every control outside the board darkens and sinks while
  held — touch, mouse or Space — and releases back; instant swap under
  reduced motion (#95).
- New game now re-rolls a fresh arrangement of the current level; Restart
  keeps replaying the deal being played, re-rolled or not (#94).
- The holder is now the whole matching gesture (#93): one tap sends a
  revealed free tile to the holder, a concealed tile takes a reveal tap
  first, and pairs assemble and clear inside the holder — fly-in,
  side-by-side beat, score popup and particle burst. Selection and
  mismatches are gone; the combo now only breaks by timeout.
- Stacks read as physical piles: deeper cast shadows, thicker beveled
  sides and a larger per-layer offset carry depth, and tile faces stay
  bright on every layer (#86).
- Dots ink is now royal blue and Fall is russet, so Dots vs Winds and
  Fall vs Characters tell apart at a glance (#83).
- Face-down tile backs are a bright green that stands off the felt
  instead of blending into it (#82).
- The game now plays the 150-level ladder: each level has its own layout,
  deal and difficulty, clearing a level advances, and progress survives
  restarts (#79).
- Matching a found concealed pair is two taps: peeking a tile that pairs
  with the face already showing matches it immediately (#77).
- Matches with a held tile play the full match animation on the board-side
  tile (#73).
- Fixed: an uncovered tile with a same-layer neighbour half a tile away on
  one side was wrongly unselectable (#74).
- Version number and this changelog are visible in Settings (#81).

## 2026-08-31

- Flowers replaced with four composed Seasons tiles (#75).
- 150-level plateau ladder shipped in data, with its release gate (#18).
- Holder slots draw the real tile at board size (#66).
- Face-down tiles: difficulty-scaled concealment with peek-to-reveal (#64).
- The holder is one-way and a full holder ends the level (#63).
- Parking moved onto the board: activate a selected tile to park it; a tap
  on a tile whose partner is held clears the pair (#62).
- Holder: four off-board slots a free tile can be parked in (#43).
- Match feedback: the pair flies together and collides, with sound, haptic
  and particle burst; reduced-motion substitutes a cross-fade (#44).
- Tile depth shading and side faces (#45).
- All ten layouts shipped and solvability-swept (#17).
- The HUD edge is chosen per viewport for the largest board fit (#37).

## 2026-08-30

- First playable vertical slice: one Turtle level, tap input, mis-tap
  forgiveness, portrait and landscape (#11, #16).
- Accessibility foundation: DOM/ARIA board mirror, spoken outcomes, 48dp
  targets (#12).
- Boosters: Hint, Undo, Shuffle with persisted charges (#13).
- Auto-save on every move, resume after force-quit, settings screen (#14).
- Playtest deploys to Cloudflare on every green main build (#15).
- Core engine: board rules, generator, solver, difficulty, scoring,
  shuffle (#5–#10).
