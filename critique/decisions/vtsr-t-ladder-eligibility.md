# VTSR-T ranked-ladder eligibility (decision memo)

Status: **RATIFIED** (2026-09-19). Display-only. Ratings, K, and match
history are unchanged. `ELO_SCHEMA_VERSION` is deliberately **not**
bumped (additive display fields; published `vtsr` stays comparable).

## Decision

A player occupies a ranked `#` on the VTSR-T ladder (ELO page, dashboard
teaser top-5, player-page career rank) when:

```
matches_played >= ELO_LADDER_MIN_MATCHES    (25)
```

Everyone else stays visible in a single **Unranked** table (no rank
numbers). The existing `?` Provisional badge (`matches_played < 10`,
`ELO_PROVISIONAL_THRESHOLD`) is independent of the ranked bar — a
12-match player has a real tier badge and is still Unranked.

## Why 25

Same veteran bar as VTSR-C's older path. At ratification the corpus had
43 rated players and 20 cleared 25. Closest misses: mort (24) and blue
(23) — they enter on the next games.

The 10-match `?` stays where it is. That badge means "rating still
moving fast." Occupying a `#` is a different claim (enough games to
stand in a numbered list).

## Frozen parameters (changing any of these needs a new memo)

| Parameter | Value | Rationale |
|---|---|---|
| `ELO_LADDER_MIN_MATCHES` | 25 | Veteran ranked bar. Same number as VTSR-C's older path. |
| `ELO_PROVISIONAL_THRESHOLD` | 10 | Unchanged. `?` badge only. |
| Eligibility | display-only flag | Does not change `vtsr`, K, or match history. Tools / Balonce still consume the rating. |
| Unranked UI | one table, unnumbered | Provisionals and the 10–24 band together. Progress chip shows `{n} matches` (tooltip: `{n} of 25 rated matches to join the ranked ladder`). Do **not** print `/ 25` on every chip. |
| Schema | no bump | Additive fields: per-rating `leaderboard_eligible`; top-level `leaderboard_min_matches`. Pre-change `vtsr` / `peak_vtsr` remain comparable. |

## Do not retune to chase a name

Do not lower 25 to 24 or 20 to keep a favorite ranked. mort and blue
enter as soon as they play the remaining games. Revisit the bar only
if the league itself changes what "veteran" means.

## Consumers

- `/elo` (default VTSR-T pane) — ranked table + Unranked table
- Dashboard VTSR-T teaser — top 5 **eligible** only (muted provisional
  chips stay about the `?` badge, not the ranked bar)
- Player-page career rank — `#N of M` among eligible; unranked players
  show `Unranked` + the match-count chip, never a vanity rank
