# Balonce Meter — the T-term ablations (pre-registered)

## TL;DR

The Balonce Meter ships the VTSR-C duel formula verbatim:

```
P(T1) = 1 / (1 + 10^(-((Rc1 - Rc2) + lambda * (T1 - T2)) / scale))
```

with `T` = the **mean pre-match VTSR-T of each side's non-commander rated
rows** and `lambda = 1.0`. That exact configuration is what
`scripts/validate_elo.py` §10 scores, so the accuracy figure the UI
prints is the accuracy the displayed formula earned.

Three questions about the `T` term were raised while building the meter.
All three are **untested, not rejected** — nobody has ever scored a
variant. This memo registers the rules under which any of them may be
promoted into the shipped formula, BEFORE the ablation numbers exist.

Rules registered: 2026-09-18, ahead of any implementation run. This
section is append-only from here; results land under "Results" below.

## The three questions

### Q1. Should the commander's own VTSR-T enter the model?

**Status today: excluded.** `elo_commander.py::_team_thug_means` skips
`is_commander` rows, so a commander's thug rating appears nowhere in the
probability. The Balonce Meter *displays* it on the commander's row but
does not score it.

**The argument for exclusion (why it was designed this way).** VTSR-C is
outcome-pure. Everything a commander contributes that produces wins —
build order, economy, map calls, **and their own flying and shooting** —
is already priced into the rating, because it produced the wins that
moved it. Adding their VTSR-T counts that fighting twice. The two
ratings are also correlated (good players tend to be good at both jobs),
and a correlated extra term on a 625-duel corpus usually buys variance
rather than accuracy.

**The argument against (why this memo exists).** VTSR-C prices things in
*slowly* — win/loss only, K decaying 40 -> 20, no partial credit. For a
commander with 80+ duels the double-counting argument is strong. For one
with 3, VTSR-C is mostly anchor noise while their VTSR-T is a
high-signal continuous measurement and arguably the best evidence we
have about them. And the originally-raised scenario is real: when both
thug squads perform evenly and commander A is in the fight while
commander B is dormant in base, something asymmetric happened that a
thug-mean-only handicap term cannot see.

**Variants to score:**

- **V0 — canonical.** Thug-only means. The shipped baseline.
- **V1 — team-mean-inclusive.** Fold the commander's own pre-match
  VTSR-T into their side's `T`. Parameter-free, so it carries the lowest
  overfitting risk of the three.
- **V2 — provisional-conditional.** Use V1's `T` **only** while that
  commander's VTSR-C is provisional (below
  `CMDR_PROVISIONAL_THRESHOLD`), V0's otherwise. Encodes the honest
  asymmetry: lean on VTSR-T exactly when VTSR-C has not had time to
  learn anything.
- **V3 — three-term.** A separate `lambda2 * (Tc1 - Tc2)` commander-VTSR-T
  gap alongside the thug term, swept on a coarse grid only
  (`lambda2 in {0.25, 0.5, 1.0}`). Highest overfitting risk: a fitted
  second dial on this corpus size is exactly how a model learns noise.

### Q2. Does the model hold up on uneven lobbies?

`T` is a **mean**, so headcount vanishes from the probability: an
even-mean 5v4 scores 50% even though the five-body side has a real
material advantage. The meter currently states this limitation in a chip
rather than modelling it, which is honest but unsatisfying.

**To score:** break duel-prediction accuracy out by whether the two
sides had equal rated-row counts. If accuracy on the uneven subset is
materially worse, a headcount term is worth designing; if it holds, the
chip is the right answer and no term is needed.

### Q3. Mean or softmax for the thug aggregation?

Phase 2A found that post-hoc **hard-MAX** team aggregation of canonical
ratings beat team-mean by ~10pp on `clean_win` prediction, and Phase 2C
established that the lift does *not* survive being moved into the rating
update rule (`critique/decisions/phase-2c-max-vs-median.md`). That memo
explicitly earmarks the finding for **Tools-layer consumption** and
roadmap §13.1 carries it as READY NOW.

But the 66.2% was earned with **plain means** in the `T` term. Swapping
in softmax is plausible-but-unvalidated, so it goes through the same
gate as everything else here.

**To score:** `T` as mean vs `softmax`-weighted mean
(`tau in {100, 200, 400}`) vs hard MAX.

## Sample-size caveat (registered up front)

The duel corpus is 625, but **only the ~120 telemetry duels can carry
these variants**. All three questions need per-player detail the duel
rows do not hold:

| Variant needs | Available on telemetry duels | Available on F9 duels |
|---|---|---|
| Commander's own pre-match VTSR-T | yes, via `elo_history` deltas | **no** |
| Per-side rated-row counts | yes, via `elo_history` deltas | **no** |
| Individual thug ratings (for softmax) | yes, via `elo_history` deltas | **no** |

F9-ledger duels carry only the pre-computed `team_handicap` means, so
every variant falls back to canonical on them. Scoring therefore runs on
the telemetry subset, and **the subset is scored under every variant
including V0** so the comparison is apples-to-apples. A variant must
beat V0 *on the same rows*, never V0's full-corpus number.

With n ~ 120 and Wilson intervals around +/-8pp, this corpus can detect a
large effect and nothing subtle. That is a reason to hold, not a reason
to relax the bar.

## PRE-REGISTERED PROMOTE RULE

A variant becomes promote-eligible iff, **on the identical telemetry
subset**, it satisfies ALL of:

1. **Accuracy improves by >= +3pp** over V0 on the same rows;
2. **Log-loss improves** (strictly lower) over V0 on the same rows;
3. **`n_scored` >= 100** under that variant (no promotion off a thin
   subset);
4. The improvement is **not confined to a single band** of the
   reliability strip — the variant must not buy accuracy in one
   confidence bucket by degrading another.

Anything else: **HOLD at V0 (canonical).** No partial credit. A
near-miss motivates corpus growth, not rule relaxation.

**Discard rule.** Any variant losing more than 3pp of accuracy is
dropped from future sweeps without further analysis.

**Q2 has no promote rule** — it is diagnostic only. It tells us whether
a headcount term needs designing; designing one would be its own memo
with its own pre-registered rule.

**If a variant does promote**, the change is NOT UI-only: it means
`scripts/elo_commander.py::_team_thug_means` should change too, so the
displayed formula and the rating stay the same function. That is a
`CMDR_ELO_SCHEMA_VERSION` bump and a re-rate, and it needs its own
implementation plan. Promotion here authorizes that work; it does not
perform it.

Amendments to this rule require a new memo section justified on
methodology grounds only (never by observed numbers), written BEFORE the
next run is examined.

## Results

_(appended after the rules above were committed; commit `fd4afe95`
registered the rules, this section landed after the first run)_

First run: 2026-09-18, validator v1.4 (`VALIDATOR_VERSION = 5`), 625
duels of which **120 scoreable telemetry duels**, canonical `lambda = 1.0`,
scale 400. Every row below is scored on those same 120 rows, canonical
included.

| variant | accuracy | Δacc | log-loss | Δll | promote |
|---|---|---|---|---|---|
| `canonical` (V0) | **72.5%** | — | 0.611 | — | baseline |
| `cmdr_in_mean` (V1) | 73.3% | +0.8pp | 0.604 | −0.0071 | FAIL (Δacc < +3pp) |
| `cmdr_conditional` (V2) | 71.7% | −0.8pp | 0.611 | −0.0002 | FAIL |
| `three_term` λ₂=0.25 (V3) | 72.5% | +0.0pp | 0.604 | −0.0070 | FAIL |
| `three_term` λ₂=0.5 | 68.3% | −4.2pp | 0.601 | −0.0100 | FAIL (discard) |
| `three_term` λ₂=1.0 | 68.3% | −4.2pp | 0.606 | −0.0050 | FAIL (discard) |
| `softmax` τ=400 | 70.0% | −2.5pp | 0.610 | −0.0011 | FAIL |
| `softmax` τ=200 | 66.7% | −5.8pp | 0.610 | −0.0007 | FAIL (discard) |
| `softmax` τ=100 | 64.2% | −8.3pp | 0.613 | +0.0024 | FAIL (discard) |
| `hard_max` | 60.8% | −11.7pp | 0.614 | +0.0029 | FAIL (discard) |

**VERDICT: HOLD at V0 (canonical).** No variant clears the +3pp
accuracy condition, so the promote rule is not satisfied by anything and
no partial credit applies. The shipped formula is unchanged.

### Q1 — commander VTSR-T: a whisper, not a step change

V1 is the only variant that moves both metrics the right way: **+0.8pp
accuracy and a genuinely better log-loss (−0.0071)**, improving in three
of four confidence bands (55-65%: 66.7 → 68.9, 65-75%: 72.2 → 73.0,
75%+: 78.9 → 81.8) and giving back ground only in the 50-55% coin-flip
band (80.0 → 75.0, n=20).

That is exactly the shape the exclusion argument predicts. The
commander's own fighting *is* mildly informative, and it is *mostly*
already priced into VTSR-C — so folding it in buys a fraction of a
point, not the step change that would justify changing a validated
formula. +0.8pp on n=120 sits far inside the ±8pp Wilson interval this
corpus affords; it is indistinguishable from noise at this sample size.

**V2 (provisional-conditional) losing to V1** is the genuinely
surprising result, since the a-priori argument for leaning on VTSR-T
specifically when VTSR-C is thin is the strongest of the three. The
likely mechanism is that the provisional window (5 duels) is too narrow
to matter on a corpus where the frequent commanders are all long past it
— so V2 is V0 with a handful of rows perturbed, and those rows are the
noisiest ones. Not worth a redesign on this evidence.

**V3 is a textbook overfitting curve**: neutral at λ₂=0.25, then −4.2pp
at both λ₂=0.5 and λ₂=1.0 while log-loss keeps *improving*. A second
fitted dial sharpens confidence on the rows it happens to fit and gets
the calls wrong. This is why the grid was registered coarse.

**Re-run trigger:** when the scoreable telemetry subset roughly doubles
(~250 duels), at which point a real +3pp would be detectable. V1 is the
only variant worth carrying forward; V2, V3 at λ₂ ≥ 0.5, all softmax
τ ≤ 200, and hard MAX are discarded under the discard rule.

### Q2 — uneven lobbies: untestable, chip stays

| lobby shape | accuracy | n |
|---|---|---|
| even rated-row counts | 72.2% | 115 |
| uneven | 80.0% | **5** |

Five rows. Nothing is knowable from this, exactly as the sample-size
caveat predicted. The Balonce Meter's uneven-teams **caveat chip remains
the correct answer** — it states the limitation instead of modelling it
on no evidence. No headcount term is designed.

### Q3 — softmax aggregation: roadmap §13.1 CLOSED, negative

This is the load-bearing finding of the run. Roadmap §13.1 and
`critique/decisions/phase-2c-max-vs-median.md` both carried "Tools Team
Balonce could legitimately switch from team-mean to softmax-weighted
mean" as READY NOW, on the strength of the Phase 2A result that hard-MAX
aggregation beat team-mean by ~10pp.

**Inside the VTSR-C duel formula it is strictly and substantially
worse, monotonically so:** τ=400 −2.5pp, τ=200 −5.8pp, τ=100 −8.3pp,
hard MAX −11.7pp. Accuracy degrades in lockstep with how MAX-like the
aggregation gets, and the two most MAX-like variants make log-loss worse
as well — they are confidently wrong.

The two results do not actually conflict; they are different predictors.
Phase 2A aggregated **thug VTSR-T as the whole prediction** of a
`clean_win` outcome, where a carry's lethality plausibly is what makes a
team a threat. Here the commander gap is the dominant term and `T` is
only a **handicap correction** to it — and a handicap wants the *typical*
strength of the squad a commander has to work with, not its ceiling. One
smurf does not change how hard the commander's job is nearly as much as
MAX implies.

**Recommendation: mark roadmap §13.1 CLOSED (negative).** Do not wire
softmax into Team Balonce. Anyone revisiting it should be pointed at
this table first.

## Source files

- `scripts/validate_elo.py` §14 `metric_cmdr_t_term` (regenerable:
  `python scripts/validate_elo.py`, output `_validation/report.md` §14 +
  `report.json` `cmdr_t_term`, schema 4 → 5)
- `js/balonce-meter.js` (`computeWinProb` — the V0 formula under test)
- This memo
