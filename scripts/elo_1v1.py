"""VTSR-1v1 -- a separate win/loss Elo for head-to-head games.

A 1v1 is two commanders and nothing else, so neither existing ladder
fits it: VTSR-T needs a six-player lobby and VTSR-C carries a thug
team-strength handicap. Both already drop every 1v1 (`low_player_count`
in scripts/elo.py; VTSR-C only rates matches VTSR-T kept), so this
ladder cannot double-count and must never feed back into either.

Pure module, no I/O. `compute_1v1_elo(all_match_data, match_names=None)`
returns `(elo_1v1_current, elo_1v1_history)` dicts ready for `json.dump`.

Recorded corpus only. F9bomber's spreadsheet is deliberately NOT read:
none of its roster-less rows can be proven to be a 1v1 (decision memo
critique/decisions/vtsr-1v1-ladder.md).

Eligible game: not void; exactly one non-campod leaderboard row per
side (slots 1-5 / 6-10); duration >= ONE_V_ONE_MIN_DURATION_SEC;
winner.decided_by in DETERMINED_DECIDED_BY with team 1/2 (or a draw,
0.5 each). A low-activity row does not void the game -- the outcome is
the label. Same-id dual recordings rate once.

Math: classic Elo, scale 400, anchor 1500, no floor. Each game uses ONE
K for both players (the mean of their scheduled K values, 40 -> 20 over
the first ONE_V_ONE_PROVISIONAL_PRIOR games) so every game is exactly
zero-sum.

Output files (written by scripts/process_stats.py, both in the
load_cache_index skip set):
  * data/processed/elo_1v1_current.json
  * data/processed/elo_1v1_history.json

Corpus-wide, picker-unaware, NOT in the pipeline cache key. Algorithm
spec: DEVELOPER_GUIDE.md section 13.15. Output schemas:
docs/DATA_DICTIONARY.md section 18.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import identity_aliases
import inactivity

# ---------------------------------------------------------------------------
# Constants (frozen in critique/decisions/vtsr-1v1-ladder.md)
# ---------------------------------------------------------------------------

ONE_V_ONE_ANCHOR = 1500.0
ONE_V_ONE_K_BASE = 40.0
ONE_V_ONE_K_FLOOR = 20.0
ONE_V_ONE_PROVISIONAL_PRIOR = 5.0
ONE_V_ONE_PROVISIONAL_THRESHOLD = 5
ONE_V_ONE_LOGISTIC_SCALE = 400.0
ONE_V_ONE_MIN_DURATION_SEC = 240

# Display-only ranked-table gate. Do not lower it to fill the table.
ONE_V_ONE_LADDER_MIN_GAMES = 5
INACTIVITY_WINDOW_DAYS = 90
COMEBACK_GAMES_REQUIRED = 3

DETERMINED_DECIDED_BY = ("adjudicated", "attested", "clean_win", "contested")

ELO_1V1_SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def expected_score(r_own: float, r_opp: float) -> float:
    return 1.0 / (1.0 + 10.0 ** (-(r_own - r_opp) / ONE_V_ONE_LOGISTIC_SCALE))


def k_factor(games: int) -> float:
    frac = max(0.0, 1.0 - games / ONE_V_ONE_PROVISIONAL_PRIOR)
    return ONE_V_ONE_K_FLOOR + (ONE_V_ONE_K_BASE - ONE_V_ONE_K_FLOOR) * frac


def _slot_side(slot: Any) -> int | None:
    try:
        s = int(slot)
    except (TypeError, ValueError):
        return None
    if 1 <= s <= 5:
        return 1
    if 6 <= s <= 10:
        return 2
    return None


def one_v_one_players(md: dict) -> dict[int, dict] | None:
    """{1: row, 2: row} when the match has exactly one non-campod
    leaderboard row per side, else None. Shared with the separation gate
    and the validator so the 1v1 definition lives in one place."""
    sides: dict[int, list[dict]] = {1: [], 2: []}
    for row in md.get("leaderboard") or []:
        if row.get("is_campod"):
            continue
        side = _slot_side(row.get("slot"))
        if side is None:
            continue
        sides[side].append(row)
    if len(sides[1]) == 1 and len(sides[2]) == 1:
        return {1: sides[1][0], 2: sides[2][0]}
    return None


def _key(row: dict) -> str:
    s64 = row.get("steam64")
    return str(s64) if s64 else f"name:{row.get('name', '')}"


def _faction_name(m: dict, side: int) -> str | None:
    fac = (m.get("team_factions") or {}).get(str(side))
    return fac.get("name") if isinstance(fac, dict) else None


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def compute_1v1_elo(all_match_data: list[dict],
                    match_names: dict[str, str] | None = None,
                    ) -> tuple[dict, dict]:
    """Chronological 1v1 Elo walk over the recorded corpus.

    `match_names`: optional match id -> display map name (the manifest's
    registry-resolved `name`); falls back to the raw `.bzn` filename.
    """
    names = match_names or {}

    def _sort_key(md: dict) -> tuple:
        m = md.get("match") or {}
        dt = inactivity.parse_match_date(m.get("date"))
        return (dt.timestamp() if dt else 0.0, str(m.get("id") or ""))

    rating: dict[str, float] = {}
    games: dict[str, int] = {}
    wins: dict[str, int] = {}
    losses: dict[str, int] = {}
    draws: dict[str, int] = {}
    peak: dict[str, float] = {}
    peak_at: dict[str, str] = {}
    peak_date: dict[str, str] = {}
    last_match: dict[str, str] = {}
    last_date: dict[str, str] = {}
    last_delta: dict[str, float] = {}
    win_history: dict[str, list[float]] = {}
    display_name: dict[str, str] = {}
    steam64_out: dict[str, str | None] = {}

    skipped = {
        "void": 0,
        "short": 0,
        "cancelled": 0,
        "undetermined": 0,
        "duplicate_recording": 0,
    }
    one_v_one_seen = 0
    rated_ids: set[str] = set()
    duels: list[dict] = []

    for md in sorted(all_match_data, key=_sort_key):
        players = one_v_one_players(md)
        if players is None:
            continue
        m = md.get("match") or {}
        match_id = str(m.get("id") or "")
        one_v_one_seen += 1
        if m.get("void"):
            skipped["void"] += 1
            continue
        if (m.get("duration_sec") or 0) < ONE_V_ONE_MIN_DURATION_SEC:
            skipped["short"] += 1
            continue
        winner = m.get("winner") or {}
        decided_by = winner.get("decided_by")
        team = winner.get("team")
        if decided_by == "cancelled":
            skipped["cancelled"] += 1
            continue
        if decided_by == "draw":
            scores = {1: 0.5, 2: 0.5}
            outcome = "draw"
        elif decided_by in DETERMINED_DECIDED_BY and team in (1, 2):
            scores = {team: 1.0, 3 - team: 0.0}
            outcome = f"team{team}"
        else:
            skipped["undetermined"] += 1
            continue
        if match_id in rated_ids:
            skipped["duplicate_recording"] += 1
            continue

        keys = {s: _key(players[s]) for s in (1, 2)}
        if keys[1] == keys[2]:
            skipped["undetermined"] += 1
            continue
        for s in (1, 2):
            k = keys[s]
            if k not in rating:
                rating[k] = ONE_V_ONE_ANCHOR
                games[k] = wins[k] = losses[k] = draws[k] = 0
                peak[k] = ONE_V_ONE_ANCHOR
            display_name[k] = players[s].get("name") or display_name.get(k, "")
            pinned = identity_aliases.ALIAS_TARGET_NAMES_STR.get(k)
            if pinned:
                display_name[k] = pinned
            if not steam64_out.get(k):
                s64 = players[s].get("steam64")
                steam64_out[k] = str(s64) if s64 else None

        r_before = {s: rating[keys[s]] for s in (1, 2)}
        e1 = expected_score(r_before[1], r_before[2])
        expected = {1: e1, 2: 1.0 - e1}
        # One K per game keeps every game exactly zero-sum.
        k_game = (k_factor(games[keys[1]]) + k_factor(games[keys[2]])) / 2.0
        d1 = k_game * (scores[1] - expected[1])
        deltas = {1: d1, 2: -d1}

        match_date = str(m.get("date") or "")
        side_out: dict[str, dict] = {}
        for s in (1, 2):
            k = keys[s]
            r_after = r_before[s] + deltas[s]
            rating[k] = r_after
            games[k] += 1
            if scores[s] == 1.0:
                wins[k] += 1
            elif scores[s] == 0.0:
                losses[k] += 1
            else:
                draws[k] += 1
            if r_after > peak[k] or k not in peak_at:
                if r_after > peak[k]:
                    peak[k] = r_after
                peak_at[k] = match_id
                peak_date[k] = match_date
            last_match[k] = match_id
            last_date[k] = match_date
            last_delta[k] = deltas[s]
            wh = win_history.setdefault(k, [])
            wh.append(round(deltas[s], 2))
            if len(wh) > 10:
                del wh[: len(wh) - 10]
            side_out[str(s)] = {
                "steam64": steam64_out.get(k),
                "name": display_name.get(k, ""),
                "before": round(r_before[s], 2),
                "after": round(r_after, 2),
                "delta": round(deltas[s], 2),
                "expected": round(expected[s], 4),
                "k": round(k_game, 2),
                "score": scores[s],
            }

        duels.append({
            "match_id": match_id,
            "date": match_date,
            "map": names.get(match_id) or str(m.get("map") or ""),
            "map_file": str(m.get("map") or ""),
            "duration_sec": m.get("duration_sec"),
            "factions": {"1": _faction_name(m, 1), "2": _faction_name(m, 2)},
            "decided_by": decided_by,
            "adjudicated": bool(winner.get("adjudicated")),
            "outcome": outcome,
            "players": side_out,
        })
        rated_ids.add(match_id)

    activity = inactivity.compute_activity(
        all_match_data,
        window_days=INACTIVITY_WINDOW_DAYS,
        comeback_games=COMEBACK_GAMES_REQUIRED,
    )

    ratings_out = []
    for k in rating:
        g = games[k]
        name = display_name.get(k, "")
        s64 = steam64_out.get(k)
        act = inactivity.lookup_activity(activity, s64, name)
        ratings_out.append({
            "name": name,
            "steam64": s64,
            "rating": round(rating[k], 2),
            "games": g,
            "wins": wins[k],
            "losses": losses[k],
            "draws": draws[k],
            "win_pct": round(wins[k] / g, 3) if g else 0.0,
            "peak": round(peak[k], 2),
            "peak_at": peak_at.get(k, ""),
            "peak_date": peak_date.get(k, ""),
            "last_match_id": last_match.get(k, ""),
            "last_1v1_date": last_date.get(k, "")[:10],
            "last_delta": round(last_delta.get(k, 0.0), 2),
            "win_history": list(win_history.get(k, [])),
            "provisional": g < ONE_V_ONE_PROVISIONAL_THRESHOLD,
            "leaderboard_eligible": (
                g >= ONE_V_ONE_LADDER_MIN_GAMES and bool(act["active"])
            ),
            "inactive_status": act["inactive_status"],
            "days_since_last_match": act["days_since_last_match"],
            "last_seen_date": act["last_seen_date"],
            "comeback_games_remaining": act["comeback_games_remaining"],
        })
    ratings_out.sort(key=lambda r: (-r["rating"], r["name"].lower()))

    common = {
        "schema_version": ELO_1V1_SCHEMA_VERSION,
        "computed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "recorded",
        "anchor": ONE_V_ONE_ANCHOR,
        "k_base": ONE_V_ONE_K_BASE,
        "k_floor": ONE_V_ONE_K_FLOOR,
        "provisional_prior": ONE_V_ONE_PROVISIONAL_PRIOR,
        "provisional_threshold": ONE_V_ONE_PROVISIONAL_THRESHOLD,
        "logistic_scale": ONE_V_ONE_LOGISTIC_SCALE,
        "min_duration_sec": ONE_V_ONE_MIN_DURATION_SEC,
        "leaderboard_min_games": ONE_V_ONE_LADDER_MIN_GAMES,
        "inactivity_window_days": INACTIVITY_WINDOW_DAYS,
        "comeback_games_required": COMEBACK_GAMES_REQUIRED,
        "corpus_latest_date": activity["corpus_latest_date"],
        "one_v_one_matches_seen": one_v_one_seen,
        "duels_rated": len(duels),
        "skipped_void": skipped["void"],
        "skipped_short": skipped["short"],
        "skipped_cancelled": skipped["cancelled"],
        "skipped_undetermined": skipped["undetermined"],
        "skipped_duplicate_recording": skipped["duplicate_recording"],
    }
    current = dict(common)
    current["ratings"] = ratings_out
    history = dict(common)
    history["duels"] = duels
    return current, history
