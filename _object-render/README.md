# Object Render

Extracts real Battlezone: Combat Commander ship/building/projectile geometry
from the game's baked `.msh` files and renders it in three.js -- a standalone
single-object viewer (full 360 orbit) plus a searchable/filterable object
browser scaled to the **entire renderable corpus** (~700 models).

This is a dev/research surface (like `_map-analysis/`), self-contained and
movable. It is NOT (yet) wired into the production dashboard; the generated
assets under `data/models/` are the durable output the ODF browser + match
replays will read later.

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
  thumbnails/<stem>.png             hero (~256px) for the directory cards
  shots/<stem>/<angle>.png          7-angle HQ gallery (~512px):
                                     hero/front/back/left/right/top/bottom
```

## Pipeline

```
BZCC baked **/<geo>.msh (DOCB binary, across base + workshop packs)
        |
        v   scripts/msh_parser.py     decode geometry (rest pose via inverse
        |                             bind matrices; faithful mesh-tree walk)
        |   scripts/dds_decode.py     BC1/BC3 .dds -> RGBA, mip-level decode
        |   scripts/glb_writer.py     stdlib glTF 2.0 binary writer
        |   scripts/msh_thumbnail.py  per-pixel numpy rasterizer (bilinear HQ
        |                             texture, smooth normals, z-buffer, 2x AA)
        v
scripts/convert_msh.py  ->  data/models/{geometry,textures/{perf,hq},thumbnails,shots,index.json}
        |
        v
_object-render/index.html + js/     three.js r170 + OrbitControls + GLTFLoader + DDSLoader
```

## Regenerate the assets

Requires the BZCC (BZ2R) install on this machine plus the VSR workshop asset
packs subscribed (the baked `.msh` + `.dds` live under
`steamapps/common/BZ2R/` and `steamapps/workshop/content/624970/`). Python deps:
stdlib + **Pillow** (`.dds` decode) + **numpy** (the build-time gallery
rasterizer -- DEV-only, not shipped to the site).

```
python scripts/convert_msh.py --limit 20         # smoke run (first 20 by stem)
python scripts/convert_msh.py --jobs 12           # full run, parallel
python scripts/convert_msh.py --force --jobs 12   # ignore the cache, rebuild all
python scripts/convert_msh.py --odf ivscout_vsr.odf
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

## git LFS

`data/models/**/*.{glb,dds,png}` is tracked via git LFS (`.gitattributes`) so a
clone pulls the full multi-GB asset set without bloating git history. Run
`git lfs install` once after cloning.

## Coordinate / format notes

- Geometry is meters, Y-up -- already three.js convention, no axis swap needed.
- BZCC is a DirectX (left-handed) engine; the converter negates Z + reverses
  winding to produce un-mirrored right-handed glTF (toggle `--no-handedness-fix`).
- GLB UVs are authored for the glTF `flipY=false` convention; the viewer forces
  `flipY=false` + `SRGBColorSpace` on BOTH texture sets so perf + HQ share UVs.
- Models render in their SYMMETRIC rest pose (inverse bind matrices), not a
  mid-animation pose. Format decode record: `spike/FORMAT.md`.

## Known limitations / future

- Team-color compositing (the `_c` mask), PBR (normal/spec/emissive), and
  animations are deferred to later passes; the baked diffuse already carries
  each unit's canonical faction coloring.
- ~34 meshes are unbaked map scenery / `.xsi` projectiles -- out of scope (would
  need other map mods or `game.bakeassets`).
- The 10 generic texture-name collisions across packs (e.g. effect `phong1`)
  are deduped by stem; none are primary unit diffuses.
- Replay integration (real models replacing the placeholder glyphs in
  `_map-analysis/render/js/replay-actors.js`) is a separate follow-on.

## Files

- `scripts/msh_parser.py` -- DOCB `.msh` geometry parser (stdlib)
- `scripts/dds_decode.py` -- BC1/BC3 `.dds` decoder, mip-level (stdlib + Pillow)
- `scripts/glb_writer.py` -- minimal glTF 2.0 `.glb` writer (stdlib)
- `scripts/msh_thumbnail.py` -- per-pixel numpy rasterizer (hero + gallery)
- `scripts/convert_msh.py` -- orchestrator -> `data/models/`
- `_object-render/index.html`, `js/app.js`, `js/viewer.js`, `css/style.css`
- `_object-render/vendor/three/` -- vendored three r170 + addons (incl. DDSLoader)
- `_object-render/spike/` -- reverse-engineering record (FORMAT.md, preview renderers)
