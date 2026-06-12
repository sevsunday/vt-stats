# Object Render

> **Promoted to production.** The browser POC that used to live here now ships
> as the standalone **Models** page: [`models/index.html`](../models/index.html)
> + [`js/models.js`](../js/models.js) + [`js/models-viewer.js`](../js/models-viewer.js)
> + [`css/models.css`](../css/models.css), with three.js vendored at
> `vendor/three/`. This folder is retained only as the reverse-engineering
> record (`FORMAT.md`) and the diagnostic `spike/` scripts. The conversion
> pipeline lives at `scripts/object-render/` and still writes `data/models/`.

Extracts real Battlezone: Combat Commander ship/building/projectile geometry
from the game's baked `.msh` files and renders it in three.js -- a standalone
single-object viewer (full 360 orbit) plus a searchable/filterable object
browser scaled to the **entire renderable corpus** (~700 models).

The generated assets under `data/models/` are the durable output the Models
page reads (and the ODF browser + match replays may read later).

## Coverage

Every ODF `GameObjectClass.geometryName` plus every weapon/ordnance
`shotGeometry` that resolves to a baked `.msh`, indexed across the base game +
the VSR config mod + every workshop asset/model pack (the same roots
`_map-analysis/scripts/bz2_paths.py` walks). ~702 unique meshes after dedup by
lowercased mesh stem. The handful that don't resolve (~34) are map scenery
(cacti / palms / pines / grass), a few `_skel` rigs, and `.xsi`-sourced
projectiles that were never baked on this machine.

Factions by ODF prefix: `i`->ISDF, `e`->Hadean, `f`->Scion, `c`->Cerberi, else
Other. Categories come from the `data/odf.min.json` bucket (Vehicle / Building /
Powerup / Mine / Misc / ...), with `shotGeometry` projectiles bucketed as
`Ordnance`.

## Dual-quality assets (the key idea)

One **geometry GLB** per model (shared by both quality modes), plus **two
deduped diffuse texture sets**, assigned at runtime by material name:

- **Performance** -- `data/models/textures/perf/<stem>.png` (512px, decoded from
  the `.dds` mip pyramid). Small, low-VRAM; the browser default and the future
  many-units-on-screen replay default.
- **High quality** -- `data/models/textures/hq/<stem>.dds` (native 2048
  BC-compressed, copied verbatim -- the game's true max quality). Loaded via the
  vendored `DDSLoader`.

The GLB carries per-primitive materials **named by their lowercased diffuse
`.dds` stem** (the `.material [solid]` diffuse becomes `baseColorFactor`, so
textureless materials like cockpit glass keep their real color) but **no
embedded texture**. The viewer loads the GLB then, per material, loads
`textures/<perf|hq>/<name>.{png|dds}` and assigns `material.map`; materials with
no matching file keep their `baseColorFactor`.

The browser defaults to **perf**, with a per-object **Performance | HQ** toggle
and a global **Prefer HQ** preference (`localStorage vt.obj.quality`).

## Output layout

```
data/models/                        (committed via git LFS)
  index.json                        manifest: models[] + odf_index (odf -> stem)
  geometry/<stem>.glb               geometry + UVs + named materials, no tex
  textures/perf/<stem>.png          512px diffuse (perf)
  textures/hq/<stem>.dds            native 2048 diffuse (HQ, verbatim)
  textures/teamcolor/<stem>.png     <=512px team-color mask (alpha=region, rgb=shading)
  textures/emissive/<stem>.png      <=512px emissive glow map (windows / engines / lights)
  textures/mods/<pack_id>/          workshop mod texture-set overrides, same keying:
    perf/<stem>.png                   512px diffuse
    hq/<stem>.dds                     native 2048 diffuse (verbatim)
    teamcolor/<stem>.png              the pack's own _c mask (when shipped)
    emissive/<stem>.png               the pack's own _e map (when shipped)
  thumbnails/<stem>.png             hero (~256px) for the directory cards
  shots/<stem>/<angle>.png          7-angle HQ gallery (~512px):
                                     hero/front/back/left/right/top/bottom
```

## Pipeline

```
BZCC baked **/<geo>.msh (DOCB binary, across base + workshop packs)
        |
        v   scripts/object-render/msh_parser.py     decode geometry (rest pose
        |                             via inverse bind matrices; faithful walk)
        |   scripts/object-render/dds_decode.py     BC1/BC3 .dds -> RGBA, mip
        |   scripts/object-render/glb_writer.py     stdlib glTF 2.0 binary writer
        |   scripts/object-render/msh_thumbnail.py  per-pixel numpy rasterizer
        |                             (bilinear HQ texture, smooth normals, 2x AA)
        v
scripts/object-render/convert_msh.py  ->  data/models/{geometry,textures/{perf,hq},thumbnails,shots,index.json}
        |
        v
models/index.html + js/models*.js   three.js r170 + OrbitControls + GLTFLoader + DDSLoader
```

## Regenerate the assets

Requires the BZCC (BZ2R) install on this machine plus the VSR workshop asset
packs subscribed (the baked `.msh` + `.dds` live under
`steamapps/common/BZ2R/` and `steamapps/workshop/content/624970/`). Python deps:
stdlib + **Pillow** (`.dds` decode) + **numpy** (the build-time gallery
rasterizer -- DEV-only, not shipped to the site).

```
python scripts/object-render/convert_msh.py --limit 20        # smoke run (first 20 by stem)
python scripts/object-render/convert_msh.py --jobs 12          # full run, parallel
python scripts/object-render/convert_msh.py --force --jobs 12  # ignore cache, rebuild all
python scripts/object-render/convert_msh.py --odf ivscout_vsr.odf
```

Caching: a model is skipped when its `.glb` + hero thumbnail + 7 gallery shots
already exist and the `.glb` is newer than the source `.msh` (its prior
`index.json` entry is reused). `--no-render` skips images (geometry + textures
only); `--no-gallery` keeps the hero but skips the 7-angle gallery.

## Run the viewer

ES modules + `fetch`, so it must be served over HTTP (not `file://`). From the
repo root:

```
python -m http.server 8731
```

Open <http://127.0.0.1:8731/_object-render/>. Search / faction / category /
sort filter the grid (committed static thumbnails -- no live WebGL per card, so
it scales). Click a unit to inspect it; drag to orbit (all angles incl.
underside), scroll to zoom, right-drag to pan. Toolbar: Performance | HQ texture
toggle, Wireframe, Auto-rotate, Reset view, and **Capture HQ** (renders the 7
canonical angles at HQ + 2x supersample and downloads them -- a one-off
convenience; the committed galleries for every model already come from the build
script).

## Hosting (GitHub Pages) -- no Git LFS

The site is served from this repo via GitHub Pages. The one hard rule:

- GitHub Pages does NOT resolve Git LFS -- it serves the ~130-byte LFS pointer
  text instead of the real binary, breaking the `.glb`/`.png`/`.dds` loaders.
  So the entire `data/models/` asset set is committed as **PLAIN git blobs**
  (never LFS).

The **full set is published** (geometry GLBs + perf PNG + HQ `.dds` + hero
thumbnails + the multi-angle `shots/` gallery, ~1.7 GB total):

```
data/models/geometry/<stem>.glb       committed
data/models/textures/perf/<stem>.png  committed (512px, default)
data/models/textures/hq/<stem>.dds    committed (native 2048, HQ toggle)
data/models/textures/teamcolor/<stem>.png  committed (<=512px team-color mask)
data/models/thumbnails/<stem>.png     committed
data/models/shots/<stem>/*.png        committed (capture targets / future OG)
data/models/index.json                committed
```

GitHub Pages documents a 1 GB published-site limit, but it is not strictly
enforced here -- the multi-GB repo serves fine. The browser defaults to perf
with a working **HQ** toggle (`HQ_AVAILABLE = true` in [js/app.js](js/app.js));
the viewer's HQ path still degrades to the perf PNG if a `.dds` is ever absent.
If repo size becomes a problem later, move `textures/hq/` + `shots/` to an
external host and point `TEX_BASE` (and the thumbnail/glb bases) at it.

## Coordinate / format notes

- Geometry is meters, Y-up -- already three.js convention, no axis swap needed.
- BZCC is a DirectX (left-handed) engine; the converter negates Z + reverses
  winding to produce un-mirrored right-handed glTF (toggle `--no-handedness-fix`).
- GLB UVs are authored for the glTF `flipY=false` convention; the viewer forces
  `flipY=false` + `SRGBColorSpace` on BOTH texture sets so perf + HQ share UVs.
- Models render in their SYMMETRIC rest pose (inverse bind matrices), not a
  mid-animation pose. Format decode record: `spike/FORMAT.md`.

## Interactive moveable parts (articulation)

The published GLBs preserve the baked mesh-tree node hierarchy for every rigid
multi-node model (not just the ~126 with baked clips), so named moveable parts
survive into the viewer. The viewer detects them by the BZCC naming conventions
(confirmed against the ODFs) and exposes a "Parts" panel:

- `turret_y` / `turret_x` -> turret yaw / pitch (sliders + a click-drag
  mouse-aim mode)
- `recoil*` nodes -> a Fire button that pulses them back and springs them home
- a `tread` / `fvtread` material -> a Drive slider that scrolls the tread UV
  (and plays the body `forward` / `reverse` bank clip when the model has one)

Each model's manifest entry carries a `parts` block
(`{turret, pitch, recoil, treads, bankClips}`, null when nothing articulates)
which also drives the directory "Articulated" badge. The pipeline switch lives
behind `ANIM_FORMAT_VERSION` (now 4; index `schema_version` 8).

## Team colors (the `_c` mask)

BZCC `.material` files declare `teamColor = <stem>_c.dds` -- a BC3 mask whose
**alpha channel marks the colorizable region** and whose **RGB carries the
shading detail / baked default tint**. The pipeline extracts these masks into a
single perf-resolution set:

```
data/models/textures/teamcolor/<diffuse_stem>.png   (<=512px, RGBA preserved)
```

keyed by the **diffuse/material stem** so the viewer maps a material name
straight to its mask (no `_c` suffix guessing -- the `teamColor` reference is
read directly from the `.material`). Each manifest entry carries a
`teamColorTextures` list of the stems that got a mask; this drives the directory
"Team color" badge and the viewer's "Colors" button (both appear only for masked
models, like the Parts button). ~200 of the ~700 models have masks (the canonical
units/buildings); the rest fall through cleanly.

The viewer composites in a GPU shader (per-material `onBeforeCompile`), blending
before lighting so shadows/lighting still apply:

```glsl
// masked region = teamColor * mask-luminance * TEAM_GAIN, blended by coverage
diffuseColor.rgb = mix( diffuseColor.rgb,
                        uTeamColor * shade * TEAM_GAIN,
                        coverage * uTeamMix );
```

Recoloring is just a uniform update (no texture reload), so presets + the
freeform picker are instant. Default is **off** (`uTeamMix = 0`) -- the original
baked diffuse shows until the user picks a color; wireframe suppresses the tint.
The exact engine formula isn't published; `TEAM_GAIN` (in `js/models-viewer.js`)
is the tuning knob if a unit reads too dark/bright. HQ has no separate mask set --
coverage + shading needs no 2048 fidelity, and a single perf set keeps the repo
from growing ~1 GB.

The texture-set switch lives behind `TEXTURE_FORMAT_VERSION` (now 2; index
`schema_version` 8). A bump forces a **texture-only** re-emit: otherwise-fresh
models are reprocessed to emit the new masks, but the GLB write is guarded
(skipped when fresh) so the ~700 deterministic geometry GLBs don't churn.

## Emissive glow maps (the `_e` map)

BZCC `.material` files declare `emissive = <stem>_e.dds` -- a self-illumination
map (cockpit windows, engine exhausts, building lights). The pipeline extracts
these corpus-wide into `data/models/textures/emissive/<diffuse_stem>.png`
(<=512px RGB, same diffuse-stem keying as the team-color masks; an `_e`
filename-convention probe covers inline-material workshop models with no
`.material`). The viewer assigns `material.emissiveMap` + a white `emissive`
color per material -- glow regions stay lit regardless of the sun, which is
exactly the in-game look. The wireframe override nulls the emissiveMap while
painting its flat-white lines (solid white emissive IS the wireframe look) and
restores it on exit. Each manifest entry carries an `emissiveTextures` stem
list.

## Mod texture sets (workshop re-texture packs)

Three community texture-override mods are mirrored as switchable **texture
sets** (the `MOD_TEXTURE_PACKS` registry in `convert_msh.py`):

- `1554202061` Scion Stock-Enhanced Textures
- `1581901346` ISDF Stock-Enhanced Textures
- `3365986032` ISDF Redux Re-Texture

These packs are pure DDS overlays keyed by the same stems the stock game uses,
so detection is an exact stem intersection against each model's resolved
diffuse stems. Per pack and per covered stem the pipeline emits a 512px perf
PNG + the native 2048 HQ DDS (verbatim), plus the pack's own `_c` mask, `_e`
glow map, `_n` normal map, and `_s` spec map (converted to roughness) when
shipped (matched via the `.material`-declared names with the `_d`-strip
filename-convention fallback -- see `_aux_name_candidates`). Packs not
installed on the build machine are soft-skipped with a console warning.

Each manifest entry carries `textureSets` (packs covering >=1 of its stems,
with per-pack `textures` / `teamColorTextures` / `emissiveTextures` /
`normalTextures` / `specularTextures` stem lists); the top-level
`texture_packs` block maps pack id -> `{label, url}` for the credit links. The viewer surfaces a **Textures** button (only for covered
models) with Stock + one row per set showing material coverage and a Steam
Workshop credit link-out; uncovered stems keep stock textures (partial
coverage is expected and fine -- the packs derive from the stock art).
Switching sets re-runs the texture assignment per material; team color +
quality toggle compose with whichever set is active (the active set's own `_c`
mask wins, stock mask fills).

## Normal + specular maps (`_n` / `_s`)

Both SHIPPED (texture format v3). Stock `_n.dds` sources are legacy-fourcc
**BC5-SNORM** -- `dds_decode.py`'s BC5 branch decodes the two signed BC4
channels, reconstructs Z (`sqrt(1 - x^2 - y^2)`), and emits a
standard-encoding RGB PNG at <=1024px (`NORMAL_MAX_DIM`) under
`textures/normal/<diffuse_stem>.png`. The viewer binds `material.normalMap`
with `normalScale.set(1, -1)` (`NORMAL_FLIP_G` -- DirectX green-channel flip);
the GLBs carry no TANGENT attribute, so three.js's screen-space derivative
tangents apply. No HQ DDS tier (the vendored DDSLoader has no BC5/RGTC
support). `_s.dds` spec/gloss maps (plain BC1/BC3) are converted to roughness
at pipeline time -- `roughness = clamp((1 - L)^SPEC_ROUGHNESS_K * (1 - 0.3 *
log10(specularPower) / 2), SPEC_ROUGHNESS_MIN, 1)` with the per-material
`specularPower` captured from the `.material` `[solid]` section -- and emitted
as <=512px grayscale `textures/specular/<diffuse_stem>.png`; the viewer binds
`material.roughnessMap` with `roughness = 1.0` while mapped (the baked 0.65
factor would otherwise dim the map). Manifest entries carry `normalTextures` /
`specularTextures`; both kinds are mod-set-aware and join the wireframe stash
+ dispose paths. The original implementation spec (including the BC5S format
correction) is preserved at
[`models/model_render_improvements.txt`](../models/model_render_improvements.txt).

## Known limitations / future

- Recoil distance, tread scroll rate, and gun-elevation limits use tuned
  viewer-side constants rather than the exact per-weapon ODF values (a possible
  later refinement).
- ~34 meshes are unbaked map scenery / `.xsi` projectiles -- out of scope (would
  need other map mods or `game.bakeassets`).
- The 10 generic texture-name collisions across packs (e.g. effect `phong1`)
  are deduped by stem; none are primary unit diffuses.
- Replay integration (real models replacing the placeholder glyphs in
  `_map-analysis/render/js/replay-actors.js`) is a separate follow-on.

## Files

- `scripts/object-render/msh_parser.py` -- DOCB `.msh` geometry parser (stdlib)
- `scripts/object-render/dds_decode.py` -- BC1/BC3/BC5 `.dds` decoder, mip-level (stdlib + Pillow)
- `scripts/object-render/glb_writer.py` -- minimal glTF 2.0 `.glb` writer (stdlib)
- `scripts/object-render/msh_thumbnail.py` -- per-pixel numpy rasterizer (hero + gallery)
- `scripts/object-render/convert_msh.py` -- orchestrator -> `data/models/`
- `models/index.html`, `js/models.js`, `js/models-viewer.js`, `css/models.css` -- the production browser (promoted from this POC)
- `vendor/three/` -- vendored three r170 + addons (OrbitControls / GLTFLoader / DDSLoader / BufferGeometryUtils)
- `_object-render/spike/` + `_object-render/FORMAT.md` -- reverse-engineering record + diagnostic preview renderers (kept here)
