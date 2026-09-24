# VTSR-T/C inactivity threshold (decision memo)

Status: **RATIFIED** (2026-09-19). Amended 2026-09-24: the shared
global window is 90 days (was 30). Display-only. Ratings, K, and match
history are unchanged. `ELO_SCHEMA_VERSION` is deliberately **not**
bumped. `CMDR_ELO_SCHEMA_VERSION 4 → 5` is an additive signal for the
new commander fields, not a re-rate. The 2026-09-24 window change is
not a schema bump either.

This is **not** the K-factor inactivity boost in `scripts/elo.py`
(`K_INACTIVITY_BOOST_*`). That still scales returning-player K. This
memo only flips who occupies a ranked `#`.

## Decision

Both ranked ladders already defer to a pipeline `leaderboard_eligible`
flag. Folding activity into that flag auto-moves idle players into the
existing **Unranked** tables. Frontend work is labeling *why*.

### Global activity clock (both ladders)

A player is active if they appear in **any** corpus match (thug or
commander, rated or not, including campod / cancelled / short games)
**or** in an F9 ledger duel (commanders and thugs). The clock is
measured against the newest **corpus** match (`corpus_latest_date`),
not wall-clock and not the newest F9 row.

```
idle > INACTIVITY_WINDOW_DAYS (90) from corpus_latest  →  Unranked
```

Playing again does **not** restore rank on the first game. The player
stays Unranked, labeled `Returning · N of 3`, until
`COMEBACK_GAMES_REQUIRED` (3) games since the gap, then rejoins.
Playing also resets the 90-day window.

A brand-new player who never had a >90-day gap is never caught by the
comeback rule — the existing 25-match / duel-count gate governs them.

### VTSR-C commander grace (second clock, VTSR-C only)

A player who commands regularly then stops commanding *while remaining
active as a thug* keeps their commander rank for
`CMDR_STALE_WINDOW_DAYS` (90) from their last command game. Past 90
days without commanding, VTSR-C drops to Unranked (`Not commanded · Nd`)
and they must **command** 3 games to re-rank. VTSR-T is unaffected.

A "command game" is any match where the player leads a team
(`is_commander` / `team_leaders`) **or** occupies an F9
`commanders.{1,2}` slot — not restricted to rated VTSR-C duels. F9
command games count toward the 3-game comeback. The comeback is
necessarily commander games: a still-thugging player is always
playing, so "3 games" can only mean commanding again.

The command streak also resets when an intervening >90-day **global**
gap sits between two command games (a player who quit entirely and
returned must re-command, not just resume). The reset threshold is the
global window, so it moved with the 2026-09-24 amendment.

### Composition

```
VTSR-T ranked  ⇔  matches_played >= 25
                 AND inactive_status == "active"

VTSR-C ranked  ⇔  (duels_with_telemetry >= 8  OR  duels_non_v4 >= 25)
                 AND inactive_status == "active"
                 AND command_status == "active"
```

Whichever clock fires first drops VTSR-C. Global inactivity (>90d,
stopped playing) and command staleness (>90d, still thugging) are
independent reasons. The day counts match; the events do not.

## Why

A numbered ladder that lists people who have not shown up in a quarter
reads as a graveyard, not a ranking. A month was too short: missing a
few sessions while the rest of the league kept playing dropped an
otherwise current player. Three games is enough to prove the return is
real without making a one-off drop-in look ranked.

The commander grace exists because commanding is a different job.
Staying active as a thug should not preserve a commander `#`
indefinitely — 90 days without a command game is the same quarter, not
a lifetime lock. The comeback must be command games for the same
reason.

This is **not** a rating penalty. Tools / Balonce / player-page tiers
still consume the rating. Only the ranked `#` moves.

## Frozen parameters (changing any of these needs a new memo)

| Parameter | Value | Rationale |
|---|---|---|
| `INACTIVITY_WINDOW_DAYS` | 90 | One quarter vs newest corpus match, not wall-clock. Amended 2026-09-24 (was 30). |
| `COMEBACK_GAMES_REQUIRED` | 3 | Prove the return; not instant on game 1. |
| Appearance | corpus `leaderboard[]` **or** F9 duel (commanders + thugs) | Campod / cancelled / short still count as "showed up". Dual recordings of one `match.id` count once. F9 rows use the `f9:<row>` sentinel. |
| `CMDR_STALE_WINDOW_DAYS` | 90 | Same quarter, different event: last command game, not last appearance. Thug activity does not preserve command rank forever. |
| Command appearance | `is_commander` / `team_leaders` **or** F9 `commanders.{1,2}` | Any lead, not only rated VTSR-C duels. |
| Command comeback | 3 command games | A still-thugging player is always playing. |
| Eligibility | display-only flag | Does not change `vtsr` / `vtsr_c`, K, or history. |
| VTSR-T schema | no bump | Additive fields. Pre-change `vtsr` / `peak_vtsr` remain comparable. |
| VTSR-C schema | `CMDR_ELO_SCHEMA_VERSION 4 → 5` | Additive fields. Pre-change `vtsr_c` remains comparable. |

## Do not retune to chase a name

Do not shrink 90 to 60 or stretch it to 120 to keep a favorite ranked,
and do not drop the comeback to 1 because someone is almost back.
Revisit the windows only if the league's session cadence itself
changes.

## Amendment (2026-09-24) — global window 30 → 90

The 2026-09-19 ratification set the shared appearance clock at 30 days
and described the 90-day command grace as three of those windows. League
cadence made a month too harsh: a player can miss a few sessions while
others keep playing and fall off a numbered `#` they still belong on.
The shared clock is now one quarter, the same length as the command
grace. The two clocks stay separate constants because they still watch
different events (any appearance vs a command game). The command-streak
reset uses the global window, so that threshold moved 30 → 90 with it.
Comeback stays 3 games. This is not a rescue of any named player.

## Implementation notes

- Helper: `scripts/inactivity.py` `compute_activity(..., external_duels=)`.
  Keyed by steam64 with a `name.lower()` fallback. **Lookup miss /
  never seen → inactive** (and command `stale`). Absence is not a
  free pass onto the ranked table. Empty `last_seen_date` /
  `last_command_date`; UI labels `Inactive` without `· 0d ago`.
- F9 gated `duels[]` (commanders **and** thugs) fold into both clocks.
  Overlaps stay out of that list and are covered by corpus rows.
  `scripts/elo.py` still does not *rate* F9; display-only consumption.
  Never-commanded thugs who *were* seen keep `command_status: "active"`
  so VTSR-T players are not fake-stale.
- Proof of rating-inertness: `elo_history.json` byte-identical after
  the change; `elo_commander_history.json` `duels[]` unchanged. Only
  `elo_current.json` / `elo_commander_current.json` gain fields and
  flip `leaderboard_eligible`.
- Out of scope: Tools resolver and player-profile **tier** display
  still show the rating (correct for lobby balancing). An Inactive
  hint on those surfaces is a possible follow-up.

## Consumers

- `/elo` — Unranked chips `Inactive · Nd ago` / `Returning · N of 3`
  (VTSR-C also `Not commanded · Nd` / `Returning · N of 3 cmdr games`).
  Never-seen rows: `Inactive` with no `· 0d ago`.
- Dashboard VTSR-T teaser — idle established players as an
  `Inactive (unranked)` chip row beside Provisional
- Player-page career / commander rank — already reads
  `leaderboard_eligible`; chips pick up the new labels
