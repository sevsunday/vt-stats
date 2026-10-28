# VTSR-2v2: separate 2v2 ladders (decision memo)

Status: **RATIFIED** (2026-10-27), **amended the same day** (below).
New ladder family, own module
(`scripts/elo_2v2.py`), own files (`data/processed/elo_2v2_current.json`
+ `elo_2v2_history.json`), own `ELO_2V2_SCHEMA_VERSION` (now 2). VTSR-T,
VTSR-C and VTSR-1v1 are untouched and must stay byte-identical (gate:
`_investigation/check_2v2_separation.py`).

Three ratings:

- **VTSR-2v2C** — commander rating, win/loss.
- **VTSR-2v2T (win/loss)** — thug rating, win/loss, in the same walk as
  2v2C.
- **VTSR-2v2T (performance)** — thug rating from a thug-vs-thug damage
  duel, recorded games only.

Both thug ratings are published side by side for a comparison period
(operator decision, 2026-10-27). The rule for picking one is
pre-registered below.

## Amendment (2026-10-27): recorded games only

Operator decision: F9bomber's 2v2 rows are removed from every 2v2
ladder. `data/external/f9_ledger_2v2.json`, the importer's 2v2 pass and
`scripts/study_2v2_transfer.py` are deleted; `scripts/import_f9_ledger.py`
is back to its pre-2v2 form, so `f9_ledger.json` and the VTSR-C ladder
are unaffected. The win/loss walk drops from 71 games (8 recorded + 63
F9) to the 8 recorded ones, and the activity clock reads the recorded
corpus only, as VTSR-1v1 does. `ELO_2V2_SCHEMA_VERSION` 1 -> 2 (fields
removed: `games_recorded` / `games_f9` per row, `wl_games_recorded` /
`wl_games_f9` / `skipped_f9_*` in the header, `f9_row` per game);
ratings are not comparable with schema 1. The math, the pick-one rule
and its 30-game threshold are unchanged. Struck text below is kept for
the record.

## Why separate ladders

A 2v2 is two commanders, each with one thug. VTSR-T z-scores a player's
enemy-damage share across the lobby; with four rows that spread is noise
(`elo/analysis` §10), and `scripts/elo.py` already drops every 2v2 as
`low_player_count`. VTSR-C only rates matches VTSR-T kept, so it drops
them too. A 2v2 ladder therefore cannot double-count, and it must never
feed back into either main ladder.

## The format lines (`scripts/match_format.py`)

Shape = non-campod leaderboard rows per side (slots 1-5 / 6-10), the
count the main ladders' six-player gate has always used. Camera-pod
spectators never count as a side.

| Format | Shape | Ladder |
|---|---|---|
| `1v1` | 1 and 1 | VTSR-1v1 |
| `2v2` | 2 and 2, commander row present on each side, all 4 active | VTSR-2v2 |
| `team` | at least 3 per side and at least 6 in total | VTSR-T, then VTSR-C |
| `other` | anything else (2v1, 3v1, 3v2, 4v2, 1v0, inactive 2v2) | none |

"Active" for a 2v2 means no row is `is_low_activity` and no thug is
`is_zero_damage`. A 2v2 whose thug disconnected or idled is really a
2v1 and is not rated (`2026-09-29T04-06-06` is the one case today).

**Main-ladder amendment (3 per side).** `scripts/elo.py` gains
`ELO_MIN_PER_SIDE = 3` and the exclusion reason `short_side`, tested
after `low_player_count`. On 2026-10-27 no rated match has a side below
3 (the shapes are 5v5, 4v4, 3v3, 5v4, 4v3), so no rating moves and
`elo_history.json` is byte-identical. `ELO_SCHEMA_VERSION` is not
bumped, following the inert-change precedent. If a 4v2 or 5v1 is ever
recorded, it is unrated by every ladder.

## Eligible games

**Win/loss walk (2v2C + 2v2T win/loss):**

1. a recorded strict 2v2 (above), not void, `duration_sec >= 240`,
   `winner.decided_by` in `adjudicated / attested / clean_win /
   contested` with `winner.team` in (1, 2), or `draw` (0.5 each);
2. ~~or a row from `data/external/f9_ledger_2v2.json`: F9bomber's sheet
   rows with one thug per side, passing every gate the 3v3+ importer
   applies (rosters, commander parse, stragglers, winner is a
   commander, duration >= 240 s, exact-duplicate drop, excluded names)
   and not dual-recorded in our corpus.~~ Removed by the amendment.

**Performance duel (2v2T performance):** a recorded strict 2v2, not
void, not cancelled, `duration_sec >= 240`. It needs no winner, so an
undecided game still rates. Skipped when both thugs dealt 0.

Dual recordings that share one match id rate once.

## Math (frozen)

**Joint win/loss walk.** One win chance per game:

`E1 = 1 / (1 + 10^(-((C1 - C2) + λ(T1 - T2)) / 400))`, `λ = 1.0`

where `C` is VTSR-2v2C and `T` is VTSR-2v2T (win/loss). This is
VTSR-C's formula with the thug term drawn from the 2v2 thug ladder.
`S` is 1 / 0 / 0.5. Updates: `ΔC = Kc (S - E)`, `ΔT = Kt (S - E)`.

**Performance duel.** `S_A = e_A / (e_A + e_B)` with
`e = personal.enemy_dealt` (VTSR-T's own single axis),
`E_A = 1 / (1 + 10^(-(R_A - R_B) / 400))`, `ΔR_A = K (S_A - E_A)`.

| Parameter | Value |
|---|---|
| Anchor | 1500 |
| K | 40 -> 20, linear over the first 5 rated games, per ladder |
| K per game | one K per role per game: the mean of both players' scheduled K, so each role is zero-sum |
| Logistic scale | 400 (all three) |
| Floor | none |
| Seeding | none; everyone starts at the anchor |
| Provisional | fewer than 5 games in that ladder |
| Order | chronological (~~F9 rows after same-day recorded games, sheet-row order~~) |

Each recorded game also stores, recorded but not scored, each
commander's share of the side's enemy damage (2v2 commanders fight
heavily) and both thugs' performance score, for later study.

**Display.** All three ratings show numbers, like VTSR-1v1. The rule
that VTSR-T is never a number belongs to the main thug ladder; these are
separate experimental ladders and comparing two thug ratings needs the
numbers. Ranked `#` = at least 5 games in that ladder AND active on the
90-day global clock (`scripts/inactivity.py`, recorded corpus only since
the amendment; ~~F9 appearances included~~).
Do not lower the bar to fill the table.

## Consumers

Allowed: `js/elo.js` (2v2 pill), `js/vtsr-explainers.js` (How tab),
`js/player.js` (2v2 block), `js/match-elo.js` (per-match card),
`js/balonce-meter.js` (Outcome card on 2v2 matches — a deliberate
difference from the 1v1 rule, which keeps the meter off 1v1 data),
`js/tools/*` (Balonce 2v2 mode).

Forbidden: `scripts/elo.py`, `scripts/elo_commander.py`,
`scripts/elo_1v1.py`, `js/all-matches-aggregator.js`,
`js/players-tab.js`.

## Pick-one rule for the thug rating (pre-registered)

Reopen when the recorded corpus holds at least 30 strict 2v2s with a
determined winner. Replay the joint win/loss walk twice, once with each
thug variant as `T` (the performance variant's own ratings, the
commander ladder updated as normal), and score each on the recorded
games only:

1. out-of-sample log-loss of the winner (chronological, pre-match
   ratings), and
2. split-half self-consistency of the thug ranking (Spearman between
   odd and even games).

A variant wins if it improves log-loss by at least 0.01 AND its
split-half ρ is not lower by more than 0.05. If neither wins, keep
both. Do not retune λ, K or the scale to produce a winner.

## Evidence (2026-10-27, historical)

Measured before the amendment, from `scripts/study_2v2_transfer.py`
(since deleted with the F9 2v2 ledger, so these figures can no longer
be rerun) and validator §23. The "2v2 ladders' own call" row describes
the F9-seeded ladders that no longer exist; on the recorded-only
ladders §23 now reports 56% of 8 games. Main-ladder ratings are each player's last rating
strictly before the game; a formula is unscored when a rating is
missing. Samples are small and every interval is wide.

| Formula | Recorded (n) | F9 (n) | All (n) |
|---|---|---|---|
| VTSR-C gap alone | 62.5% (8) | **75.0% (52)**, CI 62-85% | 73.3% (60) |
| VTSR-C + thug VTSR-T gap, λ = 1 | 50.0% (8) | 71.4% (7) | 60.0% (15) |
| VTSR-C + thug VTSR-T gap, λ = 1.5 | 50.0% (8) | 42.9% (7) | 46.7% (15) |
| VTSR-C + team-mean VTSR-T, λ = 0.5 | 62.5% (8) | 100% (6) | 78.6% (14) |
| Team-sum VTSR-T | 62.5% (8) | 50.0% (6) | 57.1% (14) |
| The 2v2 ladders' own call | 62.5% (8) | 65.1% (63) | 64.8% (71) |

What this says:

1. **Commander skill transfers.** The main VTSR-C gap called F9's 2v2
   winners 75% of the time, better than the 2v2 ladder's own calls
   (65%), which start every player at 1500. The 2v2C ladder is still
   kept separate as decided; its early calls are coin flips by
   construction.
2. **The main thug rating does not transfer.** Adding the thugs'
   VTSR-T gap gets worse as λ grows (60% at λ = 1, 47% at λ = 1.5).
   VTSR-T measures share of a big lobby's damage; one thug's share of a
   four-player game is a different job. This is why the 2v2 handicap
   uses the 2v2 thug ladder, not VTSR-T.
3. **Commanders fight.** On the 8 recorded games a commander dealt
   30-55% of the side's enemy damage, so a thug's damage share is
   shared with someone who is also fighting. That is recorded per game
   (`combat_share`), not scored.
4. **The two thug ratings disagree.** 10 thugs are rated on both;
   Spearman between the performance and win/loss ratings is 0.35.
   That is the comparison the pick-one rule will settle.

**Follow-up candidate (not adopted):** seed a new player's 2v2C from
their VTSR-C. Point 1 is the case for it. Adopting it would change the
frozen math, so it needs its own memo with a pre-registered test on
games after the adoption date.
