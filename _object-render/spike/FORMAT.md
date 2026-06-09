# BZCC baked `.msh` (DOCB) format -- decode notes

Reverse-engineering record for the object-render POC. The parser is
[scripts/object-render/msh_parser.py](../../scripts/object-render/msh_parser.py); these are the findings
that validated it.

## Source of truth

The full binary layout matches the community Blender importer
[frute94/io_scene_bz2msh](https://github.com/frute94/io_scene_bz2msh)
(`bz2msh.py`). Our parser is a clean stdlib re-implementation that keeps only
what static rendering needs (positions / normals / uvs / per-material-group
faces + bounding sphere + material/texture names).

## Layout (little-endian)

```
BlockHeader (44 bytes)
  fileType  : char[4]  = "DOCB"
  verID     : u32      = 1
  blockCount: u32      = 1 (usually)
  notUsed   : u8[32]
Block (x blockCount)
  BlockInfo { key:u32 (per-mesh hash), size:u32 (= filesize-52) }
  name      : u16 len-incl-null + ascii   (e.g. "mainbody")
  Sphere    { radius:f32, matrix:4x4 f32, width/height/breadth:f32 }
  MSH_Header{ dummy:f32, scale:f32, indexed/moveAnim/oldPipe/isSingleGeometry/skinned:u32 }
  vertices[]      : u32 count + Vec3 f32[count]
  normals[]       : u32 count + Vec3 f32[count]
  uvs[]           : u32 count + UV f32[count]
  colors[]        : u32 count + BGRA u8[count]
  faces[]         : u32 count + FaceObj[count]
                    FaceObj { buckyIndex:u16, verts:u16[3], norms:u16[3], uvs:u16[3] }
  buckys[]        : u32 count + { flags:u32, indexCount:u32, vertCount:u32, <optional Material/Texture/End markers> }
  vertToState[]   : skinning weights (skipped)
  vertGroups[]    : (skipped)
  indices[]       : u16 (skipped -- redundant with faces for our use)
  planes[] / stateMatrices[] / states[] / animList[]  (skipped)
  mesh-tree       : root Mesh + CHILD/SIBLING/END markers, terminated by EOF (skipped)
```

## Key insight

Geometry lives at the **block level**: each `FaceObj` is a triangle whose three
corners index SEPARATE `vertices` / `normals` / `uvs` arrays (BZ2 de-duplicates
components). `buckyIndex` selects the material group. The per-node mesh tree we
skip is animation/hierarchy state, not extra geometry -- confirmed because the
block-level faces reproduce ALL material groups (recycler = 12 groups, Scion
fvburn = 4 groups).

## Axis / scale

Geometry is in **meters, Y-up, Z-forward, X-right** -- this is already three.js
convention, so NO axis conversion is needed for the viewer (validated: the
PIL preview renders correctly with Y treated as up). Replay integration (future)
will still need heading alignment, but the object viewer is native-correct.

## Validation (this spike)

- `ivscout00`: 1 group, 1442 tris, bbox ~2.9 x 1.6 x 6.3 m -- renders as a scout.
- `ivtank00` : 1 group, 1070 tris, bbox ~5.6 x 2.0 x 7.4 m.
- `ibrecy00` : 12 groups, 3124 tris, 64 x 13 m -- building + ground footprint.
- `fvburn00` : 4 groups, 5182 tris -- Scion vehicle, cross-faction.

Previews: `ivscout00.preview.png`, `ibrecy00.preview.png` (this folder).

## Articulation node conventions (moveable parts)

The mesh-tree node names follow BZCC conventions the engine drives at runtime
(authoritatively declared in each unit's ODF, e.g. `turretName1`/`recoilName1`):

- `turret_y` -- turret yaw node (rotate about local Y); `turret_x` -- pitch node
  (rotate about local X, usually a child of `turret_y`).
- `recoil*` (`recoil`, `recoil1`, `recoil_l`, ...) -- per-weapon recoil nodes
  that translate back along the barrel axis on fire, then spring home.
- treads are a STATIC mesh (`tread_l`/`tread_r`) whose `tread`/`fvtread` material
  UV-scrolls (engine-coded, speed-proportional -- no scroll rate in the
  `.material`); the viewer fakes track motion by offsetting that material's UV.
- `hp_*` nodes are hardpoints (no geometry).

The converter preserves this hierarchy for every rigid multi-node model so the
viewer can drive the named nodes/materials interactively (see the project README
"Interactive moveable parts").

## Render flags worth honoring

`RS_HIDDEN = 0x400` (collision/helper geometry -- skip), `RS_2SIDED = 0x200`
(disable backface culling for that group). All four proof units use flag
`0x650000` (a blend mode), none hidden.
