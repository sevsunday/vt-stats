"""Generate the VSR map browser for the `vsrmaplist/` workspace.

Scans every subdirectory of `_map-analysis/vsrmaplist/`, analyzes each map
via `analyze_map.analyze_map_dir`, generates a per-map interactive
calibration HTML (via `build_calibration_ui.generate`), and emits a master
`index.html` with a card grid linking to each map's calibration page.

The directory `vsrmaplist/` is THE contract:
- Each subdir is one map's full file set + (optional) `calibration.json`.
- The `calibration.json` file's mere existence on disk = "this map is
  calibrated". Counter math is `len(glob('vsrmaplist/*/calibration.json'))`.
- Calibrations are also collated into `vsrmaplist/_calibrations_backup.json`
  on every rebuild as a safety net against accidental deletion of an
  individual `calibration.json`.

Output:
    _map-analysis/index.html                                    (browser landing)
    _map-analysis/vsrmaplist/<MapName>/calibrate.html           (per-map UI)
    _map-analysis/vsrmaplist/<MapName>/<terrain>.json           (analyze output)
    _map-analysis/vsrmaplist/_calibrations_backup.json          (safety backup)
"""

from __future__ import annotations

import base64
import html
import json
import sys
import urllib.parse
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from analyze_map import analyze_map_dir, MapReport
from build_calibration_ui import generate as generate_calibration_ui
from overlay_on_minimap import find_minimap


SCRAP_VALUE_FOR_NPSCRX = 5  # per data/odf.min.json
VSRMAPLIST_DIR_NAME = "vsrmaplist"
CALIBRATION_BACKUP_NAME = "_calibrations_backup.json"


def discover_maps(root: Path) -> list[Path]:
    """Return every map subdirectory under `root`, sorted case-insensitively.

    Subdirectories whose name starts with `_` are skipped - that's our
    convention for "this folder isn't a map" (e.g. `_calibrations_backup.json`
    is a file, but any future `_archive/` etc would also be excluded).
    """
    if not root.exists():
        return []
    return sorted(
        [p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")],
        key=lambda p: p.name.lower(),
    )


def serialize_report(report: MapReport) -> dict[str, Any]:
    def _convert(o: Any) -> Any:
        if is_dataclass(o):
            return {k: _convert(v) for k, v in asdict(o).items()}
        if isinstance(o, dict):
            return {k: _convert(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [_convert(v) for v in o]
        return o
    return _convert(report)


def _safe_relative_url(target: Path, base: Path) -> str:
    """Return a URL-encoded forward-slash path from `base` to `target`."""
    rel = target.relative_to(base).as_posix()
    return "/".join(urllib.parse.quote(seg) for seg in rel.split("/"))


def thumbnail_data_url(path: Path, max_dim: int = 256) -> str | None:
    try:
        img = Image.open(path).convert("RGBA")
    except Exception:
        return None
    img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def write_calibrations_backup(vsrmaplist_dir: Path, cards: list[dict[str, Any]]) -> None:
    """Write a single collated backup of every map's calibration.json.

    Idempotent. Maps with no `calibration.json` are simply omitted.

    The shape is:
        {
          "schema_version": 1,
          "generated_at": "<ISO timestamp>",
          "count": <int>,
          "by_map": {
             "<MapName folder>": <verbatim calibration.json contents>,
             ...
          }
        }

    This lives at `vsrmaplist/_calibrations_backup.json`. If someone
    accidentally deletes a per-map `calibration.json`, this file lets us
    restore from the most recent rebuild.
    """
    import datetime
    by_map: dict[str, Any] = {}
    for c in cards:
        if not c.get("is_calibrated"):
            continue
        cal_path = Path(c["map_dir_abs"]) / "calibration.json"
        try:
            data = json.loads(cal_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  WARN backup: failed to read {cal_path.name}: {e}",
                  file=sys.stderr)
            continue
        by_map[c["name"]] = data

    payload = {
        "schema_version": 1,
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "count": len(by_map),
        "by_map": dict(sorted(by_map.items(), key=lambda kv: kv[0].lower())),
    }
    backup_path = vsrmaplist_dir / CALIBRATION_BACKUP_NAME
    backup_path.write_text(
        json.dumps(payload, indent=2), encoding="utf-8",
    )
    print(f"  backup: {len(by_map)} calibrations -> {backup_path.name}")


def build(vsrmaplist_dir: Path, index_out: Path) -> None:
    map_dirs = discover_maps(vsrmaplist_dir)
    if not map_dirs:
        print(f"no maps found under {vsrmaplist_dir}", file=sys.stderr)
        return

    cards: list[dict[str, Any]] = []
    for md in map_dirs:
        try:
            report = analyze_map_dir(md)
        except Exception as e:
            print(f"  skip {md.name}: {e}", file=sys.stderr)
            continue

        json_path = md / f"{(report.terrain_name or md.name.lower().replace(' ', '_'))}.json"
        json_path.write_text(
            json.dumps(serialize_report(report), indent=2, default=str),
            encoding="utf-8",
        )

        calibration_path = md / "calibration.json"
        saved_calibration: dict | None = None
        if calibration_path.exists():
            try:
                saved_calibration = json.loads(calibration_path.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"  warn {md.name}: bad calibration.json ({e}); ignoring")
                saved_calibration = None

        mini = find_minimap(report, None)
        calibrate_path: Path | None = None
        thumb_data: str | None = None
        if mini is not None:
            calibrate_path = md / "calibrate.html"
            generate_calibration_ui(
                md, minimap=mini, out=calibrate_path,
                saved_calibration=saved_calibration,
            )
            thumb_data = thumbnail_data_url(mini, max_dim=180)
            saved_marker = " [calibrated]" if saved_calibration else ""
            print(f"  ok  {md.name:<28s} -> calibrate.html  (mini: {mini.name}){saved_marker}")
        else:
            print(f"  no-minimap  {md.name:<28s} (calibration page skipped)")

        counts = report.object_counts_by_kind or {}
        pools_n = counts.get("scrap_pool", 0)
        loose_n = counts.get("loose_scrap", 0)
        spawns_n = counts.get("spawn_point", 0)
        loose_value = loose_n * SCRAP_VALUE_FOR_NPSCRX

        # Terrain bounds line. Three honest sources, in priority order:
        #   1. .TRN [Size] block       -> "from .TRN"
        #   2. Object-position extents -> "inferred from objects" (approximate)
        #   3. Neither                 -> show why (missing file / no [Size])
        tb = report.terrain_bounds
        bounds_label: str | None = None
        bounds_source: str | None = None  # "trn" / "inferred" / "none"
        if tb:
            bounds_label = (
                f"{tb.min_x:g} \u2192 {tb.min_x + tb.width:g} m  \u00d7  "
                f"{tb.min_z:g} \u2192 {tb.min_z + tb.depth:g} m"
            )
            bounds_source = "trn"
        elif report.inferred_bounds_from_objects:
            ib = report.inferred_bounds_from_objects
            def _r(v: float) -> float:
                return round(float(v)) + 0.0
            bounds_label = (
                f"~{_r(ib['min_x']):.0f} \u2192 {_r(ib['max_x']):.0f} m  \u00d7  "
                f"~{_r(ib['min_z']):.0f} \u2192 {_r(ib['max_z']):.0f} m"
            )
            bounds_source = "inferred"
        else:
            bounds_source = "none"

        TRN_STATUS_NOTE = {
            "ok":              None,
            "missing":         "no .TRN file",
            "no_size_block":   ".TRN present, no [Size] block (overlay TRN)",
            "parse_error":     ".TRN [Size] block had bad values",
        }
        trn_note = TRN_STATUS_NOTE.get(report.trn_status)

        saved_label: str | None = None
        if saved_calibration:
            inner = saved_calibration.get("image_calibration", saved_calibration)
            ibw = inner.get("image_bounds_world") if isinstance(inner, dict) else None
            if ibw:
                mn = ibw.get("min", {}); mx = ibw.get("max", {})
                saved_label = (
                    f"x {mn.get('x', '?')} \u2192 {mx.get('x', '?')}  \u00b7  "
                    f"z {mn.get('z', '?')} \u2192 {mx.get('z', '?')}"
                )

        cat_counts = report.object_counts_by_category or {}
        cat_label: str | None = None
        if cat_counts:
            top = sorted(cat_counts.items(), key=lambda kv: -kv[1])[:5]
            cat_label = ", ".join(f"{v} {k}" for k, v in top)
        miss_classes = report.odf_db_miss_classes or []
        EXPECTED_MISS = {"player"}
        EXPECTED_MISS_PREFIXES = ("pspwn",)
        unusual_misses = [
            c for c in miss_classes
            if c.lower() not in EXPECTED_MISS
            and not any(c.lower().startswith(p) for p in EXPECTED_MISS_PREFIXES)
            and not c.lower().endswith(".dll")
        ]

        cards.append({
            "name": md.name,
            "map_dir_abs": str(md),
            "mission_name": report.mission_name or md.name,
            "terrain_name": report.terrain_name or md.name.lower().replace(" ", "_"),
            "pools": pools_n,
            "spawns": spawns_n,
            "loose_scrap": loose_n,
            "loose_value": loose_value,
            "has_trn": tb is not None,
            "has_minimap": mini is not None,
            "bounds_label": bounds_label,
            "bounds_source": bounds_source,
            "trn_status": report.trn_status,
            "trn_note": trn_note,
            "calibrate_href": (
                _safe_relative_url(calibrate_path, index_out.parent)
                if calibrate_path else None
            ),
            "json_href": _safe_relative_url(json_path, index_out.parent),
            "thumb_data": thumb_data,
            "is_calibrated": saved_calibration is not None,
            "saved_label": saved_label,
            "db_category_label": cat_label,
            "db_hits": report.odf_db_hits,
            "db_misses": report.odf_db_misses,
            "unusual_misses": unusual_misses,
        })

    write_index_html(index_out, cards)
    write_calibrations_backup(vsrmaplist_dir, cards)
    print(f"\nwrote {index_out}  ({len(cards)} maps)")


def write_index_html(out: Path, cards: list[dict[str, Any]]) -> None:
    rows_html = []
    for c in cards:
        thumb = (
            f'<img src="{c["thumb_data"]}" alt="{html.escape(c["name"])}" class="thumb">'
            if c["thumb_data"] else
            '<div class="thumb-placeholder">no minimap</div>'
        )
        calib_btn = (
            f'<a class="btn primary" href="{html.escape(c["calibrate_href"])}" target="_blank">Open calibration</a>'
            if c["calibrate_href"] else
            '<button class="btn primary" disabled title="No minimap available">Open calibration</button>'
        )
        if c["bounds_label"] and c["bounds_source"] == "trn":
            bounds_line = (
                f'<div class="meta">{html.escape(c["bounds_label"])} '
                f'<span class="meta-source">from .TRN</span></div>'
            )
        elif c["bounds_label"] and c["bounds_source"] == "inferred":
            tip = "Approximate - .TRN has no [Size] block; bounds inferred from placed object positions"
            bounds_line = (
                f'<div class="meta meta-inferred" title="{html.escape(tip)}">'
                f'{html.escape(c["bounds_label"])} '
                f'<span class="meta-source">inferred from objects</span></div>'
            )
        else:
            warn_text = c["trn_note"] or "no terrain data"
            bounds_line = f'<div class="meta meta-warn">{html.escape(warn_text)}</div>'

        if c["is_calibrated"]:
            calib_chip = (
                '<span class="chip chip-good" title="calibration.json detected'
                ' &middot; the calibrate.html will open with these values pre-loaded">'
                '&#10003; Calibrated</span>'
            )
            calib_line = (
                f'<div class="meta meta-calib mono">'
                f'{html.escape(c["saved_label"] or "")}</div>'
                if c["saved_label"] else ""
            )
        else:
            calib_chip = '<span class="chip chip-muted">Not calibrated</span>'
            calib_line = ""

        db_line = ""
        if c.get("db_category_label"):
            db_line = (
                f'<div class="meta meta-db mono" title="Top ODF DB categories'
                f' &middot; {c["db_hits"]} hits, {c["db_misses"]} misses">'
                f'DB: {html.escape(c["db_category_label"])}'
                f'</div>'
            )
        unusual_chip = ""
        if c.get("unusual_misses"):
            tip = "Classes not in odf.min.json: " + ", ".join(c["unusual_misses"][:6])
            if len(c["unusual_misses"]) > 6:
                tip += f" (+{len(c['unusual_misses']) - 6} more)"
            unusual_chip = (
                f'<span class="chip chip-warn" title="{html.escape(tip)}">'
                f'{len(c["unusual_misses"])} unknown</span>'
            )

        # The card's outer element carries data-* attributes so the
        # client-side "Hide calibrated" toggle can filter without
        # reparsing the chip DOM.
        rows_html.append(f"""
        <div class="card"
             data-calibrated="{'1' if c["is_calibrated"] else '0'}"
             data-has-minimap="{'1' if c["has_minimap"] else '0'}">
          <div class="card-thumb">{thumb}</div>
          <div class="card-body">
            <div class="card-header">
              <h3 class="card-title">{html.escape(c["mission_name"])}</h3>
              <div class="chip-row">{unusual_chip}{calib_chip}</div>
            </div>
            <div class="meta meta-muted">{html.escape(c["name"])}  &middot;  <span class="mono">{html.escape(c["terrain_name"])}</span></div>
            {bounds_line}
            {db_line}
            {calib_line}
            <div class="stats">
              <span><strong>{c["pools"]}</strong> pools</span>
              <span><strong>{c["spawns"]}</strong> spawns</span>
              <span><strong>{c["loose_scrap"]}</strong> scrap = <strong>{c["loose_value"]}</strong> biometal</span>
            </div>
            <div class="actions">
              {calib_btn}
              <a class="btn" href="{html.escape(c["json_href"])}" target="_blank">View JSON</a>
            </div>
          </div>
        </div>
        """)

    n_total = len(cards)
    n_calibratable = sum(1 for c in cards if c["calibrate_href"])
    n_no_minimap = n_total - n_calibratable
    n_calibrated = sum(1 for c in cards if c["is_calibrated"])
    n_pending = n_calibratable - n_calibrated
    # Percentage track widths: calibrated and unhealthy/no-minimap fractions
    # of the total. Their sum + pending fraction = 100%.
    pct_calibrated = (n_calibrated / n_total * 100.0) if n_total else 0.0
    pct_no_mini = (n_no_minimap / n_total * 100.0) if n_total else 0.0

    html_doc = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>VSR map calibration - VT Stats</title>
  <style>
    :root {{
      --bg: #0e1015;
      --panel: #181b22;
      --panel-border: #2a2f3a;
      --text: #e2e3e7;
      --text-muted: #9098a8;
      --accent: #6aa9ff;
      --accent-strong: #2563eb;
      --warn: #fbbf24;
      --good: #34d399;
      --track-bg: #1f242e;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      min-height: 100vh;
    }}
    .topnav {{
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 12px;
      padding: 18px 22px;
      margin-bottom: 22px;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(320px, 2fr) auto;
      gap: 22px;
      align-items: center;
    }}
    h1 {{ margin: 0; font-size: 24px; line-height: 1.2; }}
    .topnav-sub {{ color: var(--text-muted); font-size: 12px; margin-top: 4px; }}
    .progress-wrap {{ display: flex; flex-direction: column; gap: 6px; min-width: 0; }}
    .progress-counter {{
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-size: 14px;
      color: var(--text-muted);
    }}
    .progress-counter .cal-count {{
      font-size: 26px;
      line-height: 1;
      color: var(--good);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 700;
    }}
    .progress-counter .cal-total {{
      font-size: 16px;
      color: var(--text);
      font-family: ui-monospace, monospace;
    }}
    .progress-bar {{
      position: relative;
      height: 10px;
      background: var(--track-bg);
      border-radius: 5px;
      overflow: hidden;
      border: 1px solid var(--panel-border);
    }}
    .progress-fill {{
      position: absolute;
      top: 0; left: 0;
      height: 100%;
      background: linear-gradient(90deg, #34d399 0%, #6aa9ff 100%);
      transition: width 0.4s ease-out;
    }}
    .progress-no-mini {{
      position: absolute;
      top: 0; right: 0;
      height: 100%;
      background: rgba(143, 152, 168, 0.25);
    }}
    .progress-meta {{
      display: flex;
      gap: 12px;
      font-size: 11px;
      color: var(--text-muted);
      flex-wrap: wrap;
    }}
    .progress-meta .pending {{ color: var(--accent); }}
    .progress-meta .skipped {{ color: var(--text-muted); }}
    .topnav-controls {{ display: flex; gap: 10px; align-items: center; }}
    /* Segmented filter (All / Calibrated / Uncalibrated). Hidden radios
       drive the visual state via :checked on their sibling label. */
    .filter-segment {{
      display: inline-flex;
      background: var(--bg);
      border: 1px solid var(--panel-border);
      border-radius: 999px;
      padding: 3px;
      gap: 2px;
    }}
    .filter-segment input[type=radio] {{
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }}
    .filter-segment label {{
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
      padding: 5px 12px;
      border-radius: 999px;
      transition: background 0.15s, color 0.15s;
      white-space: nowrap;
    }}
    .filter-segment label:hover {{ color: var(--text); }}
    .filter-segment input[type=radio]:checked + label {{
      background: var(--accent);
      color: white;
    }}
    .filter-segment input[type=radio]:focus-visible + label {{
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }}
    .filter-segment .seg-count {{
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      opacity: 0.7;
    }}
    .filter-segment input[type=radio]:checked + label .seg-count {{
      opacity: 0.85;
    }}
    .empty-state {{
      grid-column: 1 / -1;
      padding: 40px 20px;
      text-align: center;
      color: var(--text-muted);
      font-size: 14px;
      background: var(--panel);
      border: 1px dashed var(--panel-border);
      border-radius: 12px;
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 18px;
    }}
    .card {{
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: row;
    }}
    .card.hidden {{ display: none; }}
    .card-thumb {{
      width: 160px;
      flex-shrink: 0;
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
    }}
    .card-thumb .thumb {{
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }}
    .card-thumb .thumb-placeholder {{
      color: var(--text-muted);
      font-size: 12px;
      padding: 12px;
      text-align: center;
    }}
    .card-body {{ padding: 14px 16px; flex: 1; min-width: 0; }}
    .card-header {{ display: flex; align-items: center; justify-content: space-between; gap: 8px; }}
    .card-title {{ margin: 0 0 4px 0; font-size: 16px; }}
    .chip {{
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.03em;
      padding: 2px 7px;
      border-radius: 999px;
      white-space: nowrap;
      flex-shrink: 0;
    }}
    .chip-good {{ background: rgba(52, 211, 153, 0.18); color: var(--good); border: 1px solid rgba(52, 211, 153, 0.35); }}
    .chip-muted {{ background: rgba(143, 152, 168, 0.12); color: var(--text-muted); border: 1px solid var(--panel-border); }}
    .chip-warn {{ background: rgba(251, 191, 36, 0.18); color: var(--warn); border: 1px solid rgba(251, 191, 36, 0.35); cursor: help; }}
    .chip-row {{ display: flex; gap: 6px; }}
    .meta {{ font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }}
    .meta-muted {{ font-size: 11px; }}
    .meta-db {{ font-size: 11px; color: var(--text-muted); }}
    .meta-calib {{ font-size: 11px; color: var(--good); margin-bottom: 4px; }}
    .meta-inferred {{ cursor: help; }}
    .meta-source {{
      font-size: 10px;
      font-style: italic;
      color: var(--text-muted);
      opacity: 0.75;
      margin-left: 4px;
    }}
    .meta-warn {{ color: var(--warn); }}
    .mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }}
    .stats {{
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--text-muted);
      margin: 10px 0;
    }}
    .stats strong {{ color: var(--text); font-family: ui-monospace, monospace; }}
    .actions {{ display: flex; gap: 6px; flex-wrap: wrap; }}
    .btn {{
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--panel-border);
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      display: inline-block;
    }}
    .btn:hover {{ color: var(--text); border-color: var(--accent); }}
    .btn.primary {{ background: var(--accent); color: white; border-color: var(--accent); }}
    .btn.primary:hover {{ background: var(--accent-strong); color: white; }}
    .btn[disabled] {{ opacity: 0.4; cursor: not-allowed; }}

    @media (max-width: 880px) {{
      .topnav {{ grid-template-columns: 1fr; }}
      .topnav-controls {{ justify-content: flex-start; }}
    }}
  </style>
</head>
<body>
  <header class="topnav">
    <div class="topnav-title">
      <h1>VSR map calibration</h1>
      <div class="topnav-sub">Each <span class="mono">vsrmaplist/&lt;MapName&gt;/calibration.json</span> = one calibrated map.</div>
    </div>
    <div class="progress-wrap">
      <div class="progress-counter">
        <span class="cal-count" id="cal-count-live">{n_calibrated}</span>
        <span class="cal-sep">/</span>
        <span class="cal-total" id="cal-total-live">{n_total}</span>
        <span class="cal-label">calibrated</span>
      </div>
      <div class="progress-bar" role="progressbar"
           aria-valuemin="0"
           aria-valuemax="{n_total}"
           aria-valuenow="{n_calibrated}"
           title="{n_calibrated} of {n_total} maps have a calibration.json on disk">
        <div class="progress-fill" style="width: {pct_calibrated:.1f}%"></div>
        <div class="progress-no-mini" style="width: {pct_no_mini:.1f}%"
             title="{n_no_minimap} maps have no minimap and can't be calibrated"></div>
      </div>
      <div class="progress-meta">
        <span class="pending"><strong id="pending-count">{n_pending}</strong> pending</span>
        <span class="skipped">{n_no_minimap} skipped (no minimap)</span>
      </div>
    </div>
    <div class="topnav-controls">
      <div class="filter-segment" role="radiogroup" aria-label="Filter maps by calibration status">
        <input type="radio" id="filter-all" name="cal-filter" value="all" checked>
        <label for="filter-all">All <span class="seg-count">{n_total}</span></label>
        <input type="radio" id="filter-cal" name="cal-filter" value="calibrated">
        <label for="filter-cal">Calibrated <span class="seg-count">{n_calibrated}</span></label>
        <input type="radio" id="filter-uncal" name="cal-filter" value="uncalibrated">
        <label for="filter-uncal">Uncalibrated <span class="seg-count">{n_pending}</span></label>
      </div>
    </div>
  </header>
  <div class="grid" id="map-grid">
    {''.join(rows_html)}
  </div>
  <script>
    (function() {{
      const radios = document.querySelectorAll('input[name="cal-filter"]');
      const cards = Array.from(document.querySelectorAll('#map-grid .card'));
      const grid = document.getElementById('map-grid');
      const STORAGE_KEY = 'vt-map-cal-filter';
      const VALID = new Set(['all', 'calibrated', 'uncalibrated']);
      let emptyState = null;

      function ensureEmptyState() {{
        if (emptyState) return emptyState;
        emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.id = 'empty-state';
        grid.appendChild(emptyState);
        return emptyState;
      }}

      function currentValue() {{
        for (const r of radios) {{
          if (r.checked) return r.value;
        }}
        return 'all';
      }}

      function applyFilter() {{
        const mode = currentValue();
        let visible = 0;
        for (const c of cards) {{
          const isCal = c.getAttribute('data-calibrated') === '1';
          let show = true;
          if (mode === 'calibrated' && !isCal) show = false;
          if (mode === 'uncalibrated' && isCal) show = false;
          if (show) {{
            c.classList.remove('hidden');
            visible += 1;
          }} else {{
            c.classList.add('hidden');
          }}
        }}
        const empty = ensureEmptyState();
        if (visible === 0) {{
          empty.textContent = (mode === 'calibrated')
            ? 'No maps have been calibrated yet. Switch to All or Uncalibrated to start one.'
            : (mode === 'uncalibrated')
              ? 'All calibratable maps are calibrated. Nice work.'
              : 'No maps in the corpus.';
          empty.style.display = 'block';
        }} else {{
          empty.style.display = 'none';
        }}
      }}

      // Restore persisted state. localStorage so the choice survives a
      // page reload (the user usually wants the same view next time).
      // Migration note: an earlier build used the boolean
      // `vt-map-cal-hide-calibrated` key. We map a true-ish value to
      // `uncalibrated` once, then clear the legacy key.
      try {{
        let stored = localStorage.getItem(STORAGE_KEY);
        if (!VALID.has(stored)) {{
          const legacy = localStorage.getItem('vt-map-cal-hide-calibrated');
          if (legacy === '1') {{
            stored = 'uncalibrated';
            localStorage.setItem(STORAGE_KEY, stored);
          }}
          localStorage.removeItem('vt-map-cal-hide-calibrated');
        }}
        if (VALID.has(stored)) {{
          for (const r of radios) {{
            if (r.value === stored) {{ r.checked = true; break; }}
          }}
        }}
      }} catch (_) {{ /* private mode etc - ignore */ }}

      for (const r of radios) {{
        r.addEventListener('change', () => {{
          try {{ localStorage.setItem(STORAGE_KEY, r.value); }} catch (_) {{}}
          applyFilter();
        }});
      }}

      applyFilter();
    }})();
  </script>
</body>
</html>
"""
    out.write_text(html_doc, encoding="utf-8")


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    vsrmaplist = here / VSRMAPLIST_DIR_NAME
    index_out = here / "index.html"
    build(vsrmaplist, index_out)
