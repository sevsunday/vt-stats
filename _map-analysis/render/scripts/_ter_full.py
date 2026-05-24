"""Definitive `.TER` decoder.

Format reference: `_map-analysis/archive/bz2terraineditor-master/.../Terrain.cs`.
Validated against 5 maps (Europa Night, Hubris, Ebola, 310, Quagmire) -- every
byte in every file is accounted for. See `_verify_format.py` for the smoke test.

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

### Heights are in METERS (float32 absolute world altitude)

Validated values:
- Europa Night basin: 24-180m, plateau: 300m
- Hubris: sea level around 0m, max 600m peak
- Ebola: water level 0m, max 197m
- 310: basin 28-150m
- Quagmire: 95-300m mostly

### What we use vs ignore for the 3D POC

Used:
- Heightmap (float32 -> downsampled to 256x256 -> int16 for transport)
- CellType is decoded but not yet rendered (planned: tint water cells blue,
  flag cliff/lava for the viewer)

Ignored for now (could enable richer rendering later):
- ColorMap: per-cell baked vertex color
- AlphaMap1/2/3: terrain texture blend weights
- InfoMap: per-cluster tile indices, visibility, ownership

### Output

We emit a downsampled heightmap at 256x256 (each output cell = 4x4 input
cells, box-averaged). 256x256 matches the engine's MetersPerGrid=8
resolution and keeps browser meshes lean. The original 1024x1024 float32
data could be exposed later if a use case demands it.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path


CLUSTER_SIZE = 16          # v >= 4
DOWNSAMPLE_FACTOR = 4      # 1024x1024 source -> 256x256 output


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
    heights_le_bytes: bytes   # cells_x * cells_z * 2 bytes (int16 LE)
    height_setting: float     # quantization range: int16 -> meters via scale
    scale: float              # meters per int16 unit
    height_min_m: float       # actual min height in decoded data
    height_max_m: float       # actual max height in decoded data
    # Per-cell CellType bytes at OUTPUT resolution (cells_x * cells_z bytes).
    # Each byte is the OR of all bits set in any source cell of the 4x4 block
    # that downsampled into it. Bits per CellType.cs:
    #   0x01 Cliff  0x02 Water  0x04 Building  0x08 Lava  0x10 Sloped
    cell_type_bytes: bytes
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
        return float(self.tile_min_x) * 2.0

    @property
    def world_min_z(self) -> float:
        return float(self.tile_min_z) * 2.0

    @property
    def world_max_x(self) -> float:
        return float(self.tile_max_x) * 2.0

    @property
    def world_max_z(self) -> float:
        return float(self.tile_max_z) * 2.0

    @property
    def cell_meters_x(self) -> float:
        return (self.world_max_x - self.world_min_x) / self.cells_x if self.cells_x else 0.0

    @property
    def cell_meters_z(self) -> float:
        return (self.world_max_z - self.world_min_z) / self.cells_z if self.cells_z else 0.0


@dataclass
class CellTypeCounts:
    total: int
    flat: int        # bits == 0
    cliff: int       # 0x01
    water: int       # 0x02
    building: int    # 0x04
    lava: int        # 0x08
    sloped: int      # 0x10


def _decode_v5(raw: bytes) -> tuple[list[list[float]], list[list[int]], int, int, tuple[int, int, int, int], CellTypeCounts]:
    """Decode a v5 .TER. Returns (heights_2d, cell_types_2d, width, height, tile_bounds, cellcounts).
    Heights are float32 meters. cell_types_2d carries the raw CellType byte
    (see bits in CellType.cs) per source cell."""
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

            # Color - 768 bytes per cluster or 3 broadcast (we skip)
            offset += (cells_per_cluster * 3) if have_color else 3
            # Alpha1/2/3 - 256 bytes per cluster or 1 broadcast each (we skip)
            offset += cells_per_cluster if have_a1 else 1
            offset += cells_per_cluster if have_a2 else 1
            offset += cells_per_cluster if have_a3 else 1
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
            # Info map - 1 uint32 per cluster
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
    # Convert each row from bytearray to bytes for immutability (small cost,
    # but the caller doesn't need to mutate). Keep as list of bytes for
    # consistent indexing with heightmap.
    cell_types_out = [bytes(row) for row in cell_types]
    return heightmap, cell_types_out, width, height, (grid_min_x, grid_min_z, grid_max_x, grid_max_z), counts


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


def parse_ter_full(path: Path, height_setting: float | None = None) -> TerFull | None:
    """Decode .TER and return a downsampled int16 heightmap suitable for
    transport to the browser. `height_setting` is no longer used --
    heights come from the actual file in float32 meters; we quantize
    using each map's measured max height."""
    raw = path.read_bytes()
    try:
        heightmap_2d, cell_types_2d, width, height, bounds, counts = _decode_v5(raw)
    except ValueError:
        return None

    grid_min_x, grid_min_z, grid_max_x, grid_max_z = bounds

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

    # Find the actual height range so we can quantize tightly.
    flat = [v for row in down for v in row]
    h_min = min(flat)
    h_max = max(flat)
    span = max(1e-6, h_max - h_min)

    # Quantize to int16 (signed). int16 unit = span/65535 meters.
    # We store `(h - h_min) * 65535 / span - 32768`, which maps
    # [h_min..h_max] to [-32768..+32767]. Recovery is
    # `meters = (int16 + 32768) * span / 65535 + h_min`.
    # But the existing viewer assumes a simple linear scale `meters = int16 * scale`,
    # so to keep that contract we instead anchor at zero: scale = h_max / 32767
    # (or -h_min / -32768 -- pick the tighter side). This loses some precision
    # but keeps the viewer code simple.
    # Use a symmetric quantization centered on midpoint:
    midpoint = (h_min + h_max) * 0.5
    half_range = max(abs(h_max - midpoint), abs(h_min - midpoint), 1e-3)
    scale = half_range / 32767.0   # meters per int16 unit
    # Plus a base offset so int16=0 represents `midpoint` meters.
    # The viewer will be told about this offset via `base_offset_m`.

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
        heights_le_bytes=bytes(out),
        height_setting=midpoint,
        scale=scale,
        height_min_m=h_min,
        height_max_m=h_max,
        cell_type_bytes=cell_type_bytes,
        total_cells=counts.total,
        flat_cells=counts.flat,
        cliff_cells=counts.cliff,
        water_cells=counts.water,
        building_cells=counts.building,
        lava_cells=counts.lava,
        sloped_cells=counts.sloped,
    )


def read_trn_height_setting(trn_path: Path | None) -> float:
    """Legacy compatibility: returns the .TRN [Size] Height for callers
    that want it. The actual .TER decoder doesn't need this -- heights
    come from the file directly in absolute meters."""
    DEFAULT = 100.0
    if trn_path is None or not trn_path.is_file():
        return DEFAULT
    try:
        text = trn_path.read_text(encoding='utf-8', errors='replace')
    except Exception:
        return DEFAULT
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
                    val = float(v.strip().strip('"'))
                    return val if val > 0 else DEFAULT
                except ValueError:
                    return DEFAULT
    return DEFAULT


if __name__ == '__main__':
    import sys
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
    print(f'cell meters:   {t.cell_meters_x:.2f} x {t.cell_meters_z:.2f}')
    print(f'height meters: min={t.height_min_m:.2f}  max={t.height_max_m:.2f}  '
          f'midpoint={t.height_setting:.2f}')
    print(f'int16 scale:   {t.scale:.6g} m/unit  (recovers meters as '
          f'`int16 * scale + {t.height_setting:.2f}`)')
    pct = lambda n: 100.0 * n / max(1, t.total_cells)
    print(f'cell types:    total={t.total_cells:,}')
    print(f'  flat:        {t.flat_cells:>9,}  ({pct(t.flat_cells):5.1f}%)')
    print(f'  cliff:       {t.cliff_cells:>9,}  ({pct(t.cliff_cells):5.1f}%)')
    print(f'  water:       {t.water_cells:>9,}  ({pct(t.water_cells):5.1f}%)')
    print(f'  building:    {t.building_cells:>9,}  ({pct(t.building_cells):5.1f}%)')
    print(f'  lava:        {t.lava_cells:>9,}  ({pct(t.lava_cells):5.1f}%)')
    print(f'  sloped:      {t.sloped_cells:>9,}  ({pct(t.sloped_cells):5.1f}%)')
