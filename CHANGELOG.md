# Changelog

Playtest builds deploy from `main` on every merge; entries are grouped by
deploy day. The in-game Settings screen shows this file with the exact
commit and build time of the running bundle.

## 2026-09-02

- Spotting a match while peeking at a face-down tile now clears it. Tapping a
  free tile whose face matches the one you just peeked at sends both to the
  holder and clears them there, scored like any other pair — instead of
  parking the tile you tapped and quietly flipping the peeked one back down.
  Tapping a tile that doesn't match still parks it and drops the peek as
  before (#169).
- Face-down tiles now play like the reference game. A face-down tile whose
  match is already in the holder goes straight there on one tap, turning over
  in flight — so remembering a peeked face pays off in one tap instead of
  two. A peek no longer changes what other taps do: tapping another tile
  parks it (or clears it against the holder) as usual, and the peek simply
  flips back. Undo leaves a peek showing. The short-lived "match against the
  peek on the board" rule from #124 is gone (#165).
- A cleared Daily Challenge stays cleared. Once today's board is credited,
  the Daily chip greys out and can't be tapped again until tomorrow's board
  arrives (its spoken name says so), and Restart won't re-deal it either — so
  the Daily leaderboard measures one shared run, not the best of many. Losing
  a Daily still lets you retry it as often as you like (#166).
- Bamboo 6 and Bamboo 9 no longer look alike. Both used to show three tall
  green-red-green columns, and you had to count canes to tell two rows from
  three. Canes are now shorter, with a clear gap between rows, and the red
  canes follow the traditional pattern: a red bottom row on 6, a red middle
  row on 9, a red top cane on 3 and 7, a red centre on 5 (#163).
- What's new opens at the newest release and closes on a tap outside the
  card, like every other dialog. It used to open scrolled to the oldest
  entry and only close from its Done button (#168).
- A stuck board stays grey. The deadlock's grey-out used to fade in and then
  quietly let the tiles back to full colour under the "No moves left" card
  (and with Reduced motion on, the tiles were never grey at all). Now the
  board holds its grey for as long as it is stuck — through a rotation, and
  through a Shuffle that leaves it still stuck — and only comes back to
  colour when a rescue or a new deal lifts the deadlock (#159).
- The phone header is one row again. The New game and Restart buttons used to
  wrap under the stat chips and the two half-empty rows cost the board about
  50 px of height; now the chips and the two buttons share one row at every
  phone width, and a named player's chip shows the name over the level number
  without the word "Level" (the spoken name still says it). The Leaderboard
  button moved to the bottom bar beside Settings, so the bar is two groups:
  the three boosters on the left, Leaderboard and Settings on the right. The
  board grows into the height that frees up (#153).
- Tile faces lost their small corner letters and numbers. The West Wind and
  the White Dragon both carried a "W", and on a phone that corner was often
  the only part of a covered tile you could see — so it looked like a pair
  that wasn't one. Every face is now identifiable from its main art alone:
  the glyphs are bigger, the Dots rings and Bamboo canes are bolder, and each
  Dragon has its own colour — red 中, green 發, and the White Dragon is now a
  white double frame instead of a box character (#152).
- The tutorial now points. From step 2 on, everything except the thing the
  step is talking about goes dark: a free tile and a blocked tile side by side
  (tagged FREE and BLOCKED, with arrows), the matchable pair, the three
  boosters, the holder, the score. The tiles it picks are always ones you can
  see in full, and the card moves out of their way (#150).
- New players get a short tutorial. The first level opens with a six-step
  walkthrough — the goal, what makes a tile free, a real matchable pair
  highlighted on your own board, the three boosters, the holder, and how
  scoring works — with Next and Skip on every step (Esc skips too). Nothing is
  gated: you never have to make the demonstrated match to move on, and the
  tutorial spends no booster charge. Once you finish or skip it, it stays out
  of the way; "Show tutorial" in Settings brings it back on the next level for
  a refresher (#59).
- The Daily Challenge now has a leaderboard. Everyone gets the same board on
  a given date, so the scores are actually comparable — clear the Daily and a
  "Leaderboard" button on the win screen shows the top ten, your rank, and the
  players either side of you. It is opt-in and separate from Cloud sync:
  nothing appears until you tick "Show me on the leaderboard" in your profile,
  and unticking it removes every score you have posted, not just today's.
  Reading the board needs no profile at all. Replaying a Daily can improve
  your place but never costs you the one you have (#70).
- Your profile can now follow you off the device. "Cloud sync" in the profile
  screen is off by default and entirely optional — the game plays exactly the
  same without it. Turning it on gives you a player tag and a recovery code;
  entering that code after a reinstall or on another device brings back your
  name, avatar, record and Daily streak. Nothing is lost when the two sides
  disagree: scores and trophies keep the higher number, cleared levels keep
  both, and a long streak survives a fresh install that plays today. Names
  are checked before they can be shown to other players (#138).
- Tile size in Settings is now a one-row slider with three stops — Medium,
  Large, Extra large — instead of a four-option list, so the popup is shorter
  on a phone. Small is gone (too small to read on a phone); anyone who had it
  picked is moved to Medium. Each stop applies as you reach it, by touch or
  arrow key, and screen readers hear the stop's name (#139).
- Tapping the Level chip in the HUD opens your profile — name, avatar, and
  record — so progression is one tap from where it is shown. It is a real
  button for screen readers, named for what it shows and where it goes, and
  closing the profile puts focus back on the chip with the board untouched
  (#137).
- The Daily Challenge is one tap from the board: a "Daily" chip in the HUD,
  right after Score, in the Daily's indigo-and-gold palette. It pulses until
  today's board is cleared (a steady glow under reduced motion), reads as
  active while the Daily is on the table, and its tooltip names the date and
  your streak. The Daily row is gone from Settings (#136).
- The feedback form can now carry evidence: an "Add image or video" control
  attaches up to three screenshots or a short screen recording (images up to
  10 MB, video up to 25 MB, 25 MB in all), shown as thumbnails with a remove
  control before sending. Images are redrawn on your device before they
  leave it, so no camera or location metadata travels with them. A failed
  send keeps the attachments along with the text; the "Email it instead"
  fallback can't carry files and says so (#130).
- Settings gains a "Send feedback" row: a short Summary + Body form that
  emails the QA inbox directly from the game, with the build version, current
  level, and platform attached automatically. If the connection fails, the
  typed feedback stays on screen and an "Email it instead" link opens the
  same message in your mail app, so nothing is lost (#118).
- The settings gear moved into the booster rail, as its last control, instead
  of floating top-right inside the board — on narrow phones it could sit on
  top of the board's own top-right tiles. The rail's band is reserved space
  the board's fit already prices in, so nothing there can overlap a tile
  (#125).
- Peeking a face-down tile and tapping its match now clears the pair right
  there on the board — no trip through the holder, whether the tapped tile
  was already face-up or was itself face-down. Tapping a non-matching tile
  while the peek is showing fails the attempt instead: nothing moves, the
  peek flips back face down, and a still-hidden tapped tile stays hidden
  (#124).
- A deadlock now reads as a pause, not a loss: a slate wash sweeps in left to
  right over the board while the tile pictures desaturate, up to three
  near-pairs (tiles blocking each other) pulse an amber outline once each to
  hint at why Shuffle or Undo helps, and only then — a beat after that — does
  the "No moves left" dialog appear, in its usual neutral card. Reduced
  motion skips the sweep and the pulse and shows the grey wash and dialog at
  once; choosing Shuffle or Undo from the dialog clears the wash and restores
  full colour immediately if either lifts the deadlock (#122).

## 2026-09-01

- The holder-full loss now lands like the hard fail it is. The fourth tile
  slams into its slot instead of parking, the holder strip shakes twice and
  every slot reddens, a dark red wash settles over the board while whatever
  tiles are left slump, tilt and lose their colour, and only then — a beat
  later than a win's own celebration — does the dialog appear, tinted red,
  offering only Restart level and New game. Reduced motion skips the slam,
  shake and slump and shows the wash at once, at a lower opacity; reopening a
  save from a level that already ended this way shows the same instant wash
  at full opacity with no delay, since there is nothing left to replay
  (#121).
- Clearing a level now feels like a reward: the remaining tile pictures sweep
  off the board column by column, paper lanterns tinted to the board's own
  colours drift up from the felt, a light gold/cream/green confetti fall plays
  behind the dialog, and the final score counts up rather than just appearing.
  The dialog and its buttons are live within a second either way — the
  celebration plays around them, never in front of them. Reduced motion (OS
  preference or the in-app toggle) skips all four and just fades the dialog in
  with the final score shown at once (#120).
- The star rating is gone: a clear is a clear. The win dialog no longer
  shows stars, and the profile screen's Stars row is removed — levels
  cleared, total score, streak and trophies stay. Existing records keep
  every level they had rated (#119).
- Booster rewards no longer ask you to choose, and are rarer. The
  per-level first-clear grant is gone — it was too easy to stock up on.
  Every third new level cleared pays one charge of a random booster (it used
  to pay three) and the level-complete dialog just says which ("3 levels
  cleared: +1 Shuffle"); the first clear of a milestone level — 10, 20,
  30, … — pays one of every booster. Grants that land on the same clear
  stack and are each listed. The pick buttons are gone, which also removes
  the dialog that could come back after a pick with dead buttons (#116,
  #117).
- The timer is gone: the Time chip and the "Show a timer" setting are
  removed (PM request). Nothing about pace is shown on the board; the game
  still keeps time quietly for the save.
- Special boards look special: the Daily Challenge plays on night indigo
  felt with gold tile edges, and every tenth ladder level — the decade
  milestone — on burgundy with rose edges; ordinary levels keep the warm
  lantern look. Only the felt, tile outline, side shading and face-down back
  change; the face art is untouched, every palette holds the same contrast
  and greyscale floors, and the Level chip names the level kind ("Daily",
  "Milestone") so colour never carries the meaning alone (#67).
- Boosters replenish: clearing a level for the first time earns one charge
  of a booster you pick on the level-complete dialog (an unclaimed pick goes
  to whichever you have fewest of); every third new level cleared pays three
  more at random; and the first launch of each day adds one of each. Replays
  earn nothing, balances cap at 99, and the grants are spoken to screen
  readers. A player at zero of everything can always earn their way back
  without ads or purchases (#51).
- Daily Challenge: Settings has a new row that deals the day's board — the
  same layout and arrangement for every player on that calendar date. Clear
  it for a trophy; clear it on consecutive days to build a streak, and the
  streak pays more (two trophies a clear from 7 days, three from 30). The
  profile screen shows levels cleared, total score, live streak and
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
