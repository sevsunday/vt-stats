# Phase 3 rank-based lobby scoring -- decision memo

Forensic-alt-mode trial of replacing the per-axis lobby z-score pipeline
(`z-score -> clip(+-2) -> /2`, "zclip") with an average-rank percentile mapping
onto `[-1, +1]` ("rank"): `score_i = 2 * (avg_rank_i - 0.5) / n - 1`, ties ->
mean rank. Implemented as `lobby_score_mode` on `scripts/elo.py::compute_elo`;
the pipeline emits `elo_current_ranks.json` + `elo_history_ranks.json` beside
canonical; scored via `python scripts/validate_elo.py --elo-mode ranks`.

**One-line verdict: HOLD.** Keep zclip canonical; retain the ranks alt pair;
re-evaluate per §5. Neither the promote condition nor the discard condition of
the pre-registered rule fired.

---

## 1. Hypothesis (fable analysis, finding 5)

A population z-score over a 6-10 player lobby is noise-dominated: sigma
estimated from n=8 carries ~25% relative error, a single outlier row owns the
denominator, and the +-2-sigma clip triggers on estimation noise as often as
on true outliers. Rank scores keep the relative-to-lobby semantics while being
distribution-free, outlier-immune, clip-free, and lobby-size-invariant -- at
the cost of discarding MAGNITUDE (a narrow win over the #2 player scores the
same as a blowout). Hypothesis: the discarded magnitude is mostly noise, so
rank scoring should hold predictive power while reducing rating noise.

## 2. Pre-registered decision rule (set before the run)

| Outcome | Condition |
|---|---|
| **Promote-candidate** | self-consistency AND pooled rho hold within -0.01 of canonical AND bootstrap sigma improves |
| **Discard** | pooled rho drops > 0.03 |
| **Hold** | anything else |

## 3. Headline comparison (validator, 107 rated matches, seed 12345, 2026-06-10)

| Metric | Canonical (zclip) | Ranks | Delta | Reading |
|---|---|---|---|---|
| Spearman rho (R_pre -> P_i) | 0.445 | 0.438 | -0.007 | holds (within -0.01 band) |
| Self-consistency rho (split-half P_i) | 0.814 | **0.841** | **+0.027** | improves -- rank P_i is a more repeatable per-player signal |
| Synthetic-winner agreement | 100.0% (n=32) | 87.5% (n=32) | -12.5pp | still passes 85%; see §4.3 |
| clean_win accuracy (team mean R) | 37.5% | **43.8%** | +6.3pp | improves directionally; CIs overlap heavily (22.9-54.7 vs 28.2-60.7) |
| clean_win log-loss (mean R) | 0.707 | 0.707 | 0 | flat |
| Bootstrap top-20 Jaccard | 0.826 | 0.829 | +0.003 | flat |
| Bootstrap rating-proxy sigma (median ELO) | 31.9 | **37.0** | **+5.1** | WORSE on its face; scale-confounded, see §4.2 |
| Calibration MAE | 0.017 | 0.018 | +0.001 | flat |

## 4. Detail findings

### 4.1 Rating-economy + leaderboard effects

| Statistic | Canonical | Ranks |
|---|---|---|
| Mean rating | 1538.0 | 1555.5 (+17.5) |
| Min / Max | 1415.6 / 1741.5 | 1415.0 / 1772.6 |
| Leaderboard rank correlation | -- | **0.9824** |
| Top 5 | VTrider, Snake, Cyber, Domakus, Sly | identical |
| Largest single shift | -- | Nomad +50.5 ELO (#8 -> #6) |
| Mean / median shift | -- | +17.4 / +19.5 ELO |

No hard-MAX-style pathology: the modest extra mean drift (+17.5) follows from
rank scores having higher per-axis variance by construction (§4.2) flowing
through the loss-aversion asymmetry. Order is essentially preserved; only
Nomad (+2), Muffin (+2), Sev (-1), MAX (-2) move ranks among the top 15.

### 4.2 The sigma comparison is scale-confounded

Rank scores on an n=8 lobby occupy a fixed grid (+-0.875, +-0.625, +-0.375,
+-0.125) with std ~0.57; zclip post-clip scores cluster near 0 with std ~0.45.
Rank-mode per-match deltas are therefore ~25-30% larger in magnitude at the
same K, and the bootstrap rating-proxy sigma (a sum of preserved deltas)
inflates proportionally -- the observed +16% sigma increase (31.9 -> 37.0) is
*smaller* than the naive scale prediction, and the scale-free stability metric
(top-20 Jaccard) is flat. A fair noise comparison needs either delta-magnitude
normalization in the validator or an `ELO_RATING_SCALE` re-calibration for
rank mode (~2.0 instead of 2.5 to match canonical delta magnitudes). The
pre-registered rule did not anticipate this confound, so the rule's verdict
stands as written (HOLD), with the normalization listed as a re-evaluation
trigger below.

### 4.3 Synthetic-winner agreement dropping to 87.5% is not obviously bad

Canonical's 100% agreement (32/32) is argued in the fable analysis (finding 2)
to be circularity -- P_i and the kill-feed-inferred clean_win are two functions
of the same base-razing events. Rank P_i compresses blowout magnitudes, so it
agrees *less* perfectly with the destruction-derived winner label while
predicting that label *better* from pre-match ratings (43.8% vs 37.5%). A
performance index that is slightly less collinear with the outcome label but
more predictive of it is the direction you want; n=32 is far too small to
declare it, hence HOLD rather than promote.

### 4.4 Adjustment-layer caveats (trial approximations)

The v2.4 commander axis-shift priors and the v2.8 low-tier lift were
measured/tuned in post-clip z space. Both apply unchanged in rank space
(shared `[-1, +1]` range; the lift re-ranks the player's effective kill rate
against the lobby's full-time values). Effective strength differs slightly --
a -0.488 mobility shift spans ~2 rank positions in an 8-lobby instead of a
z-distance. Acceptable for a forensic trial; a promotion would require
re-measuring the commander audit in rank space.

## 5. Verdict + re-evaluation triggers

**HOLD.** Promote condition failed on bootstrap sigma (31.9 -> 37.0, worse);
discard condition (rho drop > 0.03) did not fire (-0.007). The self-consistency
improvement (+0.027 on the metric the validator calls "THE ceiling for any
rating system") and the clean_win lift (+6.3pp) make this the most promising
non-canonical mode tested to date -- materially unlike the hard-MAX trial,
which failed everything.

Re-evaluate (re-run `--elo-mode ranks` + refresh this memo) when ANY of:

1. **Corpus reaches ~200 rated matches** (CIs halve; the clean_win and
   self-consistency deltas become decidable).
2. **The sigma scale confound is removed** -- either delta-magnitude
   normalization in the validator's bootstrap, or a rank-mode
   `ELO_RATING_SCALE` re-calibration (~2.0) followed by a fresh comparison.
   If normalized sigma comes in at-or-below canonical, the promote condition
   retroactively passes and this memo should be revisited immediately.
3. **Recorded match outcomes land** (statsgate winner field) -- rank-vs-zclip
   should then be judged on real-outcome prediction, not the inferred
   clean_win subset.

## 6. Repro

```bash
python scripts/process_stats.py --no-sync          # emits elo_current_ranks.json pair
python scripts/validate_elo.py                      # canonical -> _validation/
python scripts/validate_elo.py --elo-mode ranks --output-dir _validation/ranks
```

Comparison sources: `_validation/report.json` (canonical, 2026-06-10) vs
`_validation/ranks/report.json` (same seed). Leaderboard comparison computed
directly from `elo_current.json` vs `elo_current_ranks.json`.

## 7. Re-evaluation (2026-09-04 — trigger #3 fired) — SUPERSEDED

> **This run was scored on a contaminated corpus.** Two synthetic
> proto-v4 fixtures (`2099-01-01T00-00-01` / `-02`, from
> `scripts/make_v4_fixture.py`) were still on disk; being clones of a
> real v3 session they carried a real roster and a determined outcome,
> so the pipeline rated them like genuine matches. Kept verbatim as the
> historical record. The binding result is §8. The verdict is unchanged.

Recorded outcomes landed (proto v3/v4 attestation + human adjudication; the
Stage E wins ladder consumes them), so per trigger #3 the ranks pair was
re-scored on the determined-outcome prediction set (validator v1.3, 115
rated matches, n = 40 determined rows, seed 12345):

| Metric | Canonical (zclip) | Ranks | Delta | Reading |
|---|---|---|---|---|
| Spearman rho (R_pre -> P_i) | 0.452 | 0.444 | -0.008 | holds (within -0.01 band) |
| Self-consistency rho | 0.821 | 0.829 | +0.008 | improves (smaller lead than 2026-06's +0.027) |
| Determined-outcome accuracy (team mean R) | 42.5% | **50.0%** | **+7.5pp** | improves directionally on REAL outcomes; CIs overlap (28.5-57.8 vs 35.2-64.8) |
| log-loss (mean R) | 0.699 | 0.699 | 0 | flat |
| Calibration MAE | 0.0108 | **0.0249** | **+0.0141** | WORSE — new negative this run |
| Bootstrap rating-proxy sigma (median ELO) | 29.1 | 36.6 | +7.5 | worse; scale confound (§4.2) still unresolved |

**Verdict: HOLD again.** The promote condition still fails on bootstrap
sigma (the §4.2 scale confound remains the blocker — trigger #2 is now the
critical path), and the calibration MAE degradation is a new mark against.
The determined-outcome accuracy lift (+7.5pp on real outcomes, up from
+6.3pp on inferred clean_wins) keeps ranks the most promising
non-canonical mode. Next action unchanged: normalize the sigma comparison
(validator delta-magnitude normalization or rank-mode `ELO_RATING_SCALE`
~2.0 re-calibration) before any promote decision.

## 8. Corrected re-evaluation (2026-09-04, post fixture purge) — BINDING

The two synthetic v4 fixtures were deleted and every validator mode
re-scored on the clean corpus. The §2 pre-registered rule is applied
unchanged.

Clean corpus: validator v4, **113 rated matches, n = 38 determined
rows**, seed 12345.

| Metric | Canonical (zclip) | Ranks | Delta | Reading |
|---|---|---|---|---|
| Spearman rho (R_pre -> P_i) | 0.447 | 0.438 | -0.009 | holds (inside the -0.01 band, but only just) |
| Self-consistency rho | 0.829 | **0.849** | **+0.020** | improves (between 2026-06's +0.027 and the contaminated run's +0.008) |
| Determined-outcome accuracy (team mean R) | 39.5% (15/38) | **47.4%** (18/38) | **+7.9pp** | improves directionally on REAL outcomes; CIs overlap (25.6-55.3 vs 32.5-62.7) |
| log-loss (mean R) | 0.7040 | 0.7031 | -0.0009 | flat/marginally better |
| Calibration MAE | 0.0134 | **0.0238** | **+0.0104** | WORSE — confirms the contaminated run's new negative |
| Bootstrap rating-proxy sigma (median ELO) | 29.3 | 37.1 | +7.8 | worse; §4.2 scale confound still unresolved |
| Mean rating | 1537.3 | 1555.6 | +18.3 | consistent with §4.1 (+17.5) |

**Verdict: HOLD again.** Promote condition fails on bootstrap sigma
(29.3 -> 37.1, worse); discard condition (rho drop > 0.03) does not fire
(-0.009). Every directional finding from §7 survives decontamination:
ranks leads on self-consistency and determined-outcome accuracy, trails
on sigma and calibration MAE. Trigger #2 (remove the sigma scale
confound) remains the critical path to any promote decision.

Repro: `python _investigation/sweep_table2.py` after the five validator
modes in §6.
