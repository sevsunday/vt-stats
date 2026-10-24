# VTSR-1v1: a separate 1v1 Elo ladder (decision memo)

Status: **RATIFIED** (2026-10-24). New ladder, own module
(`scripts/elo_1v1.py`), own files (`data/processed/elo_1v1_current.json`
+ `elo_1v1_history.json`), own `ELO_1V1_SCHEMA_VERSION = 1`. VTSR-T and
VTSR-C are untouched and must stay byte-identical (gate:
`_investigation/check_1v1_separation.py`).

## Why a separate ladder

A 1v1 is two commanders and nothing else. VTSR-T rates thug
performance against a lobby and needs at least six players; VTSR-C
rates the commander duel inside a team game and carries a thug
team-strength handicap. Neither fits a head-to-head game, and both
already drop it: `scripts/elo.py` excludes every 1v1 as
`low_player_count`, and `scripts/elo_commander.py` only rates matches
VTSR-T kept. So a 1v1 ladder cannot double-count, and it must never
feed back into either rating.

## Eligible games (recorded corpus only)

A match is rated when ALL of these hold:

1. not `match.void`;
2. exactly one leaderboard row per side with `is_campod` false
   (slots 1-5 = side 1, 6-10 = side 2). Camera-pod spectators never
   count as a side;
3. `match.duration_sec >= 240` (`ONE_V_ONE_MIN_DURATION_SEC`, the same
   bar as the other ladders);
4. `winner.decided_by` in `adjudicated / attested / clean_win /
   contested` with `winner.team` in (1, 2) — or `draw`, which scores
   0.5 for both. Unclear and cancelled games are skipped and counted.

A low-activity row does not void the game: the outcome is the label.
A dual recording that shares one match id rates once
(`skipped_duplicate_recording`).

## Math (frozen)

| Parameter | Value |
|---|---|
| Expected score | `E = 1 / (1 + 10^(-(Ra - Rb) / 400))` |
| Anchor | 1500 |
| K | 40 -> 20, linear over the first 5 rated games, symmetric |
| Floor | none |
| Provisional | fewer than 5 rated games |
| Handicap | none (no thugs) |
| Factions | recorded for display only; no faction term (the Phase 6 memo has not been promoted) |
| Order | chronological by `match.date` |

Zero-sum: both players' deltas use their own K, so a pair at different
K values does not sum to exactly zero. **Amendment to the plan text:**
to keep every game zero-sum, both sides use the SAME K per game — the
mean of the two players' scheduled K values. The separation gate checks
that each game's deltas sum to 0.

## Who gets a rank (display only)

`leaderboard_eligible` = at least `ONE_V_ONE_LADDER_MIN_GAMES` (5) rated
1v1s AND active on the shared 90-day global clock
(`scripts/inactivity.py`, any appearance in the recorded corpus).
Everyone else sits in one unnumbered Unranked table. Ratings, K and
history are unaffected.

Ranks will be sparse at first (on 2026-10-24 only one player clears 5
rated 1v1s). **Do not lower the bar to fill the table.** Revisit only
when the recorded 1v1 sample is several times larger.

## F9bomber's spreadsheet is excluded

The operator rule: include an F9 row only if it can be proven a 1v1.
None can.

- **Before January 2025 no row has a roster.** All 307 rows from
  2024-03 to 2024-12 list only "A vs B" commanders, so a 1v1 and a team
  game look identical. Rosters begin at sheet row 309 (2 January 2025).
- **The later roster-less rows cannot be confirmed.** From 2025 on,
  about 19 rows still lack a roster. Row 1144 (24 April 2026) sits
  among roster-logged team games on the same night. Rows 1287-1288
  (14 August 2026) have no game time. None matches a recorded 1v1.
- **The sheet does not track 1v1s consistently.** All six recorded
  1v1s from April and May 2026 are absent from it, although team games
  on those dates were logged.

`scripts/elo_1v1.py` therefore reads nothing under `data/external/`.
If F9bomber later records an explicit game size, a new memo can admit
those rows.

## Starting sample (2026-10-24)

17 recorded true 1v1s: 11 with a decided winner (10 attested, 1 clean
win), 5 unclear, 1 cancelled; about 10 players. Three unclear games
(Giza 532 s, Terron 1310 s, Remnant 1295 s) can be rated after operator
sign-off with `python scripts/process_stats.py --adjudicate-all`. The
two Mojave games (223 s, 227 s) are under 240 s and stay out.

## Consumers

- `/elo?tab=1v1` — Ranked + Unranked tables with per-player game logs
- How-it-works tab — "The 1v1 ladder" section
- Player profile — 1v1 block (self-hides without a rated 1v1)
- Per-match Elo tab — 1v1 strip on rated 1v1 matches

Forbidden consumers: `scripts/elo.py`, `scripts/elo_commander.py`,
`js/all-matches-aggregator.js`, `js/balonce-meter.js`.
