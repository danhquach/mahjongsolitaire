# Decision 0001 — Tech stack: web-first TypeScript + PixiJS, Capacitor wrappers

**Status:** DRAFT — pending PM approval · **Date:** 2026-08-30 · **Issue:** #1 · **Roadmap:** §2.1

## Decision

Adopt the recommended stack: **TypeScript, `/core` as a pure TS package, PixiJS (v8) canvas rendering, DOM/ARIA overlay for accessibility, Capacitor wrappers in Phase 4 for store builds.** Flutter fallback is NOT triggered — no spike leg failed. One caveat is accepted into the plan (ad mediation, below).

## Spike results

### 1. DOM/ARIA overlay over the canvas board — ✅ validated

Prototype: [spike/tech-stack](../../spike/tech-stack/) — 144 tiles, 4 stacked layers, PixiJS 8 canvas, transparent absolutely-positioned `<button>` overlay as the single input path for pointer and assistive tech.

- Accessibility tree (Chromium): every uncovered tile exposes as `button "Bamboo 7, free"` / `"…, blocked"`; covered tiles removed from the tree; board group announces remaining-tile count; `aria-live` announces matches ("Matched Bamboo 7. 142 tiles left"). Verified by reading the AT tree and completing a match through the overlay.
- Touch targets ≥ 48px enforced in CSS; focus ring rendered on the overlay, selection state mirrored via `aria-pressed`.
- **Remaining (not yet run):** a pass with real VoiceOver (iOS Safari) and TalkBack (Android Chrome). The Chromium AT tree strongly predicts success — the overlay is plain semantic HTML — but the real-device pass should happen before Phase 2 a11y work starts.

### 2. Capacitor ads-mediation + IAP — ✅ viable with one caveat

Researched 2026-08-30, versions verified against npm/GitHub:

- **AdMob:** `@capacitor-community/admob` v8.1.0 (2026-08-14, Capacitor-8-current, actively maintained). Banner/interstitial/rewarded/rewarded-interstitial/app-open all supported. **ATT prompt and Google UMP consent are built into the same plugin** — the compliance plumbing in roadmap §5 is covered.
- **IAP:** `@revenuecat/purchases-capacitor` v13.4.2 (2026-08-25, first-party RevenueCat, weekly releases). Consumables, non-consumable Remove-Ads, `restorePurchases()` on both stores. Backendless alternative: `cordova-plugin-purchase` v13.18.0 (active).
- **Caveat — mediation:** AdMob *mediation/bidding* works the native way (adapter SDKs added by hand in the wrapper), but there is no managed abstraction, and **AppLovin MAX has no Capacitor plugin at all** (Cordova-only, unsupported). Consequence for roadmap §2.3 vendor pick: **AdMob (+ bidding partners) is the mediation choice; MAX is off the table** unless we switch stacks.
- **Review risk:** Apple guideline 4.2 (minimum functionality) rejections hit webview apps; polished canvas games with offline play generally pass. Mitigate with native touches (haptics, Game Center) — aligns with existing Phase 4/5 scope.

### 3. Performance sanity — ✅ on dev hardware; real-device check outstanding

- Synchronous render benchmark, all 144 tiles animating every frame (position + alpha): **avg 0.14 ms, p95 0.20 ms, worst 0.40 ms per frame** (300 frames, M-series Mac, Chromium). ~100× headroom against the 16.7 ms/60fps budget.
- **Remaining:** the roadmap's binding target is 60fps on a 5-year-old mid-tier Android *device* (§1, M1 exit criteria). That harness is built in wk 1 by the UI/services engineer; the spike distributes as a URL, so the check is a 10-minute job once any such device is in hand. Given ~100× headroom on dev hardware and PixiJS's WebGL batching, risk of failure is low.

## Fallback triggers (unchanged from roadmap §2.1)

Flutter is triggered only if: real-device VoiceOver/TalkBack traversal fails on the overlay approach, OR the Capacitor wrapper fails ads/IAP integration in Phase 4, OR the low-end Android device cannot hold 60fps. None occurred in the spike. If MAX-style managed multi-network waterfalls become a hard monetization requirement, that is the one finding that would favor Flutter — decide consciously at §2.3 vendor pick (end of M2).

## Consequences

- M1 starts on TypeScript `/core` immediately (pure logic, no renderer dependency — unaffected by any later renderer/wrapper change).
- §2.3 ad-vendor decision is pre-constrained to AdMob; note this in that decision.
- Two follow-up checks scheduled, neither blocking M1: real-device screen-reader pass (before Phase 2) and low-end Android fps run (wk 1 harness).

## Sources

- spike prototype: `spike/tech-stack/` (`index.html`, `main.js`)
- https://github.com/capacitor-community/admob · npm `@capacitor-community/admob` 8.1.0
- https://github.com/RevenueCat/purchases-capacitor · npm 13.4.2
- npm `cordova-plugin-purchase` 13.18.0
- https://developers.applovin.com/en/max/cordova/overview/integration (no Capacitor target)
- Apple 4.2 pattern: forum.ionicframework.com/t/200908, code2native.com/blog/pass-app-store-guideline-42-review
