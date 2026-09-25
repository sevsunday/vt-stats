#!/usr/bin/env python3
"""VT Stats — display-only activity clocks for the ranked ladders.

Pure module (no I/O). ``compute_activity(all_match_data,
external_duels=None)`` walks every corpus ``leaderboard[]`` row (rated
OR not) plus optional F9 ledger duels (commanders and thugs) and
returns a per-player status block plus ``corpus_latest_dt``. The
reference date stays the newest **corpus** match, not wall-clock and
not the newest F9 row.

Two clocks, one shared helper:

  * GLOBAL (90 days, any appearance) — drives VTSR-T ranked eligibility
    and is a floor for VTSR-C. Idle longer than the window relative to
    the newest corpus match → ``inactive``; playing again starts a
    3-game comeback (``returning``) before ``active``.
  * COMMAND (90 days, command appearances) — VTSR-C only. Staying
    active as a thug protects a commander rank for the grace window;
    past that, the commander must command 3 games to re-rank. A
    command-streak also resets when an intervening >90-day global
    inactivity episode sits between two command games (a player who
    quit entirely and returned must re-command, not just resume).

Neither clock changes ratings, K, or match history. Consumers fold
``active`` / ``command_active`` into the existing display-only
``leaderboard_eligible`` flag. Memo:
``critique/decisions/vtsr-inactivity-threshold.md``.

Keyed by steam64 with a ``name.lower()`` fallback so both rating
modules can join. Dual recordings of one physical game (same
``match.id``) count once. F9 rows use the ``f9:<row>`` sentinel.
A lookup miss (never seen in corpus or F9) is **inactive**, not a
free pass onto the ranked table.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# Frozen in critique/decisions/vtsr-inactivity-threshold.md.
# Rating modules pass these through as arguments and also emit them
# top-level so the UI never hardcodes the numbers.
DEFAULT_WINDOW_DAYS = 90
DEFAULT_COMEBACK_GAMES = 3
DEFAULT_CMDR_STALE_DAYS = 90


def parse_match_date(value: str | None) -> datetime | None:
    """Parse a ``match.date`` string into a UTC datetime.

    Mirrors ``scripts/elo.py::_parse_match_date`` so the activity clock
    and the inactivity K-boost agree on the same strings. Returns
    ``None`` on empty / malformed input.
    """
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.strptime(value, "%Y-%m-%d")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _iso_date(dt: datetime | None) -> str:
    if dt is None:
        return ""
    return dt.date().isoformat()


def _days_between(earlier: datetime, later: datetime) -> float:
    return (later - earlier).total_seconds() / 86400.0


def _days_since(last: datetime | None, corpus_latest: datetime | None) -> int:
    if last is None or corpus_latest is None:
        return 0
    return max(0, int(_days_between(last, corpus_latest)))


def _player_keys(row: dict) -> list[str]:
    """Primary steam64, plus name.lower() so lookups can join either way."""
    keys: list[str] = []
    s = row.get("steam64")
    if s:
        keys.append(str(s))
    name = (row.get("name") or "").strip().lower()
    if name:
        keys.append(name)
    return keys


def _is_commander(row: dict, match: dict) -> bool:
    if row.get("is_commander"):
        return True
    leaders = match.get("team_leaders") or {}
    name = (row.get("name") or "").strip().lower()
    s64 = str(row.get("steam64") or "")
    for v in leaders.values():
        if isinstance(v, dict):
            leader_s64 = str(v.get("s64") or v.get("steam64") or "")
            if s64 and leader_s64 and leader_s64 == s64:
                return True
            leader_name = (v.get("name") or "").strip().lower()
            if name and leader_name and leader_name == name:
                return True
        elif isinstance(v, str) and name and v.strip().lower() == name:
            return True
    return False


def _empty_record(window_days: int, comeback_games: int,
                  cmdr_stale_days: int) -> dict[str, Any]:
    """Lookup miss / never seen → inactive. Absence is not a free pass."""
    return {
        "inactive_status": "inactive",
        "days_since_last_match": 0,
        "last_seen_date": "",
        "comeback_games_played": 0,
        "comeback_games_remaining": comeback_games,
        "active": False,
        "command_status": "stale",
        "days_since_last_command": 0,
        "last_command_date": "",
        "command_comeback_games_played": 0,
        "command_comeback_remaining": comeback_games,
        "command_active": False,
        "window_days": window_days,
        "comeback_games": comeback_games,
        "cmdr_stale_days": cmdr_stale_days,
    }


def _status_from_timeline(
    dates: list[datetime],
    corpus_latest: datetime | None,
    window_days: float,
    comeback_games: int,
    *,
    inactive_label: str = "inactive",
    returning_label: str = "returning",
    active_label: str = "active",
    extra_reset: list[tuple[datetime, datetime]] | None = None,
) -> tuple[str, int, bool]:
    """Walk a sorted datetime list; return (status, streak, had_reset).

    ``extra_reset`` is an optional list of (prev, cur) pairs that MUST
    reset the streak even when the pair's own gap is inside ``window_days``
    (the command clock's intervening global-inactivity rule).
    """
    if not dates:
        return inactive_label, 0, False
    extra = set(extra_reset or [])
    streak = 1
    had_reset = False
    for prev, cur in zip(dates, dates[1:]):
        reset = _days_between(prev, cur) > window_days or (prev, cur) in extra
        if reset:
            streak = 1
            had_reset = True
        else:
            streak += 1
    last = dates[-1]
    if (corpus_latest is not None
            and _days_between(last, corpus_latest) > window_days):
        return inactive_label, streak, had_reset
    if had_reset and streak < comeback_games:
        return returning_label, streak, had_reset
    return active_label, streak, had_reset


def _intervening_global_gaps(
    all_dates: list[datetime],
    cmd_dates: list[datetime],
    global_window: float,
) -> list[tuple[datetime, datetime]]:
    """Command-game pairs whose in-between appearance chain has a >window gap."""
    resets: list[tuple[datetime, datetime]] = []
    if len(cmd_dates) < 2:
        return resets
    for prev, cur in zip(cmd_dates, cmd_dates[1:]):
        chain = [prev] + [d for d in all_dates if prev < d < cur] + [cur]
        for a, b in zip(chain, chain[1:]):
            if _days_between(a, b) > global_window:
                resets.append((prev, cur))
                break
    return resets


def _add_appearance(
    appearances: dict[str, dict[str, tuple[datetime, bool]]],
    cid: str,
    match_id: str,
    dt: datetime,
    is_cmd: bool,
) -> None:
    bucket = appearances.setdefault(cid, {})
    prev = bucket.get(match_id)
    if prev is None:
        bucket[match_id] = (dt, is_cmd)
        return
    prev_dt, prev_cmd = prev
    keep_dt = prev_dt if prev_dt <= dt else dt
    bucket[match_id] = (keep_dt, prev_cmd or is_cmd)


def _fold_external_duels(
    external_duels: list[dict] | None,
    appearances: dict[str, dict[str, tuple[datetime, bool]]],
    canonical_id,
) -> None:
    """Add F9 ledger commanders + thugs. Does not move corpus_latest."""
    if not external_duels:
        return
    for duel in external_duels:
        if not isinstance(duel, dict):
            continue
        dt = parse_match_date(duel.get("date") or "")
        if dt is None:
            continue
        row = duel.get("row")
        match_id = f"f9:{row}" if row is not None else f"f9:{_iso_date(dt)}"
        commanders = duel.get("commanders") or {}
        cmd_ids: set[str] = set()
        if isinstance(commanders, dict):
            for person in commanders.values():
                if not isinstance(person, dict):
                    continue
                cid = canonical_id(person)
                if cid is None:
                    continue
                cmd_ids.add(cid)
                _add_appearance(appearances, cid, match_id, dt, True)
        thugs = duel.get("thugs") or {}
        if not isinstance(thugs, dict):
            continue
        for roster in thugs.values():
            if not isinstance(roster, list):
                continue
            for person in roster:
                if not isinstance(person, dict):
                    continue
                cid = canonical_id(person)
                if cid is None or cid in cmd_ids:
                    continue
                _add_appearance(appearances, cid, match_id, dt, False)


def compute_activity(
    all_match_data: list[dict],
    window_days: int = DEFAULT_WINDOW_DAYS,
    comeback_games: int = DEFAULT_COMEBACK_GAMES,
    cmdr_stale_days: int = DEFAULT_CMDR_STALE_DAYS,
    external_duels: list[dict] | None = None,
) -> dict[str, Any]:
    """Build per-player global + command activity clocks.

    ``external_duels`` is the gated F9 ``duels[]`` list (display-only
    appearances). ``corpus_latest`` stays the newest corpus match.

    Returns::

        {
          "by_key": {steam64_or_name_lower: record, ...},
          "empty": record,          # lookup miss → inactive
          "corpus_latest_dt": datetime | None,
          "corpus_latest_date": str,
          "window_days": int,
          "comeback_games": int,
          "cmdr_stale_days": int,
        }
    """
    window = float(window_days)
    stale = float(cmdr_stale_days)

    # player_id -> {match_id: (dt, is_commander)}
    appearances: dict[str, dict[str, tuple[datetime, bool]]] = {}
    # Canonical steam64/name keys that should all point at the same id.
    aliases: dict[str, str] = {}
    next_anon = 0

    def canonical_id(row: dict) -> str | None:
        nonlocal next_anon
        keys = _player_keys(row)
        if not keys:
            return None
        for k in keys:
            if k in aliases:
                cid = aliases[k]
                for k2 in keys:
                    aliases[k2] = cid
                return cid
        cid = keys[0]
        if not cid:
            next_anon += 1
            cid = f"anon:{next_anon}"
        for k in keys:
            aliases[k] = cid
        return cid

    corpus_latest: datetime | None = None
    for md in all_match_data:
        m = md.get("match") or {}
        # Operator void: the game does not count as an appearance and
        # does not move the corpus clock.
        if m.get("void"):
            continue
        dt = parse_match_date(m.get("date"))
        if dt is None:
            continue
        if corpus_latest is None or dt > corpus_latest:
            corpus_latest = dt
        match_id = m.get("id") or f"date:{_iso_date(dt)}"
        lobby = md.get("leaderboard") or []
        for row in lobby:
            cid = canonical_id(row)
            if cid is None:
                continue
            _add_appearance(
                appearances, cid, match_id, dt, _is_commander(row, m)
            )

    _fold_external_duels(external_duels, appearances, canonical_id)

    by_key: dict[str, dict[str, Any]] = {}
    empty = _empty_record(window_days, comeback_games, cmdr_stale_days)

    records_by_cid: dict[str, dict[str, Any]] = {}
    for cid, bucket in appearances.items():
        events = sorted(bucket.values(), key=lambda e: e[0])
        all_dates = [e[0] for e in events]
        cmd_dates = [e[0] for e in events if e[1]]

        g_status, g_streak, _ = _status_from_timeline(
            all_dates, corpus_latest, window, comeback_games,
            inactive_label="inactive",
            returning_label="returning",
            active_label="active",
        )
        extra = _intervening_global_gaps(all_dates, cmd_dates, window)
        c_status, c_streak, _ = _status_from_timeline(
            cmd_dates, corpus_latest, stale, comeback_games,
            inactive_label="stale",
            returning_label="returning",
            active_label="active",
            extra_reset=extra,
        )
        # Never commanded, but we DID see them (thug-only): don't invent
        # a stale commander clock. Lookup-miss uses _empty_record instead.
        if not cmd_dates and all_dates:
            c_status = "active"
            c_streak = 0

        last_seen = all_dates[-1] if all_dates else None
        last_cmd = cmd_dates[-1] if cmd_dates else None
        g_days = _days_since(last_seen, corpus_latest)
        c_days = _days_since(last_cmd, corpus_latest) if last_cmd else 0

        if g_status == "returning":
            g_played = g_streak
            g_remain = max(0, comeback_games - g_streak)
        elif g_status == "inactive":
            g_played = 0
            g_remain = comeback_games
        else:
            g_played = 0
            g_remain = 0

        if c_status == "returning":
            c_played = c_streak
            c_remain = max(0, comeback_games - c_streak)
        elif c_status == "stale":
            c_played = 0
            c_remain = comeback_games
        else:
            c_played = 0
            c_remain = 0

        records_by_cid[cid] = {
            "inactive_status": g_status,
            "days_since_last_match": g_days,
            "last_seen_date": _iso_date(last_seen),
            "comeback_games_played": g_played,
            "comeback_games_remaining": g_remain,
            "active": g_status == "active",
            "command_status": c_status,
            "days_since_last_command": c_days,
            "last_command_date": _iso_date(last_cmd),
            "command_comeback_games_played": c_played,
            "command_comeback_remaining": c_remain,
            "command_active": c_status == "active",
            "window_days": window_days,
            "comeback_games": comeback_games,
            "cmdr_stale_days": cmdr_stale_days,
        }

    for alias, cid in aliases.items():
        rec = records_by_cid.get(cid)
        if rec is not None:
            by_key[alias] = rec

    return {
        "by_key": by_key,
        "empty": empty,
        "corpus_latest_dt": corpus_latest,
        "corpus_latest_date": _iso_date(corpus_latest),
        "window_days": window_days,
        "comeback_games": comeback_games,
        "cmdr_stale_days": cmdr_stale_days,
    }


def lookup_activity(result: dict[str, Any], steam64: Any, name: Any) -> dict[str, Any]:
    """Join a rating row to its activity record. Miss → inactive default."""
    by_key = result.get("by_key") or {}
    empty = result.get("empty") or _empty_record(
        result.get("window_days", DEFAULT_WINDOW_DAYS),
        result.get("comeback_games", DEFAULT_COMEBACK_GAMES),
        result.get("cmdr_stale_days", DEFAULT_CMDR_STALE_DAYS),
    )
    if steam64:
        rec = by_key.get(str(steam64))
        if rec:
            return rec
    n = (name or "").strip().lower()
    if n:
        rec = by_key.get(n)
        if rec:
            return rec
    return empty
