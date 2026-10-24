"""How much scrap does killing an enemy scavenger or extractor deny?

Standalone and stdlib-only; not invoked by the pipeline. Reads the per-match
JSON (economy block, kill feed) and data/odf.min.json, and writes
``_validation/pve_denial.{md,json}``. Nothing under data/ is written.

Run from the repo root::

    python scripts/study_pve_denial.py

Method, per rated match with resource telemetry (proto v4):

* Regen rate per pool: least-squares fit, over team-matches, of
  ``income_regen = a * pool_seconds + b * seconds`` (no intercept). ``b`` is
  the base regen every team gets regardless of pools; ``a`` is what one
  pool adds per second.
* For every enemy kill of a scavenger or an extractor, the victim team's
  pool count over the next H seconds (H in ``HORIZONS``) is compared with
  matched control windows: same team side, same starting pool count, same
  match-minute bucket, and no scavenger / extractor loss of their own inside
  the window. Pool-seconds lost = sum over the window of
  (start count + mean control drift - observed count).
* Scrap denied = pool-seconds lost x regen rate, beside a tank's scrap cost.
  This counts lost pool income only, not the unit's own cost and not loose
  scrap a scavenger would have collected.
"""

from __future__ import annotations

import glob
import json
import math
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROCESSED = os.path.join(ROOT, "data", "processed")
OUT_DIR = os.path.join(ROOT, "_validation")

HORIZONS = (60, 120, 300)
MINUTE_BUCKET_SEC = 300
POOL_DROP_WINDOW_SEC = 3
TANK_STEM = "ivtank_vsr.odf"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def side(slot):
    if 1 <= (slot or 0) <= 5:
        return 1
    if 6 <= (slot or 0) <= 10:
        return 2
    return 0


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def median(xs):
    s = sorted(xs)
    if not s:
        return float("nan")
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def percentile(xs, q):
    s = sorted(xs)
    if not s:
        return float("nan")
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def odf_sets():
    db = load(os.path.join(ROOT, "data", "odf.min.json"))
    buildings = {k.lower() for k in db.get("Building", {})}
    vehicles = {k.lower() for k in db.get("Vehicle", {})}
    cost = {}
    for cat in ("Vehicle", "Building"):
        for name, body in db.get(cat, {}).items():
            for props in body.values():
                if isinstance(props, dict) and "scrapCost" in props:
                    try:
                        cost[name.lower()] = float(props["scrapCost"])
                    except (TypeError, ValueError):
                        pass
    extractors = {o for o in buildings if "scav" in o}
    scavengers = {o for o in vehicles if "scav" in o}
    return extractors, scavengers, cost


def main():
    extractors, scavengers, cost = odf_sets()
    hist = load(os.path.join(PROCESSED, "elo_history.json"))["history"]
    rated = {h["match_id"] for h in hist if not h.get("match_excluded")}

    fit_rows = []  # (pool_seconds, seconds, income_regen) per team-match
    matches = []
    for path in sorted(glob.glob(os.path.join(PROCESSED, "2026-*.json"))):
        d = load(path)
        m = d.get("match") or {}
        e = d.get("economy") or {}
        if m.get("id") not in rated or not e.get("has_resource_data"):
            continue
        ticks = e.get("ticks") or []
        teams = e.get("teams") or {}
        if len(ticks) < 60 or "1" not in teams or "2" not in teams:
            continue
        tr = m.get("tick_rate") or 20
        t0 = ticks[0]
        pools = {s: teams[str(s)].get("pool_count") or [] for s in (1, 2)}
        for s in (1, 2):
            fit_rows.append((sum(pools[s]), len(ticks), teams[str(s)].get("income_regen") or 0))
        losses = []
        for k in (d.get("kills") or {}).get("feed") or []:
            vo = (k.get("victim_odf") or "").lower()
            kind = "extractor" if vo in extractors else ("scavenger" if vo in scavengers else None)
            if kind is None:
                continue
            vs, ks = side(k.get("victim_team")), side(k.get("killer_team"))
            if not vs:
                continue
            sec = int(round((k["tick"] - t0) / tr))
            losses.append({
                "sec": sec, "side": vs, "kind": kind,
                "enemy": bool(ks and ks != vs),
                "by_player": k.get("killer") not in (None, "", "World", "Self")
                and not str(k.get("killer")).startswith("Team "),
            })
        matches.append({"id": m["id"], "pools": pools, "n": len(ticks), "losses": losses})

    s11 = sum(p * p for p, _n, _y in fit_rows)
    s12 = sum(p * n for p, n, _y in fit_rows)
    s22 = sum(n * n for _p, n, _y in fit_rows)
    t1 = sum(p * y for p, _n, y in fit_rows)
    t2 = sum(n * y for _p, n, y in fit_rows)
    det = s11 * s22 - s12 * s12
    regen_rate = (s22 * t1 - s12 * t2) / det if det else float("nan")
    base_rate = (s11 * t2 - s12 * t1) / det if det else float("nan")

    # Control drift tables: (side-agnostic) start pools x minute bucket x horizon.
    drift = defaultdict(list)
    for mt in matches:
        for s in (1, 2):
            series = mt["pools"][s]
            loss_secs = sorted(x["sec"] for x in mt["losses"] if x["side"] == s)
            for h in HORIZONS:
                for t in range(0, mt["n"] - h, 5):
                    if any(t <= ls <= t + h for ls in loss_secs):
                        continue
                    key = (series[t], t // MINUTE_BUCKET_SEC, h)
                    drift[key].append([series[t + j] - series[t] for j in range(h + 1)])
    drift_mean = {
        key: [mean([w[j] for w in ws]) for j in range(len(ws[0]))]
        for key, ws in drift.items() if len(ws) >= 5
    }

    results = {kind: {h: [] for h in HORIZONS} for kind in ("extractor", "scavenger")}
    drop_seen = defaultdict(lambda: [0, 0])
    recovery = []
    censored = 0
    for mt in matches:
        for x in mt["losses"]:
            if not x["enemy"]:
                continue
            s, sec = x["side"], x["sec"]
            series = mt["pools"][s]
            if sec < 1 or sec >= mt["n"]:
                continue
            p0 = series[sec - 1]
            if x["kind"] == "extractor":
                drop = next(
                    (j for j in range(sec, min(mt["n"], sec + POOL_DROP_WINDOW_SEC + 1)) if series[j] < p0),
                    None,
                )
                drop_seen["extractor"][0] += int(drop is not None)
                drop_seen["extractor"][1] += 1
                if drop is not None:
                    back = next((j for j in range(drop, mt["n"]) if series[j] >= p0), None)
                    if back is None:
                        censored += 1
                    else:
                        recovery.append(back - drop)
            for h in HORIZONS:
                if sec - 1 + h >= mt["n"]:
                    continue
                dm = drift_mean.get((p0, (sec - 1) // MINUTE_BUCKET_SEC, h))
                if dm is None:
                    continue
                lost = sum((p0 + dm[j]) - series[sec - 1 + j] for j in range(h + 1))
                results[x["kind"]][h].append(lost)

    tank_cost = cost.get(TANK_STEM, 55.0)
    report = {
        "matches": len(matches),
        "regen_scrap_per_pool_second": regen_rate,
        "regen_scrap_per_pool_minute": regen_rate * 60,
        "base_regen_scrap_per_minute": base_rate * 60,
        "tank_scrap_cost": tank_cost,
        "scavenger_scrap_cost": cost.get("ivscav_vsr.odf"),
        "extractor_pool_drop_within_3s": drop_seen["extractor"],
        "extractor_recovery_sec": {
            "n": len(recovery), "censored": censored,
            "median": median(recovery), "p25": percentile(recovery, 0.25),
            "p75": percentile(recovery, 0.75),
        },
        "denial": {},
    }
    for kind, by_h in results.items():
        report["denial"][kind] = {}
        for h, vals in by_h.items():
            scrap = [v * regen_rate for v in vals]
            report["denial"][kind][h] = {
                "n": len(vals),
                "pool_seconds_lost_mean": mean(vals),
                "scrap_denied_mean": mean(scrap),
                "scrap_denied_median": median(scrap),
                "scrap_denied_p25": percentile(scrap, 0.25),
                "scrap_denied_p75": percentile(scrap, 0.75),
            }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "pve_denial.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    L = ["# Scrap denied by scavenger and extractor kills", ""]
    L.append(f"{report['matches']} rated matches with resource telemetry.")
    L.append(
        f"Regen: {regen_rate * 60:.2f} scrap per pool per minute on top of {base_rate * 60:.2f} scrap per minute "
        f"of base regen (least squares over {len(fit_rows)} team-matches)."
    )
    dse = report["extractor_pool_drop_within_3s"]
    L.append(f"Extractor kills followed by a pool-count drop within {POOL_DROP_WINDOW_SEC} s: {dse[0]} of {dse[1]}.")
    rc = report["extractor_recovery_sec"]
    L.append(f"Time from the pool-count drop until the victim team is back to its pre-kill count: median {rc['median']:.0f} s (IQR {rc['p25']:.0f}-{rc['p75']:.0f}, n {rc['n']}, {rc['censored']} never recovered before the end).")
    L.append("")
    L.append(f"| Kill | Window | n | Pool-seconds lost (mean) | Scrap denied mean | median | IQR | vs tank ({tank_cost:.0f} scrap) |")
    L.append("|---|---|---|---|---|---|---|---|")
    for kind in ("extractor", "scavenger"):
        for h in HORIZONS:
            r = report["denial"][kind][h]
            L.append(
                f"| {kind} | {h} s | {r['n']} | {r['pool_seconds_lost_mean']:.0f} | {r['scrap_denied_mean']:.1f} "
                f"| {r['scrap_denied_median']:.1f} | {r['scrap_denied_p25']:.1f} to {r['scrap_denied_p75']:.1f} "
                f"| {r['scrap_denied_mean'] / tank_cost:.2f}x |"
            )
    L.append("")
    L.append("Lost pool income only. The unit's own cost (scavenger 20 scrap) and loose scrap a scavenger would have collected are not included.")
    L.append("The control windows match on pool count and match minute only. A team losing extractors is often losing the game, so part of the shortfall at 300 s is the game state, not the kill: read the 300 s row as an upper bound.")
    with open(os.path.join(OUT_DIR, "pve_denial.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
