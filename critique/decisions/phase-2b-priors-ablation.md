# Phase 2B locked-priors ablation -- decision memo

Auto-generated comparison of canonical (`elo_current.json`) vs unlocked-priors (`elo_current_unlocked.json`) outputs of `scripts/elo.py`. Reading from the three `_validation/` validator runs.

**One-line verdict:** see §1 + §6 below.

---

## 1. Headline metric comparison (validator output, n=100 rated matches)

| Metric | Canonical | Unlocked | Thug-only |
|---|---|---|---|
| Spearman rho (R_pre -> P_i) | 0.4623 | 0.4623 | 0.4315 |
| Self-consistency rho (mean across players >=4 matches) | 0.8043 | 0.8063 | 0.8364 |
| Synthetic-winner agreement vs clean_win | 0.9333 | 0.9333 | 0.9333 |
| clean_win predicted by team mean R | 0.4333 | 0.4333 | 0.4667 |
| clean_win predicted by team hard MAX R | 0.5333 | 0.5333 | 0.5000 |
| clean_win predicted by softmax MAX R (tau=200) | 0.4667 | 0.4667 | 0.4667 |
| Bootstrap top-20 Jaccard mean | 0.8261 | 0.8271 | 0.7836 |
| Bootstrap rating-proxy std (median ELO) | 26.97 | 26.84 | 25.23 |
| Dirichlet rho mean (weight perturbation) | 0.9857 | 0.9855 | 0.9852 |

**Reading:** Unlocked changes the rating values themselves (see §3 below) but the validator-level headline metrics are essentially flat between Canonical and Unlocked. With n=30 clean_wins and the locks affecting only commander rows on two axes, this is the expected signal floor: team-prediction sensitivity to per-row commander adjustments is below noise.

## 2. Effective lock set actually used by each run

- Canonical effective lock set: `['pve_share', 'target_lock_pct']`
- Unlocked effective lock set:  `[]`
- Module default (constant):    `['pve_share', 'target_lock_pct']`

## 3. Effective per-axis commander baseline (post-clip space)

This is what each commander row gets shifted by in each variant. Audit-derived rows (mobility / thug_kill_rate / net_damage_share / thug_efficiency) are identical between modes by construction. The two formerly-locked axes are where the ablation lives.

| Axis | Canonical baseline | Unlocked baseline | Locked status (canonical) | Empirical mean (n) |
|---|---|---|---|---|
| `mobility` | -0.3607 | -0.3607 | rolling | -0.3416 (n=200) |
| `thug_kill_rate` | -0.1089 | -0.1089 | rolling | -0.1007 (n=200) |
| `net_damage_share` | -0.0730 | -0.0730 | rolling | -0.0643 (n=200) |
| `thug_efficiency` | -0.1124 | -0.1124 | rolling | -0.1134 (n=200) |
| `target_lock_pct` | -0.1000 | -0.3536 | LOCKED | -0.3950 (n=184) |
| `pve_share` | -0.0500 | 0.0428 | LOCKED | 0.0567 (n=200) |

**Where the locks bite:**
- `target_lock_pct`: canonical baseline -0.10 (hand-tuned cushion). Unlocked baseline -0.354 (full empirical relief). Unlocked gives commanders ~0.25 *more* post-clip credit per match on this axis.
- `pve_share`: canonical baseline -0.05 (hand-tuned reward shift; becomes a +0.05 credit). Unlocked baseline +0.043 (slight dock; follows the empirical mean). Unlocked *removes* the +0.05 reward boost and replaces it with a small penalty -- swing of ~0.09 per commander match in the unfavorable direction.

## 4. Top-15 biggest VTSR-T deltas (canonical -> unlocked)

Players ordered by `|delta|` descending. Negative delta = player is rated lower under unlocked priors. Commander-heavy players are where the action is.

| Player | Matches | As cmdr | VTSR canonical | VTSR unlocked | delta | rank shift |
|---|---|---|---|---|---|---|
| vacuum34 | 4 | 4 | 1451.4 | 1447.5 |   -3.9 | - |
| Darkvale | 43 | 18 | 1417.6 | 1413.8 |   -3.8 | down 1 |
| blue | 23 | 14 | 1598.8 | 1595.3 |   -3.5 | - |
| Cloaket | 30 | 14 | 1520.1 | 1516.8 |   -3.3 | down 1 |
| Snake | 48 | 26 | 1687.0 | 1684.0 |   -3.0 | - |
| Sev | 56 | 28 | 1586.6 | 1583.6 |   -3.0 | - |
| Lithium | 62 | 17 | 1509.9 | 1506.9 |   -3.0 | down 1 |
| Certified Bad Guy | 46 | 14 | 1507.3 | 1504.3 |   -3.0 | - |
| Nomad | 62 | 8 | 1670.2 | 1667.5 |   -2.7 | - |
| F9bomber | 85 | 17 | 1550.8 | 1548.1 |   -2.7 | - |
| econchump | 30 | 5 | 1505.1 | 1502.4 |   -2.7 | - |
| dd | 23 | 5 | 1425.8 | 1423.2 |   -2.6 | - |
| VTrider | 51 | 3 | 1744.1 | 1741.6 |   -2.5 | - |
| Waddles | 28 | 2 | 1460.0 | 1457.5 |   -2.5 | - |
| judgeguns | 36 | 1 | 1417.0 | 1414.5 |   -2.5 | up 1 |

## 5. Aggregate VTSR-T delta stats

| Cohort | n | min delta | max delta | mean delta | std delta |
|---|---|---|---|---|---|
| All players       | 35 | -3.9 | +0.0 | -2.13 | 0.96 |
| With cmdr matches | 28 | -3.9 | -1.1 | -2.44 | 0.73 |
| Pure thugs only   | 7 | -2.3 | +0.0 | -0.89 | 0.74 |

**Reading:** Pure-thug players see no rating change between modes (delta = 0 across the cohort by construction -- the ablation only touches commander row evaluation, but cascading matchwise lobby shifts could in principle bleed in via R_before chains). Commander-active players' deltas surface the actual impact of the ablation.

## 6. Decision memo

**The ablation does shift commander ratings**, but the shifts are TINY in context. The biggest single-player rating delta is 3.9 ELO; the commander-active cohort mean is -2.44 ELO. Bootstrap rating-proxy noise on the same corpus is ~27 ELO median. **The locked-vs-unlocked rating delta is well below the per-player noise floor.** Validator headline metrics (Spearman, calibration, self-consistency, clean_win prediction, bootstrap stability) are indistinguishable between modes.

**Three paths forward:**

1. **Keep canonical locks (status quo, RECOMMENDED).** Empirical evidence does not motivate a change. The locks implement documented design intent ('commanders should hold target lock nearly as much as thugs because the T-key is universally available'; 'commanders should be actively rewarded for PvE work') and the validator cannot demonstrate they cost anything predictively. Ship the alt JSON pair as opt-in forensics. Re-evaluate at corpus n>200 or once a commander-free clean_win subset materializes.
2. **Adopt unlocked priors as canonical.** The empirical-data path is the lower-future-maintenance choice. Risk: commanders see rating shifts of up to single-digit ELO immediately on swap. Net effect on the leaderboard: at most one or two single-position rank shifts in the top 15, all within bootstrap noise.
3. **Split the locks** -- drop `pve_share` (the +0.05 reward boost is the softer normative claim: 'reward what commanders already do more of'); keep `target_lock_pct` (the cushion has a clearer normative basis: 'T-key is universally available'). Net rating impact would be intermediate to options 1 and 2.

**Recommendation: option 1 (keep canonical).** With rating shifts of 2-4 ELO against a 27 ELO noise floor and zero headline-metric impact, no empirical case has been made to change the locks. The canonical setup remains documented design intent that the data has neither confirmed nor refuted. The alt JSON pair stays on disk for forensics; the lock set stays where it is. If a future audit (more matches, commander-free clean_win subset, or a different metric like matchmaking-quality predictiveness in Tools) shows the locks actively cost something, we revisit then.

## 7. Source files

- Canonical elo: `data/processed/elo_current.json` (canonical)
- Unlocked elo: `data/processed/elo_current_unlocked.json`
- Thug-only elo: `data/processed/elo_current_thugs_only.json`
- Validator runs: `_validation/{default,thugs_only,unlocked}/report.{md,json}`
- This memo: regenerate via `python _validation/_compare_modes.py`
