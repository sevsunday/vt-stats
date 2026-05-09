"""VT Stats Rating (VTSR) — pipeline-side combat ELO.

Computed once per pipeline run over the full chronological corpus, and
emitted to ``data/processed/elo_current.json`` (one row per player) plus
``data/processed/elo_history.json`` (per-match deltas for trend / debug).

The dashboard reads ``elo_current.json`` once per session and passes
ratings through the All Matches aggregator unchanged — VTSR is corpus-
wide, *not* picker-filter aware. The picker filter narrows the displayed
roster only.

Algorithm summary (full derivation lives in
``docs/DEVELOPER_GUIDE.md`` §VTSR Methodology):

    VTSR_i = alpha * R^W_i + (1 - alpha) * R^C_i

with ``alpha = 0`` in v1 (Wins ELO stubbed at the league anchor 1500
for every player; the blend math runs through unchanged so a future
``alpha = 0.55`` bump doesn't change any UI strings).

Combat ELO ``R^C_i`` updates per match by

    K_i = K_BASE * (1 - n_i / (n_i + N_PRIOR)) + K_FLOOR
    P_i = sum_a w'_a * clip(z_a(x_{i,a}), -2, +2) / 2     (seven axes)
    dR_raw = K_i * SCALE * (P_i - P_med)
    dR     = dR_raw                              if dR_raw >= 0
             dR_raw * L * phi(R^C_i)             otherwise

where the loss multiplier ``L = 0.85`` (loss aversion) and the soft-floor
taper ``phi(R) = clamp(0, 1, (R - F) / W)`` with ``F = 1000`` and
``W = 150`` so the rating asymptotes toward (but never crosses) the
1000 floor. A defensive ``max(F, R)`` clamp catches float-edge drift.

Excluded matches (``player_count < 6`` or ``duration_sec < 300``) do not
update ratings or increment ``matches_played``; they appear in
``elo_history`` with ``match_excluded: true`` and an empty ``deltas``
list so the exclusion counters reconcile.

This module is pure (no I/O); the writer side lives in
``process_stats.py`` ``main()``.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any


# ---------------------------------------------------------------------------
# Locked constants
# ---------------------------------------------------------------------------

ELO_ANCHOR = 1500.0              # League-wide anchor; every new player starts here.
ELO_K_BASE = 40.0                # Base K-factor (rookie has K = BASE + FLOOR ≈ 52).
ELO_K_FLOOR = 12.0               # Settled-veteran floor on K (matches FIDE rapid).
ELO_PROVISIONAL_PRIOR = 10.0     # K decays toward FLOOR over the first ~10 matches.
ELO_PROVISIONAL_THRESHOLD = 10   # matches_played < this => "Provisional" badge.
ELO_MIN_PLAYER_COUNT = 6         # match excluded from ELO when player_count < 6.
ELO_MIN_DURATION_SEC = 300       # 5-minute minimum.

# Per-match update scale. (P_i - P_med) typically lives in [-0.7, +0.7]
# after the per-axis z-clip-by-2 normalisation, so SCALE = 2.5 lands
# rookie swings around ~52 pts and settled vets around ~18 pts. (Replaces
# a buggy "* 400" in earlier drafts that lifted a chess expected-score
# divisor into the update rule.)
ELO_RATING_SCALE = 2.5

# Loss-aversion asymmetry: when raw dR < 0, multiply by this factor.
# Anchored in Kahneman & Tversky 1979 prospect theory; operational
# precedent in Marvel Rivals SR, Overwatch role queue, League of Legends
# demotion shielding. Mild ~5-8 pts/player/year drift at ~600 league
# matches/year recorded — disclosed in methodology, no need to raise
# RATING_SCALE for "chess.com spread".
ELO_K_LOSS_AVERSION = 0.85

# Soft rating floor with linear taper. Effective loss multiplier is
# clamp(0, 1, (R - FLOOR) / TAPER_WINDOW) — losses go to zero as a
# player approaches FLOOR. Tier 5 spans 1000-1349, so a wider taper (150
# vs the 100-pt taper from earlier drafts) keeps the floor approach
# gradual across the band rather than abrupt at the top of Tier 5.
ELO_RATING_FLOOR = 1000.0
ELO_FLOOR_TAPER_WINDOW = 150.0   # full asymmetric losses restored at FLOOR + 150 (1150).

# Combat composite weights (locked, sum = 1.00). SEVEN axes —
# ``pickup_economy`` deliberately omitted from rating (low signal /
# map-dependent); pickups & destructions remain on contributions for
# Career Highlights (Pod Goblin). The former pickup weight folded into
# pvp_share to lean harder on the anti-PvE-farming signal.
COMBAT_WEIGHTS = {
    "net_damage_share":  0.25,
    "kill_rate":         0.20,
    "accuracy":          0.15,
    "pvp_share":         0.20,
    "mobility":          0.10,
    "snipe_bonus":       0.05,
    "asset_multiplier":  0.05,
}

ALPHA = 0.0   # v1: Wins ELO stubbed at anchor; bump to 0.55 when winner data backfilled.

# Schema version for elo_current.json / elo_history.json. Bump if the
# JSON shape changes downstream (the JS reader checks this).
ELO_SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def k_factor(matches_played: int) -> float:
    """K-factor decay curve. Rookie (n=0) ≈ 52, n=10 → 32, n=50 → ~18.7."""
    n = max(0, int(matches_played))
    return ELO_K_BASE * (1 - n / (n + ELO_PROVISIONAL_PRIOR)) + ELO_K_FLOOR


def floor_taper(rating: float) -> float:
    """Linear taper applied to losses near the rating floor.

    Returns a multiplier in [0, 1]: 0 at FLOOR (full loss damping),
    1 at FLOOR + TAPER_WINDOW and above.
    """
    span = (rating - ELO_RATING_FLOOR) / ELO_FLOOR_TAPER_WINDOW
    if span <= 0.0:
        return 0.0
    if span >= 1.0:
        return 1.0
    return span


def bayesian_kd(kills: int, deaths: int, league_kd: float, prior: float = 10.0) -> float:
    """Bayesian-shrunk K/D with prior strength = ``prior`` deaths at the league mean.

    Shields a 1-match 8/0 player from gaming the leaderboard. Returned in
    "kills per death" units (same as raw KD). Re-exported for use by the
    Career Hustler highlight in ``js/all-matches-aggregator.js``-equivalent
    Python paths and as a shared reference in docs.
    """
    return (kills + prior * league_kd) / (deaths + prior)


def _zscore_axis(values: list[float]) -> list[float]:
    """Population z-score (ddof=0) with sigma=0 fallback to zeros.

    Mirrors the algorithm-hardening contract: when every player ties on an
    axis (rare, e.g. all 0 snipes), nobody's rating moves on that axis.
    """
    n = len(values)
    if n == 0:
        return []
    mu = sum(values) / n
    var = sum((v - mu) ** 2 for v in values) / n
    sigma = math.sqrt(var)
    if sigma < 1e-9:
        return [0.0] * n
    return [(v - mu) / sigma for v in values]


def _clip(x: float, lo: float, hi: float) -> float:
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


# ---------------------------------------------------------------------------
# Per-axis preprocessing (BEFORE z-score)
# ---------------------------------------------------------------------------
#
# Each axis returns a single float per player for one match. ``None``
# means "this axis is unavailable for the entire lobby" (it'll be
# omitted via the weight redistribution rule).
# ---------------------------------------------------------------------------

def _net_damage_share_lobby(lobby: list[dict]) -> list[float]:
    total_dealt = sum(max(0.0, p.get("personal", {}).get("dealt", 0) or 0) for p in lobby)
    denom = max(1.0, total_dealt)
    out = []
    for p in lobby:
        pd = p.get("personal", {}) or {}
        net = (pd.get("dealt", 0) or 0) - (pd.get("received", 0) or 0)
        out.append(net / denom)
    return out


def _kill_rate_lobby(lobby: list[dict], minutes_played: float) -> list[float]:
    minutes = max(1e-3, minutes_played)
    return [(p.get("kills", 0) or 0) / minutes for p in lobby]


def _accuracy_lobby(lobby: list[dict]) -> list[float]:
    out = []
    for p in lobby:
        pd = p.get("personal", {}) or {}
        sf = pd.get("shots_fired", 0) or 0
        sh = pd.get("shots_hit", 0) or 0
        out.append(sh / max(1, sf))
    return out


def _pvp_share_lobby(lobby: list[dict]) -> list[float]:
    out = []
    for p in lobby:
        pd = p.get("personal", {}) or {}
        pvp = pd.get("pvp_dealt", 0) or 0
        total = pd.get("dealt", 0) or 0
        out.append(pvp / max(1.0, total))
    return out


def _mobility_lobby(lobby: list[dict], pos_players: dict) -> list[float] | None:
    """Returns mobility per player in [0, 1]. ``None`` if this match has
    no positioning data for any player (axis-missing → weight redistribution).
    """
    any_present = False
    out = []
    for p in lobby:
        metrics = ((pos_players.get(p.get("name")) or {}).get("metrics") or {})
        score = metrics.get("activity_score")
        if score is None:
            out.append(0.0)
        else:
            any_present = True
            out.append(max(0.0, min(1.0, score / 100.0)))
    return out if any_present else None


def _snipe_bonus_lobby(lobby: list[dict], snipes_by_player: dict) -> list[float] | None:
    """Capped at min(snipes / 5, 1) BEFORE z-score so a 12-snipe outlier
    can't deform the lobby distribution. Returns None if no one sniped
    in this match (axis omitted via redistribution).
    """
    any_present = False
    out = []
    for p in lobby:
        c = snipes_by_player.get(p.get("name"), 0) or 0
        if c > 0:
            any_present = True
        out.append(min(c / 5.0, 1.0))
    return out if any_present else None


def _asset_multiplier_lobby(lobby: list[dict]) -> list[float] | None:
    any_present = False
    out = []
    for p in lobby:
        ad = (p.get("assets", {}) or {}).get("dealt", 0) or 0
        dealt = (p.get("personal", {}) or {}).get("dealt", 0) or 0
        if ad > 0:
            any_present = True
        out.append(ad / max(1.0, dealt))
    return out if any_present else None


# ---------------------------------------------------------------------------
# Performance index per lobby
# ---------------------------------------------------------------------------

def compute_performance_index(match_data: dict) -> tuple[list[float], list[str]]:
    """Compute the per-player performance index ``P_i`` for a single
    match.

    Returns (per_player_P, player_keys) where ``player_keys[i]`` is the
    steam64 (or fallback name) for ``per_player_P[i]``. Pure: no
    side-effects on ``match_data``.
    """
    lobby = match_data.get("leaderboard") or []
    if not lobby:
        return [], []

    duration_sec = (match_data.get("match") or {}).get("duration_sec", 0) or 0
    minutes = duration_sec / 60.0

    pos_players = ((match_data.get("positioning") or {}).get("players") or {})
    snipes_by_player = {
        row.get("name"): int(row.get("count", 0) or 0)
        for row in ((match_data.get("snipes") or {}).get("by_player") or [])
    }

    # Build per-axis raw values lists (one float per player) keyed by axis
    # name. None entries mean the axis is missing for the whole lobby —
    # that axis's weight gets redistributed.
    raw: dict[str, list[float] | None] = {
        "net_damage_share":  _net_damage_share_lobby(lobby),
        "kill_rate":         _kill_rate_lobby(lobby, minutes),
        "accuracy":          _accuracy_lobby(lobby),
        "pvp_share":         _pvp_share_lobby(lobby),
        "mobility":          _mobility_lobby(lobby, pos_players),
        "snipe_bonus":       _snipe_bonus_lobby(lobby, snipes_by_player),
        "asset_multiplier":  _asset_multiplier_lobby(lobby),
    }

    available = [a for a, v in raw.items() if v is not None]
    if not available:
        # Pathological — should be excluded by the duration gate, but
        # belt-and-suspenders: every player gets P = 0, no rating change.
        return [0.0] * len(lobby), [_player_key(p) for p in lobby]

    # Per-axis z-score, clip to [-2, +2], divide by 2 to land in [-1, +1].
    z_by_axis: dict[str, list[float]] = {}
    for axis in available:
        z = _zscore_axis(raw[axis])
        z_by_axis[axis] = [_clip(zi, -2.0, 2.0) / 2.0 for zi in z]

    # Pro-rata weight redistribution so available weights still sum to 1.
    total_available_weight = sum(COMBAT_WEIGHTS[a] for a in available)
    weights = {a: COMBAT_WEIGHTS[a] / total_available_weight for a in available}

    perf = []
    for i in range(len(lobby)):
        p = sum(weights[a] * z_by_axis[a][i] for a in available)
        perf.append(p)

    return perf, [_player_key(p) for p in lobby]


def _player_key(p: dict) -> str:
    """Primary steam64 with name fallback (legacy rows missing steam64)."""
    s = p.get("steam64")
    if s:
        return str(s)
    return p.get("name") or ""


# ---------------------------------------------------------------------------
# Top-level rating loop
# ---------------------------------------------------------------------------

def compute_elo(all_match_data: list[dict]) -> tuple[dict, dict]:
    """Walk ``all_match_data`` chronologically, applying the ELO update
    rule per match, and return the (current, history) JSON-ready dicts.

    Match order is determined by ``(match.date, match.id)`` — ELO is
    path-dependent and a re-ordering would change every downstream
    rating, so the composite key handles same-second imports
    deterministically.
    """
    # Sort chronologically, ties broken by match id.
    matches = sorted(
        list(all_match_data),
        key=lambda md: (
            (md.get("match") or {}).get("date", ""),
            (md.get("match") or {}).get("id", ""),
        ),
    )

    # Per-player rating state. Combat ELO accumulates across matches;
    # display name and last-seen steam64 are tracked for the output row.
    combat_elo: dict[str, float] = defaultdict(lambda: ELO_ANCHOR)
    matches_played: dict[str, int] = defaultdict(int)
    display_name: dict[str, str] = {}
    steam64_for_key: dict[str, str | None] = {}
    last_match_id: dict[str, str] = {}
    last_delta: dict[str, float] = {}
    peak_vtsr: dict[str, float] = defaultdict(lambda: ELO_ANCHOR)
    peak_at: dict[str, str] = {}
    win_history: dict[str, list[float]] = defaultdict(list)

    history_entries: list[dict] = []

    excluded_low_player_count = 0
    excluded_short_duration   = 0
    excluded_no_winner        = 0  # reserved (alpha-blend slot); always 0 in v1

    for md in matches:
        m = md.get("match") or {}
        lobby = md.get("leaderboard") or []
        match_id = m.get("id", "")
        match_date = m.get("date", "")

        # Match-exclusion gates. Player count < 6 OR duration < 300s →
        # don't update ratings or increment matches_played, but still
        # emit a history row so exclusion counters reconcile.
        excluded = False
        if (m.get("player_count", 0) or 0) < ELO_MIN_PLAYER_COUNT:
            excluded_low_player_count += 1
            excluded = True
        elif (m.get("duration_sec", 0) or 0) < ELO_MIN_DURATION_SEC:
            excluded_short_duration += 1
            excluded = True

        if excluded:
            history_entries.append({
                "match_id":        match_id,
                "match_date":      match_date,
                "match_excluded":  True,
                "exclusion_reason": (
                    "low_player_count" if (m.get("player_count", 0) or 0) < ELO_MIN_PLAYER_COUNT
                    else "short_duration"
                ),
                "deltas": [],
            })
            continue

        perfs, keys = compute_performance_index(md)
        if not perfs:
            history_entries.append({
                "match_id":         match_id,
                "match_date":       match_date,
                "match_excluded":   True,
                "exclusion_reason": "empty_lobby",
                "deltas": [],
            })
            continue

        # Median P used as the "expected" performance the per-player
        # update fans out around. Population-statistic, deterministic.
        p_med = _median(perfs)

        # Update each player's combat ELO and emit a delta row.
        match_deltas = []
        for i, key in enumerate(keys):
            n_before = matches_played[key]
            r_before = combat_elo[key]
            ki = k_factor(n_before)
            dr_raw = ki * ELO_RATING_SCALE * (perfs[i] - p_med)
            if dr_raw >= 0:
                dr = dr_raw
            else:
                dr = dr_raw * ELO_K_LOSS_AVERSION * floor_taper(r_before)
            r_after = r_before + dr
            # Defensive clamp — math drives losses asymptotically to FLOOR
            # but float arithmetic at the boundary could otherwise dip below.
            if r_after < ELO_RATING_FLOOR:
                r_after = ELO_RATING_FLOOR

            combat_elo[key] = r_after
            matches_played[key] = n_before + 1
            last_match_id[key] = match_id
            last_delta[key] = dr
            display_name[key] = lobby[i].get("name") or display_name.get(key, "")
            if not steam64_for_key.get(key):
                steam64_for_key[key] = lobby[i].get("steam64")
            if r_after > peak_vtsr[key]:
                peak_vtsr[key] = r_after
                peak_at[key] = match_id
            elif key not in peak_at:
                peak_at[key] = match_id
            wh = win_history[key]
            wh.append(round(dr, 2))
            if len(wh) > 10:
                del wh[: len(wh) - 10]

            match_deltas.append({
                "name":        display_name[key],
                "steam64":     steam64_for_key.get(key),
                "before":      round(r_before, 2),
                "after":       round(r_after, 2),
                "delta":       round(dr, 2),
                "performance": round(perfs[i], 4),
            })

        history_entries.append({
            "match_id":       match_id,
            "match_date":     match_date,
            "match_excluded": False,
            "deltas":         match_deltas,
        })

    # ----- Build elo_current.json shape -----
    ratings = []
    for key in combat_elo:
        c_elo = combat_elo[key]
        n     = matches_played[key]
        # Final VTSR = blend(R^W, R^C). R^W stubbed at anchor in v1.
        wins_elo = ELO_ANCHOR
        vtsr = ALPHA * wins_elo + (1.0 - ALPHA) * c_elo
        ratings.append({
            "name":             display_name.get(key, ""),
            "steam64":          steam64_for_key.get(key),
            "vtsr":             round(vtsr, 1),
            "combat_elo":       round(c_elo, 1),
            "wins_elo":         round(wins_elo, 1),
            "matches_played":   n,
            "matches_provisional": n < ELO_PROVISIONAL_THRESHOLD,
            "last_match_id":    last_match_id.get(key, ""),
            "last_delta":       round(last_delta.get(key, 0.0), 2),
            "peak_vtsr":        round(peak_vtsr.get(key, ELO_ANCHOR), 1),
            "peak_at":          peak_at.get(key, ""),
            "win_history":      list(win_history.get(key, [])),
        })

    # Sort by VTSR desc, then name asc (deterministic).
    ratings.sort(key=lambda r: (-r["vtsr"], (r["name"] or "").lower()))

    rated_match_count = sum(1 for h in history_entries if not h["match_excluded"])
    elo_current = {
        "schema_version":     ELO_SCHEMA_VERSION,
        "alpha":              ALPHA,
        "anchor":             ELO_ANCHOR,
        "rating_scale":       ELO_RATING_SCALE,
        "k_loss_aversion":    ELO_K_LOSS_AVERSION,
        "rating_floor":       ELO_RATING_FLOOR,
        "floor_taper_window": ELO_FLOOR_TAPER_WINDOW,
        "k_base":             ELO_K_BASE,
        "k_floor":            ELO_K_FLOOR,
        "provisional_prior":  ELO_PROVISIONAL_PRIOR,
        "provisional_threshold": ELO_PROVISIONAL_THRESHOLD,
        "min_player_count":   ELO_MIN_PLAYER_COUNT,
        "min_duration_sec":   ELO_MIN_DURATION_SEC,
        "computed_at":        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "match_count":        rated_match_count,
        "matches_excluded_low_player_count": excluded_low_player_count,
        "matches_excluded_short_duration":   excluded_short_duration,
        "matches_excluded_no_winner":        excluded_no_winner,
        "weights":            dict(COMBAT_WEIGHTS),
        "ratings":            ratings,
    }

    elo_history = {
        "schema_version": ELO_SCHEMA_VERSION,
        "history":        history_entries,
    }

    return elo_current, elo_history


def _median(values: list[float]) -> float:
    """Population median. Pure numpy-free implementation so this module
    has no external deps.
    """
    n = len(values)
    if n == 0:
        return 0.0
    s = sorted(values)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2.0
