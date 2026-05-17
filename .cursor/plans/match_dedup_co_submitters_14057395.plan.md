# Match Deduplication + Co-Submitters

**Status:** awaiting user go-ahead to implement
**Owner:** agent
**Triggered by:** user noticed Nomad + Cyber both submitted the same Red Slope and Mojave matches (May 17 ~21:41 and ~22:14 UTC); Nomad's two duplicates also showed only 1 player in their event roster (collector-side bug on his machine). User wants:

1. Detect duplicate-match submissions and emit a single canonical match per cluster.
2. Credit *all* submitters in the canonical match's metadata.
3. Avoid showing the broken 1-player view that comes from Nomad's incomplete recordings (solved automatically by primary-selection picking Cyber's complete recording).

## Concrete evidence (gzipped header dump)

| File | Submitter | Map | last_tick | tick_rate | start_time | Header roster size | Events |
|---|---|---|---|---|---|---|---|
| `Nomad/2026-05-17-21-41-24.binpb.gz` | Nomad | `stredslopevsr.bzn` | 21707 | 20 | 1779054084 | **1** | 66413 |
| `Cyber/2026-05-17-21-41-51.binpb.gz` | Cyber | `stredslopevsr.bzn` | 21707 | 20 | 1779054111 | **8** | 93938 |
| `Nomad/2026-05-17-22-14-23.binpb.gz` | Nomad | `vsrMojave.bzn`     | 21684 | 20 | 1779056063 | **1** | 86163 |
| `Cyber/2026-05-17-22-14-50.binpb.gz` | Cyber | `vsrMojave.bzn`     | 21684 | 20 | 1779056090 | **10**| 123473 |

Both pairs are clearly the same engine session: identical map+tick_rate+last_tick, start times 27s apart.

`Nomad/2026-05-16-21-25-56.binpb.gz` (4-player Red Slope) is **not** a duplicate — its event roster is genuinely 4 players. Stays as-is.

## Design

### Fingerprint signature

Per binpb.gz, computed from header alone (no full event-stream walk needed for the cluster decision — keep cheap):

```
sig = (map_file_lower, tick_rate, last_tick, start_time_unix, author_steam64)
```

### Cluster rule

Two sessions are duplicates iff **all** of:
- same `map_file_lower`
- same `tick_rate`
- same `last_tick` (exact)
- `|Δstart_time| ≤ 300s`

The `last_tick` clause is essentially a unique key in practice (engine ticks at 20Hz; collisions across unrelated matches are statistically negligible). The 5-min start-time clause is a defense-in-depth against the rare degenerate.

### Primary selection (within a cluster)

1. **Most events** (proxy for most-complete recording — wins by definition over collector-broken Nomad files)
2. Tiebreak: largest `header.player_count`
3. Tiebreak: largest source file size
4. Tiebreak: earliest start_time (deterministic)

### Pipeline changes (`scripts/process_stats.py`)

1. New helper `cluster_sessions(sources)` — header-parse each binpb.gz once (cheap; we only read `StatHeader` fields plus a single-pass scan that already happens in `load_session`'s schema-detection probe), build clusters by signature, return:
   - `primaries: list[(session_path, submitter)]`
   - `cluster_by_primary: dict[primary_path, list[(submitter, source_file)]]` — full submitter list including the primary
   - `dropped: list[(submitter, source_file, primary_match_id_hint)]` — for orphan cleanup
2. Main loop iterates **only primaries**:
   - Cache key unchanged: `(submitter, source_file)`. Primary-row cache hits work as today.
   - When the cached `match.submitters` list disagrees with the cluster's computed list, just patch the field in-memory + re-emit the JSON (cheap; no full reprocess).
3. Per-match output:
   - New `match.submitters: ["Cyber", "Nomad"]` (sorted, primary always first if we want UI to render canonical-first — but sorted alphabetical is simpler and the UI doesn't care; **decision: alpha-sorted**).
   - Legacy `match.submitter` keeps the **primary** submitter's name for backward-compat.
4. Manifest (`matches.json`):
   - New `submitters: [...]` array on each entry.
   - Legacy `submitter` field stays (= primary).
5. `match_contributions.json` `_extract_contribution`:
   - Adds `submitters: [...]` (used by the All Matches aggregator's submitter histogram).
6. New file `data/processed/duplicate_index.json`:
   ```json
   {
     "schema_version": 1,
     "computed_at": "2026-05-17T...",
     "clusters": [
       {"primary_match_id": "2026-05-17T21-41-51",
        "primary": {"submitter": "Cyber", "source_file": "..."},
        "duplicates": [{"submitter": "Nomad", "source_file": "..."}]
       }, ...
     ]
   }
   ```
   Skipped by `load_cache_index`.
7. **Orphan cleanup (one-shot per pipeline run, idempotent):** any `data/processed/<match_id>.json` whose `(submitter, source_file)` pair appears as a *duplicate* (not a primary) in the freshly-computed cluster index gets deleted. Logged loudly. Safe because the primary's JSON file (different match_id, since primaries differ in start_time) carries the canonical data.
8. **Version bumps:**
   - `PIPELINE_VERSION` += 1 — forces full corpus reprocess so existing matches gain the `submitters` field.
   - `match.schema_version` 6 → 7 — frontend-contract bump for the new field.
   - `ELO_SCHEMA_VERSION` unchanged.
9. **Picker facet contract:** when filtering by submitter, an entry matches if **any** of its submitters is selected (currently exact-equality on `entry.submitter`). Documented in `.cursor/rules/filter-contract.mdc`.

### UI changes

- `js/app.js` `renderBanner()`: render `info.submitters.join(', ')` when present, else fall back to `info.submitter`.
- `js/app.js` `buildMatchPickerCardHtml()`: same join fallback for the card's submitter chip.
- `js/app.js` picker-filter loop: change `state.submitters.includes(entry.submitter)` → `entry.submitters.some(s => state.submitters.includes(s))` with single-name fallback.
- `js/app.js` picker-facet build (`pickerFacets.submitters`): unchanged — already collects unique submitter names from `m.submitter`; switch to spread from `m.submitters` so co-submitters show up as facet options.
- `js/all-matches-aggregator.js`:
  - Hero submitters set: spread `m.submitters` instead of single `m.submitter`.
  - Submitter histogram: count each submitter once per match they participated in (so a co-submitted match increments both Cyber's and Nomad's counts; this matches the human intuition of "how many matches has this submitter contributed to").

### Doc / rules updates

- `docs/DATA_DICTIONARY.md` §3 manifest schema + §4 per-match schema: add `submitters` array, document dedup rule.
- `.cursor/rules/project-overview.mdc`: short bullet on dedup.
- `AGENTS.md`: short bullet under "Key Conventions".
- `.cursor/rules/filter-contract.mdc`: picker submitter facet "any-of" semantics.

## Out of scope (deferred, document as such)

- **Auto-flagging "bad data" sessions when no duplicate exists.** If Nomad submits a future Mojave alone with the same collector bug, we'd display a 1-player view. The user did not ask for this; the right fix is upstream in his collector. We could add a `match.partial: true` heuristic later if it becomes a recurring problem.
- **Backfilling submitter credits across the existing `elo_history.json`.** Ratings already collapsed under primary-only credit; recomputing won't change rating math. If the user later wants "matches contributed" stats, we'd recompute then.

## Acceptance criteria

1. After pipeline run, `data/processed/2026-05-17T21-41-24.json` (Nomad's broken Red Slope) is **gone**; `data/processed/2026-05-17T21-41-51.json` (Cyber's full Red Slope) carries `match.submitters = ["Cyber", "Nomad"]`.
2. Same for the Mojave pair: only `2026-05-17T22-14-50.json` survives, with both submitters listed.
3. Dashboard match-info banner for those matches shows "Cyber, Nomad".
4. Match picker submitter facet has both Cyber and Nomad as options; selecting Nomad shows the co-submitted matches.
5. All Matches → Meta tab "Submitters" hero stat correctly counts both Cyber and Nomad as contributors.
6. The third Nomad file (`2026-05-16-21-25-56`, 4-player Red Slope) renders unchanged — no false-positive dedup.
7. ELO output (`elo_current.json`) numerically unchanged (same 84 rated matches, same player ratings — losing 2 broken Nomad submissions doesn't add anything because the primary is in the corpus already).

## Implementation order

1. **Plan checkpoint** — get user go-ahead on this file. ← we are here
2. Add `cluster_sessions()` + tests by manual eyeball on the four known files.
3. Wire into main loop; emit `submitters` everywhere.
4. Orphan cleanup pass.
5. Bump versions; run pipeline; verify acceptance criteria 1–2 + 7.
6. JS UI changes; verify acceptance criteria 3–6 in browser.
7. Doc/rule updates.
8. Commit (only on user request).
