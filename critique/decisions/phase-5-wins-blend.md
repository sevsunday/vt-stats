# Phase 5 wins blend (Stage E ALPHA sweep) -- decision memo

## TL;DR

The R^W wins ladder is real machinery as of Stage E (proto v4 overhaul):
every rated match with a determined outcome updates a second per-player
ELO, and the published `vtsr = ALPHA * wins_elo + (1 - ALPHA) * thug_elo`
blend line now has a real left operand. `ALPHA` stays **0.0** (published
ratings unchanged, byte-identity gated). This memo pre-registers the rule
under which ALPHA may ever move, BEFORE the forensic sweep numbers were
generated or examined -- the promote decision must never be fitted to the
data that judges it.

Rules registered: 2026-09-04. Sweep results appended below after the
first full-pipeline emit of the alpha pairs (same session, but the rules
section was committed first and is append-only from here).

## The machinery (shipped inert)

- **R^W ladder** (`scripts/elo.py` `_rating_pass`): updates on rated
  matches whose outcome is DETERMINED (`adjudicated` / `attested` /
  `clean_win` / `contested` with `winner.team` in {1, 2}); draws
  (`decided_by == "draw"`) score S = 0.5 for every rated row;
  undetermined matches skip the wins update (counted in
  `wins_matches_skipped_undetermined`) while still rating the thug side
  in full (`matches_excluded_no_winner` stays 0).
- **Update rule**: per-row `dR^W = K_w(n) * (S - E_side)` with E_side
  from the logistic on **team-mean** R^W difference (scale 400). Mean,
  never MAX/softmax -- Phase 2C's decisive negative result (MAX inflates
  catastrophically as an update reference; MAX-flavored aggregations
  live in the VALIDATOR only, as prediction-side comparisons).
- **K**: symmetric `WINS_K_BASE 24 -> WINS_K_FLOOR 12` decaying over the
  first `WINS_PROVISIONAL_PRIOR 10` wins-rated games. No loss aversion
  (W/L is zero-sum), no floor, no inactivity boost (thug-calibrated;
  revisit if ALPHA ships > 0).
- **Role-blind**: commanders included; campod / low-activity rows
  excluded by the shared lobby predicate; thug-only mode inherits its
  row filter.
- **State initializes INSIDE `_rating_pass`** -- the v2.8 lowtier
  two-pass structure re-runs the pass, and leaked state would silently
  double every wins delta while the byte-identity gate (blind to wins at
  ALPHA = 0) kept passing. Gate B below exists precisely for this.
- **Emissions (additive)**: per-rating `wins_elo` (real values -- the
  1500 stub is gone), `wins_games`, `wins_record {w,l,d}`; per-delta
  `wins {before, after, delta, s, e}`; top-level `wins_*` constants +
  `wins_matches_rated` / `_skipped_undetermined` / `_skipped_one_sided`
  counters + `alpha_overridden` sentinel. `ELO_SCHEMA_VERSION` NOT
  bumped while inert (kboost precedent: additive sentinels, published
  vtsr unchanged); bumps to 11 when ALPHA flips.
- **Known user-visible touchpoints at inert ship (intended)**: the VTSR-T
  leaderboard rating-cell tooltip (js/elo.js) and the Tools resolver
  (js/tools/player-resolver.js) already read `wins_elo` and now show real
  R^W values. Desirable transparency -- the two-dials story becomes
  visible. The "Wins dial idle at alpha = 0" explainer copy remains
  accurate (it describes the blend weight, not the ladder).

## Golden gates (PASSED 2026-09-04)

`_investigation/golden_wins_elo.py`:

- **Gate A -- byte-identity A/B**: baseline elo.py (git HEAD) vs Stage E
  elo.py on the identical manifest-reconstructed corpus (133 entries at
  the contaminated first run, 131 after the fixture purge; both counts
  include the known duplicate-id match twice): every pre-existing
  field -- vtsr, thug_elo, every delta, every counter, every axis block
  -- byte-identical. (Comparing against the COMMITTED files is
  impossible outside the pipeline: the duplicate match exists as two
  different client recordings in pipeline memory but only one on disk.)
- **Gate B -- standalone wins recompute**: an independent single-pass
  replay built only from emitted artifacts reproduced every emitted
  `wins_elo` and `wins_games` exactly (37/37 players).
- Corpus snapshot: 41 wins-rated matches, 74 undetermined skips,
  0 one-sided skips, 34/37 players with >= 1 wins-rated game.
  **(Contaminated -- see "Corrected sweep" below. Two synthetic v4
  fixtures were on disk during this run. Both gates were re-run on the
  clean 131-match corpus and PASSED again; the clean snapshot is 39
  wins-rated matches, 74 undetermined skips, 0 one-sided skips.)**

## Forensic sweep plumbing

- Pipeline emits `elo_current_alpha{10,25,50}.json` (+ histories) via
  `compute_elo(alpha_override=...)`; all six files in the
  `load_cache_index()` skip set.
- At alpha > 0 the published vtsr is the real blend and `peak_vtsr`
  tracks the BLENDED value per match inside the walk (both ladders in
  scope). At alpha = 0 the blend is bit-identical to thug_elo, so
  canonical behavior is untouched (Gate A proves it).
- Validator `--elo-mode alpha10 | alpha25 | alpha50` scores each pair.
- Smoke (2026-09-04): alpha25 blend arithmetic verified exact on 3
  spot-checked players; `alpha` / `alpha_overridden` fields emit
  correctly.

## PRE-REGISTERED PROMOTE RULE (the only path to ALPHA > 0)

Promote-candidate iff SOME alpha in {0.10, 0.25, 0.50} satisfies ALL of:

1. **Determined-outcome accuracy improves >= +5pp** vs the ALPHA = 0
   baseline on the validator's determined-outcome prediction set;
2. **log-loss improves** (strictly lower) on the same set;
3. **Spearman rho (R_pre -> P_i) holds within -0.01** of baseline;
4. **calibration MAE holds within +0.005** of baseline;
5. **mean published rating drifts < 50 ELO above the 1500 anchor**
   (blend must not inflate the pool).

Discard rule: any alpha dropping Spearman by more than 0.03 is discarded
from future sweeps without further analysis.

Anything else: **HOLD at ALPHA = 0.0.** No partial credit. A near-miss
motivates corpus growth, not rule relaxation.

Amendments to this rule require a new memo section justified by
methodology arguments only (never by the observed sweep numbers), written
BEFORE the next sweep is examined.

## Fired re-evaluation triggers (bookkeeping)

- **Phase 3 ranks-mode HOLD, trigger #3 ("recorded outcomes land")**:
  FIRED -- the wins ladder consumes exactly those outcomes. The ranks
  pair gets re-scored via `--elo-mode ranks` alongside the alpha sweep;
  verdict appended to `critique/decisions/phase-3-rank-scoring.md`.
- **EOMM dual-track audit (roadmap 13.5)**: becomes unblocked only if
  ALPHA ever ships > 0. Not this plan.

## Sweep results (appended after the rules above were committed)

> **SUPERSEDED -- this sweep was scored on a contaminated corpus.** Two
> synthetic proto-v4 fixtures (`2099-01-01T00-00-01` / `-02`, generated
> by `scripts/make_v4_fixture.py` during Stage A) were still on disk.
> Because they are clones of a real v3 session they carried a real
> roster and a determined outcome, so the pipeline rated them like
> genuine matches. Numbers below are kept verbatim as the historical
> record; the binding result is the **Corrected sweep** section that
> follows. The verdict did not change.

First sweep: 2026-09-04, validator v1.3, 115 rated matches / 41
wins-rated / 40 determined-outcome prediction rows, seed 12345.

| mode | Spearman rho | self-cons | determined acc (mean R) | log-loss | calib MAE | bootstrap sigma | mean vtsr |
|---|---|---|---|---|---|---|---|
| ALPHA = 0 (canonical) | 0.452 | 0.821 | 42.5% | 0.699 | 0.0108 | 29.1 | 1538.6 |
| alpha10 | 0.455 | 0.821 | 42.5% | 0.700 | 0.0107 | 29.1 | 1534.5 |
| alpha25 | 0.459 | 0.833 | 42.5% | 0.700 | 0.0102 | 29.2 | 1528.5 |
| alpha50 | 0.463 | 0.837 | 42.5% | 0.700 | 0.0103 | 29.3 | 1519.1 |

Rule-by-rule verdict (every alpha):

1. Determined-outcome accuracy >= +5pp: **FAIL** — 42.5% at every
   alpha, identical to baseline. With 41 wins-rated matches at K <= 24,
   wins_elo values sit within ~+/-55 of anchor and never flip a
   team-mean comparison on the 40-row prediction set.
2. Log-loss improves: **FAIL** — 0.700 vs 0.699 (marginally worse).
3. Spearman within -0.01: pass (improves monotonically, 0.452 -> 0.463).
4. Calibration MAE within +0.005: pass (improves slightly).
5. Mean drift < 50 above anchor: pass (mean COMPRESSES toward anchor,
   1538.6 -> 1519.1 — blending toward near-anchor wins values).

**VERDICT: HOLD at ALPHA = 0.0.** Rules 1 and 2 fail; no partial credit.

Honest observation for the next sweep (not a rule change): rho,
self-consistency, and calibration all improve monotonically with alpha
while the pool compresses toward the anchor — the wins signal is not
noise, it is simply not yet decisive at this corpus size. Re-run the
sweep when the wins-rated corpus roughly doubles (~80 determined
matches) or after the next re-rate, whichever comes first.

## Corrected sweep (2026-09-04, post fixture purge) — BINDING

The two synthetic v4 fixtures were deleted (session `.binpb.gz` +
processed JSON), the pipeline re-ran, and all five validator modes were
re-scored. **The pre-registered rule was NOT touched** — the same five
conditions committed above are applied to the clean numbers.

Clean corpus: validator v4, **113 rated matches / 39 wins-rated / 38
determined-outcome prediction rows**, seed 12345.

| mode | Spearman rho | self-cons | determined acc (mean R) | log-loss | calib MAE | bootstrap sigma | mean vtsr |
|---|---|---|---|---|---|---|---|
| ALPHA = 0 (canonical) | 0.447 | 0.829 | 39.5% (15/38) | 0.7040 | 0.0134 | 29.3 | 1537.3 |
| alpha10 | 0.450 | 0.829 | 39.5% (15/38) | 0.7041 | 0.0130 | 29.3 | 1533.3 |
| alpha25 | 0.454 | 0.845 | 39.5% (15/38) | 0.7043 | 0.0135 | 29.6 | 1527.5 |
| alpha50 | 0.459 | 0.853 | 39.5% (15/38) | 0.7044 | 0.0134 | 29.6 | 1518.4 |

Rule-by-rule verdict (every alpha):

1. Determined-outcome accuracy >= +5pp: **FAIL** — 39.5% (15/38) at
   every alpha, byte-identical to baseline. Same mechanism as the first
   sweep: at 39 wins-rated matches with K <= 24, no wins_elo has moved
   far enough from anchor to flip a team-mean comparison on any of the
   38 prediction rows.
2. Log-loss improves: **FAIL** — 0.7041 / 0.7043 / 0.7044 vs baseline
   0.7040 (monotonically, marginally worse).
3. Spearman within -0.01: pass (improves monotonically, 0.447 -> 0.459).
4. Calibration MAE within +0.005: pass (-0.0004 / +0.0001 / +0.0000).
5. Mean drift < 50 above anchor: pass (compresses toward anchor,
   1537.3 -> 1518.4).

**VERDICT: HOLD at ALPHA = 0.0.** Rules 1 and 2 fail. Identical verdict
to the contaminated first sweep, which is itself the useful finding: the
2 fixtures were not what produced the HOLD.

The honest observation carries over unchanged and slightly strengthened
— rho and self-consistency still improve monotonically with alpha while
the pool compresses toward the anchor, so the wins signal is real but
not yet decisive. Re-run when the wins-rated corpus roughly doubles
(~80 determined matches) or after the next re-rate, whichever is first.

## Ranks-mode re-evaluation (trigger #3 bookkeeping)

Re-scored `--elo-mode ranks` on the same runs (now judged on the
determined-outcome set, which is dominated by attested/adjudicated real
outcomes — trigger #3's condition). Verdict appended to
`critique/decisions/phase-3-rank-scoring.md` §7 (contaminated) and §8
(corrected, binding): **HOLD again** in both. On the clean corpus rho
holds at -0.009, self-consistency improves +0.020, determined-outcome
accuracy leads by +7.9pp, but bootstrap sigma is still worse under the
unresolved scale confound (29.3 -> 37.1) and calibration MAE degrades
0.0134 -> 0.0238.

## Source files

- `scripts/elo.py` (wins ladder + alpha_override)
- `scripts/process_stats.py` (alpha-pair emission + cache skip set)
- `scripts/validate_elo.py` (`--elo-mode alpha{10,25,50}`)
- `_investigation/golden_wins_elo.py` (Gates A + B, regenerable)
- `_investigation/smoke_alpha_override.py` (blend smoke, regenerable)
- `_investigation/sweep_table2.py` (corrected-sweep table, regenerable)
- This memo
