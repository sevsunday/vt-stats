# `render/` — 3D Map Render POC

A standalone, single-page Three.js viewer that renders a BZ:CC map in 3D.
The first map shipped is **Europa Night (`vsreuronig`)** — chosen because
it's our only hand-calibrated map, so any UV misalignment is a viewer
bug rather than a calibration bug.

Everything is self-contained inside this folder. No CDN, no bundler.
The Python pipeline only reads from existing assets elsewhere in
`_map-analysis/`; nothing outside `render/` is modified.

## Open it

There's a small wrinkle: ES modules + `fetch()` won't run from a `file://`
URL on most modern browsers due to CORS. Serve a static HTTP server
**rooted at the repo root** so the viewer can reach both
`_map-analysis/render/data/<stem>.3d.json` and the calibrated minimap
PNG over at `data/maps/<stem>.png`:

```powershell
# From the repo root (the parent of _map-analysis/):
cd <path-to>/vt-stats
python -m http.server 8765 --bind 127.0.0.1
```

Then browse to:
**http://127.0.0.1:8765/_map-analysis/render/index.html?map=vsreuronig**

> Rooting the server at `_map-analysis/render/` looks tempting but breaks
> the minimap fetch -- `../../../data/maps/...` would escape the server
> root, which `http.server` rejects. Root at the project root and
> everything resolves.

> If you'd rather double-click the HTML, launch Chrome with
> `--allow-file-access-from-files` or use the
> `Live Server` extension in VS Code (which serves the open workspace
> root by default -- exactly what we want).

## What you'll see

- The full 1024 x 789 cell heightmap rendered as a smooth, vertex-colored
  terrain mesh (green-tan-grey ramp by elevation).
- The calibrated 128 x 128 minimap PNG draped on the playable region as
  a semi-transparent decal; pool markers in the minimap should line up
  with the yellow cylinder primitives in 3D.
- Translucent water plane at `y = 10 m`.
- 7 yellow cylinders (pools), 2 blue cones (spawns), 42 green spheres
  (loose scrap) sitting on the terrain.
- HUD panel (top-left): map info, floor-mode radio, layer toggles, FPS
  counter, reset-camera button.

## Run the pipeline

The full extraction output ships in git (see "Folder layout" above), so
**you typically don't need to run anything to use the viewer**. Re-extract
only when the BZN, the .TER, the calibration config, or the extractor
itself changes:

```powershell
# Single map:
python _map-analysis\render\scripts\extract_3d.py vsreuronig
# -> _map-analysis\render\data\vsreuronig.3d.json   (about 2 MB)

# Full corpus (overwrites every *.3d.json + composite PNG in-place):
python _map-analysis\render\scripts\extract_3d.py --all

# Refresh the manifest after a corpus pass so has_tier3 flags re-sync:
python _map-analysis\render\scripts\_build_manifest.py
```

Tier-3 tile textures live in `data/tiles/` and are also tracked in git.
Regenerate from a local BZ:CC install only if the corpus changes:

```powershell
python _map-analysis\render\scripts\extract_tile_textures.py
# Defaults to --steam-root "C:/Program Files (x86)/Steam"
```

To render a different map (e.g. Hubris): just visit
`index.html?map=vsrhubris` — the JSON is already on disk. Heads up: maps
with axis flips in their calibration (`x_flipped` / `y_flipped` on
`affine`) will need the viewer to honor those flags before the decal
aligns — for now only `vsreuronig` is verified.

## Folder layout

```
render/
  README.md                  this file
  index.html                 viewer shell (importmap + canvas + HUD)
  css/style.css              HUD styling
  js/
    viewer.js                Three.js scene composition + render loop
    loader.js                fetch + base64 decode
    objects.js               per-kind primitive factories + height sampler
  vendor/three/              Three.js r170 ES modules (vendored, ~1.3 MB)
    three.module.js
    addons/controls/OrbitControls.js
    LICENSE
  scripts/
    extract_3d.py            one-map pipeline driver
    _ter_full.py             full-grid .TER decoder
    _wat_sky.py              .WAT + .SKY header decoders
  data/                      EXTRACTION OUTPUTS (all tracked in git)
    _manifest.json           map-switcher directory
    <stem>.3d.json           per-map heightmap + objects + tier-3 composite
                             block (142 maps, ~60 MB total)
    <stem>.color.png         tier-3 composite input: color tint
    <stem>.alpha1.png        tier-3 composite input: alpha layer 1
    <stem>.alpha2.png        tier-3 composite input: alpha layer 2
    <stem>.alpha3.png        tier-3 composite input: alpha layer 3
    tiles/                   tier-3 floor textures
      _manifest.json         tile inventory + per-map slot mapping
      <name>.dds             GPU-native BC-compressed tile texture
                             (~420 MB, 219 files; copied verbatim from a
                             local BZ:CC Steam install via
                             extract_tile_textures.py)
```

The entire `data/` tree ships pre-baked in git so a fresh clone can open
`render/index.html?map=<stem>` without running any pipeline first. The
regen path is still fully documented under "Run the pipeline" below; you
only need to invoke it after re-ingesting maps, changing calibration,
or improving the extractor.

## Data contract: `<stem>.3d.json`

```jsonc
{
  "schema_version": 1,
  "map_stem": "vsreuronig",
  "map_name": "VSR: Europa Night",

  "heightmap": {
    "cells_x": 1024, "cells_z": 789,
    "encoding": "int16_le_base64",
    "data": "...",                          // ~2 MB base64
    "scale": 0.00305185,                    // multiply int16 -> meters
    "cell_meters_x": 2.0, "cell_meters_z": 2.6,
    "world_origin": { "x": -1024, "z": -1024 },
    "ter_version": 5, "ter_stride": 4
  },

  "world_rect": {                            // hand-calibrated; from calibration/configs/
    "min": { "x": -667, "z": -627 },
    "max": { "x":  578, "z":  627 }
  },

  "minimap_png_rel": "../../../data/maps/vsreuronig.png",
  "minimap_dim": [128, 128],

  "water_y": 10.0,
  "sky_tint": "#14191e",
  "sky_rgb_float": [0.078, 0.098, 0.118],

  "objects": [
    { "uid": "scrap_pool#0", "kind": "scrap_pool",
      "obj_class": "bepool01", "world": { "x": 464, "z": 112 } }
    // ...
  ],
  "object_count_by_kind": { "scrap_pool": 7, "spawn_point": 2, "loose_scrap": 42 }
}
```

## v1 vs v2 scope split

| Feature | v1 (this POC) | v2+ |
|---|---|---|
| Heightmap | full `.TER` v5 cluster decode, float32 -> 256x256 box-averaged | optionally expose source 1024x1024 resolution for hero shots |
| Cell types | decoded but not rendered | water cells -> blue translucent; cliff cells -> rocky material |
| Color map | decoded but not used | per-cell baked vertex color as a fourth floor mode |
| Floor texture | iondriver minimap PNG UV-mapped onto the terrain | actual `.tga` tile textures from `.TRN` (need pak access) |
| Object primitives | cylinder / cone / box / sphere | real `.fbx` / `.xsi` meshes (need pak access) |
| Sky | flat tint background + fog | full skybox from `.SKY` body decode |
| Water | flat plane at `water_y_raw`, hidden by default | per-map "has_visible_water" flag from corpus tagging |
| Lighting | hemi + directional, fixed | sun direction from `.SKY`, optional shadows |
| Object labels | none | CSS2DRenderer for hover-tooltips |
| Maps | just `vsreuronig` (shipped JSON) | directory page + parametric viewer |
| Axis flips | not handled (Europa Night is flip-free) | honor `x_flipped` / `y_flipped` from `.config.json` |

## Notes / known limitations

### Heightmap decode: full `.TER` v5 cluster format

Sourced from the BZ2 Terrain Editor's
[`Terrain.cs`](../archive/bz2terraineditor-master/bz2terraineditor-master/BZ2TerrainEditor/Terrain.cs).
Validated against 5 maps (Europa Night, Hubris, Ebola, 310, Quagmire);
every byte in every file is accounted for in our decoder.

**File header (16 bytes)**:
- `[0..3]`   uint32 LE: magic `0x52524554` ('TERR')
- `[4..7]`   uint32 LE: version (always 5 in our corpus)
- `[8..15]`  int16 LE x4: GridMinX, GridMinZ, GridMaxX, GridMaxZ
  (in TER 2 m units; e.g. Europa Night is `-512..+512` = `1024 x 1024`
  cells covering a 2048 m world)

**Body**: row-major sequence of `CLUSTER_SIZE x CLUSTER_SIZE` clusters
(`CLUSTER_SIZE = 16` for v >= 4). Each cluster is:

1. `1 byte` compression flags (bits 0-5: haveHeight, haveColor,
   haveAlpha1, haveAlpha2, haveAlpha3, haveCell).
2. **Heights**: 256 x float32 LE if `haveHeight` else 1 broadcast float.
   **Float32 in absolute world meters.**
3. **Color**: 256 x RGB (3 bytes each) if `haveColor` else 1 broadcast.
4. **Alpha1/2/3**: 256 bytes each if their flag is set else 1 broadcast.
5. **Cell type** (cliff / water / building / lava / sloped, see
   [`CellType.cs`](../archive/bz2terraineditor-master/bz2terraineditor-master/BZ2TerrainEditor/CellType.cs)):
   256 bytes if `haveCell` else 1 broadcast.
6. **Info map**: 1 uint32 LE per cluster (tile indices + cluster
   visibility + owner team + build type per the Terrain.cs comment).

**Cluster size**: ranges from 16 bytes (fully compressed -- all channels
broadcast) to 2,821 bytes (every channel per-cell). Europa Night
averages 789 bytes/cluster, Ebola averages the max (varied terrain
everywhere).

### v1 pipeline behaviour

- Decode the full 1024 x 1024 (or 704 x 704 for Hubris) float32 heightmap.
- Box-average down to **256 x 256** (factor 4) -- matches the engine's
  MetersPerGrid=8 resolution and keeps browser meshes lean.
- Quantize to int16 LE around the per-map midpoint so the mesh sits
  visually centered at y=0. The viewer recovers meters via
  `int16 * scale + base_offset` and adds a vertical-exaggeration
  multiplier on top.
- Emitted as `data/<stem>.3d.json` alongside the calibrated minimap,
  object positions, sky tint, and water plane height (the .WAT byte-16
  float, suppressed by default per the v1 contract).

### Channels we decode but don't yet visualize

- **Cell type** (water, cliff, building, lava, sloped). Future: tint
  water cells blue, mark cliffs with a different material.
- **Color map** (per-cell baked vertex color from the engine's
  lighting/texture bake). Could replace the minimap-texture approach
  for a more authentic look.
- **Alpha maps 1/2/3** (terrain texture blend weights for layers 1-3,
  using the `TileTexture*` tile filenames from `.TRN [Texture]`). Real
  per-cell terrain texturing if we ever vendor the .tga files from the
  game's asset pak.
- **Info map** (per-cluster tile indices + ownership). Probably only
  useful for in-game inspection, not rendering.

### Water plane suppressed by default

Most VSR maps don't display the engine's water plane (it sits below the
playable surface as engine-internal data). The `.WAT` byte-16 float is
parsed and preserved as `water_y_raw` in the JSON for the future, but
the HUD toggle ships unchecked. Toggling water ON places the plane at
that engine-internal depth, mostly hidden under the terrain.

### Heightmap covers full `.TER` world bounds

The minimap-derived heightmap mesh spans the entire `.TER` world bounds
(typically `+/- 1024 m`, i.e. the full 2048 x 2048 m terrain). The
calibrated `world_rect` is used only to UV-map the minimap texture
onto the playable region of that mesh -- everything outside the
playable area gets the texture's edge pixels clamped (looks fine since
the minimap edge is usually dead-border anyway).

### Other

- **Minimap UV orientation**: `flipY = false` because the iondriver PNG
  is stored row 0 = north. If a future map needs the opposite, expose
  it as a per-map field in the JSON.
- **No `file://` support.** Static HTTP server required (see
  "Open it" above). Browser security restriction, not a code bug.

## Cross-reference

- Pipeline reuses [_map-analysis/scripts/analyze_map.py](../scripts/analyze_map.py)
  for BZN parsing (object enumeration + ODF DB enrichment).
- Calibration data comes from
  [_map-analysis/calibration/configs/&lt;stem&gt;.config.json](../calibration/configs/)
  produced by [scripts/init_configs.py](../scripts/init_configs.py) and
  hand-edited via the calibration tool at
  [_map-analysis/calibration/calibrate.html](../calibration/calibrate.html).
- Three.js vendored from
  [unpkg.com/three@0.170.0](https://unpkg.com/three@0.170.0) per the
  project's no-CDN convention.
