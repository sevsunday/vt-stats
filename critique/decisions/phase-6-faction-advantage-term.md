# Phase 6 — faction-advantage term in the VTSR-C expected score (pre-registered)

Status: **PRE-REGISTERED, HOLD** (2026-10-04). No canonical change. The
term described here is NOT in `scripts/elo_commander.py`, NOT in
`js/balonce-meter.js`, and NOT in any published rating. This memo exists
so that the question "is a faction advantaged after the ratings have had
their say?" is answered by a rule written down before the confirmation
data exists, not by whoever looks at the numbers last.

Companion sections: `scripts/validate_elo.py` §19 (`metric_faction_effect`,
validator v1.7) computes every number this memo reads and prints the
promote verdict on each run. Critique v4 (`critique/elo-analysis-v4.md`
Part V) carries the design discussion — faction-based ratings, pro and
con — that motivates the candidate.

## TL;DR

- Hadean sides win more than their commanders' and thugs' ratings
  predict. On the full 675-duel corpus, with the canonical expected score
  held fixed as an offset, the Hadean-vs-ISDF contrast is **+0.357 logit
  (SE 0.157, z 2.27, p 0.023)**, worth about **+62 rating points** on the
  ladder's 400 scale; the Scion-vs-ISDF contrast is **−0.010 (z −0.08)**.
  The likelihood-ratio test for both contrasts together is χ² 6.44,
  p 0.040. Log-loss on non-mirror duels improves 0.6179 → 0.6099;
  accuracy is unchanged (66.5%).
- **That fit is DISCOVERY.** The exploratory regression was run on
  2026-10-04 while drafting critique v4, before this memo. Every duel
  dated on or before that day is therefore tainted by having motivated
  the hypothesis and can never be the sample that promotes it.
- Candidate: an additive faction term inside the VTSR-C expected score,
  FROZEN at the rounded discovery estimate (**Hadean +60 points, Scion 0,
  ISDF 0**). The confirmation sample (non-mirror duels dated strictly
  after 2026-10-04) judges those exact numbers out of sample; nothing is
  refit on it.
- Scope is the VTSR-C expected score and its mirror in the Balonce
  Meter. It is **never** a VTSR-T axis, never a per-player faction
  ladder, never a per-player faction offset. Those are separate
  questions with separate memos, if ever.

## The candidate

Today (`scripts/elo_commander.py::expected_score`, mirrored verbatim in
`js/balonce-meter.js::computeWinProb`):

```
E_A = 1 / (1 + 10^( -( (R_A - R_B) + lambda * (T_A - T_B) ) / 400 ))
```

with `R` = commander VTSR-C, `T` = mean pre-match VTSR-T of each side's
non-commander rated rows, `lambda = 1.0`, scale 400.

Candidate (Bradley–Terry with a within-pair order effect, Davidson &
Beaver 1977 — the same device chess rating models use for the first-move
advantage):

```
E_A = 1 / (1 + 10^( -( (R_A - R_B) + lambda * (T_A - T_B) + (phi[f_A] - phi[f_B]) ) / 400 ))

phi = { ISDF: 0, Hadean: +60, Scion: 0 }      # rating points, FROZEN
```

`f_A` / `f_B` are the two sides' factions: `match.team_factions[side].code`
for telemetry duels, the ledger's `factions[side]` for F9 duels. Mirror
matchups contribute `phi[f] - phi[f] = 0` and are unchanged. The term is
a property of the matchup, not of either player: a commander who always
picks Hadean is expected to win slightly more often and therefore earns
slightly less per win and loses slightly more per loss. That is the only
thing the term does.

Why the expected score and nothing else:

- VTSR-T's `P_i` is lobby-relative (z-scored inside the match), so both
  sides' faction effects sit in the same lobby and the faction cannot be
  recovered from `P_i` at all. `ideas.txt` recorded the standing position
  in June 2026 — "faction balance is a META property, not a player-skill
  property. Do NOT bake faction into VTSR-T" — and nothing here disturbs
  it.
- VTSR-C is outcome-pure. A win is a win regardless of why; the only
  place a known, matchup-level advantage can be priced without touching
  any player's measurement is the expectation.
- The Balonce Meter prints a win probability. If a faction term is real
  and the meter ignores it, the meter is miscalibrated by exactly that
  term on every mixed-faction lobby.

## Why the discovery estimate is plausible, and why it is not enough

Plausible:

- Raw non-mirror records point the same way the regression does: Hadean
  64.8% vs ISDF (79-43, n=122), Hadean 57.9% vs Scion (62-45, n=107),
  Scion 49.2% vs ISDF (87-90, n=177). Scion and ISDF are indistinguishable
  in the raw record and in the fit; Hadean is the outlier in both.
- The obvious confound — better commanders pick Hadean — is small and is
  controlled for. Commanders fielding Hadean averaged 1512.8 pre-duel
  VTSR-C versus 1488.6 (ISDF) and 1486.8 (Scion); the regression holds
  the whole canonical expectation fixed, so that 25-point gap is already
  removed before the faction contrast is estimated.
- The effect appears in both sources with the same sign: telemetry
  +0.313 (n=116), F9 +0.354 (n=290). Neither sub-sample is significant on
  its own; the pooled fit is.

Not enough:

- p 0.023 on a hypothesis that was formed by looking at the same data is
  not p 0.023. The pick share of Hadean rose from roughly 10% of sides in
  late 2025 to 37–38% in September–October 2026, which is exactly the
  pattern a community produces when it believes a faction is strong. Some
  of the win rate may be the belief selecting the games, not the faction
  winning them.
- Meta drift is real. A balance patch, a map-pool change, or a strategy
  that counters the current Hadean opening would move the true value of
  `phi`. A frozen constant estimated on one era can be wrong in the next
  — which is one more reason the confirmation sample has to be games
  that had not been played yet when the number was chosen.
- Accuracy did not move (66.5% → 66.5%). The term sharpens probabilities
  (log-loss) without flipping many calls. A probability-calibration gain
  is still a gain for a meter whose output is a probability, but it is a
  modest one.

## Pre-registered promote rule

The validator's §19 `confirmation` row is the only sample this rule
reads. Confirmation = VTSR-C duels (telemetry and F9 alike) dated
**strictly after 2026-10-04**, non-mirror only, scored with the frozen
`phi` applied to the canonical expected score — no refit.

Promote-candidate iff ALL of:

1. **Sample size:** at least **60** confirmation non-mirror duels.
2. **Out-of-sample log-loss:** the frozen term improves confirmation
   log-loss by **≥ 0.005** against the canonical expected score on the
   same rows.
3. **Accuracy not worse:** confirmation accuracy with the frozen term is
   ≥ the canonical accuracy on the same rows.
4. **Sign and magnitude stability:** a free refit on the confirmation
   rows gives a Hadean-vs-ISDF coefficient with the SAME SIGN as
   discovery and a point estimate of at least half the discovery
   estimate (≥ +0.18 logit). A Wald-significant confirmation refit is
   NOT required — at n = 60 the standard error is near 0.4 logit and a
   true +0.36 effect would fail a z ≥ 2 bar most of the time; the
   predictive conditions (2) and (3) carry the test.
5. **Re-rate sanity:** after a full re-rate with the term, mean published
   VTSR-C drifts by less than **25** points from where it is without the
   term (the term is a redistribution between matched sides, not a pool
   inflator), and the validator's §10 replay integrity stays within its
   current tolerance.

**Discard rule:** at ≥ 60 confirmation duels, a confirmation refit whose
Hadean-vs-ISDF coefficient is ≤ 0 discards the candidate without further
analysis — the discovery effect was the meta and the pick selection, not
the faction.

**Anything else: HOLD.** No partial credit, no refit of `phi` on the
confirmation sample, no widening of the sample to recover discovery
duels. A near-miss motivates waiting for the next 60 duels, not relaxing
the rule.

Re-evaluation cadence: the validator prints the verdict every run; the
memo is appended at the first run with ≥ 60 confirmation duels and every
further +60 after that until a PROMOTE-CANDIDATE or DISCARD lands.

Amendments to this rule require a new section justified on methodology
grounds only — never by observed confirmation numbers — written before
the next run is examined.

## What a promotion would change (authorized by this memo, not performed)

- `scripts/elo_commander.py`: `expected_score` gains the `phi` term; a
  `CMDR_FACTION_ADVANTAGE_POINTS` constant block; per-duel audit fields
  `factions.{1,2}` and `faction_term` beside `team_handicap`; top-level
  `faction_advantage_points` on both emitted files. `CMDR_ELO_SCHEMA_VERSION`
  bumps (re-rate signal; pre-bump `vtsr_c` / `peak_vtsr_c` not comparable).
- `js/balonce-meter.js::computeWinProb` reads `faction_advantage_points`
  from the emitted JSON and takes the two sides' factions as inputs; the
  Tools card gains a faction selector per team (the commander picks the
  faction in the lobby, so it is known before the match); the dashboard
  Outcome card reads `team_factions`. The displayed formula and the
  rating must stay the same function — that is the standing Balonce
  contract.
- `scripts/validate_elo.py` §10 replay includes the term so replay
  integrity still holds; §19 keeps running with `phi` as the new
  baseline so the next drift question has its own confirmation sample.
- ELO page explainers (`js/vtsr-explainers.js`): one sentence in the
  commander-ladder section and one fairness card.

## Scope exclusions (what this memo does NOT authorize)

- **No VTSR-T axis or shift.** `P_i` is lobby-relative; a faction term
  there would measure nothing and would penalize thugs for a choice the
  commander made.
- **No per-player faction ladders** (three VTSR-Ts or three VTSR-Cs per
  player). With ~45 rated players and three factions the median
  player-faction cell is too thin to carry its own K schedule; the
  SC2 precedent is a 1v1 ladder with millions of players choosing their
  own race.
- **No per-player faction offset** (the Natural Selection 2 "average
  skill + team bias" factorization). It is a reasonable future design
  for the display layer (a faction profile card) and would need its own
  memo with its own confirmation sample.
- **No map × faction interaction.** Plausible, unmeasured, out of scope.

## Undo recipe

Nothing to undo today. If promoted and later regretted: set the three
`phi` values to 0, bump `CMDR_ELO_SCHEMA_VERSION`, re-run the pipeline —
VTSR-C recomputes from scratch every run, so the removal is total.

## Appendix — discovery numbers (validator v1.7 §19, 2026-10-04)

Corpus: 675 duels with both factions known (telemetry 170, F9 505), of
which 269 are mirror matchups and 406 carry a contrast. Canonical
expected score as offset; logistic scale 400.

| sample | n (non-mirror) | Hadean vs ISDF | ≈ pts | Scion vs ISDF | ≈ pts | LR χ² (p) | log-loss base → fit | acc base → fit |
|---|---|---|---|---|---|---|---|---|
| all | 406 | +0.357 ± 0.157 (z 2.27, p 0.023) | +62 | −0.010 ± 0.138 (z −0.08) | −2 | 6.44 (0.040) | 0.6179 → 0.6099 | 66.5% → 66.5% |
| telemetry | 116 | +0.313 ± 0.274 (z 1.14) | +54 | −0.290 ± 0.291 (z −1.00) | −50 | 4.27 (0.118) | 0.6190 → 0.6006 | 66.4% → 68.1% |
| F9 | 290 | +0.354 ± 0.193 (z 1.83) | +62 | +0.070 ± 0.157 (z 0.45) | +12 | 3.51 (0.173) | 0.6174 → 0.6113 | 66.6% → 67.6% |
| confirmation | 0 | not yet testable | | | | | | |

Frozen term (+60 Hadean, 0 Scion, 0 ISDF) applied without refit, as the
promote rule will apply it to confirmation rows:

| sample | n | log-loss base → frozen | accuracy base → frozen |
|---|---|---|---|
| all | 406 | 0.6179 → 0.6099 (+0.0079) | 66.5% → 66.5% (+0.0pp) |
| telemetry | 116 | 0.6190 → 0.6056 (+0.0135) | 66.4% → 67.2% (+0.9pp) |
| F9 | 290 | 0.6174 → 0.6117 (+0.0057) | 66.6% → 66.2% (−0.3pp) |

Faction picks across all 675 duels (team-sides): ISDF 747 picks / 47.8%
win rate, Hadean 271 / 59.8%, Scion 332 / 47.0%. Mean pre-duel VTSR-C of
the commander fielding each: ISDF 1488.6, Hadean 1512.8, Scion 1486.8.

Hadean share of team-sides by month: 35% (2025-01), 8–16% through late
2025, 12% (2026-01/02), 25% (2026-03), 17–20% (2026-04/05), 33%
(2026-08), 37% (2026-09), 38% (2026-10).

## Source files

- `scripts/validate_elo.py` §19 `metric_faction_effect` + constants
  `FACTION_DISCOVERY_CUTOFF`, `FACTION_FROZEN_POINTS`,
  `FACTION_PROMOTE_MIN_CONFIRMATION`, `FACTION_PROMOTE_LOGLOSS_DELTA`
  (regenerable: `python scripts/validate_elo.py`, output
  `_validation/report.md` §19 + `report.json` `faction_effect`)
- `scripts/elo_commander.py::expected_score` (the function under
  discussion; unchanged)
- `js/balonce-meter.js::computeWinProb` (its mirror; unchanged)
- `data/external/f9_ledger.json` (`duels[].factions`), `data/processed/matches.json`
  (`team_factions`) — the faction sources
- `critique/elo-analysis-v4.md` Part V — design discussion
- This memo
