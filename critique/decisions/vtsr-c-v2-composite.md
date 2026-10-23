# VTSR-C v2 economy-performance composite -- decision memo (formula freeze)

## TL;DR

**Current semantics: the 2026-10-23 amendment (whole-game axes,
confirmation clock reset).** The sections below record each freeze in
order.

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

## Amendment (2026-09-23) — opening semantics, retired axes, reset clock

The five formulas above stay the historical freeze. They are no longer
what the composite records. This section replaces them. Justification is
engine mechanics, not a fit to the duel outcomes that accumulated after
the freeze. `CMDR_ALPHA_C` stays 1.0. Published `vtsr_c` values stay
comparable with schema 5; `CMDR_ELO_SCHEMA_VERSION` bumps 5 → 6 because
the audit-block axis keys changed meaning.

### Why the 2026-09-04 axes are the wrong thing to score

Same-match sign agreement asks whether the leader of an axis won that
same duel. Several of the frozen formulas are full-match states that
move because the match was already won: pools still standing, fewer
deaths, more scrap spent. On the discovery corpus (54 telemetry duels
as of this amendment) every axis cleared a 55% point estimate, and an
α = 0.5 replay raised accuracy by about six points while log-loss
stayed flat (0.594). That is a lagging indicator, not a skill signal.
The original promote rule treats a 0.0002 log-loss dip as "improving."
It does not.

### Scored axes (higher = better command decision)

Opening window `OPENING_WINDOW_SEC = 240` (the minimum rated-match
length). Income and the regen band use the stored 1 Hz series, so the
opening income is a downsample of the full-rate Tycoon measure. Both
sides use the same clock.

| Axis | Per-side value | Weight |
|---|---|---|
| `pool_tempo` | Seconds sooner to **3** pools. Raw value is `-(clock)`. `clock` is `time_to_3_pools_sec` when that time falls inside the opening window; otherwise it is `OPENING_WINDOW_SEC` (never reached, or reached only after the window — the same failed open). **Why 3, not 5:** 5 extractors is a mid-match event on this build clock (among sides that ever reach 5, the typical time is about 9 minutes; only a handful do it inside 240s). A time-to-5 axis inside the opening window is a tie on nearly every duel. 3 pools is the opening milestone (typical time about 3 minutes). This threshold is a timing fact about the build clock, not a fit to who won. | 0.43 |
| `combat_conversion` | Combat-ship BUILD scrap in the opening divided by opening income, denominator `max(income, 1)`. Combat ships are the existing `combat_ship_odfs` set; constructor builds are excluded (same cut as `combat_ship_value`). Service pods and scavengers are not combat ships. | 0.35 |
| `regen_tempo` | Share of opening samples in the red (fast-regen) band, using the verified segment model: red when `scrap < 20 × upgrade_count`. Samples with a dead recycler (`max_scrap == 20 × pool_count`) are skipped. No alive samples → axis unavailable for that duel. | 0.22 |

Weights are the old priors on the three axes that remain, renormalized.
They are still priors. They are not fitted.

### Recorded, weight 0

| Axis | Value | Why it is not scored |
|---|---|---|
| `replacement_ratio` | `min(3, ships_built / max(1, team deaths))` — the old `thug_supply` formula | It is hulls fielded per hull lost, not rebuild speed. Deaths fall because the side is winning. The display block also named `thug_supply` is a different statistic and must not be wired in. There is no honest prompt-rebuild clock in current telemetry. |
| `upgrade_share` | `min(1, upgrades_final / peak_pools)` when `peak_pools ≥ 1` — the old `upgrade_investment` formula | More upgrades is not always better (a rush should not upgrade). The regen benefit of an upgrade is already inside `regen_tempo`. The final snapshot also forgets upgraded pools that died. |
| `loose_share` | `income_loose / max(scrap_income, 1)` | Share of **whole-match** income that arrived as loose collected. Loose stays available all game and is often left on the ground; the whole match is the measurement. Weight stays 0. The wire records the pickup into the bank, not how many seconds the scrap sat before a scavenger reached it. Adding or widening this readout does not reset the promote clock and does not change the scored weights. |

These stay in `performance.axes` with `weight: 0` so the audit can show
them. They do not enter `P`.

### Seed differential-std priors (one-time scale anchor)

Re-anchored once on the discovery corpus so z-scores do not saturate
the clip. Scale only — the sign of each axis does not depend on it.
Do not refit these to chase accuracy.

Binding scale, one-time RMS of team-1-perspective diffs on the 66-match
discovery corpus, rounded. Not refit later.

```
pool_tempo          48     seconds-sooner diff
combat_conversion    0.14  opening combat-scrap / income diff
regen_tempo          0.054 red-share diff
replacement_ratio    0.61  ships-per-loss diff (unscored)
upgrade_share        0.25  upgrade-share diff (unscored)
loose_share          0.11  whole-match loose/income diff (unscored; one-time RMS, scale only)
```

### Promote rule (replaces the 2026-09-04 rule)

The pre-amendment telemetry duels are a **discovery** sample. They must
not be the sample that flips `CMDR_ALPHA_C`. A duel counts toward
confirmation only when its match date is **after** `2026-09-23`.

Flip `CMDR_ALPHA_C` below 1.0 only when ALL of these hold on that
confirmation sample:

1. At least 25 confirmation duels.
2. At least 2 of the 3 scored axes have a Wilson **lower bound** above
   0.55 on same-match sign agreement. A point estimate is not enough.
3. On the close subset — `decided_by == "contested"`, or the losing
   recycler's first destruction is after 75% of duration (never
   destroyed counts as still up) — those same axes are not below 0.50.
   If the close subset has fewer than 15 duels, the gate is "not yet
   testable" and blocks a flip.
4. The early-vs-full diagnostic for the retired full-match formulas is
   published. An axis whose agreement exists only on the full match and
   disappears in the first 240s cannot be added back.
5. An α ablation in {1.0, 0.9, 0.8, 0.5}, scored only on confirmation
   duels, improves log-loss by at least 0.01 and does not worsen
   accuracy. The discovery-sample dip of 0.0002 does not qualify.

Anything else: HOLD. No partial blend. No weight refit on the
confirmation sample.

## Amendment (2026-10-23) — whole-game axes, reset clock

The 2026-09-23 axes stay on record above. They are no longer what the
composite records. This section replaces them. `CMDR_ALPHA_C` stays
1.0, published `vtsr_c` values stay comparable with schema 10, and
`CMDR_ELO_SCHEMA_VERSION` bumps 10 → 11 because the audit-block axis
keys change meaning.

### Why

The justification is commander play and engine mechanics, supplied by
the operator before any outcome test on these formulas:

- A 240 s opening window measures the first few builds, not how a
  commander runs the economy. Pools reaching 3 inside 4 minutes says
  little about who held the map.
- Red only exists with upgrades (red band = `20 × upgrade_count`), so
  opening red share mostly read "did you upgrade early." The real
  spending failure is green: the top band (`20 × pool_count` up to the
  cap) regenerates at ⅓ scrap/s, three times slower than yellow, and
  not at all at the cap. Time in green is usually a symptom of too few
  pools planted or too few scavengers on loose.
- Opening combat spend is dominated by empty scouts and Xypos rebuilt
  for thugs who died. That is a thug-death proxy, and it competes with
  teching (power, factory, armory). Starter craft are excluded.
- An upgrade snapshot forgets how long upgrades were held. Two upgrades
  held for the rest of the game beat two that were built earlier and
  then half lost.

The whole-game versions of pools, float and upgrades were seen on the
discovery sample before this amendment (`legacy_early_full` in
`validation_summary.json`). That is why the clock below starts fresh:
the new formulas are judged only on matches played after this date.

### Measurement span: the whole game (FROZEN)

Every axis is measured over the whole recorded game. Every telemetry
game carries a recorded outcome (host attestation or adjudication), so
the end of the game is the decision; the few minutes after a building
falls add too little to change what the axes track.

Revision note: a draft of this amendment, dated 2026-10-22, ended the
measurement at the first enemy kill of a recycler or factory. It was
dropped before any confirmation duel existed (the newest match on disk
was dated 2026-10-21), and the clock moved to 2026-10-23 so only games
recorded under these final formulas count.

Whole-game values can partly read the scoreboard: a side that is
winning keeps its pools. The prefix gate (condition 4 below) is the
guard against that.

### Scored axes (FROZEN; higher is the hypothesized better)

| Axis | Per-side value over the whole game | Weight |
|---|---|---|
| `pool_lead` | Mean `pool_count` over the 1 Hz samples. The differential is the mean pool lead. | 0.25 |
| `non_green_share` | Share of live-recycler samples with `scrap < 20 × pool_count` (red or yellow). Green counts as bad everywhere, including time at the cap and green caused by having no pools. Samples with a dead recycler (`max_scrap == 20 × pool_count`) are skipped. | 0.25 |
| `combat_conversion` | Combat-ship BUILD scrap (constructor lane excluded, starter ships excluded) divided by `max(income, 1)`, income = positive 1 Hz bank deltas. | 0.25 |
| `upgrade_time` | Mean `upgrade_count` over the 1 Hz samples. | 0.25 |

Equal weights are priors. They are not fitted.

Starter ships (`STARTER_SHIP_STEMS`): `ivscout_m`, `ivscoutm_vsr`,
`ivscoutm_12xvsr`, `fvscout_m`, `fvscoutm_vsr`, `evscout_m`,
`evscoutm_vsr`. `cvscoutm_vsr` stays a combat ship.

### Recorded, weight 0

| Axis | Value |
|---|---|
| `replacement_ratio` | `min(3, combat ships built / max(1, human vehicle deaths))`, whole game. Deaths come from `kills.feed` rows whose victim is a leaderboard player on that side, pilot victims excluded. |
| `replacement_ratio_real` | The same, with starter ships removed from "ships built". |
| `loose_share` | Unchanged: whole-match `income_loose / max(scrap_income, 1)`. |

Retired: `pool_tempo`, `regen_tempo`, `upgrade_share`, and the 240 s
opening window.

### Diagnostic prefixes (never in P)

`performance.prefix_diffs` holds every axis diff re-measured from 0 to
240, 480 and 720 seconds, present only when the match runs past that
point. They exist to separate a signal that appears early in the game
from one that only reads the scoreboard.

### Seed differential-std priors (one-time scale anchor)

One-time RMS of team-1-perspective whole-game diffs over the 138
telemetry duels on disk on 2026-10-23, computed outcome-blind by
`_investigation/cmdr_axes_preflight.py` (it never reads a winner).
Scale only. Do not refit.

```
pool_lead               1.3
non_green_share         0.24
combat_conversion       0.13
upgrade_time            0.41
replacement_ratio       0.58   (unscored)
replacement_ratio_real  0.64   (unscored)
loose_share             0.11   (unscored; 2026-09-23 scale kept)
```

### What the outcome-blind preflight showed

Recorded here so nobody rediscovers it on the confirmation sample:

- `pool_lead` and `non_green_share` diffs correlate at r = 0.91. More
  pools widen the yellow band, so the two largely move together; at
  equal weights they act like one axis at double weight. Weights stay
  frozen; this is a known overlap, not a reason to refit.
- `loose_share` runs opposite to both (r = −0.70 and −0.83): a side
  with fewer pools leans on loose.
- `combat_conversion` is 0 for both sides in 10 of 138 duels (no
  non-starter combat ship built all game); `replacement_ratio_real`
  in the same 10.
- Prefix coverage: 138 duels run past 4 minutes, 128 past 8, 99 past
  12.
- Feed-counted ships built and human deaths reproduce
  `builds.teams.ships_built` and the sum of `leaderboard[].deaths`
  exactly (0 mismatches).

### Promote rule (replaces the 2026-09-23 rule)

Confirmation = telemetry duels whose match date is **after 2026-10-23**.
Earlier telemetry is discovery only. Flip `CMDR_ALPHA_C` below 1.0 only
when ALL of these hold on the confirmation sample:

1. At least 25 confirmation duels.
2. At least 2 of the 4 scored axes have a Wilson **lower bound** above
   0.55 on same-match sign agreement.
3. **Close subset, redefined.** The 2026-09-23 test (loser's recycler
   alive at 75% of the match) classified every confirmation duel as
   close, because a recycler kill usually ends the game. A duel is now
   close when `decided_by == "contested"` or its own pre-match expected
   score (team 1) lies within [0.40, 0.60]. That uses no in-match data.
   Those same axes must not be below 0.50 there. Fewer than 15 close
   duels blocks a flip ("not yet testable").
4. **Prefix gate.** An axis whose sign agreement is at or below 0.50 in
   every prefix (0–240, 0–480, 0–720 s) cannot count toward condition
   2, however well it agrees over the whole game.
5. The α ablation in {1.0, 0.9, 0.8, 0.5}, scored only on confirmation
   duels, improves log-loss by at least 0.01 and does not worsen
   accuracy.

Anything else: HOLD. No partial blend. No weight refit on the
confirmation sample.

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
- `.cursor/plans/elo/commander_stats_overhaul_18e691bf.plan.md` (Stage D spec)
- This memo
