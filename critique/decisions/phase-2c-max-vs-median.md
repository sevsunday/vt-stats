# Phase 2C MAX-vs-median vs softmax -- decision memo

Auto-generated comparison of three full corpus re-rates under different `expected_performance_mode` settings of `scripts/elo.py::compute_elo`. Each mode emits its own `elo_current_*.json` + `elo_history_*.json` pair; the validator (`scripts/validate_elo.py --elo-mode {default,max,softmax}`) scores each independently.

**One-line verdict:** see §1 + §5.

---

## 1. Headline metric comparison (validator output, n=100 rated matches)

Three full re-rates of the corpus, each scored independently. **Lower-is-bad** for Spearman rho and bootstrap stability; **higher-is-better** for clean_win accuracy.

| Metric | **Canonical (median)** | Hard MAX | Softmax MAX (tau=200) |
|---|---|---|---|
| Spearman rho (R_pre -> P_i, **predictive ceiling**) | 0.4622 | 0.1882 | 0.3586 |
| Self-consistency rho (career-stable signal) | 0.8043 | 0.8043 | 0.8043 |
| Synthetic-winner agreement vs clean_win | 0.9333 | 0.9333 | 0.9333 |
| clean_win predicted by team mean R (n=30) | 0.4333 | 0.4333 | 0.5000 |
| clean_win predicted by team hard MAX R (n=30) | 0.5333 | 0.4667 | 0.5333 |
| clean_win predicted by team softmax R (n=30) | 0.4667 | 0.4667 | 0.4667 |
| Bootstrap top-20 Jaccard mean (rank stability) | 0.8261 | 0.8793 | 0.8653 |
| Bootstrap rating-proxy std (median ELO; lower=tighter) | 27.02 | 50.05 | 32.38 |
| Dirichlet rho mean (knife-edge sensitivity check) | 0.9857 | 0.9857 | 0.9857 |

## 2. The Phase 2A preview vs Phase 2C full re-rate

The Phase 2A validator preview computed team aggregations (mean / hard MAX / softmax MAX) **on the existing canonical ratings** -- i.e. it asked 'given the current rating values from median-canonical, would aggregating them differently at team-prediction time predict winners better?' Answer at Phase 2A: yes, hard MAX added +10pp.

Phase 2C asked a different question: **'what if we rebuilt the rating values themselves under MAX assumptions, then scored the result?'** Cascading R_before chain effects mean this is NOT the same experiment.

**The two questions and the two results:**

| Question | Method | Result |
|---|---|---|
| 'Should we aggregate ratings differently *at team-prediction time*?' | Phase 2A: re-aggregate canonical ratings post-hoc | Hard MAX: +10pp lift on clean_win accuracy |
| 'Should we use a different opponent reference *during rating updates*?' | Phase 2C: full corpus re-rate under hard MAX / softmax | **Lift does NOT survive.** See §3 below. |

These are answering different questions and the answers don't have to match. Phase 2A's aggregation finding is still useful for downstream consumers (e.g. Lobby Tools' Team Balonce could use a softmax-weighted balance signal at lobby-formation time). Phase 2C's negative result tells us the *internal* rating math should keep median.

## 3. Why hard MAX breaks the rating math

When `E_i` is computed against `max(opponents)` instead of `median(opponents)`, every player except the lobby's strongest has their expected-performance reference dragged toward the lobby ceiling. The **logistic E_i curve saturates near -1 for any sub-max player** (they're expected to do much worse than max), so when they perform at average lobby level (`P_i ~= 0`), `dR = K * S * (P_i - E_i)` stays positive and they gain rating every match. **The result is systematic rating inflation, not better calibration.**

**Rating-economy effects of swapping the opponent reference:**

| Statistic | Canonical (median) | Hard MAX | Softmax MAX (tau=200) |
|---|---|---|---|
| Mean rating | 1532.2 | **2021.7 (+489)** | 1662.5 (+130) |
| Min rating | 1413.7 | 1487.2 | 1471.5 |
| Max rating | 1743.8 | 2477.0 | 1893.2 |
| Range | 330.1 | **989.8 (3.0x)** | 421.7 (1.3x) |

Anchor is 1500. Canonical mean (1532) is barely above anchor after 100 matches -- ratings are roughly zero-sum modulo the soft floor and loss aversion. Hard MAX mean (2022) is 522 ELO above anchor: **systematic upward drift**, not skill-tracking. Softmax mean (1663) is in between, +163 above anchor.

**Specific symptoms in the validator:**

- **Spearman rho R_pre -> P_i collapses from 0.462 to 0.188** (canonical -> hard MAX). The rating's predictive signal for in-match performance erodes because everyone's rating is drifting upward at different rates -- the rating no longer tracks skill, it tracks 'how many lobbies have you been in with a noticeably stronger top-rated player.'
- **Bootstrap rating-proxy std jumps from 27 ELO to 50 ELO** (canonical -> hard MAX): nearly 2x noisier ratings under match resampling.
- **Self-consistency rho is unchanged** (0.804 across all three modes): past P_i still predicts future P_i because the axes themselves are unchanged. The composite is sound; only the rating *update* math is breaking under MAX assumptions.
- **Top 5 leaderboard reorders.** Canonical: VTrider, Domakus, Snake, Nomad, Cyber. Hard MAX: Nomad, Snake, Domakus, Sev, F9bomber -- VTrider drops OUT of the top 5 entirely. The rating becomes 'who has played the most matches against weaker lobbies' rather than 'who is best.'
- **Softmax MAX is a less-pathological version of the same failure mode.** Top 5 mostly preserved (VTrider drops to #4 instead of out), mean drift +163 instead of +522, range 1.3x instead of 3.0x. Spearman rho 0.359 is between canonical and hard MAX. Still strictly worse than canonical on the headline metrics.

## 4. Per-player rating shifts (canonical -> hard MAX)

How much do individual ratings move under the hard MAX re-rate? Top 15 by |delta|.

| Player | Matches | VTSR canonical | VTSR hard MAX | delta | rank shift |
|---|---|---|---|---|---|
| F9bomber | 85 | 1550.7 | 2359.6 | +808.9 | up 8 |
| Lithium | 62 | 1509.8 | 2317.0 | +807.2 | up 12 |
| Nomad | 62 | 1670.2 | 2477.0 | +806.8 | up 3 |
| Sev | 56 | 1586.5 | 2371.7 | +785.2 | up 6 |
| Snake | 48 | 1686.8 | 2468.1 | +781.3 | up 1 |
| econchump | 30 | 1505.0 | 2254.7 | +749.7 | up 14 |
| Certified Bad Guy | 46 | 1507.2 | 2232.6 | +725.4 | up 11 |
| Domakus | 51 | 1719.3 | 2424.5 | +705.2 | down 1 |
| judgeguns | 36 | 1417.0 | 2114.2 | +697.2 | up 17 |
| blue | 23 | 1598.8 | 2264.5 | +665.7 | up 1 |
| sponge | 27 | 1513.0 | 2165.7 | +652.7 | up 2 |
| Vivify | 45 | 1579.6 | 2229.6 | +650.0 | - |
| Cloaket | 30 | 1520.1 | 2160.1 | +640.0 | down 1 |
| Waddles | 28 | 1460.4 | 2073.6 | +613.2 | up 7 |
| Monkey | 20 | 1413.7 | 2023.6 | +609.9 | up 15 |

**Reading:** Every player gains hundreds of ELO under hard MAX -- this is the runaway inflation described in §3. Average-skill players gain the most because they get the biggest E_i drag toward -1. Top players gain less because they're closer to the lobby max. The biggest deltas don't tell us 'these are the best players' -- they tell us 'these are the players who got the most rating inflation under MAX assumptions.' Rank shifts of 10+ positions are common because different players inflate at different rates.

## 5. Decision memo

**Verdict: KEEP MEDIAN as the canonical opponent reference. Do NOT promote hard MAX or softmax to canonical.**

**Reasons:**

1. The Phase 2A directional lift was a **post-hoc team-aggregation effect**, not a re-rating-mode effect. The full corpus re-rate under hard MAX collapses Spearman rho from 0.462 to 0.188 and nearly doubles bootstrap noise. The lift does not survive.
2. **Canonical median wins decisively** on the two metrics that matter most for a rating system: predictive Spearman rho and rank stability under resampling. The clean_win prediction metrics are mixed but secondary -- they're n=30 with 16+ pp Wilson CIs, far less reliable than the n=884-pair Spearman and the 100-run bootstrap.
3. **Softmax MAX is a less-bad version of hard MAX, but still worse than canonical on the headline metrics.** It would be a reasonable choice if median were producing problematic team-balance behavior in practice -- but Phase 1 + 2A showed median is well-calibrated on individual performance (Spearman 0.46, calibration MAE 0.018). There is no behavioral problem to solve at the rating-update layer.

**What this DOESN'T close out:**

- The Phase 2A finding that **post-hoc team-aggregation** of canonical ratings via hard MAX adds +10pp on clean_win prediction is still real and useful. **Lobby Tools' Team Balonce could legitimately switch from team-mean to softmax-weighted-mean as its team-strength estimate** for matchmaking purposes, while compute_elo continues to use median for the rating updates themselves. These are separate decisions and Phase 2A's evidence directly motivates the Tools-page change without disturbing canonical ratings.

**Files emitted by this Phase 2C work:**

- `data/processed/elo_current.json` + `elo_history.json` -- canonical (median, unchanged)
- `data/processed/elo_current_max.json` + `elo_history_max.json` -- hard MAX (forensic only)
- `data/processed/elo_current_softmax.json` + `elo_history_softmax.json` -- softmax MAX (forensic only)
- `_validation/{default,max,softmax}/report.{md,json}` -- per-mode validator output
- This memo: regenerate via `python _validation/_compare_2c_modes.py`

**No `PIPELINE_VERSION` / `ELO_SCHEMA_VERSION` bump required.** The two new fields on `elo_current.json` (`expected_performance_mode`, `expected_performance_softmax_tau`) are additive sentinels with safe defaults; existing JS readers are unaffected.
