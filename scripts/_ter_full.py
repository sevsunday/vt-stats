"""Definitive `.TER` decoder.

Format reference: `_map-analysis/reference-repos/bz2terraineditor-master/.../Terrain.cs`.
Every byte of every corpus `.TER` is accounted for, and the decoded heights
are checked against the engine and the map authoring data by
`scripts/verify_terrain_scale.py`.

## Format spec (Version 5, the universal version in our corpus)

### Header (16 bytes)
- `[0..3]`   uint32 LE: magic = `0x52524554` ('TERR')
- `[4..7]`   uint32 LE: version (5)
- `[8..9]`   int16 LE:  GridMinX (in TER 2m units)
- `[10..11]` int16 LE:  GridMinZ
- `[12..13]` int16 LE:  GridMaxX
- `[14..15]` int16 LE:  GridMaxZ

`width = GridMaxX - GridMinX` cells. Each cell = 2 m world space.
`CLUSTER_SIZE = 16` for version >= 4.

### Body: row-major sequence of clusters
For each cluster (cy outer, cx inner, both stepping by CLUSTER_SIZE):

1. `1 byte` compression flags:
   - bit 0: haveHeight  (per-cell heights vs single broadcast value)
   - bit 1: haveColor
   - bit 2: haveAlpha1
   - bit 3: haveAlpha2
   - bit 4: haveAlpha3
   - bit 5: haveCell    (the CellType / cliff map)

2. Heights: 256 x float32 LE if haveHeight else 1 x float32 LE broadcast
3. Color:   256 x RGB (3 bytes) if haveColor else 1 RGB broadcast
4. Alpha1:  256 bytes if haveAlpha1 else 1 byte broadcast
5. Alpha2:  256 bytes if haveAlpha2 else 1 byte broadcast
6. Alpha3:  256 bytes if haveAlpha3 else 1 byte broadcast
7. Cell:    256 bytes if haveCell   else 1 byte broadcast
8. Info:    1 x uint32 LE per cluster

### Heights are engine meters (float32 absolute world altitude)

No scale factor applies. The `.TRN` `[Size] Height` value is not a height
scale: the engine's terrain Y bounds (`GetTerrainMinY/MaxY`, recorded in
every session header) are exactly `[min(TER min, Height), max(TER max,
Height)]`, with Height = 0 when the `.TRN` has no `[Size]` section.

### Sample positions

Source sample `k` is a terrain vertex at world `2 * (GridMin + k)`. The
engine's X/Z bounds are `2 * GridMin .. 2 * GridMax`.

### Output

Heights are box-averaged by `DOWNSAMPLE_FACTOR` (4) to keep browser meshes
lean, so output sample `o` is the mean of source vertices `4o .. 4o+3`
and sits at their mean position, `2 * GridMin + 3 + 8 * o`
(`TerFull.sample_origin_*`, `TerFull.sample_spacing_m`). Color, alpha,
CellType and InfoMap stay at source resolution. They are per-vertex like the
heights, so texel `k` is centred on vertex `k` and the texture frame runs
from `2 * GridMin - 1` to `2 * GridMax - 1` (`TerFull.texel_frame_*`).
"""
from __future__ import annotations

import struct
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path


CLUSTER_SIZE = 16          # v >= 4
DOWNSAMPLE_FACTOR = 4      # 1024x1024 source -> 256x256 output
TER_CELL_METERS = 2.0      # one TER grid unit


@dataclass
class TerFull:
    cells_x: int
    cells_z: int
    src_cells_x: int          # original .TER cell width before downsample
    src_cells_z: int
    tile_min_x: int
    tile_min_z: int
    tile_max_x: int
    tile_max_z: int
    version: int
    downsample_factor: int    # source samples averaged per output sample, per axis
    heights_le_bytes: bytes   # cells_x * cells_z * 2 bytes (int16 LE)
    base_offset_m: float      # meters = int16 * scale + base_offset_m
    scale: float              # meters per int16 unit
    height_min_m: float       # min of the downsampled heights
    height_max_m: float       # max of the downsampled heights
    # Per-cell CellType bytes at OUTPUT resolution (cells_x * cells_z bytes).
    # Each byte is the OR of all bits set in any source cell of the 4x4 block
    # that downsampled into it. Bits per CellType.cs:
    #   0x01 Cliff  0x02 Water  0x04 Building  0x08 Lava  0x10 Sloped
    cell_type_bytes: bytes
    # Per-cell RGB bytes at SOURCE resolution (src_cells_x * src_cells_z * 3).
    # The .TER Color channel -- the engine's baked vertex color (per-cell
    # painted ground tint). Used as the per-pixel tint multiplier in the
    # tier-3 tile compositing shader.
    color_rgb_bytes: bytes
    # Per-cell alpha bytes at SOURCE resolution (src_cells_x * src_cells_z each).
    # The .TER's 3 alpha-blend channels: per-pixel weights for tile-texture
    # layers 1/2/3 (layer 0 is always fully visible). Consumed by the tier-3
    # shader as alphaMap1/2/3.
    alpha1_bytes: bytes
    alpha2_bytes: bytes
    alpha3_bytes: bytes
    # Per-cluster InfoMap (uint32 little-endian). Length = info_cluster_cols *
    # info_cluster_rows * 4 bytes. Bits 0-3 = tile index for layer 0, bits 4-7
    # for layer 1, etc (see Terrain.cs L70-83). The viewer unpacks these into
    # a DataTexture for the shader.
    info_map_bytes: bytes
    info_cluster_cols: int       # = src_cells_x / CLUSTER_SIZE (16)
    info_cluster_rows: int       # = src_cells_z / CLUSTER_SIZE (16)
    # CellType (cliff/water/building/lava/sloped bit flags per cell)
    # counts -- enables smart sidebar defaults in the viewer.
    total_cells: int          # source-resolution total cells (= src_cells_x * src_cells_z)
    flat_cells: int           # CellType == 0x00 cells
    cliff_cells: int          # cells with bit 0x01 set
    water_cells: int          # cells with bit 0x02 set
    building_cells: int       # cells with bit 0x04 set
    lava_cells: int           # cells with bit 0x08 set
    sloped_cells: int         # cells with bit 0x10 set

    @property
    def world_min_x(self) -> float:
        return float(self.tile_min_x) * TER_CELL_METERS

    @property
    def world_min_z(self) -> float:
        return float(self.tile_min_z) * TER_CELL_METERS

    @property
    def world_max_x(self) -> float:
        return float(self.tile_max_x) * TER_CELL_METERS

    @property
    def world_max_z(self) -> float:
        return float(self.tile_max_z) * TER_CELL_METERS

    @property
    def sample_spacing_m(self) -> float:
        """World distance between neighbouring output height samples."""
        return TER_CELL_METERS * self.downsample_factor

    @property
    def sample_origin_x(self) -> float:
        """World X of output sample 0, the mean of the vertices it averages."""
        return self.world_min_x + TER_CELL_METERS * (self.downsample_factor - 1) / 2.0

    @property
    def sample_origin_z(self) -> float:
        return self.world_min_z + TER_CELL_METERS * (self.downsample_factor - 1) / 2.0

    @property
    def texel_frame_min(self) -> tuple[float, float]:
        """World (x, z) where source-resolution textures start: half a cell
        before vertex 0, so every texel is centred on its vertex."""
        return (self.world_min_x - TER_CELL_METERS / 2.0,
                self.world_min_z - TER_CELL_METERS / 2.0)

    @property
    def texel_frame_max(self) -> tuple[float, float]:
        return (self.world_max_x - TER_CELL_METERS / 2.0,
                self.world_max_z - TER_CELL_METERS / 2.0)


@dataclass
class CellTypeCounts:
    total: int
    flat: int        # bits == 0
    cliff: int       # 0x01
    water: int       # 0x02
    building: int    # 0x04
    lava: int        # 0x08
    sloped: int      # 0x10


def _decode_v5(raw: bytes) -> tuple[
        list[list[float]],   # heightmap
        list[list[int]],     # cell_types
        list[bytes],         # color rows (RGB, 3 bytes per cell)
        list[bytes],         # alpha1 rows (1 byte per cell)
        list[bytes],         # alpha2 rows
        list[bytes],         # alpha3 rows
        bytes,               # info_map_bytes (uint32 LE per cluster, row-major)
        int,                 # info_cluster_cols
        int,                 # info_cluster_rows
        int, int,            # width, height (cells)
        tuple[int, int, int, int],  # tile bounds (grid min/max X/Z)
        CellTypeCounts,
    ]:
    """Decode a v5 .TER. Returns all per-pixel + per-cluster maps the tier-3
    renderer needs: heights, cell types (water/lava/cliff), color tint,
    3 alpha-blend channels, and the InfoMap (per-cluster tile indices)."""
    if raw[:4] != b'TERR':
        raise ValueError('bad magic')
    version = int.from_bytes(raw[4:8], 'little')
    if version != 5:
        raise ValueError(f'unsupported version {version} (need 5)')

    grid_min_x = int.from_bytes(raw[8:10], 'little', signed=True)
    grid_min_z = int.from_bytes(raw[10:12], 'little', signed=True)
    grid_max_x = int.from_bytes(raw[12:14], 'little', signed=True)
    grid_max_z = int.from_bytes(raw[14:16], 'little', signed=True)
    width  = grid_max_x - grid_min_x
    height = grid_max_z - grid_min_z

    if width % CLUSTER_SIZE != 0 or height % CLUSTER_SIZE != 0:
        raise ValueError(f'dimensions {width}x{height} not multiple of {CLUSTER_SIZE}')

    heightmap = [[0.0] * width for _ in range(height)]
    cell_types = [bytearray(width) for _ in range(height)]
    # Color channel: RGB bytes per source cell, stored as one bytearray per
    # row (width * 3 bytes each). Easy to PIL.Image.frombytes() later by
    # concatenating all rows.
    color_rows = [bytearray(width * 3) for _ in range(height)]
    # Alpha channels 1/2/3: 1 byte per source cell each. Same row-bytearray
    # layout as color_rows for cheap concatenation into image bytes.
    alpha1_rows = [bytearray(width) for _ in range(height)]
    alpha2_rows = [bytearray(width) for _ in range(height)]
    alpha3_rows = [bytearray(width) for _ in range(height)]
    # InfoMap: one uint32 per cluster, row-major. Capture as flat bytes (LE).
    info_cluster_cols = width // CLUSTER_SIZE
    info_cluster_rows = height // CLUSTER_SIZE
    info_map_bytes = bytearray(info_cluster_cols * info_cluster_rows * 4)
    cells_per_cluster = CLUSTER_SIZE * CLUSTER_SIZE

    # Cell type counters
    n_flat = n_cliff = n_water = n_building = n_lava = n_sloped = 0

    def count_bytes(byte_seq):
        nonlocal n_flat, n_cliff, n_water, n_building, n_lava, n_sloped
        for b in byte_seq:
            if b == 0:
                n_flat += 1
            else:
                if b & 0x01: n_cliff += 1
                if b & 0x02: n_water += 1
                if b & 0x04: n_building += 1
                if b & 0x08: n_lava += 1
                if b & 0x10: n_sloped += 1

    offset = 16
    for cy in range(0, height, CLUSTER_SIZE):
        for cx in range(0, width, CLUSTER_SIZE):
            compression = raw[offset]; offset += 1
            have_height = (compression & 0x01) != 0
            have_color  = (compression & 0x02) != 0
            have_a1     = (compression & 0x04) != 0
            have_a2     = (compression & 0x08) != 0
            have_a3     = (compression & 0x10) != 0
            have_cell   = (compression & 0x20) != 0

            # Heights (float32 LE) - 256 per cluster or 1 broadcast
            if have_height:
                hs = struct.unpack_from(f'<{cells_per_cluster}f', raw, offset)
                offset += cells_per_cluster * 4
                for i, h in enumerate(hs):
                    yy = i // CLUSTER_SIZE
                    xx = i % CLUSTER_SIZE
                    heightmap[cy + yy][cx + xx] = h
            else:
                h, = struct.unpack_from('<f', raw, offset)
                offset += 4
                for yy in range(CLUSTER_SIZE):
                    for xx in range(CLUSTER_SIZE):
                        heightmap[cy + yy][cx + xx] = h

            # Color - 768 bytes per cluster (256 RGB triples) or 3 bytes
            # broadcast for the whole 16x16 cluster.
            if have_color:
                # Scatter 256 RGB triples into the 2D color array.
                for i in range(cells_per_cluster):
                    yy = i // CLUSTER_SIZE
                    xx = i % CLUSTER_SIZE
                    src = offset + i * 3
                    dst = (cx + xx) * 3
                    row = color_rows[cy + yy]
                    row[dst]     = raw[src]
                    row[dst + 1] = raw[src + 1]
                    row[dst + 2] = raw[src + 2]
                offset += cells_per_cluster * 3
            else:
                r = raw[offset]
                g = raw[offset + 1]
                b = raw[offset + 2]
                for yy in range(CLUSTER_SIZE):
                    row = color_rows[cy + yy]
                    for xx in range(CLUSTER_SIZE):
                        dst = (cx + xx) * 3
                        row[dst]     = r
                        row[dst + 1] = g
                        row[dst + 2] = b
                offset += 3
            # Alpha1/2/3 - 256 bytes per cluster or 1 broadcast each.
            # Scatter into per-row bytearrays at source resolution.
            for alpha_rows, have_alpha in (
                (alpha1_rows, have_a1),
                (alpha2_rows, have_a2),
                (alpha3_rows, have_a3),
            ):
                if have_alpha:
                    block = raw[offset:offset + cells_per_cluster]
                    for i in range(cells_per_cluster):
                        yy = i // CLUSTER_SIZE
                        xx = i % CLUSTER_SIZE
                        alpha_rows[cy + yy][cx + xx] = block[i]
                    offset += cells_per_cluster
                else:
                    b = raw[offset]
                    if b != 0:
                        for yy in range(CLUSTER_SIZE):
                            row = alpha_rows[cy + yy]
                            for xx in range(CLUSTER_SIZE):
                                row[cx + xx] = b
                    offset += 1
            # Cell type - 256 bytes per cluster or 1 broadcast (count + store)
            if have_cell:
                block = raw[offset:offset + cells_per_cluster]
                count_bytes(block)
                # Scatter the per-cell bytes into the 2D bitmap.
                for i in range(cells_per_cluster):
                    yy = i // CLUSTER_SIZE
                    xx = i % CLUSTER_SIZE
                    cell_types[cy + yy][cx + xx] = block[i]
                offset += cells_per_cluster
            else:
                # Broadcast: the single byte applies to all 256 cells.
                b = raw[offset]
                if b == 0:
                    n_flat += cells_per_cluster
                else:
                    if b & 0x01: n_cliff    += cells_per_cluster
                    if b & 0x02: n_water    += cells_per_cluster
                    if b & 0x04: n_building += cells_per_cluster
                    if b & 0x08: n_lava     += cells_per_cluster
                    if b & 0x10: n_sloped   += cells_per_cluster
                # Fill the cluster's 16x16 block in the 2D bitmap.
                if b != 0:
                    for yy in range(CLUSTER_SIZE):
                        row = cell_types[cy + yy]
                        for xx in range(CLUSTER_SIZE):
                            row[cx + xx] = b
                offset += 1
            # Info map - 1 uint32 per cluster. Capture as 4 LE bytes packed
            # into info_map_bytes at the cluster's row-major position.
            ccol = cx // CLUSTER_SIZE
            crow = cy // CLUSTER_SIZE
            ioff = (crow * info_cluster_cols + ccol) * 4
            info_map_bytes[ioff]     = raw[offset]
            info_map_bytes[ioff + 1] = raw[offset + 1]
            info_map_bytes[ioff + 2] = raw[offset + 2]
            info_map_bytes[ioff + 3] = raw[offset + 3]
            offset += 4

    total_cells = width * height
    counts = CellTypeCounts(
        total=total_cells,
        flat=n_flat,
        cliff=n_cliff,
        water=n_water,
        building=n_building,
        lava=n_lava,
        sloped=n_sloped,
    )
    cell_types_out = [bytes(row) for row in cell_types]
    color_rows_out = [bytes(row) for row in color_rows]
    a1_out = [bytes(row) for row in alpha1_rows]
    a2_out = [bytes(row) for row in alpha2_rows]
    a3_out = [bytes(row) for row in alpha3_rows]
    return (
        heightmap, cell_types_out, color_rows_out,
        a1_out, a2_out, a3_out,
        bytes(info_map_bytes), info_cluster_cols, info_cluster_rows,
        width, height,
        (grid_min_x, grid_min_z, grid_max_x, grid_max_z),
        counts,
    )


def _box_downsample(src: list[list[float]], factor: int) -> list[list[float]]:
    """Average src down by `factor` in both dimensions. Trims off the
    remainder if src dims aren't divisible by factor."""
    src_h = len(src) // factor * factor
    src_w = len(src[0]) // factor * factor
    out_h = src_h // factor
    out_w = src_w // factor
    dst = [[0.0] * out_w for _ in range(out_h)]
    inv = 1.0 / (factor * factor)
    for oy in range(out_h):
        sy = oy * factor
        for ox in range(out_w):
            sx = ox * factor
            s = 0.0
            for dy in range(factor):
                row = src[sy + dy]
                for dx in range(factor):
                    s += row[sx + dx]
            dst[oy][ox] = s * inv
    return dst


def _downsample_celltypes(src: list[bytes], factor: int, out_w: int, out_h: int) -> bytes:
    """OR-reduce each factor x factor block of CellType bytes into one output
    byte. Any bit set in any source cell propagates to the output. Preserves
    small water bodies / lava patches that would be lost to a majority filter.
    Returns flat bytes in row-major order, length out_w * out_h."""
    out = bytearray(out_w * out_h)
    for oy in range(out_h):
        sy = oy * factor
        base = oy * out_w
        for ox in range(out_w):
            sx = ox * factor
            acc = 0
            for dy in range(factor):
                row = src[sy + dy]
                for dx in range(factor):
                    acc |= row[sx + dx]
            out[base + ox] = acc
    return bytes(out)


def parse_ter_full(path: Path) -> TerFull | None:
    """Decode .TER and return a downsampled int16 heightmap suitable for
    transport to the browser, plus the source-resolution paint channels."""
    raw = path.read_bytes()
    try:
        (heightmap_2d, cell_types_2d, color_rows,
         alpha1_rows, alpha2_rows, alpha3_rows,
         info_map_bytes, info_cluster_cols, info_cluster_rows,
         width, height, bounds, counts) = _decode_v5(raw)
    except ValueError:
        return None

    grid_min_x, grid_min_z, grid_max_x, grid_max_z = bounds

    # Flatten the per-row byte buffers into single bytes blobs at source
    # resolution. Row 0 = grid_min_z (matches the heightmap convention).
    color_rgb_bytes = b"".join(color_rows)
    alpha1_bytes_flat = b"".join(alpha1_rows)
    alpha2_bytes_flat = b"".join(alpha2_rows)
    alpha3_bytes_flat = b"".join(alpha3_rows)

    # Downsample to keep browser meshes lean. 1024 -> 256 (factor 4).
    factor = DOWNSAMPLE_FACTOR
    if width // factor < 1 or height // factor < 1:
        factor = 1
    down = _box_downsample(heightmap_2d, factor)
    out_h = len(down)
    out_w = len(down[0])

    # Downsample the CellType bitmap to the same output resolution. Use OR
    # reduction so a single water/lava cell within a 4x4 block survives.
    cell_type_bytes = _downsample_celltypes(cell_types_2d, factor, out_w, out_h)

    flat = [v for row in down for v in row]
    h_min = min(flat)
    h_max = max(flat)

    # Symmetric int16 quantization around the midpoint of the range:
    # meters = int16 * scale + midpoint, accurate to scale / 2. The scale is a
    # transport unit only; it never changes the recovered meters.
    midpoint = (h_min + h_max) * 0.5
    half_range = max(abs(h_max - midpoint), abs(h_min - midpoint), 1e-3)
    scale = half_range / 32767.0

    out = bytearray(out_w * out_h * 2)
    for y in range(out_h):
        for x in range(out_w):
            v_units = int(round((down[y][x] - midpoint) / scale))
            v_units = max(-32768, min(32767, v_units))
            if v_units < 0:
                v_units += 0x10000
            i = (y * out_w + x) * 2
            out[i]     = v_units & 0xff
            out[i + 1] = (v_units >> 8) & 0xff

    return TerFull(
        cells_x=out_w,
        cells_z=out_h,
        src_cells_x=width,
        src_cells_z=height,
        tile_min_x=grid_min_x,
        tile_min_z=grid_min_z,
        tile_max_x=grid_max_x,
        tile_max_z=grid_max_z,
        version=5,
        downsample_factor=factor,
        heights_le_bytes=bytes(out),
        base_offset_m=midpoint,
        scale=scale,
        height_min_m=h_min,
        height_max_m=h_max,
        cell_type_bytes=cell_type_bytes,
        color_rgb_bytes=color_rgb_bytes,
        alpha1_bytes=alpha1_bytes_flat,
        alpha2_bytes=alpha2_bytes_flat,
        alpha3_bytes=alpha3_bytes_flat,
        info_map_bytes=info_map_bytes,
        info_cluster_cols=info_cluster_cols,
        info_cluster_rows=info_cluster_rows,
        total_cells=counts.total,
        flat_cells=counts.flat,
        cliff_cells=counts.cliff,
        water_cells=counts.water,
        building_cells=counts.building,
        lava_cells=counts.lava,
        sloped_cells=counts.sloped,
    )


def decode_v5_heights(raw: bytes) -> tuple[array, int, int, tuple[int, int, int, int], int]:
    """Heights only, as one row-major float32 array (row 0 = GridMinZ).

    Walks the same cluster layout as `_decode_v5` but skips the paint
    channels instead of scattering them, so a 2048 x 2048 map decodes in a
    fraction of a second. Returns `(heights, width, height, (GridMinX,
    GridMinZ, GridMaxX, GridMaxZ), bytes_consumed)`.
    """
    if raw[:4] != b'TERR':
        raise ValueError('bad magic')
    version = int.from_bytes(raw[4:8], 'little')
    if version != 5:
        raise ValueError(f'unsupported version {version} (need 5)')
    grid_min_x = int.from_bytes(raw[8:10], 'little', signed=True)
    grid_min_z = int.from_bytes(raw[10:12], 'little', signed=True)
    grid_max_x = int.from_bytes(raw[12:14], 'little', signed=True)
    grid_max_z = int.from_bytes(raw[14:16], 'little', signed=True)
    width = grid_max_x - grid_min_x
    height = grid_max_z - grid_min_z
    if width % CLUSTER_SIZE != 0 or height % CLUSTER_SIZE != 0:
        raise ValueError(f'dimensions {width}x{height} not multiple of {CLUSTER_SIZE}')

    n = CLUSTER_SIZE
    cells_per_cluster = n * n
    heights = array('f', bytes(4 * width * height))
    offset = 16
    for cy in range(0, height, n):
        for cx in range(0, width, n):
            flags = raw[offset]
            offset += 1
            if flags & 0x01:
                block = array('f')
                block.frombytes(raw[offset:offset + cells_per_cluster * 4])
                if sys.byteorder == 'big':
                    block.byteswap()
                offset += cells_per_cluster * 4
                for yy in range(n):
                    row = (cy + yy) * width + cx
                    heights[row:row + n] = block[yy * n:(yy + 1) * n]
            else:
                h, = struct.unpack_from('<f', raw, offset)
                offset += 4
                fill = array('f', [h]) * n
                for yy in range(n):
                    row = (cy + yy) * width + cx
                    heights[row:row + n] = fill
            offset += cells_per_cluster * 3 if flags & 0x02 else 3
            for bit in (0x04, 0x08, 0x10, 0x20):
                offset += cells_per_cluster if flags & bit else 1
            offset += 4
    return heights, width, height, (grid_min_x, grid_min_z, grid_max_x, grid_max_z), offset


def read_trn_size_height(trn_path: Path | None) -> float | None:
    """The `.TRN` `[Size] Height` value, or None when the file or key is
    absent. Not a height scale: the engine counts it inside its terrain Y
    bounds (see the module docstring)."""
    if trn_path is None or not trn_path.is_file():
        return None
    try:
        text = trn_path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None
    in_size = False
    for raw in text.splitlines():
        line = raw.split('//', 1)[0].strip()
        if not line: continue
        if line.startswith('[') and line.endswith(']'):
            in_size = (line[1:-1].strip().lower() == 'size')
            continue
        if in_size and '=' in line:
            k, v = line.split('=', 1)
            if k.strip().lower() == 'height':
                try:
                    return float(v.strip().strip('"'))
                except ValueError:
                    return None
    return None


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('usage: python _ter_full.py path/to/X.TER', file=sys.stderr)
        raise SystemExit(2)
    t = parse_ter_full(Path(sys.argv[1]))
    if t is None:
        print('decode failed', file=sys.stderr); raise SystemExit(1)
    print(f'version:       {t.version}')
    print(f'source grid:   {t.src_cells_x} x {t.src_cells_z}')
    print(f'output grid:   {t.cells_x} x {t.cells_z}')
    print(f'world bounds:  X[{t.world_min_x:.0f}..{t.world_max_x:.0f}] '
          f'Z[{t.world_min_z:.0f}..{t.world_max_z:.0f}]')
    print(f'samples:       every {t.sample_spacing_m:.0f} m from '
          f'({t.sample_origin_x:.0f}, {t.sample_origin_z:.0f})')
    print(f'height meters: min={t.height_min_m:.2f}  max={t.height_max_m:.2f}  '
          f'midpoint={t.base_offset_m:.2f}')
    print(f'int16 scale:   {t.scale:.6g} m/unit  (recovers meters as '
          f'`int16 * scale + {t.base_offset_m:.2f}`)')
    pct = lambda n: 100.0 * n / max(1, t.total_cells)
    print(f'cell types:    total={t.total_cells:,}')
    print(f'  flat:        {t.flat_cells:>9,}  ({pct(t.flat_cells):5.1f}%)')
    print(f'  cliff:       {t.cliff_cells:>9,}  ({pct(t.cliff_cells):5.1f}%)')
    print(f'  water:       {t.water_cells:>9,}  ({pct(t.water_cells):5.1f}%)')
    print(f'  building:    {t.building_cells:>9,}  ({pct(t.building_cells):5.1f}%)')
    print(f'  lava:        {t.lava_cells:>9,}  ({pct(t.lava_cells):5.1f}%)')
    print(f'  sloped:      {t.sloped_cells:>9,}  ({pct(t.sloped_cells):5.1f}%)')
