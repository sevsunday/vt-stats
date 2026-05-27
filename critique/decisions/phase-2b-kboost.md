# Phase 2B inactivity K-boost -- decision memo

## TL;DR

Inactivity K-boost is wired in, validates as safe-blind on the current corpus, and ships in canonical. No regressions. Effect on current data is essentially zero because the corpus is dense (matches happen close together in time); the mechanism will materialize when long-absent players return.

## What changed

`scripts/elo.py`:

```
def k_factor(matches_played: int, days_inactive: float = 0.0) -> float:
    base = ELO_K_BASE * (1 - n / (n + ELO_PROVISIONAL_PRIOR)) + ELO_K_FLOOR
    if days_inactive <= 0.0:
        return base
    boost = min(K_INACTIVITY_BOOST_MAX, K_INACTIVITY_BOOST_RATE * days_inactive)
    return base + boost
```

New module constants: `K_INACTIVITY_BOOST_RATE = 0.05` (ELO/day) and `K_INACTIVITY_BOOST_MAX = 20.0` (cap). Surfaced on `elo_current.json` as `k_inactivity_boost_rate` and `k_inactivity_boost_max` for visibility / future tuning.

`compute_elo()` now tracks `last_match_dt[key]` per player across the chronological loop. On each rated row it computes `days_inactive = (current_match_dt - prev_match_dt).days` (defensive 0.0 fallback when either date is unparseable or the player is in their first appearance) and threads that into `k_factor()`.

A new private helper `_parse_match_date()` handles the project's canonical ISO date formats including the `Z` suffix on Python <3.11.

`scripts/process_stats.py` is unchanged; it reads ratings out of `compute_elo` the same way it always did.

## Activity audit (current corpus, 100 rated matches, 849 player-rows with prior history)

| Metric | Value |
|---|---|
| Median days_inactive per row | 0.02 |
| Mean days_inactive per row | 0.96 |
| p90 days_inactive | 3.05 |
| Max days_inactive | 25.9 |
| Rows hitting full +20 cap | 0 (0.0%) |
| Total extra K applied across corpus | 40.7 |
| Mean extra K per row | 0.05 |

The longest single-player gap in the entire corpus is 25.9 days, which produces a +1.30 ELO-K boost (`0.05 * 25.9`) on top of the player's matches-played K. Most rows see boosts of less than 0.10. The mechanism is correctly inert on the current dense corpus.

## Pre / post-K-boost canonical validator drift

All differences are at or below the 4th decimal place except bootstrap rating-proxy std, which moved by 0.057 ELO out of a ~27 ELO baseline (well within bootstrap-run-to-run noise from re-shuffled match samples).

| Metric | Pre | Post | Delta |
|---|---|---|---|
| Spearman rho (R_pre -> P_i) | 0.4623 | 0.4622 | -0.0000 |
| Self-consistency rho | 0.8043 | 0.8043 | +0.0000 |
| Synthetic-winner agreement | 0.9333 | 0.9333 | +0.0000 |
| clean_win mean R accuracy | 0.4333 | 0.4333 | +0.0000 |
| clean_win hard MAX R accuracy | 0.5333 | 0.5333 | +0.0000 |
| clean_win softmax MAX R accuracy | 0.4667 | 0.4667 | +0.0000 |
| Bootstrap top-20 Jaccard mean | 0.8261 | 0.8261 | +0.0000 |
| Bootstrap rating-proxy std (med ELO) | 26.97 | 27.02 | +0.06 |
| Dirichlet rho mean | 0.9857 | 0.9857 | +0.0000 |

## Decision

**Ship in canonical.** The mechanism is wired, validates as safe-blind on dense data, and stands ready to absorb returning-player uncertainty without bloating volatility on regular players. No `PIPELINE_VERSION` / `ELO_SCHEMA_VERSION` bump required (the boost surfaces on existing `elo_current.json` as additive sentinel fields; no field removals).

## Re-tuning protocol

If a future audit shows returning players still systematically miscalibrate (e.g. > 50 ELO drift over their first 5 matches back after a 6-month absence), the levers in priority order:

1. Bump `K_INACTIVITY_BOOST_RATE` (currently 0.05 ELO/day) -- linear amplification of the slope.
2. Bump `K_INACTIVITY_BOOST_MAX` (currently 20.0 ELO) -- raises the ceiling for very long absences.
3. Move from linear to a saturating curve (`tanh` or `1 - exp(-rate * days)` * cap) -- only if the linear cap proves wrong-shaped.
4. **Last resort:** full Glicko-2 RD migration. Cambridge's Figure 2 says defaults are usually near-optimal; only justified if (1)-(3) demonstrably fail.

All four levers are tunable without a schema bump.

## Source files

- `scripts/elo.py` (k_factor signature, compute_elo loop, _parse_match_date helper)
- `_validation/default_pre_kboost/` -- snapshot of canonical validator output BEFORE the K-boost change
- `_validation/default/` -- canonical validator output WITH the K-boost active
- `_validation/_inspect_kboost.py` -- audit script (regenerable)
- This memo
