"""VTSR-C -- Commander Rating v1 (win/loss ELO with a team-strength handicap).

Pure module, no I/O -- mirrors the `scripts/elo.py` contract.
`compute_commander_elo(all_match_data, elo_history)` returns
`(elo_commander_current, elo_commander_history)` dicts ready for `json.dump`.

Design (locked, v1):

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

from datetime import datetime, timezone
from typing import Any

import identity_aliases  # silent Steam64 alias table (name pinning)

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

CMDR_ELO_SCHEMA_VERSION = 1


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
            # Silent-alias name pin (mirrors scripts/elo.py): a commander
            # appearance on an alias-source account carries the source
            # display name per-match, but the ladder row must keep the
            # alias target's canonical name.
            display_name[k] = (identity_aliases.ALIAS_TARGET_NAMES_STR.get(k)
                               or commanders[t].get("name")
                               or display_name.get(k, ""))
            if not steam64_out.get(k):
                s64 = commanders[t].get("steam64")
                steam64_out[k] = str(s64) if s64 else None

        r_before = {t: rating[keys[t]] for t in (1, 2)}
        e1 = expected_score(
            r_before[1], r_before[2], thug_means[1], thug_means[2]
        )
        expected = {1: e1, 2: 1.0 - e1}

        duel_commanders = {}
        for t in (1, 2):
            k = keys[t]
            ki = k_factor(games[k])
            dr = ki * (scores[t] - expected[t])
            r_after = r_before[t] + dr
            rating[k] = r_after
            games[k] += 1
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
    }

    current = dict(common)
    current["ratings"] = ratings_out

    history = dict(common)
    history["duels"] = duels

    return current, history
