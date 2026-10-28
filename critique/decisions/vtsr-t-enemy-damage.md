# VTSR-T enemy-damage refactor -- decision memo

## TL;DR

VTSR-T may move from the v2.13 four-axis composite (net damage share, thug kill rate, PvE share, mobility) to a single enemy-damage axis. This memo fixes the rule that decides it, the candidates, and their order, before the harness runs on the reprocessed corpus. The rule favours the simplest measure that is no worse at predicting winners and at least as consistent, because the outcome data on this corpus cannot tell any of the formulas apart.

Registered: 2026-10-24. Append-only from here. Results go in the Results section below.

## What was already seen

This is not a blind pre-registration. An exploratory read-only analysis on 2026-10-23 replayed `compute_elo` in memory for ten variants and decoded the raw damage events. These numbers motivated the rule and were seen before it was written:

- No variant predicted the winner from the thugs' pre-match ratings: AUC 0.51-0.54 on 186 decided matches after a 40-match warm-up. Every paired-bootstrap difference against today spanned zero. The outcome-only wins ladder scored 0.508. Even the top quartile of rating gaps picked the winner only 45% of the time (n = 47).
- Split-half reliability of the per-match score: today 0.883; enemy damage dealt only 0.952; enemy net damage only 0.900.
- Today's scorer pays about 2x for damage to AI compared with damage to players (through `pve_share`). A scav kill scores 1.21x a tank kill. Only the bare PvE kill count is halved.
- 16% of `pve_dealt` was not enemy damage (friendly AI and buildings, loose scrap, props). Match schema 33 now records the enemy side separately.
- In the first 5-15 minutes, PvE damage predicted the winner about as strongly per unit as PvP damage (ratio roughly 0.7-1.5). Whole-match building damage reached AUC 0.95 because the winners demolish the base at the end.
- Kill rate correlated 0.72 with damage dealt; mobility 0.62. About 6.5% of ship losses produce no kill or death.

The exploratory run used enemy-only damage rebuilt from the raw events. The harness reads the pipeline's own schema-33 fields, so its numbers will differ slightly.

## Candidates, in order of simplicity

All candidates use `personal.enemy_dealt` / `enemy_received` (schema 33), z-scored in the lobby and clipped like every other axis. Commander rows get the usual shrunk commander shift on the new axis (seeded at -0.131, the v17 net-damage prior). The v2.8 low-tier lift is left as it stands during the comparison (it adjusts `thug_kill_rate`, so it is inert for single-axis candidates).

1. **Enemy damage dealt only** (`enemy_damage_share`): the player's share of the lobby's enemy damage.
2. **Enemy net damage only** (`enemy_net_damage_share`): (enemy damage dealt - enemy damage taken) / lobby enemy damage.
3. **Enemy net damage + kill rate**, 0.5 / 0.5, with `ALPHA_PVE` = 1 (PvE kills count the same as player kills).

Control: today's v17 composite, frozen in `scripts/vtsr_t_variants.py` (`V17`).

## Late building damage

`enemy_structure_dealt_late` is building damage in the last 180 s of a match. If it is **more than 10% of the winning team's enemy damage**, summed over decided rated matches, every candidate uses the trimmed definition (that damage removed). Otherwise none does. The trimmed variants are reported either way.

## The rule

Metrics are computed by `scripts/vtsr_t_variants.py` on decided matches (winner team 1 or 2, `decided_by` in adjudicated / attested / clean_win / contested) after the first 40, using each variant's own pre-match ratings:

- **AUC**: thug-mean rating gap (commanders excluded) against the winner. Paired bootstrap of the difference against the control: 2000 resamples, seed 20261024.
- **Gain over commanders**: log-likelihood gained by adding the thug gap to the commanders' VTSR-C gap in a no-intercept logistic.
- **Reliability**: split-half reliability (Spearman-Brown) of the per-match performance score over thug rows, for players with at least 16 thug matches, odd vs even matches in date order.

Walk the candidates in the order above and **promote the first one that passes all three**:

1. Its 95% bootstrap lower bound on the AUC difference is at least **-0.05**.
2. Its gain over commanders is at least the control's **minus 0.5**.
3. Its reliability is **at least the control's**.

If none passes, VTSR-T stays as it is and this memo records why.

## Forward check

After shipping, once at least **40 decided matches** dated after the ship date exist, run `python scripts/vtsr_t_variants.py --since <ship date>`. If the shipped rating's AUC on those matches is **more than 0.05 below** the v17 replay's, revert to v17.

## What ships if a candidate is promoted

- `THUG_WEIGHTS` becomes the promoted axis alone. The old axis functions stay in `scripts/elo.py`, uncalled, so the control stays reproducible.
- `COMMANDER_AXIS_PRIOR` gets one entry for the promoted axis, seeded from the observed commander running mean reported by the harness, shrinkage 30. The locked `pve_share` prior goes.
- The low-tier at-base lift moves to the promoted axis, measured over effective in-ship time.
- `ELO_SCHEMA_VERSION` 17 -> 18. The corpus is re-rated; pre-v18 `peak_vtsr` is not comparable.
- VTSR-C, the wins ladder (ALPHA stays 0) and every non-rating surface are unchanged.

## Results

### Run 2026-10-24 (pipeline v57, match schema 33, 299 matches)

`python scripts/vtsr_t_variants.py`. Fidelity: the module-default replay equals the published `elo_current.json` (max |d| 0.0, 47 players). Evaluation set: 191 decided matches after the first 40.

| Variant | AUC | AUC diff vs today [95% CI] | Gain over commanders | Split-half reliability | Top-quartile accuracy |
|---|---|---|---|---|---|
| Today (v17) | 0.527 | control | 1.34 | 0.878 | 0.458 (n=48) |
| Enemy damage dealt only | 0.527 | -0.000 [-0.034, +0.033] | 1.65 | 0.951 | 0.521 |
| Enemy net damage only | 0.537 | +0.009 [-0.022, +0.038] | 1.88 | 0.896 | 0.542 |
| Enemy net damage + kill rate | 0.525 | -0.002 [-0.024, +0.019] | 1.06 | 0.881 | 0.479 |
| Enemy damage dealt only, trimmed | 0.508 | -0.019 [-0.060, +0.020] | 1.37 | 0.978 | 0.562 |
| Enemy net damage only, trimmed | 0.529 | +0.002 [-0.032, +0.036] | 1.86 | 0.933 | 0.542 |
| Enemy net damage + kill rate, trimmed | 0.521 | -0.006 [-0.033, +0.023] | 1.10 | 0.904 | 0.479 |

Late building damage was **8.3%** of the winning team's enemy damage (1.4% for losers), under the 10% threshold, so the untrimmed definitions were judged.

**Verdict: promote enemy damage dealt only (`enemy_damage_share`).** It is first in the order and passes all three conditions: AUC lower bound -0.034 >= -0.05; gain over commanders 1.65 >= 1.34 - 0.5; reliability 0.951 >= 0.878. The other two candidates also passed; the rule takes the simplest.

Consequences recorded before shipping (27 players with at least 15 rated matches): Spearman 0.960 against today's ratings, mean |change| 75.7, max 300.3. The change correlates **-0.79** with a player's career PvE share of enemy damage: PvE-leaning players drop (DraconisMarch -146, Maverick -110, Totokomo -88) and high-volume players rise (VTrider +300, Domakus +190, Cloaket +160). Equal pay per point of enemy damage removes the PvE bonus `pve_share` carried; it does not raise PvE play. The single axis also spreads ratings wider than the four-axis average did.

Commander prior for the new axis: observed commander running mean **-0.171** over 508 commander rows (shrunk baseline -0.169). Shipped seed: -0.171.

### Scrap-denial study (2026-10-24)

`python scripts/study_pve_denial.py` on 144 rated matches with resource telemetry. Regen is 12.8 scrap per pool per minute on top of 31.4 scrap per minute of base regen. 1576 of 1591 extractor kills show the victim's pool count dropping within 3 s, and the victim team takes a median 93 s to get back to its previous count (311 never do before the match ends).

| Kill | Pool income denied over 2 min | over 5 min (upper bound) | Unit's own cost | Damage credit vs a tank under 1:1 pay |
|---|---|---|---|---|
| Extractor | 28 scrap (0.50x a tank) | 79 scrap (1.43x) | 20 | 5000 / 3500 HP = 1.43x |
| Scavenger | 8 scrap | 43 scrap (0.78x) | 20 | 3000 / 3500 HP = 0.86x |

Paying every point of enemy damage the same already credits these kills about in line with the scrap they cost the enemy. The study gives no case for a PvE premium above 1:1, so no follow-up memo proposes one. The 5-minute figures are upper bounds: control windows match on pool count and match minute only, and a team losing extractors is often losing the game.

### Shipped 2026-10-24

`ELO_SCHEMA_VERSION` 18. The module-default replay matches the published ratings (max |d| 0.0). Forward window: decided matches dated 2026-10-25 or later, `python scripts/vtsr_t_variants.py --since 2026-10-25`. Matches from 2026-10-24 were in the decision corpus and stay out of it.

### Amendment 2026-10-27 — laid mines count

Before match schema 35, a mine detonating as its own entity booked its damage to `asset_dealt`, so `enemy_dealt` missed it. The pipeline now credits that damage, and the kill, to the player who had flown a carrier of the mine. Both arms of the forward check read the corrected per-match JSON, so the comparison stays like-for-like. `ELO_SCHEMA_VERSION` 19. Measured drift against the v18 ratings, 48 players: max |Δ| 7.40, mean |Δ| 1.40, top-10 order unchanged.
