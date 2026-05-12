"""VT Stats Rating — Thug (VTSR-T): pipeline-side Thug ELO.

**VTSR-T** is the thug-focused rating (eight-axis thug composite +
fine-tuned ELO-style updates). The published blend
``VTSR-T = α·R^W + (1−α)·R^T`` collapses to VTSR-T when ``α = 0``
(current ship); JSON still exposes the combined field as ``vtsr`` for
one stable wire name. ``R^T`` is the **Thug ELO** subscript — the
combat-skill component that pairs with Wins ELO ``R^W`` in the blend.
A future VTSR-C (commander) rating will follow the same blend shape
with its own commander-axis composite.

v2.3 axis rebalance (this module):
  * Renames ``Combat ELO`` -> ``Thug ELO`` and ``COMBAT_WEIGHTS`` ->
    ``THUG_WEIGHTS``. The rating measures thug effectiveness, not
    generic combat skill; the rename clarifies that VTSR-T sits
    alongside future VTSR-C as a sibling thug-vs-commander pair.
    ``combat_elo`` JSON field on ``elo_current.ratings[]`` becomes
    ``thug_elo`` (rides the existing ``ELO_SCHEMA_VERSION`` bump).
  * **Alpha-blended thug axes (α = 0.5).** The three "thug" axes
    (``thug_kill_rate``, ``thug_accuracy``, ``thug_efficiency``) credit
    PvE work at fractional weight rather than zero, so a role player
    doing economy/utility work isn't penalized for the role choice.
    Lobby z-scoring still amplifies exceptional performance regardless
    of source — no separate "PvE excellence" axis needed.
  * **Weapon-normalized accuracy.** Replaces flat shots_hit/shots_fired
    with per-weapon ratio against the lobby's per-weapon baseline,
    weighted by player's shot-share. Numerator includes ``α × pve_hits``
    so role players landing hits on AI/economy targets get credit.
  * **Broader ``pve_share`` axis** replaces ``structure_share``. Covers
    all enemy non-human damage (structures + mobile AI like Scavengers,
    Producers, Extractors). Sources from ``personal.pve_dealt``.
  * **Per-axis attribution**: ``compute_performance_index`` now also
    returns per-axis z-scores per player. Threaded into each
    ``elo_history.deltas[]`` entry as ``axis_contributions`` and
    aggregated into per-player ``axis_means`` on
    ``elo_current.ratings[]``. Powers the VTSR-T leaderboard's
    "why does this player have this rating?" tooltip + popover.

Computed once per pipeline run over the full chronological corpus, and
emitted to ``data/processed/elo_current.json`` (one row per player) plus
``data/processed/elo_history.json`` (per-match deltas for trend / debug).

The dashboard reads ``elo_current.json`` once per session and passes
ratings through the All Matches aggregator unchanged — ratings are corpus-
wide, *not* picker-filter aware. The picker filter narrows the displayed
roster only.

Algorithm summary (full derivation lives in
``DEVELOPER_GUIDE.md`` §13 — VTSR-T methodology):

    VTSR-T_i = alpha * R^W_i + (1 - alpha) * R^T_i

with ``alpha = 0`` in v1 (Wins ELO stubbed at the league anchor 1500
for every player; the blend math runs through unchanged so a future
``alpha = 0.55`` bump doesn't change any UI strings).

**Thug ELO update rule** (R^T_i updates per match by):

    K_i      = K_BASE * (1 - n_i / (n_i + N_PRIOR)) + K_FLOOR
    P_i      = sum_a w'_a * clip(z_a(x_{i,a}), -2, +2) / 2   (eight axes in v2.3)
    Rbar_i   = median{R^T_j : j != i}                        (median of opponents)
    E_i      = 2 / (1 + 10^((Rbar_i - R^T_i) / S_R)) - 1     (logistic expected, in [-1, +1])
    dR_raw   = K_i * S_O * (P_i - E_i)
    dR       = dR_raw                                        if dR_raw >= 0
               dR_raw * L * phi(R^T_i)                        otherwise

Compares against opponent-strength-weighted expected performance ``E_i``
(ELO-family logistic). ``S_R = 800`` is the rating-logistic scale
(calibrated for our small-population corpus with **continuous** ``P_i``
scoring — a tighter denominator such as 400 over-compressed the spread;
800 lets top players plateau ~300 pts above the median lobby instead
of ~140). ``S_O = 2.5`` is the outcome scale. We use the **median** of
opponents (not mean) so a single outlier rating like VTrider's doesn't
pull the lobby reference up for everyone else.

The loss multiplier ``L = 0.85`` (loss aversion) and the soft-floor
taper ``phi(R) = clamp(0, 1, (R - F) / W)`` with ``F = 1000`` and
``W = 150`` apply on top of the raw delta so the rating asymptotes
toward (but never crosses) the 1000 floor. A defensive ``max(F, R)``
clamp catches float-edge drift.

Cold start: when every player is at the anchor (1500), ``E_i = 0`` for
everyone and the model degrades to ``dR = K * S_O * P_i`` (no special
case needed).

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
ELO_K_FLOOR = 12.0               # Settled-veteran floor on K (typical provisional settle band).
ELO_PROVISIONAL_PRIOR = 10.0     # K decays toward FLOOR over the first ~10 matches.
ELO_PROVISIONAL_THRESHOLD = 10   # matches_played < this => "Provisional" badge.
ELO_MIN_PLAYER_COUNT = 6         # match excluded from ELO when player_count < 6.
ELO_MIN_DURATION_SEC = 300       # 5-minute minimum.

# Per-match outcome scale. ``(P_i - E_i)`` typically lives in the
# same [-0.5, +0.5] range as v1's ``(P_i - P_med)`` because each
# update is bounded by how far ``P_i`` can sit above/below ``E_i``,
# which is itself bounded in [-1, +1]. ``S_O = 2.5`` is unchanged
# from v1 — the per-match scale didn't need rebumping once the
# logistic scale (``S_R``) was set to the calibrated 800.
ELO_RATING_SCALE = 2.5

# Rating-logistic scale for the expected-performance curve.
# Calibrated for a small (~25-player) league with continuous P_i
# scoring. A denominator near 400 fits classic *binary-outcome* ELO
# expected scores; our 8-axis composite carries more signal per match
# but is noisier and bounded by ~±0.7 in practice, which made our v2.0
# ship at S_R=400 over-compress the spread to ~200 pts (Tiers 3 and 4
# only on the leaderboard). ``S_R = 800`` flattens the curve
# so top players need ~300 pts above the median lobby to plateau
# (instead of ~140), restoring a Tier 1–4 leaderboard-friendly
# spread. With S_R = 800: a 200-pt rating advantage maps to
# E ≈ +0.28; a 400-pt advantage to E ≈ +0.52; a 800-pt advantage
# to E ≈ +0.80. Lower values amplify rating differences (faster
# regression to the mean, harsher penalty for top players in soft
# lobbies); higher values dampen them. Iterating this constant
# does NOT require an ``ELO_SCHEMA_VERSION`` bump (shape unchanged),
# only a ``PIPELINE_VERSION`` bump to force re-rating.
ELO_LOGISTIC_SCALE = 800.0

# Loss-aversion asymmetry: when raw dR < 0, multiply by this factor.
# Anchored in Kahneman & Tversky 1979 prospect theory; operational
# precedent in Marvel Rivals SR, Overwatch role queue, League of Legends
# demotion shielding. Mild ~5-8 pts/player/year drift at ~600 league
# matches/year recorded — disclosed in methodology; no need to inflate
# RATING_SCALE to chase a wider cosmetic spread.
ELO_K_LOSS_AVERSION = 0.85

# Soft rating floor with linear taper. Effective loss multiplier is
# clamp(0, 1, (R - FLOOR) / TAPER_WINDOW) — losses go to zero as a
# player approaches FLOOR. Tier 5 spans 1000-1349, so a wider taper (150
# vs the 100-pt taper from earlier drafts) keeps the floor approach
# gradual across the band rather than abrupt at the top of Tier 5.
ELO_RATING_FLOOR = 1000.0
ELO_FLOOR_TAPER_WINDOW = 150.0   # full asymmetric losses restored at FLOOR + 150 (1150).

# Fractional weight for PvE work in the three thug axes. A "thug" can
# be effective in more ways than one — α=0.5 means PvE damage / kills /
# hits count at half the weight of equivalent PvP work in the thug
# axes, while remaining standalone-rewardable via lobby z-scoring when
# a player's PvE output is exceptional. ``pve_share`` already credits
# PvE work at full weight (separate axis); this constant tunes how
# much PvE shows up in the dogfight-flavored axes (thug_kill_rate,
# thug_accuracy, thug_efficiency).
#
# Tunable post-ship without an ``ELO_SCHEMA_VERSION`` bump (shape
# unchanged). ``compute_elo`` is corpus-wide (recomputed every pipeline
# run, not cached per-match), so re-rating after an ALPHA_PVE tune
# requires only a ``PIPELINE_VERSION`` bump in ``process_stats.py``.
# Surface in elo_current.json so consumers can audit the value.
ALPHA_PVE = 0.5

# Thug composite weights (locked, sum = 1.00). EIGHT axes (v2.3) —
# rebalanced to recognize role-player effectiveness alongside pure
# dogfight skill. v2.3 changes vs v2.2:
#   * Renamed three axes for clarity ("thug" prefix on the three
#     alpha-blended axes; the others stay descriptive without prefix):
#         kill_rate       -> thug_kill_rate    (alpha-blended)
#         accuracy        -> thug_accuracy     (weapon-normalized + alpha-blended)
#         pvp_share       -> thug_efficiency   (alpha-blended; denom excl. structure)
#         structure_share -> pve_share         (broadened to all enemy non-human dmg)
#   * Tweaked weights: net_damage 0.21 -> 0.20, snipe_bonus 0.04 -> 0.05,
#     thug_efficiency 0.18 -> 0.16, pve_share 0.10 -> 0.12. Direct-
#     dogfight axes (thug_kill_rate + thug_accuracy + thug_efficiency)
#     total 0.51; pve_share 0.12; volume + utility (net + mobility +
#     snipe + target_lock) 0.37. Sum locked at 1.00.
#
# Naming note: the dict variable is ``THUG_WEIGHTS`` (the weights for
# the Thug ELO axis composite). The wire field on
# ``elo_current.json`` stays as ``weights`` (no rename of the JSON key
# itself; only the keys *inside* the dict changed names).
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

ALPHA = 0.0   # v1: Wins ELO stubbed at anchor; bump to 0.55 when winner data backfilled.

# Schema version for elo_current.json / elo_history.json. Bump if the
# JSON shape changes downstream (the JS reader checks this).
# v1 → v2 (Phase 12): switched per-match comparison from lobby-median
# ``P_med`` to opponent-strength-weighted expected ``E_i``; constants
# block grew ``expected_score_logistic_scale``; per-delta rows now
# carry an ``expected`` field alongside ``performance``.
# v2 → v3 (Phase 13 / v2.2 axis rebalance): the ``weights`` block now
# has 8 keys (asset_multiplier removed; structure_share + target_lock_pct
# added). Pre-v3 ``peak_vtsr`` values are no longer comparable.
# v3 → v4 (v2.3): axis renames (``kill_rate``→``thug_kill_rate``,
# ``accuracy``→``thug_accuracy``, ``pvp_share``→``thug_efficiency``,
# ``structure_share``→``pve_share``); ``thug_accuracy`` is now
# weapon-normalized; ``ALPHA_PVE`` constant introduced (alpha-blended
# PvE in the three thug axes); ``thug_efficiency`` denominator now
# excludes structure damage; ``pve_share`` broadened from buildings-only
# to all enemy non-human damage. JSON field rename
# ``ratings[].combat_elo`` → ``ratings[].thug_elo`` reflects the
# Combat ELO -> Thug ELO architectural rename. Per-delta rows now
# carry an ``axis_contributions`` block; per-rating rows carry an
# ``axis_means`` block. ``alpha_pve`` constant surfaced in the top-
# level constants block. Pre-v4 ``peak_vtsr`` values are no longer
# comparable (P_i definition changed).
ELO_SCHEMA_VERSION = 4


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


def expected_performance(r_i: float, r_opponents_ref: float) -> float:
    """Logistic expected-performance curve, mapped to ``[-1, +1]``.

    Same logistic *family* as standard two-player ELO expected score
    (often written with a 400-pt denominator for binary outcomes) but
    rescaled to match the composite-performance range ``P_i in [-1, +1]``:

        E_i = 2 / (1 + 10^((Rbar_i - R_i) / S_R)) - 1

    Returns a value in ``[-1, +1]`` that's ``0`` when ``R_i`` matches
    the opponent reference rating, ``+~0.5`` when ``R_i`` is ``S_R``
    points above the reference, and asymptotes to ``+1`` / ``-1`` for
    extreme rating gaps. Used to subtract from ``P_i`` so deltas
    reward over-performance *relative to expectations* rather than
    relative to the lobby median.

    ``r_opponents_ref`` should be the *median* of all other players'
    Thug ELO at the start of the match — the median is robust to a
    single high-rated outlier in the lobby (e.g. VTrider) that would
    otherwise pull a mean-based reference up for everyone.

    Pure: no side effects, deterministic.
    """
    exponent = (r_opponents_ref - r_i) / ELO_LOGISTIC_SCALE
    # Guard against extreme exponents that could overflow ``10 ** x``.
    # At |exponent| >= 16, the result is already pinned to ±1.0 within
    # double-precision rounding; clamping keeps the math finite even on
    # pathological synthetic inputs (no real-corpus value ever hits
    # this since |R_i - Rbar_i| caps at ~1500 → exponent ~3.75).
    if exponent > 16.0:
        return -1.0
    if exponent < -16.0:
        return 1.0
    return 2.0 / (1.0 + 10.0 ** exponent) - 1.0


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


def _thug_kill_rate_lobby(lobby: list[dict], minutes_played: float) -> list[float]:
    """Alpha-blended kill rate: (pvp_kills + α·pve_kills) / minutes.

    v2.3 axis. PvE kills (against AI ships, AI structures) count at
    fractional weight ``ALPHA_PVE`` so role players doing economy/utility
    work get credit for AI kills without farming-rewarding alpha=1.0.
    Falls back to ``kills`` when ``pvp_kills``/``pve_kills`` are absent
    (legacy match data); this preserves pre-v2.3 behavior on stale
    leaderboards rather than dropping them to zero.
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
            # Legacy fallback: treat all kills as PvP-equivalent (matches
            # v2.2 behavior for pre-v4 match data).
            blended = p.get("kills", 0) or 0
        out.append(blended / minutes)
    return out


def _thug_accuracy_lobby(lobby: list[dict]) -> list[float]:
    """Weapon-normalized accuracy with alpha-blended PvE hits (v2.3).

    For each player p and each weapon w that p fired, compute the
    ratio of p's combat-weighted hits per shot vs the lobby's
    combat-weighted hits per shot for the same weapon. Combat-weighted
    hits = ``pvp_hits + ALPHA_PVE * pve_hits`` (where ``pve_hits =
    hits - pvp_hits``). Player score is the shot-share-weighted mean
    of those ratios over the player's used weapons:

        pwa_p = (Σ_w (p_combat_acc_w / lobby_combat_acc_w) * weight_w) / Σ_w weight_w
        weight_w = p_shots_w / p_total_shots

    Returns a positive number per player; lobby z-score in
    ``compute_performance_index()`` handles centering. Unlike the v2.2
    flat ratio, this is weapon-mix bias robust — sniper mains aren't
    penalized for the rifle's natural lower hit rate, and shotgun
    spammers don't benefit from the spray pattern.

    Edge cases:
      * Player who fired zero shots → 0.0 (lowest score).
      * Weapon with no lobby signal (nobody else fired it, or lobby has
        zero hits with it) → dropped from the player's pwa via
        ``continue``; ``used_weight`` shrinks accordingly. A player who
        ONLY fires unique-to-them weapons gets ``used_weight == 0`` and
        is assigned 0.0.
      * Pre-v2.3 leaderboard rows lacking ``weapon_breakdown[w].pvp_hits``
        treat all hits as PvP-equivalent (legacy fallback).
    """
    from collections import defaultdict as _dd
    lobby_shots_w: dict[str, int] = _dd(int)
    lobby_thug_hits_w: dict[str, float] = _dd(float)

    for p in lobby:
        for w, wd in (p.get("weapon_breakdown") or {}).items():
            shots = wd.get("shots", 0) or 0
            hits = wd.get("hits", 0) or 0
            # Legacy fallback: pre-v2.3 weapon_breakdown has no pvp_hits.
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
            # Renormalize over the weapons that had lobby signal.
            out.append(score_num / used_weight)
    return out


def _thug_efficiency_lobby(lobby: list[dict]) -> list[float]:
    """Alpha-blended dogfight efficiency with structure damage excluded
    from the denominator (v2.3, replaces v2.2 ``pvp_share``).

        thug_efficiency_p = (pvp_dealt + α * pve_to_AI) / max(1, total - structure)

    Where ``pve_to_AI ≈ pve_dealt - structure_dealt`` (mobile AI damage,
    excluding world props which are negligible after the sentinel
    filter). Rationale: measures "of your non-structure damage, how
    effectively did you dogfight (with PvE damage credited at α
    weight)?". Structure damage flows entirely to ``pve_share``;
    mobile-AI damage gets partial credit here AND full credit on
    ``pve_share``. The denominator excludes structure so a structure-
    buster's economy work is rewarded via ``pve_share`` rather than
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


def _pve_share_lobby(lobby: list[dict]) -> list[float] | None:
    """Player-dealt damage to enemy non-human assets / total dealt
    (v2.3 axis, replaces v2.2's narrower ``structure_share``).

    Captures ALL "asset disruption" work — structures AND mobile AI
    units (Scavengers, Producers, Extractors, AI tanks, etc.). Sources
    from ``personal.pve_dealt``, which is already
    ``total_dealt - pvp_dealt`` and excludes player-owned-AI damage by
    construction (only events with ``shooter > 0`` enter
    ``personal.dealt``). Structures are NOT double-counted; this is one
    share over a clean denominator.

    Returns ``None`` when no player in the lobby dealt any PvE damage —
    axis-missing triggers the weight-redistribution rule in
    ``compute_performance_index``. This is the same axis-missing handling
    used for ``mobility`` and ``target_lock_pct``.

    Rewards both base-busters and scrap-killers symmetrically: a
    structure-focused thug and a mobile-AI-focused thug both score on
    the same axis.
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

    Reads ``positioning.players[name].metrics.target_lock_pct`` (already
    a 0-1 ratio, cross-match comparable per the data-schema rules).
    Gated on the match-global ``has_target_lock_data`` flag — pre-schema
    sessions and matches where nobody activated target mode return
    ``None`` for the entire lobby (axis-missing → weight redistribution).

    Per project rule: "T-key Usage is absolute (cross-match comparable)
    and averaged directly in career_stats[].mean_target_lock_pct" — same
    contract holds for the ELO axis. Low weight (0.04) intentionally: a
    discipline reward, not a dominator signal.
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
) -> tuple[list[float], list[str], list[dict[str, float]]]:
    """Compute the per-player performance index ``P_i`` for a single
    match.

    Returns ``(per_player_P, player_keys, per_player_axis_z)`` where:
      * ``per_player_P[i]`` is the player's composite score in [-1, +1]
      * ``player_keys[i]`` is the steam64 (or fallback name)
      * ``per_player_axis_z[i]`` is a dict ``{axis_name: clipped_z}``
        carrying each axis's contribution AFTER clip-and-divide-by-2 so
        each value lives in [-1, +1]. Axes that were unavailable for the
        entire lobby (and thus had their weight redistributed) are
        OMITTED from the dict — consumers should treat absence as
        "axis unavailable in this match" and rely on the redistributed
        weight already baked into ``per_player_P``.

    The ``per_player_axis_z`` block powers the VTSR-T leaderboard's
    per-axis breakdown popover (``elo_history.json`` ``axis_contributions``
    field) and the career-average tooltip (``elo_current.json``
    ``axis_means`` field). Audit invariant: for available axes,
    ``Σ_axis (axis_z[axis] * weight'_axis) ≈ per_player_P[i]`` where
    ``weight'`` is the redistributed weight (sum to 1.00).

    Pure: no side-effects on ``match_data``.
    """
    lobby = match_data.get("leaderboard") or []
    if not lobby:
        return [], [], []

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

    # Build per-axis raw values lists (one float per player) keyed by axis
    # name. None entries mean the axis is missing for the whole lobby —
    # that axis's weight gets redistributed.
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
        # Pathological — should be excluded by the duration gate, but
        # belt-and-suspenders: every player gets P = 0, no rating change.
        return (
            [0.0] * len(lobby),
            [_player_key(p) for p in lobby],
            [{} for _ in lobby],
        )

    # Per-axis z-score, clip to [-2, +2], divide by 2 to land in [-1, +1].
    z_by_axis: dict[str, list[float]] = {}
    for axis in available:
        z = _zscore_axis(raw[axis])
        z_by_axis[axis] = [_clip(zi, -2.0, 2.0) / 2.0 for zi in z]

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

    return perf, [_player_key(p) for p in lobby], per_player_axis_z


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

    # Per-player rating state. Thug ELO accumulates across matches;
    # display name and last-seen steam64 are tracked for the output row.
    # Naming: ``thug_elo`` is the v2.3 rename of ``combat_elo`` —
    # reflects that VTSR-T's combat-skill component is specifically
    # thug-flavored (8-axis thug composite), and sets up future VTSR-C
    # (commander) as a sibling rating.
    thug_elo: dict[str, float] = defaultdict(lambda: ELO_ANCHOR)
    matches_played: dict[str, int] = defaultdict(int)
    display_name: dict[str, str] = {}
    steam64_for_key: dict[str, str | None] = {}
    last_match_id: dict[str, str] = {}
    last_delta: dict[str, float] = {}
    peak_vtsr: dict[str, float] = defaultdict(lambda: ELO_ANCHOR)
    peak_at: dict[str, str] = {}
    win_history: dict[str, list[float]] = defaultdict(list)
    # Per-player career-average axis z-scores (running mean across all
    # rated matches the player participated in). Keyed
    # ``axis_running_sum[key][axis] -> sum`` and
    # ``axis_running_count[key][axis] -> n``; final mean = sum / n.
    # Tracked separately per axis because some matches omit some axes
    # (mobility / target_lock_pct / pve_share / snipe_bonus can self-omit
    # via the axis-missing rule), so each axis's denominator may differ
    # by player. Surfaces as ``axis_means`` on each elo_current.ratings[]
    # row; powers the VTSR-T leaderboard's "top axes" tooltip.
    axis_running_sum: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    axis_running_count: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

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

        perfs, keys, axis_z_by_player = compute_performance_index(md)
        if not perfs:
            history_entries.append({
                "match_id":         match_id,
                "match_date":       match_date,
                "match_excluded":   True,
                "exclusion_reason": "empty_lobby",
                "deltas": [],
            })
            continue

        # Snapshot every player's pre-match Thug ELO so each per-player
        # ``E_i`` reads the same lobby state — the order in which we
        # apply updates within a single match must NOT influence anyone
        # else's expected score in the same match. ``defaultdict``
        # access here also seeds new players to ``ELO_ANCHOR``, so a
        # debutant correctly contributes 1500 to everyone else's
        # ``Rbar``.
        ratings_before = [thug_elo[k] for k in keys]
        n_lobby = len(keys)

        # Update each player's Thug ELO and emit a delta row.
        match_deltas = []
        for i, key in enumerate(keys):
            n_before = matches_played[key]
            r_before = ratings_before[i]
            ki = k_factor(n_before)
            # Median rating of every OTHER player in the lobby. Median
            # is intentionally chosen over mean so a single high-rated
            # outlier (e.g. VTrider at ~2700) doesn't pull the
            # reference up for everyone else's expected score. Falls
            # back to ``ELO_ANCHOR`` for the degenerate single-player
            # case (excluded by the ``ELO_MIN_PLAYER_COUNT`` gate
            # above, but belt-and-braces).
            others = [r for j, r in enumerate(ratings_before) if j != i]
            r_opp_ref = _median(others) if others else ELO_ANCHOR
            e_i = expected_performance(r_before, r_opp_ref)
            dr_raw = ki * ELO_RATING_SCALE * (perfs[i] - e_i)
            if dr_raw >= 0:
                dr = dr_raw
            else:
                dr = dr_raw * ELO_K_LOSS_AVERSION * floor_taper(r_before)
            r_after = r_before + dr
            # Defensive clamp — math drives losses asymptotically to FLOOR
            # but float arithmetic at the boundary could otherwise dip below.
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

            # v2.3: per-axis attribution. Round to 4 dp for compact JSON.
            # axis_z_by_player[i] omits axes that self-redistributed for
            # this lobby (e.g. no positioning -> mobility absent). The
            # consumer (VTSR-T leaderboard popover) renders absent axes
            # as "axis unavailable in this match".
            axis_contrib = {
                a: round(z, 4) for a, z in (axis_z_by_player[i] or {}).items()
            }
            # Accumulate into per-player career running means.
            for a, z in (axis_z_by_player[i] or {}).items():
                axis_running_sum[key][a] += z
                axis_running_count[key][a] += 1

            match_deltas.append({
                "name":        display_name[key],
                "steam64":     steam64_for_key.get(key),
                "before":      round(r_before, 2),
                "after":       round(r_after, 2),
                "delta":       round(dr, 2),
                "performance": round(perfs[i], 4),
                # v2: opponent-strength-weighted expected (audit / debug).
                "expected":    round(e_i, 4),
                # v2.3: per-axis z-scores (post-clip / 2). Powers the
                # VTSR-T leaderboard's Last-delta breakdown popover.
                "axis_contributions": axis_contrib,
            })

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
        # v2.3: per-player career-average axis z-scores. Each axis's
        # mean is computed over the rated matches where THAT axis was
        # available for the player's lobby (so a player who's been in
        # mostly no-positioning matches has a smaller denominator on
        # the mobility key). Rounded to 4 dp for compact JSON.
        axis_means: dict[str, float] = {}
        sums = axis_running_sum.get(key) or {}
        counts = axis_running_count.get(key) or {}
        for a in THUG_WEIGHTS:
            n_a = counts.get(a, 0)
            if n_a > 0:
                axis_means[a] = round(sums.get(a, 0.0) / n_a, 4)
        ratings.append({
            "name":             display_name.get(key, ""),
            "steam64":          steam64_for_key.get(key),
            "vtsr":             round(vtsr, 1),
            # v2.3: was ``combat_elo`` (Combat ELO -> Thug ELO rename).
            "thug_elo":         round(t_elo, 1),
            "wins_elo":         round(wins_elo, 1),
            "matches_played":   n,
            "matches_provisional": n < ELO_PROVISIONAL_THRESHOLD,
            "last_match_id":    last_match_id.get(key, ""),
            "last_delta":       round(last_delta.get(key, 0.0), 2),
            "peak_vtsr":        round(peak_vtsr.get(key, ELO_ANCHOR), 1),
            "peak_at":          peak_at.get(key, ""),
            "win_history":      list(win_history.get(key, [])),
            # v2.3: per-axis career-average z-scores. Powers the
            # VTSR-T leaderboard's "Strong axes" tooltip on the
            # rating cell.
            "axis_means":       axis_means,
        })

    # Sort by VTSR desc, then name asc (deterministic).
    ratings.sort(key=lambda r: (-r["vtsr"], (r["name"] or "").lower()))

    rated_match_count = sum(1 for h in history_entries if not h["match_excluded"])
    elo_current = {
        "schema_version":     ELO_SCHEMA_VERSION,
        "alpha":               ALPHA,
        # v2.3: PvE-credit fraction in the three thug axes
        # (thug_kill_rate, thug_accuracy, thug_efficiency). Surfaced for
        # auditability and future tunability.
        "alpha_pve":           ALPHA_PVE,
        "anchor":              ELO_ANCHOR,
        "rating_scale":        ELO_RATING_SCALE,
        # v2: rating-logistic scale for the expected-performance curve.
        "expected_score_logistic_scale": ELO_LOGISTIC_SCALE,
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
        "weights":            dict(THUG_WEIGHTS),
        "ratings":            ratings,
    }

    elo_history = {
        "schema_version": ELO_SCHEMA_VERSION,
        "history":        history_entries,
    }

    return elo_current, elo_history
