# VTSR-C v2 economy-performance composite -- decision memo (formula freeze)

## TL;DR

VTSR-C v2 ships an economy-performance composite computed on every duel
with proto-v4 telemetry, **structurally inert behind `CMDR_ALPHA_C = 1.0`**.
Duel scores are byte-identical to v1 (golden test passed on the full
corpus). This memo FREEZES the five axis formulas, the
normalization, the seed priors, and the pre-registered promote rule
BEFORE any meaningful telemetry corpus accumulates -- the formulas must
never be tuned against the same data that will later judge them.

Frozen: 2026-09-04, at exactly 1 real v4 session in the corpus (**1
telemetry duel**, 39 duels total). The freeze was originally written
during a window when 2 synthetic v4 fixtures were also on disk (3
telemetry duels, 41 total); those fixtures were purged the same day and
the corpus re-rated. This changes nothing about the freeze — the whole
point of freezing now is that no telemetry corpus exists to tune
against, and the golden byte-identity gate passed again post-purge.
Amendments to the formulas below require a new memo section with
justification INDEPENDENT of accumulated duel outcomes (engine-mechanics
evidence only).

## The five axes (formulas FROZEN)

All raw values are per-side, per-match, from the `economy` + `builds`
match blocks (`scripts/process_stats.py`, proto v4) and the leaderboard.
Constructor/structure telemetry is excluded BY DESIGN (era-mixed
completion quality; see the hover-constructor risk register).

| Axis | Formula (per side) | Source fields | Direction hypothesis |
|---|---|---|---|
| `pool_tempo` | `pool_advantage_integral / duration_sec` | economy.teams | C2: more pools sooner = better |
| `production_output` | `scrap_spent_units / (duration_sec / 60)` | builds.teams | C3: more value fielded per minute = better |
| `thug_supply` | `min(3.0, ships_built / max(1, team_deaths))` | builds.teams + leaderboard | C4: prompt rebuilds = better |
| `econ_efficiency` | `1 - mean_float_ratio` | economy.teams | C1: low bank float = fast-regen zone = better |
| `upgrade_investment` | `min(1.0, upgrades_final / max(1, peak_pools))` | economy.teams | C5: upgrade share = long-game investment |

Notes fixed at freeze time:

- `production_output` is deliberately **`scrap_spent_units`/min (value
  fielded), NOT `scrap_income`** -- income overlaps pool_tempo /
  econ_efficiency territory; the axes stay decorrelated.
- `thug_supply` losses = **sum of the side's leaderboard `deaths`**
  (vehicle losses; pilot deaths already excluded by the v2.9 pipeline
  gate). Cap `THUG_SUPPLY_CAP = 3.0` keeps a low-loss stomp from
  defining the axis.
- `upgrade_investment` uses `peak_pools` as the denominator (not final
  pools) so late pool losses don't inflate the share.
- `pool_tempo` uses the signed own-perspective integral, so the
  within-match diff is exactly `2 x` the team-1 value (symmetric).
- Every axis is duration-normalized or dimensionless -- no match-length
  bias.

## Normalization (FROZEN): within-match differential

A 1v1 duel makes lobby z-scores degenerate (n=2). The opponent diff
controls for map / patch / lobby size:

```
d      = v_own - v_opp                       (per axis, per duel)
z      = clip(d / shrunk_std(axis), -2, 2) / 2          in [-1, 1]
P_1    = sum(w_axis * z_axis) / sum(w_axis)  over available axes
P_2    = -P_1                                (zero-sum)
```

`shrunk_std` is a rolling RMS of team-1-perspective diffs (mean-zero by
construction) with a seed prior + shrinkage, snapshot-before-duel /
update-after (mirrors `commander_shrunk_baseline` in `scripts/elo.py`):

```
shrunk_var(axis) = (SHRINK * prior^2 + sum(d^2)) / (SHRINK + n_observed)
```

with `CMDR_ECON_STD_SHRINKAGE = 10.0` pseudo-duels. An axis is dropped
from a duel (weights renormalized) when either side's value is missing.

## Weights (priors, FROZEN as priors)

```
pool_tempo         0.30
production_output  0.25
thug_supply        0.20
econ_efficiency    0.15
upgrade_investment 0.10
```

These are design priors, not fitted values. They matter ONLY when
`alpha_c < 1.0`, which the promote rule below gates.

## Seed differential-std priors (FROZEN)

Sanity-anchored on the first real v4 session (2026-09-03 Wasteland
mortar strat) so seed-era z-scores land mid-range instead of saturating
the clip:

```
pool_tempo          2.0    (real-match d = 3.30)
production_output  25.0    (d = 1.4)
thug_supply         1.0    (d = 0.69)
econ_efficiency     0.15   (d = 0.075)
upgrade_investment  0.35   (d = 0.60)
```

## Blend (FROZEN) + structural inertness

```
S' = CMDR_ALPHA_C * S + (1 - CMDR_ALPHA_C) * (P + 1) / 2
```

- Applied ONLY when the match carries BOTH `has_resource_data` AND
  `has_build_data`.
- **Telemetry-gap fallback policy (RATIFIED by user 2026-09-03)**: duels
  without telemetry (all pre-v4 matches forever; any v4 collector gap)
  score outcome-pure S at ANY alpha_c. A determined outcome is always a
  valid duel signal; exclusion would starve the pool and couple ladder
  coverage to collector uptime. The mix is per-duel transparent via
  `performance.available`.
- The code branches on `CMDR_ALPHA_C < 1.0` so the inert path never
  routes through blend arithmetic (provable by inspection, on top of the
  golden test).
- W/L/D records always tally the RAW outcome, never the blended score.

## Golden byte-identity gate (PASSED 2026-09-04)

`_investigation/golden_vtsrc_v2.py`: v2 replayed the full duel corpus
against the committed v1 output -- every v1 field on every duel, rating
row, and top-level scalar byte-identical.

The gate first passed on a 41-duel corpus with 3 telemetry duels (1 real
+ 2 synthetic fixtures); P values team-1-perspective were +0.447
(fixture), +0.386 (fixture), +0.363 (real). The fixtures were purged the
same day and the gate re-run and re-passed on the clean **39-duel
corpus** with **1 telemetry duel**: the real `2026-09-03T00-57-19`
Wasteland match, now the FIRST telemetry duel in the walk so it scores
against the pure seed priors -- **P = +0.4466 for team 1, which LOST**
(pool_tempo z +0.826, upgrade_investment z +0.857, thug_supply z +0.344,
econ_efficiency z +0.249, production_output z +0.028).

That single duel is the standing axis-humility anchor, and the purge
sharpened it: the composite's strongest available read points at the
loser. Economy advantage is a hypothesis, not a truth, until the
sign-agreement gate below says otherwise on a real corpus.

## Pre-registered promote rule (verbatim from the migration plan)

Flip `CMDR_ALPHA_C` below 1.0 ONLY when ALL of:

1. >= 25 telemetry duels in the corpus;
2. >= 3 of the 5 axes show validator sign-agreement > 0.55, with NO axis
   < 0.35;
3. the validator alpha_c ablation ({1.0, 0.9, 0.8, 0.5}) improves -- or
   holds within CI -- duel-prediction accuracy while improving log-loss.

Axis discard rule: drop an axis (weight to 0, renormalize) at
sign-agreement < 0.40 with n >= 40 telemetry duels.

Anything else: HOLD at 1.0. No partial credit, no "almost".

## Consequence-free surface at ship

- `CMDR_ELO_SCHEMA_VERSION 1 -> 2` (additive fields only).
- New per-duel `performance {available, p, axes{axis: {diff, std, z}}}`
  + per-side `score_blend {alpha_c, s_raw, s_blended}` audit blocks.
- New per-rating `duels_with_telemetry`; new top-level `alpha_c`,
  `econ_weights`, `econ_std_prior`, `econ_std_shrinkage`,
  `thug_supply_cap`, `econ_std_observed`.
- No `PIPELINE_VERSION` / `ELO_SCHEMA_VERSION` / `match.schema_version`
  interaction (VTSR-C recomputes every run).

## Source files

- `scripts/elo_commander.py` (v2 module)
- `_investigation/golden_vtsrc_v2.py` (golden gate, regenerable)
- `.cursor/plans/commander_stats_overhaul_18e691bf.plan.md` (Stage D spec)
- This memo
