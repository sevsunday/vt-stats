"""Pre-aggregator for the axis-analysis explorer (_axis-analysis/index.html).

One-shot script (not wired into the main pipeline). Run manually after
``python scripts/process_stats.py`` to refresh
``_axis-analysis/axis_timeline.json``.

Output is a compact, viz-ready JSON: per-player chronological array of
per-match entries carrying BOTH the raw per-axis value (mirrored from
``scripts/elo.py``'s ``_*_lobby`` preprocessors) AND the post-clip
[-1, +1] z-score that the rating system actually consumed (read straight
out of ``data/processed/elo_history.json`` so the chart can never
disagree with the rating).

Sandbox-mode: lives under ``_axis-analysis/`` (sibling of ``_investigation/``)
so it doesn't disturb the production pipeline or main site bundle. If
this graduates to a real ``/axis/`` route the only changes are output
path + a call from ``scripts/process_stats.py::main()``; the formulas
and JSON shape are deliberately stable.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure ``scripts/`` is importable so we can borrow elo.py's preprocessors
# verbatim -- avoids formula drift between the two surfaces.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from elo import (  # noqa: E402  (sys.path mutation above)
    THUG_WEIGHTS,
    ALPHA_PVE,
    _net_damage_share_lobby,
    _thug_kill_rate_lobby,
    _thug_accuracy_lobby,
    _thug_efficiency_lobby,
    _pve_share_lobby,
    _mobility_lobby,
    _snipe_bonus_lobby,
    _target_lock_pct_lobby,
)


PROCESSED_DIR = REPO_ROOT / "data" / "processed"
ELO_HISTORY   = PROCESSED_DIR / "elo_history.json"
ELO_CURRENT   = PROCESSED_DIR / "elo_current.json"
PLAYER_SLUGS  = PROCESSED_DIR / "player_slugs.json"
OUT_PATH      = Path(__file__).resolve().parent / "axis_timeline.json"

# Files in data/processed/ that are NOT per-match payloads.
NON_MATCH_FILES = {
    "elo_current.json",
    "elo_current_thugs_only.json",
    "elo_history.json",
    "elo_history_thugs_only.json",
    "map_stats.json",
    "matches.json",
    "match_contributions.json",
    "player_slugs.json",
}

# Axis presentation metadata. Order = chart dropdown order = the
# (informal) weight-descending order from THUG_WEIGHTS.
AXIS_META = [
    {
        "key": "target_lock_pct", "label": "T-Key Usage",
        "raw_unit": "ratio_0_1", "y_min": 0.0, "y_max": 1.0,
        "y_axis_label_raw": "Fraction of ticks with active T-key target lock",
        "description": (
            "Share of UpdateTick samples where the player had an active "
            "T-key target lock. Tap-toggled per nearest enemy; persists "
            "until target dies or breaks range."
        ),
    },
    {
        "key": "mobility", "label": "Mobility (activity_score)",
        "raw_unit": "ratio_0_1", "y_min": 0.0, "y_max": 1.0,
        "y_axis_label_raw": "Activity score (0-100 normalized to 0-1)",
        "description": (
            "Positioning-derived activity_score divided by 100. Combines "
            "movement, area coverage, and base-time penalties."
        ),
    },
    {
        "key": "thug_kill_rate", "label": "Thug Kill Rate",
        "raw_unit": "kills_per_min", "y_min": 0.0, "y_max": None,
        "y_axis_label_raw": "Blended kills per minute (pvp + 0.5 * pve)",
        "description": (
            "(pvp_kills + ALPHA_PVE * pve_kills) / minutes. "
            f"ALPHA_PVE = {ALPHA_PVE}."
        ),
    },
    {
        "key": "thug_accuracy", "label": "Thug Accuracy (weapon-normalized)",
        "raw_unit": "ratio_vs_lobby", "y_min": 0.0, "y_max": None,
        "y_axis_label_raw": "Weapon-normalized accuracy ratio vs lobby (1.0 = baseline)",
        "description": (
            "Per-weapon hit-rate ratio vs lobby baseline, weighted by "
            "shot share. PvE hits credited at ALPHA_PVE."
        ),
    },
    {
        "key": "thug_efficiency", "label": "Thug Efficiency",
        "raw_unit": "dmg_ratio", "y_min": 0.0, "y_max": None,
        "y_axis_label_raw": "(pvp_dealt + 0.5 * pve_to_AI) / max(1, dealt - structure)",
        "description": (
            "Dogfight damage efficiency. Structure damage excluded from "
            "denominator (rewarded separately via pve_share)."
        ),
    },
    {
        "key": "pve_share", "label": "PvE Share",
        "raw_unit": "ratio_0_1", "y_min": 0.0, "y_max": 1.0,
        "y_axis_label_raw": "pve_dealt / max(1, total_dealt)",
        "description": (
            "Share of player damage dealt to non-human assets "
            "(structures + mobile AI)."
        ),
    },
    {
        "key": "net_damage_share", "label": "Net Damage Share",
        "raw_unit": "ratio_signed", "y_min": -0.5, "y_max": 1.0,
        "y_axis_label_raw": "(dealt - received) / lobby_total_dealt",
        "description": (
            "Player's net damage divided by total lobby-dealt damage. "
            "Negative when received exceeds dealt."
        ),
    },
    {
        "key": "snipe_bonus", "label": "Snipe Bonus (capped)",
        "raw_unit": "ratio_0_1", "y_min": 0.0, "y_max": 1.0,
        "y_axis_label_raw": "min(snipes / 5, 1.0)",
        "description": (
            "Sniper-rifle kills divided by 5, capped at 1.0 before z-score "
            "so an outlier can't deform the lobby distribution."
        ),
    },
]
AXIS_KEYS = [a["key"] for a in AXIS_META]


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def lobby_filter(leaderboard: list[dict]) -> list[dict]:
    """Mirror compute_performance_index's lobby filter (v2.5).

    Excludes campod-heavy + low-activity rows so the raw values we
    compute use the same denominator as the pipeline's z-scores.
    Commanders STAY (canonical, non-thug-only mode) so we can also
    surface their per-match axis trajectories.
    """
    return [
        p for p in leaderboard
        if not p.get("is_campod")
        and not p.get("is_low_activity")
    ]


def compute_raw_axes(match: dict) -> dict[str, dict[str, float]]:
    """Per-player raw value for each available axis in ONE match.

    Returns ``{player_key: {axis_key: value}}`` where player_key is
    steam64 (preferred) or in-game name fallback. Axes unavailable for
    the entire lobby are omitted from every per-player dict (so the JS
    consumer can simply check ``axis in entry.raw``).
    """
    md = match
    lobby_raw = md.get("leaderboard") or []
    lobby = lobby_filter(lobby_raw)
    if not lobby:
        return {}

    duration_sec = (md.get("match") or {}).get("duration_sec", 0) or 0
    minutes = duration_sec / 60.0

    pos_players = ((md.get("positioning") or {}).get("players") or {})
    snipes_by_player = {
        row.get("name"): int(row.get("count", 0) or 0)
        for row in ((md.get("snipes") or {}).get("by_player") or [])
    }
    has_target_lock = bool((md.get("match") or {}).get("has_target_lock_data"))

    raw = {
        "net_damage_share": _net_damage_share_lobby(lobby),
        "thug_kill_rate":   _thug_kill_rate_lobby(lobby, minutes),
        "thug_accuracy":    _thug_accuracy_lobby(lobby),
        "thug_efficiency":  _thug_efficiency_lobby(lobby),
        "pve_share":        _pve_share_lobby(lobby),
        "mobility":         _mobility_lobby(lobby, pos_players),
        "snipe_bonus":      _snipe_bonus_lobby(lobby, snipes_by_player),
        "target_lock_pct":  _target_lock_pct_lobby(lobby, pos_players, has_target_lock),
    }

    out: dict[str, dict[str, float]] = {}
    for i, p in enumerate(lobby):
        key = str(p.get("steam64") or p.get("name") or "")
        if not key:
            continue
        per_axis: dict[str, float] = {}
        for axis, values in raw.items():
            if values is None:
                continue
            v = values[i]
            if v is None or (isinstance(v, float) and not math.isfinite(v)):
                continue
            per_axis[axis] = round(float(v), 6)
        out[key] = per_axis
    return out


def main() -> None:
    if not ELO_HISTORY.exists():
        print(f"ERROR: {ELO_HISTORY} missing -- run process_stats.py first", file=sys.stderr)
        sys.exit(1)
    if not ELO_CURRENT.exists():
        print(f"ERROR: {ELO_CURRENT} missing", file=sys.stderr)
        sys.exit(1)

    elo_hist  = load_json(ELO_HISTORY)
    elo_curr  = load_json(ELO_CURRENT)
    slug_blob = load_json(PLAYER_SLUGS) if PLAYER_SLUGS.exists() else {"slugs": {}}
    slug_map  = slug_blob.get("slugs") or {}

    # ----- Per-player metadata seeds (from elo_current) -----
    players: dict[str, dict] = {}
    for r in (elo_curr.get("ratings") or []):
        s64 = str(r.get("steam64") or "")
        if not s64:
            continue
        slug_entry = slug_map.get(s64) or {}
        players[s64] = {
            "name":            r.get("name") or slug_entry.get("name") or s64,
            "slug":            slug_entry.get("slug") or "",
            "matches_played":  int(r.get("matches_played") or 0),
            "matches_as_thug": int(r.get("matches_as_thug") or 0),
            "matches_as_commander": int(r.get("matches_as_commander") or 0),
            "current_vtsr":    float(r.get("vtsr") or 0.0),
            "peak_vtsr":       float(r.get("peak_vtsr") or 0.0),
            "axis_means":      r.get("axis_means") or {},
            "matches":         [],
        }

    # ----- Per-match enrichment by id for fast lookup -----
    print(f"Scanning per-match JSONs from {PROCESSED_DIR} ...", file=sys.stderr)
    match_cache: dict[str, dict] = {}
    n_scanned = 0
    for p in sorted(PROCESSED_DIR.iterdir()):
        if not p.is_file() or p.suffix != ".json" or p.name in NON_MATCH_FILES:
            continue
        try:
            md = load_json(p)
        except Exception as e:
            print(f"  skip {p.name}: {e}", file=sys.stderr)
            continue
        mid = (md.get("match") or {}).get("id") or p.stem
        match_cache[mid] = md
        n_scanned += 1
    print(f"  scanned {n_scanned} match JSONs", file=sys.stderr)

    # ----- Walk elo_history.history chronologically -----
    # elo_history is already sorted chronologically by compute_elo so we
    # can read match_index off the iteration position.
    history = elo_hist.get("history") or []
    print(f"Walking {len(history)} history entries ...", file=sys.stderr)

    n_history_with_match = 0
    n_history_excluded = 0
    n_missing_match = 0
    per_player_match_index: dict[str, int] = {}

    for entry in history:
        match_id   = entry.get("match_id") or ""
        match_date = entry.get("match_date") or ""
        is_match_excluded = bool(entry.get("match_excluded"))
        deltas = entry.get("deltas") or []

        if is_match_excluded:
            n_history_excluded += 1
            continue  # match-level gate failed (player_count < 6, etc.)

        match_data = match_cache.get(match_id)
        if not match_data:
            n_missing_match += 1
            continue
        n_history_with_match += 1

        raw_by_player = compute_raw_axes(match_data)
        # Build commander lookup from the source leaderboard (the elo
        # delta rows don't carry is_commander explicitly).
        commander_by_key: dict[str, bool] = {}
        for row in (match_data.get("leaderboard") or []):
            key = str(row.get("steam64") or row.get("name") or "")
            if key:
                commander_by_key[key] = bool(row.get("is_commander"))
        player_count = int((match_data.get("match") or {}).get("player_count") or 0)

        for d in deltas:
            s64 = str(d.get("steam64") or "")
            if not s64 or s64 not in players:
                # Provisional / never-rated -- skip (no axis_means hook).
                continue
            per_player_match_index[s64] = per_player_match_index.get(s64, 0) + 1
            raw = raw_by_player.get(s64, {})
            z   = d.get("axis_contributions") or {}
            players[s64]["matches"].append({
                "match_id":      match_id,
                "date":          match_date,
                "match_index":   per_player_match_index[s64],
                "player_count":  player_count,
                "is_commander":  commander_by_key.get(s64, False),
                "is_excluded":   False,
                "rating_before": round(float(d.get("before") or 0.0), 2),
                "rating_after":  round(float(d.get("after")  or 0.0), 2),
                "delta":         round(float(d.get("delta")  or 0.0), 3),
                "raw":           raw,
                "z":             {k: round(float(v), 4) for k, v in z.items()},
            })

    # ----- Trim players with zero rated matches (legacy / never qualified) -----
    final_players = {
        s64: p for s64, p in players.items()
        if p["matches"]  # only ship players we have at least one match for
    }
    dropped = len(players) - len(final_players)
    if dropped:
        print(f"  dropped {dropped} players with no rated matches", file=sys.stderr)

    # ----- Assemble output -----
    # Weights pulled from elo.py at runtime so this stays in sync if
    # the operator re-tunes them later.
    axes_out = [
        {
            **meta,
            "weight": THUG_WEIGHTS[meta["key"]],
        }
        for meta in AXIS_META
    ]

    out = {
        "schema_version": 1,
        "generated_at":   datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "alpha_pve":      ALPHA_PVE,
        "thug_weights":   dict(THUG_WEIGHTS),
        "axes":           axes_out,
        "counts": {
            "matches_scanned":           n_scanned,
            "history_entries":           len(history),
            "history_matched_to_data":   n_history_with_match,
            "history_match_excluded":    n_history_excluded,
            "history_missing_match":     n_missing_match,
            "players_emitted":           len(final_players),
            "players_dropped_no_data":   dropped,
        },
        "players": final_players,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    size_kb = OUT_PATH.stat().st_size / 1024.0
    print(
        f"Wrote {OUT_PATH.relative_to(REPO_ROOT)} "
        f"({size_kb:.1f} KB, {len(final_players)} players, "
        f"{n_history_with_match} match-deltas)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
