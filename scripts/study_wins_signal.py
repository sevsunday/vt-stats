"""How much of a team result belongs to one thug?

Standalone and stdlib-only; not invoked by the pipeline. Reads
``data/processed/`` (elo_history, elo_commander_history, elo_current, the
manifest and per-match leaderboards) and writes
``_validation/wins_signal.{md,json}``. Nothing under data/ is written.

Run from the repo root::

    python scripts/study_wins_signal.py

Definitions (fixed before the first run, critique/decisions/phase-5-wins-blend.md):

* B1 split-half reliability. Canonical elo_history rows carrying a ``wins``
  block, thug rows only (``is_commander`` false in the per-match
  leaderboard), players with >= RELIABILITY_MIN_ROWS such rows. Each
  player's rows in date order split into odd and even games; Pearson r
  between the half means across players, then Spearman-Brown 2r / (1 + r).
  Computed for ``performance`` and for the match result ``wins.s`` on the
  identical rows (same method as ``reliability()`` in vtsr_t_variants.py).
* B2 commander placement. Same players and rows. Per game, expected
  result = sigma((R_own_cmdr - R_opp_cmdr) / 400) from the two commanders'
  ``before`` in elo_commander_history; no thug rating enters. Games with
  no duel row are skipped and counted. Across players: Pearson r and r^2
  of actual win rate vs commander-expected win rate, and the mean
  |actual - expected| in wins per 100 games.
* B3 worked example. Most recent decided rated match with >= 3 wins-rated
  rows per side: side, s, e, delta and implied K = delta / (s - e).
* B4 the section 15 level offset. Players with >= PERF_VS_WINS_MIN_MATCHES
  matches: mean / SD of thug_elo and wins_elo, raw gap thug - wins, and the
  gap after centring each ladder on its own cohort mean.
"""

from __future__ import annotations

import json
import math
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROCESSED = os.path.join(ROOT, "data", "processed")
OUT_DIR = os.path.join(ROOT, "_validation")

DETERMINED = ("adjudicated", "attested", "clean_win", "contested")
RELIABILITY_MIN_ROWS = 16
PERF_VS_WINS_MIN_MATCHES = 20
LOGISTIC_SCALE = 400.0
HALF_BAND = 100.0
EXAMPLE_MIN_ROWS_PER_SIDE = 3


def load(name):
    with open(os.path.join(PROCESSED, name), encoding="utf-8") as f:
        return json.load(f)


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def sd(xs):
    if len(xs) < 2:
        return float("nan")
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return float("nan")
    mx, my = mean(xs), mean(ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else float("nan")


def sigmoid_gap(gap):
    return 1.0 / (1.0 + 10 ** (-gap / LOGISTIC_SCALE))


def split_half(per_player):
    odd, even = [], []
    for vals in per_player.values():
        odd.append(mean(vals[0::2]))
        even.append(mean(vals[1::2]))
    r = pearson(odd, even)
    return {"players": len(odd), "r": r, "spearman_brown": 2 * r / (1 + r) if r == r else r}


def match_meta():
    meta = {}
    for entry in load("matches.json"):
        path = os.path.join(PROCESSED, entry["file"])
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            md = json.load(f)
        m = md["match"]
        w = m.get("winner") or {}
        decided = w.get("decided_by") in DETERMINED and w.get("team") in (1, 2)
        meta[m["id"]] = {
            "date": m.get("date") or "",
            "winner": w.get("team") if decided else None,
            "rows": {
                str(r.get("steam64")): (bool(r.get("is_commander")), r.get("faction"))
                for r in md.get("leaderboard") or []
            },
        }
    return meta


def duel_ratings():
    out = {}
    for du in load("elo_commander_history.json").get("duels") or []:
        if du.get("source") != "telemetry":
            continue
        c = du.get("commanders") or {}
        if "1" in c and "2" in c:
            out[du["match_id"]] = {1: c["1"]["before"], 2: c["2"]["before"]}
    return out


def thug_rows(hist, meta):
    """Per player: date-ordered (match_id, side, performance, s) thug rows."""
    per = defaultdict(list)
    for h in sorted(hist["history"], key=lambda h: (h.get("match_date") or "", h["match_id"])):
        if h.get("match_excluded"):
            continue
        rows = (meta.get(h["match_id"]) or {}).get("rows") or {}
        for d in h["deltas"]:
            isc, fac = rows.get(str(d.get("steam64")), (False, None))
            wins = d.get("wins")
            if isc or fac not in (1, 2) or not wins or d.get("performance") is None:
                continue
            per[str(d["steam64"])].append((h["match_id"], fac, d["performance"], wins["s"]))
    return {k: v for k, v in per.items() if len(v) >= RELIABILITY_MIN_ROWS}


def study_b1(rows):
    perf = split_half({k: [r[2] for r in v] for k, v in rows.items()})
    res = split_half({k: [r[3] for r in v] for k, v in rows.items()})
    return {
        "players": len(rows),
        "rows": sum(len(v) for v in rows.values()),
        "min_rows": RELIABILITY_MIN_ROWS,
        "performance": perf,
        "result": res,
    }


def study_b2(rows, duels):
    actual, expected, skipped, used = [], [], 0, 0
    for vals in rows.values():
        a, e = [], []
        for mid, fac, _perf, s in vals:
            du = duels.get(mid)
            if not du:
                skipped += 1
                continue
            a.append(s)
            e.append(sigmoid_gap(du[fac] - du[3 - fac]))
        if a:
            actual.append(mean(a))
            expected.append(mean(e))
            used += len(a)
    r = pearson(expected, actual)
    return {
        "players": len(actual),
        "games_used": used,
        "games_skipped_no_duel": skipped,
        "pearson_r": r,
        "r_squared": r * r if r == r else r,
        "mean_abs_gap_per_100": 100 * mean([abs(x - y) for x, y in zip(actual, expected)]),
        "caveat": (
            "Commander ratings were built partly from games these thugs played in, "
            "so this is descriptive, not causal."
        ),
    }


def study_b3(hist, meta):
    for h in sorted(hist["history"], key=lambda h: (h.get("match_date") or "", h["match_id"]), reverse=True):
        mm = meta.get(h["match_id"])
        if h.get("match_excluded") or not mm or mm["winner"] is None:
            continue
        sides = {1: [], 2: []}
        for d in h["deltas"]:
            isc, fac = mm["rows"].get(str(d.get("steam64")), (False, None))
            if fac in (1, 2) and d.get("wins"):
                sides[fac].append((isc, d["wins"]))
        if min(len(sides[1]), len(sides[2])) < EXAMPLE_MIN_ROWS_PER_SIDE:
            continue
        out = []
        for fac in (1, 2):
            letter = 0
            for isc, w in sorted(sides[fac], key=lambda t: not t[0]):
                if isc:
                    label = f"Team {fac} commander"
                else:
                    label = f"Team {fac} thug {chr(ord('A') + letter)}"
                    letter += 1
                diff = w["s"] - w["e"]
                out.append({
                    "label": label, "side": fac, "s": w["s"], "e": w["e"],
                    "delta": w["delta"], "implied_k": w["delta"] / diff if diff else None,
                })
        return {"match_id": h["match_id"], "date": mm["date"], "winner": mm["winner"], "rows": out}
    return None


def study_b4(current):
    coh = [
        r for r in current.get("ratings") or []
        if isinstance(r.get("matches_played"), int) and r["matches_played"] >= PERF_VS_WINS_MIN_MATCHES
        and isinstance(r.get("thug_elo"), (int, float)) and isinstance(r.get("wins_elo"), (int, float))
    ]
    t = [float(r["thug_elo"]) for r in coh]
    w = [float(r["wins_elo"]) for r in coh]
    mt, mw = mean(t), mean(w)
    raw = [a - b for a, b in zip(t, w)]
    cen = [(a - mt) - (b - mw) for a, b in zip(t, w)]
    return {
        "players": len(coh),
        "min_matches": PERF_VS_WINS_MIN_MATCHES,
        "thug_elo": {"mean": mt, "sd": sd(t)},
        "wins_elo": {"mean": mw, "sd": sd(w)},
        "raw": {
            "players_higher_on_performance": sum(1 for g in raw if g > 0),
            "mean_gap": mean(raw),
            "mean_abs_gap": mean([abs(g) for g in raw]),
        },
        "centred": {
            "players_higher_on_performance": sum(1 for g in cen if g > 0),
            "mean_abs_gap": mean([abs(g) for g in cen]),
            "mean_abs_gap_half_bands": mean([abs(g) for g in cen]) / HALF_BAND,
        },
    }


def fmt(x, nd=3):
    return "n/a" if x is None or x != x else f"{x:.{nd}f}"


def write_md(res):
    b1, b2, b3, b4 = res["b1"], res["b2"], res["b3"], res["b4"]
    lines = [
        "# How much of a team result belongs to one thug?",
        "",
        f"Snapshot: `elo_current.json` computed_at {res['computed_at']}. "
        "Generated by `python scripts/study_wins_signal.py`.",
        "",
        "## B1. Split-half reliability, identical thug rows",
        "",
        f"{b1['players']} players with >= {b1['min_rows']} wins-rated thug rows ({b1['rows']} rows).",
        "",
        "| Score | Half-vs-half r | Spearman-Brown |",
        "|-------|---------------|----------------|",
        f"| Performance (`performance`) | {fmt(b1['performance']['r'])} | {fmt(b1['performance']['spearman_brown'])} |",
        f"| Match result (`wins.s`) | {fmt(b1['result']['r'])} | {fmt(b1['result']['spearman_brown'])} |",
        "",
        "## B2. Thug win rate vs commander-expected win rate",
        "",
        f"{b2['players']} players, {b2['games_used']} games ({b2['games_skipped_no_duel']} skipped: no duel row).",
        f"Pearson r {fmt(b2['pearson_r'])}, r^2 {fmt(b2['r_squared'])}; "
        f"mean |actual - expected| {fmt(b2['mean_abs_gap_per_100'], 1)} wins per 100 games.",
        "",
        b2["caveat"],
        "",
        "## B3. Worked example of the shared update",
        "",
    ]
    if b3:
        lines += [
            f"Match `{b3['match_id']}`, Team {b3['winner']} won.",
            "",
            "| Row | s | e | delta | implied K |",
            "|-----|---|---|-------|-----------|",
        ]
        for r in b3["rows"]:
            lines.append(f"| {r['label']} | {r['s']} | {r['e']} | {r['delta']} | {fmt(r['implied_k'], 1)} |")
    else:
        lines.append("No eligible match.")
    lines += [
        "",
        "## B4. The section 15 level offset",
        "",
        f"{b4['players']} players with >= {b4['min_matches']} matches.",
        f"thug_elo mean {fmt(b4['thug_elo']['mean'], 1)} (SD {fmt(b4['thug_elo']['sd'], 1)}); "
        f"wins_elo mean {fmt(b4['wins_elo']['mean'], 1)} (SD {fmt(b4['wins_elo']['sd'], 1)}).",
        f"Raw: {b4['raw']['players_higher_on_performance']} of {b4['players']} higher on performance, "
        f"mean gap {fmt(b4['raw']['mean_gap'], 1)}.",
        f"Centred: {b4['centred']['players_higher_on_performance']} of {b4['players']} higher, "
        f"mean |gap| {fmt(b4['centred']['mean_abs_gap'], 1)} points "
        f"({fmt(b4['centred']['mean_abs_gap_half_bands'], 2)} half-bands).",
        "",
    ]
    return "\n".join(lines)


def main():
    hist = load("elo_history.json")
    current = load("elo_current.json")
    meta = match_meta()
    rows = thug_rows(hist, meta)
    res = {
        "computed_at": current.get("computed_at"),
        "b1": study_b1(rows),
        "b2": study_b2(rows, duel_ratings()),
        "b3": study_b3(hist, meta),
        "b4": study_b4(current),
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "wins_signal.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2)
    md = write_md(res)
    with open(os.path.join(OUT_DIR, "wins_signal.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print(md)


if __name__ == "__main__":
    main()
