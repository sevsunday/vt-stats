"""Generate the master `calibration/index.html` browser.

Scans:
- `calibration/<tier>/*.png` (tier-folder overlays) for thumbnails
- `calibration/configs/<stem>.config.json` for calibration metadata +
  override counts (so cards can show "N override(s)" chips)

Produces:
- `calibration/index.html` - tabbed grid browser with progress bar,
  search, workflow help modal, and links into `calibrate.html?map=<stem>`
  for hand-editing.

CSS lives in `calibration/css/style.css`; JS lives in `calibration/js/browser.js`.
This script only emits the data + structure HTML.
"""
from __future__ import annotations

import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import (  # noqa: E402
    TIER_DIRS,
    CONFIGS_DIR,
    INDEX_HTML,
)


# (id, label, description, color, action_hint)
TIERS = [
    ("proven",     "Proven",     "Sub-pixel RMSE. Auto-calibrated and ready to ship. No action needed.",          "#34d399", "skip - already correct"),
    ("hand_cal",   "Hand cal",   "Calibrated by you (one or more overrides saved). Ready to ship.",               "#a78bfa", "skip or refine if needed"),
    ("borderline", "Borderline", "RMSE 2-5 px. Close but not pixel-perfect; open and eye-check.",                 "#fbbf24", "open, nudge if needed, save"),
    ("failed",     "Failed",     "bbox x 1.43 fallback. Approximate; needs hand calibration.",                    "#f87171", "open, drag markers, save"),
    ("no_png",     "No PNG",     "No iondriver minimap on disk. Can't be calibrated without one.",                "#9098a8", "nothing actionable"),
]


def collect_tier(tier_id: str) -> list[dict]:
    sub = TIER_DIRS.get(tier_id)
    if sub is None or not sub.is_dir():
        return []
    rows = []
    for f in sorted(sub.iterdir(), key=lambda p: p.name.lower()):
        if f.suffix.lower() != ".png":
            continue
        stem = f.stem.removesuffix("_overlay")
        rel = f"{tier_id}/{f.name}"
        rows.append({"stem": stem, "rel_src": rel})
    return rows


def load_config_metadata() -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not CONFIGS_DIR.is_dir():
        return out
    for cfg in CONFIGS_DIR.glob("*.config.json"):
        try:
            data = json.loads(cfg.read_text(encoding="utf-8"))
        except Exception:
            continue
        stem = (data.get("map_stem") or cfg.stem.removesuffix(".config")).lower()
        affine = data.get("affine") or {}
        out[stem] = {
            "map_name": data.get("map_name") or stem,
            "n_overrides": len(data.get("overrides") or []),
            "affine_source": affine.get("source"),
            "rmse_max": affine.get("rmse_max"),
        }
    return out


def render_card(item: dict, meta: dict | None, tier_id: str) -> str:
    stem = item["stem"]
    rel_thumb = html.escape(item["rel_src"])
    map_name = meta["map_name"] if meta else stem
    n_overrides = meta["n_overrides"] if meta else 0
    rmse = meta.get("rmse_max") if meta else None
    rmse_str = f"RMSE {rmse:.2f}px" if rmse is not None else ""
    override_chip = ""
    if n_overrides > 0:
        plural = "s" if n_overrides != 1 else ""
        override_chip = (
            f'<span class="chip chip-override" title="{n_overrides} per-object '
            f'override(s) saved">{n_overrides} override{plural}</span>'
        )
    href = f"calibrate.html?map={html.escape(stem)}&from={html.escape(tier_id)}"
    search_haystack = f"{stem.lower()} {map_name.lower()}"
    return (
        f'<a class="card" href="{href}" '
        f'data-stem="{html.escape(stem)}" '
        f'data-search="{html.escape(search_haystack)}">'
        f'<div class="thumb-wrap">'
        f'<img class="thumb" src="{rel_thumb}" loading="lazy" alt="{html.escape(map_name)}">'
        f'</div>'
        f'<div class="card-body">'
        f'<div class="card-title-row">'
        f'<span class="card-title">{html.escape(map_name)}</span>'
        f'{override_chip}'
        f'</div>'
        f'<div class="card-meta mono">{html.escape(stem)}</div>'
        f'<div class="card-meta"><span class="rmse">{rmse_str}</span></div>'
        f'</div>'
        f'</a>'
    )


def render_tab(tid: str, label: str, color: str, count: int, active: bool) -> str:
    selected = "true" if active else "false"
    return (
        f'<button class="tab" role="tab" data-tier="{tid}" '
        f'style="--tier-color:{color}" aria-selected="{selected}">'
        f'<span class="tab-label">{html.escape(label)}</span>'
        f'<span class="tab-count">{count}</span></button>'
    )


def render_panel(tid: str, label: str, desc: str, color: str,
                 action_hint: str, count: int, cards_html: str,
                 hidden: bool) -> str:
    hidden_class = " hidden" if hidden else ""
    return (
        f'<section class="panel{hidden_class}" role="tabpanel" data-tier="{tid}">'
        f'<div class="panel-header" style="--tier-color:{color}">'
        f'<h2>{html.escape(label)}'
        f'<span class="panel-count">({count})</span></h2>'
        f'<p class="panel-desc">{html.escape(desc)}</p>'
        f'<p class="panel-action">Action: <em>{html.escape(action_hint)}</em></p>'
        f'</div>'
        f'<div class="grid">{cards_html}</div>'
        f'</section>'
    )


# Workflow help shown in the (i) modal.
WORKFLOW_HTML = """
<h2>How to calibrate maps</h2>
<p>This tool lets you hand-tune the placement of pool / spawn / loose-scrap
markers on top of each map's iondriver minimap. Each map's calibration is
saved to a per-map JSON config. The reprocess script regenerates all
overlays + production staging from those configs.</p>

<h3>Per-map workflow (~30-60 sec per map)</h3>
<ol>
  <li><strong>Pick a map.</strong> Open the <em>Failed</em> tab (biggest
    pool of work), or <em>Borderline</em> for almost-perfect maps that just
    need nudging.</li>
  <li><strong>Click a map card</strong> to open the calibration tool.</li>
  <li><strong>Drag misplaced markers</strong> to their correct positions:
    <ul>
      <li>Click a marker to select it</li>
      <li>Click+drag on empty space to draw a rubber-band rectangle</li>
      <li>Drag the selection to move all selected markers together</li>
      <li><kbd>Esc</kbd> to deselect</li>
      <li>Arrow keys to nudge selection by 1 px (<kbd>Shift</kbd>+arrow = 10 px)</li>
      <li><kbd>R</kbd> to reset selected markers to default projection</li>
    </ul>
  </li>
  <li><strong>Save</strong>: click Save (or <kbd>Ctrl</kbd>+<kbd>S</kbd>).
    <em>First time you save</em>: a folder picker appears - pick
    <span class="mono">_map-analysis/calibration/configs/</span>. After that,
    subsequent saves are silent.</li>
  <li><strong>Auto-save</strong>: every drag is auto-saved to localStorage
    immediately. Close the tab anytime; drafts survive. The explicit Save
    above is what writes the actual file.</li>
</ol>

<h3>End of session: regenerate</h3>
<ol>
  <li>Run the reprocess script in a terminal:
    <pre>python _map-analysis/scripts/reprocess.py</pre>
  </li>
  <li>This rebuilds all overlay PNGs and the
    <span class="mono">calibration/staging/</span> folder with the latest
    calibrations.</li>
  <li>Reload this index page to see the updated tier counts.</li>
</ol>

<h3>What gets exported</h3>
<p>The <span class="mono">calibration/staging/</span> folder contains a clean
<span class="mono">&lt;stem&gt;.png</span> for every calibrated map - this
is what eventually gets exported to the main vt-stats project as the
production minimap overlays.</p>

<h3>Pick up next session</h3>
<p>Just reopen this <span class="mono">index.html</span>. Drafts are in
your browser's localStorage and survive across sessions. Saved configs
in <span class="mono">calibration/configs/</span> are the source of truth.</p>
"""


def build_html() -> str:
    meta_by_stem = load_config_metadata()
    tier_counts = {tid: len(collect_tier(tid)) for tid, _, _, _, _ in TIERS}
    grand_total = sum(tier_counts.values())

    # Progress: "done" = proven + hand_cal + borderline (latter is
    # ship-able with a quick eyeball). Failed needs work.
    n_done = (tier_counts.get("proven", 0)
              + tier_counts.get("hand_cal", 0)
              + tier_counts.get("borderline", 0))
    n_actionable = grand_total - tier_counts.get("no_png", 0)
    pct_done = (n_done / n_actionable * 100.0) if n_actionable else 0.0

    # Pick first non-empty tier as the initially-active one.
    first_visible = None
    for tid, _, _, _, _ in TIERS:
        if tier_counts.get(tid, 0) > 0 or tid in ("failed", "no_png"):
            first_visible = tid
            break
    if first_visible is None:
        first_visible = TIERS[0][0]

    tab_html = []
    for tid, label, _, color, _ in TIERS:
        cnt = tier_counts.get(tid, 0)
        if cnt == 0 and tid not in ("failed", "no_png"):
            continue
        tab_html.append(render_tab(tid, label, color, cnt, tid == first_visible))

    panel_html = []
    for tid, label, desc, color, action_hint in TIERS:
        items = collect_tier(tid)
        if items:
            cards_html = "".join(
                render_card(it, meta_by_stem.get(it["stem"].lower()), tid)
                for it in items
            )
        else:
            cards_html = (
                f'<div class="empty">No maps in this tier - '
                f'{html.escape(desc)}</div>'
            )
        panel_html.append(render_panel(
            tid, label, desc, color, action_hint,
            tier_counts.get(tid, 0), cards_html, hidden=(tid != first_visible),
        ))

    title = f"VSR map calibration - {n_done}/{n_actionable} done ({pct_done:.0f}%)"

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{html.escape(title)}</title>
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<header class="topbar">
  <div class="topbar-row">
    <h1>VSR map calibration</h1>
    <div class="progress-wrap">
      <div class="progress-bar">
        <div class="progress-fill" style="width: {pct_done:.1f}%"></div>
      </div>
      <span>
        <span class="progress-num">{n_done}</span> / {n_actionable} done
        ({pct_done:.0f}%)
      </span>
    </div>
    <button class="info-btn" id="info-btn" title="How to use this tool">i</button>
    <input type="search" class="search" id="search"
           placeholder="filter by map name (Ctrl+K)">
  </div>
  <div class="tabs" role="tablist">
    {''.join(tab_html)}
  </div>
</header>
<main>
  {''.join(panel_html)}
</main>
<div class="modal-backdrop hidden" id="info-modal-backdrop">
  <div class="modal" id="info-modal">
    <button class="modal-close" id="info-modal-close" title="Close">x</button>
    {WORKFLOW_HTML}
  </div>
</div>
<script src="js/browser.js"></script>
</body>
</html>
"""


def main() -> int:
    if not TIER_DIRS["proven"].parent.is_dir():
        print("error: calibration/ not found - run reprocess.py first", file=sys.stderr)
        return 1
    html_text = build_html()
    INDEX_HTML.write_text(html_text, encoding="utf-8")
    print(f"wrote {INDEX_HTML}  ({INDEX_HTML.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())