---
name: Statsgate roster union fix
overview: Fix the statsgate collector so the player roster is the union of everyone seen across the match instead of a one-shot snapshot at the first tick. This makes every steamid get reported on every tick and repairs sessions that falsely report a single player. No proto change (deferred), so it compiles against the committed gencode and is a small, backward-compatible, irrefutable diff.
todos:
  - id: helper
    content: "Add scan_players() helper to stat_client.cpp (+ declaration in stat_client.h under Helper functions): merge current slot occupants into header maps via emplace, skip s64==0, derive player_count from s64_to_nick_size()."
    status: pending
  - id: first_tick
    content: "Refactor first_tick(): remove the inline slot loop (lines 341-351) and player_count increments; after *stat_session.mutable_header() = header; call scan_players()."
    status: pending
  - id: record_update
    content: "In record_update(): call scan_players() after the recording-start gate; in the per-slot loop, move `Handle h = GetPlayerHandle(teamnum);` above `add_players()`, add `if (!h) continue;`, delete the stale 'guaranteed to be a player' comment, and keep the `[teamnum, nick]` binding unchanged."
    status: pending
  - id: verify
    content: Verify diff is only src/stat_client.cpp and src/stat_client.h; run the AI-remnant grep; confirm fork CI compiles at protobuf 6.33.4; runtime-decode a fresh recording with scripts/tojson.py to confirm union roster + all players per tick.
    status: pending
isProject: false
---

# Statsgate roster union fix (collector-only, no proto)

## Why this scope
- Confirmed decisions: (A) keep the header maintained as the live union, leave `is_player()` unchanged; (B) cannot regenerate gencode at the pinned protobuf 6.33.4 right now.
- Consequence: the `int32 team` field (explicit per-tick slot stamp, needed for commander-handoff *detection*) requires regenerated gencode to compile, so it is **deferred** to a follow-up. It is fully specced below and ready the moment regen is possible.
- This PR still fully delivers "report every steamid every tick + post-processing builds the union": once the header roster is a live union, the existing `record_update()` loop emits every present player's steamid each tick.

## Root cause (recap, evidence-backed)
The roster is captured once in `first_tick()` by scanning slots 1-10, with an explicit `// TODO: Rescan teamnums when players leave and join`. Decoded evidence: the corrupted Bowl/Oldboy sessions captured the roster at tick 0 (only the Team 1 commander instantiated), while the rest of the lobby does not appear until ~tick 2000; the roster is never rescanned, so `player_count=1` and only slot 1 is ever reported.

## The change (only `statsgate-dev/src/stat_client.cpp` and `.h`)

### 1. New helper `scan_players()` (merge current slots into the header union)
Style: snake_case, Allman braces, tabs, terse comment matching the file. Operates on the live session header; `emplace` keeps first-seen (so `teamnum_to_s64[1]/[6]` remain the initial commanders); `player_count` is derived; transient `s64 == 0` is skipped.

```cpp
void stat_client::scan_players()
{
	auto* header = stat_session.mutable_header();
	for (int teamnum = 1; teamnum <= 10; teamnum++)
	{
		Handle h = GetPlayerHandle(teamnum);
		if (!h)
			continue;
		uint64_t s64 = exu2::GetSteam64(teamnum);
		if (s64 == 0)
			continue;
		header->mutable_s64_to_nick()->emplace(s64, GetPlayerName(h));
		header->mutable_teamnum_to_s64()->emplace(teamnum, s64);
		header->mutable_s64_to_teamnum()->emplace(s64, teamnum);
	}
	header->set_player_count(header->s64_to_nick_size());
}
```
Declared in `stat_client.h` under `// Helper functions`, near `first_tick`/`last_tick`.

### 2. `first_tick()` delegates the initial scan
Currently `first_tick()` builds a local `StatHeader header`, runs the slot loop (lines 341-351), then assigns `*stat_session.mutable_header() = header;` (line 406). Change: remove the inline slot loop and the `player_count` increments; after the existing `*stat_session.mutable_header() = header;`, call `scan_players();`. Static fields (map, start_time, author, tick_rate, config_mod, terrain, races, shutdown) are untouched.

### 3. `record_update()` keeps the union live and guards empty slots
At the top, after the recording-start gate (after line 164), call `scan_players();`. Then make three precise edits to the existing per-slot loop (lines 169-191):
- Keep the structured binding exactly as-is: `for (auto& [teamnum, nick] : ...)`. The value is unused in the body (the loop reads `exu2::GetSteam64(teamnum)` live), so it is NOT renamed -- no cosmetic churn on an untouched line.
- Move `Handle h = GetPlayerHandle(teamnum);` from its current position (line 173, *after* `add_players()`) to the top of the loop body, *before* `auto* player = tick->add_players();`, and add `if (!h) continue;`. The reorder is required so an absent slot does not emit an empty `PlayerState`.
- Delete the now-inaccurate trailing comment `// teamnum should be guaranteed to be a player at this point` on that line; the `!h` guard makes it false.

```cpp
	scan_players(); // keep roster in sync: late joiners + rejoins

	auto* tick = stat_session.add_event_stream()->mutable_update_tick();
	long cur_turn = GetLockstepTurn();
	tick->set_tick(cur_turn);
	for (auto& [teamnum, nick] : stat_session.header().teamnum_to_s64())
	{
		Handle h = GetPlayerHandle(teamnum);
		if (!h)
			continue; // slot currently empty (player left / not yet spawned)
		auto* player = tick->add_players();
		player->set_player(exu2::GetSteam64(teamnum));
		// ...existing position / speed / health / ammo / odf / has_target...
	}
```
The `if (!h) continue;` is also a real robustness fix: with the roster now growing, `GetPlayerHandle(teamnum)` can return null mid-match (a player left), and the current code would call `GetPosition(null)`.

## Per-change justification (irrefutable / data-backed)
- Rescan each update: directly implements the in-code TODO; decoded evidence shows the lobby materializes ~2000 ticks after the tick-0 capture.
- `emplace` (first-seen wins): preserves initial commanders in slots 1/6; matches existing semantics.
- `player_count` derived from `s64_to_nick_size()`: required, else it inflates on every rescan.
- `s64 == 0` guard: decoded Bowl shows `GetSteam64(teamnum)` transiently returns 0 during transitions/teardown; without the guard, repeated scanning would insert a phantom player and over-count.
- `if (!h) continue;`: prevents `GetPosition(null)` now that the loop iterates a growing roster.
- Delete the stale `// teamnum should be guaranteed to be a player at this point` comment: the guard makes it untrue, and comments must stay truthful.
- Keep the `[teamnum, nick]` binding unchanged: renaming an unused binding is an unjustified diff.

## Edge cases handled
- 1 player at tick 0, 8 by tick 3 -> union grows to 8, `player_count=8`, valid (the exact target case).
- Late joiner -> added on first sighting; reported every tick thereafter.
- Commander handoff 35 -> 94 on slot 1 -> both land in `s64_to_nick`; 94 attributed in events + team totals; per-tick slot 1 occupant reflects the live id. Explicit change *detection* awaits the deferred `team` field.
- Commander leaves, no replacement -> slot samples stop (null handle skipped).
- Transient `GetSteam64==0` -> skipped, no phantom entry.

## Validation
- Compile via the fork's Actions (workflow is `on: push: branches:[main]`, vcpkg -> protobuf 6.33.4). Push and confirm green.
- Runtime: rebuild `statsgate.dll`, record a multiplayer session (ideally with a late joiner), decode with the repo's `scripts/tojson.py`; confirm `player_count` reaches the true count, `s64_to_nick`/`teamnum_to_s64` contain everyone, and every `UpdateTick` lists all present players.
- Backward-compat: decode an existing pre-change recording and confirm it still parses.

## Commit / PR hygiene (no AI traces)
- You make all commits/pushes yourself in the fork.
- Verify identity: `git -C statsgate-dev config user.name` / `user.email` are yours; no co-author trailers, no emoji, no "generated" text.
- Diff must contain only `src/stat_client.cpp` and `src/stat_client.h`; verify with `git status` / `git diff`.
- `git -C statsgate-dev grep -iE "cursor|claude|copilot|generated by|AI" -- src/` returns zero hits.
- Comments match the file's terse style; no over-commenting; no reformatting of untouched lines.
- Suggested branch `fix/rescan-roster`; commit message in the maintainer's imperative voice, e.g. "Rescan team slots each update so late-spawning players are recorded".
- Issue-first recommended: cite the TODO and the tick-0 vs ~tick-2000 evidence.

## Deferred follow-up (separate, when gencode regen is available)
Slot-change / commander-handoff detection. Requires:
- `statsgate.proto`: add `int32 team = 8;` to `PlayerState` (comment: team slot 1-10; 0 = legacy/unknown).
- `record_update()`: `player->set_team(teamnum);` in the loop.
- Regenerate committed gencode at protobuf 6.33.4 via `build_protobuf_headers.ps1` (`src/statsgate.pb.cc`, `src/statsgate.pb.h`, `scripts/statsgate_pb2.py`) and commit alongside.
- Backward compatible: old recordings decode `team=0`; old readers ignore field 8.

## Downstream (vt-stats) note
No vt-stats change is needed to benefit from this PR: the pipeline already reads `teamnum_to_s64` / `s64_to_nick` / `player_count`, which become complete for future recordings. Existing corrupted files remain unrecoverable (the other players' steamids were never written). Consuming the future `team` field (timeline-based roster + validity flag) is separate vt-stats work.