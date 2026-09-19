# VTSR-C ranked-ladder eligibility (decision memo)

Status: **RATIFIED** (2026-09-19). Display-only. Ratings, K, and duel
history are unchanged. `CMDR_ELO_SCHEMA_VERSION 3 -> 4` is an additive
signal for the new fields, not a re-rate.

## Decision

A commander occupies a ranked `#` on the VTSR-C ladder (ELO page,
dashboard cohort top-5, player-page rank) when:

```
duels_with_telemetry >= CMDR_LADDER_MIN_V4        (8)
    OR
duels_non_v4         >= CMDR_LADDER_MIN_NON_V4    (25)
```

`duels_non_v4` = `matches_commanded_rated − duels_with_telemetry` =
F9 ledger duels + pre-v4 corpus telemetry. Everyone else stays
visible in a single **Unranked** table (no rank numbers). The existing
`provisional` badge (`< 5` rated games) is unchanged.

## Why these numbers

The live v4 telemetry corpus is small (43 duels at ratification). Only
two commanders clear 10 v4 games (mort 15, F9bomber 11); Vivify sits
at 8. The v4 bar is therefore **8**, not 10–15, so current-era regulars
are not locked out while the collector sample grows.

The older bar is **25** because F9 / pre-v4 games are noisier (no
economy telemetry, mixed eras, ledger provenance). A veteran F9-heavy
career still qualifies; a 2-game ledger spike (F9mama) does not.

The gate is an OR so a new-era commander does not need a pre-v4
resume, and a retired veteran does not need eight v4 games they will
never play.

## Frozen parameters (changing any of these needs a new memo)

| Parameter | Value | Rationale |
|---|---|---|
| `CMDR_LADDER_MIN_V4` | 8 | Current-era sample; raise later only with a larger v4 corpus, not to chase a name. |
| `CMDR_LADDER_MIN_NON_V4` | 25 | Veteran path. F9 **counts** — excluding it empties the path (nobody has 25 pre-v4 *telemetry* alone). |
| Eligibility | display-only flag | Does not change `vtsr_c`, K, W/L, or duel history. Tools / Balonce still consume the rating. |
| Unranked UI | one table, unnumbered | Provisionals and below-threshold together. `?` badge stays on `< 5` games. Progress chip shows `v4 / 8 · older / 25`. |
| Schema | `CMDR_ELO_SCHEMA_VERSION 3 -> 4` | Additive fields: per-rating `duels_non_v4` + `leaderboard_eligible`; top-level `leaderboard_min_v4` + `leaderboard_min_non_v4`. Pre-v4 `vtsr_c` values remain comparable. |

## Do not retune to chase a name

Snake (23 older) and Cyber (2 v4 / 17 older) miss the gate today and
enter as soon as they hit either bar. Do not lower 25 to 20 or 8 to 6
to keep a favorite ranked. Revisit the mins only when the v4 corpus
grows enough that a higher v4 bar is honest.

## Consumers

- `/elo?tab=vtsr-c` — ranked table + Unranked table
- Dashboard Commander Cohort VTSR-C strip — top 5 **eligible** only
- Player-page Commander Rivalries — `#N of M` among eligible; unranked
  players show `Unranked` + the progress chip, never a vanity rank
