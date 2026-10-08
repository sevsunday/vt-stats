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
    atmosphere.js            engine lighting + fog from the .sky sidecar (shared
                             by viewer.js, replay.js and js/explorer/world.js)
    sky-dome.js              camera-locked sky dome, clouds, sun / moon sprites
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
  _wat_sky.py                .WAT decoder + full .SKY decode (SKY1 atmosphere,
                             FOG volumes, dome / sprite assets) + .TRN material
  extract_sky.py             writes data/render/<stem>.sky.json (schema 5) and
                             the dome GLBs / textures under data/render/sky/
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
  <stem>.sky.json            per-map .SKY decode: `atmosphere` block (fog, sun,
                             ambient, sky colour + alpha, layer switches, stars,
                             dome, terrain material) + dome / cloud / sun / star /
                             sprite asset references (schema 5)
  sky/                       dome GLBs and cloud / sun / sprite textures
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

## Atmosphere: `<stem>.sky.json` (schema 5) and the lighting / fog model

**The `.SKY` file is the atmosphere source of truth.** It holds the fog
ranges, the fog and sky colours, the sun's colour, intensity and position
on its arc, the ambient light, the cloud layer and the dome / sprite assets.
The `.TRN` contributes only the terrain material (`[NormalView]
DiffuseColor`); its `[Light]` and fog keys are legacy data the engine no
longer reads, and the `.3d.json` `lighting` block built from them is kept
only as a fallback for a map with no sidecar. Every value below was read
back from the running game's console (2.0.206) on Remnant and Europa Night
and the sun arc was probed live; the console queries are documented in
[docs/reference/bzcc-console-reference.md](../../docs/reference/bzcc-console-reference.md)
(`sky.*`, `sun.*`, `terrain.*`) and in the ODF Guide's **Console commands**
group.

### `.SKY` layout (version 4, 7068 bytes, 12 chunks)

`SKY1` (212 bytes) is the atmosphere; `FOG ` (488 bytes) the local fog
volumes. `DOME`, `RAIN`, `SPLT`, `MIRR`, `STAR`, `SPRT`, `WATR`, `BOLT`,
`ENV_`, `ENVC` carry assets and effects (`extract_sky.py` reads `DOME` /
`SPRT` for the dome mesh, cloud and sprite textures).

| `SKY1` offset | Console variable | Meaning |
|---|---|---|
| `0x00` RGBA float | `sky.fogcolor` | fog colour (Remnant `120 110 80`, Europa Night `20 25 30`) |
| `0x10 / 0x14 / 0x18` float | `sky.fogrange` start / end, `sky.visibilityrange` | linear fog ramp in metres; nothing is drawn past the visibility range (starts may be negative, e.g. Aussault `-30`) |
| `0x1C` float | `sun.period` | real-time hours per revolution (24 on most maps, 1 on Bolt) |
| `0x20` float | `sun.angle` | position on the arc in hours: 6 = east horizon, 12 = zenith, 18 = west horizon (probed live) |
| `0x24` float | derived | `2 pi * angle / period` |
| `0x2C` RGBA float | `sun.color` | sun colour; **alpha = intensity** (Remnant `255 230 150 200`, Europa Night `255 255 255 125`, Know Thyself 1.96, Lunar black) |
| `0x3C` RGBA float | `sky.ambientcolor` | flat ambient; alpha = intensity (lunar maps are full white) |
| `0x50` float, `0x54` char[32] | `sky.height`, `sky.texturename` | cloud layer height and texture |
| `0x74` BGRA bytes | `sky.color` | the editor's "Sky Color" of the Sky Texture group: tint of the dome and the flat cloud layer (Remnant `180 170 130`, Europa Night `40 55 60`); its alpha (`sky.colora`, 255 on 106 of 157 VSR skies, 50-200 on the rest) is the cloud layer's opacity. **Not** the clear colour: where no layer draws the game shows the fog colour |
| `0x78` int | `sky.modulate` | cloud layer blend: 1 = editor "Add" (additive), 0 = "Blend" (alpha) |
| `0x7C` char[32] | `sun.texturename` | sun sprite (`dunesun`; Europa Night's "sun" is `dunemoonfull`) |
| `0x9C / 0xA0 / 0xA4` float | `sky.uspeed / vspeed / tilesize` | cloud scroll and tiling |
| `0xA8` int | `sky.flags` | dome / stars / flat / clouds toggles |
| `0xB8 / 0xBC` float | `sun.size`, `sun.distance` | sprite span in degrees (30) and distance (200) |

`FOG `: 16 local fog volumes of 7 floats `(x, y, z, rx, ry, rz, density)`
(`-1` = unused), the count at `0x1C0`, then ground fog `(height start,
height end, density, min dist 1000, max dist 2000)`. Decoded into the
sidecar as `local_fog[]` / `ground_fog`; not rendered yet.

### Sidecar `atmosphere` block

```jsonc
"atmosphere": {
  "fog": { "color_hex": "#786e50", "start": 300, "end": 600, "visibility": 600,
           "mode": "linear", "break": 0.5 },
  "sky_color_hex": "#b4aa82", "sky_color_alpha": 1.0,
  "sun": { "period_h": 24, "angle_h": 16, "color_hex": "#ffe696", "intensity": 0.784,
           "texture": "dunesun", "size_deg": 30, "distance": 200 },
  "ambient": { "color_hex": "#375a78", "intensity": 1.0 },
  "cloud": { "texture": "white_clouds", "height": 120, "tilesize": 300,
             "uspeed": 6, "vspeed": 0, "modulate": 0 },
  "flags": 49,
  "layers": { "dome": true, "stars": false, "flat": false, "clouds": false,
              "sprites": true, "sun": true },
  "stars": { "color_hex": "#ffffff", "alpha": 1.0, "count": 128, "distance": 100,
             "size": 1.0, "height": 0, "texture": "lightflare", "modulate": 0,
             "azim_speed": 0, "elev_speed": 0 },
  "dome": { "name": "miredome", "radius": 200, "type": 1, "height": 0,
            "uspeed": 0, "vspeed": 0, "ambient_hex": "#643c14",
            "light": { "azim_deg": 90, "elev_deg": 35, "dist": 300, "range": 400,
                       "attenuation": 1, "color_hex": "#fac878" } },
  "local_fog": [], "ground_fog": { "enabled": false, "...": "..." },
  "terrain_material": { "diffuse_hex": "#b2b2b2", "specular_hex": "#ffffff",
                        "specular_power": null, "emissive_hex": "#000000", "source": "default" }
},
"assets": { "dome_glb": "sky/miredome.glb", "dome_dds": "sky/miredome1.dds",
            "cloud_dds": "sky/white_clouds.dds", "sun_dds": "sky/dunesun.dds",
            "stars_dds": "sky/lightflare.dds", "...": "..." },
"sprite_distance": 100, "sprite_height": 0,
"sprites": [ { "name": "dunemoon", "blend": 1, "color": "#ffdcb4", "alpha": 1.0, "size": 40,
               "azimuth": 0, "elevation": 20, "roll": -80, "texture": "sky/dunemoon.dds" },
             "..." ]
```

Schema 5 (the alpha bytes `sky_color_alpha` / `stars.alpha` /
`sprites[].alpha` joined in 5). `colors.sky` keeps the SKY1 fog colour for older readers. The
`terrain_material` comes from the `.TRN` `[NormalView]` section; the diffuse
default is `178 178 178` (console-confirmed on Remnant, whose `.TRN` has no
`DiffuseColor`), not white. Regenerate with `python scripts/extract_sky.py`
(colours need no game install; dome assets do) and bump the `?v=` key in
`loader.js::loadSkySidecar` when the schema changes.

### Sky layers: `sky.flags` decides what is drawn

The template every VSR `.SKY` descends from names a dome, a cloud texture,
44 sprite slots and a star field on **every** map; `sky.flags` is what
switches them on. The bits come from the editor's six TOGGLE buttons bound
to the variable (`bz2r_res/config/editor/bzeditor_sky.cfg`), and the
engine names them the same way: `sky.toggle` prints `DOME=%d STARS=%d
FLAT=%d CLOUDS=%d SPRITES=%d SUN=%d`. The legacy BZ2 `.TRN` sections pin
the two ambiguous names: `[Sky] SkyTexture / SkyHeight / SkyColor` is the
FLAT layer, `[Clouds] Count / TextureN / SizeN / HeightN` the CLOUDS
billboard system.

| Bit | Editor / engine | What the engine draws | How `sky-dome.js` draws it |
|---|---|---|---|
| `1` | Toggle Dome / DOME | the `dome.name` mesh (DOME chunk) with its texture | the baked GLB, texture × `sky.color` (fullbright when the material ambient is 0) |
| `2` | Toggle Stars / STARS | `stars.count` points of `stars.size` m at `stars.distance` m, `stars.texture`, additive when `stars.modulate` is 1, `stars.colora` | `THREE.Points`, seeded per map (the engine rolls positions at load), point size floored so the texture core covers 2 px |
| `4` | Toggle Flat / FLAT | the flat cloud plane: `sky.texturename` at `sky.height` m, tiled every `sky.tilesize` m, scrolling `sky.uspeed` / `sky.vspeed` m/s, `sky.modulate` 1 = Add / 0 = Blend, opacity `sky.colora` | a camera-locked disc at that height, world-anchored UVs, × `sky.color` as a display-space product (the engine's `default` shader, see below), alpha × `sky.colora`, fogged by the sky fog skirt |
| `8` | Toggle Clouds / CLOUDS | the legacy `[Clouds]` cloud billboards (`Count = 0` on every VSR `.TRN`, so nothing; 17 maps set the bit) | not drawn |
| `16` | Toggle Sprites / SPRITES | the SPRT billboards with `size` > 0 | quads on the sprite shell |
| `32` | Toggle Sun / SUN | `sun.texturename` at the sun direction, `sun.size` degrees | the sun sprite |

Bit `64` appears on six maps and has no editor button. Remnant is `49`
(dome + sprites + sun); Europa Night is `54` (stars + flat + sprites +
sun) — **no dome**, which is why its template `miredome` must never be
drawn. Gating on the flags, not on an asset being present, is what keeps
Europa Night's starry sky apart from Remnant's olive dome.

**Where no layer draws, the game shows the fog colour.** In the Europa
Night frame the sky between the faint cloud wisps reads exactly the fully
fogged `13 18 24` right up to 30 degrees (block medians, G channel 17-18
with smooth blobs to 39), so `scene.background` is the fog colour on every
surface; `sky.color` never appears on screen by itself. (The earlier
reading of "clear colour 40-56 in the upper sky" was the fogged terrain
band and the moon's glow.)

Layouts (all console-confirmed on Europa Night):

- `STAR` (64 B): `0x00` colour B,G,R,A bytes · `0x04` u32 `count` ·
  `0x08` f32 `distance` · `0x0C` f32 `size` · `0x10` f32 `height` ·
  `0x14` char[32] `texture` · `0x34` u32 `modulate` · `0x38`/`0x3C` f32
  `azimspeed` / `elevspeed` (1000 on four maps, not applied yet).
- `SPRT`: 12-byte header (u32 selected slot, f32 `sprites.distance` = 100
  on every map, f32 `sprites.height`), then 56-byte records: name[32],
  u32 `modulate` (1 = Add), B,G,R,A tint bytes, f32 `size`, `azimuth`,
  `elevation`, `roll`. **`size` is metres at `sprites.distance`**: Remnant's
  size-40 moon spans `2 atan(20 / 100)` = 22.6 degrees (the disc fills 0.75
  of the quad), its size-10 companion 5.7 degrees. **Azimuth is a compass
  bearing** (0 north, 90 east): the big moon at azimuth 0 sits due north in
  the game and the small one at 30 to its right. The colour bytes are
  B,G,R,A (the console reports the moon as `255 220 180` for file bytes
  `b4 dc ff`; A is `sprites.colora`, 255 on both moons). **"Add" sprites
  are additive**: the moon texture is a black-backed disc whose lit arc sits
  at the TOP of the image, so only the crescent shows and the roll turns it
  (-80 puts Remnant's lit edge on the right, as in the game). The game draws
  them faint: the crescent adds `+100 +85 +80` to the `135 133 92` dome,
  which `sky-dome.js` reproduces as `encode(texel × tint × 0.135)` added on
  the display-encoded canvas (`SPRITE_ADDITIVE_GAIN`; why the engine
  attenuates them is unknown -- alpha is 255 and the 100 m shell is inside
  the fog start). The sun sprite is not attenuated. **DDS V flip**: DDS rows
  are stored top-first and compressed textures cannot be flipped on upload,
  so sprite / sun / star textures get `repeat.y = -1` -- without it the
  upside-down moon plus the authored roll reads as a left/right mirror of
  the game.
- `DOME` (1808 B, a raw struct with pointers): `0x0C` f32 `radius` ·
  `0x10` char[32] `name` · `0x30` u32 `type` (editor "Dome" 0 on 74 maps,
  "Planet" 1 on 64, 2 on four; no visible difference established) · `0x34`
  f32 `height` (decoded, **not applied**: the sign and reference are
  unverified and a wrong guess opens a seam at the rim; `DOME_HEIGHT_SCALE`
  0) · `0x38`/`0x3C` f32 `uspeed` / `vspeed` (texture drift, applied) ·
  `0x44` f32×3 `ambient` · `0x58..0x74` the first `dome.light` (azim / elev
  in radians, dist, range, attenuation, colour; three more light blocks
  follow at 0x144-byte strides). The dome mesh's own group texture
  (`banedome` → `banesky.dds`) is the fallback when no `.material` or
  sibling `.dds` exists.
- Dome meshes with no baked `.msh` in the install (`earthdome2`,
  `earthdome3`, `ultradome`, `vsrconscdome`) draw nothing; the fog colour
  shows instead.

**Sky fog.** The engine fogs the sky layers toward the horizon: in both
reference frames the stars and cloud wisps vanish into the fog colour below
about 15 degrees and reappear by 30-40 degrees, which is distance fog on a
layer `sky.height` metres up (`(h / sin e - fogstart) / (fogend -
fogstart)`; Europa Night is fully fogged below 14 degrees and clear above
53, Remnant between 11.5 and 24). `addFogSkirt()` overlays a camera-locked
band carrying that fraction as alpha in the fog colour on every sky layer
(the cloud plane carries no fog of its own, so it is fogged exactly once);
terrain still occludes it. `sky.fogbreak` (0.5 everywhere) is not used for
this. The dome is also lit by `dome.light` in the game (Remnant's east sky
reads `193 184 121` against `118 121 89` in the west at the same
elevation); that term is decoded but not applied yet.

**Draw order.** The dome and the legacy gradient sit in the opaque pass
with the depth test off, so the terrain simply overwrites them. Stars,
sprites, the sun, the cloud plane and the fog skirt need real blending,
which three.js only enables on `transparent` materials, so they draw in
the transparent pass (`renderOrder` -18 … -9), depth-tested against the
terrain, single-pass (`forceSinglePass`, or a DoubleSide additive quad is
added twice) and at the far edge of the rig (`SKY_FAR_FRACTION` 0.995,
shells 0.96-0.99) so every hill inside the visibility range is in front of
them.

Mirroring: the replay and the explorer reflect the world on Z, so north is
`-Z` there and `attachSky` takes `state.mirrorZ` (default true) for the
sprite directions; the baked dome GLBs are pre-mirrored and the map
viewer's unmirrored orbit scene flips the dome holder back.

### What the engine's shaders say

The game ships its compiled DX11 shaders in
`bz2r_res/baked/shaders/*.fxc` (DXBC containers): a `default` family
(`dx11_default_psh_<n><flags>.fxc`, 2,000-odd permutations over the flag
letters `c d e l n o p s t x y z`), plus `terrain`, `water` and
`local_fog`. There is no sky-specific shader: the dome, the cloud plane,
the sprites and the sun all render with `default`. `D3DDisassemble` from
the Windows `d3dcompiler_47.dll` reads them (Python `ctypes`: load the
DLL, call `D3DDisassemble(bytes, len, 0, None, &blob)`, read the blob
through its vtable; the RDEF chunk also lists the constant buffers).
What the disassembly establishes:

- **Unlit textured (`0pd`)**: `out.rgb = lerp(texel.rgb *
  g_MaterialDiffuse.rgb, g_FogColor.rgb, fog)`, `out.a = texel.a *
  g_MaterialDiffuse.a`. **No gamma / pow anywhere.** There is no vertex
  colour input; every tint reaches the pixel as the `g_MaterialDiffuse`
  constant (cbuffer `psfloats`: `g_FogColor`, `g_FogParams`,
  `g_MaterialDiffuse`, `g_MaterialSpecular`, `g_MaterialEmissive`,
  `g_LightAmbient`, `g_LightCount`, `g_TeamColor`, `g_EnvironmentColor`,
  `g_HeightFogParams`, `g_HeightFogParams2`, `g_SoftnessThreshold`,
  `g_ModulateBlending`).
- **Fog** is range fog on `|viewPos|`: 0 below `fogstart`, `g_FogParams.x`
  (full) past `fogend`, and between them a two-segment ramp through
  `fogbreak` (`(1-b) * t / b` below the break, `(1-b) + b * (t-b) / (1-b)`
  above; `b` outside 0.01..0.99 falls back to 0.5, which makes the ramp
  plain linear). A height / ground fog term (`g_HeightFogParams*`:
  enable, height start / end, density, curve exponent, min / max distance)
  combines as `1 - (1-f)(1-g)`; it is off on the VSR maps. A layer
  `sky.height` metres up therefore fogs by exactly `h / sin e` -- the fog
  skirt's rule.
- **Lit textured (`0pdl`)**: `texel * g_MaterialDiffuse * (g_LightAmbient
  + sum over lights of m_Color * (1 - (d / range)^2) / (a0 + a1 d + a2 d^2)
  * spot * saturate(N . L)) + specular`, then the same fog lerp (lights in
  cbuffer `pslights`: `m_Pos`, `m_Dir`, `m_Color`, `m_Attenuation`,
  `m_Spot`). This is the form the dome's `dome.ambient` / `dome.light`
  would take if the dome is lit.
- The sky textures are declared sRGB (`white_clouds.dds` and
  `dunemoon.dds` DXGI format 78 = BC3_UNORM_SRGB, `miredome1.dds` 72 =
  BC1_UNORM_SRGB).

Put together with the measured fact that the fog constant displays as its
bytes (Remnant's horizon `120 109 78` for `120 110 80`), only two
pipelines are possible -- everything UNORM, or sRGB views with constants
decoded on the CPU -- and in both a `texel x constant` product lands on
screen as `texel_byte * byte / 255` (within the sRGB round-trip). That
pins the **cloud plane**: `addFlatClouds` tints with the decoded
`sky.color` (`displayColor`), so Europa Night's `white_clouds x 40 55 60`
peaks at display (36,50,54) -- +20..30 over the fog unfogged, +11 at the
95th percentile and about +20 at the brightest texels through the skirt
fog at 28-30 degrees, against the in-game frame's +20 / +24. The raw
byte-as-linear tint the renderer used before put the same wisps at +70.

What the shaders do **not** settle, and what therefore stays as a
frame-matched calibration rather than an engine rule: which constants the
engine binds for the **dome** (its `.material` diffuse is white and the
DOME chunk carries its own ambient and light, so `sky.color` is probably
not its tint at all; the raw-as-linear `sky.color` tint is kept because it
lands on the in-game Remnant average, while a fit of the frame's NW..NE
band against the `miredome1` texture -- which is itself brighter to the
east, luma 190 at azimuth 45-105 against 120-130 west -- was not
decisive); the **sprite attenuation** (`SPRITE_ADDITIVE_GAIN`, the shader
has no attenuation term, so the cause is blend state or fog on a farther
shell); and whether **stars** fog by elevation (the frame says so, the
shader would fog them at their 200 m shell; the skirt matches the frame).
`dome.u` / `dome.v` static texture offsets (DOME chunk 0x04 / 0x08; Giza
0.0475, Lunar 0.168, Aussault -0.25) are decoded but not applied.

**Sun shadows (`*z*`, `BZ_WANT_SHADOW`).** The lit permutations
(`dx11_default_psh_0pdlz`, `dx11_terrain_psh_8pdelz`, `dx11_water_psh_*z*`)
bind four cascaded maps `t28`..`t31` and one `psshadow` cbuffer:
`g_ShadowSplitPoints` plus a texel size per cascade. A fragment picks a
cascade by view-space depth (hard cuts, no blend) and, past the last
split, is unshadowed. Each cascade takes four hardware-PCF taps at ±0.5
texel (`sample_c_lz`) and averages them. The factor multiplies **light 0
only** (the sun); ambient and emissive are untouched, and the factor is
reset to 1 before every later light. Sky layers are unlit (`0pd*`, no
`z`) and do not receive shadows. Terrain as a *caster* is not visible in
the pixel shader (the depth pass is separate); hills shading valleys is
in-game observation. Split distances, map sizes (`ShadowOff` / `Low` /
`Med` / `High`) and the depth bias are not in the shader.

### Lighting model (`js/atmosphere.js`)

The engine's terrain shading is the classic `albedo * material *
(ambient + sun * saturate(N . L))`:

- **Lights.** One flat `AmbientLight(sky.ambientcolor, alpha)` and one
  `DirectionalLight(sun.color, alpha)`; no hemisphere term. three.js r170
  normalises Lambert by `1 / pi`, so both intensities are multiplied by
  `pi` to recover the plain multiplier the engine computes.
- **Shader colour bytes are linear values.** The game's textures are sRGB
  DDS (hardware-linearised) and its shaders carry no gamma code, so the
  colour bytes feed the math as-is (`255 230 150` is `(1.0, 0.9, 0.59)`).
  `engineColor()` sets the sun, ambient and the dome / sprite tints with
  `LinearSRGBColorSpace` (no decode); textures and the sRGB output stay as
  they were. The one shader-verified exception is the cloud plane's
  `sky.color`, a display-space product (see "What the engine's shaders
  say"). **The fog colour displays as its raw bytes**: Remnant's
  fogged horizon reads `120 109 78` for `120 110 80`, Europa Night's
  `13 18 24` for `20 25 30`, so `displayColor()` sets it as sRGB and the
  output encode hands the bytes back. It is also the clear colour
  (`resolveAtmosphere().clearColor`): the game shows it wherever no sky
  layer draws.
- **Sun arc.** `theta = 2 pi (angle + elapsed / 3600) / period`,
  `dir = (sin theta, -cos theta, 0)`: rises in the east (+X), zenith at
  12, sets in the west. The replay advances `elapsed` with match time, the
  explorer and the map viewer with wall-clock time (static in practice on
  24 h maps, a full cycle per hour on Bolt). Below the horizon the sun
  fades out over the last few degrees instead of lighting from
  underground. `SUN_ORBIT_AZIMUTH_DEG` rotates the arc (0 = engine-true);
  Z is negated for scenes whose world group is mirrored (`mirrorZ`).
- **Terrain material.** The game-tile floor is multiplied by the `.TRN`
  diffuse (`178 / 255` by default, `240 / 255` on Europa Night). The
  minimap drape and the height ramp are already-shaded fallbacks and keep
  their colour.
- **Sky.** `scene.background` is the fog colour; the flat cloud plane is
  `texel x sky.color` as a display-space product (shader-verified), the
  dome texture is modulated by `sky.color` taken raw-as-linear (a
  calibration: on Remnant the dome texture `164 179 133` times
  `180 170 130` lands within a few levels of the in-game sky `146 143 100`;
  the fog colour would be 45% too dark, the display-space product 20% too
  dark on average -- the engine very likely lights the dome by
  `dome.ambient` / `dome.light` instead, which is not modelled yet).
  The sun / moon sprite spans `sun.size` degrees at the engine sun
  direction, and the camera-locked rig is scaled to fit inside the camera
  far plane. Which layers exist at all is the "Sky layers" section above.

### Sun shadows (`js/shadows.js`)

`createSunShadows()` hides the plain directional light (the sky sprite
still follows it) and replaces it with four cascaded lights from the
vendored three.js r170 CSM addon (`vendor/three/addons/csm/`, `fade`
off, `PCFSoftShadowMap`). Every lit material is `prepare`d so it is lit
by one cascade instead of all four. Terrain, props, ships and buildings
cast and receive; water receives only. The explorer shadows out to
`camera.far` (on unless `?shadows=0`). The replay fits the cascades to
what the camera can see of the map, clamped to `camera.far`, and skips
the shadow pass while paused with a still camera. First person moves the
hull to a shadow-only layer so it still shades the ground. The map
viewer does not import this module, so `?topdown=1` thumbnails stay
byte-stable. `SHADOW_CASCADES` and `SHADOW_FADE` are the verified
counts; map size, split mode, bias and the light margin are calibration
knobs at the top of `shadows.js`. `?shadowdebug=1` warns if a lit
material was not prepared.

### Fog model and the camera policy

Fog is a **linear** ramp (`sky.fogmode` 3, `sky.fogbreak` 0.5 on every map
queried) from `fogstart` to `fogend` in the fog colour, and nothing is
drawn beyond `visibilityrange`. `installLinearFog()` swaps the three.js
smoothstep `fog_fragment` chunk for that ramp (it runs on import, before
any material compiles); `applyEngineFog()` sets `camera.far =
max(visibility, end) * 1.02` so fully fogged pixels, not a hard edge, hide
the clip. Players can only shorten these ranges in-game
(`GamePrefs.ini` `VisibilityMult`, `MaxVisibility`, `MinFogRange`,
`MaxFogRange`), never extend them.

| Surface | Lights | Fog | Shadows |
|---|---|---|---|
| Game Explorer (`js/explorer/world.js`) | engine | exact engine fog + visibility clip, always (the camera is in the world) | on, out to `camera.far`, unless `?shadows=0` |
| 3D replay, chase camera | engine (In-Game Lighting on) | engine fog + clip while the **Fog** setting is on | when **Shadows** is on; range fits the view, capped at the fog far plane |
| 3D replay, free / cinema / top-down cameras | engine | none, far plane 8000 m | when **Shadows** is on; cascades fit the visible map |
| 3D replay, In-Game Lighting off | studio stack | per camera as above | the studio sun, same checkbox |
| Map viewer, orbit and embed | engine | none | none |
| Map viewer, top-down capture (`?topdown=1`, batch) | studio stack | none (the committed `data/render/topdown/*.png` stay byte-stable) | none |

The replay's quality panel (`js/replay-quality.js`) carries three switches:
**In-Game Lighting** (default on; off restores the pre-atmosphere ambient 0.9
+ hemisphere 0.85 + directional 2.0 stack via `applyStudioLights()`),
**Fog** (default on; chase camera only) and **Shadows** (default on in the
High preset, off in Low and Medium). Settings saved before these switches
existed have no `lighting` key and take the new defaults once; settings
with no `shadows` key take the matching preset's value (a custom mix takes
High's, on). Changing any of them reloads the replay, as every quality
setting does.

### Calibration against the game

Compared with in-game screenshots (2.0.206, mission time under 3 minutes,
so the sun sits at the authored angle):

- **Remnant**: sky dome `137 138 103` vs in-game `146 143 100`; flat ground
  within 5-10% in sRGB; lit and shadowed mountain faces comparable;
  the far ridge dissolves into the `120 110 80` haze and the dome shows
  through at 600 m, with the palms and towers visible at 300-400 m.
- **Europa Night**: the cast shadow of the tank is 5-6x darker than the lit
  snow in linear light in both the game and the render, which pins the
  ambient : sun ratio; the ground reads about 20% brighter than the game's
  `95-100` in sRGB. Treating the sun alpha as intensity is what puts the
  snow near the game (ignoring it would read about 175); the remaining
  uniform factor is not attributed yet (candidates: the `.TER` vertex
  colour layer, texture filtering) and is left alone rather than tuned.
- Lunar / Lunix / Moonshroud come out flat-lit (black sun, white ambient),
  Know Thyself under its 1.96-intensity orange sun, Aussault / Bolt fogged
  from `-30` / `-50` m: that is the game's look, not a bug.
- **Sky layers** (after the flags work, the sprite pass and the
  shader-verified plane tint): Europa Night's sky is the fog colour
  `20 25 30` (the game's frame shows `13 18 24`, its own display sitting 7
  below its bytes) with the cloud wisps fading in above ~17 degrees as
  faint light blobs -- at 28-30 degrees ours sit +11 over the fog at the
  95th percentile (the display-space `texel x sky.color`; the raw tint put
  them at +70) against the game's +20 / +24 at the brightest texels, with
  an angular feature scale of ~1.4 degrees against the game's ~2.1 -- the
  full-moon "sun"
  high in the west reading 206 against the game's 250 peak, the nebula
  sprite beside it and 128 star points; the `miredome` is gone. Remnant
  keeps its olive dome with the two additive crescent moons due north and
  north-north-east, lit on the right as in the game, the big crescent
  adding `+91 +82 +75` to the dome against the game's `+100 +85 +80` and
  the small one `+70 +70 +65` against `+72 +65 +64`, no dark disc, no
  white-cloud plane. Star positions are a per-map seed, not the game's
  roll; the Clouds bit (8) draws nothing (`[Clouds] Count = 0`).

## v1 vs v2 scope split

| Feature | v1 (this POC) | v2+ |
|---|---|---|
| Heightmap | full `.TER` v5 cluster decode, float32 -> 256x256 box-averaged | optionally expose source 1024x1024 resolution for hero shots |
| Cell types | decoded but not rendered | water cells -> blue translucent; cliff cells -> rocky material |
| Color map | decoded but not used | per-cell baked vertex color as a fourth floor mode |
| Floor texture | iondriver minimap PNG UV-mapped onto the terrain | actual `.tga` tile textures from `.TRN` (need pak access) |
| Object primitives | cylinder / cone / box / sphere | real `.fbx` / `.xsi` meshes (need pak access) |
| Sky | done: dome, clouds and sprites from the `.SKY` decode (`sky-dome.js`) | `sky.flags` cloud / star toggles, `STAR` starfields |
| Water | flat plane at `water_y_raw`, hidden by default | per-map "has_visible_water" flag from corpus tagging |
| Lighting | done: the engine's ambient + sun from `.SKY` (`atmosphere.js`) and four-cascade sun shadows (`shadows.js`) | local / ground fog volumes |
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
