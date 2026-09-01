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
| Daily Challenge | Trophy collection, retention driver |
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
- Classic level ladder (500 hand-curated + generated levels at launch)
- Guaranteed-solvable board generation
- Boosters: Hint, Undo, Shuffle
- Daily Challenge
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
2. Its **left** edge or **right** edge is fully unblocked at the same `z` (no tile overlapping the adjacent 2×2 footprint on that side).

Vertical adjacency does not block.

**Holder** *(added by decision 0008, PM 2026-08-31 — issue #43; amended by
decision 0009, PM 2026-08-31 — issue #63)*: a tile may also be parked in one of 4
off-board **holder slots**. A held tile is still in play and is always
**matchable** (it is off the lattice, so nothing can block it), but it occupies
no slot, so whatever it was covering becomes free. Tiles therefore have three
states: on the board, held, removed.

The holder is **one-way** (decision 0009, superseding 0008):
- only a **free** tile can be parked;
- a parked tile **cannot be taken back**. The only way to free a slot is to
  match the tile in it;
- **filling the fourth slot loses the level**, the moment it fills — see §3.5.

Undo still rewinds a hold, because undo rewinds *any* move; that is the move
never having happened, not the player returning a tile.

### 3.3 Matching
- Tap tile A (selected, highlighted), tap tile B.
- If A ≠ B, both **matchable** (free on the board, or held — decision 0008), and `match(A.face, B.face)` → remove both, award score.
- Otherwise deselect / reselect.
- **Tapping the selected tile parks it in the holder** *(amended by issue #62 —
  it used to deselect)*. Deselecting is a tap on empty board, or Escape.
- **A tap on a board tile whose face is in the holder clears that pair at once**
  *(issue #62)*: one tap, both tiles gone, the slot freed. An explicit selection
  still wins — if the tapped tile completes the pair the player picked, that is
  the pair played.
- Both rules are board-only: a tile already in the holder cannot be parked
  again, and two held tiles pair the ordinary two-tap way.
- Note for §7: parking is **not** a double-tap gesture. There is no timing
  window and no `dblclick` — it is "activate the tile you already selected", so
  a keyboard or screen-reader player reaches it with two ordinary activations,
  and a selected tile's accessible name says so.

**Match rule** *(amended by decision 0005, PM 2026-08-30 — wildcard groups removed)*:
- **Identical face match for ALL tiles**, Flowers and Seasons included (Dots, Bamboo, Characters 1–9 ×4, Winds ×4, Dragons ×3, Flowers ×2 per face, Seasons ×2 per face).

### 3.4 Tile set
Standard 144: 36 Dots, 36 Bamboo, 36 Characters, 16 Winds, 12 Dragons, 4 Flowers, 4 Seasons. Flowers and Seasons ship as two identical copies of two faces each (`flower-1` ×2, `flower-2` ×2; `season-1` ×2, `season-2` ×2 — decision 0005) so every tile has an identical partner. Layouts may use fewer tiles but always an even count per face.

### 3.5 Win / loss
- **Win:** all tiles removed. Held tiles count as in play — an empty board with a tile still parked is not a win (decision 0008).
- **Loss** *(added by decision 0009, PM 2026-08-31 — issue #63)*: **the holder is full.** It fires the moment the fourth slot fills, whatever else is on the board — a playable pair in plain sight does not save it. The level is over: **no Shuffle, no Undo, no continue.** The dialog offers Restart level and New game, and nothing else. This is the one place v1 hard-fails the player, and it is deliberate: the holder is a resource you can spend yourself out of, which is what makes spending it a decision.
  - The player is warned before the step, not after it: the last empty slot is marked in the strip, the holder group's accessible name says one slot is left, and a selected tile's accessible name says that activating it again would park into the last slot and end the level.
  - The loss survives a force-quit. A save is written for a lost level exactly as for a deadlocked one, so reloading is not an escape hatch from a nearly-full holder.
- **Deadlock:** no matching pair is reachable → offer Shuffle (free the first time per level, then rewarded-ad/booster). Never hard-fail the player *here* — the deadlock dialog keeps its boosters; the loss above is a different state. *Reachable* includes what the holder can open up (decision 0008): parking a free tile can free the tile under it, so a board with no pair on it is only a deadlock once no sequence of holds exposes one. Since decision 0009 that search **stops one slot short**: the park that would fill the holder ends the level, so it is not a way out of a deadlock.
- No timer by default. Timed mode is an opt-in setting.

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
- Bucket into Easy / Medium / Hard / Expert; ladder interleaves buckets on a rising curve with a "relief" easy level every ~5.
- Difficulty is scored on a **no-holder** position, which is a lower bound on how easily a level plays now that the holder is always available (decision 0008) — the ladder has to be bucketed against holder-aware play.

**Layouts:** Turtle, Pyramid, Fortress, Spider, Butterfly, Cat, Bridge, plus original layouts. Layouts are data files (JSON), not code.

---

## 5. Boosters

| Booster | Behavior | Constraints |
|---|---|---|
| **Hint** | Highlights one valid free pair; cycles through pairs on repeat taps | Costs 1 charge; no penalty to score in casual mode |
| **Undo** | Restores the last removed pair (full move stack, unlimited depth) | 1 charge per undo; must restore selection state and score |
| **Shuffle** | Re-randomizes faces of the tiles still *on the board*, preserving slot occupancy | Must re-run solvability check; regenerate if unsolvable. Held tiles keep their faces (decision 0008) |
| **Hold** | *Retired as a rail control by issue #62* — parking is a board gesture (§3.3): activate the selected free tile again | **Not a charged booster** (decision 0008): free and always available, and one-way (decision 0009) — the park that fills the fourth slot loses the level (§3.5). Hold and holder-match are undoable moves; there is no return move |

Starting grant: 5 of each of the three charged boosters; the holder has no balance. Replenishment: daily login grant, level milestones, rewarded video, IAP bundle.

---

## 6. Scoring & Progression

- Base: 100 pts per pair.
- **Super Combo:** consecutive matches within a 5s window escalate a multiplier (×1.2, ×1.5, ×2.0, cap ×3.0). Broken by a mismatch or timeout. Purely additive reward — never punitive.
- Star rating per level (1–3) from moves used, hints used, and completion time relative to the level's baseline.
- Persistent: level index, stars, total score, streak, trophies.

**Daily Challenge:** one deterministic board per calendar date (seed = date hash), shared across all users. Completion grants a trophy; consecutive days build a streak with escalating rewards.

---

## 7. UX & Accessibility Requirements (the actual differentiator)

- **Minimum tile touch target: 48×48 dp**; tile face artwork scales with a user-set "Tile Size" (S/M/L/XL).
- Default type scale ≥ 18sp body; support OS Dynamic Type up to 200%.
- Contrast ratio ≥ 4.5:1 for all text and tile symbols; colorblind-safe suit differentiation (shape + symbol, not color alone).
- Every action reachable within 2 taps from the board.
- No double-tap, long-press, drag, or pinch requirements for core play. Optional pinch-zoom on tablets.
- Mis-tap forgiveness: nearest-free-tile resolution within 8dp of a tap point.
- Audio and haptics independently toggleable; both default ON but gentle.
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
- Undo: property test — `apply(moves) → undo(n) → apply(same n)` yields identical state hash, on a move list containing holds (decision 0009 removed returns).
- Shuffle: post-shuffle board is always solvable; slot occupancy unchanged; held tiles keep their faces and are still counted for parity.
- Holder: property test — holding never makes the *position* less winnable (which is what keeps `solve` sound while ignoring holds), but a sequence of holds **can** lose the level, and there is a witness (decision 0009 reverses 0008's safety property, so it is tested as false rather than deleted); a full holder is a loss, not a refused hold; the deadlock search stops one slot short of the park that would fill the holder; solver and hint never report "no moves" while a holder pair exists.
- Combo/scoring boundary tests at the 5s window edges.

### 11.2 Integration
- Save/restore across force-quit at every move index of a sample level, including a play-through that uses the holder (holder contents and hold count restored exactly), and a lost level, which must resume *lost* (decision 0009 — a reload is not an escape hatch from a full holder).
- Booster charge accounting vs. rewarded-ad callbacks (including ad-failed and ad-abandoned paths).
- IAP restore, including Remove-Ads on a fresh install.
- Daily Challenge determinism across devices, timezones, and DST boundaries.

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
3. **M3 — Content (2 wks):** 10 layouts, 500-level ladder, difficulty bucketing, Daily Challenge.
4. **M4 — Services (2 wks):** ads, IAP, analytics, remote config.
5. **M5 — Polish & Accessibility (2 wks):** device matrix, a11y audit, performance pass.
6. **M6 — Soft launch:** limited geo, tune ad frequency and difficulty curve on real retention data.
