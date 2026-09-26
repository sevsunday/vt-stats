#!/usr/bin/env python3
"""
VT Stats — Map Browser Page Generator

Owns three concerns:

1. Map stats aggregation. Walk `all_match_data` once and produce
   `data/processed/map_stats.json`, a per-map roll-up keyed by the
   lowercased `map_file` stem (e.g. `havenvsr`, `stredslopevsr`). The
   output is corpus-wide, picker-filter-unaware (same posture as the
   VTSR-T leaderboard) and emits an entry for *every* map in the
   registry — unplayed maps get zeroed stat fields so the
   gallery/landing UI can surface the full VSR catalog without 404s.

2. (Phase 5) Pre-generated `/map/<mapfile>/index.html` stubs. Each map
   gets a static stub whose `<head>` carries OG meta keyed to its own
   screenshot, so Discord/Twitter unfurls show the actual map image.

3. Slug normalization (defensive only). Map slugs are simply the
   lowercased `map_file` stem from `build_map_registry.map_key()` — no
   allocator, no stickiness needed because map filenames don't drift.
   `RESERVED_MAP_SLUGS` plus a filesystem-safety regex catches the
   pathological collision case.

Entry point: `run(*, all_match_data, registry, output_dir,
project_root, pregen_stubs=True)` — called by
`scripts/process_stats.py::main()` after the player-slug block. Pure
(no I/O outside the project tree); soft-fails so a hiccup never blocks
the rest of the pipeline.

Phase 2 covers item (1) above. The HTML render in (2) lands in Phase
5. Item (3) is a zero-cost helper used by both phases.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import identity_aliases

# Production host. Used to build absolute URLs (og:url, twitter:url,
# canonical) so embedded link previews resolve even when shared without
# the host prefix. CNAME in repo root is the source of truth. Mirrors
# generate_player_pages.SITE_URL.
SITE_URL = "https://vtstats.bz"

# Bumped whenever the rendered stub HTML changes shape (new meta tag,
# new template placeholder, new section in the static fold, etc.).
# Triggers a re-render of every stub on the next pipeline run even when
# the underlying map_stats.json hasn't moved. Orthogonal to
# PIPELINE_VERSION (per-match cache) and the schema_version field on
# `map_stats.json` itself (consumer contract).
# v3 threads the site-wide custom-cursor + Settings gear script
# (js/cursor-settings.js) through every map stub.
# v5 adds the ELO topnav link (dedicated /elo/ page) after Maps.
# v6 reorders the topnav: Players moves after Maps so it sits
# immediately left of ELO (Models · Maps · Players · ELO · Tools).
# v7 drops the Tools-link live-pulse poller (bz2api.js +
# active-game-indicator.js) from stubs; the dashboard owns that poller.
# v8 threads the LEGO topnav link (bi-bricks, after Models) through every stub.
# v10 turns the ODF topnav link into a dropdown (ODF Browser, Build Trees).
# v11 adds ODF Guide to that dropdown.
# v12 replaces the directory chip rows with Any-default dropdowns.
MAP_TEMPLATE_VERSION = 12

# Pre-gen stub path within the repo. Each map slug becomes
# `map/<slug>/index.html`. Created if missing, written idempotently
# (no-op when content already matches). Mirrors PLAYER_STUBS_DIR.
MAP_STUBS_DIR = "map"

# Template file consumed by `_render_map_stubs()`. Lives next to this
# module so callers don't need to know its path. Loaded once per run.
TEMPLATE_FILENAME = "map_template.html"

# Slugs that would collide with sibling routes / future pages /
# directory landing. The /map/<slug>/ folder names are derived
# straight from the map file stem (which is already filesystem-safe by
# convention), so a real collision is vanishingly unlikely — none of
# the 143 vsrmaplist entries hit any of these names. Defensive guard
# in case a future legacy mod ships a map called `index.bzn` etc.
RESERVED_MAP_SLUGS = frozenset({
    "index",
    "compare",
    "all",
    "search",
    "new",
    "api",
})

# Filesystem / URL safety regex applied to every map slug before any
# write. Matches the existing convention (lowercase alphanumeric +
# hyphen + underscore); any map whose stem fails this check is logged
# and skipped from stub rendering. Currently zero matches in the corpus
# — this is purely defensive against future legacy mod imports.
SLUG_SAFE_RE = re.compile(r"^[a-z0-9_-]+$")

# Aggregation caps. Top-commanders shows at most 10 rows; recent
# matches shows the 10 most recent. Both are intentionally short for
# the v1 surface — future card expansions can request more rows from
# the same JSON without recomputing.
MAX_TOP_COMMANDERS = 10
MAX_RECENT_MATCHES = 10

# Output schema version. v2 adds display-only play_count /
# community_games / popular plus the per-map insights block. Existing
# match_count stays recorded-sessions-only.
MAP_STATS_SCHEMA_VERSION = 2

# Popular is the top N maps by play_count (recorded + community), ties
# at the cutoff included, and only when play_count clears the floor.
POPULAR_TOP_N = 15
POPULAR_MIN_PLAYS = 3

INSIGHT_BEST_PLAYERS = 5
INSIGHT_BEST_PLAYERS_MIN = 2
INSIGHT_BEST_COMMANDERS = 5
INSIGHT_BEST_COMMANDERS_MIN = 3

# Team-win decided_by values. Contested / draw / cancelled / unclear
# stay out of blowout, closest-call, and commander win rate, matching
# the Meta tab's wins_t1 / wins_t2 buckets.
_TEAM_WIN_DECIDED = frozenset({"clean_win", "attested", "adjudicated"})
_FACTION_CODES = ("i", "e", "f")


# -- Slug helpers --------------------------------------------------------

def map_slug(map_field: str) -> str | None:
    """Normalize a raw `match.map` field (e.g. `"STAncientvsr.bzn"`) to
    the registry key / URL slug (`"stancientvsr"`). Returns None when
    the input is empty, fails the `SLUG_SAFE_RE` filesystem-safety
    check, or collides with `RESERVED_MAP_SLUGS`.

    Mirrors the slug pipeline used by `build_map_registry.map_key()` so
    the registry key, the per-map JSON filename, the URL path, and the
    stub directory name all line up.
    """
    if not map_field:
        return None
    stem = re.sub(r"\.bzn$", "", str(map_field), flags=re.IGNORECASE).lower()
    if not stem:
        return None
    if not SLUG_SAFE_RE.fullmatch(stem):
        return None
    if stem in RESERVED_MAP_SLUGS:
        # Defensive: append `-map` suffix. Currently unreachable for the
        # 143 vsrmaplist + ~34 played maps; would only fire on a future
        # legacy mod whose .bzn file shadows a reserved route.
        return f"{stem}-map"
    return stem


def map_title_resolver(raw_map: str, registry: dict) -> str:
    """Mirror of `resolve_match_name()` in `scripts/process_stats.py`.

    Resolves a map's display title from `registry[<key>].title` with
    iteratively-stripped `XYZ: ` prefixes (`"ST: VSR: TVD: Ebola"` →
    `"Ebola"`). Falls back to the raw filename minus `.bzn`.

    The same iterative-prefix logic also lives in JS at
    [js/app.js](js/app.js) `mapNameResolver` and (Phase 3) in
    [js/maps.js](js/maps.js). Document any future tweak in all three
    places — see AGENTS.md drift caveat.
    """
    key = (
        re.sub(r"\.bzn$", "", str(raw_map or ""), flags=re.IGNORECASE).lower()
    )
    title = ((registry or {}).get(key, {}) or {}).get("title") or ""
    while True:
        nxt = re.sub(r"^[^:]+:\s*", "", title, count=1)
        if nxt == title:
            break
        title = nxt
    title = title.strip()
    if title:
        return title
    return re.sub(r"\.bzn$", "", str(raw_map or ""), flags=re.IGNORECASE)


# -- Aggregation --------------------------------------------------------

def compute_map_stats(
    all_match_data: list[dict],
    registry: dict,
    *,
    elo_history: dict | None = None,
    community_games: dict | None = None,
    f9_duels: dict | None = None,
) -> dict:
    """Pure aggregator: walk `all_match_data` once and produce the
    per-map roll-up consumed by `js/maps.js` (and the future stub
    template).

    Catalog completeness contract: every key in `registry` gets an
    entry, even with zero matches recorded. The directory page's hero
    counter and the "Unplayed" filter chip both depend on this — empty
    keys must be discoverable, not silently dropped.

    Aggregation rules:
      - `match_count` / `total_duration_sec` / `avg_duration_sec` /
        `first_played` / `last_played` count every match the map
        appears in (no exclusion gates — the match itself happened).
      - `top_commanders` excludes per-row `is_campod` and
        `is_low_activity` flags so career-fairness mirrors the VTSR-T
        contract. Sort key: `(-matches_commanded, -last_appearance_iso)`
        — ties break to the more recently active commander. Capped at
        `MAX_TOP_COMMANDERS`.
      - `recent_matches` is straight `sorted(date desc)[:N]` regardless
        of exclusion gates. We want the user to see the actual
        chronology of matches on the map, not a sanitised subset.
        `commanders["1"]` / `commanders["2"]` is `null` when that slot
        had no team-leader entry; renderer handles the null with
        em-dash. `winner_team` is `null` for `winner_decided_by ==
        "unclear"`.

    Display-only additions (schema 2), never folded into `match_count`:
      - `community_games` / `play_count` join F9's per-map game counts.
      - `popular` marks the top `POPULAR_TOP_N` by `play_count`.
      - `insights` is the six per-map cards (wins, factions, best
        players from VTSR-T deltas, commander win rate, records,
        player-count histogram).

    The function is pure (no I/O). Caller wraps in a `_stable_equals`
    check to avoid gratuitous JSON rewrites on no-delta runs.
    """
    # Step 1: bucket every match into its map slug. Skip matches with
    # an unresolved map slug (failed sanity-check / reserved). One pass.
    match_buckets: dict[str, list[dict]] = {}
    for md in all_match_data or []:
        m = md.get("match") or {}
        # Operator void: the recording stays openable, but it is not a
        # played game for match_count, duration, commanders, or recents.
        if m.get("void"):
            continue
        slug = map_slug(m.get("map") or "")
        if not slug:
            continue
        match_buckets.setdefault(slug, []).append(md)

    # Step 2: build per-map stats. Iterate `registry` so unplayed maps
    # are emitted as well; played-but-not-in-registry slugs (rare —
    # would need a played map missing from vsrmaplist AND iondriver)
    # also surface as a fallback so the catalog stays complete.
    all_slugs = set(registry.keys()) | set(match_buckets.keys()) | set((f9_duels or {}).keys())
    elo_index = _index_elo_deltas(elo_history)

    maps_out: dict[str, dict] = {}
    for slug in sorted(all_slugs):
        bucket = match_buckets.get(slug) or []
        maps_out[slug] = _build_map_entry(
            slug, bucket, elo_index, (f9_duels or {}).get(slug) or [],
        )

    _apply_community_and_popular(maps_out, community_games or {})

    return {
        "schema_version": MAP_STATS_SCHEMA_VERSION,
        "template_version": MAP_TEMPLATE_VERSION,
        "generated_at": _now_iso(),
        "site_url": SITE_URL,
        "min_recent_matches_shown": MAX_RECENT_MATCHES,
        "max_top_commanders": MAX_TOP_COMMANDERS,
        "maps": maps_out,
    }


_F9_FACTION = {"isdf": "i", "hadean": "e", "scion": "f"}
_F9_SIZE_PLAYERS = {"3v3": 6, "4v4": 8, "5v5": 10}


def _pin_player(steam64, name) -> tuple[str, str, str]:
    """Return (store key, steam64, display name). Alias targets keep the
    canonical name. A missing Steam64 keys on the lowercased name."""
    sid = str(steam64 or "").strip()
    label = (name or "").strip()
    if sid:
        label = identity_aliases.ALIAS_TARGET_NAMES_STR.get(sid) or label
        return sid, sid, label
    if not label:
        return "", "", ""
    return "name:" + label.lower(), "", label


def _bump_f9_commanders(cmdr_counts: dict, duel: dict) -> None:
    winner = duel.get("winner_side")
    if winner not in (1, 2):
        return
    date = _f9_sort_date(duel.get("date"))
    commanders = duel.get("commanders") or {}
    for side in (1, 2):
        person = commanders.get(str(side)) or commanders.get(side) or {}
        key, sid, label = _pin_player(person.get("steam64"), person.get("name"))
        if not key:
            continue
        row = cmdr_counts.get(key)
        if row is None:
            row = {
                "steam64": sid,
                "name": label,
                "matches_commanded": 0,
                "wins": 0,
                "losses": 0,
                "_last_iso": date,
            }
            cmdr_counts[key] = row
        row["matches_commanded"] += 1
        if side == winner:
            row["wins"] += 1
        else:
            row["losses"] += 1
        if date >= (row.get("_last_iso") or ""):
            row["_last_iso"] = date
            row["name"] = label


def _f9_sort_date(raw) -> str:
    text = str(raw or "").strip()
    if len(text) == 10:
        return text + "T00:00:00+00:00"
    return text


def _f9_recent_row(duel: dict) -> dict:
    winner = duel.get("winner_side") if duel.get("winner_side") in (1, 2) else None
    commanders = {}
    raw = duel.get("commanders") or {}
    for side in ("1", "2"):
        person = raw.get(side) or {}
        _key, sid, label = _pin_player(person.get("steam64"), person.get("name"))
        commanders[side] = {"name": label, "s64": sid} if label or sid else None
    size = str(duel.get("size") or "").strip().lower()
    return {
        "id": "",
        "date": _f9_sort_date(duel.get("date")) or None,
        "duration_sec": duel.get("duration_sec") or 0,
        "player_count": _F9_SIZE_PLAYERS.get(size) or 0,
        "commanders": commanders,
        "winner_decided_by": "f9",
        "winner_team": winner,
        "source": "f9",
    }


def _f9_faction_code(name) -> str | None:
    return _F9_FACTION.get(str(name or "").strip().lower())


def _bump_f9_insight(duel, by_side, win_rate, pc_hist, cmdrs) -> None:
    winner = duel.get("winner_side")
    factions = duel.get("factions") or {}
    for side in (1, 2):
        code = _f9_faction_code(factions.get(str(side)) or factions.get(side))
        if code and winner in (1, 2):
            by_side[str(side)][code] += 1
            win_rate[code]["decided"] += 1
            if side == winner:
                win_rate[code]["wins"] += 1
        person = (duel.get("commanders") or {}).get(str(side)) or {}
        key, sid, label = _pin_player(person.get("steam64"), person.get("name"))
        if not key or winner not in (1, 2):
            continue
        row = cmdrs.get(key)
        if row is None:
            row = {"steam64": sid, "name": label, "wins": 0, "decided": 0}
            cmdrs[key] = row
        row["decided"] += 1
        if side == winner:
            row["wins"] += 1
        if label:
            row["name"] = label
    size = str(duel.get("size") or "").strip().lower()
    players = _F9_SIZE_PLAYERS.get(size)
    if players:
        pc_hist[players] = pc_hist.get(players, 0) + 1


def _build_map_entry(
    slug: str,
    bucket: list[dict],
    elo_index: dict,
    f9_duels: list | None = None,
) -> dict:
    """Build a single per-map roll-up. `bucket` is every match (as the
    raw `match_data` dict) that played on this map; may be empty for
    unplayed registry entries.
    """
    f9_duels = list(f9_duels or [])
    if not bucket and not f9_duels:
        return _empty_map_entry(slug, elo_index)

    # Match-level totals -- count every match unconditionally.
    match_count = len(bucket)
    total_duration = 0.0
    dates: list[str] = []
    for md in bucket:
        m = md.get("match") or {}
        dur = m.get("duration_sec")
        if isinstance(dur, (int, float)):
            total_duration += float(dur)
        d = m.get("date")
        if isinstance(d, str) and d:
            dates.append(d)

    avg_duration = (total_duration / match_count) if match_count else 0.0
    first_played = min(dates) if dates else None
    last_played = max(dates) if dates else None

    # Top commanders — tally slot 1/6 leaderboard rows where the
    # exclusion gates pass. Wins/losses count decided team wins only
    # (clean_win / attested / adjudicated). Contested, draws, and
    # cancellations stay in matches_commanded but not the record.
    cmdr_counts: dict[str, dict] = {}
    for md in bucket:
        m = md.get("match") or {}
        match_date = m.get("date") or ""
        outcome = _winner_bucket(m.get("winner"))
        for p in md.get("leaderboard") or []:
            slot = p.get("slot")
            if slot not in (1, 6):
                continue
            if p.get("is_campod") or p.get("is_low_activity"):
                continue
            sid = str(p.get("steam64") or "").strip()
            name = (p.get("name") or "").strip()
            if not sid or not name:
                continue
            # Alias TARGET steam64: pin the career-canonical name so a
            # source-account appearance cannot last-seen-rename this row.
            name = identity_aliases.ALIAS_TARGET_NAMES_STR.get(sid) or name
            row = cmdr_counts.get(sid)
            if row is None:
                row = {
                    "steam64": sid,
                    "name": name,
                    "matches_commanded": 0,
                    "wins": 0,
                    "losses": 0,
                    "_last_iso": match_date,
                }
                cmdr_counts[sid] = row
            row["matches_commanded"] += 1
            if outcome in ("t1", "t2"):
                their_team = 1 if slot == 1 else 2
                won = (outcome == "t1" and their_team == 1) or (
                    outcome == "t2" and their_team == 2
                )
                if won:
                    row["wins"] += 1
                else:
                    row["losses"] += 1
            if match_date >= row["_last_iso"]:
                row["_last_iso"] = match_date
                row["name"] = name

    for duel in f9_duels:
        _bump_f9_commanders(cmdr_counts, duel)

    def _cmdr_sort_key(r: dict) -> tuple:
        decided = r["wins"] + r["losses"]
        rate = (r["wins"] / decided) if decided else -1.0
        return (-r["wins"], -rate, -r["matches_commanded"], r["name"].lower())

    cmdr_sorted = sorted(cmdr_counts.values(), key=_cmdr_sort_key)[:MAX_TOP_COMMANDERS]
    top_commanders = []
    for r in cmdr_sorted:
        decided = r["wins"] + r["losses"]
        top_commanders.append({
            "steam64": r["steam64"],
            "name": r["name"],
            "matches_commanded": r["matches_commanded"],
            "wins": r["wins"],
            "losses": r["losses"],
            "win_rate": round(r["wins"] / decided, 3) if decided else None,
        })

    # Recent list mixes recorded sessions with community duels, then
    # keeps the 10 newest. Community rows carry source "f9" and no match id.
    recent_rows = []
    for md in bucket:
        m = md.get("match") or {}
        winner = m.get("winner") or {}
        decided_by = winner.get("decided_by") or "unclear"
        winner_team = winner.get("team") if decided_by != "unclear" else None
        team_leaders = m.get("team_leaders") or {}
        commanders = {
            "1": _commander_entry(team_leaders.get("1")),
            "2": _commander_entry(team_leaders.get("2")),
        }
        recent_rows.append({
            "id": m.get("id") or "",
            "date": m.get("date") or None,
            "duration_sec": m.get("duration_sec") or 0,
            "player_count": m.get("player_count") or 0,
            "commanders": commanders,
            "winner_decided_by": decided_by,
            "winner_team": winner_team,
        })
    for duel in f9_duels:
        recent_rows.append(_f9_recent_row(duel))
    recent_rows.sort(key=lambda r: r.get("date") or "", reverse=True)
    recent_rows = recent_rows[:MAX_RECENT_MATCHES]

    return {
        "map_file": slug,
        "match_count": match_count,
        "community_games": 0,
        "play_count": match_count,
        "popular": False,
        "total_duration_sec": round(total_duration, 1),
        "avg_duration_sec": round(avg_duration, 1),
        "first_played": first_played,
        "last_played": last_played,
        "top_commanders": top_commanders,
        "recent_matches": recent_rows,
        "insights": _build_insights(bucket, elo_index, f9_duels),
    }


def _empty_map_entry(slug: str, _elo_index: dict | None = None) -> dict:
    """Catalog-completeness placeholder for unplayed maps. Same shape
    as a played-map entry so renderer code can branch on
    `match_count > 0` without null-checking every field.
    """
    return {
        "map_file": slug,
        "match_count": 0,
        "community_games": 0,
        "play_count": 0,
        "popular": False,
        "total_duration_sec": 0.0,
        "avg_duration_sec": 0.0,
        "first_played": None,
        "last_played": None,
        "top_commanders": [],
        "recent_matches": [],
        "insights": _empty_insights(),
    }


def _empty_insights() -> dict:
    side = {code: 0 for code in _FACTION_CODES}
    return {
        "wins": {"t1": 0, "t2": 0, "contested": 0, "unclear": 0},
        "factions": {
            "by_side": {"1": dict(side), "2": dict(side)},
            "win_rate": {code: {"wins": 0, "decided": 0} for code in _FACTION_CODES},
        },
        "best_players": [],
        "best_commanders": [],
        "records": {
            "longest": None,
            "highest_scoring": None,
            "biggest_blowout": None,
            "closest_call": None,
        },
        "player_counts": [],
    }


def _winner_bucket(winner: dict | None) -> str:
    """Same partition as the All Matches Meta map chart:
    t1 / t2 / contested / unclear. Draws and cancellations fold into
    unclear so the four buckets sum to the match count.
    """
    winner = winner or {}
    decided = winner.get("decided_by") or "unclear"
    team = winner.get("team")
    if decided == "contested":
        return "contested"
    if decided in _TEAM_WIN_DECIDED and team in (1, 2):
        return "t1" if team == 1 else "t2"
    return "unclear"


def _team_of_slot(slot) -> int | None:
    if slot in (1, 2, 3, 4, 5):
        return 1
    if slot in (6, 7, 8, 9, 10):
        return 2
    return None


def _prefer_extreme(current: dict | None, candidate: dict, *, high: bool) -> dict:
    """Keep the more extreme metric. A tie breaks to the newer date."""
    if current is None:
        return candidate
    cv = current["value"]
    nv = candidate["value"]
    if (nv > cv) if high else (nv < cv):
        return candidate
    if nv == cv and (candidate.get("date") or "") > (current.get("date") or ""):
        return candidate
    return current


def _record_row(md: dict, value, **extra) -> dict:
    m = md.get("match") or {}
    row = {
        "id": m.get("id") or "",
        "date": m.get("date") or None,
        "value": value,
    }
    row.update(extra)
    return row


def _build_insights(bucket: list[dict], elo_index: dict, f9_duels: list | None = None) -> dict:
    wins = {"t1": 0, "t2": 0, "contested": 0, "unclear": 0}
    by_side = {
        "1": {code: 0 for code in _FACTION_CODES},
        "2": {code: 0 for code in _FACTION_CODES},
    }
    win_rate = {code: {"wins": 0, "decided": 0} for code in _FACTION_CODES}
    pc_hist: dict[int, int] = {}
    cmdrs: dict[str, dict] = {}
    longest = None
    highest = None
    blowout = None
    closest = None

    for md in bucket:
        m = md.get("match") or {}
        winner = m.get("winner") or {}
        bucket_name = _winner_bucket(winner)
        wins[bucket_name] += 1
        match_date = m.get("date") or ""

        factions = m.get("team_factions") or {}
        side_code = {}
        for side in ("1", "2"):
            code = ((factions.get(side) or {}).get("code") or "").lower()
            side_code[side] = code if code in _FACTION_CODES else None
            if side_code[side]:
                by_side[side][side_code[side]] += 1
        if bucket_name in ("t1", "t2"):
            win_side = "1" if bucket_name == "t1" else "2"
            lose_side = "2" if win_side == "1" else "1"
            for side, won in ((win_side, True), (lose_side, False)):
                code = side_code.get(side)
                if not code:
                    continue
                win_rate[code]["decided"] += 1
                if won:
                    win_rate[code]["wins"] += 1

        pc = m.get("player_count") or 0
        if isinstance(pc, (int, float)) and int(pc) > 0:
            pc_hist[int(pc)] = pc_hist.get(int(pc), 0) + 1

        t1_kills = 0
        t2_kills = 0
        for p in md.get("leaderboard") or []:
            kills = int(p.get("kills") or 0)
            side = _team_of_slot(p.get("slot"))
            if side == 1:
                t1_kills += kills
            elif side == 2:
                t2_kills += kills
            if p.get("slot") not in (1, 6):
                continue
            if p.get("is_campod") or p.get("is_low_activity"):
                continue
            if bucket_name not in ("t1", "t2"):
                continue
            sid = str(p.get("steam64") or "").strip()
            name = (p.get("name") or "").strip()
            if not sid or not name:
                continue
            name = identity_aliases.ALIAS_TARGET_NAMES_STR.get(sid) or name
            row = cmdrs.get(sid)
            if row is None:
                row = {"steam64": sid, "name": name, "wins": 0, "decided": 0}
                cmdrs[sid] = row
            row["decided"] += 1
            their_team = 1 if p.get("slot") == 1 else 2
            if (bucket_name == "t1" and their_team == 1) or (
                bucket_name == "t2" and their_team == 2
            ):
                row["wins"] += 1
            if match_date >= (row.get("_last") or ""):
                row["_last"] = match_date
                row["name"] = name

        dur = m.get("duration_sec")
        if isinstance(dur, (int, float)):
            longest = _prefer_extreme(
                longest, _record_row(md, round(float(dur), 1)), high=True,
            )
        total_kills = t1_kills + t2_kills
        highest = _prefer_extreme(
            highest, _record_row(md, total_kills), high=True,
        )
        if bucket_name in ("t1", "t2"):
            margin = abs(t1_kills - t2_kills)
            winner_team = 1 if bucket_name == "t1" else 2
            marked = _record_row(md, margin, winner_team=winner_team)
            blowout = _prefer_extreme(blowout, marked, high=True)
            closest = _prefer_extreme(closest, marked, high=False)

    for duel in f9_duels or []:
        _bump_f9_insight(duel, by_side, win_rate, pc_hist, cmdrs)

    best_commanders = []
    for row in cmdrs.values():
        if row["decided"] < INSIGHT_BEST_COMMANDERS_MIN:
            continue
        best_commanders.append({
            "steam64": row["steam64"],
            "name": row["name"],
            "wins": row["wins"],
            "decided": row["decided"],
            "win_rate": round(row["wins"] / row["decided"], 3),
        })
    best_commanders.sort(
        key=lambda r: (-r["win_rate"], -r["decided"], r["name"].lower()),
    )
    best_commanders = best_commanders[:INSIGHT_BEST_COMMANDERS]

    players: dict[str, dict] = {}
    for md in bucket:
        mid = (md.get("match") or {}).get("id") or ""
        commanders = set()
        for p in md.get("leaderboard") or []:
            if p.get("slot") not in (1, 6):
                continue
            sid = str(p.get("steam64") or "").strip()
            if sid:
                commanders.add(sid)
        for delta in elo_index.get(mid) or []:
            sid = delta["steam64"]
            if sid in commanders:
                continue
            name = identity_aliases.ALIAS_TARGET_NAMES_STR.get(sid) or delta["name"]
            row = players.get(sid)
            if row is None:
                row = {"steam64": sid, "name": name, "delta_sum": 0.0, "matches": 0}
                players[sid] = row
            row["delta_sum"] += delta["delta"]
            row["matches"] += 1
            row["name"] = name
    best_players = [
        {
            "steam64": r["steam64"],
            "name": r["name"],
            "delta_sum": round(r["delta_sum"], 2),
            "matches": r["matches"],
        }
        for r in players.values()
        if r["matches"] >= INSIGHT_BEST_PLAYERS_MIN
    ]
    best_players.sort(
        key=lambda r: (-r["delta_sum"], -r["matches"], r["name"].lower()),
    )
    best_players = best_players[:INSIGHT_BEST_PLAYERS]

    def _public_record(row: dict | None) -> dict | None:
        if not row:
            return None
        out = {"id": row["id"], "date": row["date"], "value": row["value"]}
        if "winner_team" in row:
            out["winner_team"] = row["winner_team"]
        return out

    return {
        "wins": wins,
        "factions": {"by_side": by_side, "win_rate": win_rate},
        "best_players": best_players,
        "best_commanders": best_commanders,
        "records": {
            "longest": _public_record(longest),
            "highest_scoring": _public_record(highest),
            "biggest_blowout": _public_record(blowout),
            "closest_call": _public_record(closest),
        },
        "player_counts": [
            {"players": n, "matches": pc_hist[n]} for n in sorted(pc_hist)
        ],
    }


def _index_elo_deltas(elo_history: dict | None) -> dict[str, list[dict]]:
    """match_id -> rated VTSR-T deltas. Excluded matches contribute nothing."""
    out: dict[str, list[dict]] = {}
    for entry in (elo_history or {}).get("history") or []:
        if entry.get("match_excluded"):
            continue
        mid = entry.get("match_id") or ""
        if not mid:
            continue
        rows = []
        for delta in entry.get("deltas") or []:
            sid = str(delta.get("steam64") or "").strip()
            if not sid:
                continue
            try:
                amount = float(delta.get("delta") or 0)
            except (TypeError, ValueError):
                amount = 0.0
            rows.append({
                "steam64": sid,
                "name": (delta.get("name") or "").strip(),
                "delta": amount,
            })
        if rows:
            out[mid] = rows
    return out


def _apply_community_and_popular(maps_out: dict[str, dict], community_games: dict) -> None:
    for slug, entry in maps_out.items():
        games = 0
        raw = community_games.get(slug)
        if isinstance(raw, (int, float)):
            games = int(raw)
        entry["community_games"] = games
        entry["play_count"] = int(entry.get("match_count") or 0) + games
        entry["popular"] = False

    eligible = sorted(
        (e for e in maps_out.values() if e["play_count"] >= POPULAR_MIN_PLAYS),
        key=lambda e: (-e["play_count"], e["map_file"]),
    )
    if not eligible:
        return
    cutoff = eligible[min(POPULAR_TOP_N, len(eligible)) - 1]["play_count"]
    for entry in eligible:
        if entry["play_count"] >= cutoff:
            entry["popular"] = True


def _load_community_games(project_root: Path) -> dict[str, int]:
    """F9 per-map game counts keyed by registry slug. Missing file → {}.
    Unjoined titles (`map_key` null) are skipped. Display-only.
    """
    path = project_root / "data" / "external" / "f9_community.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    totals: dict[str, int] = {}
    for row in payload.get("maps") or []:
        if not isinstance(row, dict):
            continue
        key = (row.get("map_key") or "").strip().lower()
        games = row.get("games") or 0
        if not key or not isinstance(games, (int, float)):
            continue
        totals[key] = totals.get(key, 0) + int(games)
    return totals


def _load_f9_duels(project_root: Path) -> dict[str, list]:
    """Community duels keyed by registry slug. `duels[]` already excludes
    games that overlap a recorded match. Unjoined titles are skipped.
    """
    path = project_root / "data" / "external" / "f9_ledger.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    grouped: dict[str, list] = {}
    for duel in payload.get("duels") or []:
        if not isinstance(duel, dict):
            continue
        key = str(duel.get("map_key") or "").strip().lower()
        if not key:
            continue
        grouped.setdefault(key, []).append(duel)
    return grouped


def _commander_entry(raw: dict | None) -> dict | None:
    """Normalise a `team_leaders[<slot>]` dict to the recent_matches
    shape (`{"name", "s64"}`). Returns None when the slot was unfilled
    (no commander on that team for the match) so the renderer can show
    an em-dash.
    """
    if not isinstance(raw, dict):
        return None
    name = (raw.get("name") or "").strip()
    sid = str(raw.get("s64") or "").strip()
    if not name and not sid:
        return None
    return {"name": name, "s64": sid}


def _sort_iso_desc_key(iso: str) -> str:
    """Sort key that breaks ties to the *more recent* ISO timestamp.
    Python's sort is stable; we negate the count separately, but since
    ISO strings can't be negated we use lexicographic descending by
    inverting the string. Cheap trick: prepend "~" so empty sorts last.

    Implementation: return a key that compares HIGHER for OLDER dates
    (so `sorted(asc)` orders newest-first within a count tier). We do
    this by subtracting char codes from a sentinel.
    """
    if not iso:
        return chr(0x10FFFF) * 32  # sort empty as oldest
    # Lexicographic flip: higher chars sort earlier in ascending sort,
    # which is what we want for "newer first". Build a string of the
    # complement codes.
    return "".join(chr(0x10FFFF - ord(c)) for c in iso)


# -- Slug-map persistence (entry-point glue) ----------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _stable_equals(existing: str, new: str) -> bool:
    """JSON equality that ignores `generated_at` drift (mirrors
    `_stable_equals` in `generate_player_pages.py`). Lets us treat
    timestamp churn as a no-op so empty-delta pipeline runs leave the
    file untouched.
    """
    try:
        a = json.loads(existing)
        b = json.loads(new)
    except (json.JSONDecodeError, TypeError):
        return False
    a.pop("generated_at", None)
    b.pop("generated_at", None)
    return a == b


def write_map_stats(map_stats: dict, path: Path) -> bool:
    """Idempotent JSON write. Returns True if a write happened, False
    if the on-disk content was already byte-equivalent (modulo
    `generated_at`). Mirrors the player-slug-map write path.
    """
    payload = json.dumps(map_stats, indent=2, ensure_ascii=False, sort_keys=True)
    if path.exists():
        try:
            existing = path.read_text(encoding="utf-8")
            if _stable_equals(existing, payload):
                return False
        except OSError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload + "\n", encoding="utf-8")
    return True


# -- Main entry point ---------------------------------------------------

def run(
    *,
    all_match_data: list[dict] | None,
    registry: dict | None,
    output_dir: Path,
    project_root: Path,
    pregen_stubs: bool = True,
    elo_history: dict | None = None,
) -> dict:
    """Compute map_stats + persist `data/processed/map_stats.json` +
    (Phase 5) render per-map HTML stubs.

    Phase 2 only emits the map_stats JSON. The `pregen_stubs` argument
    is a placeholder honoured in Phase 5 — until then it's a no-op so
    early callers don't break when Phase 5 lands.

    Returns a summary dict suitable for one-line logging by
    `process_stats.py`. Soft-fails are the caller's responsibility
    (mirrors `generate_player_pages.run`).
    """
    summary = {
        "n_total_maps": 0,
        "n_played_maps": 0,
        "n_unplayed_maps": 0,
        "wrote_map_stats": False,
        "stubs_written": 0,
        "stubs_skipped_unchanged": 0,
        "stubs_eligible": 0,
    }
    if not registry:
        print("  Skipping map_stats (registry empty / unavailable).")
        return summary

    map_stats = compute_map_stats(
        all_match_data or [],
        registry,
        elo_history=elo_history,
        community_games=_load_community_games(project_root),
        f9_duels=_load_f9_duels(project_root),
    )

    summary["n_total_maps"] = len(map_stats["maps"])
    summary["n_played_maps"] = sum(
        1 for v in map_stats["maps"].values() if v.get("play_count", 0) > 0
    )
    summary["n_unplayed_maps"] = (
        summary["n_total_maps"] - summary["n_played_maps"]
    )

    map_stats_path = output_dir / "map_stats.json"
    summary["wrote_map_stats"] = write_map_stats(map_stats, map_stats_path)

    # Phase 5: stub rendering goes here. Stubs depend on map_stats +
    # registry + map_template.html and write to map/<slug>/index.html.
    # `pregen_stubs=False` short-circuits so the run() can also serve
    # as a "stats only" refresh path during development.
    if pregen_stubs:
        try:
            n_written, n_skipped, n_eligible = _render_map_stubs(
                map_stats=map_stats,
                registry=registry,
                project_root=project_root,
            )
            summary["stubs_written"] = n_written
            summary["stubs_skipped_unchanged"] = n_skipped
            summary["stubs_eligible"] = n_eligible
        except FileNotFoundError:
            # Phase 5 lands the template; until then this branch is
            # the documented no-op.
            pass
        except Exception as e:
            print(f"  WARN: failed to render map stubs ({e}); continuing.")

    return summary


# -- Stub HTML rendering ------------------------------------------------

# Sentinel emitted into the OG description for unplayed maps. We still
# render a stub so cross-linking from the gallery works, but the OG
# copy needs to be honest about the absence.
_NO_MATCHES_DESC_SUFFIX = "no matches recorded yet"


def _html_escape(s: str) -> str:
    return (str(s if s is not None else "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&#39;"))


def _meta_attr_escape(s: str) -> str:
    """Same as HTML-escape today; kept as a separate function so a
    future tweak (e.g. line-folding for long descriptions) only
    affects meta blocks."""
    return _html_escape(s)


def _strip_html_for_meta(raw: str) -> str:
    """Strip BOM, collapse <br>/<p> tags into spaces, strip HTML, and
    squash whitespace so registry descriptions (which sometimes carry
    `<br>` from the iondriver source) flatten cleanly into a single-
    line OG description.
    """
    if not raw:
        return ""
    s = str(raw).replace("\ufeff", "")
    s = re.sub(r"<\s*br\s*/?\s*>", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"<\s*/?\s*p\s*>", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _truncate(s: str, limit: int) -> str:
    if not s:
        return ""
    if len(s) <= limit:
        return s
    cut = s[: limit - 1].rstrip()
    return cut + "\u2026"


def _build_og_description(
    map_entry: dict,
    map_stats_entry: dict,
) -> str:
    """OG description format:
        "<author> · <pools>p / <loose> loose · <formatted_size> · <match_count> matches recorded"

    Em-dashes for missing fields; the matches segment is omitted when
    `match_count == 0` and replaced with "no matches recorded yet" so
    Discord/Twitter unfurls don't carry a misleading "0 matches".
    """
    parts: list[str] = []
    author = (map_entry.get("author") or "").strip()
    if author:
        parts.append(author)

    pools = map_entry.get("pools")
    loose = map_entry.get("loose")
    pools_loose: list[str] = []
    if pools is not None:
        pools_loose.append(f"{pools}p")
    if loose is not None:
        pools_loose.append("\u221E loose" if loose < 0 else f"{loose} loose")
    if pools_loose:
        parts.append(" / ".join(pools_loose))

    fsize = (map_entry.get("formatted_size") or "").strip()
    if not fsize:
        cs = map_entry.get("canonical_size")
        if cs is not None:
            fsize = f"~{int(round(cs))}m"
    if fsize:
        parts.append(fsize)

    match_count = int(map_stats_entry.get("match_count") or 0)
    if match_count > 0:
        parts.append(f"{match_count} matches recorded")
    else:
        parts.append(_NO_MATCHES_DESC_SUFFIX)

    desc = " \u00B7 ".join(parts)
    desc = _truncate(desc, 220)  # Discord caps OG description ~300 chars

    # Optional richer prefix from registry description -- only when the
    # core stat row is short enough to leave headroom. Most map titles
    # already convey context, so we keep this lean.
    blurb = _strip_html_for_meta(map_entry.get("description") or "")
    if blurb and len(desc) < 140:
        head = _truncate(blurb, 220 - len(desc) - 3)
        if head:
            desc = f"{head} \u2014 {desc}"
            desc = _truncate(desc, 280)
    return desc


def _resolve_og_image_url(slug: str, project_root: Path) -> str:
    """Per-map OG image URL. We point at `data/maps/<slug>.png` when
    that file is on disk at stub-render time; otherwise fall back to
    the generic `data/og/map-card.png` so unfurls don't 404.
    """
    candidate = project_root / "data" / "maps" / f"{slug}.png"
    if candidate.exists():
        return f"{SITE_URL}/data/maps/{slug}.png"
    return f"{SITE_URL}/data/og/map-card.png"


def _format_stub_html(
    *,
    template: str,
    slug: str,
    title: str,
    map_entry: dict,
    map_stats_entry: dict,
    project_root: Path,
) -> str:
    """Substitute every {{...}} placeholder in `template`. Pure
    function: stable output for the same inputs (so idempotent writes
    short-circuit cleanly when nothing material changed)."""
    canonical_url = f"{SITE_URL}/map/{slug}/"
    og_title = f"{title} \u2014 VT Stats"
    og_desc = _build_og_description(map_entry, map_stats_entry)
    og_image = _resolve_og_image_url(slug, project_root)

    subs = {
        "{{MAP_FILE}}":          slug,
        "{{MAP_TITLE}}":         _html_escape(title),
        "{{MAP_TITLE_HTML}}":    _html_escape(title),
        "{{META_DESCRIPTION}}":  _meta_attr_escape(og_desc),
        "{{CANONICAL_URL}}":     _meta_attr_escape(canonical_url),
        "{{OG_TITLE}}":          _meta_attr_escape(og_title),
        "{{OG_DESCRIPTION}}":    _meta_attr_escape(og_desc),
        "{{OG_IMAGE_URL}}":      _meta_attr_escape(og_image),
        "{{TEMPLATE_VERSION}}":  str(MAP_TEMPLATE_VERSION),
    }
    out = template
    for needle, value in subs.items():
        out = out.replace(needle, value)
    return out


def _render_map_stubs(
    *,
    map_stats: dict,
    registry: dict,
    project_root: Path,
) -> tuple[int, int, int]:
    """Render one `map/<slug>/index.html` stub per map in `map_stats`.

    Returns `(written, skipped_unchanged, eligible)` where:
      - `eligible` is the count of slugs we attempted to render.
      - `skipped_unchanged` is the idempotency hit count -- on-disk
        bytes already matched the rendered template.
      - `written` is the actual write count.

    Slugs that fail the `SLUG_SAFE_RE` filesystem-safety check are
    skipped with a warning (currently zero hits in the corpus).
    """
    template_path = Path(__file__).parent / TEMPLATE_FILENAME
    if not template_path.exists():
        raise FileNotFoundError(
            f"map stub template missing: {template_path}"
        )
    template = template_path.read_text(encoding="utf-8")

    stubs_root = project_root / MAP_STUBS_DIR

    written = 0
    skipped = 0
    eligible = 0

    for slug, stats_entry in (map_stats.get("maps") or {}).items():
        if not slug:
            continue
        # Defensive sanity-check before any filesystem write. The
        # plan's Edge case #5 spells this out: any slug that fails
        # SLUG_SAFE_RE is logged + skipped (no current corpus hits).
        if not SLUG_SAFE_RE.fullmatch(slug):
            print(f"  WARN: skipping stub for unsafe slug {slug!r}")
            continue
        if slug in RESERVED_MAP_SLUGS:
            # Defensive: the slug-resolver above would already have
            # rewritten this to `<slug>-map`; if it leaks through
            # here we still skip.
            print(f"  WARN: skipping stub for reserved slug {slug!r}")
            continue

        eligible += 1
        map_entry = (registry or {}).get(slug) or {}
        title = (
            map_title_resolver(map_entry.get("map_file") or slug, registry)
            if map_entry
            else slug
        )

        stub_html = _format_stub_html(
            template=template,
            slug=slug,
            title=title,
            map_entry=map_entry,
            map_stats_entry=stats_entry,
            project_root=project_root,
        )

        out_dir = stubs_root / slug
        out_path = out_dir / "index.html"
        if out_path.exists():
            try:
                existing = out_path.read_text(encoding="utf-8")
                if existing == stub_html:
                    skipped += 1
                    continue
            except OSError:
                pass
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_text(stub_html, encoding="utf-8")
        written += 1

    return written, skipped, eligible
