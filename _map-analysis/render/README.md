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
`data/render/<stem>.3d.json` and the calibrated minimap
PNG over at `data/maps/<stem>.png`:

```powershell
# From the repo root (the parent of _map-analysis/):
cd <path-to>/vt-stats
python -m http.server 8765 --bind 127.0.0.1
```

Then browse to:
**http://127.0.0.1:8765/_map-analysis/render/index.html?map=vsreuronig**

> Rooting the server at `_map-analysis/render/` looks tempting but breaks
> the minimap + render-data fetches -- `../../data/render/...` would
> escape the server root, which `http.server` rejects. Root at the
> project root and everything resolves.

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

**Easy path** (everything wired into the production pipeline):

```powershell
# Runs the full session pipeline AND auto-builds 3D extracts for every
# map a session references. Bootstraps vsrmaplist + tiles on a fresh
# Steam-equipped clone (one-shot; idempotent thereafter).
python scripts\process_stats.py
```

**Manual extracts** (if you only want the render layer to refresh):

```powershell
# Single map:
python scripts\extract_3d.py vsreuronig
# -> data\render\vsreuronig.3d.json   (about 2 MB)

# Full corpus (overwrites every *.3d.json + composite PNG in-place):
python scripts\extract_3d.py --all

# Refresh the manifest after a corpus pass so has_tier3 flags re-sync:
python scripts\build_render_manifest.py

# Or do all three (corpus + manifest + bootstrap helpers if needed):
python scripts\build_3d_extracts.py
```

Tier-3 tile textures live in `data/render/tiles/` and are also tracked
in git. Regenerate from a local BZ:CC install only if the corpus
changes:

```powershell
python scripts\extract_tile_textures.py
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
    objects.js               per-kind primitive factories + height samplers
    terrain-owners.js        terrain surface: 8 m grid, 2 m tunnel blocks, cuts
    props.js                 placed scenery and tunnel pieces
  vendor/three/              Three.js r170 ES modules (vendored, ~1.3 MB)
    three.module.js
    addons/controls/OrbitControls.js
    LICENSE
```

```
scripts/                     PIPELINE (lives at project root, not under
                             _map-analysis/, so it sits next to every
                             other production script)
  extract_3d.py              one-map pipeline driver
  build_render_manifest.py   refreshes data/render/_manifest.json
  build_3d_extracts.py       per-stem skip-on-existence + soft-fail glue
                             (auto-bootstrap of vsrmaplist + tiles)
  extract_tile_textures.py   tier-3 tile texture extractor (Steam-only)
  _ter_full.py               full-grid .TER decoder
  verify_terrain_scale.py    proves every .3d.json is 1:1 engine meters
  _wat_sky.py                .WAT + .SKY header decoders
  _corpus_stats.py           dev utility (corpus-wide audits)
  _paths.py                  shared path constants (canonical home)
  _schema.py                 schema helpers for calibration configs
```

```
data/render/                 EXTRACTION OUTPUTS (all tracked in git;
                             relocated from _map-analysis/render/data/
                             in the 2026-05 consolidation)
  _manifest.json             map-switcher directory
  <stem>.3d.json             per-map heightmap + objects + tier-3 composite
                             block (142 maps, ~60 MB total)
  <stem>.color.png           tier-3 composite input: color tint
  <stem>.alpha1.png          tier-3 composite input: alpha layer 1
  <stem>.alpha2.png          tier-3 composite input: alpha layer 2
  <stem>.alpha3.png          tier-3 composite input: alpha layer 3
  tiles/                     tier-3 floor textures
    _manifest.json           tile inventory + per-map slot mapping
    <name>.dds               GPU-native BC-compressed tile texture
                             (~420 MB, 219 files; copied verbatim from a
                             local BZ:CC Steam install via
                             extract_tile_textures.py)
```

The entire `data/render/` tree ships pre-baked in git so a fresh clone can
open `_map-analysis/render/index.html?map=<stem>` without running any
pipeline first. The regen path is still fully documented under "Run the
pipeline" above; you only need to invoke it after re-ingesting maps,
changing calibration, or improving the extractor.

## Data contract: `<stem>.3d.json`

Schema 4, written by `scripts/extract_3d.py`. `js/loader.js` rejects any
other version.

```jsonc
{
  "schema_version": 4,
  "map_stem": "vsreuronig",
  "map_name": "VSR: Europa Night",

  "heightmap": {
    "cells_x": 256, "cells_z": 256,           // 8 m samples
    "src_cells_x": 1024, "src_cells_z": 1024,  // 2 m .TER vertices
    "encoding": "int16_le_base64",
    "data": "...",
    "scale": 0.0029949,                        // meters = int16 * scale + base_offset_m
    "base_offset_m": 201.865,
    "height_min_m": 103.73, "height_max_m": 300.0,
    "cell_meters_x": 8.0, "cell_meters_z": 8.0,
    "world_origin": { "x": -1021, "z": -1021 }, // sample (0, 0) = 2 * GridMin + 3
    "ter_version": 5, "decode_method": "ter_v5_cluster_float32"
  },
  "cell_types_map": { "cells_x": 256, "cells_z": 256, "encoding": "uint8_base64", "data": "..." },
  "defaults": { "has_visible_water": false, "has_visible_lava": false },

  "world_rect": {                            // hand-calibrated; from calibration/configs/
    "min": { "x": -667, "z": -627 },
    "max": { "x":  578, "z":  627 }
  },
  "tile_composite": {
    "color_png_rel": "vsreuronig.color.png",   // + alpha1/2/3, info_map_b64, tile names
    "world_min": { "x": -1025, "z": -1025 },   // texel k centred on .TER vertex k
    "world_max": { "x":  1023, "z":  1023 }
  },

  "minimap_png_rel": "../../../data/maps/vsreuronig.png",
  "minimap_dim": [128, 128],

  "water_y_raw": 10.0,
  "sky_tint": "#14191e",

  "objects": [
    { "uid": "scrap_pool#0", "kind": "scrap_pool",
      "obj_class": "bepool01", "world": { "x": 464, "z": 112 } }
    // ...
  ],
  "object_count_by_kind": { "scrap_pool": 7, "spawn_point": 2, "loose_scrap": 42 }
}
```

**Vertical scale is 1:1.** The `.TER` stores float32 engine meters at every
2 m vertex. The extract box-averages them to one sample every 8 m and carries
them as int16; `scale` is a transport unit only, accurate to `scale / 2`.
Both renderers draw the heights unscaled around `base_offset_m`, and actors,
structures, props, liquids and the camera floor use the same meters. There is
no height slider and no per-map default. The `.TRN` `[Size] Height` value is
not a scale either: the engine counts it inside its terrain Y bounds.

**Frames.** `.TER` vertex `k` sits at world `2 * (GridMin + k)`. Sample
`(i, j)` is the mean of vertices `4i .. 4i+3` and sits at
`world_origin + (i, j) * cell_meters`, so the mesh spans `(cells - 1) * 8` m
from `world_origin` and each `cell_types_map` texel is centred on its sample.
The source-resolution color, alpha and InfoMap textures map through
`tile_composite.world_min .. world_max`, which centres texel `k` on vertex `k`.

**Verification.** `python scripts/verify_terrain_scale.py` checks every map
against sources that do not depend on the renderer: the `.3d.json` heights
against a fresh box average of the raw `.TER`, the frames and schema, the
engine terrain bounds of every recorded session
(`y = [min(TER min, H), max(TER max, H)]`, `x/z = 2 * GridMin .. 2 * GridMax`),
BZN-placed scrap pools on the `.TER` surface, v4 build positions, and a
corpus-wide frame test. Run it after any `.TER`, `_ter_full.py` or
`extract_3d.py` change.

## Props sidecar and terrain ownership: `<stem>.props.json`

Written by `scripts/extract_props.py` (standalone; rerun after a models
index regen or a `.TER` change). Schema 3:

```jsonc
{
  "schema_version": 3,
  "map_stem": "vsroverlook",
  "props": [ { "stem": "pbtunn03", "x": -112, "y": 50, "z": 48, "yaw": 180 } ],
  "pieces": {
    "pbtunn03": {
      "bboxMin": [-48, 0, -16], "bboxMax": [48, 60, 16],   // engine-local
      "emissive": ["pbintf00"],
      "terrainPatch": { "minX": -48, "minZ": -16, "step": 2, "cols": 49, "rows": 17, "heights": [] },
      "tunnels": [ { "x0": -16, "x1": 16, "z0": -16, "z1": 16, "y0": 0, "y1": 60, "edge": "twfw" } ]
    }
  },
  // Only on maps that place a terrain-patch piece. World metres, row 0 = z0.
  "terrainHires": [
    { "x0": -184, "z0": 8, "step": 2, "cols": 73, "rows": 41,
      "encoding": "int16_le_base64", "scale": 0.0016, "base_offset_m": 102.5,
      "data": "..." }                       // abs metres = int16 * scale + base_offset_m
  ]
}
```

`terrainHires` blocks are the source 2 m `.TER` heights (`_ter_full._decode_v5`)
around every placed patch piece: the rotated footprint plus `HIRES_MARGIN_M`
(24 m), clamped to the TER, rounded out to the 2 m lattice. Blocks closer than
`HIRES_MERGE_GAP_M` (16 m, two 8 m cells) on both axes merge, so their
transition rings never share a cell.

**Coordinates.** Everything is engine numerics (+X east, +Z north, metres).
Piece geometry is local to the pivot. A row with pivot `P` and yaw `θ` maps
local `(lx, lz)` to `wx = P.x + lx·cosθ + lz·sinθ`, `wz = P.z − lx·sinθ + lz·cosθ`.
Props are placed with `rotation.y = θ` and `scale.z = −1` because
`convert_msh.py` negates Z in every GLB. The replay mirrors the whole world
(`worldGroup.scale.z = −1`); that is never compensated per object.

**Why.** The `.TER` sheet has no tunnel in it: over an underpass it holds the
roof players drive on, and inside an entrance it holds the mapmaker's sculpt.
A tunnel is placed `i76building` props. Each ODF lists its passable cells
(`tunnelNN X0/Z0/DX/DZ` in 8 m terrain squares from the mesh's min-X / north
edge, `tunnelNNEdge` N,E,S,W with `w` wall, `t` terrain, `f` next piece).
Entrance meshes carry a hidden `terrain` node (`terrain__h`); the engine snaps
the heightfield under the piece to it.

**What the renderer does.** `buildTerrainSurface()` in `js/terrain-owners.js`
builds the whole terrain as one indexed mesh, called from both `initFloor()`:

1. Grid: 8 m vertex `(ix, iz)` at `worldOrigin + (ix, iz) * cellMeters`,
   exactly 8 m apart. Each 8 m value is the mean of a 4 x 4 block of 2 m
   vertices, and the extract's `world_origin` is already that block's
   centroid, 3 m in from the first `.TER` vertex (see "Frames" above).
2. Snap: vertices inside a piece's footprint take the bilinear
   `terrainPatch` value (the gate's patch already carries the back-wall top
   across its `f` side).
3. Refine: the 8 m cells inside each `terrainHires` block are replaced by the
   block's own 2 m lattice (snapped too). The block edge runs along 8 m
   lines, holds the 8 m nodes plus the lattice positions along it, and joins
   the lattice through a 1 m zipper strip; each 8 m cell sharing an edge with
   the block is fanned through those edge vertices. No T-junctions, one
   vertex per seam point, so normals are continuous and the 8 m cells next
   to the block carry the 8 m to 2 m transition.
4. Triangulate: every cell splits along the diagonal whose ends are closer
   in height (ties keep NW-SE), so cliff edges follow the mesh on both
   sides of a piece.
5. Cut: inside each tunnel rect, drop triangles whose height range reaches
   into the piece's vertical span. A plateau over a tube never does, so the
   roof stays.

`hm.surface` keeps the result. `sampleTerrainHeight()` (`js/objects.js`) reads
it on the drawn triangles, so pools, props, structures, FX and the camera
floor sit on the surface that is drawn; `sampleSheetHeight()` is the raw
`.TER` sheet, which the camera uses to tell a tube (sheet above it) from open
sky. The camera ground query returns the tube floor and ceiling when the
reference point is inside a rect, within its span, and under the sheet.

Every prop sits at its authored BZN height, as in the game: authors sink
rocks, palms and ruin walls on purpose (Oasis buries `rbruin08` 13.5 m,
Beyond sinks all its scenery 1 m). A row without a height is snapped to the
drawn surface. `OWNERSHIP_SCOPE` in the extractor limits rects and patches to tunnel pieces
(generic props whose cells open onto another piece, bridges included);
`"all"` would also flatten under pools and buildings.

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
[`Terrain.cs`](../reference-repos/bz2terraineditor-master/bz2terraineditor-master/BZ2TerrainEditor/Terrain.cs).
Every byte of every corpus `.TER` is accounted for by the decoder, and
`scripts/verify_terrain_scale.py` checks the heights against the engine.

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
   [`CellType.cs`](../reference-repos/bz2terraineditor-master/bz2terraineditor-master/BZ2TerrainEditor/CellType.cs)):
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
  `int16 * scale + base_offset` and draws them 1:1.
- Emitted as `data/render/<stem>.3d.json` alongside the calibrated minimap,
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

The heightmap mesh spans the `.TER` world bounds (typically `+/- 1024 m`,
i.e. the full 2048 x 2048 m terrain), inset by the 3 m centroid offset at
the min edge and 5 m at the max edge. The
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
