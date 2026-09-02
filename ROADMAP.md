# Mahjong Solitaire — Product Roadmap

**Source spec:** [mahjong-solitaire-spec.md](mahjong-solitaire-spec.md)
**Owner:** PM (Danh) · **Status:** v0.5.0 — 2026-08-31 (wk-5 playtest feedback folded in: game feel added to Phase 3; Holder pulled from the v1.1+ backlog into Phase 3 per decision 0008; ladder rescoped from 500-level rising curve to 150-level plateau ladder per decision 0011)
**Target:** iOS + Android · MVP scope per spec §2.1

---

## 1. Product goals & success criteria

| Goal | Metric (soft-launch gate) |
|---|---|
| Retention-competitive casual game | D1 ≥ 35%, D7 ≥ 15% |
| Ad experience is a differentiator, not a complaint | Ad-related 1★ reviews < 5% of negatives; uninstall-after-ad correlation flat |
| Zero broken boards in the wild | 0 unsolvable-board reports; `deadlock_hit` without shuffle-out < 0.5% of levels |
| Accessibility as positioning | A11y audit pass (contrast ≥ 4.5:1, VoiceOver/TalkBack traversal, Dynamic Type 200%) |
| Performance floor | 60fps on 5-yr-old mid-tier Android; cold start < 2.0s; gen+solve < 150ms |

## 2. Pre-Phase 0 decisions (blockers — decide before M1 starts)

1. **Stack choice** (spec §9 leaves it open). Added requirement (PM, 2026-08-30): playable on any mobile device AND desktop, no OS restriction. **Recommendation: web-first TypeScript + Canvas (PixiJS)** — `/core` as a pure TS package (matches spec §9 module naming), runs in any browser on all OSs, playtests distribute as a URL; wrap with Capacitor in Phase 4 for store builds (ads/IAP SDKs in the wrapper). Spike still validates the a11y approach (DOM/ARIA overlay on the canvas board). Fallback: Flutter if the Capacitor ads/IAP or low-end-device perf spike fails.
2. **App name + art direction** — IP-safe original name/icon/tile art (spec §12, store-rejection risk). Art is the longest external lead time; commission tile-set + UI art **in parallel with M1**.
3. **Ad mediation + analytics vendors** — pick by end of M2 (AdMob/AppLovin MAX; Firebase Analytics baseline). Needed for M4 integration, but SDK choice affects app size budget (< 80MB).
4. **Spec contradiction — RESOLVED (issue #3, 2026-08-30):** ads are **suspended for v1.0** — fully playable ad-free, all ads OFF by default, opt-in via settings toggle. When enabled, banner + interstitial + rewarded all apply under spec §8 (contradiction moot). Remove-Ads IAP deferred to v1.1+. Phase 4 scope updated below.
5. **Staffing assumption** (all dates depend on this): 2 engineers (1 core/gameplay, 1 UI/services) + 1 contract artist + PM/QA (Danh). Phases 2–4 assume the two engineers work in parallel; single-engineer reality stretches Phases 2–4 by ~50%.

## 2b. Playtest checkpoints (for PM)

| When | What's playable |
|---|---|
| **End of wk 5** (Phase 2 exit) | First hands-on playtest: one full level, boosters, save/resume — any browser (mobile or desktop) |
| **End of wk 9** (Phase 4 exit) | Feature-complete MVP per spec §2.1: 150 levels (decision 0011), Daily Challenge, ads behind opt-in toggle (default OFF) — broad playtest |
| **Wk 12** (Phase 5 exit) | Release-quality build → soft launch |

## 3. Phases

### Phase 1 — Core engine (M1) · 2 wks
**Deliverables:** slot lattice + free-tile rule; match rules incl. Flower/Season wildcards; seeded reverse-construction generator; bounded-DFS solver; difficulty scorer + bucketing; headless test suite.
**Exit criteria (gate to Phase 2):**
- Generator: 10,000 seeds × each of 3 seed layouts → 100% solvable, even counts per group, all slots filled (spec §11.1; extended to all 10 layouts in Phase 3).
- Undo property test green; determinism test: same `(layoutId, seed, moveList)` → identical state hash.
- Shuffle post-solvability test and combo 5s-window boundary tests green (spec §11.1).
- Gen+solve p95 < 150ms on target low-end device (benchmark harness, not emulator; harness built by UI/services engineer in wk 1 — it predates the app shell).
**Risk watched:** solver blow-up on dense layouts → bounded DFS + memo, reseed fallback.

### Phase 2 — Playable vertical slice (M2) · 3 wks
**Deliverables:** rendering + input on one layout (Turtle); tap select/deselect, mis-tap forgiveness (8dp nearest-free); Hint/Undo/Shuffle wired to core; auto-save every move + resume after force-quit; settings screen (audio + haptics independently toggleable, tile size S–XL, timed-mode opt-in, ads toggle **default OFF** per issue #3); placeholder art.
**Accessibility is built here, not retrofitted** (spec §7 is the differentiator; canvas-drawn tiles have no native semantics tree — bolting it on later is a rewrite risk): 48dp minimum touch targets, semantic tile nodes for VoiceOver/TalkBack, every action ≤ 2 taps from board, no drag/long-press/pinch in core play.
**Exit criteria:**
- One full level playable end-to-end on phone + tablet, portrait + landscape.
- Save/restore integration test passes at every move index of a sample level (spec §11.2).
- VoiceOver/TalkBack can traverse and match a pair on the slice board; touch-target audit ≥ 48dp.
- Internal playtest (≥ 5 people incl. one 55+ target-audience proxy): ≥ 4/5 complete a level unaided in < 3 min.
**Dependency:** final tile art lands mid-phase; ship slice on placeholders if late.

### Phase 3 — Content & progression (M3) · 2 wks
**Deliverables:** 10 layouts as JSON data; 150-level plateau ladder (curated + generated; decision 0011: three flat bands — 1–20 Easy, 21–60 Medium, 61–150 Medium+ — every 10th level spiking one band up; no rising curve or separate relief levels); scoring + Super Combo; ~~star ratings~~ removed by issue #119 — a clear is a clear; Daily Challenge (date-hash seed, DST/timezone-safe); local progression persistence.
**Game feel lands here, not in Phase 5** (added 2026-08-31 from the wk-5 playtest): the wk-9 broad playtest is the first real read on retention, and it is worthless if the board is unreadable and matching feels like nothing. Two items:
- **Tile depth readability (issue #45):** stacked layers currently read as one flat sheet — you cannot see which tiles are free without tapping. Drop shadows + side shading + per-layer value shift. Ships with the 10 layouts because every layout stacks differently.
- **Match feedback animation (issue #44):** matched tiles fly together and collide instead of vanishing; mismatch shake; reduced-motion alternative. Pairs with Super Combo — a 5s-window scoring mechanic with no visible feedback will not read.
- **Holder — temporary tile store (issue #43, pulled in 2026-08-31):** four off-board slots a free tile can be parked in to reach what is under it, always available and free (decision 0008). Core-engine work, not UI: hold and holder-match are move types in the determinism contract, held tiles are matchable to the solver and hint, and the deadlock check looks through hold sequences before it offers Shuffle. **It has to land before ladder calibration**, which is why it is here and not in v1.1: an always-available assist changes every level's effective difficulty, and re-bucketing the shipped ladder afterwards is the expensive path. (Decision 0011 later cut that cost differently: the v1 ladder is a 150-level plateau needing only band ordering, with full calibration deferred.)
  - **Amended the same day by decision 0009 (issue #63, playtest #16):** the holder is **one-way** — a parked tile can only leave by being matched, and filling the fourth slot **loses the level**. `unhold` is no longer a move (undo still rewinds a hold), the deadlock search stops one slot short of the park that would fill the holder, and spec §3.5 gains v1's one hard-fail.
  - **Parking is a board gesture (issue #62):** activate the selected free tile again; one tap on a board tile whose face is in the holder clears that pair. The rail's Hold control is retired.
  - **Reworked by decision 0013 (issue #93, per the Vita reference recording):** one tap sends any revealed free tile to the holder and **pairs assemble and clear in the holder** — selection is no longer an input concept, a held tile is not tappable, and the match feedback (fly-in, side-by-side beat, score popup, particle burst) anchors at the strip.
**Exit criteria:**
- CI job validates all 150 shipped seeds solvable AND runs 10,000 random seeds × all 10 layouts (spec §11.1) — becomes a permanent release gate.
- Daily Challenge determinism verified across device/timezone/DST fixtures.
- Ladder ordering (decision 0011, replaces the rising-curve criterion): `assessDifficulty` produces no misordered pair among the bands in use — a spike level never scores below its decade's base levels, and no Medium+ level scores below the Medium median. PM signs off against a per-level report of band, score, and spike positions, not by feel. Full holder-aware bucket calibration (decisions 0008/0009) and concealment re-balance (decision 0010) are deferred to a follow-up ticket.
- Depth readability: on each of the 10 layouts a first-time player identifies top-layer tiles without tapping; the cue survives greyscale and holds contrast ≥ 4.5:1 (issue #45).
- Match animation plays at 60fps on the reference low-end device, never blocks input, and honours reduced-motion (issue #44).
**Cost note:** these two items were not in the original 2-wk Phase 3 estimate. Expect ~+0.5 wk, or burn buffer.

### Phase 4 — Services (M4) · 2 wks
**Deliverables:** rewarded video + interstitial + banner via mediation, **all gated behind the settings ads toggle (default OFF, issue #3)** — no ad SDK init while the toggle is off; frequency caps **in code** (never mid-level, ≤ 1/3 levels, ≥ 90s gap, skip after 5s); booster economy (grants, replenishment); analytics event set (spec §10); remote config for level reordering + ad tuning (caps floor stays in code). ~~Remove-Ads IAP + restore~~ deferred to v1.1+ (issue #21).
**Exit criteria:**
- With ads toggle OFF (default): zero ad SDK calls in an instrumented full session.
- With ads toggle ON: instrumented ad-stub test asserts no mid-level interstitial and min-interval respected (spec §11.4).
- Booster accounting correct on ad-failed / ad-abandoned paths (rewarded, toggle ON).
- All analytics events visible in dashboard from a test device.

### Phase 5 — Polish, a11y audit, performance (M5) · 3 wks
Scope note: spec §11.1–11.2 tests run continuously in Phases 1–4 (see their exit criteria); Phase 5 executes §11.3–11.4 and — critically — includes time to **fix** what it finds.
**Deliverables:** device-matrix pass (small/large phone, 7"/12.9" tablet × both orientations); a11y **audit** (implementation landed in Phase 2): full VoiceOver/TalkBack board traversal, Dynamic Type 200%, contrast ≥ 4.5:1, colorblind-safe suits; interrupt handling (call, background, low-mem kill, rotation); offline/airplane-mode session incl. ad-failure paths; memory (100-level soak, no leak) + battery (30-min session) profiles; store assets + listings; fix window (≈1 wk). Game feel (issues #44, #45) is **audited** here, not built — depth cues under Dynamic Type 200% / colorblind simulation, and match animation under the 60fps floor on a full board.
**Exit criteria (release gate):**
- QA §11.3–11.4 executed; §11.1–11.2 suites green in CI; zero S1/S2 open.
- Performance targets §9 met on reference low-end device.
- Store review pre-check: original name/art/copy verified against IP risk (spec §12).

### Phase 6 — Soft launch → global (M6) · 3–4 wks (data-gated, not time-boxed)
**Plan:** limited geo (e.g. CA/AU/PH), staged rollout.
**Tune on real data:** ad frequency for opted-in users (within code-cap floor) + ads-toggle opt-in rate, difficulty curve via abandon-rate-by-level telemetry, deadlock rate by layout.
**Go/no-go for global:** goals table §1 met or consciously waived; crash-free sessions ≥ 99.5%.

## 4. Timeline summary

| Phase | Duration | Cumulative |
|---|---|---|
| 0. Decisions + art kickoff | 1 wk (overlaps M1) | wk 1 |
| 1. Core engine | 2 wks | wk 2 |
| 2. Vertical slice | 3 wks | wk 5 |
| 3. Content | 2 wks | wk 7 |
| 4. Services | 2 wks | wk 9 |
| 5. Polish & a11y audit (incl. fix window) | 3 wks | wk 12 |
| — Compliance workstream (overlaps 4–5); first review-able build submitted to TestFlight/closed track end of Phase 4 (wk 9) so a store rejection burns Phase 5 time, not the launch date | overlap | wk 9–12 |
| 6. Soft launch | 3–4 wks | wk 15–16 → global |

**Buffer:** +2 wks contingency (≈15%) not shown per-phase; burn transparently. Realistic global launch: **~wk 17–18**. All dates assume the §2 staffing level.

## 5. Cross-cutting workstreams (run alongside phases)

- **Art pipeline:** tile set, themes, icon — kickoff wk 1, final by mid-Phase 2, store assets by Phase 5. Depth rendering (shadow/shading, issue #45) is a renderer concern, not an asset concern — it must work with placeholder art and survive a theme swap.
- **CI:** from Phase 1 day 1 — core test suite on every commit; seed-validation job added Phase 3; device-farm smoke added Phase 5.
- **Legal/IP:** name clearance + store-likeness review before Phase 5 asset lock.
- **Store compliance & release (starts Phase 4):** store accounts + signing/provisioning; Apple ATT prompt + Google UMP consent flow (mandatory for an ad-supported app); privacy manifests / data-safety labels; age rating; app-review submission lead time (days–weeks, rejection possible) built in ahead of the soft-launch date.

## 6. Post-launch (v1.1+ backlog, from spec §2.2 — not committed)

Active Mind mode → themes/tile-set monetization → cloud save/sync → trophies/leaderboards → special tiles. Sequence by soft-launch learnings (retention gap vs monetization gap).

~~**Holder — temporary tile store (issue #43).**~~ **Pulled into Phase 3, 2026-08-31.** The condition this entry set was met: PM answered the three open questions (4 slots, always available, no score penalty) while #18 had not started, so the ladder is calibrated *with* the holder rather than re-bucketed after it. Shipped as decision 0008, then re-priced the same day by decision 0009 (one-way, and a full holder loses the level) — still before #18 started, so the condition holds.

## 7. Top risks on the roadmap itself

| Risk | Mitigation |
|---|---|
| Stack decision slips → M1 idles | Decide in Phase 0, time-box spike to 3 days |
| Art lead time > 5 wks | Kick off wk 1; placeholders unblock all phases |
| Level curation underestimated (largest hidden cost) | Decision 0011 cut the ladder to 150 levels needing only band ordering; generator + scorer automate it; human review only flagged outliers |
| Ad SDK bloat breaks 80MB budget | Size check in CI from Phase 4 |
| Soft-launch data inconclusive | Pre-register metric thresholds (§1) before launch |
