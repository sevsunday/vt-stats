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

Status (2026-10-25): **HOLD three times** -- 2026-09-04 (39 wins-rated
matches), 2026-10-13 (199-row prediction set), 2026-10-25 (single-axis
VTSR-T, 236-row prediction set). See "Rescore (2026-10-25)" below.

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

## Display preview (not a promote)

The ELO-page VTSR-T leaderboard can preview the side files. `?rating=wins` shows the 50% blend. `w=10`, `w=25`, and `w=100` select the other weights. `w=100` is `alpha_override=1.0` (`elo_current_alpha100.json`): the wins ladder with the axes turned off, emitted for that preview only. It is not a promote candidate. The promote rule above is unchanged and still scores only {0.10, 0.25, 0.50}. Published `ALPHA` stays 0. The dashboard teaser, player pages, Tools, and the Balonce meter do not read these files. `last_delta` on the alpha files remains the performance step; the preview's Last column is assembled in the browser from canonical history (`alpha * wins step + (1 - alpha) * performance step`).

## Rescore (2026-10-13) — trigger fired, still HOLD

The "~80 determined matches" re-run above fired. Scored on the
2026-10-13T03:02 snapshot already on disk (`elo_current.json` and
`elo_current_alpha{10,25,50}.json`: 223 rated matches, 200 wins-rated,
seed 12345, validator v9). No pipeline re-run. The promote rule above
was not amended before the numbers were read, and `ALPHA` stays 0.

The prediction set is the validator's current team-mean winner call
(`clean_win_accuracy.aggregations.mean`): `clean_win` / `attested` /
`adjudicated`, contested excluded. Baseline is the committed
`validation_summary.json` from the same snapshot, 114/199 = 57.3%.
Alt-mode reports are in gitignored
`_validation/wins-blend-2026-10-13/`.

| mode | Spearman rho | self-cons | winner acc (mean R) | log-loss | calib MAE | bootstrap sigma | mean vtsr |
|---|---|---|---|---|---|---|---|
| ALPHA = 0 (canonical) | 0.277 | 0.713 | 57.3% (114/199) | 0.6816 | 0.0280 | 49.8 | 1578.6 |
| alpha10 | 0.278 | 0.713 | 56.8% (113/199) | 0.6815 | 0.0279 | 49.8 | 1570.8 |
| alpha25 | 0.279 | 0.713 | 56.8% (113/199) | 0.6814 | 0.0279 | 49.8 | 1559.1 |
| alpha50 | 0.280 | 0.713 | 56.8% (113/199) | 0.6813 | 0.0278 | 49.8 | 1539.8 |

Winner-call flips against canonical team-mean `before`, same 199 rows:
**1 flip at every alpha, and it is the same match.** `2026-10-04T02-15-47`
(attested, team 2 won). Canonical team means were 1615.82 vs 1615.83, so
team 2 was the favorite by 0.01 and the call was correct. All three blends
move the favorite to team 1. No other row changes side. Net −1 correct
call, no offsetting gain.

Rule-by-rule (deltas vs the ALPHA = 0 row):

1. Determined-outcome accuracy >= +5pp: **FAIL** at every alpha.
   113/199 vs 114/199 is −0.50pp.
2. Log-loss improves: **pass** at every alpha, marginally and
   monotonically (−0.000062 / −0.000155 / −0.000308).
3. Spearman within −0.01: **pass** (improves, +0.0006 / +0.0016 / +0.0029).
   The discard rule (drop > 0.03) does not fire.
4. Calibration MAE within +0.005: **pass** (improves,
   −0.000035 / −0.000087 / −0.000175).
5. Mean rating < 1550: **fail** at alpha10 (1570.8) and alpha25 (1559.1).
   **Pass** at alpha50 (1539.8, 39.8 above the 1500 anchor). The canonical
   pool is already 1578.6, 78.6 above the anchor, from corpus growth since
   the September sweep. The gate is the blend's own mean. Higher alpha
   still compresses the pool, which is what lets alpha50 clear it.

**VERDICT: HOLD at ALPHA = 0.0.** Rule 1 fails everywhere, so no alpha is
promote-eligible. No partial credit. The September finding does not
survive as "the calls are identical": one coin-flip match changes, and it
changes the wrong way. It does survive as "mixing wins in does not clear
the accuracy bar." Rho, log-loss, and calibration still improve slightly
as alpha rises. That is not a promote.

## Amendment (2026-10-25) — condition 5, written before the single-axis sweep was read

The "next re-rate" trigger above fired: VTSR-T moved to the single
`enemy_damage_share` axis on 2026-10-24 (`ELO_SCHEMA_VERSION` 18,
`critique/decisions/vtsr-t-enemy-damage.md`), and that memo kept ALPHA at
0 without re-scoring it. This section was committed before any
`elo_current_alpha*.json` accuracy, log-loss or mean was opened.

**Condition 5 is replaced.** Old wording: "mean published rating drifts
< 50 ELO above the 1500 anchor". New wording: **the blend's mean
published rating must not exceed the ALPHA = 0 mean on the same
snapshot.** Methodology argument only: the condition exists so "the
blend must not inflate the pool". The ALPHA = 0 pool on this snapshot
already sits at 1615.7, 115.7 above the anchor, from corpus growth, loss
aversion and the wider single-axis spread. None of that is caused by the
blend. Under the old wording a blend that pulls the mean down would
still fail at low alpha. The new wording tests what the condition is
for. Nothing else changes: conditions 1-4, the discard rule, the
prediction set (`clean_win_accuracy.aggregations.mean`: clean_win /
attested / adjudicated, contested excluded) and seed 12345.

Snapshot fingerprint (all five files from one pipeline run):

- `elo_current.json` `computed_at` 2026-10-25T03:35:55Z; alpha files
  2026-10-25T03:35:57Z
- `match_count` 259, `wins_matches_rated` 236,
  `wins_matches_skipped_undetermined` 23
- `weights` = `{enemy_damage_share: 1.0}` in every file
- Baseline (`_validation/report.json`, same run): 133/235 = 56.6%,
  log-loss 0.6778; mean VTSR-T 1615.7 over 48 rated players

## Rescore (2026-10-25) — single-axis VTSR-T

**Verdict: HOLD (third time).** No alpha passes condition 1. Accuracy
does not move at α = 0.10 or 0.25 and drops by one match at α = 0.50.
No alpha triggers the discard rule.

**Snapshot drift, stated plainly.** One new session landed (commit
`4176480b`, pipeline run 2026-10-25T05:05:53Z) between the fingerprint
above and the sweep. The sweep and its baseline both read that newer
run: `match_count` 260, `wins_matches_rated` 237, weights still
`{enemy_damage_share: 1.0}`, canonical `_validation/report.json`
regenerated in the same run (05:06:01Z). Condition 5 is applied against
that run's ALPHA = 0 mean, 1615.9 (the amendment's rule, not its
illustrative number). The one extra match changes no verdict.

Run: `python scripts/validate_elo.py --elo-mode alpha{10,25,50}
--output-dir _validation/wins-blend-2026-10-25/<mode>` (validator v11,
seed 12345); table from `_investigation/sweep_table_2026_10_25.py`.
Prediction set: `clean_win_accuracy.aggregations.mean`, 236 matches.

| Mode | Spearman ρ | Self-cons. | Winner acc. | Log-loss | Calib. MAE | Bootstrap σ | Mean VTSR-T |
|------|-----------|-----------|-------------|----------|-----------|-------------|-------------|
| ALPHA = 0 (canonical) | 0.4158 | 0.850 | 56.4% (133/236) | 0.677980 | 0.02454 | 70.5 | 1615.9 |
| alpha10 | 0.4177 | 0.850 | 56.4% (133/236) | 0.677897 | 0.02404 | 70.5 | 1603.8 |
| alpha25 | 0.4208 | 0.853 | 56.4% (133/236) | 0.677760 | 0.02416 | 70.5 | 1586.1 |
| alpha50 | 0.4273 | 0.865 | 55.9% (132/236) | 0.677318 | 0.02413 | 70.5 | 1556.8 |

| Condition | alpha10 | alpha25 | alpha50 |
|-----------|---------|---------|---------|
| 1. Accuracy ≥ +5pp | **fail** (+0.0pp) | **fail** (+0.0pp) | **fail** (−0.4pp) |
| 2. Log-loss strictly lower | pass (−0.000083) | pass (−0.000220) | pass (−0.000662) |
| 3. ρ within −0.01 | pass (+0.0019) | pass (+0.0050) | pass (+0.0115) |
| 4. MAE within +0.005 | pass (−0.0005) | pass (−0.0004) | pass (−0.0004) |
| 5. Mean ≤ ALPHA = 0 mean (amended) | pass (1603.8) | pass (1586.1) | pass (1556.8) |
| Discard (ρ drop > 0.03) | no | no | no |

**Winner calls.** Same 236 matches, team-mean call per match. alpha10
and alpha25 flip no calls. alpha50 flips one, `2026-06-01T02-09-58`
(team means 1530.0 vs 1520.3 at ALPHA = 0, 1518.9 vs 1521.2 at 0.50),
and the flip is wrong: team 1 won.

**What favors the blend, reported anyway.** ρ, self-consistency (0.850 →
0.865) and log-loss all improve monotonically with alpha, the same
direction as both earlier sweeps. The log-loss gain at α = 0.50 is
0.00066 nats per match, about a tenth of a percent. Probabilities get a
little better and the winner calls stay the same.

**Reading across the three sweeps.** VTSR-T went from four axes to one,
and the rated corpus grew from 113 to 260 matches. The wins ladder still
changes no call at low alpha, and at α = 0.50 it flips one call in the
wrong direction. The rule held up with the target moving underneath it.

**Next trigger.** Unchanged: re-run this sweep after the next VTSR-T
re-rate (`ELO_SCHEMA_VERSION` bump). Same rule, amended condition 5.

### Bookkeeping: the 2026-09-23 run

A sweep was run on 2026-09-23 (validator v7, `ELO_SCHEMA_VERSION` 13,
166 rated matches, 142 in the prediction set) into
`_validation/wins-blend/` and never written into this memo. Mean-R
accuracy: canonical 55.6% (79/142), alpha10 55.6% (79), alpha25 56.3%
(80), alpha50 57.0% (81). The largest lift was +1.4pp (two matches) at
α = 0.50, under the +5pp bar, so it
would have held. Recorded here so the record has no gap.

## Source files

- `scripts/elo.py` (wins ladder + alpha_override)
- `scripts/process_stats.py` (alpha-pair emission + cache skip set)
- `scripts/validate_elo.py` (`--elo-mode alpha{10,25,50}`)
- `_investigation/golden_wins_elo.py` (Gates A + B, regenerable)
- `_investigation/smoke_alpha_override.py` (blend smoke, regenerable)
- `_investigation/sweep_table2.py` (corrected-sweep table, regenerable)
- `_investigation/sweep_table_2026_10_25.py` (single-axis rescore table + flips, regenerable)
- `scripts/study_wins_signal.py` (why win/loss carries little individual signal; `_validation/wins_signal.{md,json}`)
- This memo
