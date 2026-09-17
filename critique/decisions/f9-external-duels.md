# F9bomber external ledger -> VTSR-C (decision memo)

Status: **RATIFIED + SHIPPED** (2026-09-17). Operator sign-offs recorded
2026-09-13 (aliases, exclusions, gates, full K, headline-record
inclusion, match-level overlap semantics) in the planning thread;
implementation landed with `CMDR_ELO_SCHEMA_VERSION 2 -> 3`.

## Decision

F9bomber's hand-kept match ledger (`f9stats/f9stats-20260913.xlsx`,
sha256 `9e3b5812db200407...`) is imported ONCE by the standalone
`scripts/import_f9_ledger.py` into two committed artifacts
(`data/external/f9_ledger.json` + `f9_community.json`), and the ledger's
eligible duels enter the **published VTSR-C ladder** as first-class
externally-sourced duels. Community rollups (thug team records, faction
picks, map counts) ship as display-only surfaces. Nothing here touches
VTSR-T, the All Matches aggregator, `map_stats`, or picker-scoped
`faction_stats`.

## Why the outcomes are trusted

- The operator declared F9's outcomes **definitive** (active player,
  hand-logged at the table).
- Empirical check: every F9 row pairable to one of our DETERMINED
  telemetry matches (Steam64 commander pair + map + date +-1 day +
  roster Jaccard) agreed on the winner — **28/28, zero disagreements**.
  The single "disagreement" in an earlier analysis was a rematch-twin
  mispairing artifact, not a data error.

## Ratified parameters (frozen; changing any of these needs a new memo)

| Parameter | Value | Rationale |
|---|---|---|
| Eligibility | roster-complete, even 3v3/4v4/5v5, straggler-clean, winner is a commander, duration >= 240s, deduped | Operator spec. Even teams remove the man-advantage confound — the one confounder we can kill for free in a no-telemetry dataset. Stricter than our own 6-player telemetry gate on purpose. |
| Overlap policy | match-level: ours supersedes. Import-time pairing (date +-1 day for US-local vs UTC skew, map stem OR alias-resolved registry key, Steam64 commander pair, greedy Jaccard >= 0.4) + runtime guard in `compute_commander_elo` (consumed-ids exempt) | Dual-recorded games must never double-count; corpus-era games we simply failed to record stay in. |
| K | `k_factor(games) * CMDR_K_EXTERNAL_SCALE` with `CMDR_K_EXTERNAL_SCALE = 1.0` (full standard 40 -> 20 schedule) | Outcomes are definitive; lobbies pass stricter size gates; ELO self-corrects and recomputes from scratch every run. A discount would encode distrust of data we ratified as trustworthy. The constant exists so a future discount is a one-line retune. |
| Team handicap | real λ = 1.0 handicap from a running VTSR-T snapshot (`vtsr_t_now`, folded from `elo_history` deltas) over each side's resolved thugs; empty side -> term 0 | Pre-corpus duels see handicap 0 — structurally identical to our own earliest telemetry matches, where everyone sat at the anchor. Corpus-era externals (74) get live handicaps. |
| Chronology | day precision; same-day externals sort AFTER telemetry, sheet-row order within a day | F9 logs calendar days, not timestamps. Ordering slop within a day is bounded by K and washes out. Documented approximation. |
| Records | headline W-L-D and `matches_commanded_rated` INCLUDE externals; split surfaced via per-rating `duels_external` + ladder chip | Rating and record must tell the same story. `rated_match_count` stays telemetry-only; `external_duels_rated` counts the rest. |
| Provenance | per-duel `source: "f9" | "telemetry"`, `external_row`, `map`, `decided_by: "external"`; top-level `external_provider` | UI must never imply a community duel was recorded telemetry. |
| Identity | committed alias table `data/external/f9_name_map.json` (exact-normalized names only, never substring); unresolved commanders keyed `name:<name>` (auto-merge on later alias) | Sign-offs: Blue Banana=blue, Bylarge=The_Bylarge, DesUxS=DesUxSAsU, SaggiSponge=sponge, aggressor=Nomad, Muerte=mort, Gravey=Graves, X-Triage=Totokomo, Ultimate=tom. Excluded (participant anywhere -> row dropped): Lone, Mr.Scout, Croatian Knight, General BlackDragon, Systeme, RollyPolly, Jabbapop, Devastator. Scorpion + Echoblammo stay name-keyed. |
| Schema | `CMDR_ELO_SCHEMA_VERSION 2 -> 3`; pre-v3 `vtsr_c` / `peak_vtsr_c` values not comparable | Established re-rate signal pattern. |

## Shipped import (funnel, from the importer report)

1309 sheet rows -> 334 no-rosters, 192 uneven, 82 wrong-size, 1
straggler-contaminated, 4 winner-not-commander, 11 no-duration, 3 short
-> 682 pre-overlap -> **85 overlaps removed** (ours supersedes; stamped
for the adjudication jogger) -> **91 excluded-name rows** -> **506
external duels** (435 pre-corpus + 71 corpus-era at import; the runtime
guard conservatively skips 1 more ambiguous row — F9 r1154 "Garden",
which collides with an unconsumed same-night Haven recording at 0.70
roster overlap — leaving **505 rated**). 504/506 duels have both
commanders Steam64-resolved; thug slots resolve at 96.8%.

Map-alias corrections discovered by the first import's runtime guard
(1.00 roster-identity collisions, winners agreeing where ours were
determined): F9 "Quarry" = `vsrquarry2`, "Alien Dunes" = `st_dunes`
(Patton's Proving Ground), "Mort's Wasteland" = `vsrmortwasteland`.

## Interactions

- **VTSR-T: untouched.** `scripts/elo.py` never reads the ledger;
  `elo_history.json` hashed byte-identical across the import
  (BFB71D9B...46AC, verified twice). The adjudication SESSION (separate
  step) legitimately moves `wins_*` fields on newly-determined matches;
  headline `vtsr` is unchanged at ALPHA = 0.
- **Adjudication jogger:** ledger `overlaps[]` render one display-only
  hint line in the outcome prompt; `--adjudicate-f9` widens candidacy to
  hinted v1/v2-era matches. Operator remains the final authority; F9
  hints are never auto-applied. Host-cancelled matches keep Cancelled
  (attestation of invalidity outranks any winner claim).
- **Validator:** `validate_elo.py` §10 replays the enlarged history
  (telemetry + external audit fields) with replay-integrity ~0.005 ELO.
  First post-import run: duel prediction 65.1% over n=572 (was ~57% over
  n=70) — record future runs here as the corpus grows.

## Undo recipe

Delete `data/external/f9_ledger.json` (or the specific duels), re-run
`python scripts/process_stats.py` — VTSR-C recomputes from scratch every
run, so removal is total and immediate. Revert
`CMDR_ELO_SCHEMA_VERSION` if reverting the whole feature.

---

## Batch adjudication addendum (2026-09-17)

**RATIFIED + EXECUTED.** The operator could not verify the pending
outcome-review backlog from memory. Instead of rubber-stamping ~50
prompts blind, the operator ratified ONE rule — *apply F9's outcome to
every unclear match whose ledger pairing is machine-provably
unambiguous; abandon the rest* — enforced mechanically by the one-shot
`scripts/apply_f9_adjudications.py` (dry-run default, `--apply` writes).

**Trust basis (measured before applying):** 29/29 winner agreement on
every independently-determined paired match, plus a duration
fingerprint proving F9 logs the engine timer — median |F9 time − our
`duration_sec`| = 0s, p90 = 11s across the 29 calibration pairs. The
residual hazard is PAIRING (a rematch-twin cross-pair), not outcomes —
and pairing ambiguity is machine-detectable, which human memory of
two-year-old lobbies is not.

**The six gates (all must pass; pre-registered here):**
1. live `winner.decided_by == "unclear"` (attested / clean_win /
   contested / cancelled / draw are never touched);
2. `our_team ∈ {1, 2}` (F9 winner resolves by Steam64 to one of our
   team leaders);
3. roster Jaccard == 1.0 (the 0.8–0.9 relaxed tier was deliberately NOT
   taken — 2 matches forfeited);
4. |duration diff| ≤ 120s (`DURATION_TOLERANCE_SEC`);
5. no F9-side sibling row (±1 day + same map + same commander pair);
6. no corpus-side sibling, EXCEPT a provable dual recording of the
   hinted match itself (starts within 300s, durations within 5s) —
   ignored for uniqueness; the twin id stays unclear on purpose so one
   physical game rates exactly one duel.

**Executed result:** 85 overlap hints → 8 already adjudicated, 21
determined (the validation set), **50 applied**, **6 skipped forever**:
r1120 (jaccard 0.778), r1129 (0.636), r1187 (0.818), r1210 (0.9),
r1152 (duration contradiction 775s at jaccard 1.0), r1160 (666s +
ambiguous sibling). The two duration rejects are exactly the
rematch-twin hazard the gates exist for. Applied-set duration diffs:
sub-second on 47 of 50, worst 10.7s. Entries live in
`data/match_outcome_adjudications.json` with
`note: "auto-applied from F9bomber ledger row <N> (…)"` — **the undo
handle**: delete every entry whose note starts with
`auto-applied from F9bomber ledger`, re-run the pipeline.

**Effects verified:** VTSR-C telemetry duels 70 → **120**
(`matches_skipped_undetermined` 74 → 23); headline VTSR-T (`vtsr` +
`thug_elo`) byte-equal for all 42 players (wins-ladder `wins_*` fields
moved legitimately); validator §10 n = 625 duels, accuracy 66.2%,
log-loss 0.622.

**Two repairs shipped with the batch:**
- `compute_commander_elo` gained a same-id **dual-recording guard**
  (additive `matches_skipped_duplicate_recording` counter): two source
  recordings of one game sharing a match id produce two `elo_history`
  entries, and the newly-determined `2026-05-04T03-45-41` exposed
  VTSR-C rating that duel twice (+4.06 and +4.07). One game = one duel;
  the second entry now skips. (VTSR-T's own double-walk of same-id
  twins is pre-existing and deliberately untouched from this module.)
- `_investigation/smoke_alpha_override.py` blend tolerance 0.1 → 0.15:
  it recomputes the blend from independently-ROUNDED emitted fields, so
  its own error budget reaches ~0.15; the adjudication's legitimate
  wins_elo movement pushed one player onto the boundary.

**UI honesty note:** these 50 matches render the reviewer check-mark
badge (`decided_by: "adjudicated"`). The review was rule-level (this
memo), not per-match; each entry's `note` field carries the mechanical
provenance for anyone auditing the store.
