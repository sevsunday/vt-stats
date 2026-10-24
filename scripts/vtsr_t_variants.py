"""VTSR-T formula variants: replay, score, and apply the decision rule.

Standalone and stdlib-only, like scripts/validate_elo.py. Not invoked by
the pipeline. Replays ``elo.compute_elo`` in memory once per variant (the
module constants are swapped for the run and restored afterwards; nothing
under data/ is written) and writes ``_validation/vtsr_t_variants.{md,json}``.

Run from the repo root::

    python scripts/vtsr_t_variants.py
    python scripts/vtsr_t_variants.py --since 2026-10-24   # forward check

The decision rule it applies is pre-registered in
critique/decisions/vtsr-t-enemy-damage.md. Change the rule there first.

Metrics, all on decided matches (winner team 1 or 2, decided_by in
``DETERMINED``), using pre-match ratings only:

* AUC of the thug-mean rating gap (commanders excluded, as in the Balonce
  thug term) against the winner, after ``WARMUP_MATCHES``; paired bootstrap
  of the difference against the control.
* Log-likelihood gained by adding the thug gap to the commanders' VTSR-C
  gap in a no-intercept logistic.
* Split-half reliability of the per-match performance P (thug rows,
  players with at least ``RELIABILITY_MIN_ROWS``), odd vs even matches.
* Accuracy in the top quartile of |gap|, movers, and the share of the
  winning team's enemy damage that is late building damage.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import random
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import elo  # noqa: E402

PROCESSED = os.path.join(ROOT, "data", "processed")
OUT_DIR = os.path.join(ROOT, "_validation")

DETERMINED = ("adjudicated", "attested", "clean_win", "contested")
WARMUP_MATCHES = 40
RELIABILITY_MIN_ROWS = 16
MOVER_MIN_MATCHES = 15
BOOTSTRAP_RUNS = 2000
SEED = 20261024

# Decision rule (critique/decisions/vtsr-t-enemy-damage.md).
RULE_AUC_LOWER_BOUND = -0.05
RULE_LL_TOLERANCE = 0.5
RULE_LATE_SHARE_TRIM = 0.10
RULE_FORWARD_MIN_MATCHES = 40
RULE_FORWARD_AUC_DROP = 0.05

# The v2.13 composite (ELO_SCHEMA_VERSION 17), frozen so the control
# survives any later change to the module defaults.
V17 = {
    "weights": {
        "net_damage_share": 0.20,
        "thug_kill_rate": 0.20,
        "pve_share": 0.12,
        "mobility": 0.08,
    },
    "alpha_pve": 0.5,
    "commander_prior": {
        "mobility": -0.488,
        "thug_kill_rate": -0.164,
        "net_damage_share": -0.131,
        "pve_share": -0.05,
    },
    "locked": {"pve_share"},
    "lift_axis": "thug_kill_rate",
}
# Commander seed for candidate axes that have no prior yet: the v17 net
# damage prior. It shrinks toward the live commander mean at
# COMMANDER_BASELINE_SHRINKAGE pseudo-duels.
CANDIDATE_COMMANDER_SEED = -0.131

CONTROL = "v17_four_axis"
VARIANTS = [
    {"name": CONTROL, "label": "Today (v17: net damage, kill rate, PvE share, mobility)",
     **V17, "trim": False, "order": None},
    {"name": "enemy_dealt", "label": "Enemy damage dealt only",
     "weights": {"enemy_damage_share": 1.0}, "trim": False, "order": 1},
    {"name": "enemy_net", "label": "Enemy net damage only",
     "weights": {"enemy_net_damage_share": 1.0}, "trim": False, "order": 2},
    {"name": "enemy_net_kill", "label": "Enemy net damage + kill rate (PvE kills at full weight)",
     "weights": {"enemy_net_damage_share": 0.5, "thug_kill_rate": 0.5},
     "alpha_pve": 1.0, "trim": False, "order": 3},
    {"name": "enemy_dealt_trim", "label": "Enemy damage dealt only, late building damage removed",
     "weights": {"enemy_damage_share": 1.0}, "trim": True, "order": 1},
    {"name": "enemy_net_trim", "label": "Enemy net damage only, late building damage removed",
     "weights": {"enemy_net_damage_share": 1.0}, "trim": True, "order": 2},
    {"name": "enemy_net_kill_trim", "label": "Enemy net damage + kill rate, late building damage removed",
     "weights": {"enemy_net_damage_share": 0.5, "thug_kill_rate": 0.5},
     "alpha_pve": 1.0, "trim": True, "order": 3},
]


# ---------------------------------------------------------------------------
# Small stdlib statistics
# ---------------------------------------------------------------------------

def ranks(values):
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            out[order[k]] = avg
        i = j + 1
    return out


def auc(scores, labels):
    n_pos = sum(labels)
    n_neg = len(labels) - n_pos
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    r = ranks(scores)
    pos_rank_sum = sum(rk for rk, y in zip(r, labels) if y)
    return (pos_rank_sum - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def pearson(a, b):
    n = len(a)
    if n < 3:
        return float("nan")
    ma, mb = sum(a) / n, sum(b) / n
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    if sa == 0 or sb == 0:
        return float("nan")
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb)


def spearman(a, b):
    return pearson(ranks(a), ranks(b))


def percentile(values, q):
    s = sorted(values)
    if not s:
        return float("nan")
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def logistic_ll(rows):
    """Max log-likelihood of y ~ sigmoid(x . b), no intercept, 1 or 2 features."""
    k = len(rows[0][0])
    b = [0.0] * k
    for _ in range(60):
        g = [0.0] * k
        h = [[0.0] * k for _ in range(k)]
        for x, y in rows:
            z = sum(bi * xi for bi, xi in zip(b, x))
            p = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))
            w = p * (1.0 - p)
            for i in range(k):
                g[i] += (y - p) * x[i]
                for j in range(k):
                    h[i][j] -= w * x[i] * x[j]
        if k == 1:
            if h[0][0] == 0:
                break
            step = [g[0] / h[0][0]]
        else:
            det = h[0][0] * h[1][1] - h[0][1] * h[1][0]
            if abs(det) < 1e-12:
                break
            step = [
                (h[1][1] * g[0] - h[0][1] * g[1]) / det,
                (-h[1][0] * g[0] + h[0][0] * g[1]) / det,
            ]
        b = [bi - si for bi, si in zip(b, step)]
        if max(abs(s) for s in step) < 1e-10:
            break
    ll = 0.0
    for x, y in rows:
        z = sum(bi * xi for bi, xi in zip(b, x))
        p = min(1 - 1e-12, max(1e-12, 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))))
        ll += y * math.log(p) + (1 - y) * math.log(1 - p)
    return ll, b


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

def load_matches():
    """Every match in the manifest (orphan JSONs on disk are not rated)."""
    out = []
    for entry in load_json("matches.json"):
        path = os.path.join(PROCESSED, entry["file"])
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            out.append(json.load(f))
    return out


def load_json(name):
    with open(os.path.join(PROCESSED, name), encoding="utf-8") as f:
        return json.load(f)


@contextlib.contextmanager
def variant_config(v):
    saved = (
        elo.THUG_WEIGHTS, elo.ALPHA_PVE, elo.COMMANDER_AXIS_PRIOR,
        elo.COMMANDER_BASELINE_LOCKED_AXES, elo.LOWTIER_LIFT_AXIS,
        elo.ENEMY_DAMAGE_TRIM_LATE_STRUCTURE,
    )
    try:
        prior = dict(v.get("commander_prior") or {})
        if not prior:
            for axis in v["weights"]:
                prior[axis] = saved[2].get(axis, CANDIDATE_COMMANDER_SEED)
        elo.THUG_WEIGHTS = dict(v["weights"])
        elo.ALPHA_PVE = v.get("alpha_pve", saved[1])
        elo.COMMANDER_AXIS_PRIOR = prior
        elo.COMMANDER_BASELINE_LOCKED_AXES = set(v.get("locked") or ())
        elo.LOWTIER_LIFT_AXIS = v.get("lift_axis", saved[4])
        elo.ENEMY_DAMAGE_TRIM_LATE_STRUCTURE = bool(v.get("trim"))
        yield
    finally:
        (elo.THUG_WEIGHTS, elo.ALPHA_PVE, elo.COMMANDER_AXIS_PRIOR,
         elo.COMMANDER_BASELINE_LOCKED_AXES, elo.LOWTIER_LIFT_AXIS,
         elo.ENEMY_DAMAGE_TRIM_LATE_STRUCTURE) = saved


def match_meta(all_md):
    meta = {}
    for md in all_md:
        m = md["match"]
        w = m.get("winner") or {}
        rows = {
            str(r.get("steam64")): (bool(r.get("is_commander")), r.get("faction"))
            for r in md.get("leaderboard") or []
        }
        decided = w.get("decided_by") in DETERMINED and w.get("team") in (1, 2)
        meta[m["id"]] = {
            "date": m.get("date") or "",
            "winner": w.get("team") if decided else None,
            "rows": rows,
        }
    return meta


def commander_gaps():
    gaps = {}
    for du in load_json("elo_commander_history.json").get("duels") or []:
        if du.get("source") != "telemetry":
            continue
        c = du.get("commanders") or {}
        if "1" in c and "2" in c:
            gaps[du["match_id"]] = c["1"]["before"] - c["2"]["before"]
    return gaps


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def decided_records(hist, meta, cgap):
    recs = []
    for h in hist["history"]:
        if h.get("match_excluded"):
            continue
        mm = meta.get(h["match_id"])
        if not mm or mm["winner"] is None:
            continue
        sides = {1: [], 2: []}
        for dlt in h["deltas"]:
            isc, fac = mm["rows"].get(str(dlt.get("steam64")), (False, None))
            if isc or fac not in (1, 2) or dlt.get("before") is None:
                continue
            sides[fac].append(dlt["before"])
        if not sides[1] or not sides[2]:
            continue
        gap = sum(sides[1]) / len(sides[1]) - sum(sides[2]) / len(sides[2])
        recs.append({
            "date": mm["date"], "match_id": h["match_id"],
            "y": 1 if mm["winner"] == 1 else 0, "gap": gap,
            "cmdr_gap": cgap.get(h["match_id"]),
        })
    recs.sort(key=lambda r: (r["date"], r["match_id"]))
    return recs


def outcome_metrics(recs):
    ys = [r["y"] for r in recs]
    gaps = [r["gap"] for r in recs]
    nz = [(g, y) for g, y in zip(gaps, ys) if g != 0]
    acc = sum(1 for g, y in nz if (g > 0) == (y == 1)) / len(nz) if nz else float("nan")
    q75 = percentile([abs(g) for g in gaps], 0.75)
    top = [(g, y) for g, y in zip(gaps, ys) if abs(g) >= q75 and g != 0]
    top_acc = sum(1 for g, y in top if (g > 0) == (y == 1)) / len(top) if top else float("nan")
    with_c = [r for r in recs if r["cmdr_gap"] is not None]
    d_ll = float("nan")
    if len(with_c) >= 10:
        ll_c, _ = logistic_ll([([r["cmdr_gap"] / 400.0], r["y"]) for r in with_c])
        ll_ct, _ = logistic_ll([([r["cmdr_gap"] / 400.0, r["gap"] / 400.0], r["y"]) for r in with_c])
        d_ll = ll_ct - ll_c
    return {
        "n": len(recs),
        "auc": auc(gaps, ys),
        "accuracy": acc,
        "top_quartile_n": len(top),
        "top_quartile_accuracy": top_acc,
        "n_with_commanders": len(with_c),
        "ll_gain_over_commanders": d_ll,
    }


def reliability(hist, meta):
    per = defaultdict(list)
    for h in sorted(hist["history"], key=lambda h: (h.get("match_date") or "", h["match_id"])):
        if h.get("match_excluded"):
            continue
        rows = (meta.get(h["match_id"]) or {}).get("rows") or {}
        for dlt in h["deltas"]:
            isc, _fac = rows.get(str(dlt.get("steam64")), (False, None))
            if isc or dlt.get("performance") is None:
                continue
            per[str(dlt.get("steam64"))].append(dlt["performance"])
    odd, even = [], []
    for vals in per.values():
        if len(vals) < RELIABILITY_MIN_ROWS:
            continue
        odd.append(sum(vals[0::2]) / len(vals[0::2]))
        even.append(sum(vals[1::2]) / len(vals[1::2]))
    r = pearson(odd, even)
    return {"players": len(odd), "r": r, "spearman_brown": 2 * r / (1 + r) if r == r else r}


def career_pve_share(all_md):
    acc = defaultdict(lambda: [0.0, 0.0])
    for md in all_md:
        for row in elo._rated_lobby(md.get("leaderboard") or []):
            pd = row.get("personal") or {}
            s = str(row.get("steam64"))
            acc[s][0] += pd.get("enemy_pve_dealt", pd.get("pve_dealt", 0)) or 0
            acc[s][1] += pd.get("enemy_dealt", pd.get("dealt", 0)) or 0
    return {s: (pve / tot if tot > 0 else 0.0) for s, (pve, tot) in acc.items()}


def late_building_share(all_md, rated_ids):
    win = [0.0, 0.0]
    lose = [0.0, 0.0]
    for md in all_md:
        m = md["match"]
        w = m.get("winner") or {}
        if m["id"] not in rated_ids or w.get("decided_by") not in DETERMINED or w.get("team") not in (1, 2):
            continue
        for row in elo._rated_lobby(md.get("leaderboard") or []):
            pd = row.get("personal") or {}
            if "enemy_dealt" not in pd:
                continue
            bucket = win if row.get("faction") == w["team"] else lose
            bucket[0] += pd.get("enemy_structure_dealt_late", 0) or 0
            bucket[1] += pd.get("enemy_dealt", 0) or 0
    return {
        "winners": win[0] / win[1] if win[1] else float("nan"),
        "losers": lose[0] / lose[1] if lose[1] else float("nan"),
    }


def movers(cur_v, cur_c, pve_share):
    c = {r["steam64"]: r for r in cur_c["ratings"]}
    v = {r["steam64"]: r for r in cur_v["ratings"]}
    keys = [k for k in c if k in v and c[k]["matches_played"] >= MOVER_MIN_MATCHES]
    deltas = [v[k]["vtsr"] - c[k]["vtsr"] for k in keys]
    shares = [pve_share.get(str(k), 0.0) for k in keys]
    rows = sorted(
        ({"name": c[k]["name"], "control": c[k]["vtsr"], "variant": v[k]["vtsr"],
          "delta": round(d, 1), "pve_share": round(s, 3)}
         for k, d, s in zip(keys, deltas, shares)),
        key=lambda r: r["delta"],
    )
    return {
        "players": len(keys),
        "spearman_vs_control": spearman([c[k]["vtsr"] for k in keys], [v[k]["vtsr"] for k in keys]),
        "spearman_delta_vs_pve_share": spearman(deltas, shares),
        "mean_abs_delta": sum(abs(d) for d in deltas) / len(deltas) if deltas else float("nan"),
        "max_abs_delta": max((abs(d) for d in deltas), default=float("nan")),
        "biggest_losers": rows[:6],
        "biggest_gainers": rows[-6:][::-1],
    }


def paired_bootstrap(recs_by_variant, control, runs, seed):
    rng = random.Random(seed)
    base = recs_by_variant[control]
    n = len(base)
    out = {}
    for name, recs in recs_by_variant.items():
        if name == control:
            continue
        assert [r["match_id"] for r in recs] == [r["match_id"] for r in base]
        diffs = []
        for _ in range(runs):
            idx = [rng.randrange(n) for _ in range(n)]
            ys = [base[i]["y"] for i in idx]
            diffs.append(auc([recs[i]["gap"] for i in idx], ys) - auc([base[i]["gap"] for i in idx], ys))
        diffs = [d for d in diffs if d == d]
        out[name] = {
            "mean": sum(diffs) / len(diffs),
            "lo": percentile(diffs, 0.025),
            "hi": percentile(diffs, 0.975),
        }
        rng = random.Random(seed)
    return out


# ---------------------------------------------------------------------------
# Decision rule
# ---------------------------------------------------------------------------

def decide(summary, boot, late):
    trim = late["winners"] == late["winners"] and late["winners"] > RULE_LATE_SHARE_TRIM
    ctrl = summary[CONTROL]
    candidates = sorted(
        (v for v in VARIANTS if v["order"] is not None and v["trim"] == trim),
        key=lambda v: v["order"],
    )
    checks = []
    promoted = None
    for v in candidates:
        s = summary[v["name"]]
        b = boot[v["name"]]
        c1 = b["lo"] >= RULE_AUC_LOWER_BOUND
        c2 = s["ll_gain_over_commanders"] >= ctrl["ll_gain_over_commanders"] - RULE_LL_TOLERANCE
        c3 = s["reliability"]["spearman_brown"] >= ctrl["reliability"]["spearman_brown"]
        checks.append({"variant": v["name"], "auc_lower_bound": c1, "ll_gain": c2, "reliability": c3})
        if promoted is None and c1 and c2 and c3:
            promoted = v["name"]
    return {"trim_late_buildings": trim, "checks": checks, "promoted": promoted}


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def fmt(x, nd=3):
    return "n/a" if x is None or x != x else f"{x:.{nd}f}"


def write_report(report, path_md, path_json):
    os.makedirs(os.path.dirname(path_md), exist_ok=True)
    with open(path_json, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    L = []
    L.append("# VTSR-T formula variants")
    L.append("")
    L.append(f"Fidelity: module-default replay vs `elo_current.json`: max |d| = {fmt(report['fidelity_max_abs_diff'], 3)} over {report['fidelity_players']} players.")
    scope = report.get("since") or f"after the first {WARMUP_MATCHES} decided matches"
    L.append(f"Evaluation set: {report['n_eval']} decided matches ({scope}).")
    L.append("")
    L.append("| Variant | AUC | AUC diff vs today [95% CI] | Gain over commanders | Split-half reliability | Accuracy | Top-quartile accuracy |")
    L.append("|---|---|---|---|---|---|---|")
    for v in VARIANTS:
        s = report["summary"][v["name"]]
        b = report["bootstrap"].get(v["name"])
        diff = "control" if b is None else f"{b['mean']:+.3f} [{b['lo']:+.3f}, {b['hi']:+.3f}]"
        L.append(
            f"| {v['label']} | {fmt(s['auc'])} | {diff} | {fmt(s['ll_gain_over_commanders'], 2)} "
            f"| {fmt(s['reliability']['spearman_brown'])} | {fmt(s['accuracy'])} "
            f"| {fmt(s['top_quartile_accuracy'])} (n={s['top_quartile_n']}) |"
        )
    L.append("")
    late = report["late_building_share"]
    L.append(f"Late building damage share of enemy damage: winners {fmt(late['winners'])}, losers {fmt(late['losers'])} (trim threshold {RULE_LATE_SHARE_TRIM}).")
    L.append("")
    d = report["decision"]
    if d:
        L.append(f"Decision: trim late buildings = {d['trim_late_buildings']}; promoted = **{d['promoted'] or 'none (keep today)'}**.")
        for c in d["checks"]:
            L.append(f"- {c['variant']}: AUC lower bound {'pass' if c['auc_lower_bound'] else 'fail'}, gain over commanders {'pass' if c['ll_gain'] else 'fail'}, reliability {'pass' if c['reliability'] else 'fail'}")
        L.append("")
    if report.get("forward"):
        fw = report["forward"]
        L.append(f"Forward check: {fw['n']} decided matches since {report['since']}; module default AUC {fmt(fw['default_auc'])} vs v17 {fmt(fw['control_auc'])}; enough matches = {fw['enough']}; revert = {fw['revert']}.")
        L.append("")
    for name, mv in report["movers"].items():
        L.append(f"## Movers: {name} vs today")
        L.append("")
        L.append(f"{mv['players']} players with at least {MOVER_MIN_MATCHES} rated matches. Spearman vs today {fmt(mv['spearman_vs_control'])}; rating change vs career PvE share {fmt(mv['spearman_delta_vs_pve_share'])}; mean |change| {fmt(mv['mean_abs_delta'], 1)}, max {fmt(mv['max_abs_delta'], 1)}.")
        L.append("")
        L.append("| Player | Today | Variant | Change | PvE share of enemy damage |")
        L.append("|---|---|---|---|---|")
        for r in mv["biggest_losers"] + mv["biggest_gainers"]:
            L.append(f"| {r['name']} | {r['control']:.0f} | {r['variant']:.0f} | {r['delta']:+.1f} | {r['pve_share'] * 100:.0f}% |")
        L.append("")
    with open(path_md, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--since", help="forward check: only decided matches on/after this date (YYYY-MM-DD)")
    ap.add_argument("--bootstrap", type=int, default=BOOTSTRAP_RUNS)
    ap.add_argument("--seed", type=int, default=SEED)
    args = ap.parse_args()

    all_md = load_matches()
    meta = match_meta(all_md)
    cgap = commander_gaps()
    published = load_json("elo_current.json")

    default_cur, default_hist = elo.compute_elo(all_md)
    ref = {r["steam64"]: r["vtsr"] for r in published["ratings"]}
    rep = {r["steam64"]: r["vtsr"] for r in default_cur["ratings"]}
    shared = [k for k in ref if k in rep]
    fidelity = max((abs(ref[k] - rep[k]) for k in shared), default=float("nan"))

    runs = {}
    for v in VARIANTS:
        with variant_config(v):
            runs[v["name"]] = elo.compute_elo(all_md)
        print(f"replayed {v['name']}")

    recs = {}
    for name, (_cur, hist) in runs.items():
        r = decided_records(hist, meta, cgap)
        recs[name] = [x for x in r if x["date"][:10] >= args.since] if args.since else r[WARMUP_MATCHES:]

    summary = {}
    for name, (_cur, hist) in runs.items():
        s = outcome_metrics(recs[name])
        s["reliability"] = reliability(hist, meta)
        summary[name] = s
    boot = paired_bootstrap(recs, CONTROL, args.bootstrap, args.seed)

    rated_ids = {h["match_id"] for h in default_hist["history"] if not h.get("match_excluded")}
    late = late_building_share(all_md, rated_ids)
    pve_share = career_pve_share(all_md)
    mv = {
        name: movers(runs[name][0], runs[CONTROL][0], pve_share)
        for name in runs if name != CONTROL
    }
    observed = {
        name: {
            a: (runs[name][0].get("commander_baseline_observed") or {}).get(a)
            for a in next(v for v in VARIANTS if v["name"] == name)["weights"]
        }
        for name in runs
    }

    report = {
        "since": args.since,
        "fidelity_max_abs_diff": fidelity,
        "fidelity_players": len(shared),
        "n_eval": len(recs[CONTROL]),
        "summary": summary,
        "bootstrap": boot,
        "late_building_share": late,
        "movers": mv,
        "commander_baseline_observed": observed,
        "decision": None if args.since else decide(summary, boot, late),
        "forward": None,
    }
    if args.since:
        d_recs = [x for x in decided_records(default_hist, meta, cgap) if x["date"][:10] >= args.since]
        default_auc = auc([r["gap"] for r in d_recs], [r["y"] for r in d_recs])
        control_auc = summary[CONTROL]["auc"]
        enough = len(d_recs) >= RULE_FORWARD_MIN_MATCHES
        report["forward"] = {
            "n": len(d_recs), "default_auc": default_auc, "control_auc": control_auc,
            "enough": enough,
            "revert": bool(enough and default_auc < control_auc - RULE_FORWARD_AUC_DROP),
        }
    suffix = "_forward" if args.since else ""
    write_report(
        report,
        os.path.join(OUT_DIR, f"vtsr_t_variants{suffix}.md"),
        os.path.join(OUT_DIR, f"vtsr_t_variants{suffix}.json"),
    )
    print(f"fidelity max |d| = {fidelity}")
    if report["decision"]:
        print(f"promoted: {report['decision']['promoted']}")
    if report["forward"]:
        print(f"forward: {report['forward']}")
    print(f"wrote {os.path.join(OUT_DIR, 'vtsr_t_variants' + suffix + '.md')}")


if __name__ == "__main__":
    main()
