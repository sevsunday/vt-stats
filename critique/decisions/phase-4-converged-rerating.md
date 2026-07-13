# Phase 4 converged re-rating -- decision memo

Forensic-alt-mode trial of replacing the single sequential rating pass with a
fixed-point iteration ("converged re-rating", Whole-History Rating in spirit --
Coulom 2008). Each iteration anchors every match's OPPONENT reference ratings
(the E_i input) to the previous iteration's damped, gauge-pinned final ratings,
so early-corpus matches are re-priced against what opponents TURNED OUT to be
worth instead of the 1500 cold-start anchor. Implemented as
`converged=True` on `scripts/elo.py::compute_elo` (constants `CONVERGE_*`);
the pipeline emits `elo_current_converged.json` + `elo_history_converged.json`
beside canonical; scored via `python scripts/validate_elo.py --elo-mode
converged`.

**One-line verdict: STOP (hypothesis not supported).** The trial implementation
was REVERTED after the checkpoint review -- no converged mode ships, no schema
bump, no sigma/conservative-rank UI. This memo is the retained record; see §5.

---

## 1. Hypothesis (VTrider cold-start analysis, 2026-07-13)

A single chronological pass scores the corpus's earliest matches against
opponents frozen at the 1500 anchor -- E_i is meaningless while the field is
uncalibrated, so early gains are mispriced (the motivating case: VTrider
gained +162 of his +241 total in his first 10 rated matches at provisional K
against an uncalibrated field, then stopped playing before the field settled).
Because the pipeline re-rates from scratch every run, the identical error
replays forever; it never dilutes with corpus growth. Hypothesis: anchoring
every match's opponent expectations to CONVERGED strength estimates re-prices
the cold-start window correctly -- deflating gains earned against
actually-weak-but-anchor-rated lobbies, preserving gains earned against
actually-strong-but-anchor-rated lobbies -- while leaving the settled-era
ordering essentially untouched.

## 2. Mechanism notes (what the iteration does and does not change)

* `P_i` is lobby-z-scored and iteration-invariant; ONLY `E_i` moves.
* Self-expectation stays live within each pass (the
  `canonical_before_by_match` contract anchors opponents only), so a player's
  own rise still raises their own bar -- no self-leakage.
* **Gauge pinning**: VTSR is not zero-sum (loss aversion + floor taper), so
  the pool's absolute level has a slow common-mode drift under naive
  iteration (higher refs -> higher E_i everywhere -> smaller gains -> lower
  finals -> ...) that never meets epsilon while relative standings settle in
  2-3 iterations. Each iteration's reference finals are therefore shifted by
  one common constant so their mean equals the pass-1 canonical pool mean.
  E_i reads only rating DIFFERENCES, so pinning breaks the drift without
  touching relative standings, and keeps converged ratings on canonical's
  absolute scale.
* Damping `0.5`, epsilon `0.5` (final ratings are rounded to 0.1), max 12
  iterations. Measured on the 107-rated-match corpus: converges in 5-7
  iterations (canonical mode) / ~6 (thug-only).
* Known side effect: converged ratings sit ~15-30 ELO above canonical pool-
  wide. This is the loss-aversion asymmetry interacting with better-informed
  E_i, not an error -- relative standings are the meaningful output, and the
  scale note must accompany any promotion (pre-v11 `peak_vtsr` not
  comparable).
* The v2.8 low-tier lift composes on top: converge first (no lift), derive
  eligibility from CONVERGED canonical finals, one final lifted pass anchored
  to the converged refs. The v2.4 commander axis-shift runs unchanged inside
  every pass.

## 3. Pre-registered decision rule (set before the validator run)

| Outcome | Condition |
|---|---|
| **Promote** | self-consistency rho AND pooled Spearman rho hold within -0.01 of canonical AND calibration MAE within +0.005 AND synthetic-winner agreement stays >= 85% AND the cold-start diff is directionally sane (first-10-match gain deflation concentrated in early-corpus players; settled-era rank correlation >= 0.95) |
| **Discard** | pooled rho drops > 0.03 OR synthetic-winner agreement < 85% OR settled-era rank correlation < 0.90 |
| **Hold** | anything else |

Note: pooled Spearman (`R_pre -> P_i`) is expected to IMPROVE under
convergence almost by construction (R_pre is better-informed), so the rho
conditions are floors, not the interesting test. The interesting tests are
calibration MAE (does the logistic curve still describe reality when E_i is
converged?) and the cold-start diff's shape.

## 4. Headline comparison (validator, 107 rated matches, seed 12345, 2026-07-13)

| Metric | Canonical | Converged | Delta | vs rule |
|---|---|---|---|---|
| Spearman rho (R_pre -> P_i) | 0.445 | 0.438 | -0.007 | holds (within -0.01 band) |
| Self-consistency rho | 0.814 | **0.832** | **+0.018** | improves |
| Calibration MAE | 0.017 | 0.024 | +0.007 | **MISSES the +0.005 promote band by 0.002** |
| Synthetic-winner agreement | 100.0% | 96.9% | -3.1pp | passes 85% floor |
| clean_win accuracy (mean R) | 37.5% | 34.4% | -3.1pp | informational (n=32, CIs overlap) |
| Bootstrap top-20 Jaccard | 0.826 | 0.823 | -0.003 | flat |
| Bootstrap sigma (median ELO) | 31.9 | 33.9 | +1.9 | flat-ish |
| Settled-era rank correlation (non-provisional) | -- | **0.9941** | -- | passes >= 0.95 promote floor |

Convergence: 8 iterations, max_residual 0.3 (< epsilon 0.5). Thug-only pair
converges in ~6.

**Cold-start finding (the motivating test).** The converged re-rate applies a
pool-wide first-10-match uplift of ~+25 mean (settled opponent refs average
~1538 instead of the 1500 anchor, so a debutant's E_i drops and early gains
grow). Read RELATIVE to that uplift, VTrider's cold-start window was
approximately correctly priced by canonical: his first-10 gain moves +162.3 ->
+183.7 (+21.4, slightly BELOW the pool mean uplift). He keeps #1 with a
slightly larger absolute lead. The genuinely mispriced cold starts the
iteration surfaces are elsewhere: relative LOSERS are Sev (-14 vs uplift) and
Nomad (-10) -- early-corpus players whose opposition settled weaker than the
anchor priced -- and relative WINNERS are Vivify (+24 rel), Lamper (+15 rel),
tom (+14 rel), whose early opposition settled STRONGER than the anchor
priced. Rank moves among non-provisionals: Nomad #6
-> #7, blue #7 -> #6, Sev #8 -> #10, Vivify #10 -> #8, econchump/Cloaket #13
<-> #14 swap. Top 5 unchanged.

**Scale note.** Converged ratings sit +5 to +49 above canonical (pool-wide,
mechanism above + loss-aversion asymmetry compounding over better-informed
E_i). Relative standings are the meaningful output; any promotion re-rates
the corpus and voids pre-v11 `peak_vtsr` comparability per convention.

## 5. Verdict + re-evaluation triggers

**STOP (checkpoint decision, 2026-07-13).** The pre-registered rule landed
between promote and hold (calibration MAE missed its +0.005 band by 0.002;
every other condition passed or improved), but the deciding factor was the
cold-start finding itself: the converged re-rate showed the motivating
complaint was NOT supported by the data. VTrider's first-10-match gains were
priced approximately correctly by the canonical single pass (his uplift under
convergence sits AT the pool-mean uplift, not above it), he retains #1 with a
0.994 rank correlation, and the genuinely mispriced cold starts (Sev -14 /
Nomad -10 relative; Vivify +24 / tom +14 relative) are small, second-band
moves within the ~30 ELO bootstrap noise floor.

Decision: no changes at all. The trial implementation (compute_elo
`converged` flag, CONVERGE_* constants, pipeline alt-pair emission, validator
mode) was reverted rather than retained -- the canonical single-pass remains
the only pipeline. The companion staleness proposal (sigma + conservative
leaderboard rank) was also dropped: with the cold-start hypothesis dead, the
"frozen #1" resolves itself organically when VTrider returns (the Phase 2B
inactivity K-boost re-locates returners quickly) and the corpus keeps growing.

Re-evaluate (re-run the trial from this memo's spec) when ANY of:

1. **The complaint recurs with a player whose cold-start window looks
   genuinely distorted** -- i.e. an early-corpus player whose lobbies
   demonstrably settled far from the anchor (this corpus: max relative
   mispricing was ~14 ELO, inside noise).
2. **Corpus reaches ~250 rated matches** -- the settled-era reference gets
   sharp enough that the calibration-MAE regression (0.017 -> 0.024) can be
   attributed (E_i curve misfit vs small-sample noise).
3. **Recorded match outcomes land** (statsgate winner field) -- converged
   refs should then be judged on real-outcome calibration, where
   better-informed E_i has the most to offer.

Implementation note for any future revival (the trial code was reverted
without being committed -- rebuild from this spec): iterate `_rating_pass`
feeding each pass's damped FINAL ratings (NOT its per-match trajectory,
which is trivially its own fixed point) into the next pass's
`canonical_before_by_match` as a synthesized `{match_id: finals}` map. The
iteration requires GAUGE PINNING -- recenter each iteration's reference
finals by one common constant so their mean equals the pass-1 canonical pool
mean -- because VTSR's loss-aversion/floor asymmetry makes the absolute pool
level drift under naive iteration while relative standings converge in 2-3
passes (E_i reads only rating differences, so pinning is standings-neutral).
Constants used: damping 0.5 (new*0.5 + old*0.5), epsilon 0.5 on max
per-player final-VTSR change, max 12 iterations; measured 8 iterations on
the 107-match corpus (thug-only ~6). Compose the v2.8 lift ON TOP: converge
without lift, derive eligibility from converged finals, one final lifted
pass anchored to the converged refs. Stamp `converged` /
`converge_iterations` / `converge_max_residual` sentinels on both output
dicts; emit as `elo_current_converged.json` + `elo_history_converged.json`;
score via a `converged` `--elo-mode` in the validator.

## 6. Repro (from the reverted trial's spec)

```bash
# Rebuild the trial per the implementation note in §5, then:
python scripts/process_stats.py --no-sync              # emits elo_current_converged.json pair
python scripts/validate_elo.py                          # canonical -> _validation/
python scripts/validate_elo.py --elo-mode converged --output-dir _validation/converged
```

Checkpoint comparison sources: `_validation/report.json` (canonical,
2026-07-13) vs `_validation/converged/report.json` (same seed);
`_validation/_compare_converged.py` produced the leaderboard / cold-start /
sigma-preview tables reviewed at the checkpoint.
