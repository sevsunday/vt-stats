"""
Resolve a map's *rendered shellmap* world rectangle from `.ter` + `.trn`.

The BZ2 engine's ``-shellmap`` command renders the full ``.ter`` cell grid
into a 512x512 BMP. Empirical observation across the VSR corpus (see
``_map-analysis/overlays/README.md`` for the audit):

  1. **Every map's ``.ter`` is centered on origin.** GridMinX = -GridMaxX
     and GridMinZ = -GridMaxZ for all 12 maps spot-checked. We treat this
     as a BZ2 invariant.

  2. **The rendered rectangle is the .ter cell grid times a per-map
     `meters_per_cell` factor.** Cells count comes from ``.ter``; the
     m/cell factor needs a hint, because BZCC maps use either 2 m/cell
     (e.g. Big Chill, Uxbridge, 310 - all `.trn MetersPerGrid=8`,
     ``cells*2 == .trn Width``) or 4 m/cell (e.g. Mountain Top, Iraq -
     ``cells*4 == .trn Width``).

  3. **The ``.trn`` ``[Size]`` block is unreliable in general:**
     - Uxbridge: ``MinX=-2048, Width=1024`` -> rect ``[-2048, -1024]``,
       doesn't even contain the origin.
     - 310 / Strategy Arena: similarly off-center.
     - Many maps (Haven, Garden, Quagmire, Bowl, ...) have no `.trn`
       at all.

  We use ``.trn`` only when its rect *is* centered on origin AND the
  derived ``m_per_cell == trn_half_extent / .ter_half_cells`` is an
  integer >= 2. Otherwise we fall back to **m_per_cell = 2.0** (BZCC
  default - covers every other sampled map).

The output is a single ``ShellmapRect`` carrying the canonical rectangle
plus a small ``provenance`` field for debugging / verdict tables.

Pure helper module - no I/O beyond reading the two files.

Re-uses ``parse_trn`` from ``_map-analysis/scripts/analyze_map.py`` for
the `[Size]` INI parsing.
"""

from __future__ import annotations

import struct
import sys
from dataclasses import dataclass
from pathlib import Path


# Make analyze_map.py importable as a sibling module
_THIS_DIR = Path(__file__).resolve().parent
_ANALYZE_DIR = _THIS_DIR.parent.parent / "scripts"
if str(_ANALYZE_DIR) not in sys.path:
    sys.path.insert(0, str(_ANALYZE_DIR))

from analyze_map import parse_trn  # noqa: E402  (sys.path manipulation above)


# BZCC default. Holds for ~10 of 12 sampled maps; the rest tell us
# the true factor via a centered `.trn [Size]` block (see derive_rect).
DEFAULT_METERS_PER_CELL = 2.0

# A `.trn` rect whose center is farther than this from origin is treated
# as unreliable (it's describing a build-grid subregion, not the rendered
# terrain). 256 m is well above the noise floor we see in real `.trn`
# centers (a few meters at most) and well below the typical "way off
# center" case (Uxbridge says center=-1536 m).
TRN_CENTER_TOLERANCE_M = 32.0


@dataclass
class ShellmapRect:
    """Square world rect (meters) the shellmap BMP is rendered against.

    Always centered on origin -- BZ2's `.ter` is universally centered, and
    the engine's shellmap mirrors that.
    """

    half_extent_m: float        # rect = [-half_extent_m, +half_extent_m] both axes
    cells: int                  # .ter cell count per side (GridMaxX - GridMinX)
    m_per_cell: float           # meters per .ter cell
    provenance: str             # human-readable: e.g. "ter+trn(centered)" or "ter (default 2 m/cell)"
    ok: bool = True
    note: str = ""

    @property
    def min_x(self) -> float:
        return -self.half_extent_m

    @property
    def min_z(self) -> float:
        return -self.half_extent_m

    @property
    def width(self) -> float:
        return 2.0 * self.half_extent_m


def _find_one(map_dir: Path, ext: str) -> Path | None:
    """Case-insensitive first match for a single extension in a map dir."""
    if not map_dir.is_dir():
        return None
    ext_lower = ext.lower()
    for p in map_dir.iterdir():
        if p.is_file() and p.suffix.lower() == ext_lower:
            return p
    return None


def parse_ter_header(ter_path: Path) -> tuple[int, int, int, int] | None:
    """Read the `.ter` binary header and return ``(grid_min_x, grid_min_z,
    grid_max_x, grid_max_z)`` in cell units. ``None`` on bad magic / EOF.

    Layout (canonical reference: ``BZMapTools/TerFile.cs`` lines 77-84
    and ``bz2terraineditor-master/BZ2TerrainEditor/Terrain.cs`` lines 122-138):

        offset 0x00  4B magic 'TERR' (0x52524554)
        offset 0x04  UInt32 LE  version (>= 4 -> BZCC, CLUSTER_SIZE 16)
        offset 0x08  Int16  LE  GridMinX
        offset 0x0A  Int16  LE  GridMinZ
        offset 0x0C  Int16  LE  GridMaxX
        offset 0x0E  Int16  LE  GridMaxZ
    """
    try:
        with ter_path.open("rb") as f:
            head = f.read(16)
    except OSError:
        return None
    if len(head) < 16 or head[0:4] != b"TERR":
        return None
    grid_min_x, grid_min_z, grid_max_x, grid_max_z = struct.unpack("<4h", head[8:16])
    if grid_max_x <= grid_min_x or grid_max_z <= grid_min_z:
        return None
    return grid_min_x, grid_min_z, grid_max_x, grid_max_z


def derive_rect(map_dir: Path) -> ShellmapRect:
    """Return the canonical ``ShellmapRect`` for this map directory.

    Algorithm (see module docstring for the full rationale):

      1. Read `.ter` header to get ``half_cells = (GridMaxX - GridMinX) / 2``.
         If `.ter` is missing or malformed, return ``ok=False``.

      2. If `.trn [Size]` is present AND its rect is centered on origin
         (within TRN_CENTER_TOLERANCE_M), check whether
         ``candidate = (Width / 2) / half_cells`` is an integer >= 2.
         If so, use ``m_per_cell = candidate``.

      3. Else fall back to ``m_per_cell = DEFAULT_METERS_PER_CELL`` (2.0).

      4. ``half_extent_m = half_cells * m_per_cell``.
    """
    ter_path = _find_one(map_dir, ".ter")
    if ter_path is None:
        return ShellmapRect(
            half_extent_m=0.0, cells=0, m_per_cell=0.0,
            provenance="missing", ok=False, note="no .ter file in map dir",
        )
    hdr = parse_ter_header(ter_path)
    if hdr is None:
        return ShellmapRect(
            half_extent_m=0.0, cells=0, m_per_cell=0.0,
            provenance="missing", ok=False, note=f"bad .ter header: {ter_path.name}",
        )
    grid_min_x, grid_min_z, grid_max_x, grid_max_z = hdr
    cells_x = grid_max_x - grid_min_x
    cells_z = grid_max_z - grid_min_z

    note_parts: list[str] = []
    if cells_x != cells_z:
        note_parts.append(f"non-square .ter ({cells_x}x{cells_z}); using max side")
    cells = max(cells_x, cells_z)
    half_cells = cells // 2

    m_per_cell = DEFAULT_METERS_PER_CELL
    provenance = "ter (default 2 m/cell)"

    trn_path = _find_one(map_dir, ".trn")
    if trn_path is not None:
        b, status = parse_trn(trn_path)
        if status == "ok" and b is not None and b.width > 0 and b.depth > 0:
            cx = b.min_x + b.width * 0.5
            cz = b.min_z + b.depth * 0.5
            if abs(cx) <= TRN_CENTER_TOLERANCE_M and abs(cz) <= TRN_CENTER_TOLERANCE_M:
                # candidate m/cell from .trn (centered)
                trn_half = max(b.width, b.depth) * 0.5
                if half_cells > 0:
                    candidate = trn_half / half_cells
                    candidate_rounded = round(candidate)
                    # Accept the .trn-derived value only when it's a clean
                    # integer >= 2 (avoids DuneNight's 1.22 m/cell which is
                    # a clue the .trn Width is some other concept entirely).
                    if (
                        candidate_rounded >= 2
                        and abs(candidate - candidate_rounded) < 1e-6
                    ):
                        m_per_cell = float(candidate_rounded)
                        provenance = "ter + trn (centered)"
            # else: .trn off-center -- ignore for m/cell purposes
        # else: bad .trn -- ignore

    half_extent_m = half_cells * m_per_cell
    return ShellmapRect(
        half_extent_m=float(half_extent_m),
        cells=int(cells),
        m_per_cell=float(m_per_cell),
        provenance=provenance,
        ok=True,
        note="; ".join(note_parts),
    )


def main(argv: list[str]) -> int:
    """CLI: print the canonical shellmap rect for one or more map dirs."""
    if len(argv) < 1:
        print("Usage: terrain_bounds.py <map_dir> [<map_dir> ...]", file=sys.stderr)
        return 2
    for arg in argv:
        d = Path(arg)
        r = derive_rect(d)
        print(f"{d.name}:")
        print(f"  ok:             {r.ok}")
        print(f"  cells/side:     {r.cells}")
        print(f"  m/cell:         {r.m_per_cell:g}")
        print(f"  half_extent:    {r.half_extent_m:g} m")
        print(f"  rect:           [{r.min_x:g}, {-r.min_x:g}] x [{r.min_z:g}, {-r.min_z:g}]")
        print(f"  provenance:     {r.provenance}")
        if r.note:
            print(f"  note:           {r.note}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
