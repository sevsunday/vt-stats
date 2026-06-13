---
name: ELO digestibility pass
overview: "Copy-and-presentation pass over the ELO page: keep the Leaderboard casual, make the expand panel readable with math one hover away, reframe precision language in plain words, and make Does-it-work bilingual via per-card technical disclosures — plus fix two factual/copy bugs found in review."
todos:
  - id: leaderboard
    content: "Leaderboard: remove noise banner, plain-words rating tooltip, 4-min fix, orphan CSS cleanup"
    status: pending
  - id: expand-panel
    content: "Expand panel: friendly axis labels + plain chips, math to hover, reword z̄ heading + P/E line"
    status: pending
  - id: how-tab
    content: "How tab: reframe precision section around meaning"
    status: pending
  - id: accuracy-tab
    content: "Does-it-work: per-card technical disclosures, neutral captions, legend de-jargon, CSS"
    status: pending
  - id: static-copy
    content: "Static copy: meta tags, thug-only banner trim, PvP Acc header tooltip"
    status: pending
isProject: false
---

# ELO Page Digestibility Pass

All changes are in [js/elo.js](js/elo.js), [elo/index.html](elo/index.html), [css/elo.css](css/elo.css), and [css/vtstats-theme.css](css/vtstats-theme.css). The shared `js/vtsr-explainers.js` builders are NOT touched, so the dashboard's methodology modal is unaffected.

Guiding rule: never name the method to a casual reader. Plain meaning by default, rigor one hover/click away.

## 1. Leaderboard — strip statistician leakage

- Delete the `#vtsr-noise-note` injection block in `renderLeaderboard()` ([js/elo.js](js/elo.js) ~lines 645-662). The uncertainty concept moves to plain words in the tooltip + stays rigorous on Does-it-work.
- Rating cell tooltip (~line 754-757): replace `255 ± 32 VTSR-T (resampling σ)` with plain `1742 VTSR-T (give or take ~32)` — keep the Thug ELO / Wins ELO / match-count tail. No method name, no sigma. (Bonus: the old "gaps < 32 are ties" claim understated the tie zone by √2 anyway — the plain phrasing is also more defensible.)
- Fix factual bug: per-row Matches tooltip (~line 768) says "<5 min duration"; the actual gate is 4 minutes (`ELO_MIN_DURATION_SEC = 240` in `scripts/elo.py`). Align with the header tooltip.
- Remove the orphaned `.vt-vtsr-noise-note` CSS block from [css/vtstats-theme.css](css/vtstats-theme.css).
- `ratingNoiseSigma()` helper stays — still feeds the How tab + Accuracy tab.

## 2. Row expand panel — friendly labels, plain readings, math on hover

In `renderVtsrAxisGrid()` ([js/elo.js](js/elo.js) ~lines 390-437):

- Axis name cell maps through `VTSR_AXIS_META[a].label` (fallback: raw key) — users see "Net damage share", never `net_damage_share`.
- Replace the always-visible `+0.42σ` / `w=0.20 → +0.084` strings with a plain reading chip: "Above avg" / "Below avg" / "Average" (reuse the sign logic from `buildAxisTooltipHtml`). The exact z-score, sigma, weight, and weighted contribution all move INTO the existing hover tooltip (`buildAxisTooltipHtml` already shows most of it; add the weight line there).
- Heading reword (~line 431): "Career axis profile (z̄ across rated matches)" → "Career axis profile (typical showing across rated matches)".
- Last-match formula line in `renderVtsrLastMatchSection()` (~line 488): `P=+0.5665 · E=+0.2667 · ΔR=+16.89` → worded form: "Scored +0.57 vs +0.27 expected → +16.9" (same data, no single-letter variables; quietly reinforces the How-tab formula).

## 3. How it works — reframe the precision section

`renderHowTab()` noise section ([js/elo.js](js/elo.js) ~lines 893-904): retitle to "How close is too close to call?", lead with the meaning ("Two players within ~N points of each other are basically tied — tier placement is meaningful, exact rank inside a tier mostly isn't."), demote the 100x80% resampling method to a muted trailing sentence + keep the link to Does-it-work.

## 4. Does it work? — bilingual via per-card disclosure

In `renderAccuracyTab()` ([js/elo.js](js/elo.js) ~lines 1028-1183):

- Keep the 4 headline cards + plain captions as the default view, but:
  - Neutralize the hardcoded verdict in the Self-consistency caption ("Ours is strong" praises a JSON-loaded number regardless of its value) — describe the metric, let the number speak.
  - Shorten the Noise-band caption (the method detail moves into its disclosure).
- Add a `<details class="vt-elo-stat-tech">` "Technical definition" disclosure inside each `vt-elo-statcard` with the exact method: Self-consistency → "Spearman ρ between random split-halves of each player's matches"; Noise band → "median per-player σ over 100 bootstrap resamples of 80% of matches"; Winner prediction → "hard-MAX team aggregation, clean-win subset only, vs log-loss baseline"; Rated matches → corpus gates (≥6 players, ≥4 min).
- New small CSS block in [css/elo.css](css/elo.css) for the disclosure (muted summary text, mono-ish body, no layout shift).
- Chart legends (~lines 1154, 1162): "Winner prediction (best aggregation)" → "Winner prediction (%)"; "Rating ↔ performance agreement (ρ × 100)" → "Rating ↔ performance agreement (%)".
- Vary the "honest" repetition: keep ONE use (the intro line), reword "honest scorecard" elsewhere.

## 5. Remaining "tells" in static copy

[elo/index.html](elo/index.html):

- Meta description (line 7) + og:description (line 14): drop "in plain language" / "honest accuracy stats" self-awareness → e.g. "The VTSR-T leaderboard, how the rating works, and how well it predicts matches." (These render in Discord unfurls — most public surface on the page.)
- Thug-only banner (line 131): delete the insider parenthetical "(campod and partial-presence rows still excluded as usual)".
- PvP Acc header tooltip (line 235): drop "per-weapon-normalized variant (used by the thug_accuracy ELO axis)" → "PvP-only hit rate. The deeper per-weapon breakdown is in the row's expand panel."
- Line 219 VTSR-T header formula tooltip: deliberately KEPT — hover-only, and the formula belongs there for the curious.

## Out of scope (deliberate)

- Empty-state "run the pipeline" copy (only visible on broken deployments — it is effectively an error message for the maintainer).
- Shared `js/vtsr-explainers.js` content (dashboard modal parity).
- Any data/pipeline changes.