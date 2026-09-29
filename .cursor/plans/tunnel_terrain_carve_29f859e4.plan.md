---
name: Tunnel terrain carve
overview: Specification for rendering BZCC tunnels in the 3D replay and map viewer - bake each model's hidden terrain__h patch and ODF tunnel rects, snap heightfield vertices to the patch, cut rect cells the sheet intersects, place props with the converter's Z negation undone at authored Y, and make the camera ground query tunnel-aware.
todos:
  - id: bake-terrain-patch
    content: msh_parser.hidden_terrain_tris() + convert_msh terrainPatch (fresh + cached paths), index schema 20, `python scripts/object-render/convert_msh.py --no-render`
    status: pending
  - id: bake-pieces
    content: extract_props.py sidecar schema 2 `pieces` block (engine-local bbox, tunnels, terrainPatch, emissive), `python scripts/extract_props.py`
    status: pending
  - id: fix-prop-transform
    content: loader.js attaches `piece`; props.js scale.z=-1, rotation.y=+yaw, authored y for owning pieces, emissive binding; remove mirrorYaw from both callers
    status: pending
  - id: terrain-ownership
    content: terrain-owners.js (localOf, buildTunnelIndex, tunnelAt, applyTerrainOwnership) wired into replay.js and viewer.js initFloor
    status: pending
  - id: camera-tunnel-aware
    content: replay.js ground callback returns {floor, ceiling} from tunnelAt; replay-cameras.js passes refY and caps under the ceiling at its three call sites
    status: pending
  - id: verify
    content: Expected counters on Overlook (64 dropped triangles, 130 snapped vertices), ground-level screenshots on both maps, no-tunnel map unchanged, slider check, cache-bust + README
    status: pending
isProject: false
---

# Tunnel rendering specification

## 1. Facts the implementation relies on

- The `.TER` sheet has no tunnel data. Over a tunnel it holds the roof (Overlook: solid 149-151 m over the tubes, players drive on it at y 151-155) and inside an entrance footprint it holds the mapmaker's sculpt (Overlook south gate: 50 -> 80 -> 110 ramp at z 56..64, 110 m ledge at z 64..68).
- A tunnel is placed `i76building` objects. Each ODF `[BuildingClass]` declares passable cells: `tunnelCount`, `tunnelNNX0/Z0/DX/DZ` (integers, **8 m squares**) and `tunnelNNEdge` (4 letters N,E,S,W: `w` wall, `t` terrain, `f` next tunnel piece). Every piece has `ownsTerrain = 1`, which only affects collision.
- Entrance meshes carry a hidden node named `terrain` (`terrain__h`, render flag `RS_HIDDEN 0x400`). The engine snaps heightfield vertices under the object's footprint to that surface at load. `pbtunn03.msh` (used by ODFs `pbtunn03` and `pbtunn08`): 60 on the wings (`x <= -24`, `x >= 24`), 0 across the full depth of the doorway column (`x -16..16`). Plain tubes (`pbtunn05/02/07/01`, `vsrf12c_tun01`) have no such node and do not change the sheet.
- `scripts/object-render/convert_msh.py` negates Z when writing GLBs (`glb_writer.MIRROR_Z = True`). Engine-local `(x, y, z)` = GLB `(x, y, -z)`.
- Rect anchor: engine-local min-X edge and max-Z (north) edge of the mesh bounding box; Z0 counts southward. Verified on `pbtunn01/02/03/05`. `pbatun04/05/07` rects overflow their 16 m mesh (32 m footprint, tube in the middle) - handled by the fallback in 3.2.
- BZN yaw = `atan2(front.x, front.z)`; the BZN rotation equals three.js `R_y(yaw)` numerically (`right = (cos, 0, -sin)`, `front = (sin, 0, cos)`), checked on 90 and 180 degree pieces.

## 2. Coordinate conventions (use verbatim)

- World = engine numeric coordinates: +X east, +Z north, +Y up, metres. The replay displays the world inside `worldGroup` with `scale.z = -1`; that reflection is uniform and is never compensated per object.
- Piece pose from the sidecar row: `P = (row.x, row.y, row.z)` (BZN `posit`, absolute metres), `theta = deg2rad(row.yaw)`.
- Local -> world: `wx = P.x + lx*cos(theta) + lz*sin(theta)`, `wz = P.z - lx*sin(theta) + lz*cos(theta)`, `wy = P.y + ly`.
- World -> local: `dx = wx - P.x`, `dz = wz - P.z`, `lx = dx*cos(theta) - dz*sin(theta)`, `lz = dx*sin(theta) + dz*cos(theta)`.
- Heightfield (`mapData.heightmap`, `hm`): vertex `i = iz * hm.cellsX + ix`, `wx = hm.worldOriginX + ix * hm.cellMetersX`, `wz = hm.worldOriginZ + iz * hm.cellMetersZ`. `baseHeights[i] = hm.heights[i] * hm.scale` is the height **minus `hm.baseOffsetM`**; absolute = `baseHeights[i] + hm.baseOffsetM`. Scene y = `baseHeights[i] * exaggeration`. Cell `(ix, iz)` owns the two triangles at `geom.index` offset `6 * (iz * (hm.cellsX - 1) + ix)` (PlaneGeometry layout after `rotateX(-PI/2)`; iz grows with z).
- All sidecar geometry (bbox, rects, patch) is **engine-local metres** relative to the pivot.

## 3. Data contracts

### 3.1 `data/models/index.json` (schema 19 -> 20) - per model, additive

```
"terrainPatch": null | {
  "minX": -48.0, "minZ": -16.0,     // engine-local, multiples of 2
  "step": 2.0, "cols": 49, "rows": 17,
  "heights": [ ... cols*rows numbers or null ... ]   // row-major, row 0 = minZ, col 0 = minX; value = top surface local y
}
```

Rasterization: triangles of every node with `flags & RS_HIDDEN` and `name.lower() == "terrain"`, transformed exactly as `_parse_block`'s `emit` would (inverse-bind `state_mats[state_index]` when present, else the node matrix chain). Grid over the node bounds rounded outward to 2 m. Sample point `(x + 1e-3, z - 1e-3)`; height = max y over triangles containing the point (barycentric, tolerance 1e-6); `null` when no triangle covers it.

### 3.2 `data/render/<stem>.props.json` (schema 1 -> 2)

Rows unchanged: `{stem, x, y, z, yaw}`. New top-level `pieces`, one entry per distinct row stem:

```
"pieces": {
  "pbtunn03": {
    "bboxMin": [-48, 0, -16], "bboxMax": [48, 60, 16],          // engine-local
    "emissive": ["pbintf00"],                                    // index emissiveTextures
    "terrainPatch": { ...copied from index... } | null,
    "tunnels": [ { "x0": -16, "x1": 16, "z0": -16, "z1": 16, "y0": 0, "y1": 60, "edge": "twfw" } ]
  }
}
```

- `bboxMin/Max`: GLB `POSITION` accessor min/max with `z_engine = -z_glb` (swap min/max in Z). Read from the GLB JSON chunk; no three.js.
- `tunnels` from `data/odf.min.json` `Building[<odf>].BuildingClass` (keys case-insensitive: `tunnelNNX0/Z0/DX/DZ/Edge`, NN two-digit from 01): `x0 = bboxMin.x + X0*8`, `x1 = x0 + DX*8`, `z1 = bboxMax.z - Z0*8`, `z0 = z1 - DZ*8`, `y0 = bboxMin.y`, `y1 = bboxMax.y`, `edge` lowercased (default `"wwww"`). Empty list when `tunnelCount` is 0/absent.
- Fallback: if the union of a piece's rects exceeds `[bboxMin.x, bboxMax.x]` or `[bboxMin.z, bboxMax.z]` by more than 0.5 m, translate all its rects so the union is centred on the pivot in the overflowing axis and print a warning naming the stem.
- `terrainPatch` copied only when `OWNERSHIP_SCOPE = "tunnels"` (module constant) admits the stem: ODF has `tunnelCount > 0`, or `GameObjectClass.isTerrain`, or `BuildingClass.bldEdge`. Setting the constant to `"all"` copies it for every stem that has one (engine-true flattening under pools/buildings; not enabled here).

## 4. Algorithms

### 4.1 Prop transform (`props.js`)

`clone.position.set(row.x, groundY * exaggeration, row.z)`, `clone.rotation.y = theta`, `clone.scale.z = -1`. Same in the viewer and inside the replay's reflected group. `groundY = row.y - hm.baseOffsetM` when `row.piece && (row.piece.tunnels.length || row.piece.terrainPatch)`, else `sampleTerrainHeight(hm, row.x, row.z)`. `clone.userData.groundY = groundY` (existing exaggeration path).

### 4.2 Terrain ownership (`terrain-owners.js`, `applyTerrainOwnership(geom, baseHeights, hm, props)`)

Runs once per floor build, after `baseHeights` is filled and before positions, `computeVertexNormals()` and `WireframeGeometry`. Returns `{ snapped, dropped }` counters (log them).

**Snap** - for each row with `piece.terrainPatch`:
1. World AABB of the rotated footprint `[bboxMin.x, bboxMax.x] x [bboxMin.z, bboxMax.z]` -> vertex index ranges (floor/ceil against `hm.worldOriginX/Z`, `cellMetersX/Z`, clamped).
2. For each vertex in range: `(lx, lz)` = world -> local. Skip unless `bboxMin.x - 1e-3 <= lx <= bboxMax.x + 1e-3` and same for z.
3. If the vertex lies on a footprint boundary side (`lx` or `lz` within 1e-3 of the bbox edge) and some rect has letter `f` on that same side (N -> `lz == rect.z1 == bboxMax.z`, S -> `rect.z0 == bboxMin.z`, E -> `rect.x1 == bboxMax.x`, W -> `rect.x0 == bboxMin.x`) and the vertex is within that rect's other-axis span: `abs = row.y + bboxMax.y`.
4. Else if the vertex is inside or on the boundary of a rect: sample the patch at the point nudged 1e-3 toward the rect centre.
5. Else sample at `(lx, lz)`.
6. Sampling: bilinear on the 2 m grid; use the exact node when the point is within 1e-3 of one; if any contributing node is `null`, leave the vertex untouched.
7. Write `baseHeights[i] = abs - hm.baseOffsetM`.

**Cut** - for each row with `piece.tunnels`, for each rect: world AABB of the rotated rect -> cell ranges; for each cell's two triangles: centroid world -> local inside the rect (inclusive, 1e-3) AND `[min, max]` of the three absolute heights intersects `[row.y + y0 - 0.5, row.y + y1 + 0.5]` -> mark dropped. Rebuild the index once from the kept triples (`Uint32Array`), `geom.setIndex(...)`.

### 4.3 Tunnel index (`terrain-owners.js`)

`buildTunnelIndex(props)` -> array of `{P, cos, sin, x0, x1, z0, z1, floorAbs: row.y + y0, ceilAbs: row.y + y1}` for every rect. `tunnelAt(index, wx, wz, refAbsY)` -> the first rect containing the point (inclusive) whose `floorAbs - 0.5 <= refAbsY < ceilAbs`, else `null`. Gates (`y1 = 60`) and tubes (`y1 = 16`) both qualify.

### 4.4 Camera (`replay.js`, `replay-cameras.js`)

Ground callback signature becomes `(x, zCam, refSceneY) -> { floor, ceiling }` in scene units (`(abs - hm.baseOffsetM) * STATE.terrainExaggeration`), `ceiling: null` outside tunnels; `wz = -zCam` as today; `refAbs = refSceneY / exaggeration + hm.baseOffsetM`. Call sites: `liftChaseAboveGround` (ref = `actor.lastValidPos.y`), `slideFree` (ref = `camera.position.y` before the move), `flyTo` (ref = `point.y`). Each: `if pos.y < floor + CLEAR -> pos.y = floor + CLEAR; if ceiling != null && pos.y > ceiling - CLEAR -> pos.y = ceiling - CLEAR` (`CLEAR` = the existing `CHASE_GROUND_CLEAR_M` / `MOVE_GROUND_CLEAR_M`; in `slideFree` apply the same delta to `orbitControls.target.y`).

## 5. File changes

1. [`scripts/object-render/msh_parser.py`](scripts/object-render/msh_parser.py) - add `hidden_terrain_tris(path) -> list[tuple[vec3, vec3, vec3]]` built on `parse_msh_full()` (nodes carry `flags`, `matrix`, `parent`, `verts`, `groups`, `indices`, `state_index`; `block.state_mats`), reusing `_inv_bind_pos` / `_xform_pos` so the transform path matches `_parse_block` lines 517-545.
2. [`scripts/object-render/convert_msh.py`](scripts/object-render/convert_msh.py) - `_extract_terrain_patch(msh_path)` implementing 3.1; call it in the resolve loop (`resolved.append((stem, meta, mp))`, line 1895) as `meta["terrainPatch"]`; emit on the fresh path next to `"drive": job.get("drive")` (line 1591) and in `_cached_entry()` next to `"drive": meta.get("drive")` (line 1661); add `terrain_patch_count` beside `collision_count` (line 2056); `"schema_version": 19` -> `20` (line 2066) and the cockpit rewrite literal (line 1807). Run `python scripts/object-render/convert_msh.py --no-render` (index rewrite only; expect ~165 models with a patch).
3. [`scripts/extract_props.py`](scripts/extract_props.py) - `SCHEMA_VERSION = 2`, `OWNERSHIP_SCOPE = "tunnels"`; load `data/odf.min.json` once; `_glb_bounds(stem)` from the GLB JSON chunk; `_piece_for(stem, odf_entry, index_entry)` implementing 3.2; write `pieces` in `extract()`. Run `python scripts/extract_props.py` (all sidecars rewrite; only `schema_version` + `pieces` differ).
4. [`_map-analysis/render/js/loader.js`](_map-analysis/render/js/loader.js) `loadPropsSidecar` (line 205) - return `doc.props.map(r => ({ ...r, piece: (doc.pieces || {})[r.stem] || null }))`; fetch query `?v=props1` -> `?v=props2`.
5. [`_map-analysis/render/js/props.js`](_map-analysis/render/js/props.js) - `buildPropsGroup(props, hm, factor, renderer)` (drop `mirrorYaw`), 4.1; `EMISSIVE_DIR = '../../data/models/textures/emissive/'`; in `bindPerf`, for material names listed in `row.piece.emissive` also load `<name>.png` and set `mat.emissiveMap = tex; mat.emissive.setRGB(1,1,1); mat.emissiveIntensity = 1` (pattern of `js/models-viewer.js` `_applyEmissive`, lines 1252-1255). Callers: [`replay.js`](_map-analysis/render/js/replay.js) `initProps` (line 798) and [`viewer.js`](_map-analysis/render/js/viewer.js) `initProps` (line 672) drop the last argument.
6. New [`_map-analysis/render/js/terrain-owners.js`](_map-analysis/render/js/terrain-owners.js) - exports `localOf`, `buildTunnelIndex`, `tunnelAt`, `applyTerrainOwnership` (4.2, 4.3). No three.js imports beyond `BufferAttribute`.
7. [`replay.js`](_map-analysis/render/js/replay.js) `initFloor` (line 592) and [`viewer.js`](_map-analysis/render/js/viewer.js) `initFloor` (line 502) - after the `baseHeights` fill loop and before the min/max + positions loop: `applyTerrainOwnership(geom, baseHeights, hm, mapData.props)`. `applyHeightExaggeration` (both files) needs no change: it rewrites positions from the snapped `STATE.terrainBaseHeights` and rebuilds the wireframe from the cut geometry.
8. [`replay.js`](_map-analysis/render/js/replay.js) `setMoveGround` callback (line 858) and [`replay-cameras.js`](_map-analysis/render/js/replay-cameras.js) `liftChaseAboveGround` (674), `slideFree` (734), `flyTo` (344) - 4.4. Build the tunnel index once after `mapData` loads (`STATE.tunnelIndex`).
9. Cache-bust: `props.js?v=props2` -> `props3` in `replay.js` (17) and `viewer.js` (27); `loader.js?v=props1` -> `props2` in `viewer.js` (23) and `replay-data.js` (26); import `terrain-owners.js?v=1`.
10. [`_map-analysis/render/README.md`](_map-analysis/render/README.md) - one section: sidecar schema 2, the ownership rule, the coordinate conventions of section 2.

## 6. Order

Track A (Python): 1 -> 2 -> regen index -> 3 -> regen sidecars. Track B (JS, parallel): 4, 5, 9. Then 6 -> 7 -> 8 (need the regenerated sidecar). Then 10 and verification. No `PIPELINE_VERSION`, match schema or rating change.

## 7. Verification

- Regenerated `vsroverlook.props.json`: `pieces.pbtunn05.tunnels == [{-16,16,-48,16,0,16,"fwfw"}]`, `pieces.pbtunn03.tunnels == [{-16,16,-16,16,0,60,"twfw"}]`, `pieces.pbtunn03.terrainPatch` 49 x 17 with 60 on the wing columns and 0 on `x -16..16`; `pieces.pbtunn05.terrainPatch == null`. `vsrf12c.props.json` has `vsrf12c_tun01` with one `fwfw` rect `{-16,16,-32,0,0,16}`.
- Overlook counters from `applyTerrainOwnership`: `dropped == 64` (two gates x 16 doorway cells x 2 triangles; no tube cell intersects the 50..66 span), `snapped == 130` (two gates x 13 x 5 footprint vertices). Vertex `(x -112, z 64)` after snap = 110 absolute (F edge), `(x -112, z 32)` = 50, `(x -144, z 48)` = 110.
- Replay `2026-09-28T02-40-35`, camera at ground level in the south canyon: gate flush in the cliff, open doorway, lit tube interior; chase a ship through to the north gate with the camera staying inside the tube (y between floor + 4 and ceiling - 4).
- Replay `2026-05-05T02-23-38` (Fort 12c): both 34 m gates, elbows and slants to the 2 m row, centre closed by `vsrf12c_tun01`, terraces above unchanged.
- A no-tunnel map: `dropped == 0`, `snapped == 0`; props differ only by the corrected reflection.
- Height slider: terrain, snapped vertices, tunnel meshes, ships and camera floor scale together; wireframe view shows the 16-cell doorway holes.

## 8. Out of scope

- 2 m local refinement of the terrain mesh around tunnel pieces (the 8 m mesh renders the engine's 2 m walls as 8 m slopes).
- `OWNERSHIP_SCOPE = "all"` (flattening under pools and buildings).
- Z-reflection review of `replay-ship-models.js` / `replay-structures.js`.
- Cutaway or x-ray of units under the roof.
