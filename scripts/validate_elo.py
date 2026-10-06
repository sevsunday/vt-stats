"""VTSR-T predictive validator (v1.2 -- Phase 2A + VTSR-C sections).

Read-only validator that scores the canonical VTSR-T ratings against the
empirical record. Pure consumer of ``data/processed/*.json`` artifacts;
does not invoke ``scripts/elo.py`` and does not modify pipeline state.

Run from the repo root::

    python scripts/validate_elo.py

Outputs ``_validation/report.md`` (human-readable), ``report.json``
(machine-readable, forward-compatible with a future option-B pipeline
integration), and ``bootstrap.json`` (per-player rating-proxy std
distribution under match-resampling).

Phase 1 metrics (shipped):
    1. Spearman rank correlation: pre-match R_i -> post-match P_i.
    2. Calibration: bucketed (R_i - median(R_others)) vs observed mean P_i
       and predicted mean E_i.
    3. Self-consistency: per-player split-half mean P_i Spearman.
    4. Bootstrap stability: 100 runs * 80% match resampling -> top-20
       Jaccard agreement and per-player rating-proxy std.
    5. Synthetic-winner proxy: agreement of ``team with higher mean P_i``
       against ``match.winner.decided_by == "clean_win"``. >= 85% unlocks
       full-corpus ALPHA > 0 validation in Phase 2.
    6. clean_win winner-prediction accuracy: predict winner from team's
       mean pre-match R_i. Anchored against Cambridge skillbench numbers.
    7. Log-loss on the clean_win subset (Cambridge punted on this; one
       extra column unlocks calibration analysis).
    8. Single-axis ablation: drop each of the 6 axes, measure rank
       displacement on per-player mean P_i (proxy for true rating
       displacement; full re-rating is Phase 2).
    9. Dirichlet weight perturbation: 50 samples around current
       THUG_WEIGHTS, measure rank stability.

v1.1 additions (Phase 2A — diagnostic deepening, NO compute_elo changes):
    6.1. MAX-vs-median preview: score three team-rating aggregations
         side-by-side (mean / hard MAX / softmax-weighted MAX with
         tau=200) on the same eligible clean_win matches. Per Dehpanah
         et al. 2021 (PUBG/LoL/CS:GO 100k+ matches), MAX-style
         aggregations should outperform mean for team-threat prediction
         in tactical shooters. Tests v2 doc §6.1 read-only.
    6.2. Commander-presence breakout: split clean_win matches into
         "with commander" vs "all thug", score canonical mean-R in each.
         Tests whether v2.4 commander axis-shifts dampen team mean R
         and break team-outcome prediction.
    6.3. Rating-gap-magnitude breakout: bucket by
         |team_1_mean_R - team_2_mean_R|, score canonical mean-R in
         each. Sanity check: rating IS meaningful when large-gap
         matches predict notably better than small-gap matches.

v1.2 additions (VTSR-C -- commander ladder proof sections):
    10. VTSR-C duel prediction: chronological replay of the commander
        ladder (from elo_commander_history.json alone) predicting each
        duel's winner from pre-match state; accuracy + log-loss, plus a
        lambda ablation over the team-strength handicap weight
        (lambda in {0, 0.5, 1.0, 1.5} + canonical). Replay is
        cross-checked against the emitted ratings (integrity ~0 diff).
    11. Axis-vs-outcome sign agreement: per-axis team-mean
        axis_contributions difference (winner minus loser) across all
        determined rated matches -- the empirical ranking of which axes
        actually predict winning (the honest check on THUG_WEIGHTS).

v1.7 additions (critique v4 -- descriptive diagnostics, report schema 8):
    15. Performance ladder vs wins ladder: per-player Spearman/Pearson of
        ``thug_elo`` against the inert ``wins_elo`` ladder, the per-player
        gap table, and the gap's correlation with commander share.
    16. Team-outcome dependence of thug P_i: winner/loser mean P and
        delta, sign-flip shares, eta-squared of P by win/loss, and the
        high-rated breakout (the "stomp effect").
    17. Ship-denial gradient: thug rows banded by positioning
        ``at_base_pilot_share`` -> mean delta / P / team win share, with
        the per-outcome split that exposes the losing-team confound.
    18. Commander selection + role-adjustment audit: commander lobby
        percentile, concentration of the job, and per-player mean delta
        as commander vs as thug (the v2.4 axis-shift audit).
    19. Faction effect controlling for the ratings: offset logistic
        regression on the VTSR-C duel stream (canonical expected score as
        the offset; Hadean-vs-ISDF and Scion-vs-ISDF contrasts), fitted
        on the full corpus, per source, and on the confirmation sample
        the Phase 6 memo scores. Factions join from matches.json and
        data/external/f9_ledger.json. Pure-Python Newton; no new deps.
    None of 15-19 feeds validation_summary.json. The one actionable
    candidate (a faction-advantage term in the VTSR-C expected score) is
    governed by critique/decisions/phase-6-faction-advantage-term.md.

v1.8 addition (critique v4 addendum -- the format gate, report schema 9):
    20. Format gate: every excluded history entry by reason / shape /
        month; small-format (<= 2 per side) vs rated full-format medians
        of duration, kills / deaths / damage per player-minute, PvE share
        and peak pools; and a transfer test -- does the higher pre-match
        team-mean VTSR-T (or leader VTSR-C) predict the determined
        small-format winners? Loads the excluded matches' per-match
        files (the other sections never do). Descriptive; not in
        validation_summary.json.

Explicit non-goals (Phase 1 + 2A):
    - No changes to ``scripts/elo.py``.
    - No new fields on existing JSON outputs.
    - No dashboard surfacing.
    - No ``PIPELINE_VERSION`` / ``ELO_SCHEMA_VERSION`` bumps.
    - No new pip dependencies.

The proxy approximations (mean P_i ranking for ablation/Dirichlet,
sum-of-deltas for bootstrap rating) are documented inline at each call
site and re-stated in the report header.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VALIDATOR_VERSION = 9  # v1.8: format-gate audit (#20) on top of v1.7 (#15-#19)

# 2026-09-23 VTSR-C amendment. Confirmation duels are dated strictly after
# this day. Mirrors elo_commander.ECON_SEMANTICS_AMENDED_ON; the history
# header wins when it is present.
ECON_SEMANTICS_AMENDED_ON = "2026-09-23"
ECON_PROMOTE_MIN_CONFIRMATION = 25
ECON_PROMOTE_CI_FLOOR = 0.55
ECON_PROMOTE_MIN_AXES = 2
ECON_PROMOTE_CLOSE_FLOOR = 0.50
ECON_PROMOTE_CLOSE_MIN_N = 15
ECON_PROMOTE_CLOSE_FRAC = 0.75
ECON_PROMOTE_LOGLOSS_DELTA = 0.01
ECON_OPENING_WINDOW_SEC = 240.0
ECON_SCORED_AXES = ("pool_tempo", "combat_conversion", "regen_tempo")
# Retired full-match formulas, diagnostic only. Not a promote sample.
ECON_LEGACY_AXES = (
    "pool_full", "production_full", "replacement_full",
    "efficiency_full", "upgrade_full",
)
RECYCLER_STEMS = frozenset({"ibrecy_vsr", "ebrecym_vsr", "fbrecy_vsr"})

# Last-N windows for the ELO page. Determined = provable-winner matches
# the accuracy metrics already score. Rated = every non-excluded history
# row, provable or not. Tunable without a validation_summary schema bump.
RECENT_WINDOW_N = 30
PROVABLE_DECIDED_BY = ("clean_win", "attested", "adjudicated")

DEFAULT_PROCESSED_DIR = Path("data") / "processed"
DEFAULT_OUTPUT_DIR = Path("_validation")

# Bootstrap parameters.
BOOTSTRAP_RUNS = 100
BOOTSTRAP_SAMPLE_RATE = 0.8

# Dirichlet perturbation parameters.
DIRICHLET_RUNS = 50
DIRICHLET_CONCENTRATION = 50.0  # higher = tighter around current weights

# Top-N for Jaccard agreement reporting.
TOP_N = 20

# Synthetic-winner agreement threshold for unlocking Phase 2 ALPHA > 0.
SYNTHETIC_WINNER_THRESHOLD = 0.85

# Mirror of scripts/elo.py THUG_WEIGHTS at the time of writing. Captured
# here rather than imported to keep the validator a pure consumer of
# emitted JSON (no Python-import coupling to elo.py internals). If the
# pipeline THUG_WEIGHTS change, the validator will pick them up via
# elo_current.json's ``weights`` block; this constant is the fallback.
THUG_WEIGHTS_FALLBACK = {
    "net_damage_share":  0.20,
    "thug_kill_rate":    0.20,
    "thug_accuracy":     0.15,
    "thug_efficiency":   0.16,
    "pve_share":         0.12,
    "mobility":          0.08,
}

# Self-consistency floor: minimum matches per player to be included in
# split-half analysis.
SELF_CONSISTENCY_MIN_MATCHES = 10

# Calibration buckets.
CALIBRATION_N_BUCKETS = 10

# v1.1 diagnostic constants.
# Softmax temperature for MAX-weighted aggregation per Dehpanah et al. 2021
# (PUBG/LoL/CS:GO study finding MAX dominates SUM/MIN/Mean/Median for team
# threat in tactical shooters). tau = 200 is a moderate setting in our ELO
# range (anchor 1500, soft floor 1000, typical span 1300-1700) -- weighting
# strongly toward the highest-rated player without devolving to literal MAX.
SOFTMAX_TAU = 200.0

# Rating-gap magnitude buckets for clean_win prediction breakout. Boundaries
# in raw ELO units. Reflect the v2.5 corpus where typical lobby rating spread
# is ~150-300 ELO; a "large" gap of >100 is the top quartile.
RATING_GAP_BUCKETS = [
    ("small",  0.0,    25.0),
    ("mid",    25.0,   100.0),
    ("large",  100.0,  float("inf")),
]

# v1.2 (VTSR-C) constants.
# Lambda values for the team-strength-handicap ablation. The canonical
# lambda from elo_commander_history.json is merged in if absent, so the
# emitted ladder's setting is always scored alongside the alternatives.
CMDR_LAMBDA_ABLATION = [0.0, 0.5, 1.0, 1.5]

# v1.4 (Balonce Meter): T-term ablation grids. Pre-registered in
# critique/decisions/balonce-meter-t-term.md -- read that memo BEFORE
# touching these, and never retune them to chase an observed result.
# lambda2 grid for the V3 three-term variant (commander-VTSR-T gap as its
# own weighted term). Coarse on purpose: a finely-swept second dial on a
# ~120-duel subset is how a model learns noise.
CMDR_T_LAMBDA2_GRID = [0.25, 0.5, 1.0]
# tau grid for softmax thug aggregation (Q3). SOFTMAX_TAU (200) is the
# Phase 2A/2C value and is always included.
CMDR_T_SOFTMAX_TAUS = [100.0, 200.0, 400.0]
# Reliability bands for the promote rule's condition 4 (the gain must not
# be confined to one confidence bucket). Mirrors the Balonce Meter's own
# strip in js/balonce-meter.js.
CMDR_T_BANDS = [(0.50, 0.55), (0.55, 0.65), (0.65, 0.75), (0.75, 1.01)]

# Fallbacks mirroring scripts/elo_commander.py constants -- used only when
# the history JSON predates a field (keeps the validator a pure consumer
# of emitted JSON, no Python-import coupling).
CMDR_ANCHOR_FALLBACK = 1500.0
CMDR_K_BASE_FALLBACK = 40.0
CMDR_K_FLOOR_FALLBACK = 20.0
CMDR_PROVISIONAL_PRIOR_FALLBACK = 5.0
CMDR_LOGISTIC_SCALE_FALLBACK = 400.0
CMDR_LAMBDA_FALLBACK = 1.0

# decided_by values whose matches count as DETERMINED for the
# axis-vs-outcome study (winner.team in (1, 2)). Draws carry no winner
# and are excluded by construction.
AXIS_OUTCOME_DECIDED_BY = ("clean_win", "attested", "adjudicated", "contested")

# v1.7 (critique v4) constants. All five new sections are DIAGNOSTIC:
# they describe the canonical ratings and the corpus, they never change
# a rating, and none of them feeds validation_summary.json. The one
# actionable candidate they surface (a faction-advantage term in the
# VTSR-C expected score) is governed by the pre-registered memo
# critique/decisions/phase-6-faction-advantage-term.md -- read it before
# touching any constant below, and never retune one to chase a result.
#
# §15 perf-vs-wins: a player enters the thug_elo-vs-wins_elo comparison
# once they have this many rated matches (both ladders need games to
# have moved off the anchor).
PERF_VS_WINS_MIN_MATCHES = 20
# §16 team-outcome dependence: the "high-rated" cut for the losing-team
# breakout. Roughly the top tier boundary in the current distribution.
HIGH_RATED_THRESHOLD = 1650.0
# §17 ship-denial gradient: bands over positioning
# ``metrics.at_base_pilot_share`` (share of the match a thug spent on foot
# inside their own base radius -- "ship-denied" time).
SHIP_DENIAL_BANDS = [
    ("<5%",    0.00, 0.05),
    ("5-15%",  0.05, 0.15),
    ("15-30%", 0.15, 0.30),
    (">=30%",  0.30, 1.01),
]
# §18 commander selection: a player appears in the per-player
# commander-vs-thug delta table once they have this many rows in BOTH
# roles.
CMDR_SELECTION_MIN_ROWS = 5
# §19 faction effect: faction codes as emitted by process_stats
# (team_factions[side].code) and by the F9 ledger importer (full names).
FACTION_CODES = {"i": "i", "e": "e", "f": "f",
                 "ISDF": "i", "Hadean": "e", "Scion": "f"}
FACTION_NAMES = {"i": "ISDF", "e": "Hadean", "f": "Scion"}
# Logistic-regression fit controls (pure-Python Newton on 2 params).
FACTION_FIT_MAX_ITER = 50
FACTION_FIT_TOL = 1e-9
# Discovery/confirmation split for the faction memo: duels dated strictly
# after this day are the confirmation sample. Mirrors the memo; the memo
# wins if they ever disagree.
FACTION_DISCOVERY_CUTOFF = "2026-10-04"
# The FROZEN candidate term the memo pre-registers (rating points added
# to the side fielding the faction; ISDF is the zero reference). Set from
# the discovery fit, rounded, and never refit on the confirmation sample:
# the confirmation rows judge these exact numbers.
FACTION_FROZEN_POINTS = {"i": 0.0, "e": 60.0, "f": 0.0}
# Promote-rule thresholds (mirror of the memo; the memo wins).
FACTION_PROMOTE_MIN_CONFIRMATION = 60
FACTION_PROMOTE_LOGLOSS_DELTA = 0.005
# §20 format gate (v1.8): a match is "small format" when neither side has
# more than this many non-campod rows (1v1, 2v2, 2v1 ...). The dynamics
# comparison keeps only games at least FORMAT_MIN_DURATION_SEC long so a
# 14-second misclick does not define the small-format medians.
FORMAT_SMALL_MAX_PER_SIDE = 2
FORMAT_MIN_DURATION_SEC = 240.0


# ---------------------------------------------------------------------------
# Stdlib statistical helpers (numpy/scipy-free by Phase 1 design)
# ---------------------------------------------------------------------------


def _rank_average(values: list[float]) -> list[float]:
    """Average rank (1-indexed). Ties get the average of the tied positions
    (standard Spearman convention). O(n log n).
    """
    n = len(values)
    if n == 0:
        return []
    indexed = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        # Walk forward over equal-value runs.
        while j + 1 < n and values[indexed[j + 1]] == values[indexed[i]]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0  # 1-indexed average of tied positions
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg_rank
        i = j + 1
    return ranks


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    """Pearson correlation. Returns ``None`` for n<2 or zero-variance."""
    n = len(xs)
    if n != len(ys) or n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    denom_x = math.sqrt(sum((xs[i] - mx) ** 2 for i in range(n)))
    denom_y = math.sqrt(sum((ys[i] - my) ** 2 for i in range(n)))
    if denom_x < 1e-12 or denom_y < 1e-12:
        return None
    return num / (denom_x * denom_y)


def spearman(xs: list[float], ys: list[float]) -> float | None:
    """Spearman rank correlation in [-1, +1]. ``None`` if undefined.

    Implemented as Pearson on average-ranks (handles ties correctly).
    """
    if len(xs) != len(ys) or len(xs) < 2:
        return None
    return _pearson(_rank_average(xs), _rank_average(ys))


def wilson_ci(
    successes: int, total: int, z: float = 1.96
) -> tuple[float, float]:
    """Two-sided Wilson score interval for a binomial proportion.

    Better-than-normal-approx for small n and edge proportions. Returns
    ``(lo, hi)`` in [0, 1]. ``(0.0, 1.0)`` when ``total <= 0``.
    """
    if total <= 0:
        return (0.0, 1.0)
    p = successes / total
    z2 = z * z
    denom = 1.0 + z2 / total
    centre = (p + z2 / (2.0 * total)) / denom
    half = (z * math.sqrt(p * (1.0 - p) / total + z2 / (4.0 * total * total))) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def dirichlet_sample(
    alphas: list[float], rng: random.Random
) -> list[float]:
    """Sample from a Dirichlet(alphas) via independent Gamma draws then
    normalize. Stdlib-only via ``random.gammavariate``.

    Caller is responsible for the parametrization: e.g. for a Dirichlet
    centered on weights ``w`` with concentration ``c``, pass ``alphas =
    [c * w_i for i in ...]`` so the mean equals ``w``.
    """
    g = [rng.gammavariate(a, 1.0) if a > 0 else 0.0 for a in alphas]
    s = sum(g)
    if s <= 0.0:
        # Pathological — degenerate to the prior mean.
        n = len(alphas)
        return [1.0 / n] * n if n > 0 else []
    return [v / s for v in g]


def jaccard(a: set, b: set) -> float:
    """Jaccard similarity |A ∩ B| / |A ∪ B|. ``1.0`` for empty-empty."""
    if not a and not b:
        return 1.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def median(values: list[float]) -> float:
    """Stdlib median; ``0.0`` on empty input."""
    if not values:
        return 0.0
    return statistics.median(values)


def mean(values: list[float]) -> float:
    """Stdlib mean; ``0.0`` on empty input."""
    if not values:
        return 0.0
    return sum(values) / len(values)


def stdev(values: list[float]) -> float:
    """Population std; ``0.0`` for n<2."""
    if len(values) < 2:
        return 0.0
    return statistics.pstdev(values)


def softmax_weighted(values: list[float], tau: float = SOFTMAX_TAU) -> float:
    """Softmax-weighted aggregation: ``Σ v_j · exp(v_j / τ) / Σ exp(v_j / τ)``.

    Approaches ``max(values)`` as ``tau -> 0`` and approaches ``mean(values)``
    as ``tau -> infinity``. Per Dehpanah et al. 2021, tactical shooters'
    team-threat aggregation is dominated by the highest-rated player; this
    helper provides the smoothed-MAX alternative to literal ``max()`` (which
    is noisy on small lobbies). ``tau`` defaults to ``SOFTMAX_TAU`` (200) --
    Dehpanah-recommended for ELO-scale ratings.

    Numerical guard: subtracts the max before exponentiating to avoid
    overflow on big rating spans.
    """
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    if tau <= 0.0:
        return max(values)
    vmax = max(values)
    weights = [math.exp((v - vmax) / tau) for v in values]
    total_w = sum(weights)
    if total_w <= 0.0:
        return vmax
    return sum(values[i] * weights[i] for i in range(len(values))) / total_w


def expected_performance(
    r_i: float, r_opponents_ref: float, scale: float = 800.0
) -> float:
    """Mirror of ``scripts/elo.py::expected_performance``. Captured here
    so the validator stays a pure JSON consumer (no elo.py import).

    Used for: (a) calibration plot, predicting E_i fresh from R_i (we
    also have it stored on each delta as ``expected``, but recomputing
    is cheap and lets us cross-check). (b) clean_win log-loss, where we
    convert team mean R into a winner-probability prediction.
    """
    exponent = (r_opponents_ref - r_i) / scale
    if exponent > 16.0:
        return -1.0
    if exponent < -16.0:
        return 1.0
    return 2.0 / (1.0 + 10.0 ** exponent) - 1.0


# ---------------------------------------------------------------------------
# Data loaders
# ---------------------------------------------------------------------------


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_corpus(processed_dir: Path) -> dict[str, Any]:
    """Load every artifact the validator reads, once, up front.

    Returns a dict with:
        - ``current``: parsed elo_current.json
        - ``history``: parsed elo_history.json (deltas keyed by match)
        - ``manifest``: parsed matches.json (manifest, chronological)
        - ``per_match``: ``{match_id: parsed match JSON}`` for every rated
          match present in elo_history that has a matching file on disk.
        - ``weights``: the active THUG_WEIGHTS dict (from elo_current
          when available, fallback to module constant otherwise)
    """
    current = _load_json(processed_dir / "elo_current.json")
    history = _load_json(processed_dir / "elo_history.json")
    manifest = _load_json(processed_dir / "matches.json")

    # The manifest is a flat list of {id, date, ...} entries. The
    # validator only uses it as a chronological order witness so
    # downstream code can sanity-check that elo_history matches manifest
    # ordering (a soft check; we trust elo_history's order primarily).
    if not isinstance(manifest, list):
        raise ValueError(
            f"Expected matches.json to be a list, got {type(manifest).__name__}"
        )

    weights = dict(current.get("weights") or THUG_WEIGHTS_FALLBACK)

    per_match: dict[str, Any] = {}
    history_entries = (history or {}).get("history") or []
    for entry in history_entries:
        if entry.get("match_excluded"):
            continue
        match_id = entry.get("match_id")
        if not match_id:
            continue
        match_path = processed_dir / f"{match_id}.json"
        if not match_path.exists():
            # Silently skip; downstream metrics that need per-match data
            # will report the eligibility shortfall in their counts.
            continue
        try:
            per_match[match_id] = _load_json(match_path)
        except Exception:
            continue

    return {
        "current": current,
        "history": history,
        "manifest": manifest,
        "per_match": per_match,
        "weights": weights,
    }


def iter_rated_history(history: dict[str, Any]):
    """Yield ``(match_id, match_date, deltas)`` for every rated entry in
    ``elo_history.history``. Skips ``match_excluded`` entries.
    """
    for entry in (history or {}).get("history") or []:
        if entry.get("match_excluded"):
            continue
        deltas = entry.get("deltas") or []
        if not deltas:
            continue
        yield (
            entry.get("match_id") or "",
            entry.get("match_date") or "",
            deltas,
        )


def faction_lookup_for_match(match_data: dict[str, Any]) -> dict[str, int]:
    """Build a ``{steam64: faction (1|2)}`` lookup from a per-match
    leaderboard. Names fall back as a secondary key when ``steam64`` is
    missing on a row (legacy / pre-Nomad rows).

    Excludes rows flagged ``is_campod`` / ``is_low_activity`` because
    those rows aren't part of the rated lobby (matches the elo.py
    pure-omission contract). Commander rows are kept (canonical mode);
    callers that want the thugs-only view should pull from the alt
    elo_history file instead, not filter here.
    """
    lookup: dict[str, int] = {}
    for row in match_data.get("leaderboard") or []:
        if row.get("is_campod") or row.get("is_low_activity"):
            continue
        faction = row.get("faction")
        if faction not in (1, 2):
            continue
        steam64 = row.get("steam64")
        if steam64:
            lookup[str(steam64)] = int(faction)
        # Name fallback for rows without steam64 (legacy / placeholder).
        name = row.get("name")
        if name and str(name) not in lookup:
            lookup[str(name)] = int(faction)
    return lookup


def player_key_for_delta(delta: dict[str, Any]) -> str:
    """Stable per-player key. Prefers ``steam64`` (matches the
    elo.py keying convention) and falls back to ``name`` so legacy
    deltas without a steam64 still join through faction_lookup_for_match.
    """
    s64 = delta.get("steam64")
    if s64:
        return str(s64)
    return str(delta.get("name") or "")


# ---------------------------------------------------------------------------
# Metric #1: pre-match R_i -> post-match P_i Spearman rank correlation
# ---------------------------------------------------------------------------


def metric_rank_correlation(history: dict[str, Any]) -> dict[str, Any]:
    """Headline metric: does pre-match rating predict in-match performance?

    For every rated delta, pair ``(R_before, P_i)`` then compute the
    Spearman rank correlation across all such pairs across the entire
    rated corpus. High positive ρ means higher-rated players reliably
    score higher composite-performance scores; ρ ≈ 0 would mean the
    rating tells us nothing about expected per-match performance.

    Per-match-pooled correlation is also reported (Spearman within each
    match, then averaged) -- this controls for between-match P_i drift
    (e.g. easy maps inflate everyone's P_i but rating gaps remain).
    """
    pooled_R: list[float] = []
    pooled_P: list[float] = []
    per_match_rho: list[float] = []
    per_match_n: list[int] = []

    for _, _, deltas in iter_rated_history(history):
        match_R: list[float] = []
        match_P: list[float] = []
        for d in deltas:
            r = d.get("before")
            p = d.get("performance")
            if r is None or p is None:
                continue
            pooled_R.append(float(r))
            pooled_P.append(float(p))
            match_R.append(float(r))
            match_P.append(float(p))
        if len(match_R) >= 3:
            rho = spearman(match_R, match_P)
            if rho is not None and not math.isnan(rho):
                per_match_rho.append(rho)
                per_match_n.append(len(match_R))

    pooled_rho = spearman(pooled_R, pooled_P)

    return {
        "pooled_rho":           pooled_rho,
        "pooled_n_pairs":       len(pooled_R),
        "per_match_rho_mean":   mean(per_match_rho) if per_match_rho else None,
        "per_match_rho_median": median(per_match_rho) if per_match_rho else None,
        "per_match_rho_stdev":  stdev(per_match_rho) if per_match_rho else None,
        "per_match_n_runs":     len(per_match_rho),
    }


# ---------------------------------------------------------------------------
# Metric #2: Calibration plot (table form)
# ---------------------------------------------------------------------------


def metric_calibration(
    history: dict[str, Any],
    n_buckets: int = CALIBRATION_N_BUCKETS,
) -> dict[str, Any]:
    """Bucket each player-match by ``(R_i - median(R_others_in_match))``,
    then compare observed mean P_i against the predicted E_i curve.

    Cambridge skillbench's calibration test in plot form. We render as a
    markdown table since Phase 1 has no plotting (matplotlib avoided to
    keep stdlib-only). Buckets are equal-frequency over the rating-gap
    distribution (so each bucket has comparable n).

    Returns one row per bucket: gap range, n, observed mean P_i,
    predicted mean E_i (re-derived via expected_performance), residual.
    """
    pairs: list[tuple[float, float, float]] = []  # (gap, P, predicted_E)

    for _, _, deltas in iter_rated_history(history):
        ratings_before = [
            float(d["before"])
            for d in deltas
            if d.get("before") is not None
        ]
        if len(ratings_before) < 2:
            continue
        for d in deltas:
            r = d.get("before")
            p = d.get("performance")
            if r is None or p is None:
                continue
            others = [x for x in ratings_before if x != r] or ratings_before
            r_med = median(others)
            gap = float(r) - r_med
            e = expected_performance(float(r), r_med)
            pairs.append((gap, float(p), e))

    if not pairs:
        return {"buckets": [], "total_pairs": 0}

    pairs.sort(key=lambda t: t[0])
    n = len(pairs)
    buckets: list[dict[str, Any]] = []
    bucket_size = max(1, n // n_buckets)
    for b in range(n_buckets):
        lo = b * bucket_size
        hi = (b + 1) * bucket_size if b < n_buckets - 1 else n
        chunk = pairs[lo:hi]
        if not chunk:
            continue
        gaps = [t[0] for t in chunk]
        ps = [t[1] for t in chunk]
        es = [t[2] for t in chunk]
        observed = mean(ps)
        predicted = mean(es)
        buckets.append({
            "gap_min":         min(gaps),
            "gap_max":         max(gaps),
            "gap_mean":        mean(gaps),
            "n":               len(chunk),
            "observed_p_mean": observed,
            "predicted_e_mean": predicted,
            "residual":        observed - predicted,
        })

    # Calibration MAE: average absolute residual across buckets,
    # weighted by bucket count. Useful single-number summary.
    total_n = sum(b["n"] for b in buckets)
    if total_n > 0:
        cal_mae = sum(
            abs(b["residual"]) * b["n"] for b in buckets
        ) / total_n
    else:
        cal_mae = 0.0

    return {
        "buckets":         buckets,
        "total_pairs":     n,
        "calibration_mae": cal_mae,
    }


# ---------------------------------------------------------------------------
# Metric #3: Per-player split-half self-consistency
# ---------------------------------------------------------------------------


def metric_self_consistency(
    history: dict[str, Any],
    min_matches: int = SELF_CONSISTENCY_MIN_MATCHES,
) -> dict[str, Any]:
    """For each player with >= ``min_matches`` rated matches, split their
    chronological match list in half and compare mean P_i across halves.

    This is THE ceiling for any rating system reading from the composite:
    if a player's first-half P_i doesn't predict their second-half P_i,
    no rating layer can fix it -- the signal isn't there to extract.
    Spearman across players of (first_half_mean, second_half_mean) gives
    us that ceiling number.

    Excluded from analysis: players below the ``min_matches`` floor
    (counted separately); odd-match players have their middle match
    assigned to the second half.
    """
    by_player: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for match_id, match_date, deltas in iter_rated_history(history):
        for d in deltas:
            p = d.get("performance")
            if p is None:
                continue
            key = player_key_for_delta(d)
            by_player[key].append((match_date or match_id, float(p)))

    eligible_keys = []
    first_means: list[float] = []
    second_means: list[float] = []
    excluded_below_floor = 0

    for key, entries in by_player.items():
        if len(entries) < min_matches:
            excluded_below_floor += 1
            continue
        entries.sort(key=lambda t: t[0])
        n = len(entries)
        # Odd splits: middle match into second half.
        cut = n // 2
        first = [v for _, v in entries[:cut]]
        second = [v for _, v in entries[cut:]]
        if not first or not second:
            continue
        eligible_keys.append(key)
        first_means.append(mean(first))
        second_means.append(mean(second))

    rho = spearman(first_means, second_means) if len(first_means) >= 2 else None
    pooled_diff = (
        mean([abs(first_means[i] - second_means[i]) for i in range(len(first_means))])
        if first_means else 0.0
    )

    return {
        "n_players":            len(eligible_keys),
        "n_excluded_below_floor": excluded_below_floor,
        "min_matches_threshold": min_matches,
        "spearman_rho":         rho,
        "mean_abs_half_diff":   pooled_diff,
    }


# ---------------------------------------------------------------------------
# Metric #4: Bootstrap rating stability
# ---------------------------------------------------------------------------


def _build_per_match_player_table(
    history: dict[str, Any],
) -> tuple[list[str], dict[str, dict[str, float]], dict[str, dict[str, float]]]:
    """Pivot ``elo_history`` into match-id -> player-key -> P_i / delta.

    Returned tuple: ``(match_ids_chrono, p_by_match_player, dr_by_match_player)``.
    Both inner dicts only include players present in that match (sparse).

    Used by bootstrap (#4) and ablation (#8). The dr lookup is a proxy
    for "rating change attributable to this match" -- summing it from
    the anchor approximates a re-rating without re-running the rating
    sequential math (loss aversion / floor taper are baked into each
    delta, so the sum carries those forward; what's lost is the
    sequential R_before update chain, which we accept as the documented
    Phase 1 approximation).
    """
    match_ids: list[str] = []
    p_by_match: dict[str, dict[str, float]] = {}
    dr_by_match: dict[str, dict[str, float]] = {}
    for match_id, _, deltas in iter_rated_history(history):
        match_ids.append(match_id)
        per_player_p: dict[str, float] = {}
        per_player_dr: dict[str, float] = {}
        for d in deltas:
            key = player_key_for_delta(d)
            if not key:
                continue
            p = d.get("performance")
            dr = d.get("delta")
            if p is not None:
                per_player_p[key] = float(p)
            if dr is not None:
                per_player_dr[key] = float(dr)
        p_by_match[match_id] = per_player_p
        dr_by_match[match_id] = per_player_dr
    return match_ids, p_by_match, dr_by_match


def metric_bootstrap_stability(
    history: dict[str, Any],
    current: dict[str, Any],
    runs: int = BOOTSTRAP_RUNS,
    sample_rate: float = BOOTSTRAP_SAMPLE_RATE,
    top_n: int = TOP_N,
    seed: int = 12345,
) -> dict[str, Any]:
    """Resample matches at ``sample_rate`` (without replacement) and
    re-aggregate per-player mean P_i and rating-proxy ``anchor + Σ dr``,
    repeated ``runs`` times.

    Reports two aspects of stability:
        - top-N Jaccard agreement against the canonical top-N (defined
          by ``elo_current.ratings`` ordered by ``vtsr`` descending).
        - per-player rating-proxy std across runs. This is the
          'real ±N' confidence band the v2 doc asked for.

    Methodological note: rating-proxy = ``ANCHOR + Σ dr_per_match`` over
    resampled matches. Approximates true re-rating but does NOT redo the
    sequential R_before chain. Documented inline; Phase 2 can promote
    to true re-rating via importing ``compute_elo``.
    """
    rng = random.Random(seed)
    match_ids, p_by_match, dr_by_match = _build_per_match_player_table(history)
    n_matches = len(match_ids)
    if n_matches < 5:
        return {
            "runs":            0,
            "sample_rate":     sample_rate,
            "n_matches_total": n_matches,
            "skipped_reason":  "too few rated matches for meaningful bootstrap",
        }

    # Canonical top-N: elo_current ratings, ordered by vtsr desc, taking
    # the first top_n that have at least 1 rated match.
    canonical_ratings = current.get("ratings") or []
    canonical_keys: list[str] = []
    for r in canonical_ratings:
        if (r.get("matches_played") or 0) <= 0:
            continue
        key = str(r.get("steam64") or r.get("name") or "")
        if key:
            canonical_keys.append(key)
        if len(canonical_keys) >= top_n:
            break
    canonical_top_set = set(canonical_keys)

    sample_size = max(1, int(n_matches * sample_rate))

    per_player_proxy_runs: dict[str, list[float]] = defaultdict(list)
    per_player_meanP_runs: dict[str, list[float]] = defaultdict(list)
    jaccard_scores: list[float] = []

    elo_anchor = float(current.get("anchor") or 1500.0)

    for _ in range(runs):
        sampled = rng.sample(match_ids, sample_size)

        proxy_sum: dict[str, float] = defaultdict(lambda: elo_anchor)
        # Reset to anchor for keys we touch this run only; defaultdict
        # initial value isn't accumulator-friendly, switch to explicit.
        proxy_sum = defaultdict(lambda: 0.0)
        meanP_sum: dict[str, float] = defaultdict(float)
        meanP_n: dict[str, int] = defaultdict(int)

        for mid in sampled:
            for k, dr in dr_by_match.get(mid, {}).items():
                proxy_sum[k] += dr
            for k, p in p_by_match.get(mid, {}).items():
                meanP_sum[k] += p
                meanP_n[k] += 1

        # Convert sum-of-dr into rating proxy (anchor + Σ dr).
        run_rating: dict[str, float] = {
            k: elo_anchor + proxy_sum[k] for k in proxy_sum
        }
        run_meanP: dict[str, float] = {
            k: meanP_sum[k] / meanP_n[k] for k in meanP_n if meanP_n[k] > 0
        }

        for k, v in run_rating.items():
            per_player_proxy_runs[k].append(v)
        for k, v in run_meanP.items():
            per_player_meanP_runs[k].append(v)

        # Bootstrap top-N from this run.
        run_top = sorted(
            run_rating.items(), key=lambda kv: -kv[1]
        )[:top_n]
        run_top_set = {k for k, _ in run_top}
        jaccard_scores.append(jaccard(canonical_top_set, run_top_set))

    # Per-player std summary (across the runs they appeared in).
    proxy_std: dict[str, float] = {
        k: stdev(vals) for k, vals in per_player_proxy_runs.items()
    }
    meanP_std: dict[str, float] = {
        k: stdev(vals) for k, vals in per_player_meanP_runs.items()
    }

    proxy_std_values = list(proxy_std.values())
    meanP_std_values = list(meanP_std.values())

    return {
        "runs":            runs,
        "sample_rate":     sample_rate,
        "n_matches_total": n_matches,
        "n_sampled_per_run": sample_size,
        "top_n":           top_n,
        "jaccard_mean":    mean(jaccard_scores) if jaccard_scores else 0.0,
        "jaccard_median":  median(jaccard_scores) if jaccard_scores else 0.0,
        "jaccard_min":     min(jaccard_scores) if jaccard_scores else 0.0,
        "jaccard_max":     max(jaccard_scores) if jaccard_scores else 0.0,
        # Rating-proxy std (anchor + Σ dr): in ELO units, approximates
        # true rating std.
        "proxy_std_median": median(proxy_std_values) if proxy_std_values else 0.0,
        "proxy_std_mean":   mean(proxy_std_values) if proxy_std_values else 0.0,
        "proxy_std_max":    max(proxy_std_values) if proxy_std_values else 0.0,
        "n_players_with_proxy_std": len(proxy_std_values),
        # mean P_i std: dimensionless, in [0, ~0.5] for realistic data.
        "meanP_std_median": median(meanP_std_values) if meanP_std_values else 0.0,
        "meanP_std_mean":   mean(meanP_std_values) if meanP_std_values else 0.0,
        # Detail map for bootstrap.json artifact (per-player std plus
        # the run distribution itself for forensic diving).
        "per_player": {
            "proxy_std": proxy_std,
            "meanP_std": meanP_std,
        },
    }


# ---------------------------------------------------------------------------
# Metric #5/#6/#7: clean_win-anchored prediction (synthetic-winner +
# winner accuracy + log-loss)
# ---------------------------------------------------------------------------


def _gather_clean_win_matches(
    history: dict[str, Any],
    per_match: dict[str, Any],
) -> list[dict[str, Any]]:
    """Build the eligibility list for the clean_win-anchored metrics.

    Returns one row per eligible match: ``{match_id, winner_team,
    team_R_values, team_R_mean, team_R_max, team_R_softmax, team_P_mean,
    has_commander, ...}``. Excludes matches where we can't form both
    teams (single-faction lobbies, missing per-match file, all rated
    players on one side after exclusion-gate filtering).

    The ``winner`` block on each match is ALWAYS emitted (per the
    process_stats.py contract). We filter to ``decided_by ==
    "clean_win"`` here; ``contested`` and ``unclear`` outcomes are
    reported as a separate counter so users can see the eligibility
    funnel.

    v1.1 (Phase 2A): each row now carries the full per-team R distribution
    so downstream metrics can compute mean / hard MAX / softmax aggregations
    side-by-side. Also flags whether the match has at least one commander
    row in either team's rated lobby (commander-presence breakout test).
    """
    eligible: list[dict[str, Any]] = []

    # Build a quick steam64/name -> is_commander lookup per match. Runs
    # once outside the per-team aggregation loop.
    for match_id, match_date, deltas in iter_rated_history(history):
        match_data = per_match.get(match_id)
        if not match_data:
            continue
        winner_block = (match_data.get("match") or {}).get("winner") or {}
        decided_by = winner_block.get("decided_by")
        winner_team = winner_block.get("team")
        # v15: host-attested team wins ("attested") join the eligibility set
        # alongside clean_win inference -- real ground-truth labels from the
        # proto v3 outcome dialog. Contested/unclear/draw stay out; disputed
        # clean_wins stay IN (physical evidence overrode a contradicting
        # attestation, so the inference is the trusted label). v16 adds
        # "adjudicated" -- reviewer-confirmed team wins from the pipeline's
        # outcome-review prompt, the strongest label of all.
        if decided_by not in ("clean_win", "attested", "adjudicated"):
            continue
        if winner_team not in (1, 2):
            continue

        factions = faction_lookup_for_match(match_data)
        if not factions:
            continue

        # Build commander-presence lookup: {key: bool}. Mirrors
        # faction_lookup_for_match's exclusion-gate filtering.
        commander_lookup: dict[str, bool] = {}
        for row in match_data.get("leaderboard") or []:
            if row.get("is_campod") or row.get("is_low_activity"):
                continue
            is_cmdr = bool(row.get("is_commander"))
            steam64 = row.get("steam64")
            if steam64:
                commander_lookup[str(steam64)] = is_cmdr
            name = row.get("name")
            if name:
                commander_lookup.setdefault(str(name), is_cmdr)

        team_R: dict[int, list[float]] = {1: [], 2: []}
        team_P: dict[int, list[float]] = {1: [], 2: []}
        team_has_cmdr: dict[int, bool] = {1: False, 2: False}
        for d in deltas:
            key = player_key_for_delta(d)
            faction = factions.get(key)
            if faction not in (1, 2):
                name = d.get("name")
                if name:
                    faction = factions.get(str(name))
            if faction not in (1, 2):
                continue
            r = d.get("before")
            p = d.get("performance")
            if r is None or p is None:
                continue
            team_R[faction].append(float(r))
            team_P[faction].append(float(p))
            # Look up commander flag using the same key-fallback chain.
            is_cmdr = commander_lookup.get(key)
            if is_cmdr is None:
                name = d.get("name")
                if name:
                    is_cmdr = commander_lookup.get(str(name))
            if is_cmdr:
                team_has_cmdr[faction] = True

        if not team_R[1] or not team_R[2]:
            continue

        eligible.append({
            "match_id":        match_id,
            "match_date":      match_date or "",
            "winner_team":     winner_team,
            "loser_team":      3 - winner_team,
            # v15: label provenance ("clean_win" inference vs "attested"
            # host confirmation) so reports can split cohorts.
            "decided_by":      decided_by,
            "team_R_values":   {1: list(team_R[1]), 2: list(team_R[2])},
            "team_R_mean":     {1: mean(team_R[1]), 2: mean(team_R[2])},
            "team_R_max":      {1: max(team_R[1]), 2: max(team_R[2])},
            "team_R_softmax":  {
                1: softmax_weighted(team_R[1]),
                2: softmax_weighted(team_R[2]),
            },
            "team_P_mean":     {1: mean(team_P[1]), 2: mean(team_P[2])},
            "team_n_rated":    {1: len(team_R[1]), 2: len(team_R[2])},
            "team_has_commander": dict(team_has_cmdr),
            "any_commander":   team_has_cmdr[1] or team_has_cmdr[2],
        })

    return eligible


def metric_synthetic_winner(
    history: dict[str, Any],
    per_match: dict[str, Any],
) -> dict[str, Any]:
    """Validate the synthetic-winner proxy: predict the winner as the
    team with higher mean P_i, compare to clean_win ground truth.

    The single highest-leverage experiment in v2 §9: if agreement is
    >= 85%, we can use ``synthetic_winner = team with higher mean P_i``
    as a proxy on the FULL corpus (~150 rated matches) instead of just
    the clean_win subset (~50 matches). This unlocks Phase 2's
    ALPHA > 0 sweep without requiring more reliable winner data.
    """
    eligible = _gather_clean_win_matches(history, per_match)
    if not eligible:
        return {
            "n_eligible":     0,
            "agreement":      None,
            "agreement_ci":   None,
            "passes_threshold": False,
            "threshold":      SYNTHETIC_WINNER_THRESHOLD,
            "disagreements":  [],
        }

    agreements = 0
    disagreements: list[dict[str, Any]] = []
    for row in eligible:
        p1, p2 = row["team_P_mean"][1], row["team_P_mean"][2]
        if p1 == p2:
            # Tie: count as half? We count as DISAGREEMENT to be
            # conservative; real ties are vanishingly rare given P_i
            # is a sum of weighted continuous z-scores.
            disagreements.append({
                "match_id":      row["match_id"],
                "declared_winner": row["winner_team"],
                "predicted_winner": None,
                "team1_meanP":   p1,
                "team2_meanP":   p2,
                "gap":           0.0,
            })
            continue
        predicted = 1 if p1 > p2 else 2
        if predicted == row["winner_team"]:
            agreements += 1
        else:
            disagreements.append({
                "match_id":      row["match_id"],
                "declared_winner": row["winner_team"],
                "predicted_winner": predicted,
                "team1_meanP":   p1,
                "team2_meanP":   p2,
                "gap":           abs(p1 - p2),
            })

    n = len(eligible)
    rate = agreements / n
    ci = wilson_ci(agreements, n)

    # Sort disagreements by gap (descending) so the most "wrong" calls
    # surface first -- those are the base-rush / sandbag edge cases the
    # user cares about reviewing.
    disagreements.sort(key=lambda r: -r["gap"])

    return {
        "n_eligible":         n,
        "n_agreements":       agreements,
        "agreement":          rate,
        "agreement_ci":       list(ci),
        "passes_threshold":   rate >= SYNTHETIC_WINNER_THRESHOLD,
        "threshold":          SYNTHETIC_WINNER_THRESHOLD,
        "disagreements":      disagreements,
    }


def _score_aggregation(
    eligible: list[dict[str, Any]],
    aggregation_key: str,  # "team_R_mean" / "team_R_max" / "team_R_softmax"
    elo_scale: float = 800.0,
) -> dict[str, Any]:
    """Score one team-rating aggregation method against clean_win ground truth.

    Returns ``{n_eligible, n_correct, accuracy, accuracy_ci, log_loss_mean,
    log_loss_median}``. Used by the v1.1 MAX-vs-median preview to report
    accuracy + log-loss for each of the three aggregations side-by-side.
    """
    if not eligible:
        return {
            "n_eligible":      0,
            "n_correct":       0,
            "accuracy":        None,
            "accuracy_ci":     [None, None],
            "log_loss_mean":   None,
            "log_loss_median": None,
        }

    correct = 0
    log_loss_terms: list[float] = []
    for row in eligible:
        r1 = row[aggregation_key][1]
        r2 = row[aggregation_key][2]
        winner = row["winner_team"]
        if r1 != r2:
            predicted = 1 if r1 > r2 else 2
            if predicted == winner:
                correct += 1
        ep = expected_performance(r1, r2, scale=elo_scale)
        p_team1_wins = (ep + 1.0) / 2.0
        eps = 1e-9
        p_team1_wins = max(eps, min(1.0 - eps, p_team1_wins))
        if winner == 1:
            log_loss_terms.append(-math.log(p_team1_wins))
        else:
            log_loss_terms.append(-math.log(1.0 - p_team1_wins))

    n = len(eligible)
    return {
        "n_eligible":      n,
        "n_correct":       correct,
        "accuracy":        correct / n,
        "accuracy_ci":     list(wilson_ci(correct, n)),
        "log_loss_mean":   mean(log_loss_terms) if log_loss_terms else None,
        "log_loss_median": median(log_loss_terms) if log_loss_terms else None,
    }


def _prediction_correct(row: dict[str, Any], aggregation_key: str) -> bool:
    """True when this aggregation's favorite team is the recorded winner.

    A tied reference (both teams equal) is not a correct call — same rule
    as ``_score_aggregation``.
    """
    r1 = row[aggregation_key][1]
    r2 = row[aggregation_key][2]
    if r1 == r2:
        return False
    predicted = 1 if r1 > r2 else 2
    return predicted == row["winner_team"]


def _recent_accuracy_block(eligible: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Hard-max (headline) plus mean / softmax on the last RECENT_WINDOW_N
    determined matches. ``accuracy`` at the top level IS the hard-max rate
    — that is the number the ELO page leads with.
    """
    if not eligible:
        return None
    window = eligible[-RECENT_WINDOW_N:]
    aggs: dict[str, Any] = {}
    for name, key in (
        ("mean", "team_R_mean"),
        ("hard_max", "team_R_max"),
        ("softmax_max", "team_R_softmax"),
    ):
        scored = _score_aggregation(window, key)
        aggs[name] = {
            "n_correct":    scored["n_correct"],
            "accuracy":     scored["accuracy"],
            "accuracy_ci":  scored["accuracy_ci"],
        }
    hard = aggs["hard_max"]
    return {
        "window_n":    RECENT_WINDOW_N,
        "n":           len(window),
        "since_date":  (window[0].get("match_date") or "")[:10],
        "n_correct":   hard["n_correct"],
        "accuracy":    hard["accuracy"],
        "accuracy_ci": hard["accuracy_ci"],
        "aggregations": aggs,
    }


def _accuracy_timeline(eligible: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per determined match, chronological. The page draws
    cumulative and rolling-30 from ``correct_hard_max``; do not pre-bake
    those series here.
    """
    return [
        {
            "date": (row.get("match_date") or "")[:10],
            "correct_hard_max": _prediction_correct(row, "team_R_max"),
        }
        for row in eligible
    ]


def _commander_breakout(eligible: list[dict[str, Any]]) -> dict[str, Any]:
    """v1.1: split clean_win matches into "with commander" vs "all thug"
    cohorts, score the canonical mean-R aggregation in each cohort.

    Tests the hypothesis that v2.4's commander axis-shifts dampen
    commander R growth, dragging team mean R artificially low and
    breaking team-outcome prediction. If "all thug" matches predict
    well but "with commander" matches don't, the dampening is the
    culprit. If both predict equally poorly, the issue is elsewhere.
    """
    with_cmdr = [r for r in eligible if r["any_commander"]]
    all_thug = [r for r in eligible if not r["any_commander"]]

    return {
        "with_commander":   _score_aggregation(with_cmdr, "team_R_mean"),
        "all_thug":         _score_aggregation(all_thug, "team_R_mean"),
        "n_with_commander": len(with_cmdr),
        "n_all_thug":       len(all_thug),
    }


def _rating_gap_breakout(eligible: list[dict[str, Any]]) -> dict[str, Any]:
    """v1.1: bucket clean_win matches by ``|team_1_mean_R - team_2_mean_R|``,
    score the canonical mean-R aggregation in each bucket.

    Sanity check: if rating means anything at all, large-gap matches
    should be highly predictable (rating gap of 100+ ELO is "the team
    that should win, wins"). If small-gap matches predict well and
    large-gap don't, that's a screaming indicator the rating is
    backwards or the aggregation is wrong. If small-gap matches predict
    near 50% (random) and large-gap matches predict 70-80%, that's
    actually HEALTHY -- it's the close games that are unpredictable.
    """
    by_bucket: dict[str, list[dict[str, Any]]] = {
        name: [] for name, _, _ in RATING_GAP_BUCKETS
    }
    for row in eligible:
        gap = abs(row["team_R_mean"][1] - row["team_R_mean"][2])
        for name, lo, hi in RATING_GAP_BUCKETS:
            if lo <= gap < hi:
                by_bucket[name].append(row)
                break

    out: dict[str, Any] = {
        "buckets": [],
    }
    for name, lo, hi in RATING_GAP_BUCKETS:
        rows = by_bucket[name]
        out["buckets"].append({
            "bucket":      name,
            "gap_min":     lo,
            "gap_max":     hi if hi != float("inf") else None,
            "n":           len(rows),
            "score":       _score_aggregation(rows, "team_R_mean"),
            "mean_gap_in_bucket": mean(
                [abs(r["team_R_mean"][1] - r["team_R_mean"][2]) for r in rows]
            ) if rows else 0.0,
        })
    return out


def metric_clean_win_accuracy(
    history: dict[str, Any],
    per_match: dict[str, Any],
) -> dict[str, Any]:
    """Predict winner from each team's pre-match R, score against
    clean_win ground truth. v1.1 reports three aggregations side-by-side
    (mean / hard MAX / softmax-weighted MAX with tau=200) plus two
    diagnostic breakouts (commander-presence, rating-gap magnitude).

    Anchors us to Cambridge skillbench numbers: WinRate baseline ~60%,
    Elo / Glicko2 / TrueSkill 62-65%, TrueSkillPlayers 64.1%. Our
    expected operating range given small-N is ~60-70% with wide CIs.

    The MAX-vs-median preview directly tests the v2 doc §6.1 claim
    (Dehpanah et al. 2021: MAX dominates SUM/MIN/Mean/Median for team
    threat in tactical shooters). If MAX or softmax-MAX clearly beats
    mean here, that's the empirical receipt for changing compute_elo's
    `expected_performance` reference rating in Phase 2C.
    """
    eligible = _gather_clean_win_matches(history, per_match)
    if not eligible:
        return {
            "n_eligible":  0,
            "skipped_reason": "no clean_win matches with both teams represented",
            "recent": None,
            "accuracy_timeline": [],
        }

    # Three parallel scorings: mean / hard MAX / softmax MAX.
    by_aggregation = {
        "mean":         _score_aggregation(eligible, "team_R_mean"),
        "hard_max":     _score_aggregation(eligible, "team_R_max"),
        "softmax_max":  _score_aggregation(eligible, "team_R_softmax"),
    }

    # Pick a winner: highest accuracy, tiebreak by lower log-loss.
    def _agg_score(name: str) -> tuple[float, float]:
        s = by_aggregation[name]
        return (s["accuracy"] or 0.0, -(s["log_loss_mean"] or float("inf")))

    sorted_aggs = sorted(by_aggregation.keys(), key=_agg_score, reverse=True)
    best = sorted_aggs[0]

    # Headline figures from the canonical mean aggregation (kept under
    # legacy keys so existing JS / report consumers don't break).
    canonical = by_aggregation["mean"]

    return {
        "n_eligible":         canonical["n_eligible"],
        "n_correct":          canonical["n_correct"],
        "accuracy":           canonical["accuracy"],
        "accuracy_ci":        canonical["accuracy_ci"],
        "log_loss_mean":      canonical["log_loss_mean"],
        "log_loss_median":    canonical["log_loss_median"],
        "log_loss_coin_flip": math.log(2.0),
        "skillbench_anchors": {
            "winrate_baseline_pct":  0.60,
            "elo_pct":               0.62,
            "glicko2_pct":           0.64,
            "trueskill_pct":         0.629,
            "trueskill_players_pct": 0.641,
        },
        # v1.1: MAX-vs-median preview.
        "aggregations":      by_aggregation,
        "best_aggregation":  best,
        "softmax_tau":       SOFTMAX_TAU,
        # v1.1: diagnostic breakouts.
        "commander_breakout":  _commander_breakout(eligible),
        "rating_gap_breakout": _rating_gap_breakout(eligible),
        # v1.5: recent-form window (hard-max headline) + per-match timeline.
        "recent":              _recent_accuracy_block(eligible),
        "accuracy_timeline":   _accuracy_timeline(eligible),
    }


def count_winner_funnel(
    history: dict[str, Any], per_match: dict[str, Any]
) -> dict[str, Any]:
    """Eligibility funnel for the winner-anchored metrics. Reported in
    the report header so the user can see how many matches we threw
    out and why.
    """
    funnel = {
        "rated_history_entries":  0,
        "missing_per_match_file": 0,
        "winner_block_missing":   0,
        "decided_by_clean_win":   0,
        # v15: host-attested team wins from the proto v3 outcome dialog.
        # Ground-truth labels; pooled with clean_win in the winner-anchored
        # metrics' eligibility set.
        "decided_by_attested":    0,
        # v16: reviewer-confirmed team wins from the pipeline's
        # outcome-review prompt (operator overrode / supplied the outcome).
        # Also pooled into the eligibility set.
        "decided_by_adjudicated": 0,
        "decided_by_contested":   0,
        "decided_by_unclear":     0,
        # v15: attested no-winner outcomes. Never eligible for the
        # winner-anchored metrics (no winner to predict).
        "decided_by_draw":        0,
        # Note: rated history never contains cancelled matches (the ELO
        # pass excludes them), so no cancelled counter here.
        # v15: attestation contradicted a clean_win inference (kept as
        # clean_win with disputed=true). Subset of decided_by_clean_win.
        "disputed_outcomes":      0,
        "skipped_no_team_split":  0,
    }
    # (date, provable) in rated-history order, for the last-N window.
    rated_tail: list[tuple[str, bool]] = []
    for match_id, match_date, deltas in iter_rated_history(history):
        funnel["rated_history_entries"] += 1
        match_data = per_match.get(match_id)
        provable = False
        if not match_data:
            funnel["missing_per_match_file"] += 1
        else:
            winner_block = (match_data.get("match") or {}).get("winner") or {}
            decided_by = winner_block.get("decided_by")
            provable = (
                decided_by in PROVABLE_DECIDED_BY
                and winner_block.get("team") in (1, 2)
            )
            if not decided_by:
                funnel["winner_block_missing"] += 1
            elif decided_by == "clean_win":
                funnel["decided_by_clean_win"] += 1
                if winner_block.get("disputed"):
                    funnel["disputed_outcomes"] += 1
            elif decided_by == "attested":
                funnel["decided_by_attested"] += 1
            elif decided_by == "adjudicated":
                funnel["decided_by_adjudicated"] += 1
            elif decided_by == "contested":
                funnel["decided_by_contested"] += 1
            elif decided_by == "unclear":
                funnel["decided_by_unclear"] += 1
            elif decided_by == "draw":
                funnel["decided_by_draw"] += 1
        rated_tail.append((match_date or "", provable))
    window = rated_tail[-RECENT_WINDOW_N:]
    funnel["recent"] = {
        "window_n":   RECENT_WINDOW_N,
        "rated":      len(window),
        "determined": sum(1 for _, ok in window if ok),
        "since_date": (window[0][0][:10] if window else ""),
    }
    return funnel


# ---------------------------------------------------------------------------
# Metric #10 (v1.2): VTSR-C commander-ladder prediction + lambda ablation
# ---------------------------------------------------------------------------


def _cmdr_duel_key(commander: dict[str, Any]) -> str:
    """Stable per-commander key mirroring elo_commander.py's convention."""
    s64 = commander.get("steam64")
    if s64:
        return str(s64)
    return f"name:{commander.get('name') or ''}"


def metric_vtsr_c(cmdr_history: dict[str, Any] | None) -> dict[str, Any]:
    """Chronological replay of the VTSR-C ladder predicting each duel's
    winner from PRE-match state, at each lambda in CMDR_LAMBDA_ABLATION
    (plus the canonical lambda).

    Everything needed lives in ``elo_commander_history.json``: each duel
    carries both commanders' identities, the team thug means feeding the
    handicap term, and the outcome. The replay at the canonical lambda is
    cross-checked against the emitted ``after`` ratings
    (``replay_max_abs_diff`` should be ~0) -- a free integrity check that
    this replay implements exactly what the pipeline shipped.

    Scoring: draws are excluded from the accuracy denominator (nothing to
    predict); an exact E = 0.5 coin-flip earns half credit. Log-loss over
    the same non-draw set.
    """
    if not cmdr_history or not (cmdr_history.get("duels") or []):
        return {
            "available": False,
            "skipped_reason": "elo_commander_history.json missing or empty",
        }

    duels = cmdr_history["duels"]
    anchor = float(cmdr_history.get("anchor", CMDR_ANCHOR_FALLBACK))
    k_base = float(cmdr_history.get("k_base", CMDR_K_BASE_FALLBACK))
    k_floor = float(cmdr_history.get("k_floor", CMDR_K_FLOOR_FALLBACK))
    prior = float(cmdr_history.get("provisional_prior",
                                   CMDR_PROVISIONAL_PRIOR_FALLBACK))
    scale = float(cmdr_history.get("logistic_scale",
                                   CMDR_LOGISTIC_SCALE_FALLBACK))
    lam_canonical = float(cmdr_history.get("lambda_team_handicap",
                                           CMDR_LAMBDA_FALLBACK))

    lambdas = sorted(set(CMDR_LAMBDA_ABLATION) | {lam_canonical})

    def replay(lam: float) -> dict[str, Any]:
        rating: dict[str, float] = {}
        games: dict[str, int] = {}
        correct = 0.0
        scored = 0
        draws = 0
        ll_sum = 0.0
        max_abs_diff = 0.0
        for duel in duels:
            c1 = duel["commanders"]["1"]
            c2 = duel["commanders"]["2"]
            key1, key2 = _cmdr_duel_key(c1), _cmdr_duel_key(c2)
            r1 = rating.get(key1, anchor)
            r2 = rating.get(key2, anchor)
            th = duel.get("team_handicap") or {}
            t1, t2 = th.get("t1_thug_mean"), th.get("t2_thug_mean")
            handicap = lam * (t1 - t2) if (t1 is not None and t2 is not None) else 0.0
            e1 = 1.0 / (1.0 + 10.0 ** (-((r1 - r2) + handicap) / scale))

            outcome = duel.get("outcome")
            if outcome == "draw":
                s1 = 0.5
                draws += 1
            else:
                s1 = 1.0 if outcome == "team1" else 0.0
                scored += 1
                if e1 == 0.5:
                    correct += 0.5
                elif (e1 > 0.5) == (s1 == 1.0):
                    correct += 1.0
                e_realized = e1 if s1 == 1.0 else 1.0 - e1
                ll_sum += -math.log(max(1e-9, e_realized))

            g1, g2 = games.get(key1, 0), games.get(key2, 0)
            k1 = k_floor + (k_base - k_floor) * max(0.0, 1.0 - g1 / prior)
            k2 = k_floor + (k_base - k_floor) * max(0.0, 1.0 - g2 / prior)
            nr1 = r1 + k1 * (s1 - e1)
            nr2 = r2 + k2 * ((1.0 - s1) - (1.0 - e1))
            rating[key1], rating[key2] = nr1, nr2
            games[key1], games[key2] = g1 + 1, g2 + 1

            if lam == lam_canonical:
                a1, a2 = c1.get("after"), c2.get("after")
                if isinstance(a1, (int, float)):
                    max_abs_diff = max(max_abs_diff, abs(nr1 - a1))
                if isinstance(a2, (int, float)):
                    max_abs_diff = max(max_abs_diff, abs(nr2 - a2))

        accuracy = (correct / scored) if scored else None
        ci = list(wilson_ci(int(round(correct)), scored)) if scored else None
        return {
            "lambda": lam,
            "canonical": lam == lam_canonical,
            "n": scored,
            "n_draws": draws,
            "accuracy": accuracy,
            "accuracy_ci": ci,
            "log_loss": (ll_sum / scored) if scored else None,
            "replay_max_abs_diff": (
                round(max_abs_diff, 4) if lam == lam_canonical else None
            ),
        }

    per_lambda = [replay(lam) for lam in lambdas]
    canonical_row = next(r for r in per_lambda if r["canonical"])
    return {
        "available": True,
        "n_duels": len(duels),
        "n_scored": canonical_row["n"],
        "n_draws": canonical_row["n_draws"],
        "lambda_canonical": lam_canonical,
        "accuracy": canonical_row["accuracy"],
        "accuracy_ci": canonical_row["accuracy_ci"],
        "log_loss": canonical_row["log_loss"],
        "replay_max_abs_diff": canonical_row["replay_max_abs_diff"],
        "per_lambda": per_lambda,
    }


# ---------------------------------------------------------------------------
# Metric #14 (v1.4): Balonce Meter T-term ablations
# ---------------------------------------------------------------------------


def _duel_thug_detail(
    history: dict[str, Any], per_match: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Per-match, per-side pre-match rating detail the duel rows do not
    carry: the individual non-commander `before` ratings, the commander's
    own `before`, and the rated-row counts.

    Keyed by match_id. Only telemetry duels (which have a match_id that
    joins back to elo_history + the per-match JSON) get an entry; F9
    ledger rows cannot, which is the registered sample-size caveat.
    """
    out: dict[str, dict[str, Any]] = {}
    for entry in history.get("history") or []:
        if entry.get("match_excluded"):
            continue
        deltas = entry.get("deltas") or []
        if not deltas:
            continue
        mid = entry.get("match_id") or ""
        md = per_match.get(mid)
        if not md:
            continue
        lobby = md.get("leaderboard") or []
        by_s64 = {str(r["steam64"]): r for r in lobby if r.get("steam64")}
        by_name = {r.get("name"): r for r in lobby}
        thugs: dict[int, list[float]] = {1: [], 2: []}
        cmdr: dict[int, float | None] = {1: None, 2: None}
        for d in deltas:
            row = None
            s64 = d.get("steam64")
            if s64 is not None:
                row = by_s64.get(str(s64))
            if row is None:
                row = by_name.get(d.get("name"))
            if row is None:
                continue
            team = _slot_team_side(row.get("slot"))
            if team is None:
                continue
            before = d.get("before")
            if not isinstance(before, (int, float)):
                continue
            if row.get("is_commander"):
                if cmdr[team] is None:
                    cmdr[team] = float(before)
            else:
                thugs[team].append(float(before))
        out[mid] = {"thugs": thugs, "cmdr": cmdr}
    return out


def _slot_team_side(slot: Any) -> int | None:
    """Slot convention: 1-5 = team 1, 6-10 = team 2."""
    try:
        s = int(slot)
    except (TypeError, ValueError):
        return None
    if 1 <= s <= 5:
        return 1
    if 6 <= s <= 10:
        return 2
    return None


def _softmax_mean(values: list[float], tau: float) -> float | None:
    """Softmax-weighted mean: approaches max as tau -> 0, plain mean as
    tau -> inf. Shifted by the max before exponentiating (overflow-safe).
    """
    if not values:
        return None
    if tau <= 0:
        return max(values)
    top = max(values)
    weights = [math.exp((v - top) / tau) for v in values]
    total = sum(weights)
    if total <= 0:
        return sum(values) / len(values)
    return sum(v * w for v, w in zip(values, weights)) / total


def metric_cmdr_t_term(
    cmdr_history: dict[str, Any] | None,
    history: dict[str, Any],
    per_match: dict[str, Any],
) -> dict[str, Any]:
    """Score the pre-registered T-term variants from
    critique/decisions/balonce-meter-t-term.md.

    Every variant is replayed over the FULL duel stream (so each ladder
    evolves under its own rule) but SCORED only on the telemetry duels
    that carry the per-player detail the variants need -- and V0 is
    re-scored on that identical subset, so a variant is always compared
    against canonical on the same rows, never against canonical's
    full-corpus number (registered requirement).

    Q2 (uneven lobbies) is diagnostic only -- no promote rule.
    """
    if not cmdr_history or not (cmdr_history.get("duels") or []):
        return {
            "available": False,
            "skipped_reason": "elo_commander_history.json missing or empty",
        }

    detail = _duel_thug_detail(history, per_match)
    if not detail:
        return {
            "available": False,
            "skipped_reason": "no telemetry duels joinable to elo_history + per-match JSON",
        }

    duels = cmdr_history["duels"]
    anchor = float(cmdr_history.get("anchor", CMDR_ANCHOR_FALLBACK))
    k_base = float(cmdr_history.get("k_base", CMDR_K_BASE_FALLBACK))
    k_floor = float(cmdr_history.get("k_floor", CMDR_K_FLOOR_FALLBACK))
    prior = float(cmdr_history.get("provisional_prior",
                                   CMDR_PROVISIONAL_PRIOR_FALLBACK))
    scale = float(cmdr_history.get("logistic_scale",
                                   CMDR_LOGISTIC_SCALE_FALLBACK))
    lam = float(cmdr_history.get("lambda_team_handicap", CMDR_LAMBDA_FALLBACK))
    prov_threshold = float(cmdr_history.get("provisional_threshold", 5))

    # The scoreable subset: telemetry duels with a joinable detail row AND
    # a non-draw outcome AND at least one rated thug on each side (without
    # both means the handicap term is zero under EVERY variant, so the row
    # cannot discriminate between them).
    def scoreable(duel: dict[str, Any]) -> bool:
        mid = duel.get("match_id") or ""
        det = detail.get(mid)
        if not det or duel.get("outcome") == "draw":
            return False
        return bool(det["thugs"][1]) and bool(det["thugs"][2])

    subset_ids = {d.get("match_id") for d in duels if scoreable(d)}

    def replay(variant: str, **kw: Any) -> dict[str, Any]:
        """One full chronological replay. `variant` selects the T rule."""
        tau = kw.get("tau", SOFTMAX_TAU)
        lambda2 = kw.get("lambda2", 0.0)
        rating: dict[str, float] = {}
        games: dict[str, int] = {}
        correct = 0.0
        scored = 0
        ll_sum = 0.0
        bands = {i: {"n": 0, "hits": 0.0} for i in range(len(CMDR_T_BANDS))}
        uneven = {"even": {"n": 0, "hits": 0.0}, "uneven": {"n": 0, "hits": 0.0}}

        for duel in duels:
            c1 = duel["commanders"]["1"]
            c2 = duel["commanders"]["2"]
            key1, key2 = _cmdr_duel_key(c1), _cmdr_duel_key(c2)
            r1 = rating.get(key1, anchor)
            r2 = rating.get(key2, anchor)
            g1, g2 = games.get(key1, 0), games.get(key2, 0)

            mid = duel.get("match_id") or ""
            det = detail.get(mid)
            th = duel.get("team_handicap") or {}
            t_pair: tuple[float | None, float | None]
            extra = 0.0

            if det is None or variant == "canonical":
                # No per-player detail (every F9 row) -> canonical means.
                t_pair = (th.get("t1_thug_mean"), th.get("t2_thug_mean"))
            elif variant == "softmax":
                t_pair = (_softmax_mean(det["thugs"][1], tau),
                          _softmax_mean(det["thugs"][2], tau))
            elif variant == "hard_max":
                t_pair = (max(det["thugs"][1]) if det["thugs"][1] else None,
                          max(det["thugs"][2]) if det["thugs"][2] else None)
            elif variant in ("cmdr_in_mean", "cmdr_conditional"):
                # V1 folds the commander's own VTSR-T into their side's
                # mean; V2 does so only while their VTSR-C is provisional.
                pair: list[float | None] = [None, None]
                for idx, side in enumerate((1, 2)):
                    vals = list(det["thugs"][side])
                    own = det["cmdr"][side]
                    include = own is not None
                    if include and variant == "cmdr_conditional":
                        gside = g1 if side == 1 else g2
                        include = gside < prov_threshold
                    if include:
                        vals.append(float(own))
                    pair[idx] = (sum(vals) / len(vals)) if vals else None
                t_pair = (pair[0], pair[1])
            elif variant == "three_term":
                t_pair = (th.get("t1_thug_mean"), th.get("t2_thug_mean"))
                tc1, tc2 = det["cmdr"][1], det["cmdr"][2]
                if tc1 is not None and tc2 is not None:
                    extra = lambda2 * (float(tc1) - float(tc2))
            else:
                t_pair = (th.get("t1_thug_mean"), th.get("t2_thug_mean"))

            t1, t2 = t_pair
            handicap = lam * (t1 - t2) if (t1 is not None and t2 is not None) else 0.0
            e1 = 1.0 / (1.0 + 10.0 ** (-((r1 - r2) + handicap + extra) / scale))

            outcome = duel.get("outcome")
            s1 = 0.5 if outcome == "draw" else (1.0 if outcome == "team1" else 0.0)

            if mid in subset_ids:
                scored += 1
                hit = 0.5 if e1 == 0.5 else (1.0 if (e1 > 0.5) == (s1 == 1.0) else 0.0)
                correct += hit
                e_realized = e1 if s1 == 1.0 else 1.0 - e1
                ll_sum += -math.log(max(1e-9, e_realized))
                fav_prob = max(e1, 1.0 - e1)
                for i, (lo, hi) in enumerate(CMDR_T_BANDS):
                    if lo <= fav_prob < hi:
                        bands[i]["n"] += 1
                        bands[i]["hits"] += hit
                        break
                n1 = len(det["thugs"][1]) if det else 0
                n2 = len(det["thugs"][2]) if det else 0
                bucket = "even" if n1 == n2 else "uneven"
                uneven[bucket]["n"] += 1
                uneven[bucket]["hits"] += hit

            k1 = k_floor + (k_base - k_floor) * max(0.0, 1.0 - g1 / prior)
            k2 = k_floor + (k_base - k_floor) * max(0.0, 1.0 - g2 / prior)
            rating[key1] = r1 + k1 * (s1 - e1)
            rating[key2] = r2 + k2 * ((1.0 - s1) - (1.0 - e1))
            games[key1], games[key2] = g1 + 1, g2 + 1

        label = variant if not kw else f"{variant}:" + ",".join(
            f"{k}={v}" for k, v in sorted(kw.items()))
        return {
            "variant": label,
            "n_scored": scored,
            "accuracy": (correct / scored) if scored else None,
            "accuracy_ci": (list(wilson_ci(int(round(correct)), scored))
                            if scored else None),
            "log_loss": (ll_sum / scored) if scored else None,
            "per_band": [
                {
                    "band": f"{int(lo * 100)}-{int(min(hi, 1.0) * 100)}%",
                    "n": bands[i]["n"],
                    "accuracy": (bands[i]["hits"] / bands[i]["n"]) if bands[i]["n"] else None,
                }
                for i, (lo, hi) in enumerate(CMDR_T_BANDS)
            ],
            "per_lobby_shape": {
                k: {
                    "n": v["n"],
                    "accuracy": (v["hits"] / v["n"]) if v["n"] else None,
                }
                for k, v in uneven.items()
            },
        }

    rows = [replay("canonical")]
    rows.append(replay("cmdr_in_mean"))
    rows.append(replay("cmdr_conditional"))
    for l2 in CMDR_T_LAMBDA2_GRID:
        rows.append(replay("three_term", lambda2=l2))
    for tau in CMDR_T_SOFTMAX_TAUS:
        rows.append(replay("softmax", tau=tau))
    rows.append(replay("hard_max"))

    base = rows[0]

    def verdict(row: dict[str, Any]) -> dict[str, Any]:
        """Apply the pre-registered promote rule verbatim."""
        if row is base:
            return {"eligible": False, "reason": "baseline"}
        if base["accuracy"] is None or row["accuracy"] is None:
            return {"eligible": False, "reason": "no scored rows"}
        d_acc = row["accuracy"] - base["accuracy"]
        d_ll = row["log_loss"] - base["log_loss"]
        fails = []
        if d_acc < 0.03:
            fails.append(f"accuracy +{d_acc * 100:.1f}pp < +3pp")
        if d_ll >= 0:
            fails.append(f"log-loss {d_ll:+.4f} not improved")
        if row["n_scored"] < 100:
            fails.append(f"n_scored {row['n_scored']} < 100")
        # Condition 4: the gain must not be confined to one band.
        improved_bands = 0
        degraded_bands = 0
        for rb, bb in zip(row["per_band"], base["per_band"]):
            if rb["accuracy"] is None or bb["accuracy"] is None:
                continue
            if rb["accuracy"] > bb["accuracy"] + 1e-9:
                improved_bands += 1
            elif rb["accuracy"] < bb["accuracy"] - 1e-9:
                degraded_bands += 1
        if improved_bands <= 1 and degraded_bands >= 1:
            fails.append("gain confined to a single band")
        discard = d_acc < -0.03
        return {
            "eligible": not fails,
            "delta_accuracy": d_acc,
            "delta_log_loss": d_ll,
            "bands_improved": improved_bands,
            "bands_degraded": degraded_bands,
            "discard": discard,
            "failed_conditions": fails,
        }

    for row in rows:
        row["promote"] = verdict(row)

    promoted = [r["variant"] for r in rows if r["promote"].get("eligible")]
    return {
        "available": True,
        "memo": "critique/decisions/balonce-meter-t-term.md",
        "n_duels_total": len(duels),
        "n_scoreable_telemetry": len(subset_ids),
        "lambda_canonical": lam,
        "provisional_threshold": prov_threshold,
        "variants": rows,
        "promote_eligible": promoted,
        "verdict": "PROMOTE-CANDIDATE" if promoted else "HOLD at canonical",
    }


# ---------------------------------------------------------------------------
# Metric #11 (v1.2): axis-vs-outcome sign agreement
# ---------------------------------------------------------------------------


def metric_axis_outcome(
    history: dict[str, Any], per_match: dict[str, Any]
) -> dict[str, Any]:
    """The "damage over tactics" question made falsifiable: for each
    DETERMINED rated match and each axis, compute the team-mean
    ``axis_contributions`` difference (winner team minus loser team) from
    the elo_history deltas, then report the per-axis SIGN-AGREEMENT rate:
    when team A out-scored team B on this axis, team A won X% of the time.

    Includes all rated rows (commanders carry their post-shift
    contributions -- exactly what fed P_i). Exact ties (rare with float
    z-scores) earn half credit. Emits the honest ranking of which axes
    actually predict winning -- the empirical check on THUG_WEIGHTS.
    """
    per_axis: dict[str, dict[str, Any]] = {}
    n_determined = 0
    for match_id, _, deltas in iter_rated_history(history):
        match_data = per_match.get(match_id)
        if not match_data:
            continue
        winner_block = (match_data.get("match") or {}).get("winner") or {}
        if winner_block.get("decided_by") not in AXIS_OUTCOME_DECIDED_BY:
            continue
        winner_team = winner_block.get("team")
        if winner_team not in (1, 2):
            continue

        lookup = faction_lookup_for_match(match_data)
        sums: dict[int, dict[str, float]] = {1: defaultdict(float), 2: defaultdict(float)}
        counts: dict[int, dict[str, int]] = {1: defaultdict(int), 2: defaultdict(int)}
        for d in deltas:
            faction = lookup.get(player_key_for_delta(d))
            if faction not in (1, 2):
                faction = lookup.get(str(d.get("name") or ""))
            if faction not in (1, 2):
                continue
            for axis, z in (d.get("axis_contributions") or {}).items():
                if isinstance(z, (int, float)):
                    sums[faction][axis] += float(z)
                    counts[faction][axis] += 1

        loser_team = 3 - winner_team
        axes_present = set(counts[1]) & set(counts[2])
        if not axes_present:
            continue
        n_determined += 1
        for axis in axes_present:
            w_mean = sums[winner_team][axis] / counts[winner_team][axis]
            l_mean = sums[loser_team][axis] / counts[loser_team][axis]
            rec = per_axis.setdefault(axis, {"n": 0, "credit": 0.0, "diffs": []})
            rec["n"] += 1
            diff = w_mean - l_mean
            rec["diffs"].append(diff)
            if diff > 0:
                rec["credit"] += 1.0
            elif diff == 0:
                rec["credit"] += 0.5

    rows = []
    for axis, rec in per_axis.items():
        n = rec["n"]
        agreement = (rec["credit"] / n) if n else None
        ci = list(wilson_ci(int(round(rec["credit"])), n)) if n else None
        rows.append({
            "axis": axis,
            "n": n,
            "sign_agreement": agreement,
            "sign_agreement_ci": ci,
            "mean_winner_minus_loser": (
                mean(rec["diffs"]) if rec["diffs"] else None
            ),
        })
    # Secondary key on the axis name: ``axes_present`` is a set, so two
    # axes tied on agreement (mobility and net_damage_share both at
    # 0.882 on the 2026-10-04 corpus) used to swap order between runs
    # under hash randomization and churn validation_summary.json.
    rows.sort(key=lambda r: (-(r["sign_agreement"] or 0.0), r["axis"]))

    if not rows:
        return {
            "available": False,
            "skipped_reason": "no determined rated matches with axis contributions",
        }
    return {
        "available": True,
        "n_matches_determined": n_determined,
        "axes": rows,
    }


# ---------------------------------------------------------------------------
# Metric #12 (v1.3): VTSR-C econ-axis vs duel-outcome sign agreement
# ---------------------------------------------------------------------------


def metric_cmdr_econ_axes(
    cmdr_history: dict[str, Any] | None,
) -> dict[str, Any]:
    """Mirror of metric #11 for the VTSR-C v2 economy composite: for each
    telemetry duel (``performance.available``) with a non-draw outcome and
    each econ axis, does the axis-leading commander win?

    The per-duel ``performance.axes[axis].diff`` is the team-1-perspective
    raw differential, so sign agreement = share of duels where
    ``sign(diff) == sign(team-1 won)``. Exact zero diffs earn half credit.

    This is THE gate feeding the pre-registered promote rule in
    critique/decisions/vtsr-c-v2-composite.md: alpha_c may only drop below
    1.0 when >= 3 axes clear 0.55 with none below 0.35 (>= 25 telemetry
    duels); an axis dies at < 0.40 with n >= 40.
    """
    if not cmdr_history or not (cmdr_history.get("duels") or []):
        return {
            "available": False,
            "skipped_reason": "elo_commander_history.json missing or empty",
        }

    per_axis: dict[str, dict[str, Any]] = {}
    n_telemetry = 0
    n_scored = 0
    for duel in cmdr_history["duels"]:
        perf = duel.get("performance") or {}
        if not perf.get("available"):
            continue
        n_telemetry += 1
        outcome = duel.get("outcome")
        if outcome not in ("team1", "team2"):
            continue  # draws: nothing to predict
        n_scored += 1
        t1_won = outcome == "team1"
        for axis, block in (perf.get("axes") or {}).items():
            diff = block.get("diff")
            if not isinstance(diff, (int, float)):
                continue
            rec = per_axis.setdefault(
                axis, {"n": 0, "credit": 0.0, "w_diffs": []})
            rec["n"] += 1
            # Winner-perspective diff for the mean column.
            rec["w_diffs"].append(diff if t1_won else -diff)
            if diff == 0:
                rec["credit"] += 0.5
            elif (diff > 0) == t1_won:
                rec["credit"] += 1.0

    rows = []
    for axis, rec in per_axis.items():
        n = rec["n"]
        agreement = (rec["credit"] / n) if n else None
        ci = list(wilson_ci(int(round(rec["credit"])), n)) if n else None
        rows.append({
            "axis": axis,
            "n": n,
            "sign_agreement": agreement,
            "sign_agreement_ci": ci,
            "mean_winner_minus_loser": (
                mean(rec["w_diffs"]) if rec["w_diffs"] else None
            ),
        })
    weights = cmdr_history.get("econ_weights") or {}
    for row in rows:
        w = weights.get(row["axis"])
        row["weight"] = w
        row["scored"] = isinstance(w, (int, float)) and w > 0
    rows.sort(key=lambda r: (
        0 if r.get("scored") else 1,
        -(r["sign_agreement"] or 0.0),
    ))

    if not rows:
        return {
            "available": False,
            "skipped_reason": (
                "no telemetry duels with a determined outcome "
                "(pre-v4 corpus, or all telemetry duels drew)"),
        }
    return {
        "available": True,
        "n_telemetry_duels": n_telemetry,
        "n_scored": n_scored,
        "axes": rows,
        # Discovery sample. Not the promote gate — see `promote`.
        "sample": "discovery",
    }


# ---------------------------------------------------------------------------
# Metric #13 (v1.3): VTSR-C alpha_c ablation
# ---------------------------------------------------------------------------

# alpha_c values replayed by metric #13 (canonical 1.0 always included).
CMDR_ALPHA_C_ABLATION = [1.0, 0.9, 0.8, 0.5]


def _duel_day(duel: dict[str, Any]) -> str:
    return str(duel.get("date") or "")[:10]


def _duel_after(duel: dict[str, Any], day: str) -> bool:
    d = _duel_day(duel)
    return bool(d) and d > day


def metric_cmdr_alpha_ablation(
    cmdr_history: dict[str, Any] | None,
    score_date_after: str | None = None,
) -> dict[str, Any]:
    """Chronological ladder replay at each alpha_c in
    CMDR_ALPHA_C_ABLATION, scoring duel prediction ONLY on telemetry
    duels so the gate is never diluted by fallback (outcome-pure) rows.

    The walk itself covers EVERY duel -- ratings must evolve exactly as
    they would in production, where non-telemetry duels score outcome-pure
    S at any alpha_c (the ratified fallback policy). Only the update rule
    changes with alpha_c:

        S'_1 = alpha_c * S_1 + (1 - alpha_c) * (P + 1) / 2    (telemetry)
        S'_1 = S_1                                            (fallback)

    with P = the duel's emitted team-1-perspective composite
    (``performance.p``). Accuracy/log-loss are measured from PRE-duel
    ratings at the canonical lambda, counted only on non-draw telemetry
    duels. The alpha_c = 1.0 row doubles as an integrity check: its
    replay must reproduce the emitted ``after`` ratings (~0 diff).
    """
    if not cmdr_history or not (cmdr_history.get("duels") or []):
        return {
            "available": False,
            "skipped_reason": "elo_commander_history.json missing or empty",
        }

    duels = cmdr_history["duels"]
    anchor = float(cmdr_history.get("anchor", CMDR_ANCHOR_FALLBACK))
    k_base = float(cmdr_history.get("k_base", CMDR_K_BASE_FALLBACK))
    k_floor = float(cmdr_history.get("k_floor", CMDR_K_FLOOR_FALLBACK))
    prior = float(cmdr_history.get("provisional_prior",
                                   CMDR_PROVISIONAL_PRIOR_FALLBACK))
    scale = float(cmdr_history.get("logistic_scale",
                                   CMDR_LOGISTIC_SCALE_FALLBACK))
    lam = float(cmdr_history.get("lambda_team_handicap",
                                 CMDR_LAMBDA_FALLBACK))

    n_telemetry = sum(
        1 for d in duels if (d.get("performance") or {}).get("available"))
    if n_telemetry == 0:
        return {
            "available": False,
            "skipped_reason": "no telemetry duels in the corpus (pre-v4)",
        }

    alphas = sorted(set(CMDR_ALPHA_C_ABLATION) | {1.0}, reverse=True)

    def replay(alpha_c: float) -> dict[str, Any]:
        rating: dict[str, float] = {}
        games: dict[str, int] = {}
        correct = 0.0
        scored = 0
        ll_sum = 0.0
        max_abs_diff = 0.0
        for duel in duels:
            c1 = duel["commanders"]["1"]
            c2 = duel["commanders"]["2"]
            key1, key2 = _cmdr_duel_key(c1), _cmdr_duel_key(c2)
            r1 = rating.get(key1, anchor)
            r2 = rating.get(key2, anchor)
            th = duel.get("team_handicap") or {}
            t1, t2 = th.get("t1_thug_mean"), th.get("t2_thug_mean")
            handicap = (lam * (t1 - t2)
                        if (t1 is not None and t2 is not None) else 0.0)
            e1 = 1.0 / (1.0 + 10.0 ** (-((r1 - r2) + handicap) / scale))

            outcome = duel.get("outcome")
            s1_raw = (0.5 if outcome == "draw"
                      else 1.0 if outcome == "team1" else 0.0)

            perf = duel.get("performance") or {}
            has_telemetry = bool(perf.get("available"))
            p = perf.get("p") if has_telemetry else None

            # Prediction scoring: non-draw TELEMETRY duels only.
            # `score_date_after` restricts the SCORE (confirmation
            # sample). The rating walk still covers every duel.
            in_score_window = (
                score_date_after is None
                or _duel_after(duel, score_date_after))
            if (has_telemetry and outcome in ("team1", "team2")
                    and in_score_window):
                scored += 1
                if e1 == 0.5:
                    correct += 0.5
                elif (e1 > 0.5) == (s1_raw == 1.0):
                    correct += 1.0
                e_realized = e1 if s1_raw == 1.0 else 1.0 - e1
                ll_sum += -math.log(max(1e-9, e_realized))

            # Update rule: blend only on telemetry duels at alpha_c < 1.
            if has_telemetry and alpha_c < 1.0 and isinstance(
                    p, (int, float)):
                s1_eff = (alpha_c * s1_raw
                          + (1.0 - alpha_c) * (p + 1.0) / 2.0)
            else:
                s1_eff = s1_raw

            g1, g2 = games.get(key1, 0), games.get(key2, 0)
            k1 = k_floor + (k_base - k_floor) * max(0.0, 1.0 - g1 / prior)
            k2 = k_floor + (k_base - k_floor) * max(0.0, 1.0 - g2 / prior)
            nr1 = r1 + k1 * (s1_eff - e1)
            nr2 = r2 + k2 * ((1.0 - s1_eff) - (1.0 - e1))
            rating[key1], rating[key2] = nr1, nr2
            games[key1], games[key2] = g1 + 1, g2 + 1

            if alpha_c == 1.0:
                a1, a2 = c1.get("after"), c2.get("after")
                if isinstance(a1, (int, float)):
                    max_abs_diff = max(max_abs_diff, abs(nr1 - a1))
                if isinstance(a2, (int, float)):
                    max_abs_diff = max(max_abs_diff, abs(nr2 - a2))

        accuracy = (correct / scored) if scored else None
        ci = list(wilson_ci(int(round(correct)), scored)) if scored else None
        return {
            "alpha_c": alpha_c,
            "canonical": alpha_c == 1.0,
            "n_telemetry_scored": scored,
            "accuracy": accuracy,
            "accuracy_ci": ci,
            "log_loss": (ll_sum / scored) if scored else None,
            "replay_max_abs_diff": (
                round(max_abs_diff, 4) if alpha_c == 1.0 else None
            ),
        }

    per_alpha = [replay(a) for a in alphas]
    canonical_row = next(r for r in per_alpha if r["canonical"])
    return {
        "available": True,
        "n_duels": len(duels),
        "n_telemetry_duels": n_telemetry,
        "n_telemetry_scored": canonical_row["n_telemetry_scored"],
        "replay_max_abs_diff": canonical_row["replay_max_abs_diff"],
        "per_alpha": per_alpha,
        "score_date_after": score_date_after,
    }


def _odf_stem(odf: Any) -> str:
    s = str(odf or "").strip().lower()
    if s.endswith(".odf"):
        s = s[:-4]
    return s


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


def _loser_recycler_up_late(md: dict) -> bool | None:
    """True when the losing recycler is still up at 75% of duration.

    "Still up" = no kill-feed destruction of that side's recycler at or
    before the cutoff (a later rebuild after an early death is not
    reconstructed; an early death stays "not up", which fails safe).
    None when the loser or the clock can't be read.
    """
    match = md.get("match") or {}
    winner = match.get("winner") or {}
    loser = winner.get("loser")
    if loser not in (1, 2):
        team = winner.get("team")
        if team == 1:
            loser = 2
        elif team == 2:
            loser = 1
        else:
            return None
    duration = match.get("duration_sec") or 0
    if not isinstance(duration, (int, float)) or duration <= 0:
        return None
    tick_rate = match.get("tick_rate") or 20
    if not isinstance(tick_rate, (int, float)) or tick_rate <= 0:
        tick_rate = 20
    tick_range = match.get("tick_range") or [0, 0]
    try:
        t0 = float(tick_range[0]) if tick_range else 0.0
    except (TypeError, ValueError, IndexError):
        t0 = 0.0
    cutoff = t0 + ECON_PROMOTE_CLOSE_FRAC * float(duration) * float(tick_rate)
    first: float | None = None
    for row in (md.get("kills") or {}).get("feed") or []:
        if _odf_stem(row.get("victim_odf")) not in RECYCLER_STEMS:
            continue
        if _slot_side(row.get("victim_team")) != loser:
            continue
        tick = row.get("tick")
        if not isinstance(tick, (int, float)):
            continue
        if first is None or tick < first:
            first = float(tick)
    if first is None:
        return True
    return first > cutoff


def _is_close_duel(md: dict | None) -> bool:
    if not md:
        return False
    winner = (md.get("match") or {}).get("winner") or {}
    if winner.get("decided_by") == "contested":
        return True
    return _loser_recycler_up_late(md) is True


def _econ_sign_rows(duels: list[dict]) -> list[dict]:
    """Sign-agreement rows for an already-filtered duel list."""
    per_axis: dict[str, dict[str, Any]] = {}
    for duel in duels:
        outcome = duel.get("outcome")
        if outcome not in ("team1", "team2"):
            continue
        t1_won = outcome == "team1"
        for axis, block in ((duel.get("performance") or {}).get("axes") or {}).items():
            diff = block.get("diff")
            if not isinstance(diff, (int, float)):
                continue
            rec = per_axis.setdefault(
                axis, {"n": 0, "credit": 0.0, "w_diffs": []})
            rec["n"] += 1
            rec["w_diffs"].append(diff if t1_won else -diff)
            if diff == 0:
                rec["credit"] += 0.5
            elif (diff > 0) == t1_won:
                rec["credit"] += 1.0
    rows = []
    for axis, rec in per_axis.items():
        n = rec["n"]
        agreement = (rec["credit"] / n) if n else None
        ci = list(wilson_ci(int(round(rec["credit"])), n)) if n else None
        rows.append({
            "axis": axis,
            "n": n,
            "sign_agreement": agreement,
            "sign_agreement_ci": ci,
            "ci_lower": ci[0] if ci else None,
            "mean_winner_minus_loser": (
                mean(rec["w_diffs"]) if rec["w_diffs"] else None
            ),
        })
    rows.sort(key=lambda r: -(r["sign_agreement"] or 0.0))
    return rows


def metric_cmdr_promote(
    cmdr_history: dict[str, Any] | None,
    per_match: dict[str, Any],
) -> dict[str, Any]:
    """2026-09-23 promote rule. Discovery duels never flip alpha_c.

    Confirmation = telemetry duels dated strictly after
    ``econ_semantics_amended_on``. HOLD unless every gate passes.
    """
    if not cmdr_history or not (cmdr_history.get("duels") or []):
        return {
            "available": False,
            "verdict": "HOLD",
            "skipped_reason": "elo_commander_history.json missing or empty",
        }
    amended = (cmdr_history.get("econ_semantics_amended_on")
               or ECON_SEMANTICS_AMENDED_ON)
    weights = cmdr_history.get("econ_weights") or {}
    scored_names = [
        a for a, w in weights.items()
        if isinstance(w, (int, float)) and w > 0
    ] or list(ECON_SCORED_AXES)

    confirmation = []
    for duel in cmdr_history["duels"]:
        perf = duel.get("performance") or {}
        if not perf.get("available"):
            continue
        if duel.get("outcome") not in ("team1", "team2"):
            continue
        if _duel_after(duel, amended):
            confirmation.append(duel)

    reasons: list[str] = []
    n_conf = len(confirmation)
    if n_conf < ECON_PROMOTE_MIN_CONFIRMATION:
        reasons.append(
            f"confirmation sample is {n_conf} "
            f"(need {ECON_PROMOTE_MIN_CONFIRMATION} duels dated after {amended})"
        )

    conf_rows = _econ_sign_rows(confirmation)
    by_axis = {r["axis"]: r for r in conf_rows}
    cleared = []
    for axis in scored_names:
        row = by_axis.get(axis)
        lo = (row or {}).get("ci_lower")
        if isinstance(lo, (int, float)) and lo > ECON_PROMOTE_CI_FLOOR:
            cleared.append(axis)
    if len(cleared) < ECON_PROMOTE_MIN_AXES:
        reasons.append(
            f"{len(cleared)} scored axis(es) have a Wilson lower bound "
            f"above {ECON_PROMOTE_CI_FLOOR} (need {ECON_PROMOTE_MIN_AXES} of "
            f"{len(scored_names)})"
        )

    close = []
    for duel in confirmation:
        md = per_match.get(duel.get("match_id") or "")
        if _is_close_duel(md):
            close.append(duel)
    close_rows = _econ_sign_rows(close)
    close_by = {r["axis"]: r for r in close_rows}
    close_testable = len(close) >= ECON_PROMOTE_CLOSE_MIN_N
    if not close_testable:
        reasons.append(
            f"close subset is {len(close)} "
            f"(need {ECON_PROMOTE_CLOSE_MIN_N}; not yet testable)"
        )
    else:
        for axis in cleared:
            agree = (close_by.get(axis) or {}).get("sign_agreement")
            if not isinstance(agree, (int, float)) or agree < ECON_PROMOTE_CLOSE_FLOOR:
                reasons.append(
                    f"{axis} close-game agreement is below {ECON_PROMOTE_CLOSE_FLOOR}"
                )

    ablation = metric_cmdr_alpha_ablation(
        cmdr_history, score_date_after=amended)
    canon = None
    best = None
    for row in (ablation.get("per_alpha") or []):
        if row.get("canonical"):
            canon = row
        elif row.get("log_loss") is not None:
            if best is None or row["log_loss"] < best["log_loss"]:
                best = row
    if not canon or canon.get("log_loss") is None or not best:
        reasons.append(
            "confirmation ablation has no scored duels to compare")
    else:
        gain = canon["log_loss"] - best["log_loss"]
        acc_ok = (
            best.get("accuracy") is not None
            and canon.get("accuracy") is not None
            and best["accuracy"] >= canon["accuracy"])
        if gain < ECON_PROMOTE_LOGLOSS_DELTA or not acc_ok:
            reasons.append(
                f"no alpha below 1.0 improves log-loss by "
                f">= {ECON_PROMOTE_LOGLOSS_DELTA} without worsening accuracy "
                f"(best gain {gain:.4f} at alpha {best.get('alpha_c')})"
            )

    return {
        "available": True,
        "verdict": "HOLD" if reasons else "PROMOTE",
        "amended_on": amended,
        "n_confirmation": n_conf,
        "n_confirmation_required": ECON_PROMOTE_MIN_CONFIRMATION,
        "log_loss_min_improvement": ECON_PROMOTE_LOGLOSS_DELTA,
        "ci_floor": ECON_PROMOTE_CI_FLOOR,
        "close_floor": ECON_PROMOTE_CLOSE_FLOOR,
        "close_min_n": ECON_PROMOTE_CLOSE_MIN_N,
        "reasons": reasons,
        "confirmation_axes": conf_rows,
        "axes_clearing_ci_floor": cleared,
        "close": {
            "n": len(close),
            "testable": close_testable,
            "axes": close_rows,
        },
        "confirmation_ablation": ablation,
        "note": (
            "Pre-amendment telemetry is a discovery sample. "
            "It is published under econ_axes and is not a promote sample."
        ),
    }


def _opening_sec(tick: Any, t0: float, tick_rate: float) -> float | None:
    if not isinstance(tick, (int, float)) or tick_rate <= 0:
        return None
    return (float(tick) - t0) / tick_rate


def _legacy_full_and_early(md: dict) -> dict[str, dict[int, float | None]] | None:
    """Retired full-match formulas plus their first-240s analogues.

    Diagnostic only. These are the 2026-09-04 axes, recomputed here so
    the early-vs-full check does not depend on the scored composite.
    """
    econ = md.get("economy") or {}
    builds = md.get("builds") or {}
    if not (econ.get("has_resource_data") and builds.get("has_build_data")):
        return None
    match = md.get("match") or {}
    duration = match.get("duration_sec") or 0
    if not isinstance(duration, (int, float)) or duration <= 0:
        return None
    tick_rate = match.get("tick_rate") or 20
    if not isinstance(tick_rate, (int, float)) or tick_rate <= 0:
        tick_rate = 20.0
    tick_range = match.get("tick_range") or [0, 0]
    try:
        t0 = float(tick_range[0]) if tick_range else 0.0
    except (TypeError, ValueError, IndexError):
        t0 = 0.0
    ticks = econ.get("ticks") or []
    feed = builds.get("feed") or []
    deaths = {1: 0, 2: 0}
    for row in md.get("leaderboard") or []:
        side = _slot_side(row.get("slot"))
        if side is None:
            continue
        try:
            deaths[side] += int(row.get("deaths") or 0)
        except (TypeError, ValueError):
            pass

    out: dict[str, dict[int, float | None]] = {
        "pool_full": {}, "pool_early": {},
        "production_full": {}, "production_early": {},
        "replacement_full": {},
        "efficiency_full": {}, "efficiency_early": {},
        "upgrade_full": {}, "upgrade_early": {},
    }
    minutes = float(duration) / 60.0
    window_min = min(float(duration), ECON_OPENING_WINDOW_SEC) / 60.0
    for side in (1, 2):
        et = (econ.get("teams") or {}).get(str(side)) or {}
        bt = (builds.get("teams") or {}).get(str(side)) or {}
        pool_adv = et.get("pool_advantage_integral")
        out["pool_full"][side] = (
            float(pool_adv) / float(duration)
            if isinstance(pool_adv, (int, float)) else None)
        spent = bt.get("scrap_spent_units")
        out["production_full"][side] = (
            float(spent) / minutes if isinstance(spent, (int, float)) else None)
        ships = bt.get("ships_built")
        out["replacement_full"][side] = (
            min(3.0, float(ships) / max(1, deaths[side]))
            if isinstance(ships, (int, float)) else None)
        mean_float = et.get("mean_float_ratio")
        out["efficiency_full"][side] = (
            1.0 - float(mean_float)
            if isinstance(mean_float, (int, float)) else None)
        upgrades = et.get("upgrades_final")
        peak = et.get("peak_pools")
        out["upgrade_full"][side] = (
            min(1.0, float(upgrades) / float(peak))
            if (isinstance(upgrades, (int, float))
                and isinstance(peak, (int, float)) and peak >= 1)
            else None)

        pools = et.get("pool_count") or []
        scrap = et.get("scrap") or []
        caps = et.get("max_scrap") or []
        ups = et.get("upgrade_count") or []
        n = min(len(pools), len(ticks))
        pool_sum = 0.0
        pool_n = 0
        float_sum = 0.0
        float_n = 0
        peak_open = 0.0
        last_up = None
        for i in range(n):
            sec = _opening_sec(ticks[i], t0, float(tick_rate))
            if sec is None or sec > ECON_OPENING_WINDOW_SEC:
                if sec is not None and sec > ECON_OPENING_WINDOW_SEC:
                    break
                continue
            try:
                pool_sum += float(pools[i])
                pool_n += 1
                peak_open = max(peak_open, float(pools[i]))
            except (TypeError, ValueError):
                pass
            if i < len(ups):
                try:
                    last_up = float(ups[i])
                except (TypeError, ValueError):
                    pass
            if i < len(scrap) and i < len(caps):
                try:
                    cap = float(caps[i])
                    pool = float(pools[i]) if i < len(pools) else 0.0
                    if cap > 0 and cap != 20.0 * pool:
                        float_sum += float(scrap[i]) / cap
                        float_n += 1
                except (TypeError, ValueError):
                    pass
        out["pool_early"][side] = (pool_sum / pool_n) if pool_n else None
        out["efficiency_early"][side] = (
            1.0 - float_sum / float_n) if float_n else None
        out["upgrade_early"][side] = (
            min(1.0, last_up / max(1.0, peak_open))
            if last_up is not None and peak_open >= 1 else None)

        early_spent = 0.0
        saw_build = False
        for row in feed:
            if row.get("type") != "build" or row.get("team") != side:
                continue
            if (row.get("producer") == "constructor"
                    or row.get("producer_resolved") == "constructor"):
                continue
            sec = _opening_sec(row.get("tick"), t0, float(tick_rate))
            if sec is None or sec > ECON_OPENING_WINDOW_SEC:
                continue
            cost = row.get("scrap_cost")
            if isinstance(cost, (int, float)):
                early_spent += float(cost)
                saw_build = True
        out["production_early"][side] = (
            early_spent / window_min if saw_build or window_min > 0 else None)

    return out


def metric_legacy_early_full(
    cmdr_history: dict[str, Any] | None,
    per_match: dict[str, Any],
) -> dict[str, Any]:
    """Early-vs-full sign agreement for the retired full-match formulas.

    An axis is `lagging` when full-match agreement is at least 0.55 and
    the opening-window analogue is missing or below 0.50. Lagging axes
    cannot be added back. `eligible_to_restore` stays false: this
    diagnostic does not authorize a formula change.
    """
    if not cmdr_history or not (cmdr_history.get("duels") or []):
        return {
            "available": False,
            "skipped_reason": "elo_commander_history.json missing or empty",
        }
    # axis -> list of (diff_team1, t1_won) for full and early
    buckets: dict[str, list[tuple[float, bool]]] = {}
    n_joined = 0
    for duel in cmdr_history["duels"]:
        if not (duel.get("performance") or {}).get("available"):
            continue
        if duel.get("outcome") not in ("team1", "team2"):
            continue
        md = per_match.get(duel.get("match_id") or "")
        if not md:
            continue
        values = _legacy_full_and_early(md)
        if not values:
            continue
        n_joined += 1
        t1_won = duel.get("outcome") == "team1"
        for axis, sides in values.items():
            v1, v2 = sides.get(1), sides.get(2)
            if not (isinstance(v1, (int, float)) and isinstance(v2, (int, float))):
                continue
            buckets.setdefault(axis, []).append((float(v1) - float(v2), t1_won))

    def _agree(pairs: list[tuple[float, bool]]) -> dict[str, Any]:
        n = len(pairs)
        if not n:
            return {"n": 0, "sign_agreement": None, "sign_agreement_ci": None}
        credit = 0.0
        for diff, t1_won in pairs:
            if diff == 0:
                credit += 0.5
            elif (diff > 0) == t1_won:
                credit += 1.0
        agreement = credit / n
        ci = list(wilson_ci(int(round(credit)), n))
        return {
            "n": n,
            "sign_agreement": agreement,
            "sign_agreement_ci": ci,
        }

    pairs = (
        ("pool_full", "pool_early"),
        ("production_full", "production_early"),
        ("replacement_full", None),
        ("efficiency_full", "efficiency_early"),
        ("upgrade_full", "upgrade_early"),
    )
    rows = []
    for full_name, early_name in pairs:
        full = _agree(buckets.get(full_name) or [])
        early = (_agree(buckets.get(early_name) or [])
                 if early_name else {"n": 0, "sign_agreement": None,
                                     "sign_agreement_ci": None})
        full_a = full.get("sign_agreement")
        early_a = early.get("sign_agreement")
        lagging = (
            isinstance(full_a, (int, float)) and full_a >= 0.55
            and (early_a is None or early_a < 0.50)
        )
        rows.append({
            "axis": full_name,
            "early_axis": early_name,
            "full": full,
            "early": early,
            "lagging": lagging,
            "eligible_to_restore": False,
        })
    if n_joined == 0:
        return {
            "available": False,
            "skipped_reason": "no telemetry duels joined to a per-match file",
        }
    return {
        "available": True,
        "n_duels": n_joined,
        "opening_window_sec": ECON_OPENING_WINDOW_SEC,
        "axes": rows,
        "note": (
            "Retired full-match formulas. Lagging means the agreement "
            "lives in the full match and not in the first 240s. "
            "eligible_to_restore is false: this block does not authorize "
            "putting an axis back into the score."
        ),
    }


# ---------------------------------------------------------------------------
# Metrics #8/#9: Axis ablation + Dirichlet perturbation
# ---------------------------------------------------------------------------


def _recompute_p_under_weights(
    deltas: list[dict[str, Any]],
    weights: dict[str, float],
) -> dict[str, float]:
    """Re-derive each delta's P_i from its ``axis_contributions`` block
    under modified weights. Returns ``{player_key: P_i}`` for one match.

    The pipeline emits ``axis_contributions`` as the post-clip post-shift
    z-score per axis (NOT yet weighted) -- see scripts/elo.py:851-857.
    So re-weighting is pure post-processing: dot-product of the
    available axis vector with the renormalized weight vector.

    Pro-rata weight redistribution mirrors elo.py:617-618 -- if an axis
    is absent from a row's contributions (axis was unavailable for the
    whole lobby), the remaining weights are renormalized to sum to 1.
    """
    out: dict[str, float] = {}
    for d in deltas:
        key = player_key_for_delta(d)
        if not key:
            continue
        axis_z = d.get("axis_contributions") or {}
        # Only weights for axes present in this row are renormalized.
        active = {a: weights[a] for a in axis_z if a in weights}
        total = sum(active.values())
        if total <= 0.0:
            continue
        renorm = {a: w / total for a, w in active.items()}
        p = 0.0
        for a, z in axis_z.items():
            w = renorm.get(a)
            if w is None:
                continue
            p += w * float(z)
        out[key] = p
    return out


def _per_player_meanP_under_weights(
    history: dict[str, Any],
    weights: dict[str, float],
) -> dict[str, float]:
    """Aggregate ``_recompute_p_under_weights`` across all rated matches
    into per-player career mean P_i. The ranking of this dict is our
    Phase 1 stand-in for full-rating ranking (documented limitation).
    """
    sums: dict[str, float] = defaultdict(float)
    counts: dict[str, int] = defaultdict(int)
    for _, _, deltas in iter_rated_history(history):
        per_player = _recompute_p_under_weights(deltas, weights)
        for k, p in per_player.items():
            sums[k] += p
            counts[k] += 1
    return {k: sums[k] / counts[k] for k in sums if counts[k] > 0}


def metric_axis_ablation(
    history: dict[str, Any],
    current: dict[str, Any],
    weights: dict[str, float],
    top_n: int = TOP_N,
) -> dict[str, Any]:
    """For each of the 6 axes, drop it from THUG_WEIGHTS and renormalize
    the remaining 5. Recompute per-player mean P_i. Compare ranking to
    the baseline (full-weights mean P_i) via Spearman + top-N Jaccard.

    Documented Phase 1 simplification: ablation operates on per-player
    *mean P_i* ranking rather than full-rating ranking. The two rankings
    are very tightly correlated for our K-factor regime (mean P_i is
    the dominant input to dr); a Phase 2 upgrade can promote to true
    re-rating via importing compute_elo with modified THUG_WEIGHTS.
    """
    baseline_meanP = _per_player_meanP_under_weights(history, weights)
    if not baseline_meanP:
        return {"results": [], "skipped_reason": "no usable axis data"}

    baseline_keys = sorted(
        baseline_meanP.keys(), key=lambda k: -baseline_meanP[k]
    )
    baseline_top_set = set(baseline_keys[:top_n])
    canonical_top_set = set(baseline_keys[:top_n])  # alias for clarity

    results: list[dict[str, Any]] = []
    for drop_axis in weights:
        modified = {
            a: w for a, w in weights.items() if a != drop_axis
        }
        # Renormalize so the modified weights still sum to 1 (matches
        # elo.py's pro-rata behaviour).
        total = sum(modified.values())
        if total <= 0:
            continue
        modified = {a: w / total for a, w in modified.items()}

        ablated_meanP = _per_player_meanP_under_weights(history, modified)

        # Build aligned vectors over keys present in BOTH rankings.
        aligned_baseline: list[float] = []
        aligned_ablated: list[float] = []
        for k in baseline_meanP:
            if k in ablated_meanP:
                aligned_baseline.append(baseline_meanP[k])
                aligned_ablated.append(ablated_meanP[k])
        rho = (
            spearman(aligned_baseline, aligned_ablated)
            if len(aligned_baseline) >= 2
            else None
        )

        ablated_top_set = set(
            sorted(
                ablated_meanP.keys(), key=lambda k: -ablated_meanP[k]
            )[:top_n]
        )
        results.append({
            "axis_dropped":     drop_axis,
            "weight_redirected": weights[drop_axis],
            "spearman_vs_baseline": rho,
            "top_n_jaccard":    jaccard(canonical_top_set, ablated_top_set),
            "n_players":        len(aligned_baseline),
        })

    # Sort so the most impactful drops surface first (lowest rho /
    # lowest Jaccard).
    results.sort(
        key=lambda r: (
            r["spearman_vs_baseline"] if r["spearman_vs_baseline"] is not None else -1.0
        )
    )

    return {
        "baseline_top_n":   list(baseline_keys[:top_n]),
        "n_players_pool":   len(baseline_keys),
        "top_n":            top_n,
        "results":          results,
    }


def metric_dirichlet_perturbation(
    history: dict[str, Any],
    weights: dict[str, float],
    runs: int = DIRICHLET_RUNS,
    concentration: float = DIRICHLET_CONCENTRATION,
    top_n: int = TOP_N,
    seed: int = 67890,
) -> dict[str, Any]:
    """Sample ``runs`` weight vectors from a Dirichlet centered on the
    current weights with given ``concentration``, recompute per-player
    mean P_i ranking, measure Spearman ρ + top-N Jaccard distribution
    against the baseline.

    Concentration semantics: higher = tighter perturbation around the
    center. ``50.0`` is a moderate setting (per-axis CV ~ 1/sqrt(c) =
    14%). Lower values explore wider regions of weight space; tighter
    values stress-test specifically that we're not on a knife edge.
    """
    rng = random.Random(seed)
    baseline_meanP = _per_player_meanP_under_weights(history, weights)
    if not baseline_meanP:
        return {
            "runs": 0,
            "skipped_reason": "no usable axis data",
        }

    axes = list(weights.keys())
    base_w = [weights[a] for a in axes]
    # Dirichlet alphas = concentration * mean -> mean equals base.
    alphas = [concentration * w for w in base_w]

    baseline_keys = sorted(
        baseline_meanP.keys(), key=lambda k: -baseline_meanP[k]
    )
    canonical_top_set = set(baseline_keys[:top_n])

    rho_distribution: list[float] = []
    jaccard_distribution: list[float] = []

    for _ in range(runs):
        sampled = dirichlet_sample(alphas, rng)
        modified = {axes[i]: sampled[i] for i in range(len(axes))}
        total = sum(modified.values())
        if total <= 0:
            continue
        modified = {a: w / total for a, w in modified.items()}

        run_meanP = _per_player_meanP_under_weights(history, modified)
        if not run_meanP:
            continue

        # Aligned rho.
        aligned_baseline: list[float] = []
        aligned_run: list[float] = []
        for k in baseline_meanP:
            if k in run_meanP:
                aligned_baseline.append(baseline_meanP[k])
                aligned_run.append(run_meanP[k])
        if len(aligned_baseline) < 2:
            continue
        rho = spearman(aligned_baseline, aligned_run)
        if rho is not None:
            rho_distribution.append(rho)

        run_top_set = set(
            sorted(
                run_meanP.keys(), key=lambda k: -run_meanP[k]
            )[:top_n]
        )
        jaccard_distribution.append(jaccard(canonical_top_set, run_top_set))

    return {
        "runs":            runs,
        "concentration":   concentration,
        "top_n":           top_n,
        "rho_mean":        mean(rho_distribution) if rho_distribution else None,
        "rho_median":      median(rho_distribution) if rho_distribution else None,
        "rho_min":         min(rho_distribution) if rho_distribution else None,
        "rho_max":         max(rho_distribution) if rho_distribution else None,
        "rho_stdev":       stdev(rho_distribution) if rho_distribution else None,
        "jaccard_mean":    mean(jaccard_distribution) if jaccard_distribution else None,
        "jaccard_median":  median(jaccard_distribution) if jaccard_distribution else None,
        "jaccard_min":     min(jaccard_distribution) if jaccard_distribution else None,
    }


# ---------------------------------------------------------------------------
# v1.7 (critique v4): shared row builder for sections 16-18
# ---------------------------------------------------------------------------


def _build_rated_rows(
    history: dict[str, Any], per_match: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Join every canonical rated delta to its per-match leaderboard row.

    Returns ``(rows, meta)``. One row per (rated match, rated player):
    ``match_id`` / ``match_date`` / ``name`` / ``key`` / ``before`` /
    ``performance`` / ``delta`` / ``side`` (leaderboard ``faction`` 1|2) /
    ``is_commander`` / ``winner_side`` (1|2 when the outcome is DETERMINED
    under AXIS_OUTCOME_DECIDED_BY, else None) / ``won`` / ``at_base_share``
    (positioning ``metrics.at_base_pilot_share`` when the match carries
    positioning data, else None).

    Deltas that cannot be matched to a leaderboard row (legacy keys) are
    dropped and counted in ``meta["unmatched"]``. Sections 16-18 are
    descriptive, so a dropped row only shrinks n; nothing is imputed.
    """
    rows: list[dict[str, Any]] = []
    meta = {"matches": 0, "rows": 0, "unmatched": 0, "with_positioning": 0}
    for match_id, match_date, deltas in iter_rated_history(history):
        md = per_match.get(match_id)
        if not md:
            continue
        meta["matches"] += 1
        winner_block = (md.get("match") or {}).get("winner") or {}
        winner_side = None
        if winner_block.get("decided_by") in AXIS_OUTCOME_DECIDED_BY:
            wt = winner_block.get("team")
            if wt in (1, 2):
                winner_side = int(wt)

        lb_by_key: dict[str, dict[str, Any]] = {}
        name_to_key: dict[str, str] = {}
        for lrow in md.get("leaderboard") or []:
            s64 = lrow.get("steam64")
            key = str(s64) if s64 else str(lrow.get("name") or "")
            if not key:
                continue
            lb_by_key[key] = lrow
            name = lrow.get("name")
            if name:
                name_to_key.setdefault(str(name), key)

        # Positioning metrics are keyed by display name; map back to the
        # leaderboard key so the join is steam64-first like everywhere else.
        pos_players = (md.get("positioning") or {}).get("players") or {}
        at_base_by_key: dict[str, float] = {}
        if isinstance(pos_players, dict):
            for pname, pentry in pos_players.items():
                if not isinstance(pentry, dict):
                    continue
                metrics = pentry.get("metrics") or {}
                share = metrics.get("at_base_pilot_share")
                if not isinstance(share, (int, float)):
                    continue
                key = str(pentry.get("steam64") or name_to_key.get(str(pname)) or pname)
                at_base_by_key[key] = float(share)
        if at_base_by_key:
            meta["with_positioning"] += 1

        for d in deltas:
            key = player_key_for_delta(d)
            lrow = lb_by_key.get(key)
            if lrow is None:
                alt = name_to_key.get(str(d.get("name") or ""))
                lrow = lb_by_key.get(alt) if alt else None
                if lrow is not None:
                    key = alt  # type: ignore[assignment]
            if lrow is None:
                meta["unmatched"] += 1
                continue
            side = lrow.get("faction")
            try:
                side = int(side)
            except (TypeError, ValueError):
                meta["unmatched"] += 1
                continue
            if side not in (1, 2):
                meta["unmatched"] += 1
                continue
            before = d.get("before")
            perf = d.get("performance")
            delta = d.get("delta")
            if before is None or perf is None or delta is None:
                meta["unmatched"] += 1
                continue
            rows.append({
                "match_id":      match_id,
                "match_date":    match_date or "",
                "name":          d.get("name") or lrow.get("name") or key,
                "key":           str(key),
                "before":        float(before),
                "performance":   float(perf),
                "delta":         float(delta),
                "side":          side,
                "is_commander":  bool(lrow.get("is_commander")),
                "winner_side":   winner_side,
                "won":           (winner_side is not None and side == winner_side),
                "at_base_share": at_base_by_key.get(str(key)),
            })
            meta["rows"] += 1
    return rows, meta


# ---------------------------------------------------------------------------
# Metric #15 (v1.7): performance ladder vs wins ladder
# ---------------------------------------------------------------------------


def metric_perf_vs_wins(
    current: dict[str, Any],
    min_matches: int = PERF_VS_WINS_MIN_MATCHES,
) -> dict[str, Any]:
    """How much does the published performance rating (``thug_elo``, the
    6-axis composite) agree with the win/loss ladder (``wins_elo``, the
    Stage E R^W machinery that runs inert at ALPHA = 0)?

    Per-player comparison over everyone with at least ``min_matches``
    rated matches: Spearman and Pearson across players, the per-player
    gap ``thug_elo - wins_elo`` (positive = the composite says you are
    better than your team results do), and the correlation between that
    gap and the share of a player's matches spent commanding. This is the
    v4 critique's quantified "raw performance meter" complaint; it is a
    description of the two ladders, not a verdict on either.
    """
    ratings = current.get("ratings") or []
    eligible = []
    for r in ratings:
        n = r.get("matches_played")
        t = r.get("thug_elo")
        w = r.get("wins_elo")
        if not isinstance(n, int) or n < min_matches:
            continue
        if not isinstance(t, (int, float)) or not isinstance(w, (int, float)):
            continue
        cmdr = r.get("matches_as_commander") or 0
        eligible.append({
            "name":          r.get("name"),
            "steam64":       r.get("steam64"),
            "thug_elo":      float(t),
            "wins_elo":      float(w),
            "gap":           float(t) - float(w),
            "matches_played": n,
            "matches_as_commander": cmdr,
            "commander_share": (cmdr / n) if n else 0.0,
            "wins_record":   r.get("wins_record"),
            "wins_games":    r.get("wins_games"),
        })
    if len(eligible) < 3:
        return {
            "available": False,
            "skipped_reason": f"fewer than 3 players with >= {min_matches} matches",
            "min_matches": min_matches,
        }
    thug = [e["thug_elo"] for e in eligible]
    wins = [e["wins_elo"] for e in eligible]
    gaps = [e["gap"] for e in eligible]
    shares = [e["commander_share"] for e in eligible]
    eligible.sort(key=lambda e: -e["gap"])
    return {
        "available":        True,
        "min_matches":      min_matches,
        "n_players":        len(eligible),
        "spearman":         spearman(thug, wins),
        "pearson":          _pearson(thug, wins),
        "gap_mean":         mean(gaps),
        "gap_stdev":        stdev(gaps) if len(gaps) >= 2 else None,
        "gap_max":          max(gaps),
        "gap_min":          min(gaps),
        "pearson_gap_vs_commander_share": _pearson(shares, gaps),
        "players":          eligible,
    }


# ---------------------------------------------------------------------------
# Metric #16 (v1.7): team-outcome dependence of thug P_i ("stomp effect")
# ---------------------------------------------------------------------------


def _eta_squared(groups: list[list[float]]) -> float | None:
    """Share of total variance explained by group membership."""
    allv = [v for g in groups for v in g]
    if len(allv) < 2:
        return None
    gm = mean(allv)
    ss_total = sum((v - gm) ** 2 for v in allv)
    if ss_total <= 0:
        return None
    ss_between = sum(len(g) * (mean(g) - gm) ** 2 for g in groups if g)
    return ss_between / ss_total


def metric_team_outcome_dependence(
    rows: list[dict[str, Any]],
    high_rated_threshold: float = HIGH_RATED_THRESHOLD,
) -> dict[str, Any]:
    """P_i is lobby-relative, so a thug on the losing side tends to score
    below zero whatever they personally did. This section measures how
    much: winner vs loser mean P and delta, the share of winning thugs
    who still lost rating and losing thugs who still gained, the share of
    thug-P variance explained by win/loss alone (eta squared), and the
    same breakout for high-rated thugs. Commander rows are reported
    separately for completeness (they carry the v2.4 shift).
    """
    thugs = [r for r in rows if r["winner_side"] is not None and not r["is_commander"]]
    cmdrs = [r for r in rows if r["winner_side"] is not None and r["is_commander"]]
    if len(thugs) < 20:
        return {"available": False,
                "skipped_reason": "fewer than 20 determined thug rows"}

    def _block(sub: list[dict[str, Any]]) -> dict[str, Any]:
        w = [r for r in sub if r["won"]]
        l = [r for r in sub if not r["won"]]
        return {
            "n_winners": len(w),
            "n_losers": len(l),
            "winner_mean_p":     mean([r["performance"] for r in w]) if w else None,
            "loser_mean_p":      mean([r["performance"] for r in l]) if l else None,
            "winner_mean_delta": mean([r["delta"] for r in w]) if w else None,
            "loser_mean_delta":  mean([r["delta"] for r in l]) if l else None,
            "winners_negative_delta_share": (
                sum(1 for r in w if r["delta"] < 0) / len(w) if w else None),
            "losers_positive_delta_share": (
                sum(1 for r in l if r["delta"] > 0) / len(l) if l else None),
            "eta_squared_p": _eta_squared([
                [r["performance"] for r in w], [r["performance"] for r in l]]),
        }

    hi = [r for r in thugs if r["before"] >= high_rated_threshold]
    return {
        "available": True,
        "n_thug_rows": len(thugs),
        "n_commander_rows": len(cmdrs),
        "thugs": _block(thugs),
        "high_rated_thugs": {
            "threshold": high_rated_threshold,
            **_block(hi),
        } if hi else {"threshold": high_rated_threshold, "n_winners": 0, "n_losers": 0},
        "commanders": _block(cmdrs) if cmdrs else None,
    }


# ---------------------------------------------------------------------------
# Metric #17 (v1.7): ship-denial gradient (at-base on-foot time vs rating)
# ---------------------------------------------------------------------------


def metric_ship_denial(
    rows: list[dict[str, Any]],
    bands: list[tuple[str, float, float]] | None = None,
) -> dict[str, Any]:
    """Band thug rows by the share of the match spent on foot inside their
    own base (positioning ``at_base_pilot_share`` -- time waiting for a
    ship) and report mean delta, mean P, mean pre-match rating and team
    win share per band, plus the same delta broken out by match outcome so
    the reader can see how much of the gradient survives inside a fixed
    outcome. CONFOUND, stated plainly: a thug is on foot at base because
    their ship died and was not replaced, which happens more on losing
    teams. The gradient is real; attributing it to the commander alone is
    not something this section can do.
    """
    bands = bands or SHIP_DENIAL_BANDS
    eligible = [r for r in rows
                if r["winner_side"] is not None and not r["is_commander"]
                and r.get("at_base_share") is not None]
    if len(eligible) < 20:
        return {"available": False,
                "skipped_reason": "fewer than 20 determined thug rows with positioning"}
    out_bands = []
    for label, lo, hi in bands:
        sub = [r for r in eligible if lo <= r["at_base_share"] < hi]
        if not sub:
            out_bands.append({"band": label, "lo": lo, "hi": hi, "n": 0})
            continue
        w = [r for r in sub if r["won"]]
        l = [r for r in sub if not r["won"]]
        out_bands.append({
            "band": label, "lo": lo, "hi": hi,
            "n": len(sub),
            "mean_delta":  mean([r["delta"] for r in sub]),
            "mean_p":      mean([r["performance"] for r in sub]),
            "mean_before": mean([r["before"] for r in sub]),
            "win_share":   len(w) / len(sub),
            "winners": {"n": len(w),
                        "mean_delta": mean([r["delta"] for r in w]) if w else None},
            "losers":  {"n": len(l),
                        "mean_delta": mean([r["delta"] for r in l]) if l else None},
        })
    shares = [r["at_base_share"] for r in eligible]
    deltas = [r["delta"] for r in eligible]
    perfs = [r["performance"] for r in eligible]
    return {
        "available": True,
        "n_rows": len(eligible),
        "spearman_share_vs_delta": spearman(shares, deltas),
        "spearman_share_vs_p":     spearman(shares, perfs),
        "bands": out_bands,
    }


# ---------------------------------------------------------------------------
# Metric #18 (v1.7): commander selection + role-adjustment audit
# ---------------------------------------------------------------------------


def metric_commander_selection(
    rows: list[dict[str, Any]],
    min_rows: int = CMDR_SELECTION_MIN_ROWS,
) -> dict[str, Any]:
    """Who commands, and what does commanding do to a rating?

    Selection: for every commander row, the commander's pre-match VTSR-T
    percentile inside their own lobby (0 = highest rated in the lobby) and
    whether they sat below their own team's thug mean. Concentration: the
    share of all commander rows held by the four most frequent commanders.
    Role adjustment: per-player mean delta as commander vs as thug (players
    with >= ``min_rows`` rows in both roles) and the cohort means. A
    commander cohort that out-gains the thug cohort per match is the v2.4
    axis-shift over-compensating for above-average fighters; a cohort that
    under-gains is the reverse. Either reading is an audit input, not a
    verdict.
    """
    by_match: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_match[r["match_id"]].append(r)
    percentiles: list[float] = []
    n_sides = 0
    n_below = 0
    for mid, mrows in by_match.items():
        ratings_desc = sorted((r["before"] for r in mrows), reverse=True)
        n = len(ratings_desc)
        sides: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for r in mrows:
            sides[r["side"]].append(r)
        for side, srows in sides.items():
            cmd = [r for r in srows if r["is_commander"]]
            thug = [r for r in srows if not r["is_commander"]]
            if not cmd:
                continue
            c = cmd[0]
            if n > 1:
                percentiles.append(ratings_desc.index(c["before"]) / (n - 1))
            if thug:
                n_sides += 1
                if c["before"] < mean([r["before"] for r in thug]):
                    n_below += 1
    if not percentiles:
        return {"available": False, "skipped_reason": "no commander rows"}

    cmdr_rows = [r for r in rows if r["is_commander"]]
    thug_rows = [r for r in rows if not r["is_commander"]]
    counts: dict[str, int] = defaultdict(int)
    names: dict[str, str] = {}
    for r in cmdr_rows:
        counts[r["key"]] += 1
        names[r["key"]] = r["name"]
    top = sorted(counts.items(), key=lambda kv: -kv[1])
    top4 = sum(c for _, c in top[:4])

    per_player: dict[str, dict[str, Any]] = {}
    for r in rows:
        rec = per_player.setdefault(r["key"], {"name": r["name"], "cmdr": [], "thug": []})
        rec["cmdr" if r["is_commander"] else "thug"].append(r["delta"])
    table = []
    for key, rec in per_player.items():
        if len(rec["cmdr"]) >= min_rows and len(rec["thug"]) >= min_rows:
            table.append({
                "name": rec["name"],
                "steam64": key,
                "n_commander": len(rec["cmdr"]),
                "n_thug": len(rec["thug"]),
                "mean_delta_commander": mean(rec["cmdr"]),
                "mean_delta_thug": mean(rec["thug"]),
            })
    table.sort(key=lambda t: -t["n_commander"])

    return {
        "available": True,
        "n_commander_rows": len(cmdr_rows),
        "n_thug_rows": len(thug_rows),
        "commander_percentile_mean":   mean(percentiles),
        "commander_percentile_median": median(percentiles),
        "team_sides_with_both_roles":  n_sides,
        "commander_below_own_thug_mean_share": (n_below / n_sides) if n_sides else None,
        "distinct_commanders": len(counts),
        "top4_commander_row_share": (top4 / len(cmdr_rows)) if cmdr_rows else None,
        "top_commanders": [{"name": names[k], "steam64": k, "rows": c} for k, c in top[:8]],
        "cohort_mean_delta_commander": mean([r["delta"] for r in cmdr_rows]) if cmdr_rows else None,
        "cohort_mean_delta_thug":      mean([r["delta"] for r in thug_rows]) if thug_rows else None,
        "min_rows_per_role": min_rows,
        "per_player": table,
    }


# ---------------------------------------------------------------------------
# Metric #19 (v1.7): faction effect, controlling for the ratings
# ---------------------------------------------------------------------------


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1.0 - 1e-6)
    return math.log(p / (1.0 - p))


def _sigmoid(z: float) -> float:
    if z >= 0:
        ez = math.exp(-z)
        return 1.0 / (1.0 + ez)
    ez = math.exp(z)
    return ez / (1.0 + ez)


def _normal_sf_two_sided(z: float) -> float:
    """Two-sided normal tail probability for a Wald statistic."""
    return math.erfc(abs(z) / math.sqrt(2.0))


def _fit_offset_logistic_2(
    xs: list[tuple[float, float]], ys: list[float], offsets: list[float],
) -> dict[str, Any] | None:
    """Newton-Raphson fit of ``logit p = offset + b1*x1 + b2*x2`` (no
    intercept -- the offset is the canonical expected score, so the model
    asks only whether the two faction contrasts add information). Returns
    coefficients, Wald SEs/z/p, the likelihood-ratio test against the
    offset-only model (chi-square, 2 df, closed-form survival
    ``exp(-LR/2)``), and log-loss/accuracy before vs after. ``None`` when
    the Hessian is singular (a contrast with no variation in the sample).
    """
    n = len(ys)
    if n == 0:
        return None

    def _ll(b1: float, b2: float) -> float:
        total = 0.0
        for (x1, x2), y, off in zip(xs, ys, offsets):
            z = off + b1 * x1 + b2 * x2
            # log p if y==1 else log(1-p), written stably.
            total += -math.log1p(math.exp(-z)) if y == 1.0 else -math.log1p(math.exp(z))
        return total

    b1 = b2 = 0.0
    for _ in range(FACTION_FIT_MAX_ITER):
        g1 = g2 = 0.0
        h11 = h12 = h22 = 0.0
        for (x1, x2), y, off in zip(xs, ys, offsets):
            p = _sigmoid(off + b1 * x1 + b2 * x2)
            r = y - p
            g1 += x1 * r
            g2 += x2 * r
            w = p * (1.0 - p)
            h11 += w * x1 * x1
            h12 += w * x1 * x2
            h22 += w * x2 * x2
        det = h11 * h22 - h12 * h12
        if abs(det) < 1e-12:
            return None
        inv11 = h22 / det
        inv12 = -h12 / det
        inv22 = h11 / det
        s1 = inv11 * g1 + inv12 * g2
        s2 = inv12 * g1 + inv22 * g2
        b1 += s1
        b2 += s2
        if abs(s1) < FACTION_FIT_TOL and abs(s2) < FACTION_FIT_TOL:
            break
    # Final Hessian at the optimum for the SEs.
    h11 = h12 = h22 = 0.0
    for (x1, x2), y, off in zip(xs, ys, offsets):
        p = _sigmoid(off + b1 * x1 + b2 * x2)
        w = p * (1.0 - p)
        h11 += w * x1 * x1
        h12 += w * x1 * x2
        h22 += w * x2 * x2
    det = h11 * h22 - h12 * h12
    if abs(det) < 1e-12:
        return None
    se1 = math.sqrt(max(h22 / det, 0.0))
    se2 = math.sqrt(max(h11 / det, 0.0))
    ll1 = _ll(b1, b2)
    ll0 = _ll(0.0, 0.0)
    lr = 2.0 * (ll1 - ll0)
    acc0 = sum(1 for y, off in zip(ys, offsets) if (off > 0) == (y == 1.0)) / n
    acc1 = sum(
        1 for (x1, x2), y, off in zip(xs, ys, offsets)
        if ((off + b1 * x1 + b2 * x2) > 0) == (y == 1.0)
    ) / n
    z1 = (b1 / se1) if se1 > 0 else None
    z2 = (b2 / se2) if se2 > 0 else None
    return {
        "n": n,
        "coef_hadean_vs_isdf": b1,
        "se_hadean_vs_isdf": se1,
        "z_hadean_vs_isdf": z1,
        "p_hadean_vs_isdf": _normal_sf_two_sided(z1) if z1 is not None else None,
        "coef_scion_vs_isdf": b2,
        "se_scion_vs_isdf": se2,
        "z_scion_vs_isdf": z2,
        "p_scion_vs_isdf": _normal_sf_two_sided(z2) if z2 is not None else None,
        "lr_chi2_2df": lr,
        "lr_p_value": math.exp(-lr / 2.0) if lr >= 0 else 1.0,
        "log_loss_baseline": -ll0 / n,
        "log_loss_with_faction": -ll1 / n,
        "accuracy_baseline": acc0,
        "accuracy_with_faction": acc1,
    }


def metric_faction_effect(
    cmdr_history: dict[str, Any] | None,
    manifest: list[dict[str, Any]],
    f9_ledger: dict[str, Any] | None,
    discovery_cutoff: str = FACTION_DISCOVERY_CUTOFF,
) -> dict[str, Any]:
    """Is a faction advantaged AFTER the ratings have had their say?

    Every VTSR-C duel already carries the canonical expected score
    (commander gap + lambda x thug handicap). Taking its logit as a fixed
    offset, fit two contrasts -- Hadean-vs-ISDF and Scion-vs-ISDF, each
    coded +1/-1/0 by which side fielded the faction -- and ask whether
    they add information: Wald z per contrast, a likelihood-ratio test for
    the pair, log-loss and accuracy before vs after, and the coefficients
    expressed as rating points on the ladder's logistic scale (so
    "+60 points" reads as "worth a 60-point stronger commander").

    Factions join from ``matches.json`` ``team_factions`` for telemetry
    duels and from ``data/external/f9_ledger.json`` for F9 duels (by
    ``external_row``). Mirror matchups carry no contrast and drop out of
    the fit (they still count in the pick tables). The fit runs on the full
    corpus, per source, and on the confirmation sample (duels dated after
    ``discovery_cutoff``) that the Phase 6 memo scores -- the full-corpus
    fit is DISCOVERY and can never promote anything.
    """
    duels = (cmdr_history or {}).get("duels") or []
    if not duels:
        return {"available": False, "skipped_reason": "no commander history"}
    scale = float((cmdr_history or {}).get("logistic_scale") or CMDR_LOGISTIC_SCALE_FALLBACK)
    man_factions: dict[str, tuple[str | None, str | None]] = {}
    for m in manifest:
        tf = m.get("team_factions") or {}
        c1 = FACTION_CODES.get(((tf.get("1") or {}) or {}).get("code") or "")
        c2 = FACTION_CODES.get(((tf.get("2") or {}) or {}).get("code") or "")
        man_factions[str(m.get("id"))] = (c1, c2)
    ledger_factions: dict[int, tuple[str | None, str | None]] = {}
    for d in (f9_ledger or {}).get("duels") or []:
        fs = d.get("factions") or {}
        ledger_factions[int(d.get("row"))] = (
            FACTION_CODES.get(fs.get("1") or ""), FACTION_CODES.get(fs.get("2") or ""))

    joined: list[dict[str, Any]] = []
    n_missing_faction = 0
    n_draws = 0
    picks: dict[str, dict[str, int]] = {c: {"picks": 0, "wins": 0} for c in ("i", "e", "f")}
    cmdr_before_by_faction: dict[str, list[float]] = {"i": [], "e": [], "f": []}
    month_sides: dict[str, dict[str, int]] = defaultdict(lambda: {"sides": 0, "hadean": 0})
    for d in duels:
        if d.get("source") == "f9":
            f1, f2 = ledger_factions.get(int(d.get("external_row") or -1), (None, None))
        else:
            f1, f2 = man_factions.get(str(d.get("match_id")), (None, None))
        if not f1 or not f2:
            n_missing_faction += 1
            continue
        outcome = d.get("outcome")
        if outcome not in ("team1", "team2"):
            n_draws += 1
            continue
        y = 1.0 if outcome == "team1" else 0.0
        c1 = (d.get("commanders") or {}).get("1") or {}
        c2 = (d.get("commanders") or {}).get("2") or {}
        e1 = c1.get("expected")
        if not isinstance(e1, (int, float)):
            n_missing_faction += 1
            continue
        day = str(d.get("date") or "")[:10]
        joined.append({
            "source": d.get("source") or "telemetry",
            "date": day,
            "f1": f1, "f2": f2, "y": y, "e1": float(e1),
        })
        picks[f1]["picks"] += 1
        picks[f2]["picks"] += 1
        picks[f1 if y == 1.0 else f2]["wins"] += 1
        if isinstance(c1.get("before"), (int, float)):
            cmdr_before_by_faction[f1].append(float(c1["before"]))
        if isinstance(c2.get("before"), (int, float)):
            cmdr_before_by_faction[f2].append(float(c2["before"]))
        if len(day) >= 7:
            ms = month_sides[day[:7]]
            ms["sides"] += 2
            ms["hadean"] += (f1 == "e") + (f2 == "e")

    if len(joined) < 20:
        return {"available": False,
                "skipped_reason": "fewer than 20 duels with both factions known",
                "n_missing_faction": n_missing_faction}

    # Raw non-mirror matchup table.
    matchups: dict[tuple[str, str], dict[str, Any]] = {}
    n_mirror = 0
    for j in joined:
        if j["f1"] == j["f2"]:
            n_mirror += 1
            continue
        a, b = sorted([j["f1"], j["f2"]])
        rec = matchups.setdefault((a, b), {"n": 0, "wins": {a: 0, b: 0}})
        rec["n"] += 1
        rec["wins"][j["f1"] if j["y"] == 1.0 else j["f2"]] += 1
    matchup_rows = []
    for (a, b), rec in sorted(matchups.items()):
        wa = rec["wins"][a]
        ci = wilson_ci(wa, rec["n"])
        matchup_rows.append({
            "faction_a": a, "faction_b": b,
            "faction_a_name": FACTION_NAMES[a], "faction_b_name": FACTION_NAMES[b],
            "n": rec["n"],
            "wins_a": wa, "wins_b": rec["wins"][b],
            "rate_a": wa / rec["n"],
            "rate_a_ci": list(ci),
        })

    def _fit(subset: list[dict[str, Any]]) -> dict[str, Any] | None:
        non_mirror = [j for j in subset if j["f1"] != j["f2"]]
        if len(non_mirror) < 10:
            return {"n": len(non_mirror), "fitted": False,
                    "skipped_reason": "fewer than 10 non-mirror duels"}
        xs = [((1.0 if j["f1"] == "e" else 0.0) - (1.0 if j["f2"] == "e" else 0.0),
               (1.0 if j["f1"] == "f" else 0.0) - (1.0 if j["f2"] == "f" else 0.0))
              for j in non_mirror]
        ys = [j["y"] for j in non_mirror]
        offs = [_logit(j["e1"]) for j in non_mirror]
        fit = _fit_offset_logistic_2(xs, ys, offs)
        if fit is None:
            return {"n": len(non_mirror), "fitted": False,
                    "skipped_reason": "singular Hessian (a contrast has no variation)"}
        pts = scale / math.log(10.0)
        # Frozen-term evaluation: the memo's candidate constants applied
        # as-is (no refit) -- the out-of-sample test the promote rule reads.
        frozen_ll = 0.0
        frozen_acc = 0
        for j, off in zip(non_mirror, offs):
            term = (FACTION_FROZEN_POINTS.get(j["f1"], 0.0)
                    - FACTION_FROZEN_POINTS.get(j["f2"], 0.0)) / pts
            z = off + term
            p = _sigmoid(z)
            frozen_ll += -math.log(max(p if j["y"] == 1.0 else 1.0 - p, 1e-12))
            frozen_acc += 1 if (z > 0) == (j["y"] == 1.0) else 0
        n_nm = len(non_mirror)
        fit.update({
            "fitted": True,
            "rating_points_hadean_vs_isdf": fit["coef_hadean_vs_isdf"] * pts,
            "rating_points_scion_vs_isdf": fit["coef_scion_vs_isdf"] * pts,
            "n_mirror_dropped": len(subset) - n_nm,
            "frozen_term": {
                "points": dict(FACTION_FROZEN_POINTS),
                "log_loss": frozen_ll / n_nm,
                "log_loss_delta_vs_baseline": fit["log_loss_baseline"] - frozen_ll / n_nm,
                "accuracy": frozen_acc / n_nm,
                "accuracy_delta_vs_baseline": frozen_acc / n_nm - fit["accuracy_baseline"],
            },
        })
        return fit

    fits = {
        "all": _fit(joined),
        "telemetry": _fit([j for j in joined if j["source"] != "f9"]),
        "f9": _fit([j for j in joined if j["source"] == "f9"]),
        "confirmation": _fit([j for j in joined if j["date"] > discovery_cutoff]),
    }
    months = [
        {"month": k, "sides": v["sides"], "hadean_share": v["hadean"] / v["sides"]}
        for k, v in sorted(month_sides.items()) if v["sides"]
    ]
    # Memo promote verdict, read off the confirmation fit only. The
    # conditions mirror critique/decisions/phase-6-faction-advantage-term.md;
    # the memo text is binding if they ever disagree.
    conf = fits["confirmation"] or {}
    disc = fits["all"] or {}
    reasons: list[str] = []
    verdict = "NOT YET TESTABLE"
    if conf.get("fitted"):
        n_conf = conf.get("n", 0)
        ft = conf.get("frozen_term") or {}
        if n_conf < FACTION_PROMOTE_MIN_CONFIRMATION:
            reasons.append(f"confirmation non-mirror duels {n_conf} < "
                           f"{FACTION_PROMOTE_MIN_CONFIRMATION}")
        if (ft.get("log_loss_delta_vs_baseline") or 0.0) < FACTION_PROMOTE_LOGLOSS_DELTA:
            reasons.append("frozen term does not improve confirmation log-loss by "
                           f">= {FACTION_PROMOTE_LOGLOSS_DELTA}")
        if (ft.get("accuracy_delta_vs_baseline") or 0.0) < 0.0:
            reasons.append("frozen term worsens confirmation accuracy")
        disc_coef = disc.get("coef_hadean_vs_isdf") if disc.get("fitted") else None
        conf_coef = conf.get("coef_hadean_vs_isdf")
        if disc_coef is not None and conf_coef is not None:
            if conf_coef * disc_coef <= 0:
                reasons.append("confirmation refit sign disagrees with discovery")
            elif abs(conf_coef) < 0.5 * abs(disc_coef):
                reasons.append("confirmation refit magnitude below half the discovery estimate")
        if n_conf >= FACTION_PROMOTE_MIN_CONFIRMATION:
            if (conf_coef is not None and disc_coef is not None
                    and conf_coef * disc_coef <= 0):
                verdict = "DISCARD"
            else:
                verdict = "PROMOTE-CANDIDATE" if not reasons else "HOLD"
        else:
            verdict = "HOLD (sample too small)"
    else:
        reasons.append(conf.get("skipped_reason") or "no confirmation duels yet")
    promote = {
        "verdict": verdict,
        "reasons": reasons,
        "min_confirmation": FACTION_PROMOTE_MIN_CONFIRMATION,
        "log_loss_min_improvement": FACTION_PROMOTE_LOGLOSS_DELTA,
        "frozen_points": dict(FACTION_FROZEN_POINTS),
        "memo": "critique/decisions/phase-6-faction-advantage-term.md",
    }
    return {
        "available": True,
        "promote": promote,
        "n_duels_with_factions": len(joined),
        "n_telemetry": sum(1 for j in joined if j["source"] != "f9"),
        "n_f9": sum(1 for j in joined if j["source"] == "f9"),
        "n_mirror": n_mirror,
        "n_missing_faction": n_missing_faction,
        "n_draws_skipped": n_draws,
        "logistic_scale": scale,
        "discovery_cutoff": discovery_cutoff,
        "picks": {FACTION_NAMES[c]: {**v, "win_rate": (v["wins"] / v["picks"]) if v["picks"] else None}
                  for c, v in picks.items()},
        "commander_vtsr_c_before_by_faction": {
            FACTION_NAMES[c]: {"n": len(v), "mean": mean(v) if v else None}
            for c, v in cmdr_before_by_faction.items()},
        "matchups": matchup_rows,
        "fits": fits,
        "hadean_share_by_month": months,
    }


# ---------------------------------------------------------------------------
# Metric #20 (v1.8): the format gate -- what the size exclusion leaves out
# ---------------------------------------------------------------------------


def _side_counts(md: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    """Non-campod leaderboard rows per side (1|2)."""
    sides: dict[int, list[dict[str, Any]]] = {1: [], 2: []}
    for r in md.get("leaderboard") or []:
        if r.get("is_campod"):
            continue
        try:
            side = int(r.get("faction"))
        except (TypeError, ValueError):
            continue
        if side in (1, 2):
            sides[side].append(r)
    return sides


def _duel_sort_key(date: Any) -> str:
    """Sortable key for a duel/match date. F9 rows carry a bare day; place
    them at midday so same-day telemetry (which carries a timestamp)
    orders around them deterministically."""
    s = str(date or "")
    return s if "T" in s else (s + "T12:00:00+00:00" if s else "")


def _match_dynamics(md: dict[str, Any], duration_sec: float) -> dict[str, list[float]]:
    """Per-row rate statistics for one match (kills / deaths / damage per
    player-minute, PvE share) plus per-team peak pools when the match
    carries economy telemetry."""
    mins = max(duration_sec, 1.0) / 60.0
    out: dict[str, list[float]] = {"kpm": [], "dpm": [], "dmgpm": [], "pve": [], "pools": []}
    for side_rows in _side_counts(md).values():
        for r in side_rows:
            p = r.get("personal") or {}
            out["kpm"].append(float(r.get("kills") or 0) / mins)
            out["dpm"].append(float(r.get("deaths") or 0) / mins)
            dealt = float(p.get("dealt") or 0.0)
            out["dmgpm"].append(dealt / mins)
            if dealt > 0:
                out["pve"].append(float(p.get("pve_dealt") or 0.0) / dealt)
    for t in ((md.get("economy") or {}).get("teams") or {}).values():
        if isinstance(t, dict) and isinstance(t.get("peak_pools"), (int, float)):
            out["pools"].append(float(t["peak_pools"]))
    return out


def metric_format_gate(
    history: dict[str, Any],
    per_match: dict[str, Any],
    per_match_excluded: dict[str, Any],
    manifest: list[dict[str, Any]],
    cmdr_history: dict[str, Any] | None,
    current: dict[str, Any] | None = None,
    small_max_per_side: int = FORMAT_SMALL_MAX_PER_SIDE,
    min_duration_sec: float = FORMAT_MIN_DURATION_SEC,
) -> dict[str, Any]:
    """What does the six-row / 240-second rating gate leave out, and would
    the published ratings have predicted those games?

    Three blocks:
      * **profile** -- every excluded history entry by reason, by team
        shape (non-campod rows per side) and by month, with the count of
        small-format games (<= ``small_max_per_side`` per side) that have a
        DETERMINED winner.
      * **dynamics** -- small-format vs rated full-format medians of match
        duration, kills / deaths / damage per player-minute, PvE damage
        share and peak pools (games under ``min_duration_sec`` dropped).
      * **transfer** -- for each determined small-format game, the side
        with the higher pre-match team-mean VTSR-T (reconstructed from the
        rated ``elo_history`` deltas -- ratings only move on rated
        appearances) and the side whose leader has the higher pre-match
        VTSR-C (from ``elo_commander_history``); how often each picked the
        actual winner, with Wilson intervals. A size-agnostic test the
        composite itself cannot run: with two rated rows every lobby z-score
        is +-0.5 by construction and with four the sigma estimate is noise,
        which is why the composite excludes these games whatever one thinks
        of the format.
    Descriptive only; nothing here changes a rating or the summary file.
    """
    man_by_id = {str(m.get("id")): m for m in manifest}
    entries = (history or {}).get("history") or []
    excluded = [e for e in entries if e.get("match_excluded")]
    if not excluded:
        return {"available": False, "skipped_reason": "no excluded history entries"}

    # ---- profile -------------------------------------------------------
    reasons: dict[str, int] = defaultdict(int)
    shapes: dict[str, int] = defaultdict(int)
    months_small: dict[str, int] = defaultdict(int)
    small_games: list[dict[str, Any]] = []
    for e in excluded:
        mid = str(e.get("match_id") or "")
        reasons[str(e.get("exclusion_reason") or "unknown")] += 1
        md = per_match_excluded.get(mid)
        if not md:
            continue
        sides = _side_counts(md)
        n1, n2 = len(sides[1]), len(sides[2])
        shapes[f"{n1}v{n2}"] += 1
        if n1 == 0 or n2 == 0 or max(n1, n2) > small_max_per_side:
            continue
        m = man_by_id.get(mid) or {}
        win = (md.get("match") or {}).get("winner") or {}
        determined = (win.get("decided_by") in AXIS_OUTCOME_DECIDED_BY
                      and win.get("team") in (1, 2))
        date = str(e.get("match_date") or m.get("date") or "")
        if len(date) >= 7:
            months_small[date[:7]] += 1
        small_games.append({
            "match_id": mid, "date": date, "n1": n1, "n2": n2,
            "uneven": n1 != n2,
            "duration_sec": float(m.get("duration_sec") or 0.0),
            "determined": determined,
            "winner_side": int(win["team"]) if determined else None,
            "decided_by": win.get("decided_by"),
            "sides": sides,
        })

    # ---- dynamics ------------------------------------------------------
    def _agg(ids: list[tuple[str, dict[str, Any]]]) -> dict[str, Any]:
        acc: dict[str, list[float]] = {"dur": [], "kpm": [], "dpm": [], "dmgpm": [], "pve": [], "pools": []}
        for mid, md in ids:
            dur = float((man_by_id.get(mid) or {}).get("duration_sec") or 0.0)
            if dur < min_duration_sec:
                continue
            acc["dur"].append(dur)
            dyn = _match_dynamics(md, dur)
            for k in ("kpm", "dpm", "dmgpm", "pve", "pools"):
                acc[k].extend(dyn[k])
        med = lambda v: (median(v) if v else None)  # noqa: E731
        return {
            "n_matches": len(acc["dur"]),
            "n_rows": len(acc["kpm"]),
            "duration_sec_median": med(acc["dur"]),
            "kills_per_player_min_median": med(acc["kpm"]),
            "deaths_per_player_min_median": med(acc["dpm"]),
            "damage_per_player_min_median": med(acc["dmgpm"]),
            "pve_share_median": med(acc["pve"]),
            "peak_pools_median": med(acc["pools"]),
            "n_team_sides_with_pools": len(acc["pools"]),
        }

    small_ids = [(g["match_id"], per_match_excluded[g["match_id"]]) for g in small_games]
    full_ids = [(mid, md) for mid, md in per_match.items()]
    dynamics = {"small_format": _agg(small_ids), "rated_full_format": _agg(full_ids)}

    # ---- transfer ------------------------------------------------------
    t_timeline: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for mid, mdate, deltas in iter_rated_history(history):
        key_date = _duel_sort_key(mdate)
        for d in deltas:
            aft = d.get("after")
            if isinstance(aft, (int, float)):
                t_timeline[player_key_for_delta(d)].append((key_date, float(aft)))
    for lst in t_timeline.values():
        lst.sort()
    c_timeline: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for duel in (cmdr_history or {}).get("duels") or []:
        key_date = _duel_sort_key(duel.get("date"))
        for side in ("1", "2"):
            c = (duel.get("commanders") or {}).get(side) or {}
            aft = c.get("after")
            s64 = c.get("steam64")
            if s64 and isinstance(aft, (int, float)):
                c_timeline[str(s64)].append((key_date, float(aft)))
    for lst in c_timeline.values():
        lst.sort()

    def _before(timeline: list[tuple[str, float]], date_key: str, anchor: float) -> tuple[float, int]:
        val, n = anchor, 0
        for dk, aft in timeline:
            if dk < date_key:
                val, n = aft, n + 1
            else:
                break
        return val, n

    t_anchor = float((current or {}).get("anchor") or 1500.0)
    c_anchor = float((cmdr_history or {}).get("anchor") or CMDR_ANCHOR_FALLBACK)
    rows_out: list[dict[str, Any]] = []
    t_hit = t_n = c_hit = c_n = 0
    for g in small_games:
        if not g["determined"]:
            continue
        date_key = _duel_sort_key(g["date"])
        means: dict[int, float] = {}
        hist_n: dict[int, float] = {}
        cmdr_r: dict[int, float] = {}
        cmdr_n: dict[int, int] = {}
        for side in (1, 2):
            rows_side = g["sides"][side]
            vals = []
            ns = []
            for r in rows_side:
                key = str(r.get("steam64") or r.get("name") or "")
                v, n = _before(t_timeline.get(key) or [], date_key, t_anchor)
                vals.append(v)
                ns.append(n)
            means[side] = mean(vals)
            hist_n[side] = mean(ns)
            leader = next((r for r in rows_side if r.get("is_commander")), rows_side[0])
            cv, cn = _before(c_timeline.get(str(leader.get("steam64") or "")) or [], date_key, c_anchor)
            cmdr_r[side], cmdr_n[side] = cv, cn
        fav_t = 1 if means[1] > means[2] else (2 if means[2] > means[1] else None)
        fav_c = 1 if cmdr_r[1] > cmdr_r[2] else (2 if cmdr_r[2] > cmdr_r[1] else None)
        if fav_t is not None:
            t_n += 1
            t_hit += int(fav_t == g["winner_side"])
        if fav_c is not None:
            c_n += 1
            c_hit += int(fav_c == g["winner_side"])
        rows_out.append({
            "match_id": g["match_id"], "date": g["date"][:10],
            "shape": f"{g['n1']}v{g['n2']}", "uneven": g["uneven"],
            "winner_side": g["winner_side"], "decided_by": g["decided_by"],
            "team_mean_vtsr_t": {1: means[1], 2: means[2]},
            "team_prior_rated_matches_mean": {1: hist_n[1], 2: hist_n[2]},
            "leader_vtsr_c": {1: cmdr_r[1], 2: cmdr_r[2]},
            "leader_prior_duels": {1: cmdr_n[1], 2: cmdr_n[2]},
            "vtsr_t_pick_correct": (fav_t == g["winner_side"]) if fav_t else None,
            "vtsr_c_pick_correct": (fav_c == g["winner_side"]) if fav_c else None,
            "names": {1: [r.get("name") for r in g["sides"][1]],
                      2: [r.get("name") for r in g["sides"][2]]},
        })

    small_rows_n = [g["n1"] + g["n2"] for g in small_games]
    return {
        "available": True,
        "small_max_per_side": small_max_per_side,
        "min_duration_sec": min_duration_sec,
        "profile": {
            "n_excluded_entries": len(excluded),
            "by_reason": dict(sorted(reasons.items())),
            "by_shape": dict(sorted(shapes.items(), key=lambda kv: -kv[1])),
            "n_small_format": len(small_games),
            "n_small_format_uneven": sum(1 for g in small_games if g["uneven"]),
            "n_small_format_determined": sum(1 for g in small_games if g["determined"]),
            "small_format_by_month": dict(sorted(months_small.items())),
            "small_format_rated_rows_max": max(small_rows_n) if small_rows_n else None,
        },
        "dynamics": dynamics,
        "transfer": {
            "n_determined": len(rows_out),
            "vtsr_t_team_mean": {
                "n": t_n, "correct": t_hit,
                "accuracy": (t_hit / t_n) if t_n else None,
                "accuracy_ci": list(wilson_ci(t_hit, t_n)) if t_n else None,
            },
            "vtsr_c_leader_gap": {
                "n": c_n, "correct": c_hit,
                "accuracy": (c_hit / c_n) if c_n else None,
                "accuracy_ci": list(wilson_ci(c_hit, c_n)) if c_n else None,
            },
            "rows": rows_out,
        },
        "degeneracy_note": (
            "P_i is a lobby z-score: with 2 rated rows every axis is +-0.5 "
            "by construction and with 4 the sigma estimate is noise, so the "
            "composite cannot score these games. The wins ladder (team-mean "
            "logistic) and VTSR-C (pairwise) are size-agnostic; the transfer "
            "block is the test the composite cannot run."
        ),
    }


# ---------------------------------------------------------------------------
# Report writers
# ---------------------------------------------------------------------------


def _fmt_pct(x: float | None, decimals: int = 1) -> str:
    if x is None:
        return "-"
    return f"{x * 100:.{decimals}f}%"


def _fmt_num(x: float | None, decimals: int = 3) -> str:
    if x is None:
        return "-"
    return f"{x:.{decimals}f}"


def _fmt_int(x: int | None) -> str:
    if x is None:
        return "-"
    return f"{x:,}"


def _fmt_pair(lo: float | None, hi: float | None, decimals: int = 1) -> str:
    if lo is None or hi is None:
        return "-"
    return f"{lo * 100:.{decimals}f}-{hi * 100:.{decimals}f}%"


def render_markdown_report(
    results: dict[str, Any],
    weights: dict[str, float],
) -> str:
    """Render a human-readable validator report. Intentionally
    self-documenting -- the file lives in ``_validation/`` (gitignored)
    so a teammate reading the output should not need to chase code or
    docs to interpret it.
    """
    lines: list[str] = []

    meta = results["meta"]
    rk = results["rank_correlation"]
    cal = results["calibration"]
    sc = results["self_consistency"]
    bs = results["bootstrap"]
    syn = results["synthetic_winner"]
    cwa = results["clean_win_accuracy"]
    abl = results["axis_ablation"]
    dir_p = results["dirichlet_perturbation"]
    funnel = results["winner_funnel"]

    lines.append("# VTSR-T Validator Report")
    lines.append("")
    lines.append(f"- Generated: `{meta['generated_at']}`")
    lines.append(f"- Validator version: {meta['validator_version']} (Phase 1 smoke-test)")
    lines.append(f"- Corpus: **{meta['rated_match_count']:,} rated matches**, "
                 f"**{meta['players_total']} players** ("
                 f"{meta['players_with_min_matches']} with >= {SELF_CONSISTENCY_MIN_MATCHES} matches)")
    lines.append(f"- ELO source: `{meta['elo_source']}` "
                 f"(schema {meta['elo_schema_version']})")
    lines.append("")
    lines.append("## Headline metrics")
    lines.append("")
    lines.append("| Metric | Value | Notes |")
    lines.append("|---|---|---|")
    lines.append(
        f"| Spearman ρ (pre-match R → in-match P) | "
        f"**{_fmt_num(rk['pooled_rho'])}** | "
        f"pooled across {_fmt_int(rk['pooled_n_pairs'])} player-matches |"
    )
    lines.append(
        f"| Per-match ρ (mean ± stdev) | "
        f"{_fmt_num(rk['per_match_rho_mean'])} ± "
        f"{_fmt_num(rk['per_match_rho_stdev'])} | "
        f"averaged over {_fmt_int(rk['per_match_n_runs'])} matches |"
    )
    lines.append(
        f"| Self-consistency ρ (split-half) | "
        f"**{_fmt_num(sc['spearman_rho'])}** | "
        f"n={sc['n_players']} players, ≥{sc['min_matches_threshold']} matches each |"
    )
    lines.append(
        f"| Calibration MAE | {_fmt_num(cal['calibration_mae'])} | "
        f"average |observed P_i − predicted E_i| across {len(cal['buckets'])} buckets |"
    )
    if syn["n_eligible"]:
        passes = "PASSES ✓" if syn["passes_threshold"] else "FAILS ✗"
        ci = syn["agreement_ci"] or [None, None]
        lines.append(
            f"| Synthetic-winner agreement | "
            f"**{_fmt_pct(syn['agreement'])}** "
            f"(95% CI {_fmt_pair(ci[0], ci[1])}) | "
            f"{passes} {SYNTHETIC_WINNER_THRESHOLD * 100:.0f}% threshold "
            f"(n={syn['n_eligible']} clean_wins) |"
        )
    else:
        lines.append("| Synthetic-winner agreement | - | no eligible clean_win matches |")
    if cwa.get("n_eligible"):
        ci = cwa["accuracy_ci"] or [None, None]
        lines.append(
            f"| clean_win prediction accuracy (mean R) | "
            f"**{_fmt_pct(cwa['accuracy'])}** "
            f"(95% CI {_fmt_pair(ci[0], ci[1])}) | "
            f"n={cwa['n_eligible']}; "
            f"vs Cambridge skillbench 60-64% |"
        )
        lines.append(
            f"| Log-loss (mean R) | "
            f"{_fmt_num(cwa['log_loss_mean'])} | "
            f"vs {_fmt_num(cwa['log_loss_coin_flip'])} coin-flip baseline |"
        )
        # v1.1 — MAX-vs-median preview headline.
        if "best_aggregation" in cwa:
            best = cwa["best_aggregation"]
            best_agg = cwa["aggregations"].get(best) or {}
            best_label = {
                "mean":        "team mean R",
                "hard_max":    "team hard MAX R",
                "softmax_max": f"team softmax R (τ={cwa.get('softmax_tau', 0):.0f})",
            }.get(best, best)
            lines.append(
                f"| **Best aggregation** (§6.1 preview) | "
                f"**{best_label}** @ "
                f"{_fmt_pct(best_agg.get('accuracy'))} | "
                f"mean / hard MAX / softmax MAX scored side-by-side |"
            )
    else:
        lines.append("| clean_win prediction accuracy | - | no eligible matches |")
    lines.append(
        f"| Bootstrap top-{bs.get('top_n', TOP_N)} Jaccard | "
        f"{_fmt_num(bs.get('jaccard_mean'))} (min {_fmt_num(bs.get('jaccard_min'))}) | "
        f"{bs.get('runs', 0)} runs × {bs.get('sample_rate', 0):.0%} resampling |"
    )
    lines.append(
        f"| Bootstrap rating-proxy std (median) | "
        f"{_fmt_num(bs.get('proxy_std_median'), decimals=1)} ELO | "
        f"per-player σ over resamples |"
    )
    lines.append("")

    # Eligibility funnel.
    lines.append("## Winner-anchored metric funnel")
    lines.append("")
    lines.append("| Stage | Count |")
    lines.append("|---|---|")
    lines.append(f"| Rated history entries | {_fmt_int(funnel['rated_history_entries'])} |")
    lines.append(f"| Missing per-match file (skipped) | {_fmt_int(funnel['missing_per_match_file'])} |")
    lines.append(f"| Winner block missing | {_fmt_int(funnel['winner_block_missing'])} |")
    lines.append(f"| `decided_by = clean_win` | **{_fmt_int(funnel['decided_by_clean_win'])}** |")
    lines.append(f"| `decided_by = contested` | {_fmt_int(funnel['decided_by_contested'])} |")
    lines.append(f"| `decided_by = unclear` | {_fmt_int(funnel['decided_by_unclear'])} |")
    lines.append("")

    # §1 — rank correlation.
    lines.append("## §1 — Spearman ρ (R_pre → P_i)")
    lines.append("")
    lines.append("Does the rating predict in-match composite performance? Pooled ρ "
                 "treats every (R_before, P_i) pair as one observation; per-match ρ "
                 "treats each lobby separately and averages -- this controls for "
                 "between-match P_i drift (e.g. easy maps inflate everyone's P_i, "
                 "but rating order should be robust to it).")
    lines.append("")
    lines.append(f"- **Pooled Spearman ρ:** {_fmt_num(rk['pooled_rho'])} "
                 f"(n={_fmt_int(rk['pooled_n_pairs'])} player-matches)")
    lines.append(f"- **Per-match ρ:** mean {_fmt_num(rk['per_match_rho_mean'])}, "
                 f"median {_fmt_num(rk['per_match_rho_median'])}, "
                 f"stdev {_fmt_num(rk['per_match_rho_stdev'])} "
                 f"(across {_fmt_int(rk['per_match_n_runs'])} matches)")
    lines.append("")

    # §2 — calibration.
    lines.append("## §2 — Calibration (R-gap bucketed)")
    lines.append("")
    lines.append("Each player-match gets a ``(R_i − median(R_others_in_match))`` "
                 "value. We bucket by gap (equal-frequency) and compare observed "
                 "mean P_i against predicted mean E_i. A well-calibrated rating "
                 "has residual ≈ 0 in every bucket.")
    lines.append("")
    lines.append("| # | gap min | gap max | gap mean | n | observed mean P_i | predicted mean E_i | residual |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for i, b in enumerate(cal["buckets"], start=1):
        lines.append(
            f"| {i} | {_fmt_num(b['gap_min'], decimals=1)} | "
            f"{_fmt_num(b['gap_max'], decimals=1)} | "
            f"{_fmt_num(b['gap_mean'], decimals=1)} | "
            f"{_fmt_int(b['n'])} | "
            f"{_fmt_num(b['observed_p_mean'])} | "
            f"{_fmt_num(b['predicted_e_mean'])} | "
            f"{_fmt_num(b['residual'])} |"
        )
    lines.append("")
    lines.append(f"**Calibration MAE:** {_fmt_num(cal['calibration_mae'])}")
    lines.append("")

    # §3 — self-consistency.
    lines.append("## §3 — Self-consistency (split-half)")
    lines.append("")
    lines.append("THE ceiling for any rating system reading from the composite. "
                 "If a player's first-half mean P_i doesn't predict their second-half "
                 "mean P_i, no rating layer can fix that.")
    lines.append("")
    lines.append(f"- **Spearman ρ (first-half → second-half):** "
                 f"{_fmt_num(sc['spearman_rho'])}")
    lines.append(f"- Players included: {sc['n_players']} "
                 f"(threshold ≥ {sc['min_matches_threshold']} matches)")
    lines.append(f"- Players excluded (below threshold): {sc['n_excluded_below_floor']}")
    lines.append(f"- Mean |first_half_P − second_half_P|: "
                 f"{_fmt_num(sc['mean_abs_half_diff'])}")
    lines.append("")

    # §4 — bootstrap.
    lines.append("## §4 — Bootstrap stability")
    lines.append("")
    lines.append("Resample {0:.0%} of rated matches without replacement, recompute "
                 "per-player rating-proxy = ``ANCHOR + Σ dr_per_match``. Repeat "
                 "{1} times; report top-N agreement and per-player σ.".format(
                     bs.get("sample_rate", BOOTSTRAP_SAMPLE_RATE),
                     bs.get("runs", 0),
                 ))
    lines.append("")
    lines.append(f"- **Top-{bs.get('top_n', TOP_N)} Jaccard:** "
                 f"mean {_fmt_num(bs.get('jaccard_mean'))}, "
                 f"median {_fmt_num(bs.get('jaccard_median'))}, "
                 f"min {_fmt_num(bs.get('jaccard_min'))}, "
                 f"max {_fmt_num(bs.get('jaccard_max'))}")
    lines.append(f"- **Rating-proxy σ:** "
                 f"median {_fmt_num(bs.get('proxy_std_median'), decimals=1)} ELO, "
                 f"mean {_fmt_num(bs.get('proxy_std_mean'), decimals=1)} ELO, "
                 f"max {_fmt_num(bs.get('proxy_std_max'), decimals=1)} ELO")
    lines.append(f"- Players reported: {bs.get('n_players_with_proxy_std', 0)}")
    lines.append("")
    lines.append("> **Approximation:** rating-proxy = ``ANCHOR + Σ dr_per_match`` over "
                 "the resampled matches. Approximates true re-rating but does NOT "
                 "redo the sequential R_before chain (loss-aversion / floor-taper "
                 "are still embedded in each preserved dr). Phase 2 can promote to "
                 "true sequential re-rating by importing ``compute_elo``.")
    lines.append("")
    lines.append("Detailed per-player rating-proxy σ is in `bootstrap.json`.")
    lines.append("")

    # §5 — synthetic winner.
    lines.append("## §5 — Synthetic-winner proxy")
    lines.append("")
    lines.append("Predict winner = team with higher mean P_i, score against "
                 f"clean_win ground truth. ≥{SYNTHETIC_WINNER_THRESHOLD * 100:.0f}% "
                 "agreement unlocks Phase 2 ALPHA > 0 sweep against the full corpus.")
    lines.append("")
    if syn["n_eligible"]:
        ci = syn["agreement_ci"] or [None, None]
        lines.append(f"- **Eligible matches:** {syn['n_eligible']} (clean_win + both teams represented)")
        lines.append(f"- **Agreements:** {syn['n_agreements']}")
        lines.append(f"- **Agreement rate:** {_fmt_pct(syn['agreement'])} "
                     f"(95% CI {_fmt_pair(ci[0], ci[1])})")
        lines.append(f"- **Threshold:** "
                     f"{'PASSES ✓' if syn['passes_threshold'] else 'FAILS ✗'}")
        if syn["disagreements"]:
            lines.append("")
            lines.append("**Disagreement examples** (sorted by gap, descending):")
            lines.append("")
            lines.append("| match_id | declared winner | predicted winner | team1 mean P_i | team2 mean P_i | gap |")
            lines.append("|---|---|---|---|---|---|")
            for d in syn["disagreements"][:20]:
                lines.append(
                    f"| `{d['match_id']}` | team {d['declared_winner']} | "
                    f"{('team ' + str(d['predicted_winner'])) if d['predicted_winner'] else 'tie'} | "
                    f"{_fmt_num(d['team1_meanP'])} | {_fmt_num(d['team2_meanP'])} | "
                    f"{_fmt_num(d['gap'])} |"
                )
            if len(syn["disagreements"]) > 20:
                lines.append("")
                lines.append(f"> Showing top 20 of {len(syn['disagreements'])} disagreements; "
                             "full list in `report.json`.")
    else:
        lines.append("- No eligible clean_win matches found.")
    lines.append("")

    # §6/§7 — clean_win accuracy + log-loss.
    lines.append("## §6/§7 — clean_win prediction + log-loss")
    lines.append("")
    if cwa.get("n_eligible"):
        ci = cwa["accuracy_ci"] or [None, None]
        lines.append(f"- **Eligible matches:** {cwa['n_eligible']}")
        lines.append(f"- **Correct predictions (mean R):** {cwa['n_correct']}")
        lines.append(f"- **Accuracy (mean R):** {_fmt_pct(cwa['accuracy'])} "
                     f"(95% CI {_fmt_pair(ci[0], ci[1])})")
        lines.append(f"- **Mean log-loss (mean R):** {_fmt_num(cwa['log_loss_mean'])} "
                     f"(coin-flip = {_fmt_num(cwa['log_loss_coin_flip'])})")
        lines.append(f"- **Median log-loss (mean R):** {_fmt_num(cwa['log_loss_median'])}")
        recent = cwa.get("recent") or {}
        if recent.get("n"):
            ci_r = recent.get("accuracy_ci") or [None, None]
            lines.append(
                f"- **Recent form (last {recent['n']}, hard MAX):** "
                f"{_fmt_pct(recent.get('accuracy'))} "
                f"(95% CI {_fmt_pair(ci_r[0], ci_r[1])}, "
                f"since {recent.get('since_date')})"
            )
        lines.append("")
        anchors = cwa["skillbench_anchors"]
        lines.append(
            "**Cambridge skillbench anchor accuracies (CS:GO, win/loss only):** "
            f"WinRate {anchors['winrate_baseline_pct'] * 100:.0f}% · "
            f"Elo {anchors['elo_pct'] * 100:.0f}% · "
            f"Glicko2 {anchors['glicko2_pct'] * 100:.0f}% · "
            f"TrueSkill {anchors['trueskill_pct'] * 100:.1f}% · "
            f"TrueSkillPlayers {anchors['trueskill_players_pct'] * 100:.1f}%."
        )
        lines.append("")

        # v1.1 — MAX-vs-median preview.
        lines.append("### §6.1 — MAX-vs-median preview (Dehpanah-style)")
        lines.append("")
        lines.append(
            "Three team-rating aggregations scored side-by-side on the same "
            f"{cwa['n_eligible']} eligible clean_win matches. Per Dehpanah et al. "
            "2021 (PUBG / LoL / CS:GO 100k+ matches), MAX-style aggregations "
            "should outperform mean for team-threat prediction in tactical "
            f"shooters. Softmax temperature: τ = {cwa['softmax_tau']:.0f}."
        )
        lines.append("")
        lines.append("| Aggregation | Accuracy | 95% CI | Log-loss (mean) | Log-loss (median) |")
        lines.append("|---|---|---|---|---|")
        for agg_name in ("mean", "hard_max", "softmax_max"):
            agg = cwa["aggregations"][agg_name]
            ci_a = agg["accuracy_ci"] or [None, None]
            best_marker = " **(best)**" if agg_name == cwa["best_aggregation"] else ""
            label = {
                "mean":        "team mean R",
                "hard_max":    "team hard MAX R",
                "softmax_max": f"team softmax R (τ={cwa['softmax_tau']:.0f})",
            }[agg_name]
            lines.append(
                f"| {label}{best_marker} | "
                f"{_fmt_pct(agg['accuracy'])} | "
                f"{_fmt_pair(ci_a[0], ci_a[1])} | "
                f"{_fmt_num(agg['log_loss_mean'])} | "
                f"{_fmt_num(agg['log_loss_median'])} |"
            )
        lines.append("")
        # Interpretation guide. NOTE: the update-rule question is SETTLED --
        # Phase 2C's full corpus re-rate under hard MAX / softmax collapsed
        # predictive Spearman rho (0.462 -> 0.188) and inflated mean rating
        # +522 ELO above anchor. `compute_elo` keeps the median opponent
        # reference regardless of what this post-hoc preview shows; see
        # critique/decisions/phase-2c-max-vs-median.md. Any lift below is
        # only actionable for LOBBY-TIME team aggregation (e.g. Tools'
        # Team Balonce team-strength estimate), never for rating updates.
        canonical_acc = cwa["aggregations"]["mean"]["accuracy"] or 0.0
        best_acc = cwa["aggregations"][cwa["best_aggregation"]]["accuracy"] or 0.0
        lift = (best_acc - canonical_acc) * 100
        if cwa["best_aggregation"] != "mean":
            verdict = (
                f"> **Verdict:** `{cwa['best_aggregation']}` beats `mean` by "
                f"{lift:.1f} percentage points as a post-hoc team aggregation. "
                "This is evidence for MAX-style aggregation **at lobby-formation "
                "time only** (Tools Team Balonce, v3 §13.1). The update-rule "
                "question is settled: Phase 2C's full re-rate refuted swapping "
                "`compute_elo`'s median opponent reference (Spearman collapse + "
                "rating inflation; see critique/decisions/phase-2c-max-vs-median.md)."
            )
        else:
            verdict = (
                "> **Verdict:** mean R is at least as good as MAX-style "
                "aggregations on this corpus, so the Phase 2A directional "
                "finding (hard MAX lift) is not reproducing here. No action: "
                "the update rule keeps median regardless (Phase 2C, see "
                "critique/decisions/phase-2c-max-vs-median.md); revisit the "
                "Tools-page aggregation choice if this persists as the "
                "clean_win corpus grows."
            )
        lines.append(verdict)
        lines.append("")

        # v1.1 — commander-presence breakout.
        lines.append("### §6.2 — Commander-presence breakout")
        lines.append("")
        lines.append(
            "Splits clean_win matches into matches where at least one commander "
            "row is on either team's rated lobby vs all-thug matches. Tests "
            "whether v2.4's commander axis-shifts dampen commander R growth, "
            "dragging team mean R artificially low and breaking team-outcome "
            "prediction. Mean-R aggregation only (the v1.1 preview is in §6.1)."
        )
        lines.append("")
        cb = cwa["commander_breakout"]
        lines.append("| Cohort | n | Accuracy | 95% CI | Log-loss (mean) |")
        lines.append("|---|---|---|---|---|")
        for cohort_key, label, n_key in (
            ("with_commander", "with at least one commander", "n_with_commander"),
            ("all_thug",       "all-thug",                    "n_all_thug"),
        ):
            cohort = cb[cohort_key]
            ci_c = cohort["accuracy_ci"] or [None, None]
            lines.append(
                f"| {label} | {cb[n_key]} | "
                f"{_fmt_pct(cohort['accuracy'])} | "
                f"{_fmt_pair(ci_c[0], ci_c[1])} | "
                f"{_fmt_num(cohort['log_loss_mean'])} |"
            )
        lines.append("")
        with_acc = cb["with_commander"]["accuracy"]
        thug_acc = cb["all_thug"]["accuracy"]
        if (
            with_acc is not None and thug_acc is not None
            and cb["n_all_thug"] >= 5
        ):
            cohort_gap = (thug_acc - with_acc) * 100
            if cohort_gap >= 15:
                lines.append(
                    "> **Read:** all-thug matches predict "
                    f"~{cohort_gap:.0f} pp better than commander matches. "
                    "Strong evidence that commander axis-dampening is dragging "
                    "team mean R below the rating's actual predictive power. "
                    "Phase 2C should consider an opt-out of v2.4 axis shifts "
                    "for prediction-side calculations even if they're kept "
                    "on the rating-update side."
                )
            elif abs(cohort_gap) < 5:
                lines.append(
                    "> **Read:** both cohorts predict similarly. Commander "
                    "axis-dampening is NOT the dominant cause of the 43% "
                    "headline. The team-aggregation math (§6.1) is the "
                    "more likely culprit."
                )
            else:
                lines.append(
                    f"> **Read:** {abs(cohort_gap):.0f} pp gap between "
                    "cohorts; signal is suggestive but not decisive at "
                    f"n={cb['n_with_commander']} / n={cb['n_all_thug']}."
                )
        elif cb["n_all_thug"] < 5:
            lines.append(
                f"> **Read:** all-thug subset (n={cb['n_all_thug']}) is too "
                "small to draw conclusions; almost every match in the corpus "
                "has at least one commander."
            )
        lines.append("")

        # v1.1 — rating-gap-magnitude breakout.
        lines.append("### §6.3 — Rating-gap-magnitude breakout")
        lines.append("")
        lines.append(
            "Bucket clean_win matches by ``|team_1_mean_R − team_2_mean_R|``. "
            "Sanity check: large-gap matches SHOULD be highly predictable "
            "if the rating means anything. If small-gap matches are near "
            "50% (random) and large-gap matches climb to 70-80%, that's "
            "actually HEALTHY — the close games are inherently unpredictable. "
            "If all buckets are ~50%, the rating just isn't predictive at "
            "any scale."
        )
        lines.append("")
        rg = cwa["rating_gap_breakout"]
        lines.append("| Bucket | gap (ELO) | n | Accuracy | 95% CI | Log-loss (mean) |")
        lines.append("|---|---|---|---|---|---|")
        for b in rg["buckets"]:
            score = b["score"]
            ci_b = score["accuracy_ci"] or [None, None]
            gap_label = f"[{b['gap_min']:.0f}, "
            gap_label += f"{b['gap_max']:.0f})" if b["gap_max"] is not None else "∞)"
            lines.append(
                f"| {b['bucket']} | {gap_label} | "
                f"{b['n']} | {_fmt_pct(score['accuracy'])} | "
                f"{_fmt_pair(ci_b[0], ci_b[1])} | "
                f"{_fmt_num(score['log_loss_mean'])} |"
            )
        lines.append("")
        # Read: is large-gap accuracy notably higher than small-gap?
        large_bucket = next(
            (b for b in rg["buckets"] if b["bucket"] == "large"), None
        )
        small_bucket = next(
            (b for b in rg["buckets"] if b["bucket"] == "small"), None
        )
        if (
            large_bucket and small_bucket
            and large_bucket["n"] >= 3 and small_bucket["n"] >= 3
            and large_bucket["score"]["accuracy"] is not None
            and small_bucket["score"]["accuracy"] is not None
        ):
            gap_lift = (
                large_bucket["score"]["accuracy"] - small_bucket["score"]["accuracy"]
            ) * 100
            if gap_lift >= 20:
                lines.append(
                    "> **Read:** large-gap matches predict "
                    f"~{gap_lift:.0f} pp better than small-gap matches. "
                    "HEALTHY — the rating IS predictive when gaps are "
                    "meaningful. The 43% headline is dominated by close "
                    "games (which are inherently unpredictable), not by "
                    "a fundamentally broken rating."
                )
            elif gap_lift >= 5:
                lines.append(
                    f"> **Read:** modest {gap_lift:.0f} pp lift on large-gap "
                    "matches; rating is partially predictive but the signal "
                    "is weaker than we'd expect."
                )
            else:
                lines.append(
                    "> **Read:** large-gap matches predict no better than "
                    "small-gap matches. The rating is NOT meaningfully "
                    "predictive at any scale, which points to a deeper "
                    "issue than just the team-aggregation math."
                )
    else:
        lines.append("- " + (cwa.get("skipped_reason") or "no eligible matches"))
    lines.append("")

    # §8 — axis ablation.
    lines.append("## §8 — Single-axis ablation")
    lines.append("")
    lines.append("Drop each axis, renormalize the remaining 5, recompute per-player "
                 "career mean P_i. Compare ranking to baseline. Axes whose removal "
                 "barely moves the ranking are dead weight; axes whose removal "
                 "moves it a lot are load-bearing.")
    lines.append("")
    if abl.get("results"):
        lines.append("| axis dropped | weight | Spearman ρ vs baseline | top-{0} Jaccard | n |".format(
            abl["top_n"]))
        lines.append("|---|---|---|---|---|")
        for r in abl["results"]:
            lines.append(
                f"| `{r['axis_dropped']}` | "
                f"{_fmt_num(r['weight_redirected'], decimals=2)} | "
                f"{_fmt_num(r['spearman_vs_baseline'])} | "
                f"{_fmt_num(r['top_n_jaccard'])} | "
                f"{_fmt_int(r['n_players'])} |"
            )
    else:
        lines.append("- " + (abl.get("skipped_reason") or "no results"))
    lines.append("")
    lines.append("> **Approximation:** ranking is over per-player career mean P_i "
                 "(Phase 1 stand-in for full-rating ranking). Promote to true "
                 "re-rating in Phase 2 if any axis ablation looks marginal.")
    lines.append("")

    # §9 — Dirichlet perturbation.
    lines.append("## §9 — Dirichlet weight perturbation")
    lines.append("")
    lines.append("Sample {0} weight vectors from a Dirichlet centered on the current "
                 "weights with concentration {1}. Recompute mean-P_i ranking each "
                 "time, measure ρ + top-N Jaccard distribution. Detects whether "
                 "we're tuning on a knife edge.".format(
                     dir_p.get("runs", 0), dir_p.get("concentration", 0.0)))
    lines.append("")
    if dir_p.get("rho_mean") is not None:
        lines.append(f"- **ρ distribution:** mean {_fmt_num(dir_p.get('rho_mean'))}, "
                     f"median {_fmt_num(dir_p.get('rho_median'))}, "
                     f"min {_fmt_num(dir_p.get('rho_min'))}, "
                     f"max {_fmt_num(dir_p.get('rho_max'))}, "
                     f"stdev {_fmt_num(dir_p.get('rho_stdev'))}")
        lines.append(f"- **Top-{dir_p.get('top_n', TOP_N)} Jaccard distribution:** "
                     f"mean {_fmt_num(dir_p.get('jaccard_mean'))}, "
                     f"median {_fmt_num(dir_p.get('jaccard_median'))}, "
                     f"min {_fmt_num(dir_p.get('jaccard_min'))}")
    else:
        lines.append("- " + (dir_p.get("skipped_reason") or "no usable runs"))
    lines.append("")

    # §10 — VTSR-C commander-ladder prediction (v1.2).
    vtsr_c = results.get("vtsr_c") or {}
    lines.append("## §10 — VTSR-C commander-ladder prediction + λ ablation")
    lines.append("")
    if vtsr_c.get("available"):
        lines.append(
            "Chronological replay of the VTSR-C ladder predicting each duel's "
            "winner from pre-match state (draws excluded from the accuracy "
            "denominator; E = 0.5 coin-flips earn half credit). The λ ablation "
            "reruns the replay at each handicap weight — the empirical dial "
            "for the team-strength term as the labeled corpus grows.")
        lines.append("")
        lines.append(f"- **Duels:** {_fmt_int(vtsr_c.get('n_duels'))} "
                     f"(scored {_fmt_int(vtsr_c.get('n_scored'))}, "
                     f"draws {_fmt_int(vtsr_c.get('n_draws'))})")
        ci = vtsr_c.get("accuracy_ci") or [None, None]
        lines.append(f"- **Prediction accuracy (canonical λ = "
                     f"{vtsr_c.get('lambda_canonical')}):** "
                     f"{_fmt_pct(vtsr_c.get('accuracy'))} "
                     f"({_fmt_pair(ci[0], ci[1])}), "
                     f"log-loss {_fmt_num(vtsr_c.get('log_loss'))}")
        lines.append(f"- **Replay integrity (max |replay − emitted|):** "
                     f"{_fmt_num(vtsr_c.get('replay_max_abs_diff'), decimals=4)} ELO")
        lines.append("")
        lines.append("| λ | accuracy | 95% CI | log-loss | n |")
        lines.append("|---|---|---|---|---|")
        for row in vtsr_c.get("per_lambda") or []:
            ci_r = row.get("accuracy_ci") or [None, None]
            mark = " **(canonical)**" if row.get("canonical") else ""
            lines.append(f"| {row.get('lambda')}{mark} "
                         f"| {_fmt_pct(row.get('accuracy'))} "
                         f"| {_fmt_pair(ci_r[0], ci_r[1])} "
                         f"| {_fmt_num(row.get('log_loss'))} "
                         f"| {_fmt_int(row.get('n'))} |")
    else:
        lines.append("- " + (vtsr_c.get("skipped_reason") or "unavailable"))
    lines.append("")

    # §11 — Axis-vs-outcome sign agreement (v1.2).
    axis_outcome = results.get("axis_outcome") or {}
    lines.append("## §11 — Axis-vs-outcome sign agreement")
    lines.append("")
    if axis_outcome.get("available"):
        lines.append(
            "For each determined rated match and each axis: team-mean "
            "`axis_contributions` difference (winner minus loser). "
            "Sign agreement = share of matches the axis-leading team won. "
            "This is the empirical check on the THUG_WEIGHTS — the honest "
            "ranking of which axes actually predict winning.")
        lines.append("")
        lines.append(f"- **Determined matches:** "
                     f"{_fmt_int(axis_outcome.get('n_matches_determined'))}")
        lines.append("")
        lines.append("| axis | sign agreement | 95% CI | mean W−L diff | n |")
        lines.append("|---|---|---|---|---|")
        for row in axis_outcome.get("axes") or []:
            ci_r = row.get("sign_agreement_ci") or [None, None]
            lines.append(f"| `{row.get('axis')}` "
                         f"| {_fmt_pct(row.get('sign_agreement'))} "
                         f"| {_fmt_pair(ci_r[0], ci_r[1])} "
                         f"| {_fmt_num(row.get('mean_winner_minus_loser'), decimals=4)} "
                         f"| {_fmt_int(row.get('n'))} |")
    else:
        lines.append("- " + (axis_outcome.get("skipped_reason") or "unavailable"))
    lines.append("")

    # §12 — VTSR-C econ-axis sign agreement (v1.3).
    perf = results.get("vtsr_c_perf") or {}
    econ_axes = perf.get("econ_axes") or {}
    lines.append("## §12 — VTSR-C econ-axis vs duel-outcome sign agreement")
    lines.append("")
    if econ_axes.get("available"):
        lines.append(
            "Mirror of §11 for the VTSR-C economy composite: per axis, "
            "the share of telemetry duels the axis-leading commander won. "
            "This is a direction check on the discovery sample. It is not "
            "sufficient to score the axes. The promote rule is §12b.")
        lines.append("")
        lines.append(f"- **Telemetry duels:** "
                     f"{_fmt_int(econ_axes.get('n_telemetry_duels'))} "
                     f"(scored {_fmt_int(econ_axes.get('n_scored'))})")
        lines.append("")
        lines.append("| axis | sign agreement | 95% CI | mean W−L diff | n |")
        lines.append("|---|---|---|---|---|")
        for row in econ_axes.get("axes") or []:
            ci_r = row.get("sign_agreement_ci") or [None, None]
            lines.append(f"| `{row.get('axis')}` "
                         f"| {_fmt_pct(row.get('sign_agreement'))} "
                         f"| {_fmt_pair(ci_r[0], ci_r[1])} "
                         f"| {_fmt_num(row.get('mean_winner_minus_loser'), decimals=4)} "
                         f"| {_fmt_int(row.get('n'))} |")
    else:
        lines.append("- " + (econ_axes.get("skipped_reason") or "unavailable"))
    lines.append("")

    promote = perf.get("promote") or {}
    lines.append("## §12b — VTSR-C promote rule (confirmation sample)")
    lines.append("")
    if promote.get("available"):
        lines.append(
            f"Verdict: **{promote.get('verdict')}**. "
            "Confirmation duels are dated after "
            f"{promote.get('amended_on')}. "
            f"{promote.get('note') or ''}")
        lines.append("")
        lines.append(
            f"- Confirmation duels: {_fmt_int(promote.get('n_confirmation'))} "
            f"(need {_fmt_int(promote.get('n_confirmation_required'))})")
        for reason in promote.get("reasons") or []:
            lines.append(f"- {reason}")
    else:
        lines.append("- " + (promote.get("skipped_reason") or "unavailable"))
    lines.append("")

    legacy = perf.get("legacy_early_full") or {}
    lines.append("## §12c — Retired formulas, early vs full match")
    lines.append("")
    if legacy.get("available"):
        lines.append(legacy.get("note") or "")
        lines.append("")
        lines.append("| formula | full-match agreement | opening agreement | lagging |")
        lines.append("|---|---|---|---|")
        for row in legacy.get("axes") or []:
            full_a = (row.get("full") or {}).get("sign_agreement")
            early_a = (row.get("early") or {}).get("sign_agreement")
            lines.append(
                f"| `{row.get('axis')}` | {_fmt_pct(full_a)} | "
                f"{_fmt_pct(early_a)} | {row.get('lagging')} |")
    else:
        lines.append("- " + (legacy.get("skipped_reason") or "unavailable"))
    lines.append("")

    # §13 — VTSR-C alpha_c ablation (v1.3).
    alpha_abl = perf.get("alpha_ablation") or {}
    lines.append("## §13 — VTSR-C α_c ablation")
    lines.append("")
    if alpha_abl.get("available"):
        lines.append(
            "Ladder replay at each α_c, blending the economy composite "
            "into the update score on telemetry duels only "
            "(S' = α_c·S + (1−α_c)·(P+1)/2; fallback duels stay "
            "outcome-pure per the ratified policy). Accuracy/log-loss "
            "counted on non-draw TELEMETRY duels so the comparison is "
            "never diluted by fallback rows. This table is the discovery "
            "sample. The promote gate scores the confirmation sample only "
            "(§12b) and requires log-loss to improve by at least 0.01. "
            "The α_c = 1.0 row must reproduce the emitted ladder "
            "(integrity column).")
        lines.append("")
        lines.append(f"- **Telemetry duels:** "
                     f"{_fmt_int(alpha_abl.get('n_telemetry_duels'))} of "
                     f"{_fmt_int(alpha_abl.get('n_duels'))} total "
                     f"(scored {_fmt_int(alpha_abl.get('n_telemetry_scored'))})")
        lines.append(f"- **Replay integrity (α_c = 1.0, max |replay − emitted|):** "
                     f"{_fmt_num(alpha_abl.get('replay_max_abs_diff'), decimals=4)} ELO")
        lines.append("")
        lines.append("| α_c | accuracy (telemetry) | 95% CI | log-loss | n |")
        lines.append("|---|---|---|---|---|")
        for row in alpha_abl.get("per_alpha") or []:
            ci_r = row.get("accuracy_ci") or [None, None]
            mark = " **(canonical)**" if row.get("canonical") else ""
            lines.append(f"| {row.get('alpha_c')}{mark} "
                         f"| {_fmt_pct(row.get('accuracy'))} "
                         f"| {_fmt_pair(ci_r[0], ci_r[1])} "
                         f"| {_fmt_num(row.get('log_loss'))} "
                         f"| {_fmt_int(row.get('n_telemetry_scored'))} |")
    else:
        lines.append("- " + (alpha_abl.get("skipped_reason") or "unavailable"))
    lines.append("")

    # §14 — Balonce Meter T-term ablation (v1.4).
    t_term = results.get("cmdr_t_term") or {}
    lines.append("## §14 — Balonce Meter T-term ablation")
    lines.append("")
    if t_term.get("available"):
        lines.append(
            "Pre-registered in "
            f"`{t_term.get('memo')}` — read the memo before touching the "
            "grids. Each variant replays the FULL duel stream under its own "
            "T rule, but is SCORED only on telemetry duels carrying the "
            "per-player detail the variants need; canonical is re-scored on "
            "that identical subset, so every comparison is same-rows.")
        lines.append("")
        lines.append(f"- **Scoreable telemetry duels:** "
                     f"{_fmt_int(t_term.get('n_scoreable_telemetry'))} of "
                     f"{_fmt_int(t_term.get('n_duels_total'))} total")
        lines.append(f"- **Verdict:** **{t_term.get('verdict')}**"
                     + (f" — {', '.join(t_term.get('promote_eligible') or [])}"
                        if t_term.get("promote_eligible") else ""))
        lines.append("")
        lines.append("| variant | accuracy | Δacc | log-loss | Δll | n | promote |")
        lines.append("|---|---|---|---|---|---|---|")
        for row in t_term.get("variants") or []:
            pro = row.get("promote") or {}
            if pro.get("reason") == "baseline":
                note = "baseline"
            elif pro.get("eligible"):
                note = "**ELIGIBLE**"
            else:
                note = "; ".join(pro.get("failed_conditions") or []) or "—"
            lines.append(
                f"| `{row.get('variant')}` "
                f"| {_fmt_pct(row.get('accuracy'))} "
                f"| {_fmt_num(pro.get('delta_accuracy'), decimals=4)} "
                f"| {_fmt_num(row.get('log_loss'))} "
                f"| {_fmt_num(pro.get('delta_log_loss'), decimals=4)} "
                f"| {_fmt_int(row.get('n_scored'))} "
                f"| {note} |")
        lines.append("")
        lines.append("**Q2 (diagnostic only — no promote rule): even vs "
                     "uneven rated-row counts, canonical T rule.**")
        lines.append("")
        base_row = (t_term.get("variants") or [{}])[0]
        shape = base_row.get("per_lobby_shape") or {}
        lines.append("| lobby shape | accuracy | n |")
        lines.append("|---|---|---|")
        for key in ("even", "uneven"):
            row = shape.get(key) or {}
            lines.append(f"| {key} | {_fmt_pct(row.get('accuracy'))} "
                         f"| {_fmt_int(row.get('n'))} |")
    else:
        lines.append("- " + (t_term.get("skipped_reason") or "unavailable"))
    lines.append("")

    # ------------------------------------------------------------------
    # v1.7 (critique v4) diagnostic sections §15-§19. Descriptive only:
    # nothing here changes a rating or feeds validation_summary.json.
    # ------------------------------------------------------------------
    pvw = results.get("perf_vs_wins") or {}
    lines.append("## §15 — Performance ladder vs wins ladder (v1.7)")
    lines.append("")
    if pvw.get("available"):
        lines.append(
            "Per-player agreement between the published composite rating "
            "(`thug_elo`) and the inert win/loss ladder (`wins_elo`, Stage E "
            "R^W). `gap = thug_elo − wins_elo`: positive means the composite "
            "rates the player above what their team results do. Descriptive "
            "— neither ladder is the ground truth of the other.")
        lines.append("")
        lines.append(f"- **Players (≥ {pvw['min_matches']} matches):** {pvw['n_players']}")
        lines.append(f"- **Spearman(thug_elo, wins_elo):** {_fmt_num(pvw.get('spearman'))}; "
                     f"Pearson {_fmt_num(pvw.get('pearson'))}")
        lines.append(f"- **Gap:** mean {_fmt_num(pvw.get('gap_mean'), 1)}, "
                     f"stdev {_fmt_num(pvw.get('gap_stdev'), 1)}, "
                     f"range {_fmt_num(pvw.get('gap_min'), 0)} to {_fmt_num(pvw.get('gap_max'), 0)}")
        lines.append(f"- **Pearson(commander share, gap):** "
                     f"{_fmt_num(pvw.get('pearson_gap_vs_commander_share'))}")
        lines.append("")
        lines.append("| player | thug_elo | wins_elo | gap | cmdr share | matches | W-L |")
        lines.append("|---|---|---|---|---|---|---|")
        for p in pvw.get("players") or []:
            rec = p.get("wins_record") or {}
            lines.append(
                f"| {p.get('name')} | {_fmt_num(p.get('thug_elo'), 0)} "
                f"| {_fmt_num(p.get('wins_elo'), 0)} | {p.get('gap'):+.0f} "
                f"| {_fmt_pct(p.get('commander_share'), 0)} | {p.get('matches_played')} "
                f"| {rec.get('w', '-')}-{rec.get('l', '-')} |")
    else:
        lines.append("- " + (pvw.get("skipped_reason") or "unavailable"))
    lines.append("")

    tod = results.get("team_outcome_dependence") or {}
    lines.append("## §16 — Team-outcome dependence of thug P_i (v1.7)")
    lines.append("")
    if tod.get("available"):
        lines.append(
            "P_i is lobby-relative, so a thug on the losing side tends to "
            "score below zero whatever they personally did. This measures how "
            "much of a thug's rating movement is the team result.")
        lines.append("")
        lines.append("| cohort | n win / n loss | mean P win / loss | mean Δ win / loss "
                     "| winners with Δ<0 | losers with Δ>0 | η² (P by outcome) |")
        lines.append("|---|---|---|---|---|---|---|")
        for label, blk in (("all thugs", tod.get("thugs") or {}),
                           (f"thugs rated ≥ {HIGH_RATED_THRESHOLD:.0f}", tod.get("high_rated_thugs") or {}),
                           ("commanders", tod.get("commanders") or {})):
            if not blk or not blk.get("n_winners") and not blk.get("n_losers"):
                continue
            lines.append(
                f"| {label} | {blk.get('n_winners')} / {blk.get('n_losers')} "
                f"| {_fmt_num(blk.get('winner_mean_p'))} / {_fmt_num(blk.get('loser_mean_p'))} "
                f"| {_fmt_num(blk.get('winner_mean_delta'), 2)} / {_fmt_num(blk.get('loser_mean_delta'), 2)} "
                f"| {_fmt_pct(blk.get('winners_negative_delta_share'))} "
                f"| {_fmt_pct(blk.get('losers_positive_delta_share'))} "
                f"| {_fmt_num(blk.get('eta_squared_p'))} |")
    else:
        lines.append("- " + (tod.get("skipped_reason") or "unavailable"))
    lines.append("")

    sd = results.get("ship_denial") or {}
    lines.append("## §17 — Ship-denial gradient (v1.7)")
    lines.append("")
    if sd.get("available"):
        lines.append(
            "Thug rows banded by `at_base_pilot_share` (share of the match on "
            "foot inside their own base — waiting for a ship). **Confound:** "
            "ships go unreplaced more often on losing teams, so the gradient "
            "mixes commander supply with team outcome; the per-outcome columns "
            "show what survives inside a fixed result.")
        lines.append("")
        lines.append(f"- **Rows:** {sd.get('n_rows')}; Spearman(share, Δ) "
                     f"{_fmt_num(sd.get('spearman_share_vs_delta'))}; Spearman(share, P) "
                     f"{_fmt_num(sd.get('spearman_share_vs_p'))}")
        lines.append("")
        lines.append("| at-base share | n | mean Δ | mean P | mean pre-R | team win share "
                     "| Δ when won (n) | Δ when lost (n) |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for b in sd.get("bands") or []:
            if not b.get("n"):
                lines.append(f"| {b['band']} | 0 | - | - | - | - | - | - |")
                continue
            w = b.get("winners") or {}
            l = b.get("losers") or {}
            lines.append(
                f"| {b['band']} | {b['n']} | {_fmt_num(b.get('mean_delta'), 2)} "
                f"| {_fmt_num(b.get('mean_p'))} | {_fmt_num(b.get('mean_before'), 0)} "
                f"| {_fmt_pct(b.get('win_share'))} "
                f"| {_fmt_num(w.get('mean_delta'), 2)} ({w.get('n')}) "
                f"| {_fmt_num(l.get('mean_delta'), 2)} ({l.get('n')}) |")
    else:
        lines.append("- " + (sd.get("skipped_reason") or "unavailable"))
    lines.append("")

    cs = results.get("commander_selection") or {}
    lines.append("## §18 — Commander selection + role-adjustment audit (v1.7)")
    lines.append("")
    if cs.get("available"):
        lines.append(
            "Who commands (pre-match VTSR-T percentile inside their own lobby, "
            "0 = highest), how concentrated the job is, and what commanding "
            "does to a rating relative to thugging (the v2.4 axis-shift audit).")
        lines.append("")
        lines.append(f"- **Commander rows:** {cs.get('n_commander_rows')} "
                     f"({cs.get('distinct_commanders')} distinct commanders; top-4 hold "
                     f"{_fmt_pct(cs.get('top4_commander_row_share'))} of rows)")
        lines.append(f"- **Commander lobby percentile (0 = top):** mean "
                     f"{_fmt_num(cs.get('commander_percentile_mean'))}, median "
                     f"{_fmt_num(cs.get('commander_percentile_median'))}")
        lines.append(f"- **Commander below own thug mean:** "
                     f"{_fmt_pct(cs.get('commander_below_own_thug_mean_share'))} of "
                     f"{cs.get('team_sides_with_both_roles')} team-sides")
        lines.append(f"- **Cohort mean Δ per row:** commanders "
                     f"{_fmt_num(cs.get('cohort_mean_delta_commander'), 2)} vs thugs "
                     f"{_fmt_num(cs.get('cohort_mean_delta_thug'), 2)}")
        lines.append("")
        lines.append("| commander | rows |")
        lines.append("|---|---|")
        for t in cs.get("top_commanders") or []:
            lines.append(f"| {t['name']} | {t['rows']} |")
        lines.append("")
        lines.append(f"Per-player mean Δ as commander vs as thug (≥ "
                     f"{cs.get('min_rows_per_role')} rows in both roles):")
        lines.append("")
        lines.append("| player | Δ as cmdr (n) | Δ as thug (n) |")
        lines.append("|---|---|---|")
        for p in cs.get("per_player") or []:
            lines.append(f"| {p['name']} | {p['mean_delta_commander']:+.2f} ({p['n_commander']}) "
                         f"| {p['mean_delta_thug']:+.2f} ({p['n_thug']}) |")
    else:
        lines.append("- " + (cs.get("skipped_reason") or "unavailable"))
    lines.append("")

    fe = results.get("faction_effect") or {}
    lines.append("## §19 — Faction effect, controlling for the ratings (v1.7)")
    lines.append("")
    if fe.get("available"):
        lines.append(
            "Offset logistic regression on the VTSR-C duel stream: logit of "
            "the canonical expected score (commander gap + λ·thug handicap) is "
            "held fixed as the offset; two faction contrasts (Hadean-vs-ISDF, "
            "Scion-vs-ISDF, coded +1/−1/0 by side) are fitted on top. Rating "
            "points = coefficient × scale / ln 10. The full-corpus fit is the "
            "DISCOVERY sample for `critique/decisions/phase-6-faction-advantage-term.md`; "
            "only the confirmation fit (duels dated after "
            f"{fe.get('discovery_cutoff')}) can ever promote the term.")
        lines.append("")
        lines.append(f"- **Duels with both factions known:** {fe.get('n_duels_with_factions')} "
                     f"(telemetry {fe.get('n_telemetry')}, F9 {fe.get('n_f9')}; mirrors "
                     f"{fe.get('n_mirror')}; missing faction {fe.get('n_missing_faction')}; "
                     f"draws skipped {fe.get('n_draws_skipped')})")
        lines.append("")
        lines.append("| faction | team-sides | wins | win rate | mean pre-duel VTSR-C of its commanders |")
        lines.append("|---|---|---|---|---|")
        cb = fe.get("commander_vtsr_c_before_by_faction") or {}
        for fname, pk in (fe.get("picks") or {}).items():
            lines.append(f"| {fname} | {pk.get('picks')} | {pk.get('wins')} "
                         f"| {_fmt_pct(pk.get('win_rate'))} "
                         f"| {_fmt_num((cb.get(fname) or {}).get('mean'), 1)} (n={(cb.get(fname) or {}).get('n')}) |")
        lines.append("")
        lines.append("| matchup (non-mirror) | n | A wins | B wins | A win rate | 95% CI |")
        lines.append("|---|---|---|---|---|---|")
        for m in fe.get("matchups") or []:
            ci = m.get("rate_a_ci") or [None, None]
            lines.append(f"| {m['faction_a_name']} vs {m['faction_b_name']} | {m['n']} "
                         f"| {m['wins_a']} | {m['wins_b']} | {_fmt_pct(m['rate_a'])} "
                         f"| {_fmt_pair(ci[0], ci[1])} |")
        lines.append("")
        lines.append("| sample | n (non-mirror) | Hadean vs ISDF (logit ± SE, z, p) | ≈ pts "
                     "| Scion vs ISDF (logit ± SE, z, p) | ≈ pts | LR χ² (p) "
                     "| log-loss base → faction | acc base → faction |")
        lines.append("|---|---|---|---|---|---|---|---|---|")
        for label in ("all", "telemetry", "f9", "confirmation"):
            f = (fe.get("fits") or {}).get(label) or {}
            if not f.get("fitted"):
                lines.append(f"| {label} | {f.get('n', 0)} | not fitted — "
                             f"{f.get('skipped_reason', 'n/a')} | | | | | | |")
                continue
            lines.append(
                f"| {label} | {f['n']} "
                f"| {f['coef_hadean_vs_isdf']:+.3f} ± {f['se_hadean_vs_isdf']:.3f}, "
                f"z {_fmt_num(f.get('z_hadean_vs_isdf'), 2)}, p {_fmt_num(f.get('p_hadean_vs_isdf'))} "
                f"| {f['rating_points_hadean_vs_isdf']:+.0f} "
                f"| {f['coef_scion_vs_isdf']:+.3f} ± {f['se_scion_vs_isdf']:.3f}, "
                f"z {_fmt_num(f.get('z_scion_vs_isdf'), 2)}, p {_fmt_num(f.get('p_scion_vs_isdf'))} "
                f"| {f['rating_points_scion_vs_isdf']:+.0f} "
                f"| {_fmt_num(f.get('lr_chi2_2df'), 2)} ({_fmt_num(f.get('lr_p_value'))}) "
                f"| {_fmt_num(f.get('log_loss_baseline'), 4)} → {_fmt_num(f.get('log_loss_with_faction'), 4)} "
                f"| {_fmt_pct(f.get('accuracy_baseline'))} → {_fmt_pct(f.get('accuracy_with_faction'))} |")
        lines.append("")
        pro = fe.get("promote") or {}
        lines.append(f"**Frozen candidate term** (memo `{pro.get('memo')}`): "
                     f"{pro.get('frozen_points')} rating points to the side fielding the "
                     "faction, applied WITHOUT refit. Out-of-sample read per sample:")
        lines.append("")
        lines.append("| sample | n | log-loss base → frozen (Δ) | accuracy base → frozen (Δ) |")
        lines.append("|---|---|---|---|")
        for label in ("all", "telemetry", "f9", "confirmation"):
            f = (fe.get("fits") or {}).get(label) or {}
            ft = f.get("frozen_term") or {}
            if not f.get("fitted"):
                lines.append(f"| {label} | {f.get('n', 0)} | - | - |")
                continue
            lines.append(
                f"| {label} | {f['n']} "
                f"| {_fmt_num(f.get('log_loss_baseline'), 4)} → {_fmt_num(ft.get('log_loss'), 4)} "
                f"({ft.get('log_loss_delta_vs_baseline', 0.0):+.4f}) "
                f"| {_fmt_pct(f.get('accuracy_baseline'))} → {_fmt_pct(ft.get('accuracy'))} "
                f"({ft.get('accuracy_delta_vs_baseline', 0.0) * 100:+.1f}pp) |")
        lines.append("")
        lines.append(f"- **Promote verdict (confirmation sample only):** **{pro.get('verdict')}**"
                     + (f" — {'; '.join(pro.get('reasons') or [])}" if pro.get("reasons") else ""))
        lines.append("")
        lines.append("Hadean share of team-sides by month:")
        lines.append("")
        lines.append("| month | sides | Hadean share |")
        lines.append("|---|---|---|")
        for mrow in fe.get("hadean_share_by_month") or []:
            lines.append(f"| {mrow['month']} | {mrow['sides']} | {_fmt_pct(mrow['hadean_share'], 0)} |")
    else:
        lines.append("- " + (fe.get("skipped_reason") or "unavailable"))
    lines.append("")

    fg = results.get("format_gate") or {}
    lines.append("## §20 — The format gate: what the size exclusion leaves out (v1.8)")
    lines.append("")
    if fg.get("available"):
        prof = fg.get("profile") or {}
        dyn = fg.get("dynamics") or {}
        tr = fg.get("transfer") or {}
        lines.append(
            "Every excluded history entry by reason and team shape, the "
            f"small-format (≤ {fg.get('small_max_per_side')} per side) games' "
            "dynamics against the rated full-format games, and whether the "
            "published ratings would have predicted the small-format winners. "
            + fg.get("degeneracy_note", ""))
        lines.append("")
        lines.append(f"- **Excluded entries:** {prof.get('n_excluded_entries')} — by reason: "
                     + ", ".join(f"{k} {v}" for k, v in (prof.get("by_reason") or {}).items()))
        lines.append("- **By shape (non-campod rows per side):** "
                     + ", ".join(f"{k} ×{v}" for k, v in (prof.get("by_shape") or {}).items()))
        lines.append(f"- **Small-format games:** {prof.get('n_small_format')} "
                     f"({prof.get('n_small_format_uneven')} uneven; "
                     f"{prof.get('n_small_format_determined')} with a determined winner); by month: "
                     + ", ".join(f"{k} {v}" for k, v in (prof.get("small_format_by_month") or {}).items()))
        lines.append("")
        lines.append(f"| metric (games ≥ {fg.get('min_duration_sec'):.0f} s) | small format | rated full format |")
        lines.append("|---|---|---|")
        s = dyn.get("small_format") or {}
        f = dyn.get("rated_full_format") or {}
        for label, key, dec in (("matches", "n_matches", 0), ("player rows", "n_rows", 0),
                                ("duration (s, median)", "duration_sec_median", 0),
                                ("kills per player-minute (median)", "kills_per_player_min_median", 2),
                                ("deaths per player-minute (median)", "deaths_per_player_min_median", 2),
                                ("damage per player-minute (median)", "damage_per_player_min_median", 0),
                                ("PvE share of damage (median)", "pve_share_median", 2),
                                ("peak pools per team (median)", "peak_pools_median", 1)):
            sv, fv = s.get(key), f.get(key)
            fmt = (lambda v: _fmt_int(v)) if dec == 0 and key.startswith("n_") else (lambda v: _fmt_num(v, dec))
            lines.append(f"| {label} | {fmt(sv)} | {fmt(fv)} |")
        lines.append("")
        tt = tr.get("vtsr_t_team_mean") or {}
        tc = tr.get("vtsr_c_leader_gap") or {}
        ci_t = tt.get("accuracy_ci") or [None, None]
        ci_c = tc.get("accuracy_ci") or [None, None]
        lines.append(f"**Transfer test** ({tr.get('n_determined')} determined small-format games; "
                     "pre-match ratings reconstructed from the rated history):")
        lines.append("")
        lines.append("| predictor | picks | correct | accuracy | 95% CI |")
        lines.append("|---|---|---|---|---|")
        lines.append(f"| higher team-mean VTSR-T | {tt.get('n')} | {tt.get('correct')} "
                     f"| {_fmt_pct(tt.get('accuracy'))} | {_fmt_pair(ci_t[0], ci_t[1])} |")
        lines.append(f"| higher leader VTSR-C | {tc.get('n')} | {tc.get('correct')} "
                     f"| {_fmt_pct(tc.get('accuracy'))} | {_fmt_pair(ci_c[0], ci_c[1])} |")
        lines.append("")
        lines.append("| date | shape | winner | team-mean VTSR-T (1 / 2) | leader VTSR-C (1 / 2) | T pick | C pick | sides |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for r in tr.get("rows") or []:
            tm = r.get("team_mean_vtsr_t") or {}
            lc = r.get("leader_vtsr_c") or {}
            mark = lambda v: ("✓" if v is True else ("✗" if v is False else "tie"))  # noqa: E731
            lines.append(
                f"| {r.get('date')} | {r.get('shape')}{' (uneven)' if r.get('uneven') else ''} "
                f"| {r.get('winner_side')} | {_fmt_num(tm.get(1), 0)} / {_fmt_num(tm.get(2), 0)} "
                f"| {_fmt_num(lc.get(1), 0)} / {_fmt_num(lc.get(2), 0)} "
                f"| {mark(r.get('vtsr_t_pick_correct'))} | {mark(r.get('vtsr_c_pick_correct'))} "
                f"| {', '.join(str(n) for n in (r.get('names') or {}).get(1, []))} vs "
                f"{', '.join(str(n) for n in (r.get('names') or {}).get(2, []))} |")
    else:
        lines.append("- " + (fg.get("skipped_reason") or "unavailable"))
    lines.append("")

    # Active weights footer.
    lines.append("## Active weights")
    lines.append("")
    lines.append("| axis | weight |")
    lines.append("|---|---|")
    for a, w in weights.items():
        lines.append(f"| `{a}` | {w:.3f} |")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("Source data:")
    lines.append("")
    lines.append(f"- `{meta['paths']['elo_current']}`")
    lines.append(f"- `{meta['paths']['elo_history']}`")
    lines.append(f"- `{meta['paths']['matches']}`")
    lines.append(f"- `{meta['paths']['per_match_dir']}/<id>.json`")
    lines.append("")
    return "\n".join(lines) + "\n"


def render_json_report(
    results: dict[str, Any],
    weights: dict[str, float],
) -> dict[str, Any]:
    """Machine-readable mirror of the markdown report. Keeps the same
    metric names + structure so option B can promote this verbatim into
    a dashboard surface later.

    schema_version 2 (v1.1, Phase 2A): adds ``aggregations`` /
    ``best_aggregation`` / ``softmax_tau`` / ``commander_breakout`` /
    ``rating_gap_breakout`` sub-blocks under ``clean_win_accuracy``.
    schema_version 3 (v1.2, VTSR-C): adds top-level ``vtsr_c``
    (commander-ladder prediction + lambda ablation) and ``axis_outcome``
    (per-axis sign-agreement study) blocks. Strictly additive; existing
    v1/v2 readers see the legacy fields unchanged.
    schema_version 4 (v1.3, VTSR-C v2): adds top-level ``vtsr_c_perf``
    (``econ_axes`` sign-agreement study #12 + ``alpha_ablation`` #13).
    Strictly additive; existing v1/v2/v3 readers unaffected.
    schema_version 5 (v1.4, Balonce Meter): adds top-level
    ``cmdr_t_term`` (T-term ablation #14, pre-registered in
    ``critique/decisions/balonce-meter-t-term.md``). Strictly additive.
    schema_version 6 (v1.5, explainer telemetry): adds
    ``clean_win_accuracy.recent`` (last-30 determined window) and
    ``clean_win_accuracy.accuracy_timeline``, plus
    ``winner_funnel.recent``. Strictly additive.
    schema_version 7 (v1.6, VTSR-C opening semantics): adds
    ``vtsr_c_perf.promote`` and ``vtsr_c_perf.legacy_early_full``.
    Strictly additive.
    schema_version 8 (v1.7, critique v4 diagnostics): adds top-level
    ``perf_vs_wins`` (#15), ``team_outcome_dependence`` (#16),
    ``ship_denial`` (#17), ``commander_selection`` (#18) and
    ``faction_effect`` (#19). Strictly additive; none of them feeds
    validation_summary.json.
    schema_version 9 (v1.8, format gate): adds top-level ``format_gate``
    (#20 -- excluded-match profile, small-vs-full dynamics, rating
    transfer test). Strictly additive; not in validation_summary.json.
    """
    return {
        "schema_version":   9,
        "validator_version": VALIDATOR_VERSION,
        "weights":          weights,
        **results,
    }


def render_bootstrap_artifact(bootstrap: dict[str, Any]) -> dict[str, Any]:
    """Detailed bootstrap output (per-player std distribution). Lives in
    its own file because it's bulkier than the headline summary.

    schema_version unchanged from v1; payload shape is identical. The
    version bump on the parent report.json is purely additive.
    """
    return {
        "schema_version":  1,
        "validator_version": VALIDATOR_VERSION,
        "summary": {
            k: v for k, v in bootstrap.items()
            if k != "per_player"
        },
        "per_player": bootstrap.get("per_player") or {},
    }


# ---------------------------------------------------------------------------
# Committed validation summary (data/processed/validation_summary.json)
# ---------------------------------------------------------------------------

# Drift thresholds for the per-run warning. A drop bigger than these vs the
# previous history entry prints a loud WARNING on the pipeline console.
# Tunable without any schema bump.
DRIFT_WARN_RHO_DROP = 0.03        # pooled Spearman rho
DRIFT_WARN_CLEANWIN_DROP = 0.05   # clean_win mean-R accuracy (5pp)

VALIDATION_SUMMARY_NAME = "validation_summary.json"
VALIDATION_SUMMARY_SCHEMA_VERSION = 1
VALIDATION_HISTORY_MAX_ENTRIES = 200


def _summary_history_entry(results: dict) -> dict:
    """One compact history row from a full validator ``results`` dict.

    Floats are kept at full precision -- the dedupe rule below relies on
    exact equality of deterministic outputs (same corpus + same seed =>
    byte-identical metrics).
    """
    meta = results.get("meta") or {}
    rank = results.get("rank_correlation") or {}
    selfc = results.get("self_consistency") or {}
    calib = results.get("calibration") or {}
    boot = results.get("bootstrap") or {}
    synth = results.get("synthetic_winner") or {}
    cwa = results.get("clean_win_accuracy") or {}
    aggs = cwa.get("aggregations") or {}

    def _agg_acc(name: str):
        a = aggs.get(name) or {}
        return a.get("accuracy")

    return {
        "generated_at":               meta.get("generated_at"),
        "elo_schema_version":         meta.get("elo_schema_version"),
        "rated_match_count":          meta.get("rated_match_count"),
        "players_total":              meta.get("players_total"),
        "spearman_pooled_rho":        rank.get("pooled_rho"),
        "per_match_rho_mean":         rank.get("per_match_rho_mean"),
        "self_consistency_rho":       selfc.get("spearman_rho"),
        "calibration_mae":            calib.get("calibration_mae"),
        "bootstrap_proxy_std_median": boot.get("proxy_std_median"),
        "bootstrap_jaccard_mean":     boot.get("jaccard_mean"),
        "synthetic_winner_agreement": synth.get("agreement"),
        "synthetic_winner_n":         synth.get("n_eligible"),
        "clean_win_n":                cwa.get("n_eligible"),
        "clean_win_accuracy_mean":    cwa.get("accuracy"),
        "clean_win_accuracy_hard_max": _agg_acc("hard_max"),
        "clean_win_accuracy_softmax":  _agg_acc("softmax_max"),
        "log_loss_mean":              cwa.get("log_loss_mean"),
        # v1.2: VTSR-C headline trend (canonical lambda).
        "vtsr_c_n":                   (results.get("vtsr_c") or {}).get("n_scored"),
        "vtsr_c_accuracy":            (results.get("vtsr_c") or {}).get("accuracy"),
        "vtsr_c_log_loss":            (results.get("vtsr_c") or {}).get("log_loss"),
        # v1.5: recent-form hard-max window + pool drift. Absent on
        # history rows written before this validator version.
        "clean_win_accuracy_recent":  cwa.get("recent"),
        "mean_vtsr":                  meta.get("mean_vtsr"),
        "rating_spread_std":          meta.get("rating_spread_std"),
    }


def _same_corpus_state(a: dict, b: dict) -> bool:
    """True when two history entries describe the same corpus + algorithm state.

    ``elo_current.json``'s ``computed_at`` changes on every pipeline run even
    with zero new matches (compute_elo always re-stamps), so dedupe keys on
    substance instead: rated count, elo schema, and the (deterministic,
    fixed-seed) pooled rho. Identical corpus + identical algorithm =>
    identical metrics => replace-in-place rather than append.
    """
    return (
        a.get("rated_match_count") == b.get("rated_match_count")
        and a.get("elo_schema_version") == b.get("elo_schema_version")
        and a.get("spearman_pooled_rho") == b.get("spearman_pooled_rho")
    )


def write_validation_summary(results: dict, processed_dir: Path) -> Path:
    """Write/update the committed headline-metrics summary + history.

    Unlike the gitignored ``_validation/`` artifacts, this file lives in
    ``data/processed/`` and IS committed: it powers the dashboard's
    noise-floor UI (bootstrap sigma) and gives every future re-rate
    decision a per-run metric time-series to diff against (improvement #2
    of the fable analysis). Default elo-mode only -- alt modes never touch
    this file.

    History contract: one entry per distinct corpus/algorithm state
    (see ``_same_corpus_state``); re-runs without new matches replace the
    last entry in place. Capped FIFO at VALIDATION_HISTORY_MAX_ENTRIES.
    """
    out_path = processed_dir / VALIDATION_SUMMARY_NAME

    prev_history: list[dict] = []
    if out_path.exists():
        try:
            prev = _load_json(out_path)
            prev_history = list(prev.get("history") or [])
        except Exception as exc:
            print(f"[validate_elo] WARN: could not read existing "
                  f"{VALIDATION_SUMMARY_NAME} ({exc}); starting fresh history")

    entry = _summary_history_entry(results)

    if prev_history and _same_corpus_state(prev_history[-1], entry):
        prev_history[-1] = entry  # refresh in place (no-new-matches rerun)
    else:
        prev_history.append(entry)
    if len(prev_history) > VALIDATION_HISTORY_MAX_ENTRIES:
        prev_history = prev_history[-VALIDATION_HISTORY_MAX_ENTRIES:]

    # Drift warning vs the previous DISTINCT state (the entry before the
    # one we just wrote). Console-only -- visible in pipeline output.
    if len(prev_history) >= 2:
        prev_entry = prev_history[-2]
        cur_rho = entry.get("spearman_pooled_rho")
        old_rho = prev_entry.get("spearman_pooled_rho")
        if cur_rho is not None and old_rho is not None:
            if old_rho - cur_rho > DRIFT_WARN_RHO_DROP:
                print(f"[validate_elo] WARNING: pooled Spearman rho dropped "
                      f"{old_rho:.4f} -> {cur_rho:.4f} "
                      f"(more than {DRIFT_WARN_RHO_DROP}) since the previous "
                      f"validator run -- investigate before the next re-rate.")
        cur_acc = entry.get("clean_win_accuracy_mean")
        old_acc = prev_entry.get("clean_win_accuracy_mean")
        if cur_acc is not None and old_acc is not None:
            if old_acc - cur_acc > DRIFT_WARN_CLEANWIN_DROP:
                print(f"[validate_elo] WARNING: clean_win accuracy (mean R) "
                      f"dropped {old_acc:.3f} -> {cur_acc:.3f} "
                      f"(more than {DRIFT_WARN_CLEANWIN_DROP:.0%}) since the "
                      f"previous validator run.")

    cwa = results.get("clean_win_accuracy") or {}
    summary = {
        "schema_version": VALIDATION_SUMMARY_SCHEMA_VERSION,
        "generated_at":   (results.get("meta") or {}).get("generated_at"),
        "latest":         entry,
        # Richer latest-run detail the dashboard / future trend UI can use
        # without parsing the gitignored full report.
        "latest_detail": {
            "winner_funnel":       results.get("winner_funnel") or {},
            "rating_gap_breakout": cwa.get("rating_gap_breakout") or {},
            "aggregations": {
                name: {
                    "accuracy":     (agg or {}).get("accuracy"),
                    "accuracy_ci":  (agg or {}).get("accuracy_ci"),
                    "log_loss_mean": (agg or {}).get("log_loss_mean"),
                }
                for name, agg in (cwa.get("aggregations") or {}).items()
            },
            # v1.2: commander-ladder accuracy + lambda ablation and the
            # axis-vs-outcome study, surfaced for the ELO page's
            # Does-it-work tab (absent-safe: {} when unavailable).
            "vtsr_c":       results.get("vtsr_c") or {},
            "axis_outcome": results.get("axis_outcome") or {},
            # v1.3: VTSR-C v2 economy-composite proof sections (#12 econ
            # axes + #13 alpha_c ablation), same absent-safe contract.
            "vtsr_c_perf":  results.get("vtsr_c_perf") or {},
            # v1.5: one row per determined match. The page computes
            # cumulative and rolling-30 itself. Absent on older summaries.
            "accuracy_timeline": cwa.get("accuracy_timeline") or [],
        },
        "history": prev_history,
    }
    out_path.write_text(
        json.dumps(summary, indent=2, sort_keys=False, default=str),
        encoding="utf-8",
    )
    return out_path


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="validate_elo",
        description=(
            "VTSR-T predictive validator (Phase 1 smoke-test). "
            "Reads data/processed/elo_*.json + matches.json + per-match files, "
            "writes a markdown + JSON report to _validation/."
        ),
    )
    parser.add_argument(
        "--processed-dir",
        type=Path,
        default=DEFAULT_PROCESSED_DIR,
        help="Directory containing elo_current.json, elo_history.json, "
             "matches.json, and per-match <id>.json files. "
             f"Default: {DEFAULT_PROCESSED_DIR}",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Directory to write report.md / report.json / bootstrap.json. "
             f"Default: {DEFAULT_OUTPUT_DIR}",
    )
    parser.add_argument(
        "--elo-mode",
        choices=["default", "unlocked", "max", "softmax", "ranks",
                 "alpha10", "alpha25", "alpha50"],
        default="default",
        help="Pick which canonical elo files to validate. 'default' reads "
             "elo_current.json + elo_history.json. "
             "'unlocked' reads elo_current_unlocked.json + elo_history_unlocked.json "
             "(Phase 2B locked-priors ablation -- both hand-tuned commander "
             "axes ride the shrunk rolling baseline). 'alpha10'/'alpha25'/"
             "'alpha50' read the Stage E forensic wins-blend pairs "
             "(elo_current_alpha{10,25,50}.json -- published vtsr = real "
             "R^W/R^T blend at that alpha). 'max' / 'softmax' read "
             "elo_current_max.json / elo_current_softmax.json respectively "
             "(Phase 2C team-threat aggregation -- E_i opponent reference "
             "uses hard max / softmax-weighted mean instead of median). "
             "'ranks' reads elo_current_ranks.json / elo_history_ranks.json "
             "(Phase 3 rank-based lobby scoring trial -- per-axis "
             "average-rank percentile mapping instead of z-score/clip).",
    )
    parser.add_argument(
        "--bootstrap-runs",
        type=int,
        default=BOOTSTRAP_RUNS,
        help=f"Bootstrap resampling iterations. Default: {BOOTSTRAP_RUNS}",
    )
    parser.add_argument(
        "--dirichlet-runs",
        type=int,
        default=DIRICHLET_RUNS,
        help=f"Dirichlet perturbation samples. Default: {DIRICHLET_RUNS}",
    )
    parser.add_argument(
        "--dirichlet-concentration",
        type=float,
        default=DIRICHLET_CONCENTRATION,
        help=f"Dirichlet concentration. Higher = tighter perturbation around "
             f"current weights. Default: {DIRICHLET_CONCENTRATION}",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=12345,
        help="Random seed (used for bootstrap and Dirichlet). "
             "Same seed = byte-identical report. Default: 12345",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    processed_dir: Path = args.processed_dir
    output_dir: Path = args.output_dir

    # Resolve elo file pair based on --elo-mode.
    if args.elo_mode == "default":
        elo_current_name = "elo_current.json"
        elo_history_name = "elo_history.json"
    elif args.elo_mode == "unlocked":
        elo_current_name = "elo_current_unlocked.json"
        elo_history_name = "elo_history_unlocked.json"
    elif args.elo_mode == "max":
        elo_current_name = "elo_current_max.json"
        elo_history_name = "elo_history_max.json"
    elif args.elo_mode == "softmax":
        elo_current_name = "elo_current_softmax.json"
        elo_history_name = "elo_history_softmax.json"
    elif args.elo_mode == "ranks":
        elo_current_name = "elo_current_ranks.json"
        elo_history_name = "elo_history_ranks.json"
    elif args.elo_mode in ("alpha10", "alpha25", "alpha50"):
        # Stage E forensic wins-blend pairs (alpha_override in
        # {0.10, 0.25, 0.50}). Scored against the pre-registered promote
        # rule in critique/decisions/phase-5-wins-blend.md.
        elo_current_name = f"elo_current_{args.elo_mode}.json"
        elo_history_name = f"elo_history_{args.elo_mode}.json"
    else:
        print(f"ERROR: unhandled --elo-mode {args.elo_mode!r}")
        return 2

    if not (processed_dir / elo_current_name).exists():
        print(f"ERROR: missing {processed_dir / elo_current_name}")
        return 2
    if not (processed_dir / elo_history_name).exists():
        print(f"ERROR: missing {processed_dir / elo_history_name}")
        return 2
    if not (processed_dir / "matches.json").exists():
        print(f"ERROR: missing {processed_dir / 'matches.json'}")
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)

    # Load corpus. We point ``load_corpus`` at the requested elo pair by
    # symlink-style: load directly using the resolved filenames.
    print(f"[validate_elo] loading corpus from {processed_dir}/...")
    current = _load_json(processed_dir / elo_current_name)
    history = _load_json(processed_dir / elo_history_name)
    manifest = _load_json(processed_dir / "matches.json")
    if not isinstance(manifest, list):
        print(f"ERROR: matches.json must be a list, got {type(manifest).__name__}")
        return 2

    weights = dict(current.get("weights") or THUG_WEIGHTS_FALLBACK)

    per_match: dict[str, Any] = {}
    n_total = 0
    n_loaded = 0
    n_missing = 0
    for entry in (history or {}).get("history") or []:
        if entry.get("match_excluded"):
            continue
        n_total += 1
        match_id = entry.get("match_id")
        if not match_id:
            continue
        match_path = processed_dir / f"{match_id}.json"
        if not match_path.exists():
            n_missing += 1
            continue
        try:
            per_match[match_id] = _load_json(match_path)
            n_loaded += 1
        except Exception as exc:
            print(f"  WARN: failed to load {match_path}: {exc}")
            n_missing += 1

    print(f"[validate_elo] rated history entries: {n_total} "
          f"(per-match files loaded: {n_loaded}, missing: {n_missing})")

    # v1.2: the commander-ladder history (canonical, mode-independent).
    # Absent-safe: the metric reports available=false and the report
    # sections self-omit.
    cmdr_history_path = processed_dir / "elo_commander_history.json"
    cmdr_history = None
    if cmdr_history_path.exists():
        try:
            cmdr_history = _load_json(cmdr_history_path)
        except Exception as exc:
            print(f"  WARN: failed to load {cmdr_history_path}: {exc}")

    # Run metrics.
    print("[validate_elo] [1/20] rank correlation ...")
    rank_correlation = metric_rank_correlation(history)
    print("[validate_elo] [2/20] calibration ...")
    calibration = metric_calibration(history)
    print("[validate_elo] [3/20] self-consistency ...")
    self_consistency = metric_self_consistency(history)
    print(f"[validate_elo] [4/20] bootstrap stability ({args.bootstrap_runs} runs) ...")
    bootstrap = metric_bootstrap_stability(
        history, current,
        runs=args.bootstrap_runs,
        seed=args.seed,
    )
    print("[validate_elo] [5/20] synthetic-winner proxy ...")
    synthetic_winner = metric_synthetic_winner(history, per_match)
    print("[validate_elo] [6+7/20] clean_win prediction + log-loss ...")
    clean_win_accuracy = metric_clean_win_accuracy(history, per_match)
    print("[validate_elo] [8/20] single-axis ablation ...")
    axis_ablation = metric_axis_ablation(history, current, weights)
    print(f"[validate_elo] [9/20] Dirichlet perturbation ({args.dirichlet_runs} runs) ...")
    dirichlet_perturbation = metric_dirichlet_perturbation(
        history, weights,
        runs=args.dirichlet_runs,
        concentration=args.dirichlet_concentration,
        seed=args.seed + 1,
    )
    print("[validate_elo] [10/20] VTSR-C prediction + lambda ablation ...")
    vtsr_c = metric_vtsr_c(cmdr_history)
    print("[validate_elo] [11/20] axis-vs-outcome sign agreement ...")
    axis_outcome = metric_axis_outcome(history, per_match)
    print("[validate_elo] [12/20] VTSR-C econ-axis sign agreement ...")
    cmdr_econ_axes = metric_cmdr_econ_axes(cmdr_history)
    print("[validate_elo] [12b] VTSR-C promote rule + legacy early-vs-full ...")
    cmdr_promote = metric_cmdr_promote(cmdr_history, per_match)
    cmdr_legacy = metric_legacy_early_full(cmdr_history, per_match)
    print("[validate_elo] [13/20] VTSR-C alpha_c ablation ...")
    cmdr_alpha_ablation = metric_cmdr_alpha_ablation(cmdr_history)
    print("[validate_elo] [14/20] Balonce Meter T-term ablation ...")
    cmdr_t_term = metric_cmdr_t_term(cmdr_history, history, per_match)
    winner_funnel = count_winner_funnel(history, per_match)

    # v1.7 (critique v4) descriptive diagnostics. The F9 ledger lives
    # beside data/processed/ in data/external/; absent-safe (the faction
    # section then runs on telemetry duels only).
    f9_ledger = None
    f9_ledger_path = processed_dir.parent / "external" / "f9_ledger.json"
    if f9_ledger_path.exists():
        try:
            f9_ledger = _load_json(f9_ledger_path)
        except Exception as exc:
            print(f"  WARN: failed to load {f9_ledger_path}: {exc}")
    print("[validate_elo] [15/20] performance ladder vs wins ladder ...")
    perf_vs_wins = metric_perf_vs_wins(current)
    rated_rows, rated_rows_meta = _build_rated_rows(history, per_match)
    print(f"[validate_elo] [16/20] team-outcome dependence "
          f"({rated_rows_meta['rows']} joined rows, "
          f"{rated_rows_meta['unmatched']} unmatched) ...")
    team_outcome_dependence = metric_team_outcome_dependence(rated_rows)
    print("[validate_elo] [17/20] ship-denial gradient ...")
    ship_denial = metric_ship_denial(rated_rows)
    print("[validate_elo] [18/20] commander selection + role-adjustment audit ...")
    commander_selection = metric_commander_selection(rated_rows)
    print("[validate_elo] [19/20] faction effect controlling for ratings ...")
    faction_effect = metric_faction_effect(cmdr_history, manifest, f9_ledger)
    # v1.8: the format-gate audit is the one section that needs the
    # EXCLUDED matches' per-match files (size / duration / cancelled /
    # void entries). Loaded here, never merged into ``per_match``.
    per_match_excluded: dict[str, Any] = {}
    for entry in (history or {}).get("history") or []:
        if not entry.get("match_excluded"):
            continue
        mid = entry.get("match_id")
        if not mid:
            continue
        p = processed_dir / f"{mid}.json"
        if p.exists():
            try:
                per_match_excluded[mid] = _load_json(p)
            except Exception as exc:
                print(f"  WARN: failed to load excluded match {p}: {exc}")
    print(f"[validate_elo] [20/20] format gate ({len(per_match_excluded)} excluded match files) ...")
    format_gate = metric_format_gate(history, per_match, per_match_excluded,
                                     manifest, cmdr_history, current)

    # Player count totals (corpus-wide, for the report header).
    seen_keys: set[str] = set()
    for _, _, deltas in iter_rated_history(history):
        for d in deltas:
            seen_keys.add(player_key_for_delta(d))
    players_total = len(seen_keys)

    vtsr_values = [
        float(r["vtsr"])
        for r in (current.get("ratings") or [])
        if isinstance(r.get("vtsr"), (int, float))
    ]
    mean_vtsr = statistics.fmean(vtsr_values) if vtsr_values else None
    rating_spread_std = (
        statistics.pstdev(vtsr_values) if len(vtsr_values) >= 2 else None
    )

    results: dict[str, Any] = {
        "meta": {
            "generated_at":          datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "validator_version":     VALIDATOR_VERSION,
            "elo_mode":              args.elo_mode,
            "elo_source":            elo_current_name,
            "elo_schema_version":    current.get("schema_version"),
            "rated_match_count":     n_total,
            "rated_per_match_loaded": n_loaded,
            "rated_per_match_missing": n_missing,
            "players_total":         players_total,
            "mean_vtsr":             mean_vtsr,
            "rating_spread_std":     rating_spread_std,
            "players_with_min_matches": self_consistency["n_players"],
            "paths": {
                "elo_current":   str(processed_dir / elo_current_name),
                "elo_history":   str(processed_dir / elo_history_name),
                "matches":       str(processed_dir / "matches.json"),
                "per_match_dir": str(processed_dir),
            },
            "settings": {
                "bootstrap_runs":          args.bootstrap_runs,
                "bootstrap_sample_rate":   BOOTSTRAP_SAMPLE_RATE,
                "dirichlet_runs":          args.dirichlet_runs,
                "dirichlet_concentration": args.dirichlet_concentration,
                "calibration_buckets":     CALIBRATION_N_BUCKETS,
                "self_consistency_min_matches": SELF_CONSISTENCY_MIN_MATCHES,
                "top_n":                   TOP_N,
                "synthetic_winner_threshold": SYNTHETIC_WINNER_THRESHOLD,
                "seed":                    args.seed,
            },
        },
        "rank_correlation":       rank_correlation,
        "calibration":            calibration,
        "self_consistency":       self_consistency,
        "bootstrap":              {
            k: v for k, v in bootstrap.items() if k != "per_player"
        },
        "synthetic_winner":       synthetic_winner,
        "clean_win_accuracy":     clean_win_accuracy,
        "axis_ablation":          axis_ablation,
        "dirichlet_perturbation": dirichlet_perturbation,
        "vtsr_c":                 vtsr_c,
        "axis_outcome":           axis_outcome,
        # v1.3: VTSR-C v2 economy-composite proof sections.
        "vtsr_c_perf": {
            "econ_axes":      cmdr_econ_axes,
            "alpha_ablation": cmdr_alpha_ablation,
            # v1.6: confirmation-sample promote rule + retired-formula
            # early-vs-full diagnostic. Additive.
            "promote":        cmdr_promote,
            "legacy_early_full": cmdr_legacy,
        },
        # v1.4: Balonce Meter T-term ablation (pre-registered in
        # critique/decisions/balonce-meter-t-term.md).
        "cmdr_t_term":            cmdr_t_term,
        "winner_funnel":          winner_funnel,
        # v1.7: critique-v4 descriptive diagnostics (#15-#19). Never
        # feed validation_summary.json; the faction memo governs the one
        # actionable candidate.
        "perf_vs_wins":           perf_vs_wins,
        "team_outcome_dependence": team_outcome_dependence,
        "ship_denial":            ship_denial,
        "commander_selection":    commander_selection,
        "faction_effect":         faction_effect,
        "rated_rows_join":        rated_rows_meta,
        # v1.8: format-gate audit (#20). Descriptive; not in the summary.
        "format_gate":            format_gate,
    }

    # Write outputs.
    report_md = render_markdown_report(results, weights)
    (output_dir / "report.md").write_text(report_md, encoding="utf-8")
    print(f"[validate_elo] wrote {output_dir / 'report.md'}")

    json_report = render_json_report(results, weights)
    (output_dir / "report.json").write_text(
        json.dumps(json_report, indent=2, sort_keys=False, default=str),
        encoding="utf-8",
    )
    print(f"[validate_elo] wrote {output_dir / 'report.json'}")

    bootstrap_artifact = render_bootstrap_artifact(bootstrap)
    (output_dir / "bootstrap.json").write_text(
        json.dumps(bootstrap_artifact, indent=2, sort_keys=False, default=str),
        encoding="utf-8",
    )
    print(f"[validate_elo] wrote {output_dir / 'bootstrap.json'}")

    # Committed summary + per-run metric history (default mode only --
    # alt-mode runs are forensic and must never touch the published file).
    if args.elo_mode == "default":
        summary_path = write_validation_summary(results, processed_dir)
        print(f"[validate_elo] wrote {summary_path}")

    # Print headline at the end so it's visible in CI logs / terminal.
    # ASCII-only on stdout so Windows cp1252 doesn't choke; Unicode lives
    # in the markdown report (which is written UTF-8 explicitly).
    print("")
    print("==================== HEADLINE ====================")
    print(f"  Spearman rho (R_pre -> P_i):  {_fmt_num(rank_correlation['pooled_rho'])}")
    print(f"  Self-consistency rho:         {_fmt_num(self_consistency['spearman_rho'])}")
    if synthetic_winner["n_eligible"]:
        ci = synthetic_winner["agreement_ci"] or [None, None]
        passes = "PASSES" if synthetic_winner["passes_threshold"] else "FAILS"
        print(f"  Synthetic-winner agree:       {_fmt_pct(synthetic_winner['agreement'])} "
              f"({_fmt_pair(ci[0], ci[1])})  [{passes} {SYNTHETIC_WINNER_THRESHOLD * 100:.0f}%]")
    if clean_win_accuracy.get("n_eligible"):
        ci = clean_win_accuracy["accuracy_ci"] or [None, None]
        print(f"  clean_win prediction (mean):  {_fmt_pct(clean_win_accuracy['accuracy'])} "
              f"({_fmt_pair(ci[0], ci[1])})  log-loss {_fmt_num(clean_win_accuracy['log_loss_mean'])}")
        if "aggregations" in clean_win_accuracy:
            for agg_name in ("hard_max", "softmax_max"):
                a = clean_win_accuracy["aggregations"][agg_name]
                ci_a = a["accuracy_ci"] or [None, None]
                label = {
                    "hard_max":    "clean_win prediction (MAX): ",
                    "softmax_max": "clean_win prediction (smax):",
                }[agg_name]
                print(f"  {label}  {_fmt_pct(a['accuracy'])} "
                      f"({_fmt_pair(ci_a[0], ci_a[1])})  log-loss {_fmt_num(a['log_loss_mean'])}")
            best = clean_win_accuracy["best_aggregation"]
            best_label = {
                "mean":        "team mean R",
                "hard_max":    "team hard MAX R",
                "softmax_max": "team softmax R",
            }.get(best, best)
            print(f"  Best aggregation:             {best_label} (sec 6.1 verdict)")
        recent = clean_win_accuracy.get("recent") or {}
        if recent.get("n"):
            ci_r = recent.get("accuracy_ci") or [None, None]
            print(f"  Recent form (last {recent.get('n')} MAX): "
                  f"{_fmt_pct(recent.get('accuracy'))} "
                  f"({_fmt_pair(ci_r[0], ci_r[1])})  since {recent.get('since_date')}")
    print(f"  Bootstrap top-{bootstrap.get('top_n', TOP_N)} Jaccard:       "
          f"{_fmt_num(bootstrap.get('jaccard_mean'))} "
          f"(min {_fmt_num(bootstrap.get('jaccard_min'))})")
    print(f"  Bootstrap rating-proxy std:   median {_fmt_num(bootstrap.get('proxy_std_median'), decimals=1)} ELO")
    if vtsr_c.get("available"):
        ci_c = vtsr_c.get("accuracy_ci") or [None, None]
        print(f"  VTSR-C duel prediction:       {_fmt_pct(vtsr_c.get('accuracy'))} "
              f"({_fmt_pair(ci_c[0], ci_c[1])})  log-loss {_fmt_num(vtsr_c.get('log_loss'))}  "
              f"n={vtsr_c.get('n_scored')}  lambda={vtsr_c.get('lambda_canonical')}")
    if axis_outcome.get("available"):
        top_axes = (axis_outcome.get("axes") or [])[:3]
        tops = ", ".join(
            f"{r['axis']} {_fmt_pct(r['sign_agreement'])}" for r in top_axes
        )
        print(f"  Axis-vs-outcome top 3:        {tops}")
    if cmdr_econ_axes.get("available"):
        top_econ = (cmdr_econ_axes.get("axes") or [])[:3]
        tops_e = ", ".join(
            f"{r['axis']} {_fmt_pct(r['sign_agreement'])}" for r in top_econ
        )
        print(f"  VTSR-C econ axes (n={cmdr_econ_axes.get('n_scored')}):   {tops_e}")
    if cmdr_alpha_ablation.get("available"):
        print(f"  VTSR-C alpha_c ablation:      telemetry n="
              f"{cmdr_alpha_ablation.get('n_telemetry_scored')}, "
              f"replay integrity "
              f"{_fmt_num(cmdr_alpha_ablation.get('replay_max_abs_diff'), decimals=4)} ELO")
    if perf_vs_wins.get("available"):
        print(f"  thug_elo vs wins_elo (sec 15): Spearman "
              f"{_fmt_num(perf_vs_wins.get('spearman'))} over "
              f"{perf_vs_wins.get('n_players')} players")
    if team_outcome_dependence.get("available"):
        th = team_outcome_dependence.get("thugs") or {}
        print(f"  Stomp effect (sec 16):        eta^2 {_fmt_num(th.get('eta_squared_p'))}; "
              f"winners with dR<0 {_fmt_pct(th.get('winners_negative_delta_share'))}, "
              f"losers with dR>0 {_fmt_pct(th.get('losers_positive_delta_share'))}")
    if faction_effect.get("available"):
        fa = (faction_effect.get("fits") or {}).get("all") or {}
        if fa.get("fitted"):
            print(f"  Faction effect (sec 19, all): Hadean vs ISDF "
                  f"{fa.get('coef_hadean_vs_isdf'):+.3f} logit "
                  f"(z {_fmt_num(fa.get('z_hadean_vs_isdf'), 2)}, "
                  f"~{fa.get('rating_points_hadean_vs_isdf'):+.0f} pts); "
                  f"LR p {_fmt_num(fa.get('lr_p_value'))}")
    if format_gate.get("available"):
        tr = format_gate.get("transfer") or {}
        tt = tr.get("vtsr_t_team_mean") or {}
        tc = tr.get("vtsr_c_leader_gap") or {}
        print(f"  Format gate (sec 20):         small-format games "
              f"{(format_gate.get('profile') or {}).get('n_small_format')} "
              f"({tr.get('n_determined')} determined); transfer VTSR-T "
              f"{tt.get('correct')}/{tt.get('n')}, VTSR-C {tc.get('correct')}/{tc.get('n')}")
    print("==================================================")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
