"""Which ladder considers a match: the shared 1v1 / 2v2 / 3+v3+ lines.

Pure module, no I/O. One definition used by the rating ladders, the
validator, the manifest / contribution `match_format` stamp and (through
that stamp) the browser's match picker and Players tab.

Shape = non-campod leaderboard rows per side (slots 1-5 / 6-10), the
same count scripts/elo.py's six-player gate has always used. Campod
spectators never count as a side, however many there are.

  * "1v1"   -- one row per side. scripts/elo_1v1.py rates it (a
               low-activity row does not void a 1v1; the outcome is the
               label).
  * "2v2"   -- two rows per side, each side's slot-1 / slot-6 commander
               row among them, and all four ACTIVE: no row low-activity
               and no thug zero-damage. scripts/elo_2v2.py rates it.
               A 2v2-shaped game with an inactive player is "other".
  * "team"  -- at least TEAM_MIN_PER_SIDE rows per side and at least
               TEAM_MIN_TOTAL in total. scripts/elo.py (VTSR-T) and,
               through elo_history, scripts/elo_commander.py rate it.
  * "other" -- everything else (2v1, 3v1, 3v2, 4v2, 1v0, inactive 2v2).
               No ladder rates it.

"Considers" is not "rated": each ladder still applies its own outcome,
duration, void and cancellation gates.

Decision memo: critique/decisions/vtsr-2v2-ladders.md.
"""

from __future__ import annotations

from typing import Any

TEAM_MIN_PER_SIDE = 3
TEAM_MIN_TOTAL = 6

FORMATS = ("1v1", "2v2", "team", "other")


def slot_side(slot: Any) -> int | None:
    try:
        s = int(slot)
    except (TypeError, ValueError):
        return None
    if 1 <= s <= 5:
        return 1
    if 6 <= s <= 10:
        return 2
    return None


def side_rows(md: dict) -> dict[int, list[dict]]:
    """Non-campod leaderboard rows per side. Missing `is_campod` (legacy)
    counts as playing."""
    sides: dict[int, list[dict]] = {1: [], 2: []}
    for row in md.get("leaderboard") or []:
        if row.get("is_campod"):
            continue
        side = slot_side(row.get("slot"))
        if side is None:
            continue
        sides[side].append(row)
    return sides


def side_counts(md: dict) -> tuple[int, int]:
    sides = side_rows(md)
    return len(sides[1]), len(sides[2])


def is_team_shape(n1: int, n2: int) -> bool:
    return (n1 >= TEAM_MIN_PER_SIDE and n2 >= TEAM_MIN_PER_SIDE
            and n1 + n2 >= TEAM_MIN_TOTAL)


def two_v_two_shape(md: dict) -> dict[int, dict[str, dict]] | None:
    """`{side: {"commander": row, "thug": row}}` when the match has two
    non-campod rows per side and each side's commander row is one of
    them, else None. Activity is NOT checked here (see `two_v_two_players`)."""
    sides = side_rows(md)
    if len(sides[1]) != 2 or len(sides[2]) != 2:
        return None
    out: dict[int, dict[str, dict]] = {}
    for s in (1, 2):
        cmdrs = [r for r in sides[s] if r.get("is_commander")]
        thugs = [r for r in sides[s] if not r.get("is_commander")]
        if len(cmdrs) != 1 or len(thugs) != 1:
            return None
        out[s] = {"commander": cmdrs[0], "thug": thugs[0]}
    return out


def inactive_rows(pair: dict[int, dict[str, dict]]) -> list[dict]:
    """Rows of a 2v2 shape that fail the all-four-active rule."""
    bad = []
    for s in (1, 2):
        for role in ("commander", "thug"):
            row = pair[s][role]
            if row.get("is_low_activity"):
                bad.append(row)
            elif role == "thug" and row.get("is_zero_damage"):
                bad.append(row)
    return bad


def two_v_two_players(md: dict) -> dict[int, dict[str, dict]] | None:
    """Strict 2v2: the shape above with all four players active."""
    pair = two_v_two_shape(md)
    if pair is None or inactive_rows(pair):
        return None
    return pair


def classify_format(md: dict) -> str:
    n1, n2 = side_counts(md)
    if n1 == 1 and n2 == 1:
        return "1v1"
    if n1 == 2 and n2 == 2:
        return "2v2" if two_v_two_players(md) is not None else "other"
    if is_team_shape(n1, n2):
        return "team"
    return "other"
