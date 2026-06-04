# Object Render (POC)

Proof-of-concept that extracts real Battlezone: Combat Commander ship/building
geometry from the game's baked `.msh` files and renders it in three.js -- a
standalone single-object viewer (full 360 orbit) plus a rough object browser.

This is a dev/research surface (like `_map-analysis/`), self-contained and
movable. It is NOT wired into the production dashboard.

## What works (proof set)

Four varied units, two factions, vehicle + building:

| ODF | Unit | Faction | Notes |
|-----|------|---------|-------|
| `ivscout_vsr.odf` | Scout | ISDF | primary target, 1 material |
| `ivtank_vsr.odf` | Tank | ISDF | second vehicle |
| `ibrecy_vsr.odf` | Recycler | ISDF | building, 12 material groups |
| `fvburn.odf` | Scion Leader | Scion | cross-faction, organic topology |

All four convert with geometry + diffuse textures.

## Pipeline

```
BZCC bz2r_res/baked/**/<geo>.msh  (DOCB binary, proprietary)
        |
        v   scripts/msh_parser.py     (decode geometry: positions/normals/uvs/faces, per material group)
        |   scripts/dds_decode.py     (BC1/BC3 .dds -> RGBA, stdlib)
        |   scripts/glb_writer.py     (stdlib glTF 2.0 binary writer)
        v
scripts/convert_msh.py
        |
        v
data/models/<geo>.glb              (committed)
data/models/textures/<tex>.png     (downscaled diffuse, committed)
data/models/index.json             (manifest)
        |
        v
_object-render/index.html + js/    (three.js r170 + OrbitControls + GLTFLoader)
```

## Regenerate the models

Requires the BZCC (BZ2R) install on this machine (the baked `.msh` + `.dds`
live under `steamapps/common/BZ2R/bz2r_res/baked/`). Python deps: stdlib +
Pillow (for the `.dds` decode).

```
python scripts/convert_msh.py                 # default proof set, with textures
python scripts/convert_msh.py --no-textures   # geometry only (fast)
python scripts/convert_msh.py --odf ivscout_vsr.odf ivtank_vsr.odf
```

## Run the viewer

The page uses ES modules + `fetch`, so it must be served over HTTP (not
`file://`). From the repo root:

```
python -m http.server 8731
```

Then open <http://127.0.0.1:8731/_object-render/>. Click a unit to inspect it;
drag to orbit (all angles incl. underside), scroll to zoom, right-drag to pan.
Toolbar: Wireframe, Auto-rotate, Reset view.

## Coordinate / format notes

- Geometry is meters, Y-up -- already three.js convention, no axis swap needed.
- BZCC is a DirectX (left-handed) engine; the converter negates Z + reverses
  winding to produce un-mirrored right-handed glTF (toggle `--no-handedness-fix`).
- Format decode record: `spike/FORMAT.md` (and `spike/*.py`, `spike/*.png`).

## Known limitations / future

- Team-color compositing (the `_c` mask) is NOT applied; the baked diffuse
  already carries each unit's canonical faction coloring. Team recolor belongs
  with the (deferred) match-replay integration.
- Pure-Python `.dds` decode is slow (~seconds per 2048^2 texture). Fine for a
  handful of units; a full-corpus run would want a faster decoder (texconv) or
  caching. See the plan's "Scaling to the full corpus" section.
- Only static meshes. Skeletal/morph units (`*_skel`) and `.xsi`-sourced units
  (campod) are out of scope for v1.
- Scion `e`-prefix (Hadean) meshes were not baked on the reference machine; only
  units loaded in-game have a baked `.msh`. `game.bakeassets` would fill gaps.
- Replay integration (real models replacing the placeholder glyphs in
  `_map-analysis/render/js/replay-actors.js`) is a separate follow-on.

## Files

- `scripts/msh_parser.py` -- DOCB `.msh` geometry parser (stdlib)
- `scripts/dds_decode.py` -- BC1/BC3 `.dds` decoder (stdlib + Pillow)
- `scripts/glb_writer.py` -- minimal glTF 2.0 `.glb` writer (stdlib)
- `scripts/convert_msh.py` -- orchestrator -> `data/models/`
- `_object-render/index.html`, `js/app.js`, `js/viewer.js`, `css/style.css`
- `_object-render/vendor/three/` -- vendored three r170 + addons
- `_object-render/spike/` -- reverse-engineering record (FORMAT.md, preview renderers)
