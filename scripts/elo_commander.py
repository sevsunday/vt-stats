"""VTSR-C -- Commander Rating v2 (win/loss ELO with a team-strength handicap
plus an INERT economy-performance composite behind CMDR_ALPHA_C = 1.0).

Pure module, no I/O -- mirrors the `scripts/elo.py` contract.
`compute_commander_elo(all_match_data, elo_history)` returns
`(elo_commander_current, elo_commander_history)` dicts ready for `json.dump`.

v2 additions (consequence-free while CMDR_ALPHA_C == 1.0):

  * FIVE ECONOMY AXES computed per duel from the proto-v4 `economy` +
    `builds` match blocks (constructor-free by design -- era-mixed
    structure-completion quality must never feed a rating axis):

        pool_tempo         time-weighted pool-count advantage
                           (pool_advantage_integral / duration_sec)
        production_output  scrap_spent_units per minute (value fielded)
        thug_supply        ships_built per team ship-loss, capped at
                           THUG_SUPPLY_CAP (losses = sum of the side's
                           leaderboard deaths; pilot deaths already
                           excluded by the v2.9 pipeline gate)
        econ_efficiency    1 - mean_float_ratio (low bank float = building
                           in the fast-regen zone = good, per the
                           verified regen-segment model)
        upgrade_investment upgrades_final / max(1, peak_pools)

    Exact formulas frozen in critique/decisions/vtsr-c-v2-composite.md
    BEFORE any telemetry corpus accumulates (pre-registration integrity).

  * WITHIN-MATCH DIFFERENTIAL NORMALIZATION (n=2 makes lobby z-scores
    degenerate; the opponent diff controls for map/patch/lobby size):

        d    = v_own - v_opp                    (signed, per axis)
        z    = clip(d / shrunk_std(axis), -2, 2) / 2      in [-1, 1]
        P_1  = sum(w * z) / sum(w)  over available axes;  P_2 = -P_1

    `shrunk_std` is a rolling RMS of the team-1-perspective diffs with a
    seed prior + shrinkage (mirrors elo.py's commander_shrunk_baseline
    snapshot-before-duel / update-after mechanics): the seed dominates
    the empty corpus and live telemetry takes over as duels accumulate.

  * SCORE-LEVEL BLEND, structurally inert at ship:

        S' = CMDR_ALPHA_C * S + (1 - CMDR_ALPHA_C) * (P + 1) / 2

    applied ONLY when the match carries BOTH has_resource_data and
    has_build_data. The code branches on `CMDR_ALPHA_C < 1.0` so the
    inert path never routes through blend arithmetic at all (structural
    exactness on top of the golden byte-identity test). Duels without
    telemetry (all pre-v4 matches forever) score outcome-pure S at ANY
    alpha_c -- a determined outcome is always a valid duel signal;
    exclusion would starve the pool and couple coverage to collector
    uptime (RATIFIED 2026-09-03). W/L/D records always tally the RAW
    outcome, never the blended score.

  * AUDIT FIELDS (additive, schema 1 -> 2): per-duel `performance`
    {available, p (team-1 perspective), axes{axis: {diff, std, z}}};
    per-commander-side `score_blend` {alpha_c, s_raw, s_blended};
    per-rating `duels_with_telemetry`; top-level `alpha_c`,
    `econ_weights`, `econ_std_prior`, `econ_std_shrinkage`,
    `econ_std_observed`.

  * PRE-REGISTERED PROMOTE RULE (decision memo): flip alpha_c below 1.0
    only when >= 25 telemetry duels AND >= 3 axes show sign-agreement
    > 0.55 with none < 0.35 AND the validator alpha_c ablation improves
    (or holds within CI) accuracy while improving log-loss. Discard an
    axis at sign-agreement < 0.40 with n >= 40. Otherwise HOLD.

Design (locked, v1 -- all still true):

  * OUTCOME-PURE (alpha_c = 1) -- the mirror image of VTSR-T (alpha = 0,
    performance-pure). A match outcome is a clean 1v1 label between exactly
    two commanders: the highest signal-density use of the v15/v16 outcome
    data (host attestation + human adjudication). Future commander
    telemetry (resource handling, build orders) slots in later as a
    COMMANDER_WEIGHTS performance composite blended through the same alpha
    architecture VTSR-T already reserves -- no rework.

  * TEAM-STRENGTH HANDICAP in the expected score, so stacked thugs don't
    inflate the commander's rating:

        E_A = 1 / (1 + 10^(-((R_A - R_B) + lambda * (T_A - T_B)) / 400))

    where T is the mean PRE-MATCH VTSR-T of each team's non-commander
    rated rows, read from the canonical elo_history deltas' `before`
    values -- historically accurate at that point in the walk, zero
    leakage. A commander who loses with the weaker thug team was expected
    to lose (tiny penalty); winning with it earns a big reward.

  * CLASSIC CHESS CONSTANTS where W/L semantics differ from VTSR-T's
    performance semantics: logistic scale 400 (VTSR-T's 800 is tuned for
    performance-expected values in [0,1] against a lobby median -- a
    head-to-head win probability is the textbook regime), SYMMETRIC K
    (no loss aversion -- W/L duels are zero-sum; asymmetry would inflate
    the pool), and NO rating floor (tiny pool; no ladder-flight psychology
    to manage). Anchor 1500. K decays 40 -> 20 over the first
    CMDR_PROVISIONAL_PRIOR commander games; provisional badge below
    CMDR_PROVISIONAL_THRESHOLD rated games.

Rated set = canonical rated matches that are DETERMINED: present in
elo_history with non-empty deltas (inherits the 6-player / 240s /
cancelled gates for free), `winner.team` in (1, 2) via `decided_by` in
DETERMINED_DECIDED_BY, both team leaders identified from
`leaderboard[].is_commander` (fallback `match.team_leaders`).
Attested / adjudicated draws (`decided_by == "draw"`) score S = 0.5 for
both commanders. Undetermined matches skip (counted).

Output files (written by scripts/process_stats.py, both in the
load_cache_index skip set):
  * data/processed/elo_commander_current.json
  * data/processed/elo_commander_history.json

Corpus-wide, picker-unaware, NOT in the pipeline cache key; the dashboard
thug-only toggle does NOT apply (separate ladder). Experimental posture:
provisional-heavy labeling, visible game counts everywhere.

Algorithm spec: DEVELOPER_GUIDE.md section 13.8. Output schemas:
docs/DATA_DICTIONARY.md section 11.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Constants (all tunable; no schema bump needed to retune)
# ---------------------------------------------------------------------------

# Rating anchor every commander debuts at.
CMDR_ELO_ANCHOR = 1500.0

# K-factor decay: K = K_FLOOR + (K_BASE - K_FLOOR) * max(0, 1 - games/PRIOR).
# Fast early movement (the pool is tiny and outcome-labeled matches are
# scarce), settling to a stable K after CMDR_PROVISIONAL_PRIOR games.
CMDR_K_BASE = 40.0
CMDR_K_FLOOR = 20.0
CMDR_PROVISIONAL_PRIOR = 5.0

# Ratings with fewer rated commander games than this carry
# `provisional: true` (UI renders the badge).
CMDR_PROVISIONAL_THRESHOLD = 5

# Logistic scale for the expected score. 400 = classic chess: a 400-point
# gap means ~10:1 win odds. Deliberately NOT VTSR-T's 800 -- that scale is
# tuned for lobby-median performance expectations, not head-to-head W/L.
CMDR_LOGISTIC_SCALE = 400.0

# Team-strength handicap weight: how many rating points a 1-point average
# thug-team advantage is worth inside the expected score. 1.0 = a
# 100-point average-thug advantage counts like 100 commander rating
# points. Validator-ablated (lambda in {0, 0.5, 1.0, 1.5}) so the dial
# becomes empirical as the labeled corpus grows.
CMDR_LAMBDA_TEAM_HANDICAP = 1.0

# decided_by values that make a match outcome DETERMINED for rating
# purposes (winner.team in (1, 2)). Draws are handled separately
# (decided_by == "draw" -> S = 0.5 both sides).
DETERMINED_DECIDED_BY = ("adjudicated", "attested", "clean_win", "contested")

# ---- v2: economy-performance composite (INERT at alpha_c = 1.0) ----------

# Score-level blend weight: S' = alpha_c * S + (1 - alpha_c) * (P+1)/2.
# 1.0 = outcome-pure (the shipped state). The promote rule that may lower
# this lives in critique/decisions/vtsr-c-v2-composite.md and requires
# validator evidence (>= 25 telemetry duels, per-axis sign-agreement,
# alpha_c ablation) before any flip.
CMDR_ALPHA_C = 1.0

# Per-axis prior weights (plan-registered; renormalized over available
# axes at runtime). Validator-gated before they ever matter.
COMMANDER_ECON_WEIGHTS = {
    "pool_tempo": 0.30,
    "production_output": 0.25,
    "thug_supply": 0.20,
    "econ_efficiency": 0.15,
    "upgrade_investment": 0.10,
}

# Seed prior for each axis's DIFFERENTIAL std (team-1-perspective
# v_own - v_opp spread). Magnitudes sanity-anchored on the first real v4
# session (2026-09-03 Wasteland: pool_tempo d=3.30, production d=1.4,
# thug_supply d=0.69, econ_efficiency d=0.075, upgrade d=0.60) so seed
# z-scores land mid-range rather than saturating the clip.
CMDR_ECON_STD_PRIOR = {
    "pool_tempo": 2.0,          # mean-pool-advantage diff (pools)
    "production_output": 25.0,  # scrap/min diff
    "thug_supply": 1.0,         # ships-per-loss diff
    "econ_efficiency": 0.15,    # (1 - float) diff
    "upgrade_investment": 0.35, # upgrade-share diff
}

# Shrinkage weight (pseudo-observations) for the rolling differential
# std: shrunk_var = (SHRINK * prior^2 + sum(d^2)) / (SHRINK + n).
# 10 pseudo-duels: the seed dominates the tiny early corpus, live
# telemetry takes over after ~10 telemetry duels. Tunable without a
# schema bump.
CMDR_ECON_STD_SHRINKAGE = 10.0

# thug_supply cap: ships-built-per-loss is unbounded when a team barely
# loses ships; the cap keeps one lopsided stomp from defining the axis.
THUG_SUPPLY_CAP = 3.0

CMDR_ELO_SCHEMA_VERSION = 2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def expected_score(r_own: float, r_opp: float, t_own: float | None,
                   t_opp: float | None,
                   lam: float = CMDR_LAMBDA_TEAM_HANDICAP) -> float:
    """Logistic expected score with the team-strength handicap term.

    `t_own` / `t_opp` are the mean pre-match VTSR-T of each side's
    non-commander rated rows; when EITHER side has no thug rows the
    handicap term is 0 (an asymmetric comparison would be meaningless).
    """
    if t_own is None or t_opp is None:
        handicap = 0.0
    else:
        handicap = lam * (t_own - t_opp)
    diff = (r_own - r_opp) + handicap
    return 1.0 / (1.0 + 10.0 ** (-diff / CMDR_LOGISTIC_SCALE))


def k_factor(games: int) -> float:
    """Symmetric K with linear provisional decay (40 -> 20 over the first
    CMDR_PROVISIONAL_PRIOR rated commander games)."""
    frac = max(0.0, 1.0 - games / CMDR_PROVISIONAL_PRIOR)
    return CMDR_K_FLOOR + (CMDR_K_BASE - CMDR_K_FLOOR) * frac


def _slot_team(slot: Any) -> int | None:
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


def _identify_commanders(md: dict) -> dict[int, dict] | None:
    """Return {1: leaderboard_row, 2: leaderboard_row} for the two
    commanders, or None when either side is missing.

    Primary: `leaderboard[].is_commander` (slots 1 / 6). Fallback: join
    `match.team_leaders` names back to leaderboard rows.
    """
    lobby = md.get("leaderboard") or []
    commanders: dict[int, dict] = {}
    for row in lobby:
        if not row.get("is_commander"):
            continue
        team = _slot_team(row.get("slot"))
        if team and team not in commanders:
            commanders[team] = row

    if len(commanders) < 2:
        leaders = (md.get("match") or {}).get("team_leaders") or {}
        by_name = {row.get("name"): row for row in lobby}
        for team_key in ("1", "2"):
            team = int(team_key)
            if team in commanders:
                continue
            row = by_name.get(leaders.get(team_key))
            if row is not None:
                commanders[team] = row

    return commanders if len(commanders) == 2 else None


def _team_thug_means(deltas: list[dict], md: dict) -> dict[int, float | None]:
    """Mean pre-match VTSR-T (`before`) of each team's NON-commander rated
    rows for this match. Joins elo_history deltas to leaderboard rows by
    steam64 first, then by name. Sides with zero joinable thug rows yield
    None (callers zero the handicap term)."""
    lobby = md.get("leaderboard") or []
    by_s64 = {str(row.get("steam64")): row for row in lobby if row.get("steam64")}
    by_name = {row.get("name"): row for row in lobby}

    sums = {1: 0.0, 2: 0.0}
    counts = {1: 0, 2: 0}
    for d in deltas:
        row = None
        s64 = d.get("steam64")
        if s64 is not None:
            row = by_s64.get(str(s64))
        if row is None:
            row = by_name.get(d.get("name"))
        if row is None or row.get("is_commander"):
            continue
        team = _slot_team(row.get("slot"))
        if team is None:
            continue
        before = d.get("before")
        if not isinstance(before, (int, float)):
            continue
        sums[team] += float(before)
        counts[team] += 1

    return {
        t: (sums[t] / counts[t]) if counts[t] else None
        for t in (1, 2)
    }


def _econ_axis_values(md: dict) -> dict[int, dict[str, float | None]] | None:
    """Per-side raw economy-axis values for one match, or None when the
    match lacks full v4 telemetry (either flag false / block missing).

    Axis formulas are FROZEN in critique/decisions/vtsr-c-v2-composite.md;
    change them only through that memo's amendment protocol. Individual
    axes may be None (unavailable) -- e.g. upgrade_investment on a
    zero-pool side; the differential layer drops an axis unless BOTH
    sides carry a numeric value.
    """
    econ = md.get("economy") or {}
    builds = md.get("builds") or {}
    if not (econ.get("has_resource_data") and builds.get("has_build_data")):
        return None
    econ_teams = econ.get("teams") or {}
    build_teams = builds.get("teams") or {}
    if not (econ_teams.get("1") and econ_teams.get("2")
            and build_teams.get("1") and build_teams.get("2")):
        return None

    duration_sec = (md.get("match") or {}).get("duration_sec") or 0
    if duration_sec <= 0:
        return None
    minutes = duration_sec / 60.0

    lobby = md.get("leaderboard") or []
    team_deaths = {1: 0, 2: 0}
    for row in lobby:
        team = _slot_team(row.get("slot"))
        if team is None:
            continue
        try:
            team_deaths[team] += int(row.get("deaths") or 0)
        except (TypeError, ValueError):
            pass

    out: dict[int, dict[str, float | None]] = {}
    for side in (1, 2):
        et = econ_teams[str(side)]
        bt = build_teams[str(side)]

        pool_adv = et.get("pool_advantage_integral")
        pool_tempo = (pool_adv / duration_sec) if isinstance(
            pool_adv, (int, float)) else None

        spent = bt.get("scrap_spent_units")
        production = (spent / minutes) if isinstance(
            spent, (int, float)) else None

        ships = bt.get("ships_built")
        thug_supply = None
        if isinstance(ships, (int, float)):
            thug_supply = min(
                THUG_SUPPLY_CAP, ships / max(1, team_deaths[side]))

        mean_float = et.get("mean_float_ratio")
        econ_eff = (1.0 - mean_float) if isinstance(
            mean_float, (int, float)) else None

        upgrades = et.get("upgrades_final")
        peak_pools = et.get("peak_pools")
        upgrade_share = None
        if isinstance(upgrades, (int, float)) and isinstance(
                peak_pools, (int, float)) and peak_pools >= 1:
            upgrade_share = min(1.0, upgrades / peak_pools)

        out[side] = {
            "pool_tempo": pool_tempo,
            "production_output": production,
            "thug_supply": thug_supply,
            "econ_efficiency": econ_eff,
            "upgrade_investment": upgrade_share,
        }
    return out


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------

def compute_commander_elo(all_match_data: list[dict],
                          elo_history: dict) -> tuple[dict, dict]:
    """Chronological VTSR-C walk over the canonical rated-match history.

    `all_match_data`: full per-match dicts (as held in-memory by
    scripts/process_stats.py at emit time).
    `elo_history`: the canonical VTSR-T history dict returned by
    `elo.compute_elo()` -- its `history` list is chronological and its
    per-match deltas carry the pre-match `before` ratings that feed the
    team-strength handicap.

    Returns `(elo_commander_current, elo_commander_history)`.
    """
    match_by_id = {
        ((md.get("match") or {}).get("id", "")): md for md in all_match_data
    }

    # Per-commander mutable state, keyed by steam64-then-name string.
    rating: dict[str, float] = {}
    games: dict[str, int] = {}
    wins: dict[str, int] = {}
    losses: dict[str, int] = {}
    draws: dict[str, int] = {}
    peak: dict[str, float] = {}
    peak_at: dict[str, str] = {}
    peak_date: dict[str, str] = {}
    last_match: dict[str, str] = {}
    last_delta: dict[str, float] = {}
    display_name: dict[str, str] = {}
    steam64_out: dict[str, str | None] = {}

    def _key(row: dict) -> str:
        s64 = row.get("steam64")
        return str(s64) if s64 else f"name:{row.get('name', '')}"

    duels: list[dict] = []
    rated_match_count = 0
    skipped_undetermined = 0
    skipped_missing_commander = 0

    # v2: rolling per-axis differential-std state (team-1-perspective
    # diffs; mean-zero by construction so the estimator is a shrunk RMS).
    # Snapshot BEFORE each duel scores; update AFTER -- mirrors elo.py's
    # commander_shrunk_baseline walk mechanics.
    std_sum_sq: dict[str, float] = {a: 0.0 for a in COMMANDER_ECON_WEIGHTS}
    std_count: dict[str, int] = {a: 0 for a in COMMANDER_ECON_WEIGHTS}
    duels_with_telemetry: dict[str, int] = {}

    def _shrunk_std(axis: str) -> float:
        prior = CMDR_ECON_STD_PRIOR[axis]
        var = ((CMDR_ECON_STD_SHRINKAGE * prior * prior + std_sum_sq[axis])
               / (CMDR_ECON_STD_SHRINKAGE + std_count[axis]))
        return math.sqrt(var) if var > 0 else prior

    for entry in (elo_history.get("history") or []):
        if entry.get("match_excluded"):
            continue
        deltas = entry.get("deltas") or []
        if not deltas:
            continue
        match_id = entry.get("match_id", "")
        md = match_by_id.get(match_id)
        if md is None:
            # Defensive: a rated history entry should always join back to
            # the in-memory corpus. Counted with missing-commander skips
            # (we cannot identify the commanders without the match).
            skipped_missing_commander += 1
            continue

        winner = (md.get("match") or {}).get("winner") or {}
        decided_by = winner.get("decided_by")
        team = winner.get("team")
        if decided_by == "draw":
            scores = {1: 0.5, 2: 0.5}
            outcome = "draw"
        elif decided_by in DETERMINED_DECIDED_BY and team in (1, 2):
            scores = {team: 1.0, 3 - team: 0.0}
            outcome = f"team{team}"
        else:
            skipped_undetermined += 1
            continue

        commanders = _identify_commanders(md)
        if commanders is None:
            skipped_missing_commander += 1
            continue

        thug_means = _team_thug_means(deltas, md)
        keys = {t: _key(commanders[t]) for t in (1, 2)}
        for t in (1, 2):
            k = keys[t]
            if k not in rating:
                rating[k] = CMDR_ELO_ANCHOR
                games[k] = wins[k] = losses[k] = draws[k] = 0
                peak[k] = CMDR_ELO_ANCHOR
            display_name[k] = commanders[t].get("name") or display_name.get(k, "")
            if not steam64_out.get(k):
                s64 = commanders[t].get("steam64")
                steam64_out[k] = str(s64) if s64 else None

        r_before = {t: rating[keys[t]] for t in (1, 2)}
        e1 = expected_score(
            r_before[1], r_before[2], thug_means[1], thug_means[2]
        )
        expected = {1: e1, 2: 1.0 - e1}

        # ---- v2: economy-performance composite (inert at alpha_c = 1) ----
        # Snapshot the differential stds BEFORE this duel scores; fold the
        # duel's diffs into the rolling state only AFTER -- a duel must
        # never normalize against itself (commander_shrunk_baseline
        # mechanics).
        axis_vals = _econ_axis_values(md)
        perf_block: dict[str, Any] = {"available": False}
        s_eff = {t: scores[t] for t in (1, 2)}
        if axis_vals is not None:
            axes_audit: dict[str, dict] = {}
            raw_diffs: dict[str, float] = {}
            num = 0.0
            wsum = 0.0
            for axis, w in COMMANDER_ECON_WEIGHTS.items():
                v_1 = axis_vals[1].get(axis)
                v_2 = axis_vals[2].get(axis)
                if not (isinstance(v_1, (int, float))
                        and isinstance(v_2, (int, float))):
                    continue
                d = float(v_1) - float(v_2)
                std = _shrunk_std(axis)
                z = max(-2.0, min(2.0, d / std)) / 2.0
                raw_diffs[axis] = d
                axes_audit[axis] = {
                    "diff": round(d, 4),
                    "std": round(std, 4),
                    "z": round(z, 4),
                }
                num += w * z
                wsum += w
            if axes_audit and wsum > 0:
                p1 = num / wsum
                p_by_team = {1: p1, 2: -p1}
                perf_block = {
                    "available": True,
                    "p": round(p1, 4),
                    "axes": axes_audit,
                }
                for t in (1, 2):
                    duels_with_telemetry[keys[t]] = (
                        duels_with_telemetry.get(keys[t], 0) + 1)
                # Structural-exactness guard: at CMDR_ALPHA_C == 1.0 the
                # blend arithmetic is never executed, so the inert path
                # is provably identical by inspection (not just by IEEE
                # coincidence).
                if CMDR_ALPHA_C < 1.0:
                    for t in (1, 2):
                        s_eff[t] = (
                            CMDR_ALPHA_C * scores[t]
                            + (1.0 - CMDR_ALPHA_C)
                            * (p_by_team[t] + 1.0) / 2.0)
                # Rolling-std update (post-snapshot, RAW diffs -- the
                # rounded audit values must not degrade the estimator).
                for axis, d in raw_diffs.items():
                    std_sum_sq[axis] += d * d
                    std_count[axis] += 1

        duel_commanders = {}
        for t in (1, 2):
            k = keys[t]
            ki = k_factor(games[k])
            dr = ki * (s_eff[t] - expected[t])
            r_after = r_before[t] + dr
            rating[k] = r_after
            games[k] += 1
            # W/L/D records always tally the RAW outcome, never the
            # blended score -- the record is a fact, the blend a model.
            if scores[t] == 1.0:
                wins[k] += 1
            elif scores[t] == 0.0:
                losses[k] += 1
            else:
                draws[k] += 1
            if r_after > peak[k]:
                peak[k] = r_after
                peak_at[k] = match_id
                peak_date[k] = entry.get("match_date", "")
            elif k not in peak_at:
                peak_at[k] = match_id
                peak_date[k] = entry.get("match_date", "")
            last_match[k] = match_id
            last_delta[k] = dr
            duel_commanders[str(t)] = {
                "steam64": steam64_out.get(k),
                "name": display_name.get(k, ""),
                "before": round(r_before[t], 2),
                "after": round(r_after, 2),
                "delta": round(dr, 2),
                "expected": round(expected[t], 4),
                "k": round(ki, 2),
                "score": scores[t],
                "score_blend": {
                    "alpha_c": CMDR_ALPHA_C,
                    "s_raw": scores[t],
                    "s_blended": round(s_eff[t], 4),
                },
            }

        t1m, t2m = thug_means[1], thug_means[2]
        duels.append({
            "match_id": match_id,
            "date": entry.get("match_date", ""),
            "decided_by": decided_by,
            "adjudicated": bool(winner.get("adjudicated")),
            "outcome": outcome,
            "commanders": duel_commanders,
            "team_handicap": {
                "t1_thug_mean": round(t1m, 2) if t1m is not None else None,
                "t2_thug_mean": round(t2m, 2) if t2m is not None else None,
                "diff": (
                    round(t1m - t2m, 2)
                    if (t1m is not None and t2m is not None) else 0.0
                ),
                "lambda": CMDR_LAMBDA_TEAM_HANDICAP,
            },
            # v2 audit: economy-performance composite (team-1 perspective;
            # side 2's P is the negation). available=false on every
            # pre-v4 / telemetry-gap duel.
            "performance": perf_block,
        })
        rated_match_count += 1

    ratings_out = []
    for k in rating:
        g = games[k]
        ratings_out.append({
            "name": display_name.get(k, ""),
            "steam64": steam64_out.get(k),
            "vtsr_c": round(rating[k], 2),
            "matches_commanded_rated": g,
            "wins": wins[k],
            "losses": losses[k],
            "draws": draws[k],
            "win_pct": round(wins[k] / g, 3) if g else 0.0,
            "peak_vtsr_c": round(peak[k], 2),
            "peak_at": peak_at.get(k, ""),
            "peak_date": peak_date.get(k, ""),
            "last_match_id": last_match.get(k, ""),
            "last_delta": round(last_delta.get(k, 0.0), 2),
            "provisional": g < CMDR_PROVISIONAL_THRESHOLD,
            # v2: duels where the economy composite had telemetry (both
            # v4 flags true). 0 for every pre-v4-era commander.
            "duels_with_telemetry": duels_with_telemetry.get(k, 0),
        })
    ratings_out.sort(key=lambda r: (-r["vtsr_c"], r["name"].lower()))

    computed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    common = {
        "schema_version": CMDR_ELO_SCHEMA_VERSION,
        "anchor": CMDR_ELO_ANCHOR,
        "k_base": CMDR_K_BASE,
        "k_floor": CMDR_K_FLOOR,
        "logistic_scale": CMDR_LOGISTIC_SCALE,
        "lambda_team_handicap": CMDR_LAMBDA_TEAM_HANDICAP,
        "provisional_prior": CMDR_PROVISIONAL_PRIOR,
        "provisional_threshold": CMDR_PROVISIONAL_THRESHOLD,
        "computed_at": computed_at,
        "rated_match_count": rated_match_count,
        "matches_skipped_undetermined": skipped_undetermined,
        "matches_skipped_missing_commander": skipped_missing_commander,
        # v2: economy-performance composite constants + rolling-std
        # telemetry (inert at alpha_c = 1.0; see the decision memo).
        "alpha_c": CMDR_ALPHA_C,
        "econ_weights": dict(COMMANDER_ECON_WEIGHTS),
        "econ_std_prior": dict(CMDR_ECON_STD_PRIOR),
        "econ_std_shrinkage": CMDR_ECON_STD_SHRINKAGE,
        "thug_supply_cap": THUG_SUPPLY_CAP,
        "econ_std_observed": {
            axis: {
                "count": std_count[axis],
                "std": round(_shrunk_std(axis), 4),
            }
            for axis in COMMANDER_ECON_WEIGHTS
        },
    }

    current = dict(common)
    current["ratings"] = ratings_out

    history = dict(common)
    history["duels"] = duels

    return current, history
