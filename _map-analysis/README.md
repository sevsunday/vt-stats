# `_map-analysis/` — VSR Map Calibration Workspace

Stand-alone workspace for ingesting every BZ:CC map from the local Steam
install, calibrating game-object world-coordinates to minimap pixels by
hand, and documenting everything else extractable from raw map files for
downstream tooling.

The single output we care about per map is a tiny
`calibration/configs/<stem>.config.json` carrying a world-bounds rectangle
(plus optional per-object pixel overrides) that maps the BZN game
objects 1:1 onto the in-game minimap PNG. Once enough maps are
calibrated, the cleaned `calibration/staging/<stem>.png` overlays are ready
to bake into the main `vt-stats` project for production use
(Positioning heatmaps, Replay-tab trails, Map Browser overlays).

Nothing here touches the rest of the repo. Output never leaves the
`_map-analysis/` folder until a deliberate manual "bake" step (out of
scope for this workspace).

---

## Quick start

```powershell
# One-time bootstrap (after a fresh clone).
# Walks BZ2R + VSR mod + asset deps, copies map file sets into
# _map-analysis/vsrmaplist/<MapName>/, then auto-runs reprocess.py.
python _map-analysis/scripts/ingest_maps.py

# Pull up the calibration browser.
start _map-analysis/calibration/index.html
```

That's the loop. The browser shows every map bucketed into five tiers
(Proven / Hand cal / Borderline / Failed / No PNG); click any card to
open `calibrate.html?map=<stem>` and start dragging markers.

### Typical multi-session workflow

```powershell
# 1. Calibrate a batch of maps in the browser (auto-saves drafts to
#    localStorage; Ctrl+S writes the actual *.config.json files via
#    File System Access API). Walk away whenever; resume next week.

# 2. Regenerate overlays + index from the latest configs.
python _map-analysis/scripts/reprocess.py

# 3. (Eventually) bake calibration/staging/<stem>.png into the production
#    asset set. Out of scope for this workspace.
```

Each "ingest -> calibrate -> reprocess" loop is fully idempotent.
Calibration data lives in `calibration/configs/` (the source of truth) and
survives every script rerun.

---

## Folder contract

```
_map-analysis/
  README.md                          (you are here)

  scripts/                           PYTHON BACKEND
    _paths.py                        Centralized path constants
    _schema.py                       JSON schemas + read/write helpers
    ingest_maps.py                   Steam walk -> vsrmaplist/
    analyze_map.py                   BZN/.TRN/.TER -> MapReport
    bz2_paths.py                     Steam / BZ2R / VSR path resolvers
    init_configs.py                  Bootstrap calibration/configs + calibration/map_data
    render_overlays.py               Config-driven overlay renderer
    build_browser.py                 Generates calibration/index.html
    reprocess.py                     Orchestrator (run after editing)
    prove_png_calibration.py         Detector + affine solver (used by init)

  calibration/                              CALIBRATION WEBAPP + ARTIFACTS
    index.html                       Tabbed browser of all maps by tier
    calibrate.html                   Single-map calibration tool (drag/drop)
    _README.md                       In-folder workflow cheat-sheet
    css/style.css                    Shared styles for both pages
    js/
      shared.js                      Shared utilities (mirror of _schema.py)
      browser.js                     index.html: tabs, search, modal
      calibrate.js                   calibrate.html: canvas, drag, save
    configs/<stem>.config.json       USER STATE - the source of truth
    map_data/<stem>.json             BZN-derived (regenerable)
    proven/<stem>_overlay.png        Sub-pixel auto-cals (ready)
    hand_cal/<stem>_overlay.png      Your saved overrides (ready)
    borderline/<stem>_overlay.png    RMSE 2-5px (eye-check)
    failed/<stem>_overlay.png        Bbox fallback (needs work)
    no_png/                          (would be here if any map lacked a PNG)
    staging/<stem>.png               CLEAN production-bound overlays

  vsrmaplist/<MapName>/              SOURCE MAP FILES (per ingest)
    <stem>.bzn / .ter / .trn / .inf / .sky / .wat / .des / .dds / .png
    <stem>.luma.json                 Luma metadata sidecar

  ppm/                               King's PPM render set (legacy reference)

  archive/                           DEPRECATED - pre-restructure stuff
    proof/, proof-render/, renders/, scripts/, BZNTools-master/,
    vsrmaplist_legacy_calibrate_html/, index_legacy.html
```

### The sacred contract

`calibration/configs/<stem>.config.json` is the **only** file in this
workspace that's not regenerable. Everything else can be nuked and
rebuilt by running `python scripts/init_configs.py` followed by
`python scripts/reprocess.py`.

`init_configs.py` is **idempotent** — when a config already exists, it
keeps the existing affine + overrides untouched. Use `--force-affine`
only when you've improved the detector and want fresh auto-cals while
preserving any overrides you've already saved.

---

## The calibration data model

Each map carries two JSON files:

### 1. `calibration/configs/<stem>.config.json` (user state, source of truth)

```jsonc
{
  "schema_version": 1,
  "map_stem": "vsreuronig",
  "map_name": "Europa Night",
  "affine": {
    "world_rect": {
      "min": { "x": -667, "z": -627 },
      "max": { "x":  578, "z":  627 }
    },
    "x_flipped": false,
    "y_flipped": false,
    "source": "hand_migrated",          // or auto_proven / auto_borderline /
                                         // auto_failed_fallback / hand_calibrated
    "rmse_max": 0.29,                    // null when source != auto_*
    "detector": "r4_nms5_white"
  },
  "overrides": [
    {
      "obj_uid": "scrap_pool#0",
      "obj_class": "ibpool01",
      "world": { "x":  120.0, "z":  -45.0 },
      "pixel": { "x":  178.5, "y":  124.0 },
      "set_at": "2026-05-21T19:42:00Z"
    }
  ],
  "metadata": {
    "tier_at_last_render": "proven",
    "first_calibrated": "2025-12-15T03:11:09Z",
    "last_modified":    "2026-05-21T19:42:00Z"
  }
}
```

`world_rect` is the world-coordinate bounding box of the iondriver PNG
(in BZ2 meters). `overrides[]` is a small list of per-object pixel
positions that win over the affine projection. Tier is **derived** from
these fields (`overrides` non-empty -> `hand_cal`; otherwise read from
`affine.source`).

### 2. `calibration/map_data/<stem>.json` (BZN-derived, regenerable)

```jsonc
{
  "schema_version": 1,
  "map_stem": "vsreuronig",
  "map_name": "Europa Night",
  "iondriver_png_rel": "../../data/maps/vsreuronig.png",
  "iondriver_dim": [128, 128],
  "objects": [
    {
      "uid": "scrap_pool#0",
      "kind": "scrap_pool",
      "obj_class": "ibpool01",
      "world": { "x": 120.0, "z": -45.0 }
    },
    { "uid": "scrap_pool#1", ... },
    { "uid": "spawn_point#0", "kind": "spawn_point", "obj_class": "pspwn_1", ... },
    { "uid": "loose_scrap#0", "kind": "loose_scrap", "obj_class": "npscr1",   ... }
  ]
}
```

Object UIDs are `<kind>#<index>` (0-based, BZN file order within the
kind). Overrides reference UIDs so a config can survive minor BZN
re-orderings as long as the **kind-relative** index is stable.

---

## The calibration loop (per map)

1. **Pick a map** in `calibration/index.html`. Failed tab is the biggest pool
   of work; Borderline is where almost-perfect maps need a small nudge.
2. **Click the card** -> opens `calibrate.html?map=<stem>`.
3. **Drag misplaced markers**:
   * Click a marker to select.
   * Shift+click to add to the selection.
   * Click+drag on empty canvas to draw a rubber-band rectangle
     (selects every marker whose center falls inside).
   * Drag any selected marker to move the entire selection.
   * Arrow keys nudge by 1 px (Shift+arrow nudges by 10 px).
   * `R` resets selected markers back to the affine default.
   * Esc deselects.
4. **Save** (Ctrl+S or the Save button). The first save asks you to
   pick the `calibration/configs/` folder via the File System Access API;
   subsequent saves are silent. Firefox / Safari fall back to a plain
   download — drop the file into `calibration/configs/` manually.

While you're working, every drag auto-saves to `localStorage` under
`vt-cal-draft:<stem>`. Close the tab anytime; drafts survive. The
explicit Save above is what writes the actual file. Hitting Save
clears the localStorage draft.

### End of session

```powershell
python _map-analysis/scripts/reprocess.py
```

Regenerates every overlay PNG (tier folders + `staging/`) and rebuilds
`calibration/index.html`. Reload the browser to see the updated tier counts.

### Optional steps

```powershell
# After ingesting new BZN files from Steam:
python _map-analysis/scripts/reprocess.py --regen-map-data

# After improving the detector (rare):
python _map-analysis/scripts/reprocess.py --re-detect-failed
python _map-analysis/scripts/reprocess.py --re-detect-all    # also re-runs proven/borderline

# Render only specific maps:
python _map-analysis/scripts/render_overlays.py --maps vsreuronig,vsrhubris
```

---

## How auto-calibration works

`scripts/prove_png_calibration.py` runs a multi-config detector sweep
on every PNG:

1. Find local-contrast markers in the iondriver PNG (six detector
   configs — varying radius / NMS radius / achromatic-only).
2. For each config: brute-force match the detected markers against the
   BZN-extracted scrap-pool positions (with combinatorial subset
   search for achromatic configs to rescue maps where the contrast
   detector misranks the real pool markers).
3. Solve least-squares affine, score by combined RMSE.
4. Stop on the first config with sub-pixel RMSE; otherwise keep the
   best one found.

Per-map wall-clock budget is capped at 30 s so pathological maps
don't block the corpus pass.

Tiering on the result:
* `RMSE < 2.0 px` -> `auto_proven` (ready to ship)
* `2.0 <= RMSE < 5.0 px` -> `auto_borderline` (eye-check)
* `RMSE >= 5.0 px` or detector fail -> `auto_failed_fallback`
  (uses object-bbox * 1.43 — empirically ~10-40% off, but renders
  *something* so you can see where the markers land)
* No PNG on disk -> `no_png` (nothing to calibrate against)

Once you save any override, the tier flips to `hand_cal` regardless of
the auto-detector's verdict (your edits always win).

---

## Coordinate system & projection formula

The projection used everywhere — in `_schema.project_world_to_pixel`
(Python), `shared.js::projectWorldToPixel` (JS), and the production
`js/positioning-charts.js::_drawMapImageLayer()` — is:

```
imageBounds = config.affine.world_rect

u = (world_x - x_min) / (x_max - x_min)   # 0..1
v = (z_max - world_z) / (z_max - z_min)   # 0..1  (inverted: +Z is north)

if x_flipped: u = 1 - u
if y_flipped: v = 1 - v

pixel_x = u * image_width
pixel_y = v * image_height
```

`world_z` is inverted because BZ2 world `+Z` points north (image top)
but pixel-Y grows downward. The `x_flipped` / `y_flipped` flags exist
because a small number of community-authored iondriver minimap PNGs
were screenshotted upside-down — the detector catches these
automatically. Hand-calibrated maps assume the standard orientation.

### The minimap-bounds quirk

The terrain mesh declared in `.TRN` is usually **larger than the play
area shown in the iondriver minimap**. Dead border (mountains, water,
out-of-bounds canyons) gets cropped by the in-game minimap. For
Europa Night, the minimap shows roughly the inner +/-625m of the
+/-1024m terrain mesh.

This is why every map needs its own `world_rect` — the .TRN bounds
alone produce ~10-40% centripetal compression of overlay markers. The
calibration tool is built to dial this in empirically.

---

## Tier counts

Reflect the state after the last `reprocess.py` run. The header strip
in `calibration/index.html` reads "X / N done (Y%)" where:

* `N` = total maps (currently ~142 from the curated VSR list)
* `X` = `proven + hand_cal + borderline` (the ship-ready subset)

The one map missing from local Steam install: `vsrtransfer`
("Transfer").

---

## Extraction surface (the data catalog)

This workspace is *primarily* for image calibration, but the parsers
already touch every byte of every map file. Below is the complete
catalog of what's available, with **status flags** for what's already
wired vs what's deferred. Use as a roadmap when extending the toolset.

### `.bzn` (game object stream)
**Status: parsed**

* Pool count + 3D `(x, y, z)` positions (with `team` field, currently
  always 0 in the source data)
* Loose scrap count + 3D positions (with biometal value math via
  ODF DB `scrapValue` — `npscrx` = 5 biometal/piece in the VSR mod)
* Spawn points per team slot (`pspwn_1..pspwn_10`)
* Starting units per slot (`ivscout` etc.)
* Map format version, `binarySave` flag, `seq_count`
* Terrain name reference (`g_TerrainName`)
* AI paths / waypoints (`aipath*` objects) — detected, not yet enumerated
* Mission script DLL references (`*.dll`)

### `.ter` (heightmap)
**Status: header + heights decoded; trailer bytes pending**

* Magic `TERR` + version (`uint32 LE`)
* Cell bounds (universal `(-512,-512) -> (+512,+512)` = 1024x1024 cells
  at 2m/cell)
* Per-cell `int16 LE` height
* Per-cell texture/lighting bytes (2 trailing bytes per cell) — not
  yet decoded
* Min/max/mean/stdev heights

### `.trn` (terrain config)
**Status: parsed**

* `[Size]` block (when present): `MinX`, `MinZ`, `Width`, `Depth`,
  `MetersPerGrid`, `Height`, `HeightGranularity`, `Tile`, `Color`
* `[Texture]` block: `TileTexture1..N` references (texture filenames
  live in the game asset pak)
* `[NormalView]` lighting: `DiffuseColor`, `SpecularColor`,
  `SpecularPower`
* `[DLL]` block: `CaptureTarget1..N` (Strategy-mode capture point
  waypoint names)
* `[World]` block (rarely populated)
* `trn_status` enum diagnostic: `ok` / `missing` / `no_size_block` /
  `parse_error`

### `.inf` (mission metadata)
**Status: missionName + netvars parsed**

* `[DESCRIPTION]`: `missionName`, `mapTga` (minimap filename),
  `mapDesc`, `mySide`
* `[NetVars]`: ~50+ `ivar*` / `svar*` fields. Notable ones for future
  surfacing:
  * `ivar0` (kill limit), `ivar1` (time limit), `ivar2` (player limit),
    `ivar2Min` / `ivar2Max`
  * `ivar3` (teamplay), `ivar11` (teamplay lock), `ivar50` (player
    friendly fire)
  * `ivar5` (Strat / DM / etc gametype tag), `ivar7` (starting force)
  * `ivar9` (unit limit), `ivar16` (starting sniper),
    `ivar17` / `ivar18` (AI skill levels)
  * `ivar28` (pilot lifespan), `ivar32` (AI friendly fire),
    `ivar55` (allied pilot swap)
  * `ivar118` (spawn-facing-center), `ivar119` (restore-on-rejoin),
    `ivar120` (invuln seconds)
  * `ivar35..49` per-player team defaults
  * `svar1` / `svar2` (default team names) — already used by Tools page
  * `svar4` (allowed units ODF), `svar5` (starting recycler ODF),
    `svar6` (starting units ODF), `svar7` (shell options),
    `svar8` (asset check ODF)

### `.des` (description text)
**Status: read as plain text**

* Free-form description shown in lobby (may duplicate
  `vsrmaplist.json :: Description`)

### `.sky` (skybox, fixed 7068 bytes, per-map)
**Status: header magic identified, body undecoded**

* Magic `SKY_` + version (`uint32`)
* First ~50 float32s look like color gradients, fog density, sun
  direction, time-of-day
* Per-map (no sharing observed across the 14 maps profiled)
* Decode fully if/when we need atmospheric data in 3D renders

### `.wat` (water, fixed 6512 bytes, mostly shared)
**Status: header decoded, body partial**

* Magic `WATR` + version
* Same tile bounds as `.ter` at bytes 8..15
* Byte 16 `float32` ~10.0 (water plane height) — **useful for 3D
  rendering**
* Body looks like color tints + refraction params (1.0 floats)
* Only ~5 distinct files across the 14 profiled maps (3-way average
  sharing)

### `.dds` (low-res lobby thumbnail)
**Status: format identified, not consumed**

* `DDS ` magic, `DX10` ext header, BC7-compressed 128x128
* Different from the runtime minimap PNG we calibrate against
* Could be used as a fallback when `data/maps/<stem>.png` is missing
* Most maps' `.dds` isn't in the map folder — it lives in the
  game asset pak

### Minimap PNG (`data/maps/<stem>.png`)
**Status: this tool's primary input**

* Hand-calibrated `world_rect` lives in `calibration/configs/<stem>.config.json`
  — THIS tool's primary output
* Image dimensions (mostly 256x256, Europa Night 128x128)
* `mean_luminance` + `luma_band` already computed by
  `scripts/build_map_registry.py` and copied alongside as
  `<stem>.luma.json`
* Could derive: dominant color palette, biome inference from texture
  profile

### ODF DB cross-reference (`data/odf.min.json`)
**Status: live integration**

* Per-object `unit_name` ("Biometal Pool", "Loose Scrap", etc.)
* Per-object `inheritanceChain` (full ancestry from base classes)
* Per-object DB `category` (Vehicle / Building / Weapon / etc.)
* For scrap: `scrapValue` (so we can compute total biometal value per
  map)
* For pools: `scrapCost`, `maxHealth`, tunnel definitions
* For all objects: visual model (`geometryName`), audio, behavior class

### vsrmaplist cross-reference (`data/vsrmaplist.json`)
**Status: live integration**

* Official `Name` (drives our destination folder names)
* `File` (canonical .bzn stem)
* `Image` URL (CDN minimap location)
* `Pools` / `Loose` declared by author (sanity-check vs our extracted
  counts)
* `Author`, `Description` (HTML, may differ from `.des`)
* `Tags` (e.g. "popular")
* `Size`: `formattedSize`, `size`, `baseToBase`, `binarySave`

### Composite / derived data
**Status: opportunities, not implemented**

* Top-down minimap render (already prototyped via the archived
  `archive/scripts/render_map.py`)
* 3D wireframe / textured terrain render (see roadmap below)
* Object distribution heatmaps (pool symmetry, scrap clustering)
* Faction balance metrics (asymmetric pool/spawn placement scores)
* Inferred playable-area boundary (already partial:
  `inferred_bounds_from_objects`)
* Capture point positions (from `.TRN [DLL] CaptureTarget*` waypoint
  names + marker ODFs in `.bzn`)
* Biome classification (texture name patterns + sky color + `luma_band`)
* Map difficulty / "vibe" classification (height stdev + pool count +
  size)

---

## 3D rendering roadmap

Concrete plan for "render any map as a navigable 3D scene" using
Three.js, with asset-availability caveats. **POC shipped under
[render/](render/README.md)** for Europa Night (`vsreuronig`) — full
heightmap mesh + calibrated minimap decal + water plane + object
primitives. Everything below is the broader vision; the POC pulls a
slice of it forward.

### What we have natively

* Heightmap: full per-cell `int16` grid from `.ter` (1024x1024 cells
  x 2m = 2048m mesh)
* Water plane height: `float32` from `.wat` byte 16
* Sky tint: floats from `.sky` header (first ~50 `float32`s, decode TBD)
* Object positions + ODF metadata: from `.bzn` + ODF DB cross-ref
* Texture filenames referenced by `.trn [Texture]` block

### What's NOT in map folders (lives in game asset pak)

* Actual texture image files (`*.tga` referenced by `.trn`) —
  workaround: procedural color ramp by height, OR vendor a subset from
  community packs
* Object meshes (`*.fbx` / `*.xsi`) — workaround: render as
  colored billboards / simple boxes by ODF DB category

### Suggested implementation

```python
# render_map_3d.py - emits a per-map _3d.json that render3d.html consumes
{
  "heightmap": [[h00, h01, ...], [h10, h11, ...], ...],  # 1024x1024 int16
  "height_scale": 0.00305,  # multiply by Height/32767 for meters
  "world_extent": {"min_x": -1024, "min_z": -1024, "max_x": 1024, "max_z": 1024},
  "water_y": 10.0,
  "sky_tint": "#a8b4c2",  # derived from .sky header floats
  "tile_textures": ["bane.tga", "bane2.tga", ...],  # references, not blobs
  "objects": [
    {"odf": "bepool01", "pos": [x, y, z], "kind": "scrap_pool", "unit_name": "Biometal Pool"},
    ...
  ]
}
```

Front-end (`render3d.html` in `_map-analysis/`):

* `THREE.PlaneGeometry(2048, 2048, 1023, 1023)` -> set `Z` attribute
  from `heightmap`
* Material: procedural shader that ramps color by height, OR
  `THREE.MeshStandardMaterial` w/ a vendored texture atlas
* Water: translucent blue `THREE.Mesh` at `water_y`
* Objects: colored `THREE.Sprite` or simple `THREE.BoxGeometry` per
  object, color by DB category
* Camera: `OrbitControls` orbiting the map center
* Lighting: `DirectionalLight` from sky `sun_direction` field
* Optional: minimap PNG as a floating top-down overlay (the
  calibration we just dialed in)

---

## Backlog (prioritized)

1. **Bake staging PNGs into production** — once enough maps are in
   `proven` + `hand_cal`, the `calibration/staging/<stem>.png` overlays can
   be vendored straight into the main `vt-stats` project (e.g. as a
   companion to `data/maps/<stem>.png`) and consumed by the
   Positioning tab + Map Browser.
2. **Bake `world_rect` into production** — once you're confident in a
   batch of calibrations, inject the `affine.world_rect` from each
   `calibration/configs/<stem>.config.json` into the corresponding
   `data/maps/<stem>.json` entry's `image_calibration` field. Then
   re-run `scripts/build_map_registry.py` and the dashboard's
   Positioning heatmaps + Replay trails inherit pixel-perfect overlay
   placement.
3. **Pool ownership timelines** — pool positions are now indexable
   and correctly anchored; render which pools each team held over time.
4. **Faction balance analysis** — are maps with asymmetric pool
   placement measurably favoring one side? Trivial with anchored
   `pool_positions`.
5. **`.ter` smooth decode** — the per-cell trailer bytes (texture
   id + lighting) need 2-4 more hours of reverse engineering to
   eliminate the banding noise in the wireframe / relief renders.
6. **3D map renders** — full Three.js viewer per the roadmap above.
7. **Detector improvements** — better marker recognition would shrink
   the Failed pile. Combinatorial search is already enabled for
   achromatic configs; the next win is probably template matching on
   pool glyph shapes.
8. **Build out `.sky` and `.wat` body decoders** for atmospheric and
   water-rendering data when the 3D viewer ships.

---

## Out of scope

* Touching anything under `scripts/` or `data/` at the project root
  (with the read-only exception of `data/odf.min.json` lookups +
  `data/vsrmaplist.json` manifest reads + `data/maps/*.png` minimap
  backfills).
* Live production wiring — everything stays here until a deliberate
  bake step.

---

## Reference

* **Pipeline / dashboard / data dictionary**: `../DEVELOPER_GUIDE.md`,
  `../docs/DATA_DICTIONARY.md`, `../AGENTS.md`.
* **Production map registry builder**:
  `../scripts/build_map_registry.py`.
* **Production minimap calibration consumers**:
  `../js/positioning-charts.js::_drawMapImageLayer()` and
  `../js/app.js::getMapMeta()`.
* **BZN format reference**: `archive/BZNTools-master/` (vendored).
* **Production ODF DB**: `../data/odf.min.json` (consumed by
  `scripts/analyze_map.py` for object classification).
