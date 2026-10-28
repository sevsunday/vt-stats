#!/usr/bin/env python3
"""Do the main ladders' ratings predict 2v2 winners? (VTSR-2v2 evidence)

Standalone, read-only. Writes _validation/2v2_transfer.{md,json}
(gitignored). Decision memo: critique/decisions/vtsr-2v2-ladders.md.

For every 2v2 the 2v2 ladders rated on win/loss (recorded strict 2v2s and
F9bomber's 2v2 rows), reconstructs each player's MAIN-ladder rating from
before that game and asks which formula would have called the winner:

  1. VTSR-C gap alone (commanders only).
  2. VTSR-C's own formula with the thugs' VTSR-T gap at lambda in
     {0, 0.5, 1, 1.5} (lambda 0 is test 1).
  3. The same, with the commander's VTSR-T averaged into the team term.
  4. Team-sum VTSR-T (both players, no commander term).
  5. The 2v2 ladders' own pre-match call (from elo_2v2_history.json).

Plus: rank agreement between the two thug ratings (performance vs
win/loss) among thugs rated on both.

Pre-match reconstruction: VTSR-C = `after` of the commander's last duel
strictly before the game (F9 rows compare by calendar day); VTSR-T =
`after` of the player's last rated VTSR-T row before the game. A
missing rating leaves that formula unscored for the game (not guessed).
Scoring: draws leave the denominator; a call of exactly 0.5 earns half
credit. Wilson 95% intervals.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROCESSED = PROJECT_ROOT / "data" / "processed"
OUT_DIR = PROJECT_ROOT / "_validation"
LAMBDAS = (0.0, 0.5, 1.0, 1.5)
SCALE = 400.0


def wilson(k: float, n: int, z: float = 1.96) -> tuple[float, float] | None:
    if n <= 0:
        return None
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)


def logistic(diff: float) -> float:
    return 1.0 / (1.0 + 10.0 ** (-diff / SCALE))


def key(p: dict) -> str:
    return str(p.get("steam64")) if p.get("steam64") else f"name:{p.get('name', '')}"


def spearman(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None

    def ranks(v: list[float]) -> list[float]:
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            for t in range(i, j + 1):
                r[order[t]] = (i + j) / 2.0
            i = j + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    vy = math.sqrt(sum((b - my) ** 2 for b in ry))
    return round(cov / (vx * vy), 4) if vx and vy else None


class Timeline:
    """Per-player (date, rating) list; `before(k, date)` = last rating
    strictly earlier than `date` (string compare on ISO dates)."""

    def __init__(self) -> None:
        self.rows: dict[str, list[tuple[str, float]]] = {}

    def add(self, k: str, date: str, rating: float) -> None:
        self.rows.setdefault(k, []).append((date, rating))

    def finish(self) -> None:
        for v in self.rows.values():
            v.sort(key=lambda t: t[0])

    def before(self, k: str, date: str) -> float | None:
        best = None
        for d, r in self.rows.get(k, []):
            if d < date:
                best = r
            else:
                break
        return best


def load(name: str) -> dict:
    return json.loads((PROCESSED / name).read_text(encoding="utf-8"))


def main() -> None:
    h2 = load("elo_2v2_history.json")
    c2 = load("elo_2v2_current.json")
    cmdr = load("elo_commander_history.json")
    thug = load("elo_history.json")

    vtsr_c = Timeline()
    for d in cmdr.get("duels") or []:
        date = str(d.get("date") or "")
        for s in ("1", "2"):
            p = (d.get("commanders") or {}).get(s) or {}
            if isinstance(p.get("after"), (int, float)):
                vtsr_c.add(key(p), date, float(p["after"]))
    vtsr_c.finish()
    vtsr_t = Timeline()
    for e in thug.get("history") or []:
        if e.get("match_excluded"):
            continue
        date = str(e.get("match_date") or "")
        for dl in e.get("deltas") or []:
            if isinstance(dl.get("after"), (int, float)):
                vtsr_t.add(key(dl), date, float(dl["after"]))
    vtsr_t.finish()

    formulas = (["vtsr_c_only"]
                + [f"vtsr_c_plus_thug_t_l{lam:g}" for lam in LAMBDAS if lam]
                + [f"vtsr_c_plus_team_t_l{lam:g}" for lam in LAMBDAS if lam]
                + ["team_sum_vtsr_t", "ladder_2v2"])
    tallies = {src: {f: {"correct": 0.0, "n": 0, "ll": 0.0} for f in formulas}
               for src in ("all", "recorded", "f9")}

    def score(src: str, f: str, e1: float | None, s1: float) -> None:
        if e1 is None:
            return
        for b in ("all", src):
            t = tallies[b][f]
            t["n"] += 1
            if e1 == 0.5:
                t["correct"] += 0.5
            elif (e1 > 0.5) == (s1 == 1.0):
                t["correct"] += 1.0
            t["ll"] += -math.log(max(1e-9, e1 if s1 == 1.0 else 1.0 - e1))

    games_out = []
    for g in h2.get("games") or []:
        wl = g.get("wl")
        if not wl or g.get("outcome") not in ("team1", "team2"):
            continue
        src = "f9" if g.get("source") == "f9" else "recorded"
        date = str(g.get("date") or "")
        cut = date[:10] if src == "f9" else date
        s1 = 1.0 if g["outcome"] == "team1" else 0.0
        sides = g["sides"]
        ck = {s: key(sides[s]["commander"]) for s in ("1", "2")}
        tk = {s: key(sides[s]["thug"]) for s in ("1", "2")}
        rc = {s: vtsr_c.before(ck[s], cut) for s in ("1", "2")}
        rt = {s: vtsr_t.before(tk[s], cut) for s in ("1", "2")}
        rct = {s: vtsr_t.before(ck[s], cut) for s in ("1", "2")}
        have_c = None not in rc.values()
        have_t = None not in rt.values()
        have_ct = have_t and None not in rct.values()
        calls: dict[str, float | None] = {f: None for f in formulas}
        if have_c:
            calls["vtsr_c_only"] = logistic(rc["1"] - rc["2"])
            for lam in LAMBDAS:
                if not lam:
                    continue
                if have_t:
                    calls[f"vtsr_c_plus_thug_t_l{lam:g}"] = logistic(
                        (rc["1"] - rc["2"]) + lam * (rt["1"] - rt["2"]))
                if have_ct:
                    team1 = (rt["1"] + rct["1"]) / 2.0
                    team2 = (rt["2"] + rct["2"]) / 2.0
                    calls[f"vtsr_c_plus_team_t_l{lam:g}"] = logistic(
                        (rc["1"] - rc["2"]) + lam * (team1 - team2))
        if have_ct:
            calls["team_sum_vtsr_t"] = logistic(
                (rt["1"] + rct["1"]) - (rt["2"] + rct["2"]))
        calls["ladder_2v2"] = float(wl["expected"]["1"])
        for f, e1 in calls.items():
            score(src, f, e1, s1)
        games_out.append({
            "game_id": g["game_id"], "source": src, "date": date,
            "outcome": g["outcome"],
            "calls": {f: (round(v, 4) if v is not None else None) for f, v in calls.items()},
        })

    def summarize(t: dict) -> dict:
        n = t["n"]
        return {
            "n": n,
            "accuracy": round(t["correct"] / n, 4) if n else None,
            "accuracy_ci": wilson(t["correct"], n),
            "log_loss": round(t["ll"] / n, 4) if n else None,
        }

    results = {src: {f: summarize(t) for f, t in tallies[src].items()} for src in tallies}

    lad = c2.get("ladders") or {}
    perf = {key(r): r["rating"] for r in (lad.get("thug_perf") or {}).get("ratings") or []}
    wlr = {key(r): r["rating"] for r in (lad.get("thug_wl") or {}).get("ratings") or []}
    both = sorted(set(perf) & set(wlr))
    rank_agree = {
        "n_thugs": len(both),
        "spearman": spearman([perf[k] for k in both], [wlr[k] for k in both]),
    }

    report = {
        "schema_version": 1,
        "computed_from": h2.get("computed_at"),
        "lambdas": list(LAMBDAS),
        "results": results,
        "thug_rank_agreement": rank_agree,
        "games": games_out,
    }
    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "2v2_transfer.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    lines = ["# VTSR-2v2 transfer study", "",
             f"Source: elo_2v2_history.json computed {h2.get('computed_at')}.", ""]
    for src in ("recorded", "f9", "all"):
        lines += [f"## {src}", "", "| Formula | n | Accuracy | 95% CI | Log-loss |",
                  "|---|---|---|---|---|"]
        for f in formulas:
            r = results[src][f]
            acc = f"{r['accuracy'] * 100:.1f}%" if r["accuracy"] is not None else "-"
            ci = (f"{r['accuracy_ci'][0] * 100:.0f}-{r['accuracy_ci'][1] * 100:.0f}%"
                  if r["accuracy_ci"] else "-")
            ll = f"{r['log_loss']:.3f}" if r["log_loss"] is not None else "-"
            lines.append(f"| {f} | {r['n']} | {acc} | {ci} | {ll} |")
        lines.append("")
    lines += ["## Thug rank agreement (performance vs win/loss)", "",
              f"{rank_agree['n_thugs']} thugs rated on both; Spearman "
              f"{rank_agree['spearman']}.", ""]
    (OUT_DIR / "2v2_transfer.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
