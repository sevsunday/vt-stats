# Reconstructed accuracy axis (pre-registered)

## TL;DR

`thug_accuracy` left the VTSR-T composite in v2.12 (`ELO_SCHEMA_VERSION` 16). The collector's `BulletHit` gate requires both the shooter and the victim to be players, so rounds into extractors were scored as misses. Sign agreement on determined matches was 39.5% (Wilson CI entirely below a coin flip).

The pipeline now reconstructs those hits from `DamageDealt` (`hits_est`). This memo registers the only rule under which that reconstruction may become a rating axis again. It was written before the candidate section in `scripts/validate_elo.py` is treated as evidence.

Registered: 2026-10-11. Append-only from here.

## The candidate

Weapon-normalized hit rate on `weapon_breakdown[w].hits_est`, lobby z-scored, same shape as the retired `_thug_accuracy_lobby`. Every reconstructed hit counts at full weight. There is no `ALPHA_PVE` on this candidate: a hit is a hit, and target choice stays on `pve_share`.

Display surfaces may show `accuracy_est` whether or not this axis is ever scored.

## Promote rule

Re-admit the axis at raw weight 0.15 (renormalized with the five live axes) only when all three hold on the same run:

1. Sign agreement of the winner-team mean z versus the loser-team mean z has a Wilson lower bound above 0.50, on at least 150 determined matches.
2. Adding the axis at 0.15 does not lower clean-win hard-max accuracy by more than 1 percentage point.
3. Spearman correlation of the rating with the no-accuracy rating stays within −0.01.

Otherwise the axis stays display-only. Re-evaluate after 50 additional determined matches. Do not retune the weight, the hit formula, or the clauses to chase a result.

`scripts/validate_elo.py` §21 reports clause 1 and a within-match blend at weight `0.15/0.91`. Clauses 2 and 3 need a dedicated re-rate. A HOLD from §21 is not a failed re-rate; it means clause 1 has not cleared, so clauses 2 and 3 are not yet worth running.

## Results

First run, 2026-10-11, after the v2.12 reprocess (188 determined matches with `hits_est`):

- Sign agreement 53.7%, Wilson CI 46.6–60.7%. Lower bound is under 0.50.
- Ablation blend sign agreement 91.5% (the stored performance already agrees most of the time; this is not the clean-win hard-max clause).
- Verdict: **HOLD**. The axis stays display-only.
