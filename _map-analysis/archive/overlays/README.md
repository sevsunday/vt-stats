# Map Overlay Pipeline (Phase 2)

Combines the engine-rendered shellmaps in `_map-analysis/shellmaps/bmps/` with
object data (scrap pools, spawn points, loose scrap) parsed from each map's
`.bzn` file by `_map-analysis/scripts/analyze_map.py`. Output is per-map 512x512
PNGs suitable for the map browser.

## Outputs (per map)

For each map slug `<slug>` (matches the BMP filename in
`_map-analysis/shellmaps/bmps/<slug>.bmp`):

- `<slug>.shellmap.png`  - BMP-as-is converted to PNG (no markers; the
  asked-for plain thumbnail).
- `<slug>.pools.png`     - transparent RGBA overlay, cyan pool markers.
- `<slug>.spawns.png`    - transparent RGBA overlay, team-tinted spawn markers
                           (Team 1-5 blue, Team 6-10 red, other grey).
- `<slug>.scrap.png`     - transparent RGBA overlay, grey loose-scrap dots.
- `<slug>.composite.png` - shellmap with all three marker layers baked in.

The transparent overlays can be composited at runtime to toggle layers on/off
independently in the dashboard; the composite is the ready-to-ship thumbnail.

## Layout

    _map-analysis/overlays/
      README.md                       (this file)
      scripts/
        terrain_bounds.py             .ter (primary) + .trn (m/cell hint)
        project.py                    world-meter -> 512px (centered, square)
        build_overlays.py             orchestrator (smoke + full runs)
      smoke_test/                     populated by `--smoke`
      output/                         populated by full run

## Usage

    cd _map-analysis/overlays/scripts
    python build_overlays.py --smoke           # 5 maps -> smoke_test/
    python build_overlays.py --map <slug>      # 1 map  -> output/
    python build_overlays.py                   # all maps -> output/
    python build_overlays.py --force           # ignore mtime cache

## Projection model (canonical, file-format derived)

The shellmap is rendered against a **square world rectangle, centered on
origin**, whose half-extent comes from the `.ter` cell grid times a
per-map `meters_per_cell` factor.

### Why centered-on-origin

Spot-check of 12 maps across the corpus (Big Chill, Uxbridge, 310, Haven,
Strategy Arena, Garden, Mountain Top, Iraq, Quagmire, Bowl, Jade Green,
DuneNight) shows **every** `.ter` header has `GridMinX = -GridMaxX` and
`GridMinZ = -GridMaxZ`. We treat this as a BZ2 invariant. (Canonical
reference for the `.ter` header layout:
[BZMapTools/TerFile.cs](../archive/BZMapTools-master/BZMapTools-master/BZMapTools/TerFile.cs)
lines 77-84 and
[BZ2TerrainEditor/Terrain.cs](../archive/bz2terraineditor-master/bz2terraineditor-master/BZ2TerrainEditor/Terrain.cs)
lines 122-138.)

### Why the `.trn [Size]` block is *not* the rendered rect

The `.trn [Size]` block describes a build-grid region, **not** the
rendered terrain rectangle:

| Map | `.trn [Size]` says | Reality |
|---|---|---|
| Uxbridge | `MinX=-2048, Width=1024` -> rect `[-2048, -1024]` | rect doesn't even contain the origin |
| 310 | `MinX=-1024, Width=1280` -> rect `[-1024, +256]` | off-center by 384 m |
| Strategy Arena | `MinX=-2048, Width=2048` -> rect `[-2048, 0]` | off-center by 1024 m |
| Haven, Garden, Quagmire, Bowl, ... | (no `.trn` at all) | n/a |

We use `.trn` only as a *hint* for the `meters_per_cell` factor when the
block is centered on origin AND `(trn_width / 2) / .ter_half_cells` is
an integer >= 2.

### The algorithm

```
half_cells = (GridMaxX - GridMinX) / 2        # always, from .ter header
m_per_cell = 2.0                              # BZCC default

if .trn present AND .trn rect centered on origin (<= 32 m off):
    candidate = (Width / 2) / half_cells
    if candidate is an integer >= 2:
        m_per_cell = candidate                # e.g. Mountain Top: 4.0

half_extent_m = half_cells * m_per_cell
rect = [-half_extent_m, +half_extent_m] on both axes
```

### How that plays out on the smoke set

| Map | Cells | m/cell | Half-extent (m) | Provenance |
|---|---:|---:|---:|---|
| Big Chill | 2048 | 2 | 2048 | ter + trn (centered) |
| Uxbridge | 512 | 2 | 512 | ter (default 2 m/cell) |
| 310 | 1024 | 2 | 1024 | ter (default 2 m/cell) |
| Haven | 1024 | 2 | 1024 | ter (default 2 m/cell) |
| Strategy Arena | 1024 | 2 | 1024 | ter (default 2 m/cell) |

Orientation: world `+X -> +pixel_x`, world `+Z -> -pixel_y` (BZ2 canonical,
origin top-left). `flip_x` / `flip_z` knobs are available in `project.py`
for per-map overrides if any map's shellmap turns out to be mirrored,
but no map in the smoke set needed one.

## See also

- [_map-analysis/shellmaps/README.md](../shellmaps/README.md) -- Phase 1: how
  the BMPs were generated.
- [_map-analysis/scripts/analyze_map.py](../scripts/analyze_map.py) -- the
  upstream `.bzn` / `.trn` / `.ter` parser this pipeline depends on.
- [_map-analysis/archive/BZMapTools-master/BZMapTools-master/BZMapTools/TerFile.cs](../archive/BZMapTools-master/BZMapTools-master/BZMapTools/TerFile.cs)
  -- canonical reference for the `.ter` binary header layout.
- [_map-analysis/archive/proof-render/_README.md](../archive/proof-render/_README.md)
  -- prior calibration-era effort + its `.ter` decode wall (which we sidestep
  by using engine-rendered shellmaps).
