"""Descriptive performance axes (display-only, never a rating input).

Restores the per-match, lobby-z-scored "performance axes" that VTSR-T
used to score before it collapsed to the single ``enemy_damage_share``
axis (v2.14), plus two descriptive extras, as a purely **descriptive**
block for the player profile pages and the Players hub. Nothing in
``scripts/elo.py`` / ``scripts/elo_commander.py`` / ``scripts/elo_1v1.py``
/ ``scripts/elo_2v2.py`` may ever read the output (gated by
``_investigation/check_perf_axes.py``).

The math is deliberately the same the rating used so the numbers keep
their old meaning ("how did this player compare with the lobby that
night"):

* lobby = ``elo._rated_lobby(leaderboard)`` (campod / low-activity /
  zero-damage rows omitted — they get ``perf_axes: None``);
* per axis, raw lobby values from the builder, population z-score
  (``elo._zscore_axis``, sigma 0 -> 0 for everyone), ``clip(z, -2, +2) / 2``
  so every value lands in ``[-1, +1]`` exactly like ``axis_contributions``;
* **no** commander role shift and **no** low-tier at-base lift. Those are
  fairness adjustments the *rating* needs; a description should say what
  happened. Consumers scope by role through the row's ``is_commander``.

Axes available for the whole lobby are emitted; an axis the builder
reports as unavailable (``None``) is omitted from every row's dict for
that match.

Builders:

* ``enemy_damage_share``, ``net_damage_share``, ``thug_kill_rate``,
  ``pve_share``, ``mobility``, ``thug_accuracy``, ``thug_efficiency`` are
  the live ``elo.AXIS_BUILDERS`` entries, called unchanged.
  ``thug_accuracy`` keeps the pre-v2.11 ``has_bullet_hit_data`` gate
  (the v3 collector gap recorded zero BulletHit events).
* ``snipe_bonus`` and ``target_lock_pct`` are the v2.11-retired builders,
  restored verbatim from ``git show 74adb9ece^:scripts/elo.py``.
* ``survivability`` ports ``_compositeSurvivability`` from
  ``js/charts-radar.js`` (60/40 blend of the damage-trade ratio and K/D,
  each clipped at the lobby p95) so the career radar's composite has a
  per-match, lobby-relative sibling.

Output per rated row::

    {"<axis>": {"raw": <float, 4 dp>, "z": <float in [-1, 1], 3 dp>}, ...}

``PERF_AXES_VERSION`` is stamped on every contribution entry so a
consumer can tell which catalog produced the block.
"""

from __future__ import annotations

import math

import elo

PERF_AXES_VERSION = 1

# Display order. Keys are the builder names; the JS catalog in
# js/perf-axes.js carries the labels / copy and must list the same keys.
PERF_AXES = (
    "enemy_damage_share",
    "net_damage_share",
    "thug_kill_rate",
    "thug_efficiency",
    "thug_accuracy",
    "pve_share",
    "survivability",
    "mobility",
    "target_lock_pct",
    "snipe_bonus",
)

# Survivability composite (port of js/charts-radar.js).
SURV_RATIO_WEIGHT = 0.6
SURV_KD_WEIGHT = 0.4


# ---------------------------------------------------------------------------
# Restored v2.11 builders (verbatim from 74adb9ece^:scripts/elo.py)
# ---------------------------------------------------------------------------

def _snipe_bonus_lobby(lobby: list[dict], snipes_by_player: dict) -> list[float] | None:
    """Capped at min(snipes / 5, 1) BEFORE z-score so an outlier can't deform the lobby.

    Returns None if no one sniped (axis omitted via redistribution).
    """
    any_present = False
    out = []
    for p in lobby:
        c = snipes_by_player.get(p.get("name"), 0) or 0
        if c > 0:
            any_present = True
        out.append(min(c / 5.0, 1.0))
    return out if any_present else None


def _target_lock_pct_lobby(
    lobby: list[dict], pos_players: dict, has_target_lock: bool
) -> list[float] | None:
    """Share of the match each player held an active T-key target lock.

    Reads ``positioning.players[name].metrics.target_lock_pct`` (0-1
    ratio). Gated on the match-global ``has_target_lock_data`` flag —
    pre-schema sessions return ``None`` (axis-missing → redistribution).
    """
    if not has_target_lock:
        return None
    any_present = False
    out = []
    for p in lobby:
        metrics = ((pos_players.get(p.get("name")) or {}).get("metrics") or {})
        score = metrics.get("target_lock_pct")
        if score is None:
            out.append(0.0)
        else:
            any_present = True
            out.append(max(0.0, min(1.0, float(score))))
    return out if any_present else None


# ---------------------------------------------------------------------------
# Survivability (port of js/charts-radar.js _compositeSurvivability)
# ---------------------------------------------------------------------------

def _safe_ratio(num: float, den: float) -> float:
    if den > 0:
        return num / den
    return math.inf if num > 0 else 0.0


def _percentile(sorted_finite: list[float], p: float) -> float:
    if not sorted_finite:
        return 1e-6
    idx = min(len(sorted_finite) - 1, int(math.floor(len(sorted_finite) * p)))
    return max(1e-6, sorted_finite[idx])


def _clip_norm(value: float, p95: float) -> float:
    if not p95 > 0:
        return 0.0
    v = value if math.isfinite(value) else p95
    return max(0.0, min(1.0, v / p95))


def _survivability_lobby(lobby: list[dict]) -> list[float] | None:
    """60/40 composite of p95-clipped damage-trade ratio and K/D, in [0, 1].

    The p95 ceilings are taken inside the lobby over the engaged rows
    (someone who dealt or took damage or has a kill or death); spectator
    rows would otherwise drag the percentile down. ``None`` when no row
    engaged at all.
    """
    ratios: list[float] = []
    kds: list[float] = []
    any_engaged = False
    for p in lobby:
        pd = p.get("personal", {}) or {}
        dealt = pd.get("dealt", 0) or 0
        received = pd.get("received", 0) or 0
        kills = p.get("kills", 0) or 0
        deaths = p.get("deaths", 0) or 0
        if not (dealt > 0 or received > 0 or kills > 0 or deaths > 0):
            continue
        any_engaged = True
        r = _safe_ratio(dealt, received)
        k = _safe_ratio(kills, deaths)
        if math.isfinite(r) and r > 0:
            ratios.append(r)
        if math.isfinite(k) and k > 0:
            kds.append(k)
    if not any_engaged:
        return None
    ratios.sort()
    kds.sort()
    ratio_p95 = _percentile(ratios, 0.95)
    kd_p95 = _percentile(kds, 0.95)
    out = []
    for p in lobby:
        pd = p.get("personal", {}) or {}
        dealt = pd.get("dealt", 0) or 0
        received = pd.get("received", 0) or 0
        kills = p.get("kills", 0) or 0
        deaths = p.get("deaths", 0) or 0
        r = _safe_ratio(dealt, received)
        k = _safe_ratio(kills, deaths)
        out.append(
            SURV_RATIO_WEIGHT * _clip_norm(r, ratio_p95)
            + SURV_KD_WEIGHT * _clip_norm(k, kd_p95)
        )
    return out


# ---------------------------------------------------------------------------
# Per-match computation
# ---------------------------------------------------------------------------

def _raw_axes(match_data: dict, lobby: list[dict]) -> dict[str, list[float] | None]:
    m = match_data.get("match") or {}
    duration_sec = m.get("duration_sec", 0) or 0
    minutes = duration_sec / 60.0
    pos_players = ((match_data.get("positioning") or {}).get("players") or {})
    has_bullet_hit = bool(m.get("has_bullet_hit_data", True))
    has_target_lock = bool(m.get("has_target_lock_data", False))
    snipes_by_player = {}
    for row in ((match_data.get("snipes") or {}).get("by_player") or []):
        name = row.get("name")
        if not name:
            continue
        try:
            snipes_by_player[name] = int(row.get("count", 0) or 0)
        except (TypeError, ValueError):
            continue

    builders = elo.AXIS_BUILDERS
    raw: dict[str, list[float] | None] = {}
    for axis in PERF_AXES:
        if axis == "snipe_bonus":
            raw[axis] = _snipe_bonus_lobby(lobby, snipes_by_player)
        elif axis == "target_lock_pct":
            raw[axis] = _target_lock_pct_lobby(lobby, pos_players, has_target_lock)
        elif axis == "survivability":
            raw[axis] = _survivability_lobby(lobby)
        elif axis == "thug_accuracy":
            raw[axis] = builders[axis](lobby, minutes, pos_players) if has_bullet_hit else None
        else:
            raw[axis] = builders[axis](lobby, minutes, pos_players)
    return raw


def compute_perf_axes(match_data: dict) -> dict[str, dict[str, dict[str, float]] | None]:
    """Per-row descriptive axes for one match.

    Returns ``{steam64_or_name_key: {axis: {raw, z}} | None}`` keyed the
    way ``elo._player_key`` keys rows (Steam64 string, falling back to
    the display name). Rows outside the rated lobby map to ``None``.
    """
    leaderboard = match_data.get("leaderboard") or []
    result: dict[str, dict[str, dict[str, float]] | None] = {
        elo._player_key(p): None for p in leaderboard
    }
    lobby = elo._rated_lobby(leaderboard)
    if not lobby:
        return result

    raw = _raw_axes(match_data, lobby)
    per_row: list[dict[str, dict[str, float]]] = [{} for _ in lobby]
    for axis in PERF_AXES:
        vals = raw.get(axis)
        if vals is None:
            continue
        z = elo._zscore_axis(vals)
        for i, (v, zi) in enumerate(zip(vals, z)):
            per_row[i][axis] = {
                "raw": round(float(v), 4),
                "z": round(elo._clip(zi, -2.0, 2.0) / 2.0, 3),
            }
    for i, p in enumerate(lobby):
        result[elo._player_key(p)] = per_row[i]
    return result


def extract_highlight_awards(match_data: dict) -> list[dict]:
    """Slim award slice from ``highlights.cards[]`` for the career rollup.

    One entry per card with a winner: ``{category, winner_steam64,
    winner_name, runner_up_name, value}``. Pair-type winners (Frenemies)
    carry ``winner_steam64: None`` and the pair as ``winner_name`` so the
    aggregator can skip them cleanly.
    """
    out: list[dict] = []
    for card in ((match_data.get("highlights") or {}).get("cards") or []):
        winner = card.get("winner") or {}
        if not winner:
            continue
        if winner.get("type") == "pair":
            name = f"{winner.get('a') or ''} & {winner.get('b') or ''}".strip(" &")
            s64 = None
        else:
            name = winner.get("name")
            s64 = winner.get("steam64")
            s64 = str(s64) if s64 not in (None, "", 0) else None
        if not name:
            continue
        runner = card.get("runner_up") or {}
        out.append({
            "category": card.get("category"),
            "winner_steam64": s64,
            "winner_name": name,
            "runner_up_name": runner.get("name") if isinstance(runner, dict) else None,
            "value": card.get("value"),
        })
    return out
