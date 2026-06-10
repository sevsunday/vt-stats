"""Build fable/js/report-data.js — inline data snapshot for the VTSR-T analysis report.

Reads (read-only):
  data/processed/elo_current.json
  data/processed/elo_history.json
  data/processed/matches.json
  _validation/report.json   (fresh validator run, gitignored)

Writes:
  fable/js/report-data.js   (window.FABLE_DATA = {...})

Run from repo root: python fable/tools/build_report_data.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROCESSED = ROOT / "data" / "processed"
VALIDATION = ROOT / "_validation"
OUT = ROOT / "fable" / "js" / "report-data.js"


def load(p: Path):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main() -> None:
    elo = load(PROCESSED / "elo_current.json")
    hist = load(PROCESSED / "elo_history.json")
    matches = load(PROCESSED / "matches.json")
    report = load(VALIDATION / "report.json")

    # ---- corpus ----
    manifest = matches if isinstance(matches, list) else matches.get("matches", [])
    dates = sorted(m.get("date", "") for m in manifest if m.get("date"))
    corpus = {
        "manifest_matches": len(manifest),
        "rated_matches": elo.get("match_count"),
        "players": len(elo.get("ratings", [])),
        "first_match": dates[0] if dates else None,
        "last_match": dates[-1] if dates else None,
        "rows_excluded_campod": elo.get("rows_excluded_campod"),
        "rows_excluded_low_activity": elo.get("rows_excluded_low_activity"),
        "matches_excluded_low_player_count": elo.get("matches_excluded_low_player_count"),
        "matches_excluded_short_duration": elo.get("matches_excluded_short_duration"),
        "elo_schema_version": elo.get("schema_version"),
        "computed_at": elo.get("computed_at"),
    }

    # ---- ratings ----
    ratings = elo.get("ratings", [])
    ratings_slim = [
        {
            "name": r.get("name"),
            "vtsr": r.get("vtsr"),
            "peak": r.get("peak_vtsr"),
            "matches": r.get("matches_played"),
            "cmdr": r.get("matches_as_commander"),
            "provisional": r.get("matches_provisional"),
            "lift": r.get("lowtier_lift_factor"),
        }
        for r in ratings
    ]
    vals = [r["vtsr"] for r in ratings_slim if r["vtsr"] is not None]
    vals_sorted = sorted(vals)
    n = len(vals_sorted)
    rating_stats = {
        "mean": round(sum(vals) / n, 1) if n else None,
        "median": round(vals_sorted[n // 2], 1) if n else None,
        "min": min(vals) if vals else None,
        "max": max(vals) if vals else None,
        "above_anchor": sum(1 for v in vals if v > 1500),
        "below_anchor": sum(1 for v in vals if v < 1500),
    }

    # ---- inflation / rating-economy series from history ----
    # Per rated match: sum of deltas (non-zero-sum evidence) + cumulative net ELO created.
    econ_labels, econ_per_match, econ_cumulative = [], [], []
    cum = 0.0
    pos_total = neg_total = 0.0
    for h in hist.get("history", []):
        if h.get("match_excluded"):
            continue
        s = sum(d.get("delta", 0.0) for d in h.get("deltas", []))
        for d in h.get("deltas", []):
            dv = d.get("delta", 0.0)
            if dv >= 0:
                pos_total += dv
            else:
                neg_total += dv
        cum += s
        econ_labels.append(h.get("match_date", "")[:10])
        econ_per_match.append(round(s, 2))
        econ_cumulative.append(round(cum, 1))
    economy = {
        "labels": econ_labels,
        "per_match_net": econ_per_match,
        "cumulative_net": econ_cumulative,
        "total_gained": round(pos_total, 1),
        "total_lost": round(neg_total, 1),
        "net_created": round(pos_total + neg_total, 1),
    }

    # ---- weights ----
    weights = elo.get("weights", {})
    weights_pre_v210 = {
        "net_damage_share": 0.20, "thug_kill_rate": 0.20, "thug_accuracy": 0.15,
        "thug_efficiency": 0.16, "pve_share": 0.12, "mobility": 0.08,
        "snipe_bonus": 0.05, "target_lock_pct": 0.04,
    }

    # ---- commander baseline ----
    commander = {
        "prior": elo.get("commander_axis_prior", {}),
        "observed": elo.get("commander_baseline_observed", {}),
        "shrinkage": elo.get("commander_baseline_shrinkage"),
        "locked_axes": elo.get("commander_baseline_locked_axes", []),
    }

    # ---- validator (fresh run) ----
    def g(*path, default=None):
        node = report
        for k in path:
            if not isinstance(node, dict) or k not in node:
                return default
            node = node[k]
        return node

    rank = g("rank_correlation", default={})
    calib = g("calibration", default={})
    selfc = g("self_consistency", default={})
    boot = g("bootstrap", default={})
    synth = g("synthetic_winner", default={})
    cwa = g("clean_win_accuracy", default={})
    abl = g("axis_ablation", default={})
    diri = g("dirichlet_perturbation", default={})
    funnel = g("winner_funnel", default={})

    validator = {
        "generated": g("meta", "generated_at") or g("meta", "generated"),
        "raw": {
            "rank_correlation": rank,
            "calibration": calib,
            "self_consistency": selfc,
            "bootstrap": boot,
            "synthetic_winner": synth,
            "clean_win_accuracy": cwa,
            "axis_ablation": abl,
            "dirichlet": diri,
            "winner_funnel": funnel,
        },
    }

    # ---- prior validator runs (hand-anchored from critique/ + _validation history) ----
    validator_trend = [
        {"run": "Phase 1 (v3 doc)", "date": "2026-05-30", "rated": 100, "spearman": 0.462,
         "self_consistency": 0.804, "synthetic": 93.3, "cleanwin_mean": 43.3,
         "cleanwin_max": 53.3, "boot_sigma": 27.0, "n_cleanwin": 30},
        {"run": "June 5 (schema 8)", "date": "2026-06-05", "rated": 103, "spearman": 0.468,
         "self_consistency": 0.820, "synthetic": 90.3, "cleanwin_mean": 45.2,
         "cleanwin_max": 48.4, "boot_sigma": 29.4, "n_cleanwin": 31},
        {"run": "Fresh (v2.10, this report)", "date": "2026-06-10", "rated": 107, "spearman": None,
         "self_consistency": None, "synthetic": None, "cleanwin_mean": None,
         "cleanwin_max": None, "boot_sigma": None, "n_cleanwin": None},
    ]

    data = {
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "corpus": corpus,
        "ratings": ratings_slim,
        "rating_stats": rating_stats,
        "economy": economy,
        "weights": weights,
        "weights_pre_v210": weights_pre_v210,
        "commander": commander,
        "validator": validator,
        "validator_trend": validator_trend,
        "lowtier_lift": elo.get("lowtier_lift", {}),
    }

    js = "// Generated by fable/tools/build_report_data.py — do not edit by hand.\n"
    js += "window.FABLE_DATA = " + json.dumps(data, indent=2) + ";\n"
    OUT.write_text(js, encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
