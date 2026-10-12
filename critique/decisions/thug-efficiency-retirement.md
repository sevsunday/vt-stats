# thug_efficiency retirement (v2.13)

## TL;DR

`thug_efficiency` leaves the VTSR-T composite in v2.13 (`ELO_SCHEMA_VERSION` 16 → 17). It was 0.16 of the raw weight sum 0.76, about 21% of the index. On 188 determined matches the winning side scored lower on it 61% of the time. The Wilson interval sits entirely below a coin flip, including on modern v4 matches where the formula is computed as designed.

This memo was written before the scorer change. It freezes the evidence so it survives once the axis leaves `elo_history.json`.

Registered: 2026-10-12. Append-only from here.

## The formula

`_thug_efficiency_lobby` in `scripts/elo.py`:

```
(pvp_dealt + 0.5 * (pve_dealt - structure_dealt)) / max(1, dealt - structure_dealt)
```

`0.5` is `ALPHA_PVE`. Structure damage was meant to be excluded from both sides so it would be credited only on `pve_share`. Mobile-AI damage counted at half in the numerator and in full in the denominator, so spending damage on scavengers lowered the ratio versus pure player damage.

The function stays in `scripts/elo.py` and is not called. There is no reconstruction that would flip the sign: v4 already computes this formula correctly. Do not re-admit it under `critique/decisions/accuracy-recon-axis.md`.

## Sign agreement

Team-mean of the winner minus team-mean of the loser. The stored validator figure is `latest_detail.axis_outcome` in `data/processed/validation_summary.json`, read from post-clip `axis_contributions` (the values that fed `P_i`):

- Pooled: **38.8%** on 188 matches. Wilson 95% CI **32.2–46.0%**. Mean gap **−0.069** in post-clip space.

A same-day recomputation of the raw lobby z (before clip-and-divide-by-2), same 188 lobbies, agrees on the rate and puts the mean raw-z gap at **−0.14**:

- v4 (`structure_dealt` is real): **38.6%** on 101 matches, CI **29.7–48.4%**.
- v1 (`structure_dealt` is always 0, so base damage dilutes the ratio): **26.8%** on 41 matches, CI **15.7–41.9%**.
- v2: **53.7%** on 41 matches, CI **38.7–67.9%**. Too small to call.

Within a lobby the ranking is unrelated to volume. Spearman versus net damage (dealt − received) is **−0.04**. Spearman versus damage dealt is **0.01**.

## Damage per minute stays out

Lobby z-scoring cancels the shared match clock, so damage per minute is damage dealt. On the same 188 matches that ranking agrees with the winner **88.3%** (CI 82.9–92.1%). Net damage share agrees **87.8%**. Within-lobby Spearman of the two is **0.886**. Using each rated player's presence window instead of the match clock does not change the damage-dealt ranking (Spearman 1.00). Net damage already carries the volume signal and also subtracts damage taken. A damage-per-minute axis would mostly retell it.

## What remains

Four axes. Raw weights sum to 0.60 and renormalize to net damage 33.3%, kill rate 33.3%, PvE share 20%, mobility 13.3%. `ALPHA_PVE` stays 0.5 and applies only to `thug_kill_rate`. The shrinking commander priors that remain are mobility, kill rate, and net damage. The locked `pve_share` prior stays. The `thug_efficiency` prior (−0.106) leaves with the axis. `pve_share` still credits every point of non-human damage. Pre-v17 `peak_vtsr` is not comparable.

## Results

Reprocess 2026-10-12 (47 players, schema 17, four weight keys). Max |ΔVTSR-T| 82.0 (dd 1497.9 → 1579.9). Mean |Δ| 22.7, mean signed +8.9. Spearman ρ of pre-match rating versus match performance fell from 0.412 to 0.275. Self-consistency fell from 0.787 to 0.672. Clean-win hard-max moved from 57.8% to 58.3%. Log-loss stayed 0.682. Synthetic-winner agreement stayed 92.0%. The four remaining axes agree with the winner at 88.8% / 87.8% / 85.4% / 78.7% (mobility, net damage, kill rate, PvE share).
