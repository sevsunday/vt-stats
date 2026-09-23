"""VTSR-C -- Commander Rating v3 (win/loss ELO with a team-strength handicap,
an INERT economy-performance composite behind CMDR_ALPHA_C = 1.0, and
external community-ledger duels from F9bomber's hand-kept records).

Mirrors the `scripts/elo.py` contract. The only I/O is an optional
one-time read of `data/combat_ship_odfs.json` when the caller does not
pass `combat_ship_stems` (the pipeline always passes the set).
`compute_commander_elo(all_match_data, elo_history, external_duels=None)`
returns `(elo_commander_current, elo_commander_history)` dicts ready for
`json.dump`.

v5 additions (schema 4 -> 5; ratings UNCHANGED -- display inactivity only):

  * INACTIVITY + COMMAND-STALE GATES -- a commander occupies a ranked
    `#` only when the v4 duel-count OR-gate still holds AND they are
    globally active (any appearance within 30 days of the newest corpus
    match, or 3-game comeback after a gap) AND command-recent (commanded
    within 90 days, or 3 commander games after going stale). Emits
    per-rating `inactive_status` / `command_status` (+ days / comeback
    counts) and top-level `inactivity_window_days` /
    `comeback_games_required` / `command_stale_window_days` /
    `corpus_latest_date`. Memo:
    critique/decisions/vtsr-inactivity-threshold.md.

v4 additions (schema 3 -> 4; ratings UNCHANGED -- display eligibility only):

  * LADDER GATE -- a commander occupies a ranked `#` when
    `duels_with_telemetry >= CMDR_LADDER_MIN_V4` (8) OR
    `duels_non_v4 >= CMDR_LADDER_MIN_NON_V4` (25). Older =
    F9 ledger + pre-v4 corpus (`matches_commanded_rated -
    duels_with_telemetry`). Emits per-rating `duels_non_v4` +
    `leaderboard_eligible` and top-level `leaderboard_min_v4` /
    `leaderboard_min_non_v4`. Memo:
    critique/decisions/vtsr-c-ladder-eligibility.md.

v3 additions (schema 2 -> 3; ratings not comparable with v2 values):

  * EXTERNAL DUELS -- pre-gated community games from
    data/external/f9_ledger.json (one-shot import of F9bomber's ledger;
    see scripts/import_f9_ledger.py + the decision memo
    critique/decisions/f9-external-duels.md). Outcome-pure S at
    k_factor(games) * CMDR_K_EXTERNAL_SCALE (1.0 = full K, operator-
    ratified as definitive), interleaved chronologically at day
    precision (after same-day telemetry, sheet-row order), team-strength
    handicap read from a running VTSR-T snapshot folded out of
    elo_history (empty pre-corpus -> handicap 0), W/L tallied into the
    headline record with per-rating `duels_external` + top-level
    `external_duels_rated` transparency counters, per-duel
    `source: "f9" | "telemetry"` provenance, and a runtime overlap guard
    (`external_skipped_overlap_runtime`) so a backfilled binpb of a
    ledger-covered lobby can never double-count.

v7 (schema 6 -> 7; ratings COMPARABLE with schema 6). Weight-0
`loose_share`. v8 keeps that axis at weight 0 but measures it over the
whole match (`income_loose / scrap_income`), not the opening window.
Ratings stay comparable. It does not enter P and does not reset the
promote clock.

v6 (schema 5 -> 6; ratings COMPARABLE with schema 5 -- audit axes
only). Opening-decision composite, still inert at CMDR_ALPHA_C = 1.0.
Amendment 2026-09-23 in critique/decisions/vtsr-c-v2-composite.md:

  * SCORED (higher = better decision in the opening):
        pool_tempo         seconds sooner to 3 pools (later than the
                           opening window, or never, censored at 240s)
        combat_conversion  opening combat-ship BUILD scrap / opening
                           income (1 Hz; first OPENING_WINDOW_SEC)
        regen_tempo        opening share of alive-recycler samples in
                           the red (fast-regen) band
  * AUDIT ONLY, weight 0 (visible, not in P):
        replacement_ratio  the old thug_supply formula (hulls per death)
        upgrade_share      the old upgrade_investment snapshot
        loose_share        whole-match loose collected / whole-match
                           income (weight 0)

v2 additions (consequence-free while CMDR_ALPHA_C == 1.0):

  * Economy axes computed per duel from the proto-v4 `economy` +
    `builds` match blocks (constructor-free by design -- era-mixed
    structure-completion quality must never feed a rating axis).
    The 2026-09-04 five-formula freeze is superseded by the v6
    amendment above; do not restore pool-integral / scrap-per-minute /
    ships-per-death / float / upgrade-share as scored axes.

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

  * PROMOTE RULE (2026-09-23 amendment; the 2026-09-04 rule is retired):
    the pre-amendment corpus is discovery only. Flip alpha_c below 1.0
    only on duels dated after ECON_SEMANTICS_AMENDED_ON, and only when
    that confirmation sample has >= 25 duels, >= 2 of 3 scored axes have
    a Wilson lower bound > 0.55, the close-game subset (n >= 15) is not
    below 0.50 on those axes, and an alpha ablation improves log-loss by
    >= 0.01 without worsening accuracy. Otherwise HOLD.

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

Corpus-wide, picker-unaware, NOT in the pipeline cache key. Experimental
posture: provisional-heavy labeling, visible game counts everywhere.

Algorithm spec: DEVELOPER_GUIDE.md section 13.8. Output schemas:
docs/DATA_DICTIONARY.md section 11.
"""

from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import identity_aliases
import inactivity

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
# this lives in critique/decisions/vtsr-c-v2-composite.md (2026-09-23
# amendment). The pre-amendment corpus is discovery only.
CMDR_ALPHA_C = 1.0

# Calendar day of the opening-semantics amendment. Confirmation duels are
# those whose match date is strictly after this day.
ECON_SEMANTICS_AMENDED_ON = "2026-09-23"

# Opening window for combat_conversion and regen_tempo. Matches the
# minimum rated-match length so the window is a decision period.
OPENING_WINDOW_SEC = 240.0

# Red-band height in the verified regen-segment model: the bottom
# `20 * upgrade_count` scrap is the fast (2/s) band.
REGEN_RED_SCRAP_PER_UPGRADE = 20.0

# Per-axis prior weights. Renormalized over available SCORED axes at
# runtime (weight 0 is audit-only and never enters P). Priors, not fitted.
# 0.43 / 0.35 / 0.22 renormalizes the old 0.30 / 0.25 / 0.15 priors.
COMMANDER_ECON_WEIGHTS = {
    "pool_tempo": 0.43,
    "combat_conversion": 0.35,
    "regen_tempo": 0.22,
    "replacement_ratio": 0.0,
    "upgrade_share": 0.0,
    "loose_share": 0.0,
}

# Seed prior for each axis's DIFFERENTIAL std (team-1-perspective
# v_own - v_opp spread). One-time scale anchor so z-scores do not
# saturate the clip. Sign does not depend on these. Do not refit.
# One-time RMS of team-1-perspective diffs on the 66-match discovery
# corpus (2026-09-23). Binding scale. Do not refit.
CMDR_ECON_STD_PRIOR = {
    "pool_tempo": 48.0,          # seconds-sooner diff
    "combat_conversion": 0.14,   # opening combat-scrap / income diff
    "regen_tempo": 0.054,        # red-share diff
    "replacement_ratio": 0.61,   # ships-per-loss diff (unscored)
    "upgrade_share": 0.25,       # upgrade-share diff (unscored)
    "loose_share": 0.11,         # whole-match loose/income diff (unscored)
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

# ---- v3: external community ledger (F9bomber) -----------------------------

# K multiplier applied to external (community-ledger) duels on top of the
# standard k_factor() schedule. 1.0 = full K: the operator ratified
# F9bomber's hand-logged outcomes as definitive (28/28 agreement with our
# telemetry on Steam64-paired overlapping games; pre-registered in
# critique/decisions/f9-external-duels.md). Lower to discount externals
# without a schema bump.
CMDR_K_EXTERNAL_SCALE = 1.0

# Credit metadata surfaced on elo_commander_current.json so UI credit
# lines never hardcode the provider.
EXTERNAL_PROVIDER_NAME = "F9bomber"
EXTERNAL_PROVIDER_URL = "https://f9bomber.com"

# Display-only ladder inclusion (schema 4). Ranked if v4 telemetry
# duels >= MIN_V4 OR older (F9 + pre-v4 corpus) duels >= MIN_NON_V4.
# Does NOT change ratings, K, or duel history -- only who may occupy
# a `#` on the ELO-page ladder / cohort strip / player-page rank.
# Frozen in critique/decisions/vtsr-c-ladder-eligibility.md; do not
# retune to chase a name.
CMDR_LADDER_MIN_V4 = 8
CMDR_LADDER_MIN_NON_V4 = 25

# Display-only inactivity + commander-stale gates (do NOT change ratings,
# K, or duel history). Global clock is shared with VTSR-T (30 days / 3
# games). Command clock: 90-day grace while still thugging, then 3
# commander games to re-rank. Frozen in
# critique/decisions/vtsr-inactivity-threshold.md.
INACTIVITY_WINDOW_DAYS = 30
COMEBACK_GAMES_REQUIRED = 3
CMDR_STALE_WINDOW_DAYS = 90

# v8: loose_share is the whole match, still weight 0. Ratings remain
# comparable with schema 7 (alpha_c stays 1; the axis does not enter P).
# v7: weight-0 loose_share audit axis. v6: opening-decision axes.
# v5: display inactivity. v3 ratings were not comparable with schema 2.
CMDR_ELO_SCHEMA_VERSION = 8


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ladder_eligible(duels_v4: int, duels_non_v4: int,
                    min_v4: int = CMDR_LADDER_MIN_V4,
                    min_non_v4: int = CMDR_LADDER_MIN_NON_V4) -> bool:
    """Display-only: may this commander occupy a ranked `#`?

    OR-gate: enough proto-v4 telemetry duels, or enough older games
    (F9 ledger + pre-v4 corpus). Ratings themselves are unaffected.
    """
    return duels_v4 >= min_v4 or duels_non_v4 >= min_non_v4


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


def _odf_stem(odf: Any) -> str:
    s = str(odf or "").strip().lower()
    if s.endswith(".odf"):
        s = s[:-4]
    return s


_COMBAT_STEMS_CACHE: frozenset[str] | None = None


def _resolve_combat_stems(explicit: Any) -> frozenset[str]:
    """Combat-ship stems for `combat_conversion`.

    Callers that already built the set (the pipeline) pass it in. A
    standalone recompute falls back to the committed
    `data/combat_ship_odfs.json` — the same classification
    `combat_ship_value` uses. That one read is the module's only I/O.
    """
    global _COMBAT_STEMS_CACHE
    if explicit is not None:
        return frozenset(_odf_stem(s) for s in explicit if _odf_stem(s))
    if _COMBAT_STEMS_CACHE is None:
        path = (Path(__file__).resolve().parent.parent
                / "data" / "combat_ship_odfs.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        _COMBAT_STEMS_CACHE = frozenset(
            _odf_stem(s) for s in (data.get("stems") or []) if _odf_stem(s))
    return _COMBAT_STEMS_CACHE


def _opening_sec(tick: Any, t0: float, tick_rate: float) -> float | None:
    if not isinstance(tick, (int, float)) or tick_rate <= 0:
        return None
    return (float(tick) - t0) / tick_rate


def _opening_income(scrap: list, ticks: list, t0: float, tick_rate: float) -> float:
    """Sum of positive 1 Hz bank deltas inside the opening window.

    Downsampled relative to the full-rate Tycoon income. Both sides use
    the same series, so the differential is the quantity that matters.
    """
    income = 0.0
    n = min(len(scrap), len(ticks))
    for i in range(1, n):
        sec = _opening_sec(ticks[i], t0, tick_rate)
        if sec is None:
            continue
        if sec > OPENING_WINDOW_SEC:
            break
        try:
            delta = float(scrap[i]) - float(scrap[i - 1])
        except (TypeError, ValueError):
            continue
        if delta > 0:
            income += delta
    return income


def _opening_combat_scrap(feed: list, side: int, stems: frozenset[str],
                          t0: float, tick_rate: float) -> float:
    """Combat-ship BUILD cost inside the opening window.

    Constructor builds are excluded, matching `combat_ship_value`
    (gun towers on the constructor lane are structures, not ships).
    """
    total = 0.0
    for row in feed:
        if row.get("type") != "build":
            continue
        if row.get("team") != side:
            continue
        if (row.get("producer") == "constructor"
                or row.get("producer_resolved") == "constructor"):
            continue
        sec = _opening_sec(row.get("tick"), t0, tick_rate)
        if sec is None or sec > OPENING_WINDOW_SEC:
            continue
        if _odf_stem(row.get("odf")) not in stems:
            continue
        cost = row.get("scrap_cost")
        if isinstance(cost, (int, float)):
            total += float(cost)
    return total


def _regen_tempo(team: dict, ticks: list, t0: float, tick_rate: float
                 ) -> float | None:
    """Share of opening samples spent in the fast-regen (red) band.

    Red = `scrap < 20 * upgrade_count` (verified segment model). Samples
    with a dead recycler (`max_scrap == 20 * pool_count`, the +40 base
    gone) are skipped. None when no alive-recycler sample falls in the
    window.
    """
    scrap = team.get("scrap") or []
    pools = team.get("pool_count") or []
    ups = team.get("upgrade_count") or []
    caps = team.get("max_scrap") or []
    n = min(len(scrap), len(pools), len(ups), len(caps), len(ticks))
    alive = 0
    red = 0
    for i in range(n):
        sec = _opening_sec(ticks[i], t0, tick_rate)
        if sec is None:
            continue
        if sec > OPENING_WINDOW_SEC:
            break
        try:
            pool = float(pools[i])
            cap = float(caps[i])
            bank = float(scrap[i])
            upgraded = float(ups[i])
        except (TypeError, ValueError):
            continue
        if cap == REGEN_RED_SCRAP_PER_UPGRADE * pool:
            continue
        alive += 1
        if bank < REGEN_RED_SCRAP_PER_UPGRADE * upgraded:
            red += 1
    if alive == 0:
        return None
    return red / alive


def _econ_axis_values(md: dict, combat_stems: frozenset[str]
                      ) -> dict[int, dict[str, float | None]] | None:
    """Per-side raw economy-axis values for one match, or None when the
    match lacks full v4 telemetry (either flag false / block missing).

    Formulas: critique/decisions/vtsr-c-v2-composite.md, 2026-09-23
    amendment. An axis is None when that side has no reading; the
    differential layer drops it unless BOTH sides are numeric.
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

    match = md.get("match") or {}
    duration_sec = match.get("duration_sec") or 0
    if not isinstance(duration_sec, (int, float)) or duration_sec <= 0:
        return None
    tick_rate = match.get("tick_rate") or 20
    if not isinstance(tick_rate, (int, float)) or tick_rate <= 0:
        tick_rate = 20
    tick_range = match.get("tick_range") or [0, 0]
    try:
        t0 = float(tick_range[0]) if tick_range else 0.0
    except (TypeError, ValueError, IndexError):
        t0 = 0.0
    ticks = econ.get("ticks") or []
    feed = builds.get("feed") or []

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

        # 3 pools, not 5. On this game's build clock, 5 extractors is a
        # mid-match event (typical time ~9 min) and almost never falls
        # inside the opening window, so a "time to 5" axis is a tie on
        # nearly every duel. 3 pools is the opening milestone (typical
        # ~3 min). Reaching it after the window, or never, is the same
        # failed open.
        t3 = et.get("time_to_3_pools_sec")
        if (isinstance(t3, (int, float)) and 0 <= float(t3) <= OPENING_WINDOW_SEC):
            clock = float(t3)
        else:
            clock = OPENING_WINDOW_SEC
        # Higher = sooner. The differential is seconds faster than the
        # opponent.
        pool_tempo = -clock

        income = _opening_income(et.get("scrap") or [], ticks, t0, tick_rate)
        combat = _opening_combat_scrap(feed, side, combat_stems, t0, tick_rate)
        combat_conversion = combat / max(income, 1.0)

        regen = _regen_tempo(et, ticks, t0, tick_rate)

        ships = bt.get("ships_built")
        replacement = None
        if isinstance(ships, (int, float)):
            replacement = min(
                THUG_SUPPLY_CAP, float(ships) / max(1, team_deaths[side]))

        upgrades = et.get("upgrades_final")
        peak_pools = et.get("peak_pools")
        upgrade_share = None
        if isinstance(upgrades, (int, float)) and isinstance(
                peak_pools, (int, float)) and peak_pools >= 1:
            upgrade_share = min(1.0, float(upgrades) / float(peak_pools))

        loose = et.get("income_loose")
        income_all = et.get("scrap_income")
        loose_share = None
        if isinstance(loose, (int, float)) and isinstance(
                income_all, (int, float)):
            loose_share = float(loose) / max(float(income_all), 1.0)

        out[side] = {
            "pool_tempo": pool_tempo,
            "combat_conversion": combat_conversion,
            "regen_tempo": regen,
            "replacement_ratio": replacement,
            "upgrade_share": upgrade_share,
            "loose_share": loose_share,
        }
    return out


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------

def compute_commander_elo(all_match_data: list[dict],
                          elo_history: dict,
                          external_duels: list[dict] | None = None,
                          external_overlap_ids: frozenset | set | None = None,
                          combat_ship_stems: Any = None,
                          ) -> tuple[dict, dict]:
    """Chronological VTSR-C walk over the canonical rated-match history.

    `all_match_data`: full per-match dicts (as held in-memory by
    scripts/process_stats.py at emit time).
    `elo_history`: the canonical VTSR-T history dict returned by
    `elo.compute_elo()` -- its `history` list is chronological and its
    per-match deltas carry the pre-match `before` ratings that feed the
    team-strength handicap.
    `external_duels`: optional pre-gated community duels from
    `data/external/f9_ledger.json` (`duels` list). Externals interleave
    chronologically -- day precision, sorted AFTER any same-day telemetry
    matches, sheet-row order within a day -- and score outcome-pure at
    `k_factor(games) * CMDR_K_EXTERNAL_SCALE`. Their team-strength
    handicap reads each resolved thug's then-current VTSR-T from a
    running snapshot folded out of `elo_history` (pre-corpus duels see an
    empty snapshot -> handicap 0, exactly like our own earliest matches).
    W/L records tally externals alongside telemetry; `rated_match_count`
    stays telemetry-only with externals counted in `external_duels_rated`.
    `external_overlap_ids`: match ids the importer already consumed as
    dual-records (`f9_ledger.json` `overlaps[].match_id`) -- excluded
    from the runtime overlap guard so a corpus match paired to one F9
    row cannot ALSO block a sibling rematch row (same night, same
    commanders, same roster, different map).

    `combat_ship_stems`: optional combat-ship ODF stems (the pipeline's
    `build_combat_ship_odfs` set). Used only by the inert
    `combat_conversion` axis. Omit it and the committed
    `data/combat_ship_odfs.json` is read once.

    Returns `(elo_commander_current, elo_commander_history)`.
    """
    combat_stems = _resolve_combat_stems(combat_ship_stems)
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
    # Dual recordings that share ONE match id produce TWO elo_history
    # entries (two submitters' files landing on the same second). One
    # physical game must rate exactly one duel -- the second entry is
    # skipped and counted here. (VTSR-T's own double-walk of such
    # entries is a separate pre-existing behavior, deliberately not
    # touched from this module.)
    rated_match_ids: set = set()
    skipped_duplicate_recording = 0

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

    # ---- v3: external community-ledger duels ----------------------------
    # Running per-player VTSR-T snapshot (steam64 str -> latest `after`),
    # folded from every telemetry history entry as the merged walk passes
    # it. Externals read their team-strength handicap from here; before
    # the first telemetry match it is empty -> handicap 0.
    vtsr_t_now: dict[str, float] = {}
    duels_external: dict[str, int] = {}
    external_rated = 0
    external_skipped_overlap = 0

    # Runtime overlap guard: a frozen ledger cannot know about binpb files
    # BACKFILLED after import. Skip an external when a corpus match sits
    # within +-1 day with the same commander-Steam64 pair and >= 60% of
    # the external's resolved participants on its leaderboard (expected 0
    # skips today; counted + WARNed so a future backfill can't
    # double-count a lobby).
    guard_index: list[tuple[date, frozenset, set]] = []
    if external_duels:
        consumed = external_overlap_ids or frozenset()
        for md in all_match_data:
            m = md.get("match") or {}
            if m.get("id") in consumed:
                # Already accounted for by the importer's one-to-one
                # pairing -- must not double-block a sibling F9 row.
                continue
            try:
                g_day = datetime.fromisoformat(
                    str(m.get("date") or "").replace("Z", "+00:00")).date()
            except ValueError:
                continue
            leaders = m.get("team_leaders") or {}
            pair = {str((leaders.get("1") or {}).get("s64") or ""),
                    str((leaders.get("2") or {}).get("s64") or "")} - {""}
            if len(pair) != 2:
                continue
            lobby_s64s = {str(row.get("steam64"))
                          for row in (md.get("leaderboard") or [])
                          if row.get("steam64")}
            guard_index.append((g_day, frozenset(pair), lobby_s64s))

    def _external_overlaps_corpus(duel: dict) -> bool:
        cmdrs = duel.get("commanders") or {}
        c1s = (cmdrs.get("1") or {}).get("steam64")
        c2s = (cmdrs.get("2") or {}).get("steam64")
        if not (c1s and c2s):
            return False
        try:
            ext_day = date.fromisoformat(str(duel.get("date") or ""))
        except ValueError:
            return False
        pair = frozenset((str(c1s), str(c2s)))
        participants = {str(c1s), str(c2s)}
        for side in ("1", "2"):
            for t in (duel.get("thugs") or {}).get(side) or []:
                if t.get("steam64"):
                    participants.add(str(t["steam64"]))
        for g_day, g_pair, g_lobby in guard_index:
            if abs((g_day - ext_day).days) > 1 or g_pair != pair:
                continue
            if len(participants & g_lobby) / len(participants) >= 0.6:
                return True
        return False

    # Merged chronological stream: telemetry entries keep their exact
    # history order via (day, 0, index); externals sort after same-day
    # telemetry via (day, 1, sheet_row). Day-precision interleaving is a
    # documented approximation -- F9 logs calendar days, not timestamps.
    events: list[tuple[tuple, str, Any]] = []
    for idx, entry in enumerate(elo_history.get("history") or []):
        day = str(entry.get("match_date") or "")[:10]
        events.append(((day, 0, idx), "telemetry", entry))
    for duel in (external_duels or []):
        events.append(((str(duel.get("date") or ""), 1,
                        int(duel.get("row") or 0)), "external", duel))
    events.sort(key=lambda e: e[0])

    for _sort_key, kind, payload in events:
        if kind == "external":
            duel = payload
            if _external_overlaps_corpus(duel):
                external_skipped_overlap += 1
                print(f"  WARN: F9 external duel r{duel.get('row')} "
                      f"({duel.get('date')} {duel.get('map_title')}) overlaps "
                      f"a corpus match; skipped (ours supersedes)")
                continue

            cmdrs = duel.get("commanders") or {}
            side_rows = {1: cmdrs.get("1") or {}, 2: cmdrs.get("2") or {}}
            win_side = duel.get("winner_side")
            if win_side not in (1, 2):
                # Importer guarantees this; defensive skip keeps the walk
                # alive on a hand-edited ledger.
                continue
            scores_ext = {win_side: 1.0, 3 - win_side: 0.0}

            # Team-strength handicap from the running VTSR-T snapshot
            # over each side's RESOLVED thugs (unrated/unresolved skip;
            # empty side -> None -> expected_score zeroes the term).
            t_means: dict[int, float | None] = {}
            for side in (1, 2):
                vals = [vtsr_t_now[str(t["steam64"])]
                        for t in (duel.get("thugs") or {}).get(str(side)) or []
                        if t.get("steam64")
                        and str(t["steam64"]) in vtsr_t_now]
                t_means[side] = (sum(vals) / len(vals)) if vals else None

            keys_ext = {s: _key(side_rows[s]) for s in (1, 2)}
            for side in (1, 2):
                k = keys_ext[side]
                if k not in rating:
                    rating[k] = CMDR_ELO_ANCHOR
                    games[k] = wins[k] = losses[k] = draws[k] = 0
                    peak[k] = CMDR_ELO_ANCHOR
                # Externals only seed a display name when the key is new;
                # telemetry appearances (canonical names) always win.
                if k not in display_name:
                    display_name[k] = side_rows[side].get("name") or ""
                pinned = identity_aliases.ALIAS_TARGET_NAMES_STR.get(k)
                if pinned:
                    display_name[k] = pinned
                if not steam64_out.get(k):
                    s64v = side_rows[side].get("steam64")
                    steam64_out[k] = str(s64v) if s64v else None

            r_before_ext = {s: rating[keys_ext[s]] for s in (1, 2)}
            e1_ext = expected_score(
                r_before_ext[1], r_before_ext[2], t_means[1], t_means[2]
            )
            expected_ext = {1: e1_ext, 2: 1.0 - e1_ext}
            sentinel = f"f9:{duel.get('row')}"

            duel_commanders_ext = {}
            for side in (1, 2):
                k = keys_ext[side]
                ki = k_factor(games[k]) * CMDR_K_EXTERNAL_SCALE
                dr = ki * (scores_ext[side] - expected_ext[side])
                r_after = r_before_ext[side] + dr
                rating[k] = r_after
                games[k] += 1
                if scores_ext[side] == 1.0:
                    wins[k] += 1
                else:
                    losses[k] += 1
                duels_external[k] = duels_external.get(k, 0) + 1
                if r_after > peak[k]:
                    peak[k] = r_after
                    peak_at[k] = sentinel
                    peak_date[k] = duel.get("date", "")
                elif k not in peak_at:
                    peak_at[k] = sentinel
                    peak_date[k] = duel.get("date", "")
                last_match[k] = sentinel
                last_delta[k] = dr
                duel_commanders_ext[str(side)] = {
                    "steam64": steam64_out.get(k),
                    "name": display_name.get(k, ""),
                    "before": round(r_before_ext[side], 2),
                    "after": round(r_after, 2),
                    "delta": round(dr, 2),
                    "expected": round(expected_ext[side], 4),
                    "k": round(ki, 2),
                    "score": scores_ext[side],
                    "score_blend": {
                        "alpha_c": CMDR_ALPHA_C,
                        "s_raw": scores_ext[side],
                        "s_blended": scores_ext[side],
                    },
                }

            t1m_ext, t2m_ext = t_means[1], t_means[2]
            duels.append({
                "match_id": "",
                "source": "f9",
                "external_row": duel.get("row"),
                "date": duel.get("date", ""),
                "map": duel.get("map_title", ""),
                "decided_by": "external",
                "adjudicated": False,
                "outcome": f"team{win_side}",
                "commanders": duel_commanders_ext,
                "team_handicap": {
                    "t1_thug_mean": (round(t1m_ext, 2)
                                     if t1m_ext is not None else None),
                    "t2_thug_mean": (round(t2m_ext, 2)
                                     if t2m_ext is not None else None),
                    "diff": (round(t1m_ext - t2m_ext, 2)
                             if (t1m_ext is not None and t2m_ext is not None)
                             else 0.0),
                    "lambda": CMDR_LAMBDA_TEAM_HANDICAP,
                },
                # Externals carry no v4 economy telemetry by definition.
                "performance": {"available": False},
            })
            external_rated += 1
            continue

        entry = payload
        # Fold this entry's post-match VTSR-T ratings into the running
        # snapshot FIRST -- later-sorted externals (same day or after)
        # must see post-match values; this entry's own handicap reads the
        # deltas' `before` fields via _team_thug_means, never the
        # snapshot, so folding early cannot leak into it.
        for d in (entry.get("deltas") or []):
            s64f = d.get("steam64")
            aft = d.get("after")
            if s64f is not None and isinstance(aft, (int, float)):
                vtsr_t_now[str(s64f)] = float(aft)
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
        if match_id in rated_match_ids:
            # Same-id dual recording already rated this game as a duel.
            skipped_duplicate_recording += 1
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
            pinned = identity_aliases.ALIAS_TARGET_NAMES_STR.get(k)
            if pinned:
                display_name[k] = pinned
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
        axis_vals = _econ_axis_values(md, combat_stems)
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
                    "weight": w,
                }
                # Weight 0 axes stay in the audit and the rolling std.
                # They do not enter P.
                if w > 0:
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
            "source": "telemetry",
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
        rated_match_ids.add(match_id)

    # Display-only activity clocks (global 30d + command 90d). Duels
    # above are unchanged; eligibility folds both clocks in at emit.
    # See scripts/inactivity.py.
    activity = inactivity.compute_activity(
        all_match_data,
        window_days=INACTIVITY_WINDOW_DAYS,
        comeback_games=COMEBACK_GAMES_REQUIRED,
        cmdr_stale_days=CMDR_STALE_WINDOW_DAYS,
        external_duels=external_duels,
    )

    ratings_out = []
    for k in rating:
        g = games[k]
        telem = duels_with_telemetry.get(k, 0)
        # Older = every rated duel that is not v4 telemetry: F9 ledger
        # + pre-v4 corpus. Partition of matches_commanded_rated.
        non_v4 = g - telem
        name = display_name.get(k, "")
        s64 = steam64_out.get(k)
        act = inactivity.lookup_activity(activity, s64, name)
        ratings_out.append({
            "name": name,
            "steam64": s64,
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
            "duels_with_telemetry": telem,
            # v3: duels sourced from the external community ledger
            # (included in matches_commanded_rated + the W/L record).
            "duels_external": duels_external.get(k, 0),
            # v4: display-only ladder inclusion. Ratings unchanged.
            "duels_non_v4": non_v4,
            # v5: also requires globally active AND command-recent.
            "leaderboard_eligible": (
                ladder_eligible(telem, non_v4)
                and bool(act["active"])
                and bool(act["command_active"])
            ),
            "inactive_status": act["inactive_status"],
            "days_since_last_match": act["days_since_last_match"],
            "last_seen_date": act["last_seen_date"],
            "comeback_games_played": act["comeback_games_played"],
            "comeback_games_remaining": act["comeback_games_remaining"],
            "command_status": act["command_status"],
            "days_since_last_command": act["days_since_last_command"],
            "last_command_date": act["last_command_date"],
            "command_comeback_games_played": act["command_comeback_games_played"],
            "command_comeback_remaining": act["command_comeback_remaining"],
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
        # v4: display-only ranked-ladder gate (UI reads these; do not
        # hardcode 8/25 in JS). See critique/decisions/vtsr-c-ladder-eligibility.md.
        "leaderboard_min_v4": CMDR_LADDER_MIN_V4,
        "leaderboard_min_non_v4": CMDR_LADDER_MIN_NON_V4,
        # v5: display-only inactivity + commander-stale clocks.
        # critique/decisions/vtsr-inactivity-threshold.md.
        "inactivity_window_days": INACTIVITY_WINDOW_DAYS,
        "comeback_games_required": COMEBACK_GAMES_REQUIRED,
        "command_stale_window_days": CMDR_STALE_WINDOW_DAYS,
        "corpus_latest_date": activity["corpus_latest_date"],
        "computed_at": computed_at,
        "rated_match_count": rated_match_count,
        "matches_skipped_undetermined": skipped_undetermined,
        "matches_skipped_missing_commander": skipped_missing_commander,
        "matches_skipped_duplicate_recording": skipped_duplicate_recording,
        # v3: external community ledger (F9bomber). rated_match_count
        # stays telemetry-only; externals are counted separately.
        "k_external_scale": CMDR_K_EXTERNAL_SCALE,
        "external_duels_rated": external_rated,
        "external_skipped_overlap_runtime": external_skipped_overlap,
        "external_provider": (
            {"name": EXTERNAL_PROVIDER_NAME, "url": EXTERNAL_PROVIDER_URL}
            if external_rated else None
        ),
        # v2: economy-performance composite constants + rolling-std
        # telemetry (inert at alpha_c = 1.0; see the decision memo).
        "alpha_c": CMDR_ALPHA_C,
        "econ_weights": dict(COMMANDER_ECON_WEIGHTS),
        "econ_std_prior": dict(CMDR_ECON_STD_PRIOR),
        "econ_std_shrinkage": CMDR_ECON_STD_SHRINKAGE,
        "opening_window_sec": OPENING_WINDOW_SEC,
        "econ_semantics_amended_on": ECON_SEMANTICS_AMENDED_ON,
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
