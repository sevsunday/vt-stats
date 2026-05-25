"""Generate a self-contained interactive HTML calibration tool.

Reads a map directory, analyzes the BZN to extract pool/spawn/scrap
positions, embeds the minimap as base64, and writes a single HTML file
with a canvas + 4 sliders so the user can dial in the right
`image_calibration.image_bounds_world` values by eye.

Output: `_map-analysis/calibrate_<map>.html`
Open in any browser (no server, no build step).

Usage:
    python build_calibration_ui.py "Europa Night"
    python build_calibration_ui.py "Europa Night" --minimap ../data/maps/vsreuronig.png
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

from PIL import Image

from analyze_map import analyze_map_dir
from overlay_on_minimap import find_minimap
from render_map import KIND_STYLE


def _extract_saved_bounds(saved_calibration: dict | None) -> dict | None:
    """Pull min/max XZ out of the registry-shaped calibration JSON.

    Accepts either the full {"image_calibration": {...}} envelope or just
    the inner {"image_bounds_world": {...}} block. Returns the bounds dict
    expected by the HTML template, or None if the input is missing/malformed.
    """
    if not saved_calibration:
        return None
    cal = saved_calibration.get("image_calibration", saved_calibration)
    ibw = cal.get("image_bounds_world")
    if not ibw:
        return None
    try:
        return {
            "min_x": float(ibw["min"]["x"]),
            "max_x": float(ibw["max"]["x"]),
            "min_z": float(ibw["min"]["z"]),
            "max_z": float(ibw["max"]["z"]),
        }
    except (KeyError, TypeError, ValueError):
        return None


def generate(
    map_dir: Path,
    minimap: Path | None = None,
    out: Path | None = None,
    saved_calibration: dict | None = None,
) -> Path | None:
    """Generate an interactive calibration HTML for a single map.

    If `saved_calibration` is provided (registry-shaped dict), the page
    opens with those bounds pre-loaded instead of the symmetric ±600 default.

    Returns the output path on success, None on failure (e.g. no minimap).
    """
    report = analyze_map_dir(map_dir)
    mini = find_minimap(report, minimap)
    if mini is None:
        return None

    mini_img = Image.open(mini)
    img_w_src, img_h_src = mini_img.size
    mini_bytes = mini.read_bytes()
    mini_b64 = base64.b64encode(mini_bytes).decode("ascii")
    mini_data_url = f"data:image/png;base64,{mini_b64}"

    # Calibration UI shows ONLY the three kinds that anchor the projection:
    # pools, spawn points, loose scrap. The BZN's baked-in starting_unit is
    # a placeholder swapped for real lobby players at match start - irrelevant
    # for image-to-world alignment.
    CALIB_KINDS = {"scrap_pool", "spawn_point", "loose_scrap"}
    objects_payload = []
    for o in report.objects:
        if o.position is None or o.kind not in CALIB_KINDS:
            continue
        style = KIND_STYLE.get(o.kind)
        if not style or style[1] <= 0:
            continue
        color, radius, letter = style
        objects_payload.append({
            "kind": o.kind,
            "obj_class": o.obj_class,
            "unit_name": o.unit_name or "",
            "db_category": o.db_category or "",
            "x": o.position[0],
            "z": o.position[2],
            "color": color,
            "radius": int(radius),
            "letter": letter,
        })

    tb = report.terrain_bounds
    trn_bounds = {
        "min_x": tb.min_x if tb else -1024.0,
        "max_x": (tb.min_x + tb.width) if tb else 1024.0,
        "min_z": tb.min_z if tb else -1024.0,
        "max_z": (tb.min_z + tb.depth) if tb else 1024.0,
    }

    map_name = report.mission_name or map_dir.name
    terrain_name = report.terrain_name or map_dir.name.lower().replace(" ", "_")

    # ---- Initial bounds (preview the calibration before any user input) ----
    #
    # Priority order (best -> worst):
    #   1. Saved calibration.json (authoritative; user already dialed it in).
    #   2. Object-inferred bounds + 25% padding. The placed pools/spawns/scrap
    #      perimeter is a lower bound on the playable area; ~25% outward padding
    #      empirically lines up well with hand-calibrated maps (Europa: inferred
    #      ~+/-496m, calibrated ~+/-625m, ratio 1.26).
    #   3. TRN [Size] block. Authoritative for the terrain MESH, but tends to
    #      overshoot the actual minimap playable area (Europa's mesh is +/-1024m
    #      while its minimap covers ~+/-625m).
    #   4. +/- 625 m last-resort fallback. Centered on a typical VSR Medium map.
    OBJECT_INFLATE = 1.25   # outward padding factor on the inferred-bounds box
    DEFAULT_HALF_EXTENT = 625.0

    saved_bounds = _extract_saved_bounds(saved_calibration)
    initial_bounds_source = "default"
    if saved_bounds:
        initial_bounds = saved_bounds
        initial_bounds_source = "saved"
    elif report.inferred_bounds_from_objects:
        ib = report.inferred_bounds_from_objects
        cx = (ib["min_x"] + ib["max_x"]) / 2.0
        cz = (ib["min_z"] + ib["max_z"]) / 2.0
        half_x = (ib["max_x"] - ib["min_x"]) / 2.0 * OBJECT_INFLATE
        half_z = (ib["max_z"] - ib["min_z"]) / 2.0 * OBJECT_INFLATE
        initial_bounds = {
            "min_x": cx - half_x, "max_x": cx + half_x,
            "min_z": cz - half_z, "max_z": cz + half_z,
        }
        initial_bounds_source = "inferred"
    elif tb:
        initial_bounds = {
            "min_x": trn_bounds["min_x"], "max_x": trn_bounds["max_x"],
            "min_z": trn_bounds["min_z"], "max_z": trn_bounds["max_z"],
        }
        initial_bounds_source = "trn"
    else:
        initial_bounds = {
            "min_x": -DEFAULT_HALF_EXTENT, "max_x":  DEFAULT_HALF_EXTENT,
            "min_z": -DEFAULT_HALF_EXTENT, "max_z":  DEFAULT_HALF_EXTENT,
        }

    payload = {
        "map_name": map_name,
        "terrain_name": terrain_name,
        "img_w": img_w_src,
        "img_h": img_h_src,
        "mini_data_url": mini_data_url,
        "objects": objects_payload,
        "trn_bounds": trn_bounds,
        "initial_bounds": initial_bounds,
        "initial_bounds_source": initial_bounds_source,
        "has_saved": saved_bounds is not None,
    }
    payload_json = json.dumps(payload)

    html = HTML_TEMPLATE.replace("__PAYLOAD__", payload_json)
    out_path = out if out else Path(f"calibrate_{terrain_name}.html")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return out_path


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("map_dir")
    ap.add_argument("--minimap", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    out_path = generate(
        Path(args.map_dir),
        minimap=Path(args.minimap) if args.minimap else None,
        out=Path(args.out) if args.out else None,
    )
    if out_path is None:
        print(f"error: no minimap PNG found for {args.map_dir}", file=sys.stderr)
        return 2
    print(f"wrote {out_path}")
    print(f"open it in any browser to start calibrating.")
    return 0


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Calibrate map overlay</title>
  <style>
    :root {
      --bg: #0e1015;
      --panel: #181b22;
      --panel-border: #2a2f3a;
      --text: #e2e3e7;
      --text-muted: #9098a8;
      --accent: #6aa9ff;
      --accent-strong: #2563eb;
      --good: #34d399;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: grid;
      grid-template-columns: 1fr 420px;
      gap: 24px;
      min-height: 100vh;
    }
    h1 { margin: 0 0 4px 0; font-size: 22px; }
    h2 { margin: 16px 0 8px 0; font-size: 14px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .canvas-wrap {
      background: #000;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--panel-border);
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    canvas {
      display: block;
      max-width: 100%;
      height: auto;
      image-rendering: pixelated;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    canvas.dragging { cursor: grabbing; }
    .canvas-tooltip {
      position: absolute;
      pointer-events: none;
      background: rgba(15, 18, 24, 0.95);
      border: 1px solid var(--panel-border);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      padding: 8px 10px;
      border-radius: 6px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.55);
      max-width: 260px;
      line-height: 1.45;
      display: none;
      z-index: 10;
    }
    .canvas-tooltip .ct-title {
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 2px;
    }
    .canvas-tooltip .ct-class {
      color: var(--text-muted);
      font-size: 11px;
    }
    .canvas-tooltip .ct-coords {
      color: var(--good);
      margin-top: 4px;
      font-size: 11px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 12px;
      padding: 20px;
      max-height: calc(100vh - 48px);
      overflow-y: auto;
    }
    .slider-row {
      display: grid;
      grid-template-columns: 80px 1fr 90px;
      gap: 12px;
      align-items: center;
      margin-bottom: 12px;
    }
    .slider-row label { font-size: 14px; color: var(--text-muted); font-weight: 600; }
    .slider-row input[type=range] {
      width: 100%;
      accent-color: var(--accent);
    }
    .slider-row input[type=number] {
      background: var(--bg);
      border: 1px solid var(--panel-border);
      color: var(--text);
      padding: 6px 8px;
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 14px;
      text-align: right;
    }
    .legend {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      margin-top: 8px;
    }
    .legend-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .legend-dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.3); }
    button {
      background: var(--accent);
      color: white;
      border: none;
      padding: 9px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      margin-right: 6px;
      margin-top: 4px;
    }
    button:hover { background: var(--accent-strong); }
    button.secondary {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--panel-border);
    }
    button.secondary:hover { color: var(--text); border-color: var(--accent); background: transparent; }
    pre.json-output {
      background: var(--bg);
      border: 1px solid var(--panel-border);
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--good);
      overflow-x: auto;
      margin-top: 8px;
      white-space: pre;
    }
    .hint {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 14px;
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 8px 0;
      font-size: 13px;
      color: var(--text-muted);
    }
    .checkbox-row input[type=checkbox] { accent-color: var(--accent); width: 16px; height: 16px; }
    .stat-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .stat-row span:last-child { font-family: ui-monospace, monospace; color: var(--text); }
  </style>
</head>
<body>
  <div class="canvas-wrap">
    <canvas id="cv" width="1024" height="1024"></canvas>
    <div class="canvas-tooltip" id="tooltip">
      <div class="ct-title" id="ct-title"></div>
      <div class="ct-class" id="ct-class"></div>
      <div class="ct-coords" id="ct-coords"></div>
    </div>
  </div>
  <div class="panel">
    <h1 id="map-title">VSR: Loading...</h1>
    <div class="hint">
      <strong>Click + drag</strong> on the canvas to pan markers.
      <strong>Scroll wheel</strong> to zoom around the cursor.
      Sliders below are for fine-tune nudges. Goal: line up the small dot at
      each marker's center with the actual base structures on the minimap.
    </div>

    <h2>Calibration controls</h2>
    <div class="slider-row">
      <label>min_x</label>
      <input type="range" id="r_min_x" min="-1500" max="0" step="1" value="-600">
      <input type="number" id="n_min_x" step="1" value="-600">
    </div>
    <div class="slider-row">
      <label>max_x</label>
      <input type="range" id="r_max_x" min="0" max="1500" step="1" value="600">
      <input type="number" id="n_max_x" step="1" value="600">
    </div>
    <div class="slider-row">
      <label>min_z</label>
      <input type="range" id="r_min_z" min="-1500" max="0" step="1" value="-600">
      <input type="number" id="n_min_z" step="1" value="-600">
    </div>
    <div class="slider-row">
      <label>max_z</label>
      <input type="range" id="r_max_z" min="0" max="1500" step="1" value="600">
      <input type="number" id="n_max_z" step="1" value="600">
    </div>

    <div class="stat-row"><span>x width</span><span id="stat-xw">1200</span></div>
    <div class="stat-row"><span>z depth</span><span id="stat-zd">1200</span></div>
    <div class="stat-row"><span>x center</span><span id="stat-xc">0</span></div>
    <div class="stat-row"><span>z center</span><span id="stat-zc">0</span></div>

    <div style="margin-top:14px;">
      <button class="secondary" id="btn-reset-trn">Reset to .TRN</button>
      <button class="secondary" id="btn-reset-600">Reset to &plusmn;600</button>
      <button class="secondary" id="btn-lock-aspect">Link X &harr; Z (1:1)</button>
    </div>

    <div class="checkbox-row">
      <input type="checkbox" id="cb-symmetric" checked>
      <label for="cb-symmetric">Symmetric mode (max = -min)</label>
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="cb-show-grid">
      <label for="cb-show-grid">Show world-coord grid (100m lines)</label>
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="cb-show-loose" checked>
      <label for="cb-show-loose">Show loose scrap dots</label>
    </div>

    <h2>Output</h2>
    <div class="hint" id="initial-banner" style="display:none;"></div>
    <pre class="json-output" id="json-out"></pre>
    <button id="btn-copy">Copy JSON</button>
    <button id="btn-download">Download calibration.json</button>
    <div class="hint" style="margin-top:8px;">
      Save the downloaded <span class="mono">calibration.json</span> into
      <span class="mono">_map-analysis/vsrmaplist/&lt;your map&gt;/</span> &mdash; the
      next time you re-run <span class="mono">build_vsrmaplist_browser.py</span>
      the page will open with these values pre-loaded and the index will mark
      this map as <strong>Calibrated</strong>.
    </div>
  </div>

  <script>
    const payload = __PAYLOAD__;

    const UPSCALE = 8;
    const cv = document.getElementById("cv");
    const ctx = cv.getContext("2d");
    cv.width = payload.img_w * UPSCALE;
    cv.height = payload.img_h * UPSCALE;
    cv.style.width = (payload.img_w * UPSCALE / 2) + "px"; // shrink for display

    document.getElementById("map-title").textContent = payload.map_name;

    const img = new Image();
    img.src = payload.mini_data_url;

    const state = {
      min_x: payload.initial_bounds.min_x,
      max_x: payload.initial_bounds.max_x,
      min_z: payload.initial_bounds.min_z,
      max_z: payload.initial_bounds.max_z,
      symmetric: true,
      show_grid: false,
      show_loose: true,
    };

    function worldToPx(wx, wz) {
      const px = (wx - state.min_x) / (state.max_x - state.min_x) * cv.width;
      const py = cv.height - (wz - state.min_z) / (state.max_z - state.min_z) * cv.height;
      return [px, py];
    }

    function draw() {
      if (!img.complete) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, cv.width, cv.height);

      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);

      if (state.show_grid) {
        ctx.strokeStyle = "rgba(255,220,0,0.2)";
        ctx.lineWidth = 1;
        for (let w = -1500; w <= 1500; w += 100) {
          const [px, _] = worldToPx(w, 0);
          if (px >= 0 && px <= cv.width) {
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, cv.height); ctx.stroke();
          }
          const [_2, py] = worldToPx(0, w);
          if (py >= 0 && py <= cv.height) {
            ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(cv.width, py); ctx.stroke();
          }
        }
      }

      const [ox, oy] = worldToPx(0, 0);
      ctx.strokeStyle = "rgba(255,220,0,0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ox - 14, oy); ctx.lineTo(ox + 14, oy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ox, oy - 14); ctx.lineTo(ox, oy + 14); ctx.stroke();

      const layer = ["ai_path","marker","pilot","loose_scrap","mission_script",
                     "starting_unit","player_slot","recycler","geyser","spawn_point","scrap_pool"];
      const byKind = {};
      for (const o of payload.objects) (byKind[o.kind] = byKind[o.kind] || []).push(o);

      for (const k of layer) {
        if (k === "loose_scrap" && !state.show_loose) continue;
        for (const o of (byKind[k] || [])) {
          const [cx, cy] = worldToPx(o.x, o.z);
          const r = Math.min(o.radius * (UPSCALE / 4), 24);
          ctx.fillStyle = hexA(o.color, 0x55);
          ctx.strokeStyle = o.color;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#000";
          ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = o.color; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.stroke();
          if (o.letter) {
            ctx.fillStyle = "#fff";
            ctx.font = "bold 14px monospace";
            ctx.fillText(o.letter, cx + r + 3, cy - r + 6);
          }
        }
      }
    }

    function hexA(hex, alpha) {
      const a = (alpha & 0xff).toString(16).padStart(2, "0");
      return hex + a;
    }

    function updateStats() {
      const xw = state.max_x - state.min_x;
      const zd = state.max_z - state.min_z;
      document.getElementById("stat-xw").textContent = xw.toFixed(0);
      document.getElementById("stat-zd").textContent = zd.toFixed(0);
      document.getElementById("stat-xc").textContent = ((state.max_x + state.min_x) / 2).toFixed(0);
      document.getElementById("stat-zc").textContent = ((state.max_z + state.min_z) / 2).toFixed(0);

      const cal = {
        image_calibration: {
          image_bounds_world: {
            min: { x: Math.round(state.min_x), z: Math.round(state.min_z) },
            max: { x: Math.round(state.max_x), z: Math.round(state.max_z) },
          },
          note: "calibrated by overlaying BZN pool/spawn positions on minimap",
        }
      };
      document.getElementById("json-out").textContent = JSON.stringify(cal, null, 2);
    }

    function setVal(key, val) {
      state[key] = val;
      const sym = state.symmetric;
      if (sym) {
        if (key === "min_x") state.max_x = -val;
        else if (key === "max_x") state.min_x = -val;
        else if (key === "min_z") state.max_z = -val;
        else if (key === "max_z") state.min_z = -val;
      }
      syncInputs();
      updateStats();
      draw();
    }

    function syncInputs() {
      for (const k of ["min_x","max_x","min_z","max_z"]) {
        document.getElementById("r_" + k).value = state[k];
        document.getElementById("n_" + k).value = Math.round(state[k]);
      }
    }

    for (const k of ["min_x","max_x","min_z","max_z"]) {
      document.getElementById("r_" + k).addEventListener("input", e => setVal(k, parseFloat(e.target.value)));
      document.getElementById("n_" + k).addEventListener("change", e => setVal(k, parseFloat(e.target.value)));
    }
    document.getElementById("cb-symmetric").addEventListener("change", e => {
      state.symmetric = e.target.checked;
    });
    document.getElementById("cb-show-grid").addEventListener("change", e => {
      state.show_grid = e.target.checked; draw();
    });
    document.getElementById("cb-show-loose").addEventListener("change", e => {
      state.show_loose = e.target.checked; draw();
    });
    document.getElementById("btn-reset-trn").addEventListener("click", () => {
      const tb = payload.trn_bounds;
      state.min_x = tb.min_x; state.max_x = tb.max_x;
      state.min_z = tb.min_z; state.max_z = tb.max_z;
      syncInputs(); updateStats(); draw();
    });
    document.getElementById("btn-reset-600").addEventListener("click", () => {
      state.min_x = -600; state.max_x = 600;
      state.min_z = -600; state.max_z = 600;
      syncInputs(); updateStats(); draw();
    });
    document.getElementById("btn-lock-aspect").addEventListener("click", () => {
      const cx = (state.min_x + state.max_x) / 2;
      const cz = (state.min_z + state.max_z) / 2;
      const w = (state.max_x - state.min_x);
      const d = (state.max_z - state.min_z);
      const m = (w + d) / 2;
      state.min_x = cx - m / 2; state.max_x = cx + m / 2;
      state.min_z = cz - m / 2; state.max_z = cz + m / 2;
      syncInputs(); updateStats(); draw();
    });
    document.getElementById("btn-copy").addEventListener("click", async () => {
      const text = document.getElementById("json-out").textContent;
      try {
        await navigator.clipboard.writeText(text);
        const b = document.getElementById("btn-copy");
        b.textContent = "Copied!";
        setTimeout(() => b.textContent = "Copy JSON", 1200);
      } catch (e) {
        alert("Copy failed; select the JSON above manually.");
      }
    });

    document.getElementById("btn-download").addEventListener("click", () => {
      const text = document.getElementById("json-out").textContent;
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "calibration.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 200);
    });

    // --- Canvas interactions: click-drag to pan, wheel to zoom ----------------

    function cssToCanvasPx(evt) {
      // The canvas is displayed at half its internal resolution (style.width =
      // cv.width / 2) so a 1 CSS-px mouse delta is 2 canvas-px on each axis.
      const rect = cv.getBoundingClientRect();
      const sx = cv.width / rect.width;
      const sy = cv.height / rect.height;
      return {
        cx: (evt.clientX - rect.left) * sx,
        cy: (evt.clientY - rect.top) * sy,
        sx, sy,
      };
    }

    function turnOffSymmetric() {
      if (state.symmetric) {
        state.symmetric = false;
        document.getElementById("cb-symmetric").checked = false;
      }
    }

    let drag = null;
    cv.addEventListener("pointerdown", (e) => {
      const p = cssToCanvasPx(e);
      drag = {
        start_canvas_px: { x: p.cx, y: p.cy },
        start_bounds: { ...state },
        scale: { sx: p.sx, sy: p.sy },
        moved: false,
      };
      cv.classList.add("dragging");
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", (e) => {
      const p = cssToCanvasPx(e);
      if (drag) {
        const dx_px = p.cx - drag.start_canvas_px.x;
        const dy_px = p.cy - drag.start_canvas_px.y;
        if (Math.abs(dx_px) > 1 || Math.abs(dy_px) > 1) {
          drag.moved = true;
          turnOffSymmetric();
        }
        const sb = drag.start_bounds;
        const x_range = sb.max_x - sb.min_x;
        const z_range = sb.max_z - sb.min_z;
        // Pan in world space so the world point under the cursor stays under the cursor.
        // dx_px > 0 (drag right) -> bounds shift left (markers move right)
        // dy_px > 0 (drag down)  -> bounds shift up in world (markers move down)
        const dx_world = dx_px * x_range / cv.width;
        const dy_world = dy_px * z_range / cv.height;
        state.min_x = sb.min_x - dx_world;
        state.max_x = sb.max_x - dx_world;
        state.min_z = sb.min_z + dy_world;
        state.max_z = sb.max_z + dy_world;
        syncInputs(); updateStats(); draw();
        hideTooltip();
      } else {
        updateTooltip(e, p);
      }
    });

    // --- Hover tooltip: pick nearest visible marker within HIT_PX ---------------

    const HIT_PX = 24;  // canvas-px hit radius (~12 CSS-px given the 2x display)
    const tooltipEl = document.getElementById("tooltip");
    const ctTitle = document.getElementById("ct-title");
    const ctClass = document.getElementById("ct-class");
    const ctCoords = document.getElementById("ct-coords");

    function hideTooltip() {
      tooltipEl.style.display = "none";
    }

    function updateTooltip(evt, p) {
      let best = null;
      let bestDist = HIT_PX * HIT_PX;
      for (const o of payload.objects) {
        if (o.kind === "loose_scrap" && !state.show_loose) continue;
        const [cx, cy] = worldToPx(o.x, o.z);
        const dx = cx - p.cx;
        const dy = cy - p.cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) {
          bestDist = d2;
          best = o;
        }
      }
      if (!best) {
        hideTooltip();
        return;
      }
      const niceName = best.unit_name || prettyKind(best.kind);
      ctTitle.textContent = niceName;
      const classBits = [best.obj_class];
      if (best.db_category) classBits.push(best.db_category);
      ctClass.textContent = classBits.join("  -  ");
      ctCoords.textContent = "world (x=" + best.x.toFixed(1) + ", z=" + best.z.toFixed(1) + ")";

      // Position next to cursor, clamped inside .canvas-wrap so it never
      // extends past the right/bottom edges and gets clipped by overflow:hidden.
      const wrap = cv.parentElement.getBoundingClientRect();
      tooltipEl.style.display = "block";
      const ttRect = tooltipEl.getBoundingClientRect();
      let left = evt.clientX - wrap.left + 14;
      let top = evt.clientY - wrap.top + 14;
      if (left + ttRect.width > wrap.width - 8) {
        left = (evt.clientX - wrap.left) - ttRect.width - 14;
      }
      if (top + ttRect.height > wrap.height - 8) {
        top = (evt.clientY - wrap.top) - ttRect.height - 14;
      }
      tooltipEl.style.left = Math.max(4, left) + "px";
      tooltipEl.style.top = Math.max(4, top) + "px";
    }

    function prettyKind(k) {
      return ({
        "scrap_pool":   "Scrap Pool",
        "loose_scrap":  "Loose Scrap",
        "spawn_point":  "Spawn Point",
      })[k] || k;
    }

    cv.addEventListener("pointerleave", hideTooltip);
    function endDrag(e) {
      if (!drag) return;
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      drag = null;
      cv.classList.remove("dragging");
    }
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
    cv.addEventListener("pointerleave", endDrag);

    // Wheel = zoom around the cursor. World point under cursor stays put.
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = cssToCanvasPx(e);
      // Each wheel tick scales by ~7% (capped to one tick per event)
      const ZOOM_PER_TICK = 1.07;
      // deltaY > 0 = scroll down = zoom OUT (range grows)
      // deltaY < 0 = scroll up   = zoom IN  (range shrinks)
      const dir = Math.sign(e.deltaY);
      if (dir === 0) return;
      const factor = dir > 0 ? ZOOM_PER_TICK : 1 / ZOOM_PER_TICK;
      // Cursor world coords (using current bounds)
      const cursor_world_x = state.min_x + (p.cx / cv.width) * (state.max_x - state.min_x);
      const cursor_world_z = state.min_z + ((cv.height - p.cy) / cv.height) * (state.max_z - state.min_z);
      // Scale the rectangle around the cursor world point
      state.min_x = cursor_world_x + (state.min_x - cursor_world_x) * factor;
      state.max_x = cursor_world_x + (state.max_x - cursor_world_x) * factor;
      state.min_z = cursor_world_z + (state.min_z - cursor_world_z) * factor;
      state.max_z = cursor_world_z + (state.max_z - cursor_world_z) * factor;
      // A non-uniform pre-existing calibration could re-align under symmetric;
      // but in general wheel zoom can keep symmetry intact if it was on.
      const isStillSymmetric =
        Math.abs(state.min_x + state.max_x) < 0.001 &&
        Math.abs(state.min_z + state.max_z) < 0.001;
      if (!isStillSymmetric) turnOffSymmetric();
      syncInputs(); updateStats(); draw();
    }, { passive: false });

    // Initialize state from payload (handles saved / inferred / TRN / default).
    state.min_x = payload.initial_bounds.min_x;
    state.max_x = payload.initial_bounds.max_x;
    state.min_z = payload.initial_bounds.min_z;
    state.max_z = payload.initial_bounds.max_z;

    // Show a friendly status banner explaining which assumption the page opened with.
    const banner = document.getElementById("initial-banner");
    const SOURCE_MESSAGES = {
      "saved":    '<span style="color: var(--good);">&#10003;</span> Loaded saved calibration from <span class="mono">calibration.json</span>. Tweak below as needed.',
      "inferred": 'Initial bounds <em>inferred from object positions</em> (placed pools/spawns/scrap, padded ~25% outward). Drag the canvas to align with the minimap.',
      "trn":      'Initial bounds from the <span class="mono">.TRN [Size]</span> block. NB: the terrain mesh is often larger than the minimap actually shows.',
      "default":  'No object data found - opened with the &plusmn;625 m default. Drag the canvas to position.',
    };
    const msg = SOURCE_MESSAGES[payload.initial_bounds_source];
    if (msg) {
      banner.innerHTML = msg;
      banner.style.display = "block";
    }

    if (payload.has_saved) {
      // Asymmetric saved calibrations would fight symmetric mode -> turn it off
      const isSymmetric = (state.min_x === -state.max_x) && (state.min_z === -state.max_z);
      if (!isSymmetric) {
        state.symmetric = false;
        document.getElementById("cb-symmetric").checked = false;
      }
    } else if (payload.initial_bounds_source === "inferred") {
      // Inferred bounds are generally asymmetric too (object placement is rarely
      // perfectly centered). Pre-flip the toggle so the first drag doesn't snap.
      const isSymmetric =
        Math.abs(state.min_x + state.max_x) < 0.001 &&
        Math.abs(state.min_z + state.max_z) < 0.001;
      if (!isSymmetric) {
        state.symmetric = false;
        document.getElementById("cb-symmetric").checked = false;
      }
    }

    img.addEventListener("load", () => { syncInputs(); updateStats(); draw(); });
  </script>
</body>
</html>
"""


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
