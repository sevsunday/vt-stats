---
name: 3d replay minimap flip
overview: Fix the 3D replay "mirroring" by (A) plumbing the calibration x_flipped/y_flipped flags through the .3d.json into the minimap UV drape, and (B) determining + writing correct flips for every uncalibrated map via an automated render_overlays-based heuristic, then re-extracting all maps.
todos:
  - id: extract-flips
    content: "scripts/extract_3d.py: read affine.x_flipped/y_flipped from config and emit them inside world_rect in the .3d.json (default false; keep schema_version 3)"
    status: pending
  - id: loader-flips
    content: "_map-analysis/render/js/loader.js: carry xFlipped/yFlipped onto the returned worldRect object"
    status: pending
  - id: replay-drape
    content: "_map-analysis/render/js/replay.js buildMinimapMaterial: apply u=1-u / v=1-v when xFlipped/yFlipped"
    status: pending
  - id: viewer-drape
    content: "_map-analysis/render/js/viewer.js buildMinimapMaterial: apply the same flip in the UV loop"
    status: pending
  - id: detect-helper
    content: "Add _map-analysis/scripts/detect_minimap_flip.py: project BZN anchors under all 4 flip combos, score base-structure alignment, emit 4-panel contact sheet, --write back to config"
    status: pending
  - id: validate-heuristic
    content: Run scorer read-only against the ~13 already-detected-flip maps; confirm agreement and tune threshold
    status: pending
  - id: run-write-review
    content: Run scorer with --write on vsrpstrgle, vsrravine + 108 auto_failed_fallback maps; review contact sheets and hand-correct low-confidence maps
    status: pending
  - id: reextract
    content: Re-run python scripts/extract_3d.py --all to regenerate every .3d.json with flip fields
    status: pending
  - id: validate-replay
    content: "Verify in replay HUD: vsrpstrgle/vsrravine actors land on correct bases; Height-ramp toggle shows no positional shift; detected-flip maps correct; non-flipped maps unchanged"
    status: pending
isProject: false
---

## 3D Replay Minimap Flip Fix

### Root cause (confirmed)

Player actors and the terrain mesh are placed in true BZ2 world coords and are correct (verified: gameplay trail coords match the independent BZN object coords and `.TER` bounds). The minimap PNG is draped with a fixed UV mapping that ignores the calibration's `x_flipped`/`y_flipped` flags, so the image is rotated/mirrored under correctly-placed actors. The flags never reach the viewer: `scripts/extract_3d.py` drops them when building `world_rect`, and both viewer entry points hardcode the drape.

```mermaid
flowchart LR
  cfg["config.json<br/>affine.x_flipped/y_flipped"] --> extract["extract_3d.py<br/>(DROPS flips today)"]
  extract --> j3d["render/&lt;stem&gt;.3d.json<br/>world_rect: min/max only"]
  j3d --> loader["loader.js<br/>worldRect: min/max/w/d"]
  loader --> drape["replay.js / viewer.js<br/>buildMinimapMaterial<br/>(no flip applied)"]
  drape --> tex["mirrored minimap"]
```

Scope chosen: full sweep (2 reported maps + ~13 already-detected-flip maps + verify all 108 `auto_failed_fallback` maps). Verification method: automated `render_overlays`-style object-projection scoring.

---

### Part A - Plumb flips into the drape (fixes every map at once)

1. **`scripts/extract_3d.py`** - in `build_output()` where `world_rect` is assembled (lines ~146-160), also read `cfg["affine"].get("x_flipped")` / `get("y_flipped")` and add them to the emitted `world_rect` dict (line ~326). Default `False` when no affine. Keep `schema_version: 3` (additive optional fields - existing readers unaffected, no loader version-check change, no hard-fail risk if a map is missed).

2. **`_map-analysis/render/js/loader.js`** - in the `worldRect` block (lines 115-119) carry the new fields: `xFlipped: !!(wr.x_flipped)`, `yFlipped: !!(wr.y_flipped)`.

3. **`_map-analysis/render/js/replay.js`** `buildMinimapMaterial` (lines 396-397) - after computing `u`/`v`, apply the mirror (clamp stays after):

```js
let u = (wx - wr.minX) / wr.width;
let v = (wr.maxZ - wz) / wr.depth;
if (wr.xFlipped) u = 1 - u;
if (wr.yFlipped) v = 1 - v;
```

4. **`_map-analysis/render/js/viewer.js`** `buildMinimapMaterial` (UV loop lines 386-397) - identical change. This mirrors the canonical projection in `_map-analysis/calibration/js/shared.js:65-66` and `scripts/_schema.py:319-322`.

After A, the ~13 maps with already-detected flips (and any future-correct config) render correctly once re-extracted.

---

### Part B - Determine flips for uncalibrated maps

The 108 `auto_failed_fallback` maps have `world_rect` = an inferred bbox of the objects, so anchors always land *inside* the rect; the only open question per map is which of the 4 flip combos is correct. Build a scriptable scorer using the existing projection + assets.

5. **New helper `_map-analysis/scripts/detect_minimap_flip.py`** (reuses `_schema.load_config`, `_schema.load_map_data`, `render_overlays.project_world_to_pixel`, PIL):
   - For a stem: load minimap PNG, BZN objects, and the config `world_rect`.
   - Pick anchor objects in priority order: `recycler` -> `spawn_point` -> `scrap_pool`.
   - For each of the 4 `(x_flipped, y_flipped)` combos, project anchors to pixels and compute a structure score = local luminance/contrast in a small window around each projected anchor (bases are the brightest/most-structured spots on VSR minimaps).
   - Choose the highest-scoring combo; emit a 4-panel contact sheet (each combo's overlay) to a staging dir for human spot-check; report a confidence margin.
   - `--write` flag: write chosen `x_flipped`/`y_flipped` back into the config via `_schema.make_affine` (keep the existing `world_rect`, keep `source: auto_failed_fallback`, stamp `detector: "minimap_flip_heuristic"`).

6. **Validation pass**: run the scorer (read-only) on the ~13 maps that already have detected flips. Its output must agree with the stored flags; this calibrates the heuristic + threshold before trusting it on the 108.

7. **Run + review**: run with `--write` on the 2 reported maps + the 108 fallback maps. Review contact sheets for low-confidence/low-margin maps and hand-correct those configs (or via `calibrate.html`).

8. **Re-extract**: run `python scripts/extract_3d.py --all` (or the production glue `scripts/build_3d_extracts.py`) to regenerate every `data/render/<stem>.3d.json` with the flip fields populated.

---

### Validation

- Spot-check `vsrpstrgle` and `vsrravine` in the replay HUD: actors should sit on the correct bases in Minimap mode; toggling to Height ramp/Wireframe should show no positional change (proves only the texture moved).
- Confirm the ~13 detected-flip maps now render correctly post re-extract.
- Sanity: a non-flipped proven map (flips false) is visually unchanged.

### Notes / decisions

- `schema_version` stays at `3` (additive fields) to avoid a half-migrated hard-fail in `loader.js:63`. Re-extracting `--all` is still done so every map gets the field.
- Tier is NOT promoted for fallback maps - the `world_rect` bbox is still loose; we only correct gross orientation. Fine-grained calibration remains a separate future task.