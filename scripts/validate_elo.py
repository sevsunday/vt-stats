"""VTSR-T predictive validator (v1.1, Phase 2A).

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
    8. Single-axis ablation: drop each of the 8 axes, measure rank
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

VALIDATOR_VERSION = 2  # v1.1 (Phase 2A): MAX-vs-median preview + commander-presence + rating-gap breakouts

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
    "snipe_bonus":       0.005,  # v2.10: luxury/preview axis (was 0.05)
    "target_lock_pct":   0.005,  # v2.10: luxury/preview axis (was 0.04)
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
    for match_id, _, deltas in iter_rated_history(history):
        match_data = per_match.get(match_id)
        if not match_data:
            continue
        winner_block = (match_data.get("match") or {}).get("winner") or {}
        decided_by = winner_block.get("decided_by")
        winner_team = winner_block.get("team")
        if decided_by != "clean_win":
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
            "winner_team":     winner_team,
            "loser_team":      3 - winner_team,
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
    }


def count_winner_funnel(
    history: dict[str, Any], per_match: dict[str, Any]
) -> dict[str, int]:
    """Eligibility funnel for the winner-anchored metrics. Reported in
    the report header so the user can see how many matches we threw
    out and why.
    """
    funnel = {
        "rated_history_entries":  0,
        "missing_per_match_file": 0,
        "winner_block_missing":   0,
        "decided_by_clean_win":   0,
        "decided_by_contested":   0,
        "decided_by_unclear":     0,
        "skipped_no_team_split":  0,
    }
    for match_id, _, deltas in iter_rated_history(history):
        funnel["rated_history_entries"] += 1
        match_data = per_match.get(match_id)
        if not match_data:
            funnel["missing_per_match_file"] += 1
            continue
        winner_block = (match_data.get("match") or {}).get("winner") or {}
        decided_by = winner_block.get("decided_by")
        if not decided_by:
            funnel["winner_block_missing"] += 1
            continue
        if decided_by == "clean_win":
            funnel["decided_by_clean_win"] += 1
        elif decided_by == "contested":
            funnel["decided_by_contested"] += 1
        elif decided_by == "unclear":
            funnel["decided_by_unclear"] += 1
    return funnel


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
    """For each of the 8 axes, drop it from THUG_WEIGHTS and renormalize
    the remaining 7. Recompute per-player mean P_i. Compare ranking to
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
    lines.append("Drop each axis, renormalize the remaining 7, recompute per-player "
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
    Strictly additive; existing v1 readers see the legacy fields
    unchanged.
    """
    return {
        "schema_version":   2,
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
        choices=["default", "thugs_only", "unlocked", "max", "softmax", "ranks"],
        default="default",
        help="Pick which canonical elo files to validate. 'default' reads "
             "elo_current.json + elo_history.json. 'thugs_only' reads "
             "elo_current_thugs_only.json + elo_history_thugs_only.json. "
             "'unlocked' reads elo_current_unlocked.json + elo_history_unlocked.json "
             "(Phase 2B locked-priors ablation -- both hand-tuned commander "
             "axes ride the shrunk rolling baseline). 'max' / 'softmax' read "
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
    elif args.elo_mode == "thugs_only":
        elo_current_name = "elo_current_thugs_only.json"
        elo_history_name = "elo_history_thugs_only.json"
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

    # Run metrics.
    print("[validate_elo] [1/9] rank correlation ...")
    rank_correlation = metric_rank_correlation(history)
    print("[validate_elo] [2/9] calibration ...")
    calibration = metric_calibration(history)
    print("[validate_elo] [3/9] self-consistency ...")
    self_consistency = metric_self_consistency(history)
    print(f"[validate_elo] [4/9] bootstrap stability ({args.bootstrap_runs} runs) ...")
    bootstrap = metric_bootstrap_stability(
        history, current,
        runs=args.bootstrap_runs,
        seed=args.seed,
    )
    print("[validate_elo] [5/9] synthetic-winner proxy ...")
    synthetic_winner = metric_synthetic_winner(history, per_match)
    print("[validate_elo] [6+7/9] clean_win prediction + log-loss ...")
    clean_win_accuracy = metric_clean_win_accuracy(history, per_match)
    print("[validate_elo] [8/9] single-axis ablation ...")
    axis_ablation = metric_axis_ablation(history, current, weights)
    print(f"[validate_elo] [9/9] Dirichlet perturbation ({args.dirichlet_runs} runs) ...")
    dirichlet_perturbation = metric_dirichlet_perturbation(
        history, weights,
        runs=args.dirichlet_runs,
        concentration=args.dirichlet_concentration,
        seed=args.seed + 1,
    )
    winner_funnel = count_winner_funnel(history, per_match)

    # Player count totals (corpus-wide, for the report header).
    seen_keys: set[str] = set()
    for _, _, deltas in iter_rated_history(history):
        for d in deltas:
            seen_keys.add(player_key_for_delta(d))
    players_total = len(seen_keys)

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
        "winner_funnel":          winner_funnel,
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
    print(f"  Bootstrap top-{bootstrap.get('top_n', TOP_N)} Jaccard:       "
          f"{_fmt_num(bootstrap.get('jaccard_mean'))} "
          f"(min {_fmt_num(bootstrap.get('jaccard_min'))})")
    print(f"  Bootstrap rating-proxy std:   median {_fmt_num(bootstrap.get('proxy_std_median'), decimals=1)} ELO")
    print("==================================================")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
