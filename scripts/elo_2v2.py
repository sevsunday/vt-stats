"""VTSR-2v2 -- separate ladders for two commanders each with one thug.

Neither main ladder fits a 2v2: VTSR-T z-scores enemy-damage share across
a lobby of at least six and drops every 2v2 as `low_player_count`, and
VTSR-C only rates matches VTSR-T kept. So these ladders cannot
double-count and must never feed back into VTSR-T, VTSR-C or VTSR-1v1.

Pure module, no I/O. `compute_2v2_elo(all_match_data, match_names=...)`
returns `(elo_2v2_current, elo_2v2_history)` dicts ready for `json.dump`.

Three ratings, each its own ladder:

  * VTSR-2v2C (`commander`)      -- commander, win/loss.
  * VTSR-2v2T win/loss (`thug_wl`) -- thug, win/loss, in the SAME walk:
        E1 = 1 / (1 + 10^(-((C1 - C2) + LAMBDA (T1 - T2)) / 400))
        dC = Kc (S - E),  dT = Kt (S - E)
  * VTSR-2v2T performance (`thug_perf`) -- thug vs thug damage duel,
    recorded games only:
        S_A = e_A / (e_A + e_B),  e = personal.enemy_dealt
        E_A = 1 / (1 + 10^(-(R_A - R_B) / 400)),  dR = K (S_A - E_A)

Every role uses ONE K per game (the mean of both players' scheduled K,
40 -> 20 over their first 5 games in that ladder), so each role is
exactly zero-sum. Anchor 1500, no floor, no seeding.

Eligible games:
  * recorded strict 2v2s (scripts/match_format.py: two non-campod rows per
    side, each side's commander among them, all four active); not void,
    not cancelled, at least TWO_V_TWO_MIN_DURATION_SEC. The win/loss walk
    also needs a determined winner or a draw; the performance duel does
    not, but skips games where both thugs dealt 0.

Recorded games only: F9bomber's 2v2 rows were removed by operator
decision (memo amendment, 2026-10-27), and the activity clock reads the
recorded corpus only, as VTSR-1v1 does.

Decision memo: critique/decisions/vtsr-2v2-ladders.md. Output files
(written by scripts/process_stats.py, both in the load_cache_index skip
set): data/processed/elo_2v2_current.json + elo_2v2_history.json.
Corpus-wide, picker-unaware, NOT in the pipeline cache key. Spec:
DEVELOPER_GUIDE.md section 13.16; schemas: docs/DATA_DICTIONARY.md
section 19.
"""

from __future__ import annotations

from datetime import datetime, timezone

import identity_aliases
import inactivity
import match_format

# ---------------------------------------------------------------------------
# Constants (frozen in critique/decisions/vtsr-2v2-ladders.md)
# ---------------------------------------------------------------------------

TWO_V_TWO_ANCHOR = 1500.0
TWO_V_TWO_K_BASE = 40.0
TWO_V_TWO_K_FLOOR = 20.0
TWO_V_TWO_PROVISIONAL_PRIOR = 5.0
TWO_V_TWO_PROVISIONAL_THRESHOLD = 5
TWO_V_TWO_LOGISTIC_SCALE = 400.0
TWO_V_TWO_LAMBDA = 1.0
TWO_V_TWO_MIN_DURATION_SEC = 240

# Display-only ranked-table gate. Do not lower it to fill the table.
TWO_V_TWO_LADDER_MIN_GAMES = 5
INACTIVITY_WINDOW_DAYS = 90
COMEBACK_GAMES_REQUIRED = 3

DETERMINED_DECIDED_BY = ("adjudicated", "attested", "clean_win", "contested")

LADDERS = ("commander", "thug_wl", "thug_perf")

ELO_2V2_SCHEMA_VERSION = 2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def logistic(diff: float) -> float:
    return 1.0 / (1.0 + 10.0 ** (-diff / TWO_V_TWO_LOGISTIC_SCALE))


def win_chance(c1: float, c2: float, t1: float, t2: float,
               lam: float = TWO_V_TWO_LAMBDA) -> float:
    """Team 1's win chance: commander gap + lambda x thug gap."""
    return logistic((c1 - c2) + lam * (t1 - t2))


def k_factor(games: int) -> float:
    frac = max(0.0, 1.0 - games / TWO_V_TWO_PROVISIONAL_PRIOR)
    return TWO_V_TWO_K_FLOOR + (TWO_V_TWO_K_BASE - TWO_V_TWO_K_FLOOR) * frac


def perf_score(e1: float, e2: float) -> float | None:
    """Thug 1's share of the two thugs' enemy damage; None when both are 0."""
    total = e1 + e2
    if total <= 0:
        return None
    return e1 / total


def _key(steam64, name) -> str:
    return str(steam64) if steam64 else f"name:{name or ''}"


def _enemy_dealt(row: dict) -> float:
    personal = row.get("personal") or {}
    try:
        return max(0.0, float(personal.get("enemy_dealt") or 0.0))
    except (TypeError, ValueError):
        return 0.0


def _faction_name(m: dict, side: int) -> str | None:
    fac = (m.get("team_factions") or {}).get(str(side))
    return fac.get("name") if isinstance(fac, dict) else None


def _day(value: str | None) -> str:
    return str(value or "")[:10]


class _Ladder:
    """Rating state for one ladder. Bookkeeping only; the caller supplies
    the zero-sum delta."""

    def __init__(self, name: str):
        self.name = name
        self.rating: dict[str, float] = {}
        self.games: dict[str, int] = {}
        self.wins: dict[str, int] = {}
        self.losses: dict[str, int] = {}
        self.draws: dict[str, int] = {}
        self.beat: dict[str, int] = {}
        self.score_sum: dict[str, float] = {}
        self.peak: dict[str, float] = {}
        self.peak_at: dict[str, str] = {}
        self.peak_date: dict[str, str] = {}
        self.last_game: dict[str, str] = {}
        self.last_date: dict[str, str] = {}
        self.last_delta: dict[str, float] = {}
        self.history: dict[str, list[float]] = {}
        self.games_rated = 0

    def ensure(self, k: str) -> None:
        if k not in self.rating:
            self.rating[k] = TWO_V_TWO_ANCHOR
            self.peak[k] = TWO_V_TWO_ANCHOR
            for d in (self.games, self.wins, self.losses, self.draws, self.beat):
                d[k] = 0
            self.score_sum[k] = 0.0

    def k_game(self, a: str, b: str) -> float:
        return (k_factor(self.games[a]) + k_factor(self.games[b])) / 2.0

    def apply(self, k: str, delta: float, score: float, expected: float,
              game_id: str, date: str) -> tuple[float, float]:
        before = self.rating[k]
        after = before + delta
        self.rating[k] = after
        self.games[k] += 1
        self.score_sum[k] += score
        if score > expected:
            self.beat[k] += 1
        if after > self.peak[k] or k not in self.peak_at:
            if after > self.peak[k]:
                self.peak[k] = after
            self.peak_at[k] = game_id
            self.peak_date[k] = date
        self.last_game[k] = game_id
        self.last_date[k] = date
        self.last_delta[k] = delta
        wh = self.history.setdefault(k, [])
        wh.append(round(delta, 2))
        if len(wh) > 10:
            del wh[: len(wh) - 10]
        return before, after

    def record_result(self, k: str, team_score: float) -> None:
        if team_score == 1.0:
            self.wins[k] += 1
        elif team_score == 0.0:
            self.losses[k] += 1
        else:
            self.draws[k] += 1


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def compute_2v2_elo(all_match_data: list[dict],
                    match_names: dict[str, str] | None = None,
                    canonical_names: dict[str, str] | None = None,
                    ) -> tuple[dict, dict]:
    """Chronological walk over recorded strict 2v2s.

    `match_names`: match id -> display map name (manifest `name`).
    `canonical_names`: Steam64 -> canonical display name
    (data/steamid_to_name.txt), used when a row carries no name.
    """
    names = match_names or {}
    canon = canonical_names or {}
    ladders = {n: _Ladder(n) for n in LADDERS}
    display_name: dict[str, str] = {}
    steam64_out: dict[str, str | None] = {}

    def note_identity(k: str, s64, name: str) -> None:
        pinned = identity_aliases.ALIAS_TARGET_NAMES_STR.get(k)
        if pinned:
            display_name[k] = pinned
        elif name:
            display_name[k] = name
        elif k not in display_name:
            display_name[k] = canon.get(str(s64)) if s64 and canon.get(str(s64)) else (name or "")
        if not steam64_out.get(k):
            steam64_out[k] = str(s64) if s64 else None

    skipped = {
        "void": 0,
        "short": 0,
        "cancelled": 0,
        "inactive_player": 0,
        "duplicate_recording": 0,
        "identity_collision": 0,
    }
    wl_undetermined = 0
    perf_no_damage = 0
    shape_seen = 0

    # ---- collect eligible recorded games -----------------------------------
    events: list[tuple] = []
    seen_ids: set[str] = set()
    for md in all_match_data:
        pair = match_format.two_v_two_shape(md)
        if pair is None:
            continue
        shape_seen += 1
        m = md.get("match") or {}
        match_id = str(m.get("id") or "")
        if m.get("void"):
            skipped["void"] += 1
            continue
        if match_format.inactive_rows(pair):
            skipped["inactive_player"] += 1
            continue
        if (m.get("duration_sec") or 0) < TWO_V_TWO_MIN_DURATION_SEC:
            skipped["short"] += 1
            continue
        winner = m.get("winner") or {}
        if winner.get("decided_by") == "cancelled":
            skipped["cancelled"] += 1
            continue
        if match_id in seen_ids:
            skipped["duplicate_recording"] += 1
            continue
        seen_ids.add(match_id)
        dt = inactivity.parse_match_date(m.get("date"))
        events.append((_day(m.get("date")), dt.timestamp() if dt else 0.0,
                       match_id, md, pair))

    events.sort(key=lambda e: (e[0], e[1], e[2]))

    # ---- walk --------------------------------------------------------------
    games_out: list[dict] = []
    cmdr_l, twl_l, tperf_l = ladders["commander"], ladders["thug_wl"], ladders["thug_perf"]
    for _day_key, _order, game_id, md, pair in events:
        m = md.get("match") or {}
        date = str(m.get("date") or "")
        ids = {s: {role: (pair[s][role].get("steam64"), pair[s][role].get("name") or "")
                   for role in ("commander", "thug")} for s in (1, 2)}
        winner = m.get("winner") or {}
        decided_by = winner.get("decided_by")
        team = winner.get("team")
        if decided_by == "draw":
            scores = {1: 0.5, 2: 0.5}
            outcome = "draw"
        elif decided_by in DETERMINED_DECIDED_BY and team in (1, 2):
            scores = {team: 1.0, 3 - team: 0.0}
            outcome = f"team{team}"
        else:
            scores = None
            outcome = None

        keys = {s: {role: _key(*ids[s][role]) for role in ("commander", "thug")}
                for s in (1, 2)}
        flat = [keys[s][r] for s in (1, 2) for r in ("commander", "thug")]
        if len(set(flat)) != 4:
            skipped["identity_collision"] += 1
            continue
        for s in (1, 2):
            for role in ("commander", "thug"):
                s64, nm = ids[s][role]
                note_identity(keys[s][role], s64, nm)

        game: dict = {
            "game_id": game_id,
            "source": "recorded",
            "match_id": game_id,
            "date": date,
            "decided_by": decided_by,
            "outcome": outcome,
            "wl": None,
            "perf": None,
            "map": names.get(game_id) or str(m.get("map") or ""),
            "map_file": str(m.get("map") or ""),
            "duration_sec": m.get("duration_sec"),
            "factions": {"1": _faction_name(m, 1), "2": _faction_name(m, 2)},
            "adjudicated": bool(winner.get("adjudicated")),
        }

        sides_out: dict[str, dict] = {}
        for s in (1, 2):
            sides_out[str(s)] = {
                role: {"steam64": steam64_out.get(keys[s][role]),
                       "name": display_name.get(keys[s][role], "")}
                for role in ("commander", "thug")
            }

        # Win/loss walk (commander + thug_wl).
        if scores is not None:
            for s in (1, 2):
                cmdr_l.ensure(keys[s]["commander"])
                twl_l.ensure(keys[s]["thug"])
            c = {s: cmdr_l.rating[keys[s]["commander"]] for s in (1, 2)}
            t = {s: twl_l.rating[keys[s]["thug"]] for s in (1, 2)}
            e1 = win_chance(c[1], c[2], t[1], t[2])
            expected = {1: e1, 2: 1.0 - e1}
            kc = cmdr_l.k_game(keys[1]["commander"], keys[2]["commander"])
            kt = twl_l.k_game(keys[1]["thug"], keys[2]["thug"])
            dc1 = kc * (scores[1] - expected[1])
            dt1 = kt * (scores[1] - expected[1])
            for s in (1, 2):
                sign = 1.0 if s == 1 else -1.0
                ck, tk = keys[s]["commander"], keys[s]["thug"]
                cb, ca = cmdr_l.apply(ck, sign * dc1, scores[s], expected[s], game_id, date)
                tb, ta = twl_l.apply(tk, sign * dt1, scores[s], expected[s], game_id, date)
                cmdr_l.record_result(ck, scores[s])
                twl_l.record_result(tk, scores[s])
                sides_out[str(s)]["commander"]["wl"] = {
                    "before": round(cb, 2), "after": round(ca, 2), "delta": round(sign * dc1, 2)}
                sides_out[str(s)]["thug"]["wl"] = {
                    "before": round(tb, 2), "after": round(ta, 2), "delta": round(sign * dt1, 2)}
            cmdr_l.games_rated += 1
            twl_l.games_rated += 1
            game["wl"] = {
                "expected": {"1": round(expected[1], 4), "2": round(expected[2], 4)},
                "score": {"1": scores[1], "2": scores[2]},
                "k_commander": round(kc, 2),
                "k_thug": round(kt, 2),
                "lambda": TWO_V_TWO_LAMBDA,
            }
        else:
            wl_undetermined += 1

        # Performance duel + recorded-not-scored context.
        e = {s: {role: _enemy_dealt(pair[s][role]) for role in ("commander", "thug")}
             for s in (1, 2)}
        for s in (1, 2):
            side_total = e[s]["commander"] + e[s]["thug"]
            sides_out[str(s)]["commander"]["enemy_dealt"] = round(e[s]["commander"], 1)
            sides_out[str(s)]["thug"]["enemy_dealt"] = round(e[s]["thug"], 1)
            sides_out[str(s)]["commander"]["combat_share"] = (
                round(e[s]["commander"] / side_total, 4) if side_total > 0 else None)
        s1 = perf_score(e[1]["thug"], e[2]["thug"])
        if s1 is None:
            perf_no_damage += 1
        else:
            for s in (1, 2):
                tperf_l.ensure(keys[s]["thug"])
            tk1, tk2 = keys[1]["thug"], keys[2]["thug"]
            pe1 = logistic(tperf_l.rating[tk1] - tperf_l.rating[tk2])
            pexp = {1: pe1, 2: 1.0 - pe1}
            pscore = {1: s1, 2: 1.0 - s1}
            kp = tperf_l.k_game(tk1, tk2)
            dp1 = kp * (pscore[1] - pexp[1])
            for s in (1, 2):
                sign = 1.0 if s == 1 else -1.0
                pb, pa = tperf_l.apply(keys[s]["thug"], sign * dp1, pscore[s],
                                       pexp[s], game_id, date)
                if scores is not None:
                    tperf_l.record_result(keys[s]["thug"], scores[s])
                sides_out[str(s)]["thug"]["perf"] = {
                    "before": round(pb, 2), "after": round(pa, 2),
                    "delta": round(sign * dp1, 2)}
            tperf_l.games_rated += 1
            game["perf"] = {
                "expected": {"1": round(pexp[1], 4), "2": round(pexp[2], 4)},
                "score": {"1": round(pscore[1], 4), "2": round(pscore[2], 4)},
                "k": round(kp, 2),
            }

        if game["wl"] is None and game["perf"] is None:
            continue
        game["sides"] = sides_out
        games_out.append(game)

    activity = inactivity.compute_activity(
        all_match_data,
        window_days=INACTIVITY_WINDOW_DAYS,
        comeback_games=COMEBACK_GAMES_REQUIRED,
    )

    def ratings_for(lad: _Ladder) -> list[dict]:
        out = []
        for k in lad.rating:
            g = lad.games[k]
            name = display_name.get(k, "")
            s64 = steam64_out.get(k)
            act = inactivity.lookup_activity(activity, s64, name)
            decided = lad.wins[k] + lad.losses[k] + lad.draws[k]
            row = {
                "name": name,
                "steam64": s64,
                "rating": round(lad.rating[k], 2),
                "games": g,
                "wins": lad.wins[k],
                "losses": lad.losses[k],
                "draws": lad.draws[k],
                "win_pct": round(lad.wins[k] / decided, 3) if decided else None,
                "peak": round(lad.peak[k], 2),
                "peak_at": lad.peak_at.get(k, ""),
                "peak_date": lad.peak_date.get(k, ""),
                "last_game_id": lad.last_game.get(k, ""),
                "last_2v2_date": lad.last_date.get(k, "")[:10],
                "last_delta": round(lad.last_delta.get(k, 0.0), 2),
                "win_history": list(lad.history.get(k, [])),
                "provisional": g < TWO_V_TWO_PROVISIONAL_THRESHOLD,
                "leaderboard_eligible": (
                    g >= TWO_V_TWO_LADDER_MIN_GAMES and bool(act["active"])
                ),
                "inactive_status": act["inactive_status"],
                "days_since_last_match": act["days_since_last_match"],
                "last_seen_date": act["last_seen_date"],
                "comeback_games_remaining": act["comeback_games_remaining"],
            }
            if lad.name == "thug_perf":
                row["beat_expected"] = lad.beat[k]
                row["mean_score"] = round(lad.score_sum[k] / g, 4) if g else None
            out.append(row)
        out.sort(key=lambda r: (-r["rating"], r["name"].lower()))
        return out

    wl_games = sum(1 for gm in games_out if gm["wl"])
    common = {
        "schema_version": ELO_2V2_SCHEMA_VERSION,
        "computed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "anchor": TWO_V_TWO_ANCHOR,
        "k_base": TWO_V_TWO_K_BASE,
        "k_floor": TWO_V_TWO_K_FLOOR,
        "provisional_prior": TWO_V_TWO_PROVISIONAL_PRIOR,
        "provisional_threshold": TWO_V_TWO_PROVISIONAL_THRESHOLD,
        "logistic_scale": TWO_V_TWO_LOGISTIC_SCALE,
        "lambda": TWO_V_TWO_LAMBDA,
        "min_duration_sec": TWO_V_TWO_MIN_DURATION_SEC,
        "leaderboard_min_games": TWO_V_TWO_LADDER_MIN_GAMES,
        "inactivity_window_days": INACTIVITY_WINDOW_DAYS,
        "comeback_games_required": COMEBACK_GAMES_REQUIRED,
        "corpus_latest_date": activity["corpus_latest_date"],
        "two_v_two_shape_seen": shape_seen,
        "games_rated": len(games_out),
        "wl_games_rated": wl_games,
        "perf_games_rated": tperf_l.games_rated,
        "skipped_void": skipped["void"],
        "skipped_short": skipped["short"],
        "skipped_cancelled": skipped["cancelled"],
        "skipped_inactive_player": skipped["inactive_player"],
        "skipped_duplicate_recording": skipped["duplicate_recording"],
        "skipped_identity_collision": skipped["identity_collision"],
        "wl_skipped_undetermined": wl_undetermined,
        "perf_skipped_no_damage": perf_no_damage,
    }
    current = dict(common)
    current["ladders"] = {
        n: {"games_rated": ladders[n].games_rated, "ratings": ratings_for(ladders[n])}
        for n in LADDERS
    }
    history = dict(common)
    history["games"] = games_out
    return current, history
