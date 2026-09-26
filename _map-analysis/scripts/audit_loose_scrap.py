"""Compare catalog Loose totals to BZN scrap pieces times ODF scrapValue.

Reads the already-parsed map reports under ``_map-analysis/vsrmaplist/``
(objects whose inheritance chain hits ``scrap``) and ``data/vsrmaplist.json``
(the published Loose number). Prints mismatches. Exit 0 always — a miss
means "look at this map", not a failed build.

Oldboy is the control: 38 npscrx x 5 = 190.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VSRMAPLIST = ROOT / "data" / "vsrmaplist.json"
ODF_DB = ROOT / "data" / "odf.min.json"
REPORTS = ROOT / "_map-analysis" / "vsrmaplist"


def _flatten_odf(raw: dict) -> dict[str, dict]:
    flat: dict[str, dict] = {}
    for entries in raw.values():
        if not isinstance(entries, dict):
            continue
        for fname, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            base = fname.lower()
            if base.endswith(".odf"):
                base = base[:-4]
            gobj = entry.get("GameObjectClass") or {}
            if not isinstance(gobj, dict):
                gobj = {}
            chain = entry.get("inheritanceChain") or []
            value = gobj.get("scrapValue")
            parsed = None
            if value not in (None, ""):
                try:
                    parsed = int(float(value))
                except (TypeError, ValueError):
                    parsed = None
            flat[base] = {
                "classLabel": (gobj.get("classLabel") or ""),
                "inheritanceChain": [str(c).lower() for c in chain] if isinstance(chain, list) else [],
                "scrapValue": parsed,
            }
    return flat


def _is_scrap(info: dict) -> bool:
    label = str(info.get("classLabel") or "").lower()
    chain = info.get("inheritanceChain") or []
    return label == "scrap" or "scrap" in chain


def _scrap_value(db: dict[str, dict], stem: str) -> int | None:
    key = stem.lower().strip()
    if key.endswith(".odf"):
        key = key[:-4]
    info = db.get(key)
    if info is None or not _is_scrap(info):
        return None
    if info.get("scrapValue") is not None:
        return info["scrapValue"]
    for parent in info.get("inheritanceChain") or []:
        parent_info = db.get(parent)
        if parent_info and parent_info.get("scrapValue") is not None:
            return parent_info["scrapValue"]
    return None


def _catalog_loose() -> dict[str, int | None]:
    raw = json.loads(VSRMAPLIST.read_text(encoding="utf-8"))
    out: dict[str, int | None] = {}
    for row in raw:
        if not isinstance(row, dict):
            continue
        stem = str(row.get("File") or "").lower()
        if not stem:
            continue
        loose = row.get("Loose")
        try:
            out[stem] = int(loose) if loose is not None else None
        except (TypeError, ValueError):
            out[stem] = None
    return out


def _iter_reports():
    for path in sorted(REPORTS.glob("*/*.json")):
        if path.name.endswith(".luma.json"):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        if "objects" not in data or "binary_save" not in data:
            continue
        yield path.stem.lower(), data


def main() -> int:
    db = _flatten_odf(json.loads(ODF_DB.read_text(encoding="utf-8")))
    catalog = _catalog_loose()
    rows = []
    seen = set()
    for stem, report in _iter_reports():
        seen.add(stem)
        pieces = 0
        missing_value = 0
        total = 0
        classes: dict[str, int] = {}
        for obj in report.get("objects") or []:
            if not isinstance(obj, dict):
                continue
            cls = str(obj.get("obj_class") or "")
            value = _scrap_value(db, cls)
            chain = [str(c).lower() for c in (obj.get("inheritance_chain") or [])]
            kind = obj.get("kind")
            is_loose = kind == "loose_scrap" or "scrap" in chain or value is not None
            if not is_loose:
                continue
            pieces += 1
            classes[cls] = classes.get(cls, 0) + 1
            if value is None:
                missing_value += 1
            else:
                total += value
        loose = catalog.get(stem)
        binary = bool(report.get("binary_save"))
        # Loose < 0 is the catalog's "unlimited" sentinel, not a piece total.
        counted = loose is not None and loose >= 0
        match = counted and total == loose and missing_value == 0
        rows.append({
            "stem": stem,
            "loose": loose,
            "pieces": pieces,
            "biometal": total,
            "missing_value": missing_value,
            "binary": binary,
            "match": match,
            "classes": classes,
            "in_catalog": stem in catalog,
        })

    matched = [r for r in rows if r["match"]]
    unlimited = [r for r in rows if r["in_catalog"] and isinstance(r["loose"], int) and r["loose"] < 0]
    missed = [r for r in rows if r["in_catalog"] and not r["match"] and r not in unlimited]
    binary_flagged = [
        r for r in rows
        if r["binary"] and (
            r["pieces"] == 0
            or (isinstance(r["loose"], int) and r["loose"] >= 0 and r["biometal"] != r["loose"])
        )
    ]
    no_report = sorted(set(catalog) - seen)

    print(f"reports: {len(rows)}  catalog: {len(catalog)}")
    print(f"match: {len(matched)}  numeric miss: {len(missed)}  unlimited catalog: {len(unlimited)}  no report: {len(no_report)}")
    print(f"binary flagged (zero pieces, or a counted Loose that the sum misses): {len(binary_flagged)}")
    print()
    oldboy = next((r for r in rows if r["stem"] == "vsroldboy"), None)
    if oldboy is None:
        print("CONTROL FAIL: vsroldboy report missing")
    else:
        print(
            f"CONTROL vsroldboy: pieces={oldboy['pieces']} "
            f"biometal={oldboy['biometal']} catalog={oldboy['loose']} "
            f"classes={oldboy['classes']} match={oldboy['match']}"
        )
    print()
    print("MISMATCHES")
    for r in missed:
        flag = " binary" if r["binary"] else ""
        print(
            f"  {r['stem']:<22} loose={r['loose']!s:<6} "
            f"pieces={r['pieces']:<4} biometal={r['biometal']:<6} "
            f"unpriced={r['missing_value']}{flag} {r['classes']}"
        )
    if unlimited:
        print()
        print("CATALOG UNLIMITED (Loose < 0); pieces still decoded")
        for r in unlimited:
            flag = " binary" if r["binary"] else ""
            print(
                f"  {r['stem']:<22} pieces={r['pieces']:<4} "
                f"biometal={r['biometal']:<6}{flag}"
            )
    if no_report:
        print()
        print("CATALOG WITHOUT A PARSED REPORT")
        for stem in no_report:
            print(f"  {stem}  loose={catalog[stem]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
