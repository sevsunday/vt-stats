"""Scenery and pool-mesh sidecars for the 3D map viewer and the replay.

Standalone. Not invoked by process_stats.py, and it does not rewrite the
heightmap `*.3d.json` files.

Each map's `.bzn` names the placed palms, rocks, ruins, and the exact pool
ODF (`bepool01`, `uepool01`, ...). This writes `data/render/<stem>.props.json`
for every ingested map: one row per object that has a position and a mesh in
`data/models/index.json`. Spawns, loose scrap, recyclers, and path nodes are
left out.

Schema 2 adds a top-level `pieces` block, one entry per distinct row stem:
the mesh bounds, its emissive maps and, for tunnel pieces, the passable
`tunnelNN` rects and the hidden terrain__h patch the renderer snaps the
heightfield to. Every length is engine-local metres from the pivot.

Schema 3 adds `terrainHires`: blocks of the source 2 m `.TER` heights around
every placed piece with a terrain patch, in world metres. The `.3d.json`
heightmap is box-averaged to 8 m, which turns the engine's 2 m cliff walls at
a tunnel mouth into 8-16 m ramps; the renderer swaps these blocks in.

    python scripts/extract_props.py
    python scripts/extract_props.py --stem vsroasis
"""
from __future__ import annotations

import argparse
import base64
import itertools
import json
import math
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "_map-analysis" / "scripts"))

from _paths import RENDER_DATA_DIR, VSRMAPLIST_DIR  # noqa: E402
from _ter_full import _decode_v5  # noqa: E402
from analyze_map import analyze_map_dir  # noqa: E402
from extract_3d import find_first_file  # noqa: E402

SCHEMA_VERSION = 3
MODELS_INDEX = ROOT / "data" / "models" / "index.json"
GEOMETRY_DIR = ROOT / "data" / "models" / "geometry"
ODF_DB = ROOT / "data" / "odf.min.json"

# "tunnels": only tunnel pieces carry rects and terrain patches into the
# sidecar. "all": every ODF with tunnelCount > 0 gets its rects and every mesh
# with a terrain__h node its patch (engine-true flattening under pools and
# buildings, which also cuts the terrain inside their passable cells).
OWNERSHIP_SCOPE = "tunnels"

# One tunnelNN X0/Z0/DX/DZ unit is one 8 m terrain square.
TUNNEL_UNIT_M = 8.0
RECT_OVERFLOW_TOL_M = 0.5

# .TER vertex spacing. Vertex (i, j) sits at world_min + 2 * (i, j).
TER_STEP_M = 2.0
# A hires block covers the piece footprint plus this margin. The renderer
# shrinks each block to the 8 m vertex lines inside it, so this is the 16 m
# of exact terrain wanted around the piece plus one 8 m cell of slack.
HIRES_MARGIN_M = 24.0
# Blocks closer than two 8 m cells merge. Each block is stitched to the 8 m
# mesh through a ring one cell wide, and two rings must never share a cell.
HIRES_MERGE_GAP_M = 16.0

# Gameplay markers and path nodes. Pool meshes are NOT in this set: the BZN
# class is the model (`bepool01`), and the orange/yellow markers stay separate.
_SKIP_KIND = {
    "spawn_point",
    "loose_scrap",
    "recycler",
    "starting_unit",
    "ai_path",
    "marker",
    "mission_script",
    "player_slot",
    "pilot",
}
_SKIP_CLASS = re.compile(r"^(spawn$|aipath|vsrpth)", re.IGNORECASE)
_TUNNEL_X0_KEY = re.compile(r"tunnel(\d\d)x0")


def _load_models_index() -> tuple[dict[str, str], dict[str, dict]]:
    raw = json.loads(MODELS_INDEX.read_text(encoding="utf-8"))
    odf_index = {str(k).lower(): str(v) for k, v in (raw.get("odf_index") or {}).items()}
    models = {m["stem"]: m for m in raw.get("models") or [] if "stem" in m}
    return odf_index, models


def _load_odf_db() -> dict[str, dict]:
    """`name.odf` (lowercase) -> entry, flattened across categories."""
    raw = json.loads(ODF_DB.read_text(encoding="utf-8"))
    flat = {}
    for entries in raw.values():
        if isinstance(entries, dict):
            for name, entry in entries.items():
                if isinstance(entry, dict):
                    flat[str(name).lower()] = entry
    return flat


def _odf_key(obj_class: str) -> str:
    key = obj_class.strip().lower()
    return key if key.endswith(".odf") else key + ".odf"


def _section(entry: dict, name: str) -> dict:
    return {str(k).lower(): v for k, v in (entry.get(name) or {}).items()}


def _finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


# ----------------------------- mesh bounds -----------------------------


def _node_matrix(node: dict) -> list[list[float]]:
    """glTF node -> row-major 4x4 local matrix."""
    if "matrix" in node:
        m = node["matrix"]  # column-major
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    tx, ty, tz = node.get("translation", (0.0, 0.0, 0.0))
    qx, qy, qz, qw = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
    sx, sy, sz = node.get("scale", (1.0, 1.0, 1.0))
    rot = [
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ]
    scale = (sx, sy, sz)
    out = [[rot[r][c] * scale[c] for c in range(3)] + [t] for r, t in zip(range(3), (tx, ty, tz))]
    out.append([0.0, 0.0, 0.0, 1.0])
    return out


def _mat_mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def _glb_bounds(stem: str) -> tuple[list[float], list[float]] | None:
    """Engine-local (min, max) of every drawn primitive in the stem's GLB.

    Node transforms are composed (multi-node GLBs keep vertices node-local),
    then Z is negated back to engine space (the converter negates it)."""
    path = GEOMETRY_DIR / f"{stem}.glb"
    if not path.is_file():
        return None
    data = path.read_bytes()
    if data[:4] != b"glTF":
        return None
    chunk_len, _chunk_type = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20:20 + chunk_len])
    nodes = gltf.get("nodes") or []
    meshes = gltf.get("meshes") or []
    accessors = gltf.get("accessors") or []
    lo = [math.inf] * 3
    hi = [-math.inf] * 3

    def visit(idx: int, parent: list[list[float]]) -> None:
        node = nodes[idx]
        world = _mat_mul(parent, _node_matrix(node))
        if "mesh" in node:
            for prim in meshes[node["mesh"]].get("primitives") or []:
                acc = accessors[prim["attributes"]["POSITION"]]
                if "min" not in acc or "max" not in acc:
                    continue
                for corner in itertools.product(*zip(acc["min"], acc["max"])):
                    for r in range(3):
                        v = sum(world[r][k] * corner[k] for k in range(3)) + world[r][3]
                        lo[r] = min(lo[r], v)
                        hi[r] = max(hi[r], v)
        for child in node.get("children") or []:
            visit(child, world)

    identity = [[1.0 if r == c else 0.0 for c in range(4)] for r in range(4)]
    scenes = gltf.get("scenes") or []
    if scenes:
        roots = scenes[gltf.get("scene", 0)].get("nodes") or []
    else:
        children = {c for n in nodes for c in n.get("children") or []}
        roots = [i for i in range(len(nodes)) if i not in children]
    for root in roots:
        visit(root, identity)
    if not all(map(_finite, lo + hi)):
        return None
    bmin = [round(lo[0], 3) + 0.0, round(lo[1], 3) + 0.0, round(-hi[2], 3) + 0.0]
    bmax = [round(hi[0], 3) + 0.0, round(hi[1], 3) + 0.0, round(-lo[2], 3) + 0.0]
    return bmin, bmax


# ----------------------------- tunnel pieces -----------------------------


def _tunnel_defs(entry: dict) -> list[tuple[float, float, float, float, str]]:
    """(X0, Z0, DX, DZ, edge) per declared tunnel segment, in ODF units."""
    bc = _section(entry, "BuildingClass")
    try:
        count = int(float(bc.get("tunnelcount") or 0))
    except ValueError:
        return []
    if count <= 0:
        return []
    indices = sorted({int(m.group(1)) for k in bc for m in [_TUNNEL_X0_KEY.fullmatch(k)] if m})
    out = []
    for nn in indices[:count]:
        pre = f"tunnel{nn:02d}"
        try:
            x0, z0, dx, dz = (float(bc[pre + s]) for s in ("x0", "z0", "dx", "dz"))
        except (KeyError, ValueError):
            continue
        edge = str(bc.get(pre + "edge") or "wwww").strip().strip('"').lower()
        out.append((x0, z0, dx, dz, edge))
    return out


def _is_tunnel_piece(entry: dict) -> bool:
    """A generic placed prop whose passable cells join another tunnel piece.

    Pools, factories, recyclers and bays also declare tunnelNN cells (for their
    drive-in pads); their inheritance chain ends in a gameplay class, so they
    stay out. Bridges are admitted: their decks use the same cells."""
    chain = entry.get("inheritanceChain") or []
    if not chain or str(chain[-1]).lower() != "i76building":
        return False
    return any("f" in edge for *_unit, edge in _tunnel_defs(entry))


def _admitted(entry: dict) -> bool:
    return OWNERSHIP_SCOPE == "all" or _is_tunnel_piece(entry)


def _fit_shift(rects: list[dict], lo_key: str, hi_key: str, lo: float, hi: float) -> float:
    """Shift that brings the rect union inside [lo, hi]: none when it already
    fits, the smallest shift when it fits after moving, else centre it on the
    pivot."""
    u_lo = min(r[lo_key] for r in rects)
    u_hi = max(r[hi_key] for r in rects)
    if u_lo >= lo - RECT_OVERFLOW_TOL_M and u_hi <= hi + RECT_OVERFLOW_TOL_M:
        return 0.0
    if u_hi - u_lo <= hi - lo + RECT_OVERFLOW_TOL_M:
        return lo - u_lo if u_lo < lo else hi - u_hi
    return -(u_lo + u_hi) / 2.0


def _tunnel_rects(stem: str, entry: dict, bmin: list[float], bmax: list[float]) -> list[dict]:
    """Engine-local rects. Anchor = mesh min-X edge and north (max-Z) edge;
    Z0 counts southward."""
    rects = []
    for x0u, z0u, dxu, dzu, edge in _tunnel_defs(entry):
        x0 = bmin[0] + x0u * TUNNEL_UNIT_M
        z1 = bmax[2] - z0u * TUNNEL_UNIT_M
        rects.append({
            "x0": x0, "x1": x0 + dxu * TUNNEL_UNIT_M,
            "z0": z1 - dzu * TUNNEL_UNIT_M, "z1": z1,
            "y0": bmin[1], "y1": bmax[1],
            "edge": edge,
        })
    if not rects:
        return rects
    sx = _fit_shift(rects, "x0", "x1", bmin[0], bmax[0])
    sz = _fit_shift(rects, "z0", "z1", bmin[2], bmax[2])
    if sx or sz:
        print(f"  warn: {stem} tunnel rects overflow the mesh; shifted x {sx:+g} m, z {sz:+g} m")
    for r in rects:
        r["x0"] += sx
        r["x1"] += sx
        r["z0"] += sz
        r["z1"] += sz
        for k in ("x0", "x1", "z0", "z1", "y0", "y1"):
            r[k] = round(r[k], 3) + 0.0
    return rects


def _piece_for(stem: str, entry: dict | None, model: dict) -> dict:
    bounds = _glb_bounds(stem)
    bmin, bmax = bounds if bounds else ([0.0, 0.0, 0.0], [0.0, 0.0, 0.0])
    admitted = bool(bounds and entry and _admitted(entry))
    return {
        "bboxMin": bmin,
        "bboxMax": bmax,
        "emissive": list(model.get("emissiveTextures") or []),
        "terrainPatch": model.get("terrainPatch") if admitted else None,
        "tunnels": _tunnel_rects(stem, entry, bmin, bmax) if admitted else [],
    }


# ----------------------------- sidecars -----------------------------


def _props_for_map(map_dir: Path, odf_index: dict[str, str]) -> tuple[list[dict], dict[str, list[str]]]:
    """Rows plus, per stem, the ODFs placed with it (first one first)."""
    report = analyze_map_dir(map_dir)
    rows: list[dict] = []
    odfs_by_stem: dict[str, list[str]] = {}
    for obj in report.objects:
        if obj.kind in _SKIP_KIND:
            continue
        if _SKIP_CLASS.match(obj.obj_class or ""):
            continue
        if obj.position is None:
            continue
        x, y, z = obj.position
        if not (_finite(x) and _finite(y) and _finite(z)):
            continue
        odf = _odf_key(obj.obj_class)
        stem = odf_index.get(odf)
        if not stem:
            continue
        yaw = obj.yaw if _finite(obj.yaw) else 0.0
        rows.append({
            "stem": stem,
            "x": round(float(x), 2),
            "y": round(float(y), 2),
            "z": round(float(z), 2),
            "yaw": round(math.degrees(yaw), 2),
        })
        placed = odfs_by_stem.setdefault(stem, [])
        if odf not in placed:
            placed.append(odf)
    return rows, odfs_by_stem


def _pieces_for_map(odfs_by_stem: dict[str, list[str]], odf_db: dict[str, dict],
                    models: dict[str, dict], cache: dict) -> dict[str, dict]:
    """One piece per stem, built from the first ODF placed with it."""
    pieces = {}
    for stem, odfs in odfs_by_stem.items():
        variants = []
        for odf in odfs:
            key = (stem, odf)
            if key not in cache:
                cache[key] = _piece_for(stem, odf_db.get(odf), models.get(stem) or {})
            variants.append(cache[key])
        if any(v != variants[0] for v in variants[1:]):
            print(f"  warn: {stem} is placed as {', '.join(odfs)} with different "
                  f"tunnel data; using {odfs[0]}")
        pieces[stem] = variants[0]
    return pieces


# ----------------------------- hires terrain -----------------------------


def _footprint_box(row: dict, piece: dict) -> tuple[float, float, float, float]:
    """World AABB (x0, x1, z0, z1) of the row's rotated mesh footprint, posed
    with the same rule as js/terrain-owners.js."""
    theta = math.radians(float(row.get("yaw") or 0.0))
    cos, sin = math.cos(theta), math.sin(theta)
    xs, zs = [], []
    for lx in (piece["bboxMin"][0], piece["bboxMax"][0]):
        for lz in (piece["bboxMin"][2], piece["bboxMax"][2]):
            xs.append(round(row["x"] + lx * cos + lz * sin, 6))
            zs.append(round(row["z"] - lx * sin + lz * cos, 6))
    return min(xs), max(xs), min(zs), max(zs)


def _merge_index_boxes(boxes: list[list[int]]) -> list[list[int]]:
    """Union inclusive [i0, i1, j0, j1] vertex boxes until no two are closer
    than HIRES_MERGE_GAP_M on both axes."""
    limit = HIRES_MERGE_GAP_M / TER_STEP_M
    out = [list(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        for a, b in itertools.combinations(range(len(out)), 2):
            p, q = out[a], out[b]
            if max(p[0] - q[1], q[0] - p[1]) < limit and max(p[2] - q[3], q[2] - p[3]) < limit:
                out[a] = [min(p[0], q[0]), max(p[1], q[1]), min(p[2], q[2]), max(p[3], q[3])]
                del out[b]
                changed = True
                break
    return sorted(out, key=lambda b: (b[2], b[0]))


def _metres(value: float) -> float | int:
    return int(value) if float(value).is_integer() else value


def _encode_block(grid: list[list[float]], box: list[int], wmin_x: float, wmin_z: float) -> dict:
    """One block, row-major (row 0 = z0), quantized like the .3d.json
    heightmap: abs metres = int16 * scale + base_offset_m."""
    i0, i1, j0, j1 = box
    vals = [grid[j][i] for j in range(j0, j1 + 1) for i in range(i0, i1 + 1)]
    lo, hi = min(vals), max(vals)
    mid = (lo + hi) / 2.0
    scale = max(hi - mid, mid - lo, 1e-3) / 32767.0
    packed = struct.pack(
        f"<{len(vals)}h",
        *(max(-32768, min(32767, round((v - mid) / scale))) for v in vals),
    )
    return {
        "x0": _metres(wmin_x + TER_STEP_M * i0),
        "z0": _metres(wmin_z + TER_STEP_M * j0),
        "step": _metres(TER_STEP_M),
        "cols": i1 - i0 + 1,
        "rows": j1 - j0 + 1,
        "encoding": "int16_le_base64",
        "scale": scale,
        "base_offset_m": mid,
        "data": base64.b64encode(packed).decode("ascii"),
    }


def _hires_blocks(folder: Path, rows: list[dict], pieces: dict[str, dict]) -> list[dict]:
    """Source 2 m `.TER` blocks around every placed piece with a terrain patch."""
    owners = [r for r in rows if (pieces.get(r["stem"]) or {}).get("terrainPatch")]
    if not owners:
        return []
    ter_path = find_first_file(folder, "*.TER", "*.ter")
    if ter_path is None:
        print(f"  warn: {folder.name} places terrain-patch pieces but has no .TER")
        return []
    try:
        decoded = _decode_v5(ter_path.read_bytes())
    except ValueError as err:
        print(f"  warn: {ter_path.name}: {err}; no hires blocks")
        return []
    grid, width, height, bounds = decoded[0], decoded[9], decoded[10], decoded[11]
    wmin_x, wmin_z = bounds[0] * TER_STEP_M, bounds[1] * TER_STEP_M
    boxes = []
    for row in owners:
        x0, x1, z0, z1 = _footprint_box(row, pieces[row["stem"]])
        i0 = max(0, math.floor((x0 - HIRES_MARGIN_M - wmin_x) / TER_STEP_M))
        i1 = min(width - 1, math.ceil((x1 + HIRES_MARGIN_M - wmin_x) / TER_STEP_M))
        j0 = max(0, math.floor((z0 - HIRES_MARGIN_M - wmin_z) / TER_STEP_M))
        j1 = min(height - 1, math.ceil((z1 + HIRES_MARGIN_M - wmin_z) / TER_STEP_M))
        if i1 > i0 and j1 > j0:
            boxes.append([i0, i1, j0, j1])
    return [_encode_block(grid, box, wmin_x, wmin_z) for box in _merge_index_boxes(boxes)]


def _dumps_sidecar(doc: dict) -> str:
    """json.dumps(doc, indent=2) with each terrainPatch.heights array on one line."""
    blobs = []
    pieces = {}
    for stem, piece in (doc.get("pieces") or {}).items():
        tp = piece.get("terrainPatch")
        if tp and isinstance(tp.get("heights"), list):
            blobs.append(json.dumps(tp["heights"], separators=(",", ":")))
            piece = {**piece, "terrainPatch": {**tp, "heights": f"@@heights:{len(blobs) - 1}@@"}}
        pieces[stem] = piece
    text = json.dumps({**doc, "pieces": pieces}, indent=2)
    return re.sub(r'"@@heights:(\d+)@@"', lambda m: blobs[int(m.group(1))], text) + "\n"


def _iter_maps(only: str | None):
    if not VSRMAPLIST_DIR.is_dir():
        return
    seen = set()
    for folder in sorted(VSRMAPLIST_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        key = str(folder.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        bzns = list(folder.glob("*.bzn")) + list(folder.glob("*.BZN"))
        if not bzns:
            continue
        stem = bzns[0].stem.lower()
        if only and stem != only:
            continue
        yield stem, folder


def extract(only: str | None) -> int:
    if not MODELS_INDEX.is_file():
        print(f"missing {MODELS_INDEX}")
        return 1
    odf_index, models = _load_models_index()
    odf_db = _load_odf_db()
    RENDER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    cache: dict = {}
    written = 0
    placed = 0
    tunnel_maps = 0
    hires_maps = 0
    hires_blocks = 0
    for stem, folder in _iter_maps(only):
        rows, odfs_by_stem = _props_for_map(folder, odf_index)
        pieces = _pieces_for_map(odfs_by_stem, odf_db, models, cache)
        hires = _hires_blocks(folder, rows, pieces)
        doc = {
            "schema_version": SCHEMA_VERSION,
            "map_stem": stem,
            "props": rows,
            "pieces": pieces,
        }
        if hires:
            doc["terrainHires"] = hires
            hires_maps += 1
            hires_blocks += len(hires)
        out = RENDER_DATA_DIR / f"{stem}.props.json"
        out.write_text(_dumps_sidecar(doc), encoding="utf-8")
        written += 1
        placed += len(rows)
        if any(p["tunnels"] for p in pieces.values()):
            tunnel_maps += 1
    print(f"wrote {written} prop sidecars, {placed} placements, {tunnel_maps} maps with tunnel pieces, "
          f"{hires_blocks} hires terrain blocks on {hires_maps} maps")
    return 0 if written else 1


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract map scenery and pool meshes")
    ap.add_argument("--stem", default=None, help="one map stem (bzn filename)")
    args = ap.parse_args()
    only = args.stem.lower() if args.stem else None
    raise SystemExit(extract(only))


if __name__ == "__main__":
    main()
