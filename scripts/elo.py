"""VTSR-T (VT Stats Rating - Thug): pipeline-side Thug ELO.

Computes a per-player rating from chronological match data using an
eight-axis thug composite + ELO-style updates with loss aversion and a
soft floor. Pure module (no I/O); writer lives in process_stats.py.

The published rating is ``VTSR-T = alpha * R^W + (1 - alpha) * R^T``.
With ``alpha = 0`` (current ship), VTSR-T collapses to the Thug ELO
``R^T``. JSON exposes the blended value as ``vtsr`` for a stable wire
name.

Per-match update:

    K_i    = K_BASE * (1 - n_i / (n_i + N_PRIOR)) + K_FLOOR
    P_i    = sum_a w'_a * z'_{i,a}
    Rbar_i = median{R^T_j : j != i}
    E_i    = 2 / (1 + 10^((Rbar_i - R^T_i) / S_R)) - 1
    dR     = K_i * S_O * (P_i - E_i),  scaled by L * phi(R^T_i) when negative

v2.4 (current): per-match commander role adjustment. For each commander
match-row, post-clip per-axis z-scores get shifted by the negation of a
typical-commander baseline (then re-clipped to [-1, +1]). 4 audit-derived
priors apply with shrinkage strength 30; 2 hand-tuned priors are locked
(no shrinkage); 2 axes (thug_accuracy, snipe_bonus) are role-blind.
Math: for commander row i and shifted axis a:
    z'_{i,a} = clip(clip(z_{i,a}, -2, +2) / 2  -  baseline[a],  -1, +1)
For thug rows or omitted axes, z'_{i,a} = clip(z_{i,a}, -2, +2) / 2.

Matches with ``player_count < 6`` or ``duration_sec < 300`` don't update
ratings; they emit a history row with ``match_excluded: true`` so
exclusion counters reconcile.

Full derivation: ``DEVELOPER_GUIDE.md`` §13. Output schemas:
``docs/DATA_DICTIONARY.md`` §11.
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
ELO_K_FLOOR = 12.0               # Settled-veteran floor on K (typical provisional settle band).
ELO_PROVISIONAL_PRIOR = 10.0     # K decays toward FLOOR over the first ~10 matches.
ELO_PROVISIONAL_THRESHOLD = 10   # matches_played < this => "Provisional" badge.
ELO_MIN_PLAYER_COUNT = 6         # match excluded from ELO when player_count < 6.
ELO_MIN_DURATION_SEC = 300       # 5-minute minimum.

# Per-match outcome scale; bounds dR via (P_i - E_i) which lives in roughly [-1, +1].
ELO_RATING_SCALE = 2.5

# Rating-logistic scale for the expected-performance curve. Calibrated
# for our small (~25-player) league with continuous P_i scoring; lower
# values amplify rating differences, higher values dampen them.
ELO_LOGISTIC_SCALE = 800.0

# When raw dR < 0, multiply by this factor (loss aversion).
ELO_K_LOSS_AVERSION = 0.85

# Soft rating floor with linear taper. Loss multiplier =
# clamp(0, 1, (R - FLOOR) / TAPER_WINDOW); losses go to zero as R -> FLOOR.
ELO_RATING_FLOOR = 1000.0
ELO_FLOOR_TAPER_WINDOW = 150.0

# Fractional weight for PvE work in the three thug axes
# (thug_kill_rate, thug_accuracy, thug_efficiency). PvE damage / kills /
# hits count at this fraction of equivalent PvP work. Lobby z-scoring
# still rewards exceptional PvE on its own. Surfaced in elo_current.json
# for auditability; tunable without a schema bump.
ALPHA_PVE = 0.5

# Thug composite weights (locked, sum = 1.00). Per-row inline comments
# describe what each axis measures.
THUG_WEIGHTS = {
    "net_damage_share":  0.20,   # damage you dealt minus what you took, vs lobby total
    "thug_kill_rate":    0.20,   # (pvp_kills + ALPHA_PVE * pve_kills) / minutes
    "thug_accuracy":     0.15,   # weapon-normalized hit-rate ratio vs lobby; alpha-blended
    "thug_efficiency":   0.16,   # (pvp_dealt + α * pve_to_AI) / max(1, total - structure)
    "pve_share":         0.12,   # pve_dealt / total_dealt (asset disruption)
    "mobility":          0.08,   # activity_score from positioning data
    "snipe_bonus":       0.05,   # capped sniper-rifle hits
    "target_lock_pct":   0.04,   # T-key situational-awareness proxy
}

ALPHA = 0.0   # Wins-ELO blend weight. Stubbed at 0 until winner data lands.

# v2.4: per-match commander role adjustment. For each commander row and
# each axis listed in COMMANDER_AXIS_PRIOR, the post-clip z-score is
# shifted by ``-baseline[axis]`` then re-clipped to ``[-1, +1]``. Values
# below are in **post-clip space** (i.e. after ``clip(z, -2, +2) / 2``)
# so they share units with the audit's measurement space. Asymmetric by
# design - see DEVELOPER_GUIDE.md §13 v2.4 for the full rationale.
COMMANDER_AXIS_PRIOR = {
    # ---- Audit-derived structural penalty relief (use shrinkage strength 30).
    # Commanders are tied to base / building / not in dedicated combat ships,
    # so we don't ding them as hard for the natural commander shortfall.
    "mobility":         -0.488,
    "thug_kill_rate":   -0.164,
    "net_damage_share": -0.131,
    "thug_efficiency":  -0.106,

    # ---- Hand-tuned: T-key cushion (LOCKED, no shrinkage).
    # Audit said -0.466 (n=116), but T-key is universally available and
    # commanders are common targets - they should be locking nearly as
    # much as thugs. We pin a small cushion that doesn't fully accommodate
    # the empirical reality. Locked so this design intent doesn't drift
    # toward empirical over time.
    "target_lock_pct":  -0.10,

    # ---- Hand-tuned: PvE reward boost (LOCKED, no shrinkage).
    # Audit said +0.111 (commanders naturally do more PvE). We invert the
    # sign so this becomes a +0.05 reward shift on commander rows: hitting
    # enemy assets is the work commanders SHOULD do, so we actively reward
    # it instead of dampening it. Locked so the boost intent doesn't fade
    # (and worse, silently flip into a dampener) as the running mean drifts.
    "pve_share":        -0.05,

    # ---- Omitted (role-blind by design).
    # thug_accuracy: empirical +0.069 below noise floor at current corpus
    # size (std 0.46, SE ~0.04). snipe_bonus: empirical +0.28 unreliable
    # on n=22 commander rows. Treat both as role-blind until the data
    # clearly warrants an adjustment.
}

# Shrinkage strength (in pseudo-observations) for audit-derived axes.
# Live data takes over the seed prior smoothly as the corpus grows.
COMMANDER_BASELINE_SHRINKAGE = 30.0

# Axes whose prior is hand-tuned and should NOT drift toward live empirical
# data over time. These always use the seed value from COMMANDER_AXIS_PRIOR.
# The running mean is still tracked (visibility only) so anyone reading
# elo_current.json can see when reality has diverged enough from intent
# to warrant a seed-value revisit.
COMMANDER_BASELINE_LOCKED_AXES = {"target_lock_pct", "pve_share"}

# Bump if elo_current.json / elo_history.json shape changes (the JS
# reader checks this).
ELO_SCHEMA_VERSION = 5


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def k_factor(matches_played: int) -> float:
    """K-factor decay curve. Rookie (n=0) ≈ 52, n=10 → 32, n=50 → ~18.7."""
    n = max(0, int(matches_played))
    return ELO_K_BASE * (1 - n / (n + ELO_PROVISIONAL_PRIOR)) + ELO_K_FLOOR


def floor_taper(rating: float) -> float:
    """Linear loss-damping multiplier in [0, 1]: 0 at FLOOR, 1 at FLOOR + TAPER_WINDOW."""
    span = (rating - ELO_RATING_FLOOR) / ELO_FLOOR_TAPER_WINDOW
    if span <= 0.0:
        return 0.0
    if span >= 1.0:
        return 1.0
    return span


def expected_performance(r_i: float, r_opponents_ref: float) -> float:
    """Logistic expected-performance curve, mapped to ``[-1, +1]``.

        E_i = 2 / (1 + 10^((Rbar_i - R_i) / S_R)) - 1

    Matches the composite-performance range ``P_i in [-1, +1]``: 0 when
    R_i equals the reference, ~+0.5 at S_R points above, asymptotes to
    +1 / -1 for extreme rating gaps. Subtracting from P_i rewards
    over-performance relative to expectations.
    """
    exponent = (r_opponents_ref - r_i) / ELO_LOGISTIC_SCALE
    # Clamp to avoid 10**x overflow on pathological inputs (real corpus
    # never reaches this; |R - Rbar| caps at ~1500 -> exponent ~3.75).
    if exponent > 16.0:
        return -1.0
    if exponent < -16.0:
        return 1.0
    return 2.0 / (1.0 + 10.0 ** exponent) - 1.0


def _median(values: list[float]) -> float:
    """Population median (numpy-free)."""
    n = len(values)
    if n == 0:
        return 0.0
    s = sorted(values)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2.0


def bayesian_kd(kills: int, deaths: int, league_kd: float, prior: float = 10.0) -> float:
    """Bayesian-shrunk K/D with prior strength = ``prior`` deaths at the league mean.

    Shields a 1-match 8/0 player from gaming the leaderboard. Returned
    in "kills per death" units.
    """
    return (kills + prior * league_kd) / (deaths + prior)


def _zscore_axis(values: list[float]) -> list[float]:
    """Population z-score (ddof=0). Returns zeros when sigma=0 (every player ties)."""
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


def commander_shrunk_baseline(
    axis: str, running_sum: float, running_count: int
) -> float:
    """Shrunk baseline for a commander-shifted axis (post-clip space).

    LOCKED axes (``COMMANDER_BASELINE_LOCKED_AXES``) always return the
    seed prior - their design intent is hand-tuned and should never drift
    toward live empirical mean. Audit-derived axes blend the seed prior
    with the running mean of observed pre-shift commander z-scores using
    shrinkage strength ``COMMANDER_BASELINE_SHRINKAGE``:

        baseline[a] = (n * running_mean[a] + s * prior[a]) / (n + s)

    With ``n = 0`` (no commander rows seen yet) the baseline equals the
    prior; as ``n`` grows the baseline tracks live empirical reality.
    """
    prior = COMMANDER_AXIS_PRIOR[axis]
    if axis in COMMANDER_BASELINE_LOCKED_AXES:
        return prior
    if running_count <= 0:
        return prior
    running_mean = running_sum / running_count
    s = COMMANDER_BASELINE_SHRINKAGE
    return (running_count * running_mean + s * prior) / (running_count + s)


# ---------------------------------------------------------------------------
# Per-axis preprocessing (BEFORE z-score)
# ---------------------------------------------------------------------------
# Each axis returns one float per player for one match. ``None`` means
# "axis unavailable for the entire lobby" — its weight gets redistributed
# across the available axes in compute_performance_index.

def _net_damage_share_lobby(lobby: list[dict]) -> list[float]:
    total_dealt = sum(max(0.0, p.get("personal", {}).get("dealt", 0) or 0) for p in lobby)
    denom = max(1.0, total_dealt)
    out = []
    for p in lobby:
        pd = p.get("personal", {}) or {}
        net = (pd.get("dealt", 0) or 0) - (pd.get("received", 0) or 0)
        out.append(net / denom)
    return out


def _thug_kill_rate_lobby(lobby: list[dict], minutes_played: float) -> list[float]:
    """Alpha-blended kill rate: (pvp_kills + α·pve_kills) / minutes.

    Falls back to flat ``kills`` when pvp/pve fields are absent (legacy data).
    """
    minutes = max(1e-3, minutes_played)
    out = []
    for p in lobby:
        pd = p.get("personal", {}) or {}
        if "pvp_kills" in pd or "pve_kills" in pd:
            pvp_k = pd.get("pvp_kills", 0) or 0
            pve_k = pd.get("pve_kills", 0) or 0
            blended = pvp_k + ALPHA_PVE * pve_k
        else:
            blended = p.get("kills", 0) or 0
        out.append(blended / minutes)
    return out


def _thug_accuracy_lobby(lobby: list[dict]) -> list[float]:
    """Weapon-normalized accuracy with alpha-blended PvE hits.

    For each player p and each weapon w they fired, take the ratio of
    p's combat-weighted accuracy vs the lobby's combat-weighted accuracy
    on that weapon. Combat-weighted hits = ``pvp_hits + α * pve_hits``.
    Player score is the shot-share-weighted mean of those ratios:

        pwa_p = (Σ_w (p_combat_acc_w / lobby_combat_acc_w) * weight_w) / Σ_w weight_w
        weight_w = p_shots_w / p_total_shots

    Robust to weapon-mix bias — sniper mains aren't penalized for the
    rifle's natural lower hit rate.

    Edge cases:
      * Player fired zero shots → 0.0.
      * Weapon with no lobby signal → dropped from the player's pwa;
        ``used_weight == 0`` → 0.0.
      * Pre-pvp_hits weapon_breakdown rows treat all hits as PvP-equivalent.
    """
    from collections import defaultdict as _dd
    lobby_shots_w: dict[str, int] = _dd(int)
    lobby_thug_hits_w: dict[str, float] = _dd(float)

    for p in lobby:
        for w, wd in (p.get("weapon_breakdown") or {}).items():
            shots = wd.get("shots", 0) or 0
            hits = wd.get("hits", 0) or 0
            if "pvp_hits" in wd:
                pvp_h = wd.get("pvp_hits", 0) or 0
                pve_h = max(0, hits - pvp_h)
                thug_h = pvp_h + ALPHA_PVE * pve_h
            else:
                thug_h = hits  # legacy: count all hits at full weight
            lobby_shots_w[w] += shots
            lobby_thug_hits_w[w] += thug_h

    out = []
    for p in lobby:
        wb = p.get("weapon_breakdown") or {}
        total_player_shots = sum((wd.get("shots", 0) or 0) for wd in wb.values())
        if total_player_shots <= 0:
            out.append(0.0)
            continue
        score_num = 0.0
        used_weight = 0.0
        for w, wd in wb.items():
            p_shots = wd.get("shots", 0) or 0
            if p_shots <= 0:
                continue
            if "pvp_hits" in wd:
                p_pvp_h = wd.get("pvp_hits", 0) or 0
                p_pve_h = max(0, (wd.get("hits", 0) or 0) - p_pvp_h)
                p_thug_h = p_pvp_h + ALPHA_PVE * p_pve_h
            else:
                p_thug_h = wd.get("hits", 0) or 0
            l_shots = lobby_shots_w.get(w, 0)
            l_thug_h = lobby_thug_hits_w.get(w, 0)
            if l_shots <= 0 or l_thug_h <= 0:
                continue  # no lobby signal for this weapon → drop
            player_acc = p_thug_h / p_shots
            lobby_acc = l_thug_h / l_shots
            ratio = player_acc / lobby_acc  # >=0; 1.0 = matches lobby baseline
            weight = p_shots / total_player_shots
            score_num += ratio * weight
            used_weight += weight
        if used_weight <= 0:
            out.append(0.0)
        else:
            out.append(score_num / used_weight)
    return out


def _thug_efficiency_lobby(lobby: list[dict]) -> list[float]:
    """Alpha-blended dogfight efficiency, structure damage excluded from denom.

        thug_efficiency_p = (pvp_dealt + α * pve_to_AI) / max(1, total - structure)

    Where ``pve_to_AI ≈ pve_dealt - structure_dealt`` (mobile AI damage).
    Structure-busters' work is rewarded via ``pve_share`` instead of
    diluting their efficiency score here.
    """
    out = []
    for p in lobby:
        pd = p.get("personal", {}) or {}
        pvp_d = pd.get("pvp_dealt", 0) or 0
        total = pd.get("dealt", 0) or 0
        struct = pd.get("structure_dealt", 0) or 0
        pve_to_ai = max(0.0, (pd.get("pve_dealt", 0) or 0) - struct)
        numer = pvp_d + ALPHA_PVE * pve_to_ai
        denom = max(1.0, total - struct)
        out.append(numer / denom)
    return out


def _mobility_lobby(lobby: list[dict], pos_players: dict) -> list[float] | None:
    """Mobility per player in [0, 1]. ``None`` if no positioning data for any player."""
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


def _pve_share_lobby(lobby: list[dict]) -> list[float] | None:
    """Player-dealt damage to enemy non-human assets / total dealt.

    Covers structures + mobile AI (Scavengers, Producers, Extractors,
    AI tanks). Sources from ``personal.pve_dealt`` (already excludes
    player-owned-AI damage).

    Returns ``None`` when no player dealt PvE damage — axis-missing
    triggers weight redistribution.
    """
    any_present = False
    out = []
    for p in lobby:
        pd = p.get("personal", {}) or {}
        pve_d = pd.get("pve_dealt", 0) or 0
        total = pd.get("dealt", 0) or 0
        if pve_d > 0:
            any_present = True
        out.append(pve_d / max(1.0, total))
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
# Performance index per lobby
# ---------------------------------------------------------------------------

def compute_performance_index(
    match_data: dict,
    commander_baseline_snapshot: dict[str, float] | None = None,
) -> tuple[
    list[float],
    list[str],
    list[dict[str, float]],
    list[dict[str, dict[str, float]]],
]:
    """Compute the per-player performance index ``P_i`` for a single match.

    Returns ``(per_player_P, player_keys, per_player_axis_z, per_player_axis_meta)``:
      * ``per_player_P[i]`` — composite score in [-1, +1]
      * ``player_keys[i]`` — steam64 (or fallback name)
      * ``per_player_axis_z[i]`` — ``{axis_name: z_post_shift}`` after
        clip-and-divide-by-2 AND v2.4 commander shift. Each value in
        [-1, +1]. Axes unavailable for the entire lobby are OMITTED;
        consumers treat absence as "axis unavailable in this match".
        For thug rows the value is ``z_pre_shift`` unchanged; for
        commander rows on shifted axes it's the post-shift, re-clipped z.
      * ``per_player_axis_meta[i]`` — forensic per-axis breakdown for
        commander rows on shifted axes only: ``{axis: {z_pre_shift,
        shift, z_post_shift}}``. Empty dict for thug rows or for axes
        omitted from ``COMMANDER_AXIS_PRIOR``.

    v2.4 commander adjustment: when ``commander_baseline_snapshot`` is
    provided, each commander row's post-clip z is shifted by ``-baseline``
    on the relevant axes (then re-clipped to ``[-1, +1]``). The shift is
    applied in **post-clip space** so the audit-measured prior magnitudes
    match the in-algorithm impact 1:1.

    ``per_player_axis_z`` powers ``elo_history.json``'s
    ``axis_contributions`` and ``elo_current.json``'s ``axis_means``.
    Audit invariant: for available axes,
    ``Σ_axis (axis_z[axis] * weight'_axis) ≈ per_player_P[i]``.
    """
    lobby = match_data.get("leaderboard") or []
    if not lobby:
        return [], [], [], []

    duration_sec = (match_data.get("match") or {}).get("duration_sec", 0) or 0
    minutes = duration_sec / 60.0

    pos_players = ((match_data.get("positioning") or {}).get("players") or {})
    snipes_by_player = {
        row.get("name"): int(row.get("count", 0) or 0)
        for row in ((match_data.get("snipes") or {}).get("by_player") or [])
    }
    has_target_lock = bool(
        (match_data.get("match") or {}).get("has_target_lock_data")
    )

    # Per-axis raw values keyed by axis name; None entries trigger weight redistribution.
    raw: dict[str, list[float] | None] = {
        "net_damage_share": _net_damage_share_lobby(lobby),
        "thug_kill_rate":   _thug_kill_rate_lobby(lobby, minutes),
        "thug_accuracy":    _thug_accuracy_lobby(lobby),
        "thug_efficiency":  _thug_efficiency_lobby(lobby),
        "pve_share":        _pve_share_lobby(lobby),
        "mobility":         _mobility_lobby(lobby, pos_players),
        "snipe_bonus":      _snipe_bonus_lobby(lobby, snipes_by_player),
        "target_lock_pct":  _target_lock_pct_lobby(lobby, pos_players, has_target_lock),
    }

    available = [a for a, v in raw.items() if v is not None]
    if not available:
        # Pathological — duration gate normally catches this; belt-and-braces.
        return (
            [0.0] * len(lobby),
            [_player_key(p) for p in lobby],
            [{} for _ in lobby],
            [{} for _ in lobby],
        )

    # Per-axis z-score, clip to [-2, +2], divide by 2 to land in [-1, +1].
    # v2.4: for commander rows on shifted axes, additionally subtract the
    # commander baseline (post-clip space) and re-clip to [-1, +1]. The
    # forensic breakdown lands in axis_meta_by_player.
    axis_meta_by_player: list[dict[str, dict[str, float]]] = [
        {} for _ in lobby
    ]
    z_by_axis: dict[str, list[float]] = {}
    for axis in available:
        z = _zscore_axis(raw[axis])
        clipped = [_clip(zi, -2.0, 2.0) / 2.0 for zi in z]
        if (
            commander_baseline_snapshot is not None
            and axis in commander_baseline_snapshot
        ):
            baseline = commander_baseline_snapshot[axis]
            shift = -baseline
            for i, p in enumerate(lobby):
                if not p.get("is_commander"):
                    continue
                z_pre_shift = clipped[i]
                z_post_shift = max(-1.0, min(1.0, z_pre_shift + shift))
                clipped[i] = z_post_shift
                axis_meta_by_player[i][axis] = {
                    "z_pre_shift":  round(z_pre_shift, 4),
                    "shift":        round(shift, 4),
                    "z_post_shift": round(z_post_shift, 4),
                }
        z_by_axis[axis] = clipped

    # Pro-rata weight redistribution so available weights still sum to 1.
    total_available_weight = sum(THUG_WEIGHTS[a] for a in available)
    weights = {a: THUG_WEIGHTS[a] / total_available_weight for a in available}

    perf: list[float] = []
    per_player_axis_z: list[dict[str, float]] = []
    for i in range(len(lobby)):
        axis_z_dict: dict[str, float] = {}
        p_sum = 0.0
        for a in available:
            zi = z_by_axis[a][i]
            axis_z_dict[a] = zi
            p_sum += weights[a] * zi
        perf.append(p_sum)
        per_player_axis_z.append(axis_z_dict)

    return (
        perf,
        [_player_key(p) for p in lobby],
        per_player_axis_z,
        axis_meta_by_player,
    )


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
    """Walk ``all_match_data`` chronologically, applying the ELO update rule
    per match, and return the ``(elo_current, elo_history)`` JSON-ready dicts.

    Match order is ``(match.date, match.id)`` — ELO is path-dependent,
    so the composite key handles same-second imports deterministically.
    """
    matches = sorted(
        list(all_match_data),
        key=lambda md: (
            (md.get("match") or {}).get("date", ""),
            (md.get("match") or {}).get("id", ""),
        ),
    )

    thug_elo: dict[str, float] = defaultdict(lambda: ELO_ANCHOR)
    matches_played: dict[str, int] = defaultdict(int)
    display_name: dict[str, str] = {}
    steam64_for_key: dict[str, str | None] = {}
    last_match_id: dict[str, str] = {}
    last_delta: dict[str, float] = {}
    peak_vtsr: dict[str, float] = defaultdict(lambda: ELO_ANCHOR)
    peak_at: dict[str, str] = {}
    win_history: dict[str, list[float]] = defaultdict(list)
    # Per-axis running sums + counts → career-average axis z-scores.
    # Tracked separately per axis because each axis's denominator can
    # differ (axes self-omit on a per-match basis via redistribution).
    axis_running_sum: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    axis_running_count: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    # v2.4: rolling commander-baseline running mean (per axis), and per-player
    # commander-match counter for matches_as_commander / matches_as_thug.
    # Running buffers accumulate ONLY commander rows' pre-shift z-scores
    # (post-clip space). Locked axes still accumulate for visibility but
    # commander_shrunk_baseline ignores their running mean.
    commander_axis_running_sum:   dict[str, float] = defaultdict(float)
    commander_axis_running_count: dict[str, int]   = defaultdict(int)
    commander_match_count:        dict[str, int]   = defaultdict(int)

    history_entries: list[dict] = []

    excluded_low_player_count = 0
    excluded_short_duration   = 0
    excluded_no_winner        = 0  # reserved (alpha-blend slot); always 0 in v1

    for md in matches:
        m = md.get("match") or {}
        lobby = md.get("leaderboard") or []
        match_id = m.get("id", "")
        match_date = m.get("date", "")

        # Player count < 6 OR duration < 300s → emit excluded history row, no rating change.
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

        # v2.4: snapshot the per-axis commander baseline BEFORE this match
        # runs, so commanders in this match are evaluated against rolling
        # state derived from prior matches only (no leakage).
        commander_baseline_snapshot = {
            a: commander_shrunk_baseline(
                a,
                commander_axis_running_sum[a],
                commander_axis_running_count[a],
            )
            for a in COMMANDER_AXIS_PRIOR
        }

        perfs, keys, axis_z_by_player, axis_meta_by_player = (
            compute_performance_index(
                md, commander_baseline_snapshot=commander_baseline_snapshot
            )
        )
        if not perfs:
            history_entries.append({
                "match_id":         match_id,
                "match_date":       match_date,
                "match_excluded":   True,
                "exclusion_reason": "empty_lobby",
                "deltas": [],
            })
            continue

        # Snapshot pre-match ratings so update order within the lobby
        # doesn't influence anyone else's E_i. defaultdict access seeds
        # debutants to ELO_ANCHOR.
        ratings_before = [thug_elo[k] for k in keys]
        n_lobby = len(keys)

        match_deltas = []
        for i, key in enumerate(keys):
            n_before = matches_played[key]
            r_before = ratings_before[i]
            ki = k_factor(n_before)
            # Median (not mean) of opponent ratings: a single high-rated
            # outlier shouldn't pull the reference up for everyone.
            others = [r for j, r in enumerate(ratings_before) if j != i]
            r_opp_ref = _median(others) if others else ELO_ANCHOR
            e_i = expected_performance(r_before, r_opp_ref)
            dr_raw = ki * ELO_RATING_SCALE * (perfs[i] - e_i)
            if dr_raw >= 0:
                dr = dr_raw
            else:
                dr = dr_raw * ELO_K_LOSS_AVERSION * floor_taper(r_before)
            r_after = r_before + dr
            # Defensive clamp — math asymptotes to FLOOR but float edges could dip below.
            if r_after < ELO_RATING_FLOOR:
                r_after = ELO_RATING_FLOOR

            thug_elo[key] = r_after
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

            # Per-axis attribution. Axes that self-redistributed for this
            # lobby are omitted from the dict. v2.4: values are POST-shift
            # for commander rows (so axis_contributions matches what fed
            # into P_i); the optional axis_contributions_meta sibling block
            # carries z_pre_shift / shift / z_post_shift for forensics.
            axis_contrib = {
                a: round(z, 4) for a, z in (axis_z_by_player[i] or {}).items()
            }
            for a, z in (axis_z_by_player[i] or {}).items():
                axis_running_sum[key][a] += z
                axis_running_count[key][a] += 1

            # v2.4: per-row commander tracking. Bump matches_as_commander
            # for this player when the row is flagged is_commander.
            row_axis_meta = axis_meta_by_player[i] if axis_meta_by_player else {}
            if lobby[i].get("is_commander"):
                commander_match_count[key] += 1

            delta_entry: dict[str, Any] = {
                "name":        display_name[key],
                "steam64":     steam64_for_key.get(key),
                "before":      round(r_before, 2),
                "after":       round(r_after, 2),
                "delta":       round(dr, 2),
                "performance": round(perfs[i], 4),
                "expected":    round(e_i, 4),
                "axis_contributions": axis_contrib,
            }
            # Only commander rows carry the forensic meta block. Schema is
            # {axis: {z_pre_shift, shift, z_post_shift}}; audit invariant
            # axis_contributions[axis] == z_post_shift on each shifted axis.
            if row_axis_meta:
                delta_entry["axis_contributions_meta"] = dict(row_axis_meta)
            match_deltas.append(delta_entry)

        # v2.4: AFTER the per-row loop, accumulate this match's commander
        # rows' pre-shift post-clip z-scores into the rolling baseline
        # buffers. We pull pre-shift (not post-shift) so the running mean
        # tracks the empirical commander distribution untouched by the
        # adjustment. Locked axes still accumulate (visibility only).
        for i, key in enumerate(keys):
            if not lobby[i].get("is_commander"):
                continue
            for axis, meta in (axis_meta_by_player[i] or {}).items():
                commander_axis_running_sum[axis]   += meta["z_pre_shift"]
                commander_axis_running_count[axis] += 1

        history_entries.append({
            "match_id":       match_id,
            "match_date":     match_date,
            "match_excluded": False,
            "deltas":         match_deltas,
        })

    # ----- Build elo_current.json shape -----
    ratings = []
    for key in thug_elo:
        t_elo = thug_elo[key]
        n     = matches_played[key]
        # Final VTSR-T = blend(R^W, R^T). R^W stubbed at anchor in v1.
        wins_elo = ELO_ANCHOR
        vtsr = ALPHA * wins_elo + (1.0 - ALPHA) * t_elo
        # Per-axis career means; each axis's denominator is the number
        # of rated matches where that axis was available for the lobby.
        axis_means: dict[str, float] = {}
        sums = axis_running_sum.get(key) or {}
        counts = axis_running_count.get(key) or {}
        for a in THUG_WEIGHTS:
            n_a = counts.get(a, 0)
            if n_a > 0:
                axis_means[a] = round(sums.get(a, 0.0) / n_a, 4)
        # v2.4: per-row commander vs thug match split. Sums to matches_played
        # (matches_as_commander counts every rated row where the player held
        # slot 1 / 6; everything else is a thug appearance).
        n_cmdr = commander_match_count.get(key, 0)
        ratings.append({
            "name":             display_name.get(key, ""),
            "steam64":          steam64_for_key.get(key),
            "vtsr":             round(vtsr, 1),
            "thug_elo":         round(t_elo, 1),
            "wins_elo":         round(wins_elo, 1),
            "matches_played":   n,
            "matches_as_commander": n_cmdr,
            "matches_as_thug":  n - n_cmdr,
            "matches_provisional": n < ELO_PROVISIONAL_THRESHOLD,
            "last_match_id":    last_match_id.get(key, ""),
            "last_delta":       round(last_delta.get(key, 0.0), 2),
            "peak_vtsr":        round(peak_vtsr.get(key, ELO_ANCHOR), 1),
            "peak_at":          peak_at.get(key, ""),
            "win_history":      list(win_history.get(key, [])),
            "axis_means":       axis_means,
        })

    # Sort by VTSR desc, then name asc (deterministic).
    ratings.sort(key=lambda r: (-r["vtsr"], (r["name"] or "").lower()))

    rated_match_count = sum(1 for h in history_entries if not h["match_excluded"])
    elo_current = {
        "schema_version":     ELO_SCHEMA_VERSION,
        "alpha":               ALPHA,
        "alpha_pve":           ALPHA_PVE,
        "anchor":              ELO_ANCHOR,
        "rating_scale":        ELO_RATING_SCALE,
        "expected_score_logistic_scale": ELO_LOGISTIC_SCALE,
        "k_loss_aversion":    ELO_K_LOSS_AVERSION,
        "rating_floor":       ELO_RATING_FLOOR,
        "floor_taper_window": ELO_FLOOR_TAPER_WINDOW,
        "k_base":             ELO_K_BASE,
        "k_floor":             ELO_K_FLOOR,
        "provisional_prior":  ELO_PROVISIONAL_PRIOR,
        "provisional_threshold": ELO_PROVISIONAL_THRESHOLD,
        "min_player_count":   ELO_MIN_PLAYER_COUNT,
        "min_duration_sec":   ELO_MIN_DURATION_SEC,
        "computed_at":        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "match_count":        rated_match_count,
        "matches_excluded_low_player_count": excluded_low_player_count,
        "matches_excluded_short_duration":   excluded_short_duration,
        "matches_excluded_no_winner":        excluded_no_winner,
        "weights":            dict(THUG_WEIGHTS),
        # v2.4: commander role-adjustment metadata. Audit-derived priors
        # blend with the running mean as the corpus grows; locked priors
        # always equal the seed value (running_mean tracked for visibility
        # only — `locked: true` makes that obvious in the JSON).
        "commander_axis_prior":           dict(COMMANDER_AXIS_PRIOR),
        "commander_baseline_shrinkage":   COMMANDER_BASELINE_SHRINKAGE,
        "commander_baseline_locked_axes": sorted(COMMANDER_BASELINE_LOCKED_AXES),
        "commander_baseline_observed": {
            a: {
                "n":            commander_axis_running_count[a],
                "running_mean": (
                    round(
                        commander_axis_running_sum[a]
                        / commander_axis_running_count[a],
                        4,
                    )
                    if commander_axis_running_count[a] > 0
                    else 0.0
                ),
                "shrunk_baseline_at_corpus_end": round(
                    commander_shrunk_baseline(
                        a,
                        commander_axis_running_sum[a],
                        commander_axis_running_count[a],
                    ),
                    4,
                ),
                "locked": a in COMMANDER_BASELINE_LOCKED_AXES,
            }
            for a in COMMANDER_AXIS_PRIOR
        },
        "ratings":            ratings,
    }

    elo_history = {
        "schema_version": ELO_SCHEMA_VERSION,
        "history":        history_entries,
    }

    return elo_current, elo_history
