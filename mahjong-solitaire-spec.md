# Mahjong Solitaire — Product & Technical Specification

**Reference product:** Vita Mahjong (Vita Studio) — analyzed as a competitive benchmark.
**Target:** iOS + Android, portrait & landscape, phone + tablet.
**Note on IP:** Mahjong solitaire mechanics, layouts (Turtle/Dragon etc.), and tile suits are public domain. Original art, tile artwork style, app name, icon, UI compositions, and store copy must be original.

---

## 1. Competitive Analysis (reference product)

### 1.1 What it actually is
Mahjong *solitaire* (tile-matching), not 4-player Mahjong. The app itself carries a disclaimer that the term "Mahjong" refers only to tile visual style.

### 1.2 Positioning
- Primary audience: adults 55+ and casual players.
- Differentiators are **accessibility**, not depth: oversized tiles, high contrast, large type, no timer pressure.
- Secondary hook: "brain training" framing (memory/focus).

### 1.3 Feature inventory
| Feature | Notes |
|---|---|
| Classic level ladder | Several thousand levels (user reviews reference level 3400+) |
| Special/innovation tiles | Twist on classic matching |
| "Active Mind" mode | Memory-oriented variant |
| Daily challenges | Trophy collection, retention driver |
| Boosters | Hint, Undo, Shuffle — granted free, replenished via ads/IAP |
| Super Combo | Consecutive-match reward |
| Offline | Full offline play, no network dependency |
| Scoring | Optional; no timer pressure by default |
| Cross-device | Phone + tablet layouts |

### 1.4 Business model
Free, ad-supported (interstitial + rewarded video), with IAP for ad removal and booster packs. Sensor Tower data shows a high-download / low-ARPU profile (~4M downloads/mo, ~$100k/mo revenue in US iOS) — a volume/ads business, not a whale business.

> **v1.0 amendment (issue #3, 2026-08-30):** ads are **suspended for v1.0** — the game is fully playable ad-free, with ads OFF by default and enabled only via an explicit settings toggle (see §8). The ad-supported model above describes the eventual business, not the v1.0 default experience.

### 1.5 Weaknesses to exploit
1. **Ad experience is the #1 complaint.** Non-dismissable, redirect-to-store ads dominate negative reviews. → Strict ad frequency caps, guaranteed skip after n seconds, never interrupt mid-level.
2. Ads are the only real monetization; no meaningful cosmetic economy.
3. No social/asynchronous competition beyond trophies.
4. Level ladder is long but flat — little difficulty curve signaling.

---

## 2. Product Scope

### 2.1 MVP (v1.0)
- Classic level ladder (150 hand-curated + generated levels at launch; plateau ladder per decision 0011)
- Guaranteed-solvable board generation
- Boosters: Hint, Undo, Shuffle
- Daily challenges
- Local progression persistence
- Accessibility-first UI
- Ads **suspended** (issue #3): fully playable ad-free; ads OFF by default, opt-in via settings toggle. When enabled, banner + interstitial + rewarded per §8. Remove-Ads IAP **deferred to v1.1+** (redundant while ads are opt-in)

### 2.2 v1.1+
- Active Mind / memory mode
- Themes and tile sets (soft monetization)
- Cloud save + cross-device sync
- Trophy/streak system, leaderboards
- Remove-Ads IAP (deferred from v1.0; only relevant once ads default ON)
- Special tiles

### 2.3 Out of scope
Real-money gambling, 4-player riichi/HK Mahjong rules, PvP realtime.

---

## 3. Core Game Rules

### 3.1 Board model
A board is a set of tile **slots** in a 3D lattice:
- `x`, `y` in half-unit steps (a tile occupies 2×2 half-units, allowing classic half-offset stacking)
- `z` = layer index, 0 = bottom

```
Slot { x: number (half-units), y: number (half-units), z: int }
Tile { id: uuid, slot: Slot, face: FaceId, removed: bool }
```

### 3.2 Free-tile rule
A tile is **free** (selectable) iff:
1. No tile occupies any overlapping footprint at `z+1` ("not covered"), AND
2. Its **left** edge or **right** edge is fully unblocked at the same `z` (no tile **touching** that edge: anchored exactly 2 half-units away on that side with vertical overlap; a tile a further half-unit away does not touch the edge and does not block — clarified by issue #74).

Vertical adjacency does not block.

**Holder** *(added by decision 0008, PM 2026-08-31 — issue #43; amended by
decision 0009, PM 2026-08-31 — issue #63)*: a tile may also be parked in one of 4
off-board **holder slots**. A held tile is still in play and is always
**matchable** (it is off the lattice, so nothing can block it), but it occupies
no slot, so whatever it was covering becomes free. Tiles therefore have three
states: on the board, held, removed.

The holder is **one-way** (decision 0009, superseding 0008):
- only a **free** tile can be parked;
- a parked tile **cannot be taken back by a tap**. In play, a slot frees by
  matching the tile in it — or by the Undo booster (issue #100), which returns
  the most recently parked tile to its layout slot at the cost of a charge;
- **filling the fourth slot loses the level**, the moment it fills — see §3.5.

### 3.3 Matching
*(reworked by issue #93 / decision 0013 — pairs assemble and clear in the
holder; selection is no longer a concept. Face-down rules per issue #165 /
decision 0025, which superseded issue #124 / decision 0018, narrowed by issue
#169.)*
- **One tap on a revealed free tile sends it to the holder.** No select-first
  step, no deselect, no mismatch: every tap on a playable tile is a move.
- **If the tapped tile's face matches a tile already in the holder, the pair
  clears there**: the tile flies to the holder, the pair is shown side by side
  for a beat, then both clear with a score popup and a particle burst anchored
  at the strip. Score is awarded on the tap (`match(A.face, B.face)` with both
  tiles matchable, exactly as before); the show is decoration and never blocks
  input. A pair-completing tile never occupies a slot, so it cannot trip the
  full-holder loss (§3.5) in passing.
- **Otherwise the tile parks** in the first empty slot — and the park that
  fills the fourth slot loses the level (decision 0009, unchanged).
- A held tile is not tappable: it leaves the holder only by its board partner
  being tapped, or by the Undo booster returning the newest parked tile
  (issue #100).
- **Face-down tiles (issue #64, rules per issue #165 / decision 0025, the
  reference game's):** the match rule above applies to a hidden face too — a
  face-down free tile whose real face matches a held tile clears the pair on
  that tap, flipping in flight (the memory payoff: the player peeked it
  earlier and remembers). With no match held, the first tap **peeks**: the
  face is revealed in place, nothing moves, nothing is charged, and the peek
  has no timeout. Only one peek shows at a time; peeking another face-down
  tile flips the first back in the same frame. The second tap on the peeked
  tile sends it to the holder like any visible tile.
- **A peek is passive for a non-matching tap (issue #165, narrowed by issue
  #169):** while a peek is showing, a tap on a free tile whose real face does
  *not* match the peek does exactly what it would with no peek showing —
  parks, or clears against the holder — and the peek flips back face down.
  **A tap on a free tile whose real face *does* match the peek clears the
  pair instead** — same score, feedback and undo entry as any other match,
  hidden or not — and the clear still goes through the holder (decision
  0013): both tiles travel to and clear in the strip, the face-down half
  flipping on the way in, exactly like a match against an already-held tile.
  It never occupies the holder past its limit or trips the full-holder loss
  (§3.5) as a side effect. A tap matching a tile already in the holder takes
  priority over a tap matching the peek. Undo returns the newest parked tile
  and leaves the peek showing; Shuffle drops it. A face-down tile's
  accessible name never says more than "peek", even when the activation would
  clear it — against the holder or against the peek.
- Note for §7: nothing here is a double-tap gesture. A concealed tile's two
  taps are two ordinary activations with no timing window, and every free
  tile's accessible name spells out what activating it does.

**Match rule** *(amended by decision 0005, PM 2026-08-30 — wildcard groups removed; face set amended by decision 0012, PM 2026-08-31)*:
- **Identical face match for ALL tiles**, Seasons included (Dots, Bamboo, Characters 1–9 ×4, Winds ×4, Dragons ×3, Seasons ×2 per face).

### 3.4 Tile set
Standard 144: 36 Dots, 36 Bamboo, 36 Characters, 16 Winds, 12 Dragons, 8 Seasons. The Flower suit is removed (decision 0012); the Seasons are the four real seasons as two identical copies each (`season-spring|summer|fall|winter` ×2 — decisions 0005/0012) so every tile has an identical partner. Layouts may use fewer tiles but always an even count per face.

### 3.5 Win / loss
- **Win:** all tiles removed. Held tiles count as in play — an empty board with a tile still parked is not a win (decision 0008). The win dialog plays a short celebration around itself — a cascade of any remaining tile pictures, palette-tinted lanterns, a light confetti fall, and a score count-up — without delaying the dialog or its buttons past about a second; reduced motion (OS preference or the in-app toggle) skips the celebration and fades the dialog straight in with the final score shown at once (issue #120).
- **Loss** *(added by decision 0009, PM 2026-08-31 — issue #63)*: **the holder is full.** It fires the moment the fourth slot fills, whatever else is on the board — a playable pair in plain sight does not save it. The level is over: **no Shuffle, no Undo, no continue.** The dialog offers Restart level and New game, and nothing else. This is the one place v1 hard-fails the player, and it is deliberate: the holder is a resource you can spend yourself out of, which is what makes spending it a decision.
  - The loss is presented harder than the win or a lifted deadlock (issue #121, PM 2026-09-01): the fourth tile slams into its slot, the holder strip shakes and reddens, a dark wash settles over the board while the remaining tiles slump and lose their colour, and the red-tinted dialog appears about 1.4 seconds in. Reduced motion (OS preference or the in-app toggle) drops the slam/shake/slump and shows the wash at once, at a lower opacity; a reload of an already-lost save shows that same instant wash at full opacity with no delay, since the fight already happened and there is nothing left to replay.
  - The player is warned before the step, not after it (reworded by issue #93): the last empty slot is marked in the strip, the holder group's accessible name says one slot is left and that a tile with no match in the holder ends the level, and every free tile whose face has no match in the holder says that activating it sends it to the last slot and ends the level. A tile whose match is already in the holder is safe — its name offers the clear instead. Since issue #190 the same warning is shown in words to sighted players: a banner over the board while exactly one slot is empty, naming Undo as the way to free a slot before the fatal park.
  - Undo cannot rescue a full holder, and the loss dialog says so (issue #190, PM 2026-09-04): the rule was re-examined after issue #100 turned Undo into a return move and kept, because the game is already on the easy side and the Undo economy must not become a loss budget. Charges the player still holds stay theirs for the next level.
  - The loss survives a force-quit. A save is written for a lost level exactly as for a deadlocked one, so reloading is not an escape hatch from a nearly-full holder.
- **Deadlock:** no matching pair is reachable → offer Shuffle (free the first time per level, then rewarded-ad/booster). Never hard-fail the player *here* — the deadlock dialog keeps its boosters (since issue #100 it offers Undo only when the holder has a tile to return: Undo un-parks, so it cannot rescue a deadlock caused purely by matching); the loss above is a different state. *Reachable* includes what the holder can open up (decision 0008): parking a free tile can free the tile under it, so a board with no pair on it is only a deadlock once no sequence of holds exposes one. Since decision 0009 that search **stops one slot short**: the park that would fill the holder ends the level, so it is not a way out of a deadlock. And since issue #93 every pair transits the holder, so *reachable* is gesture-aware (`takeablePairs`): a pair with both tiles on the board needs two vacancies to transit, a pair with one tile held is one tap, and a held–held pair has no gesture at all — the deadlock check and the Hint booster both use this filter, so neither ever points at a pair whose first tap would end the level.
  - Because a deadlock is recoverable, it is presented as a pause, not a loss (issue #122, PM 2026-09-01, deliberately gentler than #121's hard fail): a slate wash sweeps left to right over the board as the tile pictures desaturate (and stay grey until a rescue or a new deal lifts the deadlock, issue #159), up to three near-pairs pulse an amber outline once each to hint at what Shuffle or Undo would open up, and the "No moves left" dialog appears in its usual neutral card about 1.5 seconds in. Reduced motion (OS preference or the in-app toggle) skips the sweep and the pulse and shows the grey wash and dialog at once; a reload of an already-stuck save does the same, with no cue.
- No timer. (The opt-in timed-mode readout and its Settings toggle were removed 2026-09-01 by PM request; the elapsed clock still runs silently — it feeds the save's `elapsedMs`.)

---

## 4. Level Generation (critical)

Naïve random dealing produces unsolvable boards. Use **reverse construction**:

1. Load layout geometry (ordered slot list).
2. Repeat until all slots filled:
   a. Compute the current set of **free slots** in the *empty-from-top* sense (a slot is placeable if all slots it would rest on are filled and its blockers are resolved) — practically: iterate the removal order backwards.
   b. Pick two currently-free slots, place a matching pair.
3. Result: a board with at least one guaranteed solution path.

**Requirements**
- Deterministic given `(layoutId, seed)`. Store only the seed, not the board.
- Post-generation solver validates solvability with a bounded DFS + memo (fail → reseed).
- Difficulty scoring per generated board:
  - `initial_free_pair_count`
  - `mean_branching_factor` across a solution path
  - `layer_count`, `tile_count`
  - `forced_move_ratio` (turns with exactly one legal pair)
  - *(Decision 0035, issue #212)*: the composite is pair-density dominant — `initial_free_pair_count` and `mean_branching_factor` carry 0.35 each, normalized over the range the shipped layouts occupy (48 pairs, branching 16); size, depth and forced moves carry 0.10 each.
- Bucket into Easy / Medium / Hard / Expert. The v1 ladder is a **plateau ladder** (decision 0011): 150 levels in three flat bands — 1–20 Easy, 21–60 Medium, 61–150 Medium+ (upper half of the Medium score range) — with every 10th level spiking one band up (Medium in the Easy band, Hard elsewhere). No rising curve and no separate relief levels: the nine base levels of each decade are the relief. Expert does not ship in v1.
- The scorer's v1 obligation is **ordering, not bucket accuracy**: no misordered pair among the bands in use (a spike never scores below its decade's base levels; no Medium+ level below the Medium median). Full holder-aware calibration (decisions 0008/0009) and concealment re-balance (decision 0010) are deferred to a follow-up ticket, required only if the ladder grows past the plateaus.

**Layouts:** Turtle, Pyramid, Fortress, Spider, Butterfly, Cat, Bridge, plus original layouts. Layouts are data files (JSON), not code. *(Reworked by issue #99 / decision 0015)*: every layout uses a **compact portrait profile** — at most 9 tile columns wide, up to 10 rows tall, 4–5 layers deep — so tiles stay legible on a phone. Each ladder band owns a layout pool (`LADDER_POOLS`), the shipped ladder pins layouts from the level's own pool, and **New game deals the next layout from the current band's pool** with a fresh seed (amending decision 0014); Restart replays the deal on the table, and "Next level" deals the ladder's pinned `(layoutId, seed)`.

---

## 5. Boosters

| Booster | Behavior | Constraints |
|---|---|---|
| **Hint** | Highlights one valid free pair; cycles through pairs on repeat taps | Costs 1 charge; no penalty to score in casual mode |
| **Undo** | Returns the **most recently parked tile** from the holder to its layout slot (issue #100, Vita behavior). Matched pairs are permanent — no Undo brings a matched tile back | 1 charge per return; an empty holder costs nothing ("Nothing to undo"). Score, combo ladder and later matches are untouched |
| **Shuffle** | Re-randomizes faces of the tiles still *on the board*, preserving slot occupancy | Must re-run solvability check; regenerate if unsolvable. Held tiles keep their faces (decision 0008) |
| **Hold** | *One tap is the whole gesture since issue #93 (§3.3)*: tapping any revealed free tile sends it to the holder; a pair completes and clears there | **Not a charged booster** (decision 0008): free and always available, and one-way in play (decision 0009) — the park that fills the fourth slot loses the level (§3.5). The Undo booster is the only return: it un-parks the newest parked tile (issue #100); matches are permanent |

Starting grant: 5 of each of the three charged boosters; the holder has no balance. Replenishment: daily login grant, level milestones, rewarded video, IAP bundle. (Issue #51, PM 2026-08-31: v1.0 ships the ads-independent channels — +1 of a random booster every third distinct ladder level first-cleared — announced, never picked (issue #117 dropped #51's per-level first-clear pick as too easy to stock up on) — plus +1 of each on the first clear of a milestone level (the decade spike: 10, 20, 30, …); both can land on one clear and stack; first launch of each local calendar day +1 of each; cap 99 per booster, clamped; replays never grant. Rewarded video and an IAP bundle would sit on top later.)

---

## 6. Scoring & Progression

- Base: 100 pts per pair.
- **Super Combo:** consecutive matches within a 5s window escalate a multiplier (×1.2, ×1.5, ×2.0, cap ×3.0). Broken by timeout (issue #93 removed the mismatch — a non-matching tap is a park, not a failed pair). Purely additive reward — never punitive.
- **Difficulty multiplier:** every pair is also scaled by the level's ladder band — easy ×1.0, medium ×1.5, medium-plus ×2.0, hard spikes ×2.5 — so a harder level pays more per match and grinding an easy one is the slowest way to earn. It is applied to the score itself, so the HUD and the win dialog show the already-multiplied number everywhere a score appears. The band and its factor are not surfaced as their own label — a player sees that a hard level pays more, not why. (Decision 0027, issue #176.)
- No star rating: a clear is a clear. (Issue #19 shipped a 1–3 star rating from assists used and completion time against a per-band baseline; issue #119 removed it as unnecessary complexity — nothing else in v1 read it.)
- **One score, and it is the week's.** A ladder clear adds its final score to the player's score for the current week, which is both what the profile shows and what the leaderboard ranks. It resets with the week. The lifetime total and the best-run score are gone (decision 0027, issue #176).
- Persistent: level index, cleared levels, this week's score and the week it belongs to, streak, trophies. (Issue #19: all on the local player record, `mahjong.record.v1`, except cleared levels which issue #119 keeps as a plain set rather than per-level ratings; the level index keeps its own key.)

**Daily challenges:** a calendar date names three challenges — finish N boards, match N pairs, match N pairs of one suit, match N pairs in a row without a hint or shuffle — dealt from the date itself, so everyone gets the same three that day. There is no Daily board: they are completed by playing the ladder, and the HUD's Daily chip opens a panel of today's three with live progress rather than dealing anything. (Decision 0028, issue #183, replacing the deterministic board of decision 0016 and the replay lock of 0026.)

- **All of the day's play counts.** Every match and every finished board, on any level; progress accumulates across boards and survives a loss, a restart or an abandoned deal. The one counter that falls is the assist-free run, reset to zero by a charged Hint or Shuffle (never by Undo, which returns a parked tile and takes back no match). Counters roll over on the next local calendar date, carrying nothing.
- **Each completed challenge pays 1 trophy and 1 booster charge**, and the day's first completion also extends the streak and pays its tier bonus — 2 trophies from a 7-day streak, 3 from 30 (decision 0016's schedule). A full day pays 3 trophies, 4 on a 7-day streak, 5 on a 30-day one. The streak counts days, not challenges, so a short session still keeps it alive.
- **It pays trophies, the streak and that charge, and nothing else** — no score is banked from it and it is not counted as a level cleared (decision 0027, issue #176).

**Leaderboard:** one weekly board, ranking players by score earned on the ladder over the week. The week starts Sunday 00:00 UTC on the server's clock, so everyone is ranked over the same seven days; only the live week is browsable, and the board shows a countdown to its reset. Appearing on it is a second opt-in, separate from cloud sync, and turning it off removes every entry. (Decision 0027, issue #176, superseding the Daily board of decision 0022.)

---

## 7. UX & Accessibility Requirements (the actual differentiator)

- **Minimum tile touch target: 48×48 dp**; tile face artwork scales with a user-set "Tile Size" (M/L/XL slider; Small retired 2026-09-02, issue #139).
- Default type scale ≥ 18sp body; support OS Dynamic Type up to 200%.
- Contrast ratio ≥ 4.5:1 for all text and tile symbols; colorblind-safe suit differentiation (shape + symbol, not color alone).
- Every action reachable within 2 taps from the board.
- No double-tap, long-press, drag, or pinch requirements for core play. Optional pinch-zoom on tablets.
- Mis-tap forgiveness: nearest-free-tile resolution within 8dp of a tap point.
- Audio and haptics independently toggleable; both default ON but gentle.
- Every interactive control shows a pressed state while activated — pointer or keyboard — and releases back (issue #95). Visual only, no haptic; under reduced motion the state swap is instant.
- Ads master toggle in settings; **default OFF** (see §8). Turning it on enables banner/interstitial/rewarded under the §8 rules; turning it off disables all ads immediately.
- No countdowns, no lives, no energy gates.
- Auto-save on every move; resume mid-level after force-quit.

---

## 8. Monetization Rules

**v1.0 policy (issue #3, 2026-08-30): ads are suspended.** All ads are OFF by default; the full game is playable ad-free. A settings toggle (§7) lets the player opt in. The rules below apply whenever ads are enabled — this also resolves the former §2.1/§8 contradiction: when the toggle is on, banner + interstitial + rewarded are all in scope under these rules.

- **Interstitials:** never mid-level. Only after level completion, max 1 per 3 completed levels, min 90s between. Hard skip available after 5s.
- **Rewarded video:** always opt-in, always for boosters/extra shuffle. Clearly labeled reward.
- **Banner:** menu screens only. Never overlapping the board.
- **Remove Ads IAP:** deferred to v1.1+ — redundant while ads are opt-in (the toggle already removes them). If/when ads default ON, it returns as a single non-consumable removing interstitials and banners; rewarded video remains available by choice.
- No ad may redirect out of the app without an explicit user tap on the ad creative.

---

## 9. Technical Architecture

**Recommended stack:** Unity (2D) or Flutter/Flame for cross-platform; native SwiftUI/Compose is viable given the low rendering demands and yields the best accessibility integration.

```
/core        pure game logic, zero platform deps, fully unit-testable
  board.ts       slot lattice, free-tile computation
  generator.ts   seeded reverse-construction generator
  solver.ts      solvability validation, hint search
  rules.ts       match rules, scoring, combo
/data
  layouts/*.json
  progression.json
/persistence   local store (SQLite/Prefs) + optional cloud sync
/ui            rendering, input, accessibility
/services      ads, IAP, analytics, remote config
```

**Key invariant:** `/core` is deterministic and side-effect free. Given `(layoutId, seed, moveList)` the board state is exactly reproducible — this is what makes the whole thing testable.

### Data model
```json
{
  "levelId": 412,
  "layoutId": "turtle_classic",
  "seed": 88213947,
  "difficulty": "medium",
  "tileSet": "standard_144"
}
```
```json
{
  "saveState": {
    "levelId": 412,
    "seed": 88213947,
    "moves": [[12,88],[3,140]],
    "boostersUsed": {"hint":1,"undo":0,"shuffle":0},
    "score": 1240,
    "elapsedMs": 91400
  }
}
```

### Performance targets
- 60fps on a 5-year-old mid-tier Android device.
- Cold start to playable board < 2.0s.
- Level generation + solvability validation < 150ms on-device.
- APK/IPA < 80MB; layouts and tile atlases are the bulk.
- Zero network calls required for core gameplay.

---

## 10. Analytics

Minimum event set: `level_start`, `level_complete`, `level_abandon`, `deadlock_hit`, `booster_used`, `ad_shown`, `ad_completed`, `iap_purchased`, `session_start/end`, `settings_changed`.

Key metrics: D1/D7/D30 retention, levels/session, abandon rate by level (difficulty curve validation), deadlock rate by layout, ad-to-uninstall correlation.

---

## 11. QA Strategy

### 11.1 Unit (core, deterministic — the highest-value layer)
- Free-tile computation: exhaustive fixtures per layout for covered / left-blocked / right-blocked / both-blocked / free.
- Match rules: identical-face match for all tiles (decision 0005 — no wildcard groups), self-match rejection, non-free rejection.
- Generator: for each layout × 10,000 seeds → assert solvable, assert tile count even per face, assert every slot filled.
- Solver: known-solvable and known-deadlocked fixtures.
- Undo: property test — `park(k) → undo(k)` restores the pre-park state hash exactly, and undo returns parked tiles newest-first, skipping tiles matched out of the holder (issue #100: matches are permanent).
- Shuffle: post-shuffle board is always solvable; slot occupancy unchanged; held tiles keep their faces and are still counted for parity.
- Holder: property test — holding never makes the *position* less winnable (which is what keeps `solve` sound while ignoring holds), but a sequence of holds **can** lose the level, and there is a witness (decision 0009 reverses 0008's safety property, so it is tested as false rather than deleted); a full holder is a loss, not a refused hold; the deadlock search stops one slot short of the park that would fill the holder; solver and hint never report "no moves" while a holder pair exists.
- Combo/scoring boundary tests at the 5s window edges.

### 11.2 Integration
- Save/restore across force-quit at every move index of a sample level, including a play-through that uses the holder (holder contents and hold count restored exactly), and a lost level, which must resume *lost* (decision 0009 — a reload is not an escape hatch from a full holder).
- Booster charge accounting vs. rewarded-ad callbacks (including ad-failed and ad-abandoned paths).
- IAP restore, including Remove-Ads on a fresh install.
- Daily challenge determinism across devices, timezones, and DST boundaries: the date key, the three challenges it names, and the streak arithmetic.

### 11.3 E2E / device
- Screen matrix: small phone, large phone, 7" tablet, 12.9" tablet; portrait + landscape.
- Accessibility: VoiceOver/TalkBack traversal of the board, Dynamic Type at 200%, contrast audit.
- Offline: airplane mode through a full session including ad-request failure paths.
- Interrupt: incoming call, backgrounding, low-memory kill, OS-level rotation.

### 11.4 Non-functional
- Ad frequency cap verification via instrumented ad-service stub (asserts no mid-level interstitial, min interval respected).
- Memory profile over 100 consecutive levels — assert no leak in board teardown.
- Battery drain over a 30-min session.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Unsolvable boards shipped | Solver gate in generation + CI job validating all shipped seeds |
| Ad experience drives 1-star reviews | Hard frequency caps in code, not remote config alone |
| Difficulty curve rejection / abandon spikes | Abandon-rate telemetry per level, remote-config level reordering |
| Category is saturated | Compete on accessibility and ad restraint, not on level count |
| Store rejection over "Mahjong" naming/likeness | Original assets, original app name, mechanics-only reuse |

---

## 13. Milestones

1. **M1 — Core (2 wks):** lattice, free-tile rule, matching, generator + solver, headless test suite.
2. **M2 — Playable (3 wks):** rendering, input, one layout, undo/hint/shuffle, persistence.
3. **M3 — Content (2 wks):** 10 layouts, 150-level plateau ladder (decision 0011), difficulty band ordering, daily challenges.
4. **M4 — Services (2 wks):** ads, IAP, analytics, remote config.
5. **M5 — Polish & Accessibility (2 wks):** device matrix, a11y audit, performance pass.
6. **M6 — Soft launch:** limited geo, tune ad frequency and difficulty curve on real retention data.
