# Decision 0004 — Ads suspended for v1.0 (opt-in settings toggle)

**Status:** APPROVED (PM, 2026-08-30) · **Date:** 2026-08-30 · **Issue:** #3

## Context

Spec §2.1 listed "Ads (banner + rewarded)" while §8 defined interstitial rules and the ROADMAP assumed interstitials were v1.0 — a contradiction flagged as pre-Phase-0 decision item 4.

## Decision

- **Ads are suspended for v1.0.** The game is fully playable ad-free; all ads are **OFF by default**.
- **Opt-in toggle:** a settings toggle (spec §7, built in Phase 2) enables ads. When ON, banner + interstitial + rewarded are all in scope under the spec §8 rules (frequency caps, never mid-level, skip after 5s, etc.). This makes the §2.1/§8 contradiction moot — §8 applies whenever ads are enabled.
- **No ad SDK initialization while the toggle is OFF** (privacy + performance + no consent prompts for players who never opt in).
- **Remove-Ads IAP deferred to v1.1+** (issue #21): redundant while ads are opt-in — the toggle already removes them. It returns only if/when ads default ON.

## Consequences

- **Spec:** §1.4 amendment note, §2.1 bullet rewritten, §7 gains the ads toggle, §8 gains the v1.0 policy preamble; Remove-Ads IAP moved to §2.2.
- **ROADMAP:** decision item 4 marked resolved; Phase 2 settings scope gains the toggle; Phase 4 ads work is gated behind the toggle, Remove-Ads IAP dropped from Phase 4; new Phase 4 exit criterion — zero ad SDK calls in an instrumented session with the toggle OFF.
- **Issue #20 (Phase 4 ads):** scope unchanged in ad formats (banner + interstitial + rewarded, §8 caps) but everything sits behind the default-OFF toggle.
- **Issue #21 (Remove-Ads IAP):** deferred to v1.1+ backlog.
- **Compliance (ROADMAP §5):** ATT/UMP consent flows still ship in v1.0 (ads can be enabled by the player) but must trigger only on first opt-in, not at app start.
- **Revenue:** v1.0 is intentionally non-monetizing on ads by default; opt-in rate telemetry (Phase 6) informs whether/when ads default ON in a later release.
